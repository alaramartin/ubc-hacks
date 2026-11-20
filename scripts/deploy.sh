#!/usr/bin/env bash
# Deploy the shared verifier (from model/artifacts/riskone) and ReceiptEscrow to Arc testnet,
# then write deployments/arc-testnet.json and the ABIs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; set +a

export USDC_ADDRESS=0x3600000000000000000000000000000000000000
export N_INPUTS=7 N_OUTPUTS=1
export MIN_BOND="${MIN_BOND:-500000}"          # 0.5 USDC
export SLASH_AMOUNT="${SLASH_AMOUNT:-250000}"  # 0.25 USDC
export CHALLENGE_WINDOW="${CHALLENGE_WINDOW:-60}"
export VERIFY_GAS="${VERIFY_GAS:-3000000}"

cp "$ROOT/model/artifacts/riskone/Verifier.sol" "$ROOT/contracts/src/Halo2Verifier.sol"
cd "$ROOT/contracts"
OUT=$(forge script script/Deploy.s.sol --rpc-url "$ARC_RPC_URL" --broadcast 2>&1) || { echo "$OUT"; exit 1; }
V=$(echo "$OUT" | awk '/verifier 0x/{print $2}')
E=$(echo "$OUT" | awk '/escrow 0x/{print $2}')
B=$(cast block-number --rpc-url "$ARC_RPC_URL" 2>/dev/null)

python3 - "$ROOT" "$V" "$E" "$B" <<'PY'
import json, os, sys
root, v, e, b = sys.argv[1:5]
d = {
    "network": "arc-testnet", "chainId": 5042002, "rpcEnv": "ARC_RPC_URL",
    "explorer": "https://testnet.arcscan.app",
    "usdc": os.environ["USDC_ADDRESS"], "usdcDecimals": 6,
    "verifier": v, "escrow": e, "deployBlock": int(b),
    "escrowParams": {k: int(os.environ[k.upper()]) for k in ["min_bond", "slash_amount", "challenge_window", "verify_gas"]},
    "circuit": "model/artifacts/riskone/settings.json",
}
open(f"{root}/deployments/arc-testnet.json", "w").write(json.dumps(d, indent=2) + "\n")
for c in ["ReceiptEscrow", "Halo2Verifier"]:
    abi = json.load(open(f"{root}/contracts/out/{c}.sol/{c}.json"))["abi"]
    json.dump(abi, open(f"{root}/deployments/abi/{c}.json", "w"), indent=1)
print(json.dumps(d, indent=2))
PY
