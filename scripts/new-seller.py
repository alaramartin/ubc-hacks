"""Create, fund and register a new seller wallet (a slashed seller can never take jobs again,
so each demo run of a cheating seller needs a fresh one).

    cd seller && uv run python ../scripts/new-seller.py --name CheapRisk --model cheaprisk \
        --price 5000 --bond 500000 --endpoint http://localhost:8002

Writes the key to .sellers/<name>-<address>.key (gitignored), sends bond + gas from DEPLOYER,
registers in ReceiptEscrow, and prints the serve command.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from eth_account import Account

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "seller" / "src"))

from seller.chain import Chain  # noqa: E402
from seller.prover import Model  # noqa: E402

TRANSFER_ABI = [{"type": "function", "name": "transfer", "stateMutability": "nonpayable",
                 "inputs": [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}], "outputs": [{"type": "bool"}]}]
GAS_FUNDS = 100_000  # 0.1 USDC for registration and fulfill gas


def main() -> None:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--price", type=int, required=True)
    ap.add_argument("--bond", type=int, default=500_000)
    ap.add_argument("--endpoint", required=True)
    a = ap.parse_args()

    acct = Account.create()
    d = ROOT / ".sellers"
    d.mkdir(exist_ok=True)
    kf = d / f"{a.name}-{acct.address}.key"
    kf.write_text(acct.key.hex())
    os.chmod(kf, 0o600)

    funder = Chain(os.environ["DEPLOYER_KEY"])
    usdc = funder.w3.eth.contract(address=funder.usdc.address, abi=TRANSFER_ABI)
    r = funder.send(usdc.functions.transfer(acct.address, a.bond + GAS_FUNDS))
    print(f"funded {acct.address} with {(a.bond + GAS_FUNDS) / 1e6} USDC in {r.hash}")

    seller = Chain(acct.key.hex())
    model = Model(ROOT / "model" / "artifacts" / a.model)
    seller.send(seller.usdc.functions.approve(seller.escrow.address, a.bond))
    r = seller.send(seller.escrow.functions.registerSeller(model.commitment, a.price, a.bond, a.endpoint))
    print(f"registered {a.name} {acct.address} commitment {hex(model.commitment)} in {r.hash}")
    print(f"serve: uv run python -m seller serve --key-file {kf.relative_to(ROOT / 'seller', walk_up=True)} --model {a.model} --name {a.name} --mode <mode> --port <port>")


if __name__ == "__main__":
    main()
