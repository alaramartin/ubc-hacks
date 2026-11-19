"""Convert an EZKL proof.json into EVM-friendly form: proof bytes + uint256 instances."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def felt_le_hex_to_int(s: str) -> int:
    return int.from_bytes(bytes.fromhex(s), "little")


def evm_proof(proof_json: Path) -> dict:
    p = json.loads(proof_json.read_text())
    instances = [felt_le_hex_to_int(x) for x in p["instances"][0]]
    hex_proof = p["hex_proof"]
    if not hex_proof.startswith("0x"):
        hex_proof = "0x" + hex_proof
    return {"proof": hex_proof, "instances": [str(i) for i in instances]}


if __name__ == "__main__":
    out = evm_proof(Path(sys.argv[1]))
    Path(sys.argv[2]).write_text(json.dumps(out, indent=2))
