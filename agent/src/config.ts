import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Address } from "viem";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
}

export type Deployment = {
  network: string;
  chainId: number;
  rpcEnv: string;
  explorer: string;
  usdc: Address;
  usdcDecimals: number;
  verifier: Address;
  escrow: Address;
  deployBlock: number;
  circuit: string;
};

export type Policy = {
  /** Refuse to pay an address whose proven risk is at or above this. */
  riskThreshold: number;
  /** Most the agent pays for one risk check, in USDC base units. */
  maxCheckPrice: string;
  /** Smallest seller bond the agent accepts, in USDC base units. */
  minSellerBond: string;
  /** Total the agent may spend per UTC day (checks + payments), in USDC base units. */
  dailyBudget: string;
  /** Payments above this many base units need a typed confirmation. */
  approvalAbove: string;
  /** Most seller attempts per check before giving up. */
  maxSellerAttempts: number;
};

export const deployment = readJson<Deployment>("deployments/arc-testnet.json");
export const escrowAbi = readJson<Abi>("deployments/abi/ReceiptEscrow.json");
export const verifierAbi = readJson<Abi>("deployments/abi/Halo2Verifier.json");
export const policy = readJson<Policy>("agent/policy.json");

const circuit = readJson<{ run_args: { input_scale: number }; model_output_scales: number[] }>(deployment.circuit);
export const INPUT_SCALE = circuit.run_args.input_scale;
export const OUTPUT_SCALE = circuit.model_output_scales[0];

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

export const rpcUrl = () => env(deployment.rpcEnv);
export const indexerUrl = () => env("INDEXER_URL").replace(/\/$/, "");
export const receiptsUrl = () => (process.env.RECEIPTS_URL ?? process.env.INDEXER_URL ?? "").replace(/\/$/, "");
