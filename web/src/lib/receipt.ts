import { decodeEventLog, toEventSelector, type Address, type Hex } from "viem";
import { client, DEPLOYMENT, escrowAbi, riskOf, STATUS } from "./chain";
import { sql } from "./db";

export type Receipt = {
  jobId: Hex;
  status: (typeof STATUS)[number];
  buyer: Address;
  seller: Address;
  commitment: bigint;
  price: bigint;
  deadline: number;
  output: bigint[];
  risk: number | null;
  logit: number | null;
  input: bigint[] | null;
  proof: Hex | null;
  challengeEndsAt: number | null;
  events: { name: string; tx: Hex; block: number; ts: number; args: Record<string, unknown> }[];
};

type Job = {
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

export async function loadReceipt(jobId: Hex): Promise<Receipt | null> {
  const job = (await client().readContract({
    address: DEPLOYMENT.escrow,
    abi: escrowAbi,
    functionName: "getJob",
    args: [jobId],
  })) as Job;
  if (job.status === 0) return null;

  // Events come from the Stream-fed index (stream/filter.js keeps every HonestEscrow log).
  const rows = (await sql().query(
    `select block, tx_hash, topics, data, ts from escrow_events where job_id = $1 order by block, log_index`,
    [jobId.toLowerCase()],
  )) as { block: string; tx_hash: Hex; topics: Hex[]; data: Hex; ts: string }[];

  const events: Receipt["events"] = [];
  let input: bigint[] | null = null;
  let proof: Hex | null = null;
  let challengeEndsAt: number | null = null;
  for (const r of rows) {
    const ev = decodeEventLog({ abi: escrowAbi, topics: r.topics as [Hex, ...Hex[]], data: r.data });
    const args = ev.args as unknown as Record<string, unknown>;
    if (ev.eventName === "JobFulfilled") {
      input = [...(args.input as bigint[])];
      proof = args.proof as Hex;
      challengeEndsAt = Number(args.challengeEndsAt);
    }
    events.push({ name: String(ev.eventName), tx: r.tx_hash, block: Number(r.block), ts: Number(r.ts), args });
  }
  const out = [...job.output];
  const r = out.length ? riskOf(out[0]) : null;
  return {
    jobId,
    status: STATUS[job.status],
    buyer: job.buyer,
    seller: job.seller,
    commitment: job.commitment,
    price: job.price,
    deadline: Number(job.deadline),
    output: out,
    risk: r?.risk ?? null,
    logit: r?.logit ?? null,
    input,
    proof,
    challengeEndsAt,
    events,
  };
}

export async function recentJobs(limit = 20) {
  const rows = (await sql().query(
    `select o.job_id, o.ts, o.tx_hash,
            (select e.topic0 from escrow_events e where e.job_id = o.job_id order by e.block desc, e.log_index desc limit 1) as last
       from escrow_events o
      where o.topic0 = $1
      order by o.block desc limit $2`,
    [JOB_OPENED_TOPIC, limit],
  )) as { job_id: Hex; ts: string; tx_hash: Hex; last: Hex }[];
  return rows;
}

export const JOB_OPENED_TOPIC = toEventSelector(
  "JobOpened(bytes32,address,address,uint256,uint256,bytes32,uint64)",
).toLowerCase();
