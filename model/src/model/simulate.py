"""Wallet behaviour simulator.

Generates worlds of USDC transfers between wallets with known roles. The training set is the
features of each role wallet with its label (1 = risky to pay). The same behaviours drive
scripts/seed.py, which replays a world plan as real transfers on Arc testnet.

Time is in seconds. Histories are compressed into minutes or hours so a seeded world can be
created live; the features in spec/features.json do not depend on absolute wallet age or amounts.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from .features import Transfer

RISKY_ROLES = {"drainer", "launderer"}


@dataclass
class World:
    rng: random.Random
    t: int = 0
    transfers: list[tuple[str, str, int, int]] = field(default_factory=list)  # (from, to, value, ts)
    roles: dict[str, str] = field(default_factory=dict)
    _n: int = 0

    def wallet(self, role: str | None = None) -> str:
        self._n += 1
        addr = f"0x{self._n:040x}"
        if role:
            self.roles[addr] = role
        return addr

    def send(self, frm: str, to: str, value: int, ts: int) -> None:
        self.transfers.append((frm, to, max(1, int(value)), int(ts)))

    def as_transfers(self, block_time: float = 0.5) -> list[Transfer]:
        """Assign blocks from timestamps (about 2 blocks per second, like Arc)."""
        out = []
        for i, (f, to, v, ts) in enumerate(sorted(self.transfers, key=lambda x: x[3])):
            out.append(Transfer(f, to, v, int(ts / block_time), i, ts))
        return out


def amount(rng: random.Random, lo: int = 1_000, hi: int = 50_000) -> int:
    """USDC base units. Tiny on purpose: 0.001 to 0.05 USDC."""
    return int(rng.uniform(lo, hi))


# --------------------------------------------------------------------------- behaviours
# Each behaviour adds one role wallet (and the wallets it needs) starting near `start`.


def normal_user(w: World, start: int, hubs: list[str], merchants: list[str]) -> str:
    rng = w.rng
    me = w.wallet("normal")
    t = start
    w.send(rng.choice(hubs), me, amount(rng, 20_000, 80_000), t)
    for _ in range(rng.randint(0, 6)):
        t += rng.randint(120, 7200)
        if rng.random() < 0.7 and merchants:
            w.send(me, rng.choice(merchants), amount(rng, 500, 8_000), t)
        else:
            w.send(rng.choice(hubs), me, amount(rng, 5_000, 30_000), t)
    return me


def merchant(w: World, start: int, customers: list[str], supplier: str) -> str:
    rng = w.rng
    me = w.wallet("merchant")
    t = start
    regulars = rng.sample(customers, k=min(len(customers), rng.randint(3, 8)))
    received = 0
    for _ in range(rng.randint(8, 25)):
        t += rng.randint(30, 1800)
        v = amount(rng, 500, 10_000)
        w.send(rng.choice(regulars), me, v, t)
        received += v
        if rng.random() < 0.15:
            t += rng.randint(300, 3600)
            w.send(me, supplier, int(received * rng.uniform(0.2, 0.6)), t)
            received = 0
    return me


def exchange_hot_wallet(w: World, start: int, depositors: list[str], cold: str) -> str:
    """Hard negative: many distinct senders, fast sweeps, but the senders are old wallets."""
    rng = w.rng
    me = w.wallet("exchange")
    t = start
    total = 0
    for d in rng.sample(depositors, k=min(len(depositors), rng.randint(8, 20))):
        t += rng.randint(5, 120)
        v = amount(rng)
        w.send(d, me, v, t)
        total += v
        if rng.random() < 0.3:
            t += rng.randint(30, 900)
            w.send(me, cold, int(total * rng.uniform(0.5, 0.9)), t)
            total = 0
    return me


def payroll(w: World, start: int, hubs: list[str], employees: list[str]) -> str:
    """Negative: one funder, fan-out to the same people repeatedly."""
    rng = w.rng
    me = w.wallet("payroll")
    t = start
    staff = rng.sample(employees, k=min(len(employees), rng.randint(3, 6)))
    for _ in range(rng.randint(2, 4)):
        w.send(rng.choice(hubs), me, amount(rng, 50_000, 200_000), t)
        t += rng.randint(600, 7200)
        for e in staff:
            t += rng.randint(2, 30)
            w.send(me, e, amount(rng, 5_000, 20_000), t)
        t += rng.randint(3600, 20000)
    return me


def fresh(w: World, start: int, hubs: list[str]) -> str:
    rng = w.rng
    me = w.wallet("fresh")
    if rng.random() < 0.6:
        w.send(rng.choice(hubs), me, amount(rng), start)
    return me


def drainer(w: World, start: int, hubs: list[str], old_wallets: list[str]) -> str:
    """Victims are mostly fresh wallets funded moments before they are drained."""
    rng = w.rng
    me = w.wallet("drainer")
    cashout = w.wallet()
    t = start
    pending = 0
    for _ in range(rng.randint(5, 18)):
        t += rng.randint(3, 90)
        if rng.random() < 0.8 or not old_wallets:
            victim = w.wallet()
            w.send(rng.choice(hubs), victim, amount(rng, 10_000, 60_000), t)
            t += rng.randint(5, 300)
        else:
            victim = rng.choice(old_wallets)
        v = amount(rng, 5_000, 50_000)
        w.send(victim, me, v, t)
        pending += v
        if rng.random() < 0.6:
            t += rng.randint(2, 45)
            w.send(me, cashout, int(pending * rng.uniform(0.9, 1.0)), t)
            pending = 0
    if pending:
        w.send(me, cashout, pending, t + rng.randint(2, 45))
    return me


def launderer(w: World, start: int, hubs: list[str]) -> str:
    """Pass-through: funds from fresh sources, split into fresh hop wallets within seconds."""
    rng = w.rng
    me = w.wallet("launderer")
    t = start
    for _ in range(rng.randint(2, 6)):
        src = w.wallet()
        w.send(rng.choice(hubs), src, amount(rng, 50_000, 200_000), t)
        t += rng.randint(5, 240)
        v = amount(rng, 40_000, 150_000)
        w.send(src, me, v, t)
        for part in range(rng.randint(2, 5)):
            t += rng.randint(1, 40)
            w.send(me, w.wallet(), int(v / 5 * rng.uniform(0.8, 1.0)), t)
    return me


# --------------------------------------------------------------------------- worlds


def make_world(seed: int, scale: int = 1) -> World:
    rng = random.Random(seed)
    w = World(rng)
    hubs = [w.wallet() for _ in range(3)]
    base = 0
    # Background population created well before the role wallets act.
    customers = [w.wallet() for _ in range(25 * scale)]
    for c in customers:
        w.send(rng.choice(hubs), c, amount(rng, 20_000, 100_000), rng.randint(0, 3600))
    base = 4000
    supplier = w.wallet()
    cold = w.wallet()

    merchants = [merchant(w, base + rng.randint(0, 3600), customers, supplier) for _ in range(3 * scale)]
    for _ in range(12 * scale):
        normal_user(w, base + rng.randint(0, 7200), hubs, merchants)
    for _ in range(2 * scale):
        exchange_hot_wallet(w, base + rng.randint(0, 7200), customers, cold)
    for _ in range(2 * scale):
        payroll(w, base + rng.randint(0, 7200), hubs, customers)
    for _ in range(5 * scale):
        fresh(w, base + rng.randint(0, 7200), hubs)
    for _ in range(4 * scale):
        drainer(w, base + rng.randint(0, 7200), hubs, customers)
    for _ in range(3 * scale):
        launderer(w, base + rng.randint(0, 7200), hubs)
    return w


def label(role: str) -> int:
    return 1 if role in RISKY_ROLES else 0
