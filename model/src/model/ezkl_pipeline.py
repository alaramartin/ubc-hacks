"""EZKL pipeline: ONNX model -> settings, compiled circuit, keys, EVM verifier.

Usage:
    uv run python -m model.ezkl_pipeline <artifacts_dir> [--circuit-from <artifacts_dir>]

With --circuit-from, the model reuses another model's settings.json (same architecture, same
scales and logrows), so both share one verifying key and one onchain verifier.

<artifacts_dir> must contain network.onnx and calibration.json (EZKL input format:
{"input_data": [[...7 floats...], ...]}). Outputs are written next to them.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import ezkl

SRS_DIR = Path(__file__).resolve().parents[2] / ".srs"


def _call(fn, *a, **kw):
    """Some ezkl functions need a running event loop and may return an awaitable."""

    async def go():
        res = fn(*a, **kw)
        if asyncio.iscoroutine(res) or isinstance(res, asyncio.Future):
            res = await res
        return res

    return asyncio.run(go())


def run_args() -> ezkl.PyRunArgs:
    ra = ezkl.PyRunArgs()
    ra.input_visibility = "public"
    ra.output_visibility = "public"
    ra.param_visibility = "hashed"
    return ra


def build(art: Path, circuit_from: Path | None = None) -> dict:
    onnx = art / "network.onnx"
    settings = art / "settings.json"
    compiled = art / "network.ezkl"
    vk = art / "vk.key"
    pk = art / "pk.key"
    cal = art / "calibration.json"

    timings: dict[str, float] = {}

    def step(name, fn, *a, **kw):
        t = time.time()
        res = _call(fn, *a, **kw)
        timings[name] = round(time.time() - t, 2)
        if res is False:
            raise RuntimeError(f"ezkl step {name} returned False")
        return res

    if circuit_from is None:
        step("gen_settings", ezkl.gen_settings, str(onnx), str(settings), py_run_args=run_args())
        step("calibrate", ezkl.calibrate_settings, str(cal), str(onnx), str(settings), "resources")
    else:
        settings.write_text((circuit_from / "settings.json").read_text())
    step("compile", ezkl.compile_circuit, str(onnx), str(compiled), str(settings))

    logrows = json.loads(settings.read_text())["run_args"]["logrows"]
    SRS_DIR.mkdir(exist_ok=True)
    srs = SRS_DIR / f"kzg{logrows}.srs"
    if not srs.exists():
        step("get_srs", ezkl.get_srs, str(settings), logrows, str(srs))
    step("setup", ezkl.setup, str(compiled), str(vk), str(pk), str(srs))
    step(
        "create_evm_verifier",
        ezkl.create_evm_verifier,
        str(vk),
        str(settings),
        str(art / "Verifier.sol"),
        str(art / "Verifier.abi"),
        str(srs),
    )
    commitment = model_commitment(art)
    (art / "commitment.json").write_text(json.dumps({"commitment": str(commitment), "hex": hex(commitment)}, indent=2))
    return {"logrows": logrows, "commitment": hex(commitment), "timings": timings}


def model_commitment(art: Path) -> int:
    """Poseidon hash of the model parameters, as EZKL exposes it in the witness (instance 0)."""
    settings = json.loads((art / "settings.json").read_text())
    tmp = art / "_commit"
    tmp.mkdir(exist_ok=True)
    zero = tmp / "input.json"
    zero.write_text(json.dumps({"input_data": [[0.0] * 7]}))
    _call(ezkl.gen_witness, str(zero), str(art / "network.ezkl"), str(tmp / "witness.json"))
    w = json.loads((tmp / "witness.json").read_text())
    h = w["processed_params"]["poseidon_hash"]
    assert len(h) == 1, f"expected one param hash felt, got {len(h)}"
    return int.from_bytes(bytes.fromhex(h[0]), "little")


def prove(art: Path, input_json: Path, out_dir: Path) -> dict:
    """Witness + proof for one input. Returns paths and timings."""
    logrows = json.loads((art / "settings.json").read_text())["run_args"]["logrows"]
    srs = SRS_DIR / f"kzg{logrows}.srs"
    out_dir.mkdir(parents=True, exist_ok=True)
    witness = out_dir / "witness.json"
    proof = out_dir / "proof.json"
    t = time.time()
    ezkl.gen_witness(str(input_json), str(art / "network.ezkl"), str(witness))
    t_w = time.time() - t
    t = time.time()
    ezkl.prove(str(witness), str(art / "network.ezkl"), str(art / "pk.key"), str(proof), str(srs))
    t_p = time.time() - t
    ok = ezkl.verify(str(proof), str(art / "settings.json"), str(art / "vk.key"), str(srs))
    return {"witness": witness, "proof": proof, "witness_s": round(t_w, 2), "prove_s": round(t_p, 2), "verified": ok}


if __name__ == "__main__":
    art = Path(sys.argv[1]).resolve()
    src = Path(sys.argv[sys.argv.index("--circuit-from") + 1]).resolve() if "--circuit-from" in sys.argv else None
    print(json.dumps(build(art, src), indent=2))
