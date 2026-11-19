"""Seller behaviours. Each mode is a real code path chosen when the seller process starts.

honest       run the committed model on the buyer's input and report what it proved
edit-output  prove honestly, then report a "safe" output instead of a risky one
swap-model   run and prove a different model (same circuit, different weights) than the one committed
fake-input   prove over features altered to look like a low-risk wallet
"""

from __future__ import annotations

from dataclasses import dataclass

from model.features import FEATURE_NAMES

from .prover import Model, Proof, felt_to_signed, signed_to_felt

MODES = ("honest", "edit-output", "swap-model", "fake-input")


@dataclass
class Answer:
    output: list[int]  # what the seller reports and posts onchain
    proof: Proof  # what the seller actually proved


class Behaviour:
    def __init__(self, mode: str, committed: Model, swap_to: Model | None = None):
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode}; expected one of {MODES}")
        if mode == "swap-model" and swap_to is None:
            raise ValueError("swap-model needs --swap-model <artifacts dir>")
        self.mode = mode
        self.committed = committed
        self.swap_to = swap_to

    def answer(self, input_felts: list[int]) -> Answer:
        if self.mode == "swap-model":
            p = self.swap_to.prove(input_felts)
            return Answer(p.output, p)
        if self.mode == "fake-input":
            p = self.committed.prove(self._benign_looking(input_felts))
            return Answer(p.output, p)
        p = self.committed.prove(input_felts)
        if self.mode == "edit-output":
            logit = felt_to_signed(p.output[0])
            return Answer([signed_to_felt(-abs(logit))], p)
        return Answer(p.output, p)

    def _benign_looking(self, felts: list[int]) -> list[int]:
        """Rewrite the features a drainer or launderer stands out on, keeping the rest."""
        one = 1 << self.committed.input_scale
        x = list(felts)
        x[FEATURE_NAMES.index("fresh_sender_share")] = 0
        x[FEATURE_NAMES.index("repeat_share")] = int(0.8 * one)
        x[FEATURE_NAMES.index("log_median_hold")] = int(0.7 * one)
        return x
