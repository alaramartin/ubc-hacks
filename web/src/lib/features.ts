/** Feature computation, implementing spec/features.json. Must match model/src/model/features.py. */
// Copy of spec/features.json (Vercel builds only web/). `pnpm sync-spec` refreshes it; a test checks it matches.
import spec from "./features.spec.json" with { type: "json" };

export type Transfer = { from: string; to: string; value: bigint; block: number; logIndex: number; ts: number };

export const FEATURE_NAMES: string[] = spec.features.map((f) => f.name);
const FRESH_WINDOW_S = spec.constants.fresh_window_s;
const HOLD_CAP_S = spec.constants.hold_cap_s;
const ZERO = "0x" + "0".repeat(40);

export function valid(t: Pick<Transfer, "from" | "to">): boolean {
  return t.from !== t.to && t.from !== ZERO && t.to !== ZERO;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param address lowercase address
 * @param mine    the address's valid transfers at or before the block, in (block, logIndex) order
 * @param firstSeen first transfer timestamp anywhere (at or before the block) for a counterparty
 */
export function compute(address: string, mine: Transfer[], firstSeen: (a: string) => number): number[] {
  const n = mine.length;
  const counterparties = new Set<string>();
  let repeats = 0;
  let inflow = 0n;
  let outflow = 0n;
  let inflowCount = 0;
  const senders = new Set<string>();
  let freshValue = 0n;
  let lastInflowTs: number | null = null;
  const holds: number[] = [];

  for (const t of mine) {
    const incoming = t.to === address;
    const cp = incoming ? t.from : t.to;
    if (counterparties.has(cp)) repeats++;
    counterparties.add(cp);
    if (incoming) {
      inflow += t.value;
      inflowCount++;
      senders.add(cp);
      if (t.ts - firstSeen(cp) <= FRESH_WINDOW_S) freshValue += t.value;
      lastInflowTs = t.ts;
    } else {
      outflow += t.value;
      holds.push(lastInflowTs === null ? HOLD_CAP_S : Math.min(HOLD_CAP_S, t.ts - lastInflowTs));
    }
  }
  const ratio = (a: bigint, b: bigint) => Number(a) / Number(b);
  return [
    Math.log1p(n),
    Math.log1p(counterparties.size),
    inflow > 0n ? Math.min(2, ratio(outflow, inflow)) : 0,
    inflowCount ? senders.size / inflowCount : 0,
    n ? repeats / n : 0,
    inflow > 0n ? ratio(freshValue, inflow) : 0,
    holds.length ? Math.log1p(median(holds)) / Math.log1p(HOLD_CAP_S) : 1,
  ];
}

/** Compute from a full in-memory transfer list (tests, small sets). */
export function computeFromAll(address: string, all: Transfer[], block: number): number[] {
  const a = address.toLowerCase();
  const upto = all.filter((t) => t.block <= block && valid(t)).sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  const seen = new Map<string, number>();
  for (const t of upto) {
    if (!seen.has(t.from)) seen.set(t.from, t.ts);
    if (!seen.has(t.to)) seen.set(t.to, t.ts);
  }
  return compute(a, upto.filter((t) => t.from === a || t.to === a), (x) => seen.get(x)!);
}
