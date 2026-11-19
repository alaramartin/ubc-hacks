"""Seller CLI.

    uv run python -m seller serve    --key-env SELLER_HONEST_KEY --model riskone --mode honest --port 8001
    uv run python -m seller register --key-env SELLER_HONEST_KEY --model riskone --price 10000 --bond 500000 \
        --endpoint http://localhost:8001
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / "model" / "artifacts"


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser(prog="seller")
    sub = p.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve")
    sv.add_argument("--key-env", help="env var holding the seller's private key")
    sv.add_argument("--key-file", help="file holding the seller's private key (from scripts/new-seller.py)")
    sv.add_argument("--model", required=True, help="model artifacts name the seller committed to")
    sv.add_argument("--mode", default="honest")
    sv.add_argument("--swap-model", help="artifacts name of the model swap-model runs instead")
    sv.add_argument("--name", default=None)
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8001)

    rg = sub.add_parser("register")
    rg.add_argument("--key-env")
    rg.add_argument("--key-file")
    rg.add_argument("--model", required=True)
    rg.add_argument("--price", type=int, required=True, help="USDC base units per check")
    rg.add_argument("--bond", type=int, required=True, help="USDC base units")
    rg.add_argument("--endpoint", required=True)

    a = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    from .chain import Chain
    from .prover import Model

    if bool(a.key_env) == bool(a.key_file):
        p.error("pass exactly one of --key-env or --key-file")
    key = os.environ[a.key_env] if a.key_env else Path(a.key_file).read_text().strip()
    chain = Chain(key)
    model = Model(ARTIFACTS / a.model)

    if a.cmd == "register":
        chain.send(chain.usdc.functions.approve(chain.escrow.address, a.bond))
        r = chain.send(chain.escrow.functions.registerSeller(model.commitment, a.price, a.bond, a.endpoint))
        print(f"registered {chain.address} commitment {hex(model.commitment)} in {r.hash}")
        return

    import uvicorn

    from .app import create_app
    from .modes import Behaviour

    swap = Model(ARTIFACTS / a.swap_model) if a.swap_model else None
    behaviour = Behaviour(a.mode, model, swap)
    name = a.name or a.model
    logging.getLogger("seller").info("%s serving as %s with mode %s", name, chain.address, a.mode)
    uvicorn.run(create_app(chain, behaviour, name), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
