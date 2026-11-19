import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeFromAll, type Transfer } from "../src/lib/features.ts";

const vectors = JSON.parse(readFileSync(new URL("../../spec/vectors.json", import.meta.url), "utf8"));

test("features match spec/vectors.json (Python reference)", () => {
  let n = 0;
  for (const c of vectors.cases) {
    const all: Transfer[] = c.transfers.map((t: any) => ({
      from: t.from, to: t.to, value: BigInt(t.value), block: t.block, logIndex: t.log_index, ts: t.ts,
    }));
    for (const ch of c.checks) {
      const got = computeFromAll(ch.address, all, ch.block);
      got.forEach((v, i) => assert.ok(Math.abs(v - ch.features[i]) < 1e-12, `${ch.role} ${ch.address} f${i}: ${v} vs ${ch.features[i]}`));
      const felts = got.map((v) => Math.round(v * 2 ** vectors.input_scale));
      assert.deepEqual(felts, ch.felts.map(Number), `${ch.role} felts`);
      n++;
    }
  }
  assert.ok(n > 0);
});

test("web copy of the features spec matches spec/features.json", () => {
  const a = readFileSync(new URL("../../spec/features.json", import.meta.url), "utf8");
  const b = readFileSync(new URL("../src/lib/features.spec.json", import.meta.url), "utf8");
  assert.equal(b, a, "run pnpm sync-spec");
});

test("web copies of deployments match the repo", () => {
  for (const [a, b] of [
    ["../../deployments/arc-testnet.json", "../src/lib/deploy/arc-testnet.json"],
    ["../../deployments/abi/HonestEscrow.json", "../src/lib/deploy/HonestEscrow.json"],
    ["../../deployments/abi/Halo2Verifier.json", "../src/lib/deploy/Halo2Verifier.json"],
    ["../../model/artifacts/riskone/settings.json", "../src/lib/deploy/circuit.json"],
  ]) {
    assert.equal(readFileSync(new URL(b, import.meta.url), "utf8"), readFileSync(new URL(a, import.meta.url), "utf8"), `run pnpm sync-spec (${b})`);
  }
});
