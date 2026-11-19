"""Feature computation, implementing spec/features.json."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

SPEC = json.loads((Path(__file__).resolve().parents[3] / "spec" / "features.json").read_text())
FRESH_WINDOW_S = SPEC["constants"]["fresh_window_s"]
HOLD_CAP_S = SPEC["constants"]["hold_cap_s"]
FEATURE_NAMES = [f["name"] for f in SPEC["features"]]
ZERO = "0x" + "0" * 40


@dataclass(frozen=True)
class Transfer:
    frm: str
    to: str
    value: int
    block: int
    log_index: int
    ts: int

    @staticmethod
    def from_dict(d: dict) -> "Transfer":
        return Transfer(d["from"].lower(), d["to"].lower(), int(d["value"]), int(d["block"]), int(d["log_index"]), int(d["ts"]))

    def to_dict(self) -> dict:
        return {"from": self.frm, "to": self.to, "value": self.value, "block": self.block, "log_index": self.log_index, "ts": self.ts}


def _valid(t: Transfer) -> bool:
    return t.frm != t.to and t.frm != ZERO and t.to != ZERO


def first_seen(transfers: list[Transfer]) -> dict[str, int]:
    seen: dict[str, int] = {}
    for t in sorted(transfers, key=lambda t: (t.block, t.log_index)):
        if not _valid(t):
            continue
        seen.setdefault(t.frm, t.ts)
        seen.setdefault(t.to, t.ts)
    return seen


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    m = n // 2
    return s[m] if n % 2 else (s[m - 1] + s[m]) / 2


def compute(address: str, transfers: list[Transfer], block: int, seen: dict[str, int] | None = None) -> list[float]:
    """Features for `address` from all transfers at or before `block`.

    `transfers` is the full transfer set (needed for first-seen times of counterparties).
    """
    address = address.lower()
    ts_all = [t for t in transfers if t.block <= block and _valid(t)]
    ts_all.sort(key=lambda t: (t.block, t.log_index))
    if seen is None:
        seen = first_seen(ts_all)
    mine = [t for t in ts_all if t.frm == address or t.to == address]

    n = len(mine)
    counterparties: set[str] = set()
    repeats = 0
    inflow = outflow = 0
    inflow_count = 0
    senders: set[str] = set()
    fresh_value = 0
    last_inflow_ts: int | None = None
    holds: list[float] = []

    for t in mine:
        incoming = t.to == address
        cp = t.frm if incoming else t.to
        if cp in counterparties:
            repeats += 1
        counterparties.add(cp)
        if incoming:
            inflow += t.value
            inflow_count += 1
            senders.add(cp)
            if t.ts - seen[cp] <= FRESH_WINDOW_S:
                fresh_value += t.value
            last_inflow_ts = t.ts
        else:
            outflow += t.value
            holds.append(HOLD_CAP_S if last_inflow_ts is None else min(HOLD_CAP_S, t.ts - last_inflow_ts))

    return [
        math.log1p(n),
        math.log1p(len(counterparties)),
        min(2.0, outflow / inflow) if inflow > 0 else 0.0,
        len(senders) / inflow_count if inflow_count else 0.0,
        repeats / n if n else 0.0,
        fresh_value / inflow if inflow > 0 else 0.0,
        math.log1p(_median(holds)) / math.log1p(HOLD_CAP_S) if holds else 1.0,
    ]


def quantize(x: list[float], scale: int) -> list[int]:
    return [round(v * (1 << scale)) for v in x]
