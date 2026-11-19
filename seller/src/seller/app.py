"""x402 seller: risk checks paid into HonestEscrow, answered with an EZKL proof.

Protocol (see PLAN.md "One paid request"):
  POST /v1/risk {address, block, input: [felt strings]}
    no X-PAYMENT    -> 402 with PaymentRequirements (scheme "escrow")
    with X-PAYMENT  -> open the escrow job, prove, fulfill onchain, 200 with the answer and proof
"""

from __future__ import annotations

import base64
import json
import logging
import math
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from web3 import Web3

from .chain import DEPLOYMENT, Chain
from .modes import Behaviour
from .prover import felt_to_signed

log = logging.getLogger("seller")

X402_VERSION = 1
NETWORK = f"eip155:{DEPLOYMENT['chainId']}"
JOB_TTL_S = 300


def input_hash(felts: list[int]) -> bytes:
    return Web3.solidity_keccak(["uint256[]"], [felts])


def b64json(o: dict) -> str:
    return base64.b64encode(json.dumps(o).encode()).decode()


def create_app(chain: Chain, behaviour: Behaviour, name: str) -> FastAPI:
    app = FastAPI(title=f"Honest Model seller: {name}")
    escrow = chain.escrow
    n_inputs = escrow.functions.nInputs().call()

    def seller_info() -> dict:
        commitment, price, bond, slashed, registered, endpoint = escrow.functions.sellers(chain.address).call()
        return {"commitment": commitment, "price": price, "bond": bond, "slashed": slashed, "registered": registered}

    @app.get("/")
    def info():
        s = seller_info()
        return {
            "name": name,
            "seller": chain.address,
            "escrow": escrow.address,
            "network": NETWORK,
            "commitment": hex(s["commitment"]),
            "price": s["price"],
            "registered": s["registered"],
            "slashed": s["slashed"],
        }

    @app.post("/v1/risk")
    async def risk(request: Request):
        body = await request.json()
        try:
            felts = [int(x) for x in body["input"]]
            address = Web3.to_checksum_address(body["address"])
            block = int(body["block"])
        except (KeyError, ValueError, TypeError) as e:
            return JSONResponse({"error": f"bad request: {e}"}, status_code=400)
        if len(felts) != n_inputs:
            return JSONResponse({"error": f"expected {n_inputs} input felts"}, status_code=400)

        s = seller_info()
        if not s["registered"] or s["slashed"]:
            return JSONResponse({"error": "seller is not active in the escrow"}, status_code=503)
        ih = input_hash(felts)

        header = request.headers.get("x-payment")
        if not header:
            deadline = int(time.time()) + JOB_TTL_S
            nonce = escrow.functions.jobNonce(chain.address, ih, deadline).call()
            return JSONResponse(
                {
                    "x402Version": X402_VERSION,
                    "error": "X-PAYMENT header is required",
                    "accepts": [
                        {
                            "scheme": "escrow",
                            "network": NETWORK,
                            "maxAmountRequired": str(s["price"]),
                            "resource": str(request.url),
                            "description": f"Proven risk score for {address} at block {block}",
                            "mimeType": "application/json",
                            "payTo": escrow.address,
                            "asset": DEPLOYMENT["usdc"],
                            "maxTimeoutSeconds": JOB_TTL_S,
                            "extra": {
                                "seller": chain.address,
                                "commitment": str(s["commitment"]),
                                "verifier": DEPLOYMENT["verifier"],
                                "challengeWindow": escrow.functions.challengeWindow().call(),
                                "deadline": deadline,
                                "inputHash": "0x" + ih.hex(),
                                "nonce": "0x" + bytes(nonce).hex(),
                                "authorization": "ReceiveWithAuthorization",
                            },
                        }
                    ],
                },
                status_code=402,
            )

        try:
            payment = json.loads(base64.b64decode(header))
            assert payment["scheme"] == "escrow" and payment["network"] == NETWORK
            auth = payment["payload"]["authorization"]
            sig = payment["payload"]["signature"]
            deadline = int(payment["payload"]["deadline"])
        except Exception as e:  # noqa: BLE001 - any malformed header is a 402
            return JSONResponse({"x402Version": X402_VERSION, "error": f"invalid X-PAYMENT: {e}"}, status_code=402)

        sig_bytes = bytes.fromhex(sig.removeprefix("0x"))
        r, s_, v = sig_bytes[:32], sig_bytes[32:64], sig_bytes[64]
        if v < 27:
            v += 27
        t0 = time.time()
        try:
            opened = chain.send(
                escrow.functions.open(
                    chain.address,
                    ih,
                    deadline,
                    (
                        Web3.to_checksum_address(auth["from"]),
                        int(auth["value"]),
                        int(auth["validAfter"]),
                        int(auth["validBefore"]),
                        v,
                        r,
                        s_,
                    ),
                )
            )
        except Exception as e:  # noqa: BLE001
            log.exception("open failed")
            return JSONResponse({"x402Version": X402_VERSION, "error": f"escrow open failed: {e}"}, status_code=402)
        job_id = escrow.functions.jobNonce(chain.address, ih, deadline).call()
        log.info("job %s opened in %s", job_id.hex(), opened.hash)

        ans = behaviour.answer(felts)
        proof_bytes = bytes.fromhex(ans.proof.proof_hex.removeprefix("0x"))
        fulfilled = chain.send(escrow.functions.fulfill(job_id, ans.output, proof_bytes))
        log.info("job %s fulfilled in %s (mode %s)", job_id.hex(), fulfilled.hash, behaviour.mode)

        out_scale = behaviour.committed.output_scale
        logit = felt_to_signed(ans.output[0]) / (1 << out_scale)
        resp = {
            "jobId": "0x" + bytes(job_id).hex(),
            "address": address,
            "block": block,
            "output": [str(o) for o in ans.output],
            "outputScale": out_scale,
            "logit": logit,
            "risk": 1 / (1 + math.exp(-logit)),
            "proof": ans.proof.proof_hex,
            "openTx": opened.hash,
            "fulfillTx": fulfilled.hash,
            "fulfillGas": fulfilled.gas_used,
            "proveSeconds": ans.proof.prove_s,
            "totalSeconds": round(time.time() - t0, 2),
        }
        return JSONResponse(
            resp,
            headers={
                "X-PAYMENT-RESPONSE": b64json(
                    {"success": True, "transaction": opened.hash, "network": NETWORK, "payer": auth["from"]}
                )
            },
        )

    return app
