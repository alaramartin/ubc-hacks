#!/usr/bin/env node
// Create the QuickNode Stream that feeds the indexer (web/src/app/api/streams).
//
//   node --env-file=.env scripts/create-stream.mjs --webhook https://<app>/api/streams [--from <block>] [--test-block <block>]
//
// Env: QUICKNODE_API_KEY, QN_STREAM_SECRET (at least 32 chars; the same value is set in Vercel).
// The filter is web/stream/filter.js with the escrow address from deployments/arc-testnet.json.
// --from defaults to the block where demo seeding started (deployments/demo-wallets.json), so the
// backfill covers every seeded transfer and every escrow event.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.quicknode.com/streams/rest/v1";
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const key = process.env.QUICKNODE_API_KEY;
const secret = process.env.QN_STREAM_SECRET;
if (!key) throw new Error("QUICKNODE_API_KEY is not set");
if (!secret || secret.length < 32) throw new Error("QN_STREAM_SECRET must be at least 32 characters");
const webhook = arg("webhook");
if (!webhook) throw new Error("--webhook <url> is required");

const dep = JSON.parse(readFileSync(join(ROOT, "deployments/arc-testnet.json"), "utf8"));
let from = arg("from");
if (!from) {
  const seed = JSON.parse(readFileSync(join(ROOT, "deployments/demo-wallets.json"), "utf8"));
  from = String(Math.min(seed.startBlock, dep.deployBlock));
}
const filter = readFileSync(join(ROOT, "web/stream/filter.js"), "utf8").replaceAll("__ESCROW__", dep.escrow.toLowerCase());
const filter_function = Buffer.from(filter).toString("base64");

async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const testBlock = arg("test-block") ?? from;
const test = await call("POST", "/streams/test_filter", {
  network: "arc-testnet",
  dataset: "logs",
  block: String(testBlock),
  filter_function,
});
const res = test?.result ?? {};
console.log(
  `test_filter at block ${testBlock}: ${res.transfers?.length ?? "?"} USDC transfers, ${res.events?.length ?? "?"} escrow events`,
  JSON.stringify(res.events ?? []).slice(0, 400),
);

if (process.argv.includes("--test-only")) process.exit(0);

const stream = await call("POST", "/streams", {
  name: "honest-model arc-testnet usdc + escrow",
  network: "arc-testnet",
  dataset: "logs",
  filter_function,
  filter_language: "javascript",
  region: arg("region") ?? "usa_east",
  start_range: Number(from),
  end_range: -1,
  dataset_batch_size: 10,
  elastic_batch_enabled: true,
  keep_distance_from_tip: 0,
  fix_block_reorgs: 0,
  destination: "webhook",
  destination_attributes: {
    url: webhook,
    security_token: secret,
    compression: "none",
    headers: {},
    max_retry: 5,
    retry_interval_sec: 1,
    post_timeout_sec: 20,
  },
  status: "active",
  external_id: "honest-model-arc-testnet",
});
console.log(`stream ${stream.id} ${stream.status} from block ${from}`);
