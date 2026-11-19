/**
 * Protocol integration test against Arc testnet and locally running sellers.
 * Features come from spec/vectors.json instead of the Stream-fed indexer, so this exercises
 * x402, EIP-3009, HonestEscrow, EZKL proving, eth_call verification and challenges on their own.
 *
 *   (terminal 1) cd seller && uv run python -m seller serve --key-env SELLER_HONEST_KEY --model riskone --mode honest --port 8001
 *   (terminal 2) cd seller && uv run python -m seller serve --key-env SELLER_CHEAP_KEY --model cheaprisk --mode edit-output --port 8002
 *   cd agent && node --env-file=../.env --experimental-strip-types test/protocol.e2e.ts [role]
 */
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { riskCheckWith } from "../src/check.ts";

const role = process.argv[2] ?? "drainer";
const v = JSON.parse(readFileSync(new URL("../../spec/vectors.json", import.meta.url), "utf8"));
const check = v.cases[0].checks.find((c: { role: string }) => c.role === role);
if (!check) throw new Error(`no vector for role ${role}`);

const r = await riskCheckWith({
  address: getAddress(check.address.padStart(42, "0")),
  block: check.block,
  names: v.feature_names,
  features: check.features,
  transfers: 0,
});
console.log(JSON.stringify(r, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
