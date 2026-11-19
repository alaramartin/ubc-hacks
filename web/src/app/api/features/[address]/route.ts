/** Risk features for an address, from the Stream-fed transfer index (spec/features.json). */
import { isAddress } from "viem";
import { sql, syncedBlock } from "@/lib/db";
import { compute, FEATURE_NAMES, valid, type Transfer } from "@/lib/features";

export async function GET(req: Request, ctx: RouteContext<"/api/features/[address]">) {
  const { address } = await ctx.params;
  if (!isAddress(address)) return Response.json({ error: "not an address" }, { status: 400 });
  const a = address.toLowerCase();

  const synced = await syncedBlock();
  if (synced == null) return Response.json({ error: "index is empty" }, { status: 503 });
  const asked = new URL(req.url).searchParams.get("block");
  const block = asked ? Math.min(Number(asked), synced) : synced;

  const db = sql();
  const rows = (await db.query(
    `select block, log_index, from_addr, to_addr, value::text as value, ts
       from transfers
      where block <= $2 and (from_addr = $1 or to_addr = $1)
      order by block, log_index`,
    [a, block],
  )) as { block: string; log_index: number; from_addr: string; to_addr: string; value: string; ts: string }[];
  const mine: Transfer[] = rows
    .map((r) => ({ from: r.from_addr, to: r.to_addr, value: BigInt(r.value), block: Number(r.block), logIndex: r.log_index, ts: Number(r.ts) }))
    .filter(valid);

  const cps = [...new Set(mine.map((t) => (t.to === a ? t.from : t.to)))];
  const seen = new Map<string, number>();
  if (cps.length) {
    const fs = (await db.query(
      `select addr, min(ts) as first from (
         select from_addr as addr, ts from transfers where block <= $2 and from_addr = any($1) and from_addr <> to_addr
         union all
         select to_addr as addr, ts from transfers where block <= $2 and to_addr = any($1) and from_addr <> to_addr
       ) x group by addr`,
      [cps, block],
    )) as { addr: string; first: string }[];
    for (const r of fs) seen.set(r.addr, Number(r.first));
  }
  const features = compute(a, mine, (x) => seen.get(x)!);
  return Response.json({ address, block, names: FEATURE_NAMES, features, transfers: mine.length });
}
