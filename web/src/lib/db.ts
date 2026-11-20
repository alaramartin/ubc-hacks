import { neon } from "@neondatabase/serverless";

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export const SCHEMA = [
  `create table if not exists transfers (
     block bigint not null,
     log_index int not null,
     tx_hash text not null,
     from_addr text not null,
     to_addr text not null,
     value numeric not null,
     ts bigint not null,
     primary key (block, log_index)
   )`,
  `create index if not exists transfers_from on transfers (from_addr, block)`,
  `create index if not exists transfers_to on transfers (to_addr, block)`,
  `create table if not exists escrow_events (
     block bigint not null,
     log_index int not null,
     tx_hash text not null,
     topic0 text not null,
     job_id text,
     topics jsonb not null,
     data text not null,
     ts bigint not null,
     primary key (block, log_index)
   )`,
  `create index if not exists escrow_events_job on escrow_events (job_id)`,
  `create table if not exists batches (
     start_block bigint primary key,
     end_block bigint not null,
     n int not null,
     received_at timestamptz not null default now()
   )`,
];

/** Highest block B such that every batch covering blocks up to B has been received. */
export async function syncedBlock(): Promise<number | null> {
  const db = sql();
  const rows = (await db.query(
    // Batches can overlap (elastic batch sizes, or two Streams over the same range), so compare
    // each batch's start with the highest block covered by every batch before it.
    `with b as (
       select start_block,
              max(end_block) over (order by start_block, end_block rows between unbounded preceding and 1 preceding) as covered
       from batches)
     select coalesce(
       (select min(covered) from b where covered is not null and start_block > covered + 1),
       (select max(end_block) from batches)) as synced`,
  )) as { synced: string | null }[];
  return rows[0]?.synced == null ? null : Number(rows[0].synced);
}
