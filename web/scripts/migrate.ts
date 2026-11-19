// Create the indexer tables. Run: pnpm db:migrate (reads DATABASE_URL from .env.local)
import { neon } from "@neondatabase/serverless";
import { SCHEMA } from "../src/lib/db.ts";

const db = neon(process.env.DATABASE_URL!);
for (const s of SCHEMA) await db.query(s);
console.log(`applied ${SCHEMA.length} statements`);
