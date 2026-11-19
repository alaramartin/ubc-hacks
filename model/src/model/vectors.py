"""Write spec/vectors.json: transfer lists with expected features and felts, for cross-language tests.

    uv run python -m model.vectors
"""

from __future__ import annotations

import json
from pathlib import Path

from .features import FEATURE_NAMES, compute, first_seen, quantize
from .simulate import make_world

ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    scale = json.loads((ROOT / "model/artifacts/riskone/settings.json").read_text())["run_args"]["input_scale"]
    cases = []
    for seed in (42, 43):
        w = make_world(seed)
        tr = w.as_transfers()
        seen = first_seen(tr)
        last = tr[-1].block
        mid = tr[len(tr) // 2].block
        checks = []
        for addr, role in list(w.roles.items())[::3]:
            for block in (mid, last):
                x = compute(addr, tr, block, seen)
                checks.append({"address": addr, "role": role, "block": block, "features": x, "felts": quantize(x, scale)})
        cases.append({"seed": seed, "transfers": [t.to_dict() for t in tr], "checks": checks})
    out = {"feature_names": FEATURE_NAMES, "input_scale": scale, "cases": cases}
    (ROOT / "spec/vectors.json").write_text(json.dumps(out))
    print(f"{sum(len(c['checks']) for c in cases)} checks over {sum(len(c['transfers']) for c in cases)} transfers")


if __name__ == "__main__":
    main()
