# zkReceipt: plan

UBC (University Blockchain Conference) Hackathon 2026. Submission closes **Fri Nov 20, 12:00 PM CST** on Devpost. Finals are in person at UT Austin on **Sat Nov 21** (4 min pitch + 2 min Q&A, up to 13 teams). Prizes require being at the closing ceremony.

## The pitch

AI agents already pay for answers, including risk checks on an address before they send it money. Nothing tells the agent whether the answer came from the model the seller advertises. Anthropic's FlashProve (Nov 2, 2026) showed a provider can prove which committed model produced an output, but proofs cost 70 to 95 times the GPU time of normal inference, which is too expensive to run on every request.

zkReceipt is the payment layer for provable inference, built today on a model small enough to prove in seconds. A seller commits to secret model weights on Arc. A buyer agent pays through x402 into an escrow contract instead of to the seller. The seller answers with a zk proof that the committed model, run on the agent's inputs, produced that answer. Correct answers get paid after a short window. Anyone who catches a bad proof challenges it, the contract verifies the proof onchain, the buyer is refunded and the seller loses its bond.

One-line version for the stage: **you only pay for answers the committed model actually gave, and lying costs the seller its bond.**

## What we enter

| Slot | Choice | Pass/fail requirement we must meet |
|---|---|---|
| Main track | Agentic Payments & AI ($2,000) | Agent executes onchain transactions; README documents the agent's decision loop and safety limits |
| Chain award | Best use of Arc ($1,000) | Core onchain functionality on Arc testnet; contract addresses in README with an explanation |
| Bounty | QuickNode Streams ($500) | Streams is a core data source; at least one Stream with a filter and a destination; README explains network, dataset, filter logic, destination and why |
| Automatic | Official UBC Winner (1st $2,500) | Judged on Technical Execution, Product & UX, Innovation, Impact & Potential, Demo |

Everyone: public GitHub repo with setup instructions, working demo, 2 to 3 minute video (YouTube or Drive), README with architecture, and Devpost answers to: What did you build? What problem does it solve? How does it work? What makes it unique? What would you build next? The project must be substantially built during the hackathon window (Nov 12 to 20), so it starts from an empty repo now.

## Decisions already made

- **What gets proven:** the weights commitment, the input and the output are all bound by the proof. Weights stay secret (hashed). Input and output are public instances.
- **Who computes the input:** the buyer agent, from its own QuickNode Streams index of Arc USDC transfers. The seller only supplies the secret model. Because the escrow records a hash of the agent's input, every way of cheating fails the same onchain check and can be slashed without a trusted oracle.
- **Settlement:** optimistic with a seller bond and a challenge window.
- **Risk data:** wallets we seed on Arc testnet with real transfer histories that behave like a drainer, a mixer user, a fresh wallet and normal users.
- **Agent:** deterministic policy code, no LLM. Nothing in it is hardcoded (see "No hardcoding" in AGENTS.md). The demo is a known sequence of real commands.
- **Demo surface:** a polished terminal CLI run live by one of us, plus a public receipt page per paid answer, plus the Arc explorer for the slash transaction. No dashboard.
- **Team:** 2 people. Person A owns zk and Python, Person B owns TypeScript and Solidity.

## System

```
                 QuickNode Stream (Arc testnet, receipts, filter: USDC Transfer + ReceiptEscrow events)
                          │ webhook
                          ▼
                    indexer (TS) ──── features API ────┐
                                                       │
  honest CLI (buyer agent, TS) ──POST /v1/risk────────►│ seller (Python, FastAPI + EZKL)
        │      ◄── 402 PaymentRequirements (escrow) ───│
        │      ── retry with X-PAYMENT (EIP-3009 sig) ►│──► ReceiptEscrow.open()      (Arc)
        │      ◄── 200 {jobId, output, proof} ─────────│──► ReceiptEscrow.fulfill()   (Arc)
        │
        ├── eth_call Verifier.verifyProof(proof, instances built by the agent)   (free)
        ├── pass: ReceiptEscrow.finalize() after window, then act on the risk score
        └── fail: ReceiptEscrow.challenge(jobId, inputFelts)  → onchain verify → refund + slash

  receipt page (Next.js on Vercel): /r/<jobId> reads events from Arc and re-runs verify in the browser
```

### Components

| Dir | Owner | What it is |
|---|---|---|
| `spec/` | A + B | `features.json` (feature names, transforms, EZKL scale) and cross-language test vectors. The single source both sides read. |
| `model/` | A | Python: wallet behaviour simulator, MLP training, ONNX export, EZKL pipeline, artifact output |
| `seller/` | A | Python FastAPI seller: x402 responses, proving, `open`/`fulfill` transactions, `--mode` cheat modes |
| `contracts/` | B | Foundry: `ReceiptEscrow.sol`, generated EZKL `Verifier.sol`, tests, deploy script |
| `web/` (indexer part) | B | Next.js route handlers on Vercel: `POST /api/streams` (Stream webhook, HMAC-checked) into Neon Postgres, `GET /api/features/:address` |
| `agent/` | B | TS `zkr` CLI: seller discovery, policy, x402 client, verify, challenge, finalize, pay |
| `web/` (receipts) | whoever is free first | `/r/<jobId>` receipt pages from the Stream-fed index of escrow events, plus chain reads |
| `scripts/` | A + B | Seeding demo wallets on Arc, registering sellers, demo reset |
| `deployments/arc-testnet.json` | B writes, everyone reads | Contract addresses, USDC address, chain ID, seller registry. No address literals anywhere else. |

## Protocol

### Seller registration

`ReceiptEscrow.registerSeller(commitment, verifier, price, endpoint)` with a USDC bond pulled by `transferFrom`. `commitment` is the Poseidon hash of the model parameters that EZKL exposes when `param_visibility = "hashed"`. `verifier` is the address of the seller's deployed EZKL verifier. Anyone can read the registry, and the agent's seller list comes only from it.

### One paid request

1. Agent picks a seller by policy (cheapest active seller with `bond >= MIN_BOND` that isn't slashed), reads `block = latest`, fetches features for the target address at that block from its own indexer, and converts them to field elements with the EZKL scale from `spec/features.json`.
2. Agent sends `POST /v1/risk {address, block, inputFelts}`.
3. Seller replies `402` with x402 PaymentRequirements: `scheme: "escrow"`, `network: "eip155:5042002"`, `asset: <USDC>`, `maxAmountRequired: price`, `payTo: <ReceiptEscrow>`, `extra: {seller, commitment, verifier, challengeWindow, deadline}`. The agent checks every field against the onchain registry and refuses on any mismatch.
4. Agent signs an EIP-3009 `ReceiveWithAuthorization` from itself to the escrow for `price`, with `nonce = keccak256(abi.encode(chainId, escrow, seller, inputHash, deadline))`, and retries with the `X-PAYMENT` header. The nonce binds the payment to this exact seller, input and deadline.
5. Seller calls `ReceiptEscrow.open(seller, inputHash, deadline, auth)`. The escrow calls `USDC.receiveWithAuthorization`, recomputes the nonce from the arguments so the seller can't change the terms, and stores the job under `jobId = nonce`.
6. Seller runs the model, proves, and calls `fulfill(jobId, outputFelts, proof)`. The full proof is in calldata so anyone can challenge it, and the escrow stores `keccak256(proof)`. The challenge window starts. The seller replies `200` with `{jobId, output, proof, txHash}` and an `X-PAYMENT-RESPONSE` header.
7. Agent builds the instances itself as `[inputFelts, outputFelts, commitment]` in EZKL's instance order and calls `verifier.verifyProof` with `eth_call`, which costs nothing.
   - **Pass:** the agent acts on the score. Anyone can call `finalize(jobId)` once the window ends, which pays the seller.
   - **Fail:** the agent calls `challenge(jobId, inputFelts)`. The contract checks that `keccak256(inputFelts) == inputHash`, assembles the instances from stored values only, and calls the verifier. If verification fails, the buyer gets the price back, `SLASH_AMOUNT` of the seller's bond goes to the challenger and the seller is marked slashed. If verification succeeds, the challenge reverts.
8. If the seller never fulfills, the buyer calls `refund(jobId)` after `deadline`.

The challenger supplies only the input preimage. The commitment, output and proof all come from contract storage, so a challenger can't make an honest proof fail.

### Why optimistic when the agent verifies right away

Judges will ask this. The `eth_call` check is free, so an honest request costs only `open`, `fulfill` and `finalize`. The expensive onchain verification runs only when someone disputes. Because proofs sit in calldata, any watcher can challenge, even if the buyer is offline. Measure the gas for `verifyProof` and `challenge` on Arc at H0 and put the real numbers in the README and the pitch.

### Seller modes (all real code paths, chosen by a CLI flag when the seller process starts)

| `--mode` | What the process does | Why it fails |
|---|---|---|
| `zkr` | Runs the committed model on the agent's input and proves it | It doesn't fail |
| `edit-output` | Proves honestly, then reports and posts a different output (for example "safe") | The output in the instances doesn't match the proof |
| `swap-model` | Runs and proves a different, cheaper model whose weights don't match the registered commitment | The commitment instance doesn't match |
| `fake-input` | Proves over altered features (zero drainer inflow, for example) | The contract's `inputHash` doesn't match the proven input |

The agent never knows which mode a seller runs. It finds out only through verification.

## Proof details (Person A)

- Model: MLP with 7 inputs, then 16, 8 and 1 units with a sigmoid, producing a risk score in [0, 1]. PyTorch, then ONNX, then EZKL. Keep it small enough to prove in under 10 seconds on a laptop.
- EZKL run args: `input_visibility = "public"`, `output_visibility = "public"`, `param_visibility = "hashed"`. Then `gen-settings`, `calibrate-settings`, `compile-circuit`, `get-srs`, `setup`, `create-evm-verifier`. Check every flag name against the installed EZKL version before relying on it.
- Confirm at H0: the order of instances in the proof, how the parameter hash shows up (one field element or several), and the verifier's Solidity function signature. Write these into `spec/instances.md`. The agent and the contract both depend on them.
- `swap-model` needs a second trained model with its own artifacts, proving against the same circuit shape so that the only difference is the commitment.
- Fallback if the hashed-params commitment turns out unusable: `param_visibility = "fixed"` bakes the weights into the circuit, so the verifier contract itself acts as the commitment and `registerSeller` stores the verifier's codehash. It's weaker on hiding the weights, and we'd have to say so in the README.

## Features and Streams (Person B, with A for the spec)

**Stream:** Arc testnet, dataset `block_with_receipts` (or `receipts`, whichever the Streams UI offers for Arc). The filter function keeps only logs where `address` is the USDC contract and `topic0` is `Transfer`, plus all logs from `ReceiptEscrow`, and returns a trimmed payload of block, tx hash, log index, from, to, value and event. Destination: webhook to the indexer. Backfill starts from the block where seeding began. Delivery is in order, and the indexer is idempotent on `(txHash, logIndex)`.

**Features**, all computed by the indexer from USDC transfers at or before `block` (the exact list, transforms and scale go in `spec/features.json`):

1. wallet age in blocks since the first transfer (log1p)
2. total transfer count (log1p)
3. unique counterparties (log1p)
4. total inflow in USDC (log1p)
5. outflow to inflow ratio (clipped to [0, 2])
6. most distinct senders inside any 500-block window (log1p)
7. median blocks between receiving funds and sending them on (log1p, capped)

**Training data:** the Python simulator generates labelled histories for normal, drainer, mixer-like and fresh wallets, computes the same 7 features and trains the model. Labels exist only in `model/`. The seeding script uses the same simulator behaviours to make real transfer histories on Arc from freshly generated keys. The agent only ever sees chain data and the model's score.

**Cross-language check:** `spec/vectors.json` holds transfer lists, their expected features and expected field elements. The Python simulator and the TS indexer both test against it. This catches the most likely integration bug, a feature or quantization mismatch, which would make every honest proof look like a cheat.

## The agent (Person B)

CLI commands:

- `zkr sellers`: registry table with commitment, price, bond, status and endpoint
- `zkr check <address>`: buys one risk check and prints each step
- `zkr pay <address> <amount>`: runs a check first, then sends USDC only if the policy allows it
- `zkr receipt <jobId>`: prints the receipt and the URL of the receipt page
- `zkr finalize`: finalizes jobs whose window has ended

**Decision loop** (documented in the README for the Agentic track):

1. Load the policy from `agent/policy.json`: risk threshold, per-request price cap, daily spend budget, minimum seller bond, human-approval threshold for payments.
2. Choose a seller from the registry under the policy. Skip any seller already slashed or already challenged by this agent.
3. Buy the check (steps 1 to 6 above) and verify it.
4. On a failed verification: challenge, wait for the receipt, mark the seller bad, then go back to step 2.
5. On a pass: if `score >= threshold`, refuse the payment and print why. Otherwise pay, unless the amount is over the approval threshold, in which case it asks for a typed confirmation.
6. Every spend, including check fees, counts toward the daily budget, and the agent stops when the budget is used up.

**Terminal output:** each step on one line, with status, the onchain tx (shortened, plus an explorer link) and timing. It should read well from the back of a room: large font, high contrast, no spinners that hide what's happening.

## Receipt page

`web/` Next.js app on Vercel. `/r/<jobId>` shows the seller, the commitment, the decoded input features, the output score, proof size, status (open, fulfilled, finalized, challenged or slashed), all transactions with explorer links, and a "Verify again" button that runs the same `eth_call` in the browser. All data comes from Arc RPC and event logs. There's no database and nothing faked. Load the `website-design` skill before building it.

## Demo

### Seeded world (made by `scripts/seed.ts`, real transfers on Arc)

- `drainer`: many small inflows from many fresh wallets inside a few hundred blocks, forwarded out fast
- `mixer-user`: round-amount hops through a ring of intermediate wallets
- `merchant`: older, steady two-way payments with a few repeat counterparties
- a handful of normal users and the fresh wallets the drainer pulls from

### Sellers

- `RiskOne` runs `--mode honest` at price 0.10 USDC.
- `CheapRisk` runs `--mode edit-output` at 0.05 USDC. Being cheaper is the only reason the agent tries it first.

Both register real commitments and real bonds. Either can be restarted in another mode during Q&A to show that the modes are real.

### Live pitch (4:00)

| Time | Content |
|---|---|
| 0:00 to 0:35 | The problem. Agents pay for answers, nobody checks which model gave them, and FlashProve shows the cryptography works but is too expensive for every request today. |
| 0:35 to 0:55 | One architecture slide: commit, pay into escrow, prove, verify, slash. |
| 0:55 to 2:50 | Live. `zkr sellers` shows two bonded sellers. `zkr pay <drainer> 5` picks CheapRisk, gets a 402, opens the escrow, receives "risk 0.03, safe" with a proof, verify fails, challenges, onchain verify fails, bond slashed, refund. The Arc explorer shows the slash tx. The agent moves on to RiskOne and gets "risk 0.94", verify passes, and it refuses to send the 5 USDC. Then `zkr pay <merchant> 5` passes and pays. Open the receipt page and press "Verify again". |
| 2:50 to 3:30 | Numbers: proof time, verify gas on Arc, cost per check, challenge cost. All measured. |
| 3:30 to 4:00 | Next: the escrow works with any committed model, so as FlashProve-style proofs get cheaper, bigger models plug into the same contract. |

Keep a pre-recorded backup of the live section on the laptop in case the venue Wi-Fi fails.

### Video (2 to 3 min)

The same story as the live pitch, recorded from the real system. Load the `demo-video` skill before making it (per the global CLAUDE.md). That takes well over 10 minutes, so start no later than T-4h.

## Build schedule

Times are hours before the 12:00 PM CST deadline (T-16 is about 8 PM CST on Nov 19). Sleep in shifts if the checkpoints have passed: A sleeps T-8 to T-5 and B sleeps T-5 to T-2. If a checkpoint fails, both stay up and cut scope instead.

### H0 spikes, T-16 to T-14 (both, in parallel). Every item has a kill criterion.

| Owner | Spike | Done when | If it fails |
|---|---|---|---|
| A | Toy 7-input MLP through the whole EZKL pipeline | A proof made and verified locally in under 10 s; `spec/instances.md` written | Shrink the model or lower `logrows`. Give it 1 hour, then fall back to 4 inputs |
| B | Deploy the EZKL verifier from A's toy run to Arc testnet with Foundry, call `verifyProof` | Returns true onchain; gas measured | If it's over the contract size limit, try EZKL's separate verifying-key artifact. If that also fails, split the VK. Do not move to escrow work until this works |
| B | Check Arc USDC | `receiveWithAuthorization` exists on the USDC ERC-20 interface at the address in Arc docs; decimals confirmed | Fallback: agent calls `approve`, then `openFor` with `transferFrom`. Same escrow logic, one more tx |
| B | Create the QuickNode Stream on Arc testnet into a webhook (tunnel for now) | Test transfers appear at the webhook | Ask in the hackathon Telegram; QuickNode has a guide on indexing Arc USDC transfers with Streams |
| A | Faucet | Several wallets funded from faucet.circle.com for bonds and seeding | Keep amounts small: seeding transfers can be 0.01 USDC |

### Lanes, T-14 to T-9

**A:** `spec/features.json` and `spec/vectors.json` (first, by T-13, so B can build the indexer against them). Then the simulator and training, then the honest and swap models with artifacts, then the seller server (402, open, prove, fulfill) with all four modes.

**B:** `ReceiptEscrow.sol` with Foundry tests for every state change, including challenge success and failure. Deploy and write `deployments/arc-testnet.json`. Then the indexer and features API against the vectors, then the agent CLI: registry, policy, x402 client, verify, challenge, finalize.

**Checkpoint 1 at T-9:** one honest paid request end to end on Arc testnet, with features from the Stream-fed indexer and a real proof. If this slips past T-8, cut the receipt page and `fake-input`.

### T-9 to T-5

- A: seeding script and running it on Arc, seller registration script, demo reset script (fresh agent wallet, re-funded bonds, new sellers).
- B: challenge path wired into the agent, terminal output polish, `pay` and policy.
- Whoever is free: receipt page.

**Checkpoint 2 at T-5:** the whole demo sequence runs three times in a row from a reset, with no manual steps.

### T-5 to T-0

- README (architecture, setup, contract addresses, Stream config, decision loop and safety limits, measured numbers, limits and trust assumptions). Load `humanize-write`.
- Video: record the real run, then follow the `demo-video` skill.
- Devpost text answering the five questions.
- **Submit by 11:00 AM CST**, an hour of buffer. Check the video link opens logged out.

### After submission (Nov 20 afternoon to Nov 21)

Finalists are told by midnight Nov 20. Rehearse the 4 minute pitch with a timer, do the Q&A prep below, test the demo on hotspot Wi-Fi and charge everything.

## Cut list (cut from the top)

1. "Verify again" button (the page still shows the receipt)
2. Receipt page entirely (`zkr receipt` prints it in the terminal)
3. `fake-input` mode
4. `swap-model` mode
5. Human-approval prompt in the policy

Never cut: real proofs, the 402 flow, escrow plus the onchain challenge and slash, Stream-fed features, the cheater running as a real process.

## Risks

| Risk | Signal | Response |
|---|---|---|
| Verifier too big or too expensive for Arc | H0 deploy fails or gas is over the block limit | Smaller circuit; separate VK artifact; as a last resort, verify in `challenge` with a smaller model only |
| Feature or quantization mismatch between Python and TS | Honest proofs fail `eth_call` | `spec/vectors.json` tests on both sides from T-13 |
| Proving too slow for the stage | Over 15 s | Smaller model; prove on the faster laptop; show elapsed time as a feature |
| Stream lag on stage | Features missing for the latest block | The agent asks for features at the indexer's latest synced block and records that block in the request |
| Faucet limits | Not enough USDC for bonds | Small bonds (10 USDC), small prices, fund early |
| Venue Wi-Fi | Slow or dropped RPC calls in rehearsal | Phone hotspot plus the recorded backup |

## Q&A prep

- *Why not just verify every proof onchain?* Measured verify gas versus `eth_call`. Optimistic settlement makes the honest path cheap, and the proof in calldata lets anyone challenge.
- *Couldn't the seller lie about the input?* No. The agent computes the input and the escrow binds its hash, so a proof over other inputs fails the onchain check.
- *What stops the seller from training a bad model and committing to it?* Nothing, and we don't claim otherwise. The proof shows which model answered. Reputation and bonds work at the model level, and buyers can choose committed models with a track record. FlashProve has the same limit.
- *Why a small MLP?* Proofs for it take seconds today. The protocol doesn't care about model size, so FlashProve-class models plug into the same escrow as proving costs drop.
- *Why Arc?* Gas is paid in USDC, so the agent holds one asset for gas, fees, bonds and payments, and costs are predictable in dollars.
- *Is the x402 part standard?* The transport is standard x402 (402, `X-PAYMENT`, `X-PAYMENT-RESPONSE`). The `escrow` scheme is ours. It uses EIP-3009 like the standard `exact` scheme, but pays into the escrow and binds the job terms in the nonce.
- *What are the trust assumptions?* EZKL's soundness, the SRS, the indexer belonging to the agent itself, and a challenge window long enough for someone to watch. All listed in the README.

## Open items to verify at H0 (don't trust memory)

- Arc testnet RPC URL from QuickNode, chain ID 5042002, the USDC ERC-20 address and decimals, the explorer URL, and faucet limits
- EZKL CLI and Python flag names in the installed version, the instance order, the parameter-hash format, and the verifier function signature
- Which datasets Streams offers for Arc testnet, and the filter function format
- Arc's contract size limit and block gas limit

## Changes from the first draft

- The circuit proves the logit, and `risk = sigmoid(logit)` is applied by the reader. Dropping the sigmoid lookup took logrows from 17 to 15 and proving from 14 s to about 3 s.
- Features are flow-based (spec/features.json) with no wallet age or absolute amounts, and training adds random time compression, because seeded demo histories only span minutes.
- `fulfill` posts the input preimage, so anyone can re-verify or challenge a job, not only the buyer.
- The indexer and receipt pages are one Next.js app in `web/`.
- The index reads Arc's native USDC emitter (`0xff…fe`, 18 decimals) rather than the ERC-20 mirror, per QuickNode's Arc guide.
- Demo amounts are tiny: bonds 0.5 USDC, slash 0.25, checks 0.005 to 0.01, payments about 0.05.

## Progress log

- Nov 19: PLAN.md, AGENTS.md and CLAUDE.md written. Nothing built yet.
- Nov 19, 5:00 to 5:35 AM CST: EZKL pipeline, verifier on Arc (735k gas per verify), ReceiptEscrow with 14 tests, both models trained with shared verifying key, seller with 4 modes, agent CLI, web indexer and receipts (not deployed yet), seeding running. Waiting on: Neon terms, QuickNode account.
- Nov 19, 6:00 AM CST: escrow redeployed (fulfill carries the input). Web app live at https://zkreceipt.vercel.app with Neon. Protocol e2e on Arc passes for all four seller modes: honest verifies; edit-output, swap-model and fake-input are each challenged and slashed (challenge about 755k gas). Seeded demo wallets in deployments/demo-wallets.json. Waiting on: QuickNode account (the Stream is the last missing piece for `zkr pay`).
- Nov 20, 12:30 AM CST: QuickNode Stream 843cb3a4 created (filter tested on real blocks; fixed escrow placeholder substitution), backfilling from block 73010098 into Neon. Agent `pay --trust` mode for the plain-x402 comparison. scripts/demo_up.py starts sellers from deployments/demo.json and makes a fresh cheater when the last one is slashed.
- Nov 20, 1:00 AM CST: Stream caught up to the tip. Full demo flow ran on Arc from the Stream-fed index: `pay --trust` paid the drainer on CheapRisk's fake 0.005; `pay` caught CheapRisk, slashed it, got 0.9999 from RiskOne and refused; `pay` to the normal wallet verified and paid. Receipt pages and in-browser re-verification checked for both outcomes. README and DEVPOST.md written. Repo is public. Left: demo video (waiting for Alara), Devpost submission.
- Nov 20, 1:20 AM CST: renamed the project to zkReceipt: ReceiptEscrow (source and ABI names; the deployed contract is unchanged), `zkr` CLI, site at https://zkreceipt.vercel.app (Vercel project zkreceipt), Stream webhook moved to the new domain. Fixed the index's synced-block check, which reported false gaps when batches overlapped.
