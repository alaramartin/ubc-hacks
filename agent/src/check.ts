/**
 * The decision loop's core: buy a proven risk check, verify it, challenge it if it is bad.
 */
import pc from "picocolors";
import { decodeEventLog, keccak256, type Address, type Hex } from "viem";
import { escrow, getJob, inputHash, publicClient, signedFromFelt, STATUS, verifiesOffchain, walletClient } from "./chain.ts";
import { INPUT_SCALE, OUTPUT_SCALE, indexerUrl, policy, receiptsUrl } from "./config.ts";
import { listSellers, type SellerView } from "./registry.ts";
import { addSpend, recordJob, spentToday } from "./state.ts";
import * as ui from "./ui.ts";
import { buy, PaymentRejected } from "./x402.ts";

export type Features = { address: Address; block: number; names: string[]; features: number[]; transfers: number };

export type CheckResult =
  | { ok: true; risk: number; logit: number; seller: SellerView; jobId: Hex; spent: bigint }
  | { ok: false; reason: string; spent: bigint };

/** round(x * 2^scale), ties to even, as in spec/features.json. */
export function quantize(x: number, scale: number): bigint {
  const v = x * 2 ** scale;
  const f = Math.floor(v);
  const diff = v - f;
  const r = diff > 0.5 ? f + 1 : diff < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return BigInt(r);
}

export async function fetchFeatures(address: Address): Promise<Features> {
  const res = await fetch(`${indexerUrl()}/api/features/${address}`);
  if (!res.ok) throw new Error(`indexer returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as Features;
}

async function sellerName(s: SellerView): Promise<string> {
  try {
    const r = await fetch(s.endpoint, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { name?: string };
    return j.name ?? ui.addr(s.address);
  } catch {
    return ui.addr(s.address);
  }
}

/** Active sellers the policy allows, cheapest first. */
export async function eligibleSellers(exclude: Set<string>): Promise<SellerView[]> {
  const all = await listSellers();
  return all
    .filter((s) => s.registered && !s.slashed && !exclude.has(s.address.toLowerCase()))
    .filter((s) => s.bond >= BigInt(policy.minSellerBond) && s.price <= BigInt(policy.maxCheckPrice))
    .sort((a, b) => (a.price === b.price ? Number(b.bond - a.bond) : Number(a.price - b.price)));
}

async function challenge(jobId: Hex, felts: bigint[], proof: Hex) {
  const wallet = walletClient();
  const hash = await wallet.writeContract({ ...escrow, functionName: "challenge", args: [jobId, felts, proof], gas: 5_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (receipt.status !== "success") throw new Error(`challenge ${hash} reverted`);
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: escrow.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "JobSlashed") {
        const a = ev.args as unknown as { refunded: bigint; slashed: bigint };
        return { hash, refunded: a.refunded, slashed: a.slashed, gas: receipt.gasUsed };
      }
    } catch {
      /* other contract's log */
    }
  }
  throw new Error(`challenge ${hash} did not emit JobSlashed`);
}

/**
 * Buy one verified risk score for `address`, trying sellers cheapest first. A seller whose proof
 * fails is challenged onchain (refund + slash) and the next seller is tried.
 */
export async function riskCheck(address: Address): Promise<CheckResult> {
  return riskCheckWith(await fetchFeatures(address));
}

/**
 * What a plain x402 buyer does: pay the cheapest seller and believe the number it returns.
 * The answer is read from chain like riskCheck does, but nothing is verified or challenged.
 */
export async function trustingCheck(address: Address): Promise<CheckResult> {
  const f = await fetchFeatures(address);
  const felts = f.features.map((x) => quantize(x, INPUT_SCALE));
  const ih = inputHash(felts);
  ui.step("features", `${f.features.length} features over ${f.transfers} USDC transfers, indexed by our Stream up to block ${f.block.toLocaleString()}`);
  const [s] = await eligibleSellers(new Set());
  if (!s) return { ok: false, reason: "no eligible seller", spent: 0n };
  if (spentToday() + s.price > BigInt(policy.dailyBudget)) return { ok: false, reason: "daily budget used up", spent: 0n };
  ui.step("seller", `${pc.bold(await sellerName(s))} ${ui.addr(s.address)}  price ${ui.usdc(s.price)}  ${pc.dim("(cheapest)")}`);
  const { answer: a } = await buy(s, { address, block: f.block, input: felts }, ih, BigInt(policy.maxCheckPrice));
  addSpend(s.price);
  recordJob(a.jobId, s.address, address, "Fulfilled");
  const job = await getJob(a.jobId);
  const logit = Number(signedFromFelt(job.output[0])) / 2 ** OUTPUT_SCALE;
  const risk = 1 / (1 + Math.exp(-logit));
  ui.step("answer", `risk ${pc.bold(risk.toFixed(4))}  tx ${ui.tx(a.fulfillTx)}`);
  ui.note(pc.yellow("--trust: proof not checked, answer taken at face value"));
  return { ok: true, risk, logit, seller: s, jobId: a.jobId, spent: s.price };
}

/** riskCheck with features already in hand (the indexer's answer, or a test vector in tests). */
export async function riskCheckWith(f: Features): Promise<CheckResult> {
  const address = f.address;
  const felts = f.features.map((x) => quantize(x, INPUT_SCALE));
  const ih = inputHash(felts);
  ui.step("features", `${f.features.length} features over ${f.transfers} USDC transfers, indexed by our Stream up to block ${f.block.toLocaleString()}`);
  ui.note(f.names.map((n, i) => `${n}=${f.features[i].toFixed(3)}`).join("  "));

  const tried = new Set<string>();
  let spent = 0n;
  for (let attempt = 0; attempt < policy.maxSellerAttempts; attempt++) {
    const sellers = await eligibleSellers(tried);
    if (sellers.length === 0) return { ok: false, reason: "no eligible seller left", spent };
    const s = sellers[0];
    tried.add(s.address.toLowerCase());
    const name = await sellerName(s);

    if (spentToday() + s.price > BigInt(policy.dailyBudget)) return { ok: false, reason: "daily budget used up", spent };
    ui.step("seller", `${pc.bold(name)} ${ui.addr(s.address)}  price ${ui.usdc(s.price)}  bond ${ui.usdc(s.bond)}  ${pc.dim(`(cheapest of ${sellers.length} eligible)`)}`);

    let p;
    try {
      p = await buy(s, { address, block: f.block, input: felts }, ih, BigInt(policy.maxCheckPrice));
    } catch (e) {
      if (e instanceof PaymentRejected) {
        ui.bad("402 refused", e.message);
        continue;
      }
      ui.bad("seller error", (e as Error).message);
      continue;
    }
    const { answer: a, requirements: r } = p;
    addSpend(s.price);
    spent += s.price;
    ui.step("402", `pay ${ui.usdc(s.price)} into escrow ${ui.addr(r.payTo)}  commitment ${ui.short(BigInt(r.extra.commitment).toString(16).padStart(64, "0"))}`);
    ui.step("escrow open", `${ui.usdc(s.price)} locked  tx ${ui.tx(a.openTx)}`);
    recordJob(a.jobId, s.address, address, "Fulfilled");

    // Read the job back from chain: the answer we judge is what the seller posted, not what it told us.
    const job = await getJob(a.jobId);
    if (STATUS[job.status] !== "Fulfilled") throw new Error(`job is ${STATUS[job.status]}, expected Fulfilled`);
    if (keccak256(a.proof) !== job.proofHash) throw new Error("seller sent different proof bytes than it posted");
    const logit = Number(signedFromFelt(job.output[0])) / 2 ** OUTPUT_SCALE;
    const risk = 1 / (1 + Math.exp(-logit));
    ui.step("answer", `risk ${pc.bold(risk.toFixed(4))} (logit ${logit.toFixed(2)})  proof ${(a.proof.length / 2 - 1).toLocaleString()} bytes, proved in ${a.proveSeconds}s  tx ${ui.tx(a.fulfillTx)}`);

    const instances = [job.commitment, ...felts, ...job.output];
    const t = Date.now();
    const valid = await verifiesOffchain(a.proof, instances);
    if (valid) {
      ui.ok("verify", `proof checks out against commitment, our input and the posted output  ${pc.dim(`eth_call, ${Date.now() - t} ms, no gas`)}`);
      const rec = receiptsUrl();
      if (rec) ui.note(`receipt ${rec}/r/${a.jobId}`);
      return { ok: true, risk, logit, seller: s, jobId: a.jobId, spent };
    }

    ui.bad("verify", `proof does NOT match commitment + our input + posted output  ${pc.dim(`eth_call, ${Date.now() - t} ms`)}`);
    const c = await challenge(a.jobId, felts, a.proof);
    ui.bad("challenge", `onchain verify failed: refunded ${ui.usdc(c.refunded)}, seller bond slashed ${ui.usdc(c.slashed)}  tx ${ui.tx(c.hash)}  ${pc.dim(`${c.gas.toLocaleString()} gas`)}`);
    recordJob(a.jobId, s.address, address, "Slashed");
    const rec = receiptsUrl();
    if (rec) ui.note(`receipt ${rec}/r/${a.jobId}`);
    spent -= c.refunded;
    addSpend(-c.refunded);
  }
  return { ok: false, reason: `no verified answer after ${policy.maxSellerAttempts} sellers`, spent };
}
