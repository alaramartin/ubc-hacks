// QuickNode Streams filter (dataset: logs, network: Arc testnet).
// Keeps two kinds of logs:
//   1. USDC Transfer logs from Arc's native USDC system emitter (EIP-7708), which records every
//      USDC movement. Values are converted from 18 to 6 decimals. These feed the risk features.
//   2. Every log from the HonestEscrow contract, kept raw. These feed the receipt pages.
// Returns one compact object per batch, including empty batches, so the indexer knows how far it
// has synced. __ESCROW__ is replaced with the escrow address when the stream is created.
function main(stream) {
  var EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
  var ESCROW = "__ESCROW__";
  var events = [];
  var TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  var out = [];
  function walk(x) {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (var i = 0; i < x.length; i++) walk(x[i]);
      return;
    }
    if (x.address && x.topics && x.data !== undefined) {
      if (x.address.toLowerCase() === ESCROW && !x.removed) {
        events.push({
          b: parseInt(x.blockNumber, 16),
          i: parseInt(x.logIndex, 16),
          tx: x.transactionHash,
          topics: x.topics,
          data: x.data,
          ts: parseInt(x.blockTimestamp, 16),
        });
      }
      if (x.address.toLowerCase() === EMITTER && x.topics.length === 3 && x.topics[0] === TRANSFER && !x.removed) {
        out.push({
          b: parseInt(x.blockNumber, 16),
          i: parseInt(x.logIndex, 16),
          tx: x.transactionHash,
          f: "0x" + x.topics[1].slice(26).toLowerCase(),
          t: "0x" + x.topics[2].slice(26).toLowerCase(),
          v: (BigInt(x.data) / 1000000000000n).toString(),
          ts: parseInt(x.blockTimestamp, 16),
        });
      }
      return;
    }
    for (var k in x) walk(x[k]);
  }
  walk(stream.data);
  var m = stream.metadata || {};
  return {
    v: 1,
    start: Number(m.batch_start_range),
    end: Number(m.batch_end_range),
    transfers: out,
    events: events,
  };
}
