import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Hex } from "viem";
import { VerifyAgain } from "@/components/VerifyAgain";
import { addrUrl, DEPLOYMENT, INPUT_SCALE, signed, txUrl } from "@/lib/chain";
import { FEATURE_NAMES } from "@/lib/features";
import { loadReceipt, type Receipt } from "@/lib/receipt";

export const metadata = { title: "Receipt · zkReceipt" };

const usdc = (u: bigint) => `${(Number(u) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`;
const hex32 = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const time = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

const LABEL: Record<string, string> = {
  JobOpened: "Payment locked in escrow",
  JobFulfilled: "Answer and proof posted",
  JobFinalized: "Seller paid",
  JobSlashed: "Challenged: proof failed onchain, buyer refunded, bond slashed",
  JobRefunded: "Buyer refunded (no answer before deadline)",
};

function Stamp({ r }: { r: Receipt }) {
  const last = r.events.at(-1);
  if (r.status === "Slashed") return <div className="stamp fail">SLASHED{last && <small>{time(last.ts)}</small>}</div>;
  if (r.status === "Finalized") return <div className="stamp pass">VERIFIED · PAID{last && <small>{time(last.ts)}</small>}</div>;
  if (r.status === "Fulfilled" && r.challengeEndsAt) {
    if (Date.now() / 1000 > r.challengeEndsAt)
      return <div className="stamp open">WINDOW CLOSED<small>ready to pay seller</small></div>;
    return <div className="stamp open">IN WINDOW<small>until {time(r.challengeEndsAt)}</small></div>;
  }
  return <div className="stamp open">{r.status.toUpperCase()}</div>;
}

async function ReceiptView({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  await connection();
  if (!/^0x[0-9a-fA-F]{64}$/.test(jobId)) return <p>There is no job with that id.</p>;
  const r = await loadReceipt(jobId as Hex);
  if (!r) return <p>No job {jobId} in escrow {DEPLOYMENT.escrow}.</p>;
  const opened = r.events.find((e) => e.name === "JobOpened");
  const waiting = (
    <p>
      Not indexed yet. The Stream has delivered blocks up to {r.indexedTo?.toLocaleString() ?? "none"}, and this job&apos;s events
      come after that.
    </p>
  );
  const instances = r.input && r.output.length ? [r.commitment, ...r.input, ...r.output].map(String) : null;

  return (
    <article className="sheet">
      <div className="top">
        <div>
          <p className="kicker">zkReceipt</p>
          <p className="score">{r.risk === null ? "No answer" : `risk ${r.risk.toFixed(4)}`}</p>
          <p className="for">
            job <span className="mono">{jobId.slice(0, 14)}…</span>
            {opened && <> · opened {time(opened.ts)}</>}
          </p>
        </div>
        <Stamp r={r} />
      </div>

      <section>
        <h2>Model</h2>
        <dl>
          <dt>Commitment</dt>
          <dd className="mono">{hex32(r.commitment)}</dd>
          <dt>Seller</dt>
          <dd className="mono"><a href={addrUrl(r.seller)}>{r.seller}</a></dd>
          <dt>Buyer</dt>
          <dd className="mono"><a href={addrUrl(r.buyer)}>{r.buyer}</a></dd>
          <dt>Price</dt>
          <dd>{usdc(r.price)}</dd>
        </dl>
      </section>

      <section>
        <h2>Input</h2>
        {r.input ? (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Feature</th><th className="num">Value</th><th className="num">Field element</th></tr>
              </thead>
              <tbody>
                {r.input.map((f, i) => (
                  <tr key={i}>
                    <td>{FEATURE_NAMES[i]}</td>
                    <td className="num">{(Number(signed(f)) / 2 ** INPUT_SCALE).toFixed(4)}</td>
                    <td className="num mono">{f.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : r.status === "Open" || r.status === "Refunded" ? (
          <p>The seller has not posted an answer.</p>
        ) : (
          waiting
        )}
      </section>

      <section>
        <h2>Output and proof</h2>
        <dl>
          <dt>Logit</dt>
          <dd>{r.logit === null ? "none" : r.logit.toFixed(4)}</dd>
          <dt>Proof</dt>
          <dd>{r.proof ? `${((r.proof.length - 2) / 2).toLocaleString()} bytes, EZKL Halo2 (KZG)` : "none"}</dd>
          <dt>Verifier</dt>
          <dd className="mono"><a href={addrUrl(DEPLOYMENT.verifier)}>{DEPLOYMENT.verifier}</a></dd>
        </dl>
        {r.proof && instances && <VerifyAgain proof={r.proof} instances={instances} />}
      </section>

      <section>
        <h2>Money</h2>
        {r.events.length === 0 && waiting}
        <ol className="timeline">
          {r.events.map((e) => (
            <li key={e.tx + e.name}>
              <span>{time(e.ts)}</span>
              <span>
                <span className={e.name === "JobSlashed" ? "bad" : e.name === "JobFinalized" ? "good" : undefined}>{LABEL[e.name] ?? e.name}</span>
                {e.name === "JobSlashed" && <> ({usdc(e.args.slashed as bigint)} of bond to the challenger)</>}
                {" · "}
                <a className="mono" href={txUrl(e.tx)}>{e.tx.slice(0, 12)}…</a>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

export default function Page(props: PageProps<"/r/[jobId]">) {
  return (
    <main className="wrap">
      <p><Link href="/">All receipts</Link></p>
      <Suspense fallback={<div className="sheet">Reading the job from Arc</div>}>
        <ReceiptView params={props.params} />
      </Suspense>
    </main>
  );
}
