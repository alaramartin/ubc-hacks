#!/usr/bin/env -S node --experimental-strip-types
/**
 * honest: a buyer agent that only pays for proven model answers.
 *
 *   honest sellers                 sellers registered in the escrow
 *   honest check <address>         buy one verified risk score
 *   honest pay <address> <usdc>    risk-check the address, then pay it only if the policy allows
 *   honest finalize                release payment to sellers whose challenge window has passed
 *   honest receipt <jobId>         show a job as recorded onchain
 *   honest balance                 the agent's USDC and today's spend
 */
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { agentAccount, erc20Abi, escrow, getJob, publicClient, signedFromFelt, STATUS, walletClient } from "./chain.ts";
import { riskCheck } from "./check.ts";
import { deployment, OUTPUT_SCALE, policy, receiptsUrl } from "./config.ts";
import { listSellers } from "./registry.ts";
import { addSpend, jobs, recordJob, spentToday } from "./state.ts";
import * as ui from "./ui.ts";

async function balance(a: Address): Promise<bigint> {
  return publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] });
}

async function cmdSellers() {
  ui.title(`Sellers in HonestEscrow ${ui.addr(deployment.escrow)}`);
  for (const s of await listSellers()) {
    const status = s.slashed ? pc.red("SLASHED") : s.registered ? pc.green("active") : pc.dim("inactive");
    console.log(
      `  ${ui.addr(s.address)}  ${status.padEnd(16)} price ${ui.usdc(s.price).padEnd(14)} bond ${ui.usdc(s.bond).padEnd(12)} commitment ${ui.short(s.commitment.toString(16).padStart(64, "0"))}  ${pc.dim(s.endpoint)}`,
    );
  }
  console.log();
}

function parseTarget(x: string | undefined): Address {
  if (!x || !isAddress(x)) throw new Error(`not an address: ${x}`);
  return getAddress(x);
}

async function cmdCheck(target: Address) {
  ui.title(`honest check ${target}`);
  const r = await riskCheck(target);
  if (!r.ok) ui.decision(false, `no verified answer: ${r.reason}`);
  else {
    const risky = r.risk >= policy.riskThreshold;
    console.log(`\n  ${risky ? pc.red("RISKY") : pc.green("LOW RISK")}  proven risk ${r.risk.toFixed(4)} (threshold ${policy.riskThreshold})  spent ${ui.usdc(r.spent)}\n`);
  }
}

async function confirm(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`  ${q} type "yes" to continue: `);
  rl.close();
  return a.trim() === "yes";
}

async function cmdPay(target: Address, amountStr: string | undefined) {
  if (!amountStr) throw new Error("usage: honest pay <address> <amount in USDC>");
  const amount = parseUnits(amountStr, deployment.usdcDecimals);
  ui.title(`honest pay ${target} ${ui.usdc(amount)}`);

  if (spentToday() + amount > BigInt(policy.dailyBudget)) {
    ui.decision(false, `payment would exceed the daily budget of ${ui.usdc(BigInt(policy.dailyBudget))}`);
    return;
  }
  const r = await riskCheck(target);
  if (!r.ok) {
    ui.decision(false, `not paying without a verified risk check (${r.reason})`);
    return;
  }
  if (r.risk >= policy.riskThreshold) {
    ui.decision(false, `proven risk ${r.risk.toFixed(4)} is at or above ${policy.riskThreshold}; ${ui.usdc(amount)} stays in the agent's wallet`);
    return;
  }
  if (amount > BigInt(policy.approvalAbove) && !(await confirm(`${ui.usdc(amount)} is above the approval limit.`))) {
    ui.decision(false, "not approved");
    return;
  }
  const hash = await walletClient().writeContract({
    address: deployment.usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [target, amount],
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  if (rc.status !== "success") throw new Error(`payment ${hash} reverted`);
  addSpend(amount);
  ui.ok("paid", `${ui.usdc(amount)} to ${ui.addr(target)}  tx ${ui.tx(hash)}`);
  ui.decision(true, `proven risk ${r.risk.toFixed(4)} is below ${policy.riskThreshold}; paid ${ui.usdc(amount)}`);
}

async function cmdFinalize() {
  ui.title("honest finalize");
  const window = (await publicClient.readContract({ ...escrow, functionName: "challengeWindow" })) as bigint;
  const now = BigInt(Math.floor(Date.now() / 1000));
  let n = 0;
  for (const j of jobs().filter((j) => j.status === "Fulfilled")) {
    const job = await getJob(j.jobId);
    const st = STATUS[job.status];
    if (st !== "Fulfilled") {
      recordJob(j.jobId, j.seller, j.address, st);
      continue;
    }
    if (now < job.fulfilledAt + window) {
      ui.note(`${ui.short(j.jobId)} window ends in ${job.fulfilledAt + window - now}s`);
      continue;
    }
    const hash = await walletClient().writeContract({ ...escrow, functionName: "finalize", args: [j.jobId] });
    await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    recordJob(j.jobId, j.seller, j.address, "Finalized");
    ui.ok("finalized", `${ui.short(j.jobId)} paid ${ui.usdc(job.price)} to ${ui.addr(job.seller)}  tx ${ui.tx(hash)}`);
    n++;
  }
  if (n === 0) ui.note("nothing to finalize");
  console.log();
}

async function cmdReceipt(jobId: string | undefined) {
  if (!jobId?.startsWith("0x")) throw new Error("usage: honest receipt <jobId>");
  const j = await getJob(jobId as Hex);
  ui.title(`job ${jobId}`);
  const logit = j.output.length ? Number(signedFromFelt(j.output[0])) / 2 ** OUTPUT_SCALE : NaN;
  ui.step("status", STATUS[j.status]);
  ui.step("buyer", j.buyer);
  ui.step("seller", j.seller);
  ui.step("commitment", "0x" + j.commitment.toString(16).padStart(64, "0"));
  ui.step("price", ui.usdc(j.price));
  ui.step("output", Number.isNaN(logit) ? "none" : `risk ${(1 / (1 + Math.exp(-logit))).toFixed(4)} (logit ${logit.toFixed(2)})`);
  const rec = receiptsUrl();
  if (rec) ui.step("page", `${rec}/r/${jobId}`);
  console.log();
}

async function cmdBalance() {
  const me = agentAccount().address;
  ui.title(`agent ${me}`);
  ui.step("USDC", ui.usdc(await balance(me)));
  ui.step("spent today", `${ui.usdc(spentToday())} of ${ui.usdc(BigInt(policy.dailyBudget))}`);
  console.log();
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  switch (cmd) {
    case "sellers":
      return cmdSellers();
    case "check":
      return cmdCheck(parseTarget(a1));
    case "pay":
      return cmdPay(parseTarget(a1), a2);
    case "finalize":
      return cmdFinalize();
    case "receipt":
      return cmdReceipt(a1);
    case "balance":
      return cmdBalance();
    default:
      console.log("usage: honest sellers | check <address> | pay <address> <usdc> | finalize | receipt <jobId> | balance");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(pc.red(`\n  error: ${(e as Error).message}\n`));
  process.exitCode = 1;
});
