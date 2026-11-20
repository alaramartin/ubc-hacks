"""Start the demo sellers from deployments/demo.json.

    cd seller && uv run python ../scripts/demo_up.py

A seller marked "fresh" gets its own wallet from .sellers/. If its newest wallet is slashed (or there
is none), a new one is created, funded and registered with scripts/new-seller.py first, because a
slashed seller can never take jobs again. Runs every seller as a child process until Ctrl-C.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "seller" / "src"))
from seller.chain import Chain  # noqa: E402


def newest_key(name: str) -> Path | None:
    keys = sorted((ROOT / ".sellers").glob(f"{name}-0x*.key"), key=lambda p: p.stat().st_mtime)
    return keys[-1] if keys else None


def active(chain: Chain, address: str) -> bool:
    s = chain.escrow.functions.sellers(address).call()
    # Seller struct getter: (commitment, price, bond, slashed, registered, endpoint)
    return bool(s[4]) and not bool(s[3])


def main() -> None:
    load_dotenv(ROOT / ".env")
    cfg = json.loads((ROOT / "deployments" / "demo.json").read_text())
    procs = []
    for s in cfg["sellers"]:
        endpoint = f"http://localhost:{s['port']}"
        if s.get("fresh"):
            kf = newest_key(s["name"])
            if kf is None or not active(Chain(kf.read_text().strip()), kf.stem.split("-", 1)[1]):
                subprocess.run(
                    [sys.executable, str(ROOT / "scripts" / "new-seller.py"), "--name", s["name"], "--model", s["model"],
                     "--price", str(s["price"]), "--bond", str(cfg["bond"]), "--endpoint", endpoint],
                    check=True,
                )
                kf = newest_key(s["name"])
            key = ["--key-file", str(kf)]
        else:
            key = ["--key-env", s["keyEnv"]]
        cmd = [sys.executable, "-m", "seller", "serve", *key, "--model", s["model"], "--mode", s["mode"],
               "--name", s["name"], "--port", str(s["port"])]
        if s.get("swapModel"):
            cmd += ["--swap-model", s["swapModel"]]
        print(f"starting {s['name']} ({s['mode']}) on {endpoint}", flush=True)
        procs.append(subprocess.Popen(cmd, cwd=ROOT / "seller"))
    try:
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        for p in procs:
            p.send_signal(signal.SIGINT)


if __name__ == "__main__":
    main()
