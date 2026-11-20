/** QuickNode Streams webhook: stores USDC transfers delivered by stream/filter.js. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { toEventSelector, type AbiEvent } from "viem";
import { escrowAbi } from "@/lib/chain";
import { SCHEMA, sql } from "@/lib/db";

/** topic0 of every ReceiptEscrow event whose first indexed argument is the job id. */
const JOB_TOPICS = new Set(
  escrowAbi
    .filter((x): x is AbiEvent => x.type === "event" && x.name.startsWith("Job"))
    .map((e) => toEventSelector(e).toLowerCase()),
);

type Batch = {
  v: number;
  start: number;
  end: number;
  transfers: { b: number; i: number; tx: string; f: string; t: string; v: string; ts: number }[];
  events?: { b: number; i: number; tx: string; topics: string[]; data: string; ts: number }[];
};

let schemaReady = false;

function verify(req: Request, body: string): boolean {
  const secret = process.env.QN_STREAM_SECRET;
  if (!secret) throw new Error("QN_STREAM_SECRET is not set");
  const nonce = req.headers.get("x-qn-nonce") ?? "";
  const ts = req.headers.get("x-qn-timestamp") ?? "";
  const given = req.headers.get("x-qn-signature") ?? "";
  const want = createHmac("sha256", secret).update(nonce + ts + body).digest("hex");
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

function batches(payload: unknown): Batch[] {
  // Streams may deliver the filter's return value directly or wrapped in { data: [...] }.
  if (Array.isArray(payload)) return payload.flatMap(batches);
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.transfers) && typeof p.start === "number") return [p as unknown as Batch];
    if ("data" in p) return batches(p.data);
  }
  return [];
}

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());
  const body = (req.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
  if (!verify(req, body)) return Response.json({ error: "bad signature" }, { status: 401 });

  const db = sql();
  if (!schemaReady) {
    for (const s of SCHEMA) await db.query(s);
    schemaReady = true;
  }
  let stored = 0;
  for (const b of batches(JSON.parse(body))) {
    if (b.transfers.length) {
      const cols = ["block", "log_index", "tx_hash", "from_addr", "to_addr", "value", "ts"];
      const vals: (string | number)[] = [];
      const rows = b.transfers.map((t, k) => {
        vals.push(t.b, t.i, t.tx, t.f.toLowerCase(), t.t.toLowerCase(), t.v, t.ts);
        return `(${cols.map((_, j) => `$${k * cols.length + j + 1}`).join(",")})`;
      });
      await db.query(
        `insert into transfers (${cols.join(",")}) values ${rows.join(",")} on conflict (block, log_index) do nothing`,
        vals,
      );
      stored += b.transfers.length;
    }
    for (const e of b.events ?? []) {
      const jobId = JOB_TOPICS.has(e.topics[0].toLowerCase()) ? e.topics[1].toLowerCase() : null;
      await db.query(
        `insert into escrow_events (block, log_index, tx_hash, topic0, job_id, topics, data, ts)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (block, log_index) do nothing`,
        [e.b, e.i, e.tx, e.topics[0], jobId, JSON.stringify(e.topics), e.data, e.ts],
      );
    }
    await db.query(
      `insert into batches (start_block, end_block, n) values ($1, $2, $3)
       on conflict (start_block) do update set end_block = excluded.end_block, n = excluded.n, received_at = now()`,
      [b.start, b.end, b.transfers.length],
    );
  }
  return Response.json({ ok: true, stored });
}
