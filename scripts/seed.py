"""Seed the demo world on Arc testnet with real USDC transfers.

    cd seller && uv run python ../scripts/seed.py --seed 0 --compress 10            # dry run: plan + scores
    cd seller && uv run python ../scripts/seed.py --seed 0 --compress 10 --execute

The plan comes from model.simulate.make_demo_world. The hub is the DEPLOYER wallet; every other
wallet gets a new key, saved to .seed/wallets.json (gitignored). Role wallets are written to
deployments/demo-wallets.json for the presenter. The agent never reads either file: it scores
wallets only from chain data.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import torch
from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "seller" / "src"))

from model.features import compute, first_seen  # noqa: E402
from model.net import RiskMLP  # noqa: E402
from model.simulate import make_demo_world  # noqa: E402
from seller.chain import DEPLOYMENT, ERC20_ABI  # noqa: E402

TRANSFER_ABI = ERC20_ABI + [
    {"type": "function", "name": "transfer", "stateMutability": "nonpayable",
     "inputs": [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}], "outputs": [{"type": "bool"}]},
]
GAS_LIMIT = 90_000
GAS_RESERVE_UNITS = 4_000  # 0.004 USDC kept back for gas on each send


def plan_report(w) -> None:
    m = RiskMLP()
    m.load_state_dict(torch.load(ROOT / "model/artifacts/riskone/weights.pt"))
    m.eval()
    tr = w.as_transfers()
    seen = first_seen(tr)
    last = tr[-1].block
    hub = tr[0].frm
    print(f"{len(tr)} transfers over {tr[-1].ts}s, hub sends {sum(t.value for t in tr if t.frm == hub) / 1e6:.4f} USDC")
    for a, r in w.roles.items():
        p = float(m(torch.tensor([compute(a, tr, last, seen)])).item())
        print(f"  planned {r:10s} riskone score {p:.3f}")


def main() -> None:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--compress", type=float, default=10.0)
    ap.add_argument("--execute", action="store_true")
    a = ap.parse_args()

    w = make_demo_world(a.seed, compress=a.compress, value_div=1)
    plan_report(w)
    if not a.execute:
        return

    w3 = Web3(Web3.HTTPProvider(os.environ[DEPLOYMENT["rpcEnv"]], request_kwargs={"timeout": 30}))
    usdc = w3.eth.contract(address=Web3.to_checksum_address(DEPLOYMENT["usdc"]), abi=TRANSFER_ABI)

    hub_key = os.environ["DEPLOYER_KEY"]
    transfers = sorted(w.transfers, key=lambda x: x[3])
    sim_hub = transfers[0][0]
    names = sorted({x for t in transfers for x in t[:2]} | set(w.roles))

    seed_dir = ROOT / ".seed"
    seed_dir.mkdir(exist_ok=True)
    keys: dict[str, str] = {sim_hub: hub_key}
    for n in names:
        if n not in keys:
            keys[n] = Account.create().key.hex()
    addr = {n: Account.from_key(k).address for n, k in keys.items()}
    (seed_dir / "wallets.json").write_text(
        json.dumps({"seed": a.seed, "compress": a.compress, "wallets": {addr[n]: keys[n] for n in names if n != sim_hub}}, indent=1)
    )
    os.chmod(seed_dir / "wallets.json", 0o600)

    nonces: dict[str, int] = {}
    start_block = w3.eth.block_number
    t0 = time.time()
    sent = 0
    for frm, to, value, ts in transfers:
        delay = t0 + ts - time.time()
        if delay > 0:
            time.sleep(delay)
        sender = addr[frm]
        bal = usdc.functions.balanceOf(sender).call()
        v = min(value, bal - GAS_RESERVE_UNITS)
        if v <= 0:
            print(f"skip {sender[:10]} has {bal} units")
            continue
        nonce = nonces.get(sender)
        if nonce is None:
            nonce = w3.eth.get_transaction_count(sender, "pending")
        tx = usdc.functions.transfer(addr[to], v).build_transaction(
            {"from": sender, "nonce": nonce, "gas": GAS_LIMIT, "chainId": DEPLOYMENT["chainId"]}
        )
        signed = Account.from_key(keys[frm]).sign_transaction(tx)
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        r = w3.eth.wait_for_transaction_receipt(h, timeout=60, poll_latency=0.25)
        nonces[sender] = nonce + 1
        sent += 1
        status = "ok" if r["status"] == 1 else "REVERTED"
        print(f"[{time.time() - t0:7.1f}s] {sender[:10]} -> {addr[to][:10]} {v / 1e6:.6f} USDC {status}", flush=True)

    roles = {r: addr[n] for n, r in w.roles.items()}
    out = {
        "note": "Seeded demo wallets and the behaviour each was scripted with. For the presenter only; no runtime code reads this file.",
        "seed": a.seed,
        "compress": a.compress,
        "startBlock": start_block,
        "endBlock": w3.eth.block_number,
        "transfers": sent,
        "roles": roles,
    }
    (ROOT / "deployments" / "demo-wallets.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
