import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { addrUrl, DEPLOYMENT } from "@/lib/chain";
import { recentJobs } from "@/lib/receipt";
import { toEventSelector } from "viem";

const NAMES: Record<string, string> = Object.fromEntries(
  [
    ["JobOpened(bytes32,address,address,uint256,uint256,bytes32,uint64)", "open"],
    ["JobFulfilled(bytes32,uint256[],uint256[],bytes,uint64)", "in challenge window"],
    ["JobFinalized(bytes32,address,uint256)", "verified, seller paid"],
    ["JobSlashed(bytes32,address,address,uint256,uint256)", "slashed"],
    ["JobRefunded(bytes32,address,uint256)", "refunded"],
  ].map(([sig, label]) => [toEventSelector(sig).toLowerCase(), label]),
);

async function Jobs() {
  await connection();
  const rows = await recentJobs();
  if (rows.length === 0) return <p>No jobs yet.</p>;
  return (
    <ul className="list">
      {rows.map((j) => (
        <li key={j.job_id}>
          <Link className="mono" href={`/r/${j.job_id}`}>{j.job_id.slice(0, 18)}…</Link>
          <span className={NAMES[j.last] === "slashed" ? "bad" : undefined}>{NAMES[j.last] ?? "open"}</span>
          <span>{new Date(Number(j.ts) * 1000).toLocaleString("en-US", { timeZone: "America/Chicago" })}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  return (
    <main className="wrap">
      <article className="sheet">
        <p className="kicker">zkReceipt</p>
        <p className="lede">
          Each job is an agent paying for a risk score into escrow on Arc. The seller answers with a zk proof
          that its committed model produced the score from the agent&apos;s input. Bad proofs get the seller slashed.
        </p>
        <p className="for">
          Escrow <a className="mono" href={addrUrl(DEPLOYMENT.escrow)}>{DEPLOYMENT.escrow}</a>
        </p>
        <section>
          <h2>Latest jobs</h2>
          <Suspense fallback={<p>Reading the Stream index</p>}>
            <Jobs />
          </Suspense>
        </section>
      </article>
    </main>
  );
}
