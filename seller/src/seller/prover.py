"""Run a committed model on given input felts and produce an EZKL proof."""

from __future__ import annotations

import json
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import ezkl

from model.ezkl_pipeline import SRS_DIR, _call
from model.fixture import felt_le_hex_to_int

FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617


def felt_to_signed(f: int) -> int:
    return f - FIELD if f > FIELD // 2 else f


def signed_to_felt(v: int) -> int:
    return v % FIELD


@dataclass
class Proof:
    instances: list[int]  # [commitment, input..., output...]
    proof_hex: str
    prove_s: float

    @property
    def commitment(self) -> int:
        return self.instances[0]

    @property
    def inputs(self) -> list[int]:
        return self.instances[1:-1]

    @property
    def output(self) -> list[int]:
        return self.instances[-1:]


class Model:
    """One model's EZKL artifacts (model/artifacts/<name>)."""

    def __init__(self, artifacts: Path):
        self.dir = artifacts
        self.settings = json.loads((artifacts / "settings.json").read_text())
        self.input_scale = self.settings["run_args"]["input_scale"]
        self.output_scale = self.settings["model_output_scales"][0]
        self.commitment = int(json.loads((artifacts / "commitment.json").read_text())["commitment"])
        self.srs = SRS_DIR / f"kzg{self.settings['run_args']['logrows']}.srs"
        for f in ("network.ezkl", "pk.key", "vk.key"):
            if not (artifacts / f).exists():
                raise FileNotFoundError(f"{artifacts / f} missing: run model.train and model.ezkl_pipeline first")

    def prove(self, input_felts: list[int]) -> Proof:
        floats = [felt_to_signed(f) / (1 << self.input_scale) for f in input_felts]
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "input.json").write_text(json.dumps({"input_data": [floats]}))
            t = time.time()
            _call(ezkl.gen_witness, str(d / "input.json"), str(self.dir / "network.ezkl"), str(d / "witness.json"))
            _call(ezkl.prove, str(d / "witness.json"), str(self.dir / "network.ezkl"), str(self.dir / "pk.key"),
                  str(d / "proof.json"), str(self.srs))
            dt = time.time() - t
            p = json.loads((d / "proof.json").read_text())
        instances = [felt_le_hex_to_int(x) for x in p["instances"][0]]
        hex_proof = p["hex_proof"] if p["hex_proof"].startswith("0x") else "0x" + p["hex_proof"]
        proof = Proof(instances, hex_proof, round(dt, 2))
        # The witness must quantize back to exactly the felts we were given, or the proof would be
        # over a different input than the buyer paid for.
        if proof.inputs != [signed_to_felt(felt_to_signed(f)) for f in input_felts]:
            raise ValueError("input felts did not round-trip through EZKL quantization")
        return proof
