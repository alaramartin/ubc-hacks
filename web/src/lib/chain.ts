import { createPublicClient, defineChain, http, type Abi, type Address } from "viem";
import circuit from "./deploy/circuit.json" with { type: "json" };
import deployment from "./deploy/arc-testnet.json" with { type: "json" };
import escrowAbiJson from "./deploy/HonestEscrow.json" with { type: "json" };
import verifierAbiJson from "./deploy/Halo2Verifier.json" with { type: "json" };

export const DEPLOYMENT = deployment as typeof deployment & { escrow: Address; verifier: Address; usdc: Address };
export const escrowAbi = escrowAbiJson as Abi;
export const verifierAbi = verifierAbiJson as Abi;
export const INPUT_SCALE: number = circuit.run_args.input_scale;
export const OUTPUT_SCALE: number = circuit.model_output_scales[0];
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Public Arc RPC, safe to use from the browser. */
export const PUBLIC_RPC = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

export const arc = defineChain({
  id: DEPLOYMENT.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
});

export function client(rpc = process.env.ARC_RPC_URL ?? PUBLIC_RPC) {
  return createPublicClient({ chain: arc, transport: http(rpc) });
}

export const STATUS = ["None", "Open", "Fulfilled", "Finalized", "Slashed", "Refunded"] as const;

export function signed(f: bigint): bigint {
  return f > FIELD / 2n ? f - FIELD : f;
}

export function riskOf(outputFelt: bigint): { logit: number; risk: number } {
  const logit = Number(signed(outputFelt)) / 2 ** OUTPUT_SCALE;
  return { logit, risk: 1 / (1 + Math.exp(-logit)) };
}

export const txUrl = (h: string) => `${DEPLOYMENT.explorer}/tx/${h}`;
export const addrUrl = (a: string) => `${DEPLOYMENT.explorer}/address/${a}`;
