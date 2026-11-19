"""The risk model: a small MLP over the features in spec/features.json."""

from __future__ import annotations

from pathlib import Path

import torch
from torch import nn

N_FEATURES = 7


class RiskMLP(nn.Module):
    def __init__(self, hidden: tuple[int, int] = (16, 8)):
        super().__init__()
        h1, h2 = hidden
        self.net = nn.Sequential(
            nn.Linear(N_FEATURES, h1),
            nn.ReLU(),
            nn.Linear(h1, h2),
            nn.ReLU(),
            nn.Linear(h2, 1),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def export_onnx(model: nn.Module, path: Path) -> None:
    model.eval()
    dummy = torch.zeros(1, N_FEATURES)
    torch.onnx.export(
        model,
        dummy,
        str(path),
        input_names=["input"],
        output_names=["output"],
        opset_version=13,
        dynamo=False,
    )
