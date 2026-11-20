// Index status: how far the Stream has delivered. Run: pnpm db:status
import { neon } from "@neondatabase/serverless";
import { syncedBlock } from "../src/lib/db.ts";

const db = neon(process.env.DATABASE_URL!);
const [b] = await db.query("select count(*)::int as batches, min(start_block) as lo, max(end_block) as hi from batches");
const [t] = await db.query("select count(*)::int as n from transfers");
const [e] = await db.query("select count(*)::int as n from escrow_events");
console.log({ ...b, synced: await syncedBlock(), transfers: t.n, escrowEvents: e.n });
