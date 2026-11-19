import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodePacked,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployment, env, escrowAbi, rpcUrl, verifierAbi } from "./config.ts";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const arc = defineChain({
  id: deployment.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl()] } },
  blockExplorers: { default: { name: "Arcscan", url: deployment.explorer } },
});

export const publicClient = createPublicClient({ chain: arc, transport: http(rpcUrl(), { timeout: 30_000 }) });

export function agentAccount() {
  return privateKeyToAccount(env("AGENT_KEY") as Hex);
}

export function walletClient() {
  return createWalletClient({ chain: arc, transport: http(rpcUrl()), account: agentAccount() });
}

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

export const escrow = { address: deployment.escrow, abi: escrowAbi } as const;
export const verifier = { address: deployment.verifier, abi: verifierAbi } as const;

export function inputHash(felts: bigint[]): Hex {
  return keccak256(encodePacked(["uint256[]"], [felts]));
}

export function signedFromFelt(f: bigint): bigint {
  return f > FIELD / 2n ? f - FIELD : f;
}

export function txUrl(hash: Hex): string {
  return `${deployment.explorer}/tx/${hash}`;
}

export function addressUrl(a: Address): string {
  return `${deployment.explorer}/address/${a}`;
}

export type JobView = {
  buyer: Address;
  seller: Address;
  commitment: bigint;
  price: bigint;
  inputHash: Hex;
  proofHash: Hex;
  deadline: bigint;
  fulfilledAt: bigint;
  status: number;
  output: readonly bigint[];
};

export const STATUS = ["None", "Open", "Fulfilled", "Finalized", "Slashed", "Refunded"] as const;

export async function getJob(jobId: Hex): Promise<JobView> {
  return (await publicClient.readContract({ ...escrow, functionName: "getJob", args: [jobId] })) as JobView;
}

/** eth_call the shared verifier. A revert counts as "does not verify". Free: no transaction. */
export async function verifiesOffchain(proof: Hex, instances: bigint[]): Promise<boolean> {
  try {
    const { result } = await publicClient.simulateContract({
      ...verifier,
      functionName: "verifyProof",
      args: [proof, instances],
      account: agentAccount().address,
    });
    return result === true;
  } catch {
    return false;
  }
}
