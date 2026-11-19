"use client";
import { useState } from "react";
import { createPublicClient, http, type Hex } from "viem";
import { arc, DEPLOYMENT, PUBLIC_RPC, verifierAbi } from "@/lib/chain";

/** Re-runs the onchain verifier from this browser with an eth_call. */
export function VerifyAgain({ proof, instances }: { proof: Hex; instances: string[] }) {
  const [state, setState] = useState<"idle" | "running" | "valid" | "invalid" | "error">("idle");
  const [ms, setMs] = useState(0);
  async function run() {
    setState("running");
    const t = performance.now();
    try {
      const c = createPublicClient({ chain: arc, transport: http(PUBLIC_RPC) });
      const ok = await c
        .readContract({ address: DEPLOYMENT.verifier, abi: verifierAbi, functionName: "verifyProof", args: [proof, instances.map(BigInt)] })
        .then((r) => r === true)
        .catch(() => false);
      setMs(Math.round(performance.now() - t));
      setState(ok ? "valid" : "invalid");
    } catch {
      setState("error");
    }
  }
  return (
    <div className="verify">
      <button onClick={run} disabled={state === "running"}>
        {state === "running" ? "Verifying" : "Verify again"}
      </button>
      {state === "valid" && <span className="result set good">Proof verifies ({ms} ms, eth_call to {DEPLOYMENT.verifier.slice(0, 10)}…)</span>}
      {state === "invalid" && <span className="result set bad">Proof does not verify against these values</span>}
      {state === "error" && <span className="result bad">Could not reach the Arc RPC</span>}
    </div>
  );
}
