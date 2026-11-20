/**
 * x402 client for the "escrow" scheme.
 *
 * Transport is standard x402 (402 + PaymentRequirements, X-PAYMENT, X-PAYMENT-RESPONSE). The scheme
 * pays into ReceiptEscrow with an EIP-3009 ReceiveWithAuthorization whose nonce is the job id,
 * binding the payment to one seller, one input hash and one deadline.
 */
import { getAddress, hashDomain, type Address, type Hex } from "viem";
import { agentAccount, erc20Abi, escrow, publicClient } from "./chain.ts";
import { deployment } from "./config.ts";
import type { SellerView } from "./registry.ts";
import { recordJob } from "./state.ts";

export const NETWORK = `eip155:${deployment.chainId}`;

export type Requirements = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: {
    seller: Address;
    commitment: string;
    verifier: Address;
    challengeWindow: number;
    deadline: number;
    inputHash: Hex;
    nonce: Hex;
  };
};

export type SellerAnswer = {
  jobId: Hex;
  output: string[];
  proof: Hex;
  openTx: Hex;
  fulfillTx: Hex;
  fulfillGas: number;
  proveSeconds: number;
  totalSeconds: number;
};

export class PaymentRejected extends Error {}

let usdcDomainChecked = false;

async function usdcDomain() {
  const [name, version, separator] = await Promise.all([
    publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "name" }),
    publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "version" }),
    publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "DOMAIN_SEPARATOR" }),
  ]);
  const domain = { name, version, chainId: deployment.chainId, verifyingContract: deployment.usdc } as const;
  if (!usdcDomainChecked) {
    const ours = hashDomain({
      domain: { ...domain, chainId: BigInt(domain.chainId) },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    if (ours !== separator) throw new Error("USDC EIP-712 domain does not match DOMAIN_SEPARATOR onchain");
    usdcDomainChecked = true;
  }
  return domain;
}

/** Check every field of the seller's 402 against the chain and our own request. */
async function validate(req: Requirements, seller: SellerView, ih: Hex, maxPrice: bigint): Promise<void> {
  const fail = (why: string) => {
    throw new PaymentRejected(why);
  };
  if (req.scheme !== "escrow") fail(`unsupported scheme ${req.scheme}`);
  if (req.network !== NETWORK) fail(`wrong network ${req.network}`);
  if (getAddress(req.payTo) !== getAddress(deployment.escrow)) fail("payTo is not the ReceiptEscrow contract");
  if (getAddress(req.asset) !== getAddress(deployment.usdc)) fail("asset is not USDC");
  if (getAddress(req.extra.seller) !== getAddress(seller.address)) fail("402 names a different seller");
  if (BigInt(req.extra.commitment) !== seller.commitment) fail("402 commitment differs from the onchain registry");
  if (BigInt(req.maxAmountRequired) !== seller.price) fail("402 price differs from the onchain registry");
  if (seller.price > maxPrice) fail(`price ${seller.price} is over the policy cap ${maxPrice}`);
  if (req.extra.inputHash.toLowerCase() !== ih.toLowerCase()) fail("402 input hash does not match our input");
  const onchainVerifier = (await publicClient.readContract({ ...escrow, functionName: "verifier" })) as Address;
  if (getAddress(req.extra.verifier) !== getAddress(onchainVerifier)) fail("402 verifier is not the escrow's verifier");
  const now = Math.floor(Date.now() / 1000);
  if (req.extra.deadline <= now || req.extra.deadline > now + 900) fail("deadline out of range");
  const nonce = (await publicClient.readContract({
    ...escrow,
    functionName: "jobNonce",
    args: [seller.address, ih, BigInt(req.extra.deadline)],
  })) as Hex;
  if (nonce.toLowerCase() !== req.extra.nonce.toLowerCase()) fail("402 nonce is not the escrow's job nonce");
}

export type Purchase = { requirements: Requirements; answer: SellerAnswer };

export async function buy(
  seller: SellerView,
  body: { address: Address; block: number; input: bigint[] },
  ih: Hex,
  maxPrice: bigint,
): Promise<Purchase> {
  const url = `${seller.endpoint.replace(/\/$/, "")}/v1/risk`;
  const payload = JSON.stringify({ ...body, input: body.input.map(String) });
  const headers = { "content-type": "application/json" };

  const first = await fetch(url, { method: "POST", headers, body: payload });
  if (first.status !== 402) throw new Error(`expected 402 from seller, got ${first.status}: ${await first.text()}`);
  const pr = (await first.json()) as { accepts: Requirements[] };
  const req = pr.accepts.find((a) => a.scheme === "escrow");
  if (!req) throw new PaymentRejected("seller offers no escrow scheme");
  await validate(req, seller, ih, maxPrice);

  const account = agentAccount();
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(deployment.escrow),
    value: BigInt(req.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(now + req.maxTimeoutSeconds),
    nonce: req.extra.nonce,
  };
  const signature = await account.signTypedData({
    domain: await usdcDomain(),
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: authorization,
  });
  const xPayment = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "escrow",
      network: NETWORK,
      payload: {
        authorization: Object.fromEntries(Object.entries(authorization).map(([k, v]) => [k, String(v)])),
        signature,
        deadline: req.extra.deadline,
        inputHash: ih,
      },
    }),
  ).toString("base64");

  // Remember the job before paying, so a seller that takes the payment and never answers can be
  // refunded after the deadline (zkr finalize).
  recordJob(req.extra.nonce, seller.address, body.address, "Open");
  const second = await fetch(url, { method: "POST", headers: { ...headers, "x-payment": xPayment }, body: payload });
  if (!second.ok) throw new Error(`seller returned ${second.status}: ${await second.text()}`);
  const answer = (await second.json()) as SellerAnswer;
  if (answer.jobId.toLowerCase() !== req.extra.nonce.toLowerCase()) throw new Error("seller answered a different job");
  return { requirements: req, answer };
}
