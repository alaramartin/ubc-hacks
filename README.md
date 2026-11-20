# zkReceipt

When you pay for a model through an API, you can't see what runs. You can pay for Opus and be served Haiku. zkReceipt makes AI agents pay for inference into an escrow contract on Arc. The provider only gets paid if a zkSNARK proves its committed model produced the answer.

1. A provider registers a hash of its secret model weights in `ReceiptEscrow` and posts a USDC bond.
2. The agent builds its own prompt from a QuickNode Stream index of Arc, then pays through x402. The USDC goes into escrow, not to the provider.
3. The provider answers with an EZKL proof that its committed weights, run on that prompt, produced the answer.
4. The agent checks the proof for free with `eth_call`. A good proof pays the provider after a 60 second window. A bad one gets challenged: the contract verifies it, refunds the agent and slashes the provider's bond.

Overpaying for a cheaper model is the mild case. The same proof catches an attacker who swaps a tampered model in behind the API, before an agent acts on its answers and moves money. It lets safety evaluators check that the model they tested is the one served to customers. And it gives anyone who has to show which model made a decision, like a bank or an auditor, a proof for every answer.

- Receipts for every job: https://zkreceipt.vercel.app
- Demo video: (link)

## The demo

The demo product is a paid risk-score API that an agent calls before paying a wallet. Two providers both commit to the RiskOne model. Provider A is honest. Provider B is cheaper and secretly answers with a different model. The agent is never told which one cheats.

A plain x402 buyer (`zkr pay --trust`) pays Provider B and never finds out. The zkReceipt agent (`zkr pay`) pays Provider B into escrow, sees the proof fail, challenges it, gets refunded, then moves on to Provider A:

```
seller       Provider B 0x2339…6D82  price 0.005 USDC  bond 0.5 USDC  (cheapest of 2 eligible)
verify       proof does NOT match commitment + our prompt + posted output  eth_call, 154 ms
challenge    onchain verify failed: refunded 0.005 USDC, seller bond slashed 0.25 USDC  754,935 gas
seller       Provider A 0x5B95…9c4D  price 0.01 USDC  bond 0.5 USDC  (cheapest of 1 eligible)
verify       proof checks out against commitment, our prompt and the posted output  eth_call, 154 ms, no gas

 PAY  proven risk 0.0000 is below 0.5; paid 0.05 USDC
```

Transactions from that run: [challenge and slash](https://testnet.arcscan.app/tx/0x4874f8f09b6c23666fbf1a9f86f5fba54fdc8c9b29860b7be02374a6aff0e024), [Provider A's answer](https://testnet.arcscan.app/tx/0x89e68815e4453bf9bd81dea201011f0aec836c18fa2468974e81946cac2ab121), [payment](https://testnet.arcscan.app/tx/0x0dddde90b0018e8aaa6cc0ae004faa07232a15977bcf56a4466f917509690823), and receipts for [Provider B](https://zkreceipt.vercel.app/r/0x805da37df0e9d1aefc3ea50b63812c6729c30dd50edd7846f75c586bc777941b) and [Provider A](https://zkreceipt.vercel.app/r/0x841b0d84e42b12c4368b7ad77dfc60700915252bc4c247d78e90a2bb6bc6f617).

The provider picks a mode when it starts: `honest`, `edit-output` (changes the score after proving), `swap-model` (runs a cheaper model) or `fake-input` (changes the agent's prompt). All four were run on Arc testnet, and the three cheating modes were slashed.

## Architecture

```
            QuickNode Stream (arc-testnet, logs)
                 │  USDC transfers + ReceiptEscrow events
                 ▼
  web/ on Vercel: /api/streams ──► Neon Postgres ──► /api/features/:address
                                         │                   │
                                         ▼                   ▼
                                  /r/<jobId> receipts    agent/ (zkr CLI)
                                                             │ x402: 402, then X-PAYMENT
                                                             ▼
                                                   seller/ (FastAPI + EZKL)
                                                             │ open / fulfill
                                                             ▼
                               Arc testnet: ReceiptEscrow ──► Halo2Verifier
```

| Part | Directory | Stack |
|---|---|---|
| Model and EZKL pipeline | `model/` | Python, PyTorch, ONNX, EZKL 23.0.5 |
| Provider server | `seller/` | FastAPI, web3.py, EZKL |
| Escrow and verifier contracts | `contracts/` | Solidity 0.8.24, Foundry |
| Buyer agent | `agent/` | TypeScript, viem |
| Stream receiver, features API, receipts | `web/` | Next.js 16 on Vercel, Neon Postgres |
| Shared definitions | `spec/` | features, test vectors, EZKL instance layout |

The model is a small MLP (7→16→8→1). EZKL proves it with the weights hashed and the prompt and output public. A proof is 3,840 bytes and takes about 3 s on a laptop. The verifying key depends only on the circuit, so every provider with this architecture shares one verifier, and the commitment each one registered is what tells them apart.

## Contracts on Arc testnet (chain 5042002)

| Contract | Address | What it does |
|---|---|---|
| `ReceiptEscrow` | [`0xb292Ca92b5Cc6f621Ca15f2eb05f5066305b2905`](https://testnet.arcscan.app/address/0xb292Ca92b5Cc6f621Ca15f2eb05f5066305b2905) | Provider registry with bonds, x402 escrow, challenge and slash |
| `Halo2Verifier` | [`0xAa0B5BABb4E8A9f189712690457bDF30aFC9777f`](https://testnet.arcscan.app/address/0xAa0B5BABb4E8A9f189712690457bDF30aFC9777f) | EZKL-generated verifier for the model's circuit |
| USDC | `0x3600000000000000000000000000000000000000` | Arc's native USDC |

How a job moves through `ReceiptEscrow`:

- `registerSeller` takes the model commitment and pulls the bond.
- `open` pulls the payment with an EIP-3009 authorization whose nonce binds the provider, the prompt hash and the deadline, so the terms can't change after the agent signs.
- `fulfill` stores the prompt, the output and the proof hash.
- `finalize` pays the provider once the 60 second window has passed. `refund` returns the payment if the provider never answers.
- `challenge` rebuilds the public inputs from storage and calls the verifier with a fixed 3M gas, so nobody can fake a failure by starving the call. A bad proof refunds the buyer and slashes the bond. A valid proof makes the challenge revert.

USDC is also Arc's gas token, so the agent holds one asset for payments, bonds and gas. A challenge costs about 755k gas, roughly 0.02 USDC. `forge test` covers every state change against a real proof fixture.

## QuickNode Streams

The agent writes the model's prompt itself, so it needs its own record of who sent USDC to whom. A QuickNode Stream provides it, and the receipt pages read escrow events from the same Stream.

| Setting | Value |
|---|---|
| Network | `arc-testnet` |
| Dataset | `logs` |
| Filter | `web/stream/filter.js` |
| Destination | Webhook to `https://zkreceipt.vercel.app/api/streams`, HMAC-signed |
| Created by | `scripts/create-stream.mjs` |

The filter keeps two kinds of log:

- USDC `Transfer` logs from Arc's native emitter. Every USDC movement on Arc emits one there, including gas-token transfers, so reading only the emitter counts each transfer once.
- Every log from `ReceiptEscrow`, for the receipt pages.

`/api/streams` stores them in Neon and tracks the highest block synced with no gaps. `/api/features/:address` computes the seven prompt features at that block, as defined in `spec/features.json`.

## The agent's decision loop

`zkr pay <address> <amount>` runs this, with every limit read from `agent/policy.json`:

1. Refuse if the payment would go over the daily budget.
2. Build the prompt from the address's features in the Stream index.
3. Pick the cheapest provider that is registered, not slashed, has the minimum bond and is under the price cap.
4. On the 402, check every payment field against the chain. Refuse to sign if anything differs.
5. Sign an EIP-3009 authorization for exactly that price into escrow.
6. Read the job back from the chain and verify the proof with `eth_call`.
7. If the proof fails, challenge, get refunded and try the next provider (up to 3).
8. If it verifies, pay the address only if the proven risk is below the threshold, and ask a human first above the approval limit.

| Limit | Value |
|---|---|
| `riskThreshold` | 0.5 |
| `maxCheckPrice` | 0.02 USDC |
| `minSellerBond` | 0.5 USDC |
| `dailyBudget` | 2 USDC |
| `approvalAbove` | 1 USDC needs a typed "yes" |
| `maxSellerAttempts` | 3 |

The agent has no list of good or bad providers. It learns that one cheats only from a failed proof.

## Running it

Needs Python 3.12 with `uv`, Node 24 with `pnpm`, Foundry and `solc` 0.8.24. Copy `.env.example` to `.env` and fill it in. Every command starts from the repo root.

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

# providers from deployments/demo.json
(cd seller && uv run python ../scripts/demo_up.py)

# agent, in another terminal
cd agent && pnpm i
pnpm zkr sellers
pnpm zkr pay <address> 0.05 --trust    # plain x402 buyer, for comparison
pnpm zkr pay <address> 0.05
pnpm zkr finalize
```

Provider weights (`weights.pt`, `network.onnx`, `network.ezkl`, `pk.key`) are never committed, since keeping them secret is the point.

## Limits

- EZKL proves small models. FlashProve proves LLM inference, but at about 19 MB per 1,024 tokens it's too large to verify onchain. The escrow only needs a commitment and a verifier, so a smaller LLM proof could use it unchanged.
- The proof shows which model produced the answer, not that the model is any good. The demo model is trained on simulated wallets.
- The 60 second window and tiny amounts are sized for a live demo.
