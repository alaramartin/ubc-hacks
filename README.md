# Honest Model

Agents pay for model answers they can't check. Before an agent sends money to an address it can buy a risk score for that address, but nothing tells it whether the score came from the model the seller advertises, or from a cheaper model, or was typed in by hand.

Honest Model is an x402 payment layer on Arc where the agent only pays for answers the committed model actually gave:

1. A seller registers a hash of its secret model weights in the `HonestEscrow` contract and posts a USDC bond.
2. The agent computes the model's input itself, from its own QuickNode Stream index of Arc USDC transfers.
3. The agent pays through x402, but the payment goes into escrow, not to the seller.
4. The seller answers with an EZKL zk proof that the committed weights, run on the agent's input, produced the answer. The weights stay secret.
5. The agent checks the proof for free with `eth_call`. A good answer pays the seller after a 60 second challenge window. A bad one gets challenged: the contract verifies the proof itself, refunds the agent and slashes the seller's bond.

Receipts for every job: https://honest-model.vercel.app

## What the demo shows

Two sellers offer the same risk check. RiskOne is honest and charges 0.01 USDC. CheapRisk charges 0.005 USDC and edits its scores to say "safe". The agent is never told which one cheats.

A plain x402 buyer (`honest pay --trust`) asks the cheapest seller about a drainer wallet, gets a score of 0.005 and pays the drainer 0.05 USDC ([tx](https://testnet.arcscan.app/tx/0x684a51aaae74f8d8eadfb90f644ef940b450c27905cb2e094d257159900f8e44)).

The Honest Model agent (`honest pay`) asks the same seller about the same wallet:

```
seller       CheapRisk 0x9872…b758  price 0.005 USDC  bond 0.5 USDC  (cheapest of 2 eligible)
answer       risk 0.0050 (logit -5.29)  proof 3,840 bytes, proved in 2.51s
verify       proof does NOT match commitment + our input + posted output  eth_call, 83 ms
challenge    onchain verify failed: refunded 0.005 USDC, seller bond slashed 0.25 USDC  754,767 gas
seller       RiskOne 0x5B95…9c4D  price 0.01 USDC  bond 0.5 USDC  (cheapest of 1 eligible)
answer       risk 0.9999 (logit 9.59)  proof 3,840 bytes, proved in 2.36s
verify       proof checks out against commitment, our input and the posted output  eth_call, 88 ms, no gas

 REFUSE  proven risk 0.9999 is at or above 0.5; 0.05 USDC stays in the agent's wallet
```

Transactions from that run: [challenge and slash](https://testnet.arcscan.app/tx/0x25c244fdd6edf0e962f1ddbb48abb855085e17f39ed63bcce4f8678cf4be4b55), [RiskOne's answer](https://testnet.arcscan.app/tx/0xfd89a3b9bb0b73c426be072c7f091e45dce9902c40f76ea40dbc65b9b1fb008d), [receipt page](https://honest-model.vercel.app/r/0x6525a70eee69305533a6282054c722e3a80121f9704d42ba59f74c793fbdc306).

The seller has four modes, picked when the process starts, and each one is a real code path:

| Mode | What the seller does | What happens |
|---|---|---|
| `honest` | Runs the committed model on the agent's input | Proof verifies, seller is paid |
| `edit-output` | Proves honestly, then posts a different score | Proof fails against the posted output, slashed |
| `swap-model` | Runs a cheaper model with the same architecture | Proof fails against the committed weights, slashed |
| `fake-input` | Changes some of the agent's features before proving | Proof fails against the agent's input hash, slashed |

All four were run against Arc testnet. A `swap-model` seller gets slashed even when its answer happens to match, because what's checked is which model produced it, not the number.

## Architecture

```
            QuickNode Stream (arc-testnet, logs)
                 │  USDC transfers + HonestEscrow events
                 ▼
  web/ on Vercel: /api/streams ──► Neon Postgres ──► /api/features/:address
                                         │                   │
                                         ▼                   ▼
                                  /r/<jobId> receipts    agent/ (honest CLI)
                                                             │ x402: 402, then X-PAYMENT
                                                             ▼
                                                   seller/ (FastAPI + EZKL)
                                                             │ open / fulfill
                                                             ▼
                               Arc testnet: HonestEscrow ──► Halo2Verifier
```

| Part | Directory | Stack |
|---|---|---|
| Model, simulator, EZKL pipeline | `model/` | Python, PyTorch, ONNX, EZKL 23.0.5 |
| Seller server | `seller/` | FastAPI, web3.py, EZKL |
| Escrow and verifier contracts | `contracts/` | Solidity 0.8.24, Foundry |
| Buyer agent | `agent/` | TypeScript, viem |
| Stream receiver, features API, receipts | `web/` | Next.js 16 on Vercel, Neon Postgres |
| Shared definitions | `spec/` | `features.json`, `vectors.json`, `instances.md` |

### Contracts on Arc testnet (chain 5042002)

| Contract | Address | What it does |
|---|---|---|
| `HonestEscrow` | [`0xb292Ca92b5Cc6f621Ca15f2eb05f5066305b2905`](https://testnet.arcscan.app/address/0xb292Ca92b5Cc6f621Ca15f2eb05f5066305b2905) | Seller registry with bonds, x402 escrow, challenge and slash |
| `Halo2Verifier` | [`0xAa0B5BABb4E8A9f189712690457bDF30aFC9777f`](https://testnet.arcscan.app/address/0xAa0B5BABb4E8A9f189712690457bDF30aFC9777f) | EZKL-generated verifier for the risk model's circuit |
| USDC | `0x3600000000000000000000000000000000000000` | Arc's native USDC (ERC-20 interface, EIP-3009) |

Everything is paid in USDC, which is also Arc's gas token, so the agent holds one asset. A verified proof costs about 735k gas, a challenge about 755k, roughly 0.02 USDC at testnet prices.

How a job moves through `HonestEscrow`:

- `registerSeller(commitment, price, bond, endpoint)` pulls the bond. The commitment is EZKL's Poseidon hash of the weights.
- `open(seller, inputHash, deadline, auth)` pulls the price with `receiveWithAuthorization`. The authorization's nonce is `keccak256(chainId, escrow, seller, inputHash, deadline)`, so the agent's signature only works for that seller, that input and that deadline. The seller can't change the terms after the agent signs.
- `fulfill(jobId, input, output, proof)` checks that the input matches the hash the agent paid for, then stores the output and the proof hash. The input goes onchain in the event, so anyone can re-verify or challenge, not only the buyer.
- `finalize(jobId)` pays the seller once the challenge window has passed.
- `challenge(jobId, input, proof)` builds the public instances from storage (commitment, input, output) and calls the verifier with a fixed 3M gas. A challenge sent with too little gas reverts, so nobody can fake a failed verification by starving the call. A valid proof makes the challenge revert. An invalid one refunds the buyer, pays part of the bond to the challenger and marks the seller slashed for good.
- `refund(jobId)` returns the payment if the seller never answers before the deadline.

`forge test` runs 17 tests covering each of these, including the gas-starved challenge, a proof over a different input, a different model and a tampered output, all against a real proof fixture from `model/`.

### The proof

The model is a 7→16→8→1 MLP (ReLU). EZKL proves the logit, and readers apply the sigmoid. With hashed parameters and public inputs and outputs, the public instances are `[weights hash, 7 inputs, 1 output]` as BN254 field elements, at fixed-point scale 2^13. Proving takes about 3 s on a laptop and the proof is 3,840 bytes.

The verifying key depends only on the circuit, not the weights, so every seller using this architecture shares one verifier contract. What tells sellers apart is the commitment each one registered. See `spec/instances.md` for the encoding.

The model is trained on a simulator of seven wallet behaviours (normal user, merchant, exchange hot wallet, payroll, fresh wallet, drainer, launderer). The simulated classes are easy to separate, and test accuracy is about 0.9997. That says the pipeline works, not that this model would catch real drainers. A real seller would bring a real model, and the protocol doesn't change.

## QuickNode Streams

The agent computes the model's input itself, so it needs its own view of who sent USDC to whom. That view comes from a QuickNode Stream, which is also what the receipt pages read escrow events from.

| Setting | Value |
|---|---|
| Network | `arc-testnet` |
| Dataset | `logs` |
| Start | block 73,010,098 (start of demo seeding), then live |
| Filter | `web/stream/filter.js` |
| Destination | Webhook to `https://honest-model.vercel.app/api/streams`, HMAC-signed with a shared secret |
| Created by | `scripts/create-stream.mjs` (runs `test_filter` on a real block first) |

The filter keeps two kinds of log and drops everything else:

- **USDC `Transfer` logs from Arc's native emitter `0xff…fe`.** On Arc every USDC movement emits a log from this system address, including native gas-token transfers. An ERC-20 call also emits a copy from the USDC contract, so the filter reads only the emitter and nothing is counted twice. Values are converted from 18 decimals to USDC's 6.
- **Every log from `HonestEscrow`**, kept raw. The receipt pages decode them.

Each batch comes back as one compact object with its block range, including empty batches. `/api/streams` checks the signature, stores transfers and events in Neon, and records the range, so the features API knows which block it has fully synced (the highest block with no gaps below it). `/api/features/:address` computes the seven features from `spec/features.json` at that block.

The Python simulator and the TypeScript indexer both implement `spec/features.json`. Both run against `spec/vectors.json` (44 checks over 799 transfers), because a one-unit difference in a quantized feature makes an honest proof fail.

## The agent's decision loop

`honest pay <address> <amount>` runs this, with every limit read from `agent/policy.json`:

1. Refuse if the payment would go over the daily budget.
2. Get the address's features from the Stream-fed index and quantize them.
3. Pick the cheapest seller that is registered, not slashed, has at least the minimum bond and charges at most the maximum check price.
4. Request the risk check. On the 402, check every field against the chain and the request: scheme, network, escrow address, asset, seller, commitment, price, input hash, verifier, deadline and the job nonce. Refuse to sign if anything differs.
5. Sign an EIP-3009 authorization for exactly that price into escrow, and send it.
6. Read the job back from the chain. Judge what the seller posted onchain, not what it said over HTTP, and check the proof bytes against the stored hash.
7. Verify the proof with `eth_call` against the commitment, the agent's own input and the posted output.
8. If it fails, challenge onchain, get refunded, and go back to step 3 without that seller, up to 3 sellers.
9. If it verifies, pay the address only if the proven risk is below the threshold, and ask a human first if the amount is above the approval limit.

| Limit | Value |
|---|---|
| `riskThreshold` | 0.5 |
| `maxCheckPrice` | 0.02 USDC |
| `minSellerBond` | 0.5 USDC |
| `dailyBudget` | 2 USDC (checks and payments together) |
| `approvalAbove` | 1 USDC needs a typed "yes" |
| `maxSellerAttempts` | 3 |

The agent has no list of good or bad sellers or addresses. It learns that a seller cheats only from a failed proof. `honest finalize` releases payment for jobs whose window has passed, and refunds jobs a seller took but never answered.

## Running it

Needs Python 3.12 with `uv`, Node 24 with `pnpm`, Foundry and `solc` 0.8.24. Copy `.env.example` to `.env` and fill it in.

Every command starts from the repo root.

```sh
# model: train both models, build circuits, keys and the verifier
(cd model && uv sync && uv run python -m model.train \
  && uv run python -m model.ezkl_pipeline artifacts/riskone \
  && uv run python -m model.ezkl_pipeline artifacts/cheaprisk --circuit-from artifacts/riskone)

# contracts: test, then deploy (writes deployments/arc-testnet.json)
(cd contracts && forge build && forge test -vv)
scripts/deploy.sh

# test world: real USDC transfers between seeded wallets
(cd seller && uv run python ../scripts/seed.py --seed 0 --compress 10 --execute)

# indexer and receipts, then the Stream that feeds them
(cd web && pnpm i && pnpm db:migrate && vercel deploy --prod)
node --env-file=.env scripts/create-stream.mjs --webhook https://<app>/api/streams

# sellers from deployments/demo.json (makes a fresh cheater if the last one was slashed)
(cd seller && uv run python ../scripts/demo_up.py)

# agent, in another terminal
cd agent && pnpm i
pnpm honest sellers
pnpm honest pay <address> 0.05 --trust    # plain x402 buyer, for comparison
pnpm honest pay <address> 0.05
pnpm honest finalize
```

Seller weights (`weights.pt`, `network.onnx`, `network.ezkl`, `pk.key`) are never committed, since keeping them secret is the point. `settings.json`, `vk.key`, `Verifier.sol` and `commitment.json` are in the repo.

## Limits

- EZKL proves small models. Anthropic's FlashProve shows LLM inference can be proven too, but at about 19 MB per 1,024 tokens, too large to verify onchain. The escrow only needs a commitment and a verifier contract, so a cheaper LLM proof system could use it unchanged.
- The proof shows which model produced the answer, not that the model is any good.
- "First seen" for a counterparty means first seen in the indexed range, which starts at the demo seeding block.
- The challenge window is 60 seconds and the amounts are tiny (0.5 USDC bonds) so the demo fits on stage.
