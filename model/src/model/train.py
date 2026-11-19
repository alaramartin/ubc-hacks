"""Train risk models on simulated worlds and export them for EZKL.

    uv run python -m model.train

Writes model/artifacts/<name>/network.onnx and calibration.json for each model:
  - riskone:   the honest seller's model
  - cheaprisk: a second model with the same architecture and different weights (used by the
               swap-model cheat mode: same circuit, different commitment)
Weights files are gitignored; the commitment (Poseidon hash of weights) is what goes onchain.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .features import compute, first_seen
from .net import RiskMLP, export_onnx
from .simulate import label, make_world

ART = Path(__file__).resolve().parents[2] / "artifacts"


def dataset(seeds: range) -> tuple[np.ndarray, np.ndarray, list[str]]:
    xs, ys, roles = [], [], []
    for s in seeds:
        w = make_world(s)
        tr = w.as_transfers()
        seen = first_seen(tr)
        last_block = tr[-1].block
        for addr, role in w.roles.items():
            xs.append(compute(addr, tr, last_block, seen))
            ys.append(label(role))
            roles.append(role)
    return np.array(xs, dtype=np.float32), np.array(ys, dtype=np.float32), roles


def train(name: str, seed: int, x: np.ndarray, y: np.ndarray, epochs: int = 400, train_steps_cap: int | None = None):
    torch.manual_seed(seed)
    m = RiskMLP()
    opt = torch.optim.Adam(m.parameters(), lr=3e-3, weight_decay=1e-4)
    xt, yt = torch.tensor(x), torch.tensor(y).unsqueeze(1)
    pos_weight = (1 - y.mean()) / max(y.mean(), 1e-6)
    lossf = nn.BCELoss(reduction="none")
    for ep in range(epochs if train_steps_cap is None else train_steps_cap):
        perm = torch.randperm(len(xt))
        for i in range(0, len(xt), 256):
            idx = perm[i : i + 256]
            p = m(xt[idx])
            wts = torch.where(yt[idx] > 0.5, torch.tensor(float(pos_weight)), torch.tensor(1.0))
            loss = (lossf(p, yt[idx]) * wts).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
    return m


def evaluate(m: nn.Module, x: np.ndarray, y: np.ndarray, roles: list[str]) -> dict:
    with torch.no_grad():
        p = m(torch.tensor(x)).squeeze(1).numpy()
    pred = p >= 0.5
    acc = float((pred == (y > 0.5)).mean())
    by_role = {}
    for r in sorted(set(roles)):
        idx = [i for i, rr in enumerate(roles) if rr == r]
        by_role[r] = round(float(p[idx].mean()), 3)
    return {"accuracy": round(acc, 4), "mean_score_by_role": by_role}


def main() -> None:
    xtr, ytr, _ = dataset(range(0, 400))
    xte, yte, rte = dataset(range(10_000, 10_100))
    print(f"train {len(xtr)} wallets ({ytr.mean():.1%} risky), test {len(xte)}")

    models = {
        # honest seller: full training
        "riskone": train("riskone", 1, xtr, ytr),
        # cheaper model: same architecture, much less training
        "cheaprisk": train("cheaprisk", 7, xtr, ytr, train_steps_cap=3),
    }
    for name, m in models.items():
        out = ART / name
        out.mkdir(parents=True, exist_ok=True)
        export_onnx(m, out / "network.onnx")
        torch.save(m.state_dict(), out / "weights.pt")
        cal = xtr[np.random.default_rng(0).choice(len(xtr), 64, replace=False)]
        (out / "calibration.json").write_text(json.dumps({"input_data": [cal.flatten().tolist()]}))
        report = evaluate(m, xte, yte, rte)
        (out / "eval.json").write_text(json.dumps(report, indent=2))
        print(name, json.dumps(report))


if __name__ == "__main__":
    main()
