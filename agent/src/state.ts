/** The agent's local memory: spend per UTC day and the jobs it opened. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { ROOT } from "./config.ts";

const DIR = join(ROOT, "agent", ".state");
const FILE = join(DIR, "state.json");

type State = {
  day: string;
  spent: string;
  jobs: { jobId: Hex; seller: string; address: string; status: string; at: number }[];
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function load(): State {
  const s: State = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { day: today(), spent: "0", jobs: [] };
  if (s.day !== today()) {
    s.day = today();
    s.spent = "0";
  }
  return s;
}

export function save(s: State) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export function spentToday(): bigint {
  return BigInt(load().spent);
}

export function addSpend(amount: bigint) {
  const s = load();
  s.spent = String(BigInt(s.spent) + amount);
  save(s);
}

export function recordJob(jobId: Hex, seller: string, address: string, status: string) {
  const s = load();
  const existing = s.jobs.find((j) => j.jobId === jobId);
  if (existing) existing.status = status;
  else s.jobs.push({ jobId, seller, address, status, at: Date.now() });
  save(s);
}

export function jobs() {
  return load().jobs;
}
