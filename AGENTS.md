# AGENTS.md

Instructions for any coding agent working in this repo. Read `PLAN.md` first: it has the protocol, the decisions already made, the schedule and the cut list. Don't reopen decisions listed under "Decisions already made" unless a human asks.

Honest Model is an x402 payment layer on Arc testnet where a buyer agent pays into escrow for a risk score, the seller proves with EZKL that its committed model produced the score from the agent's inputs, and a bad proof gets the seller's bond slashed onchain.

## Deadline

Submission closes Fri Nov 20, 12:00 PM CST. Working end to end beats complete. When a task is going badly, check the cut list in `PLAN.md` before going deeper.

## No hardcoding

This is the most important rule in the repo. The demo follows a known script, but every step in it has to be the real system doing real work. A judge can ask us to restart a seller in another mode, check a different address or open any tx on the explorer, and it has to hold up.

Never:

- put a risk score, label, verdict, "safe"/"risky" string or seller behaviour in agent, indexer or web code that depends on which address or seller it is
- branch on a specific address, seller name, jobId or tx hash outside `deployments/` and `scripts/`
- fake or mock a tx hash, proof, verification result, receipt, Stream event or HTTP response in anything that runs during the demo
- tell the agent which seller cheats. It learns that only from verification.
- precompute proofs or cache answers to replay on stage
- write an address literal in source code. Addresses come from `deployments/arc-testnet.json` or env.
- show a UI or terminal state the chain doesn't back up

Allowed:

- seed scripts that create known wallets with known behaviours (that's the test world, and its transfers are real)
- a seller `--mode` flag, chosen when the process starts, that selects a real code path
- mocks inside unit tests only, under `test/` or `tests/`, never imported by runtime code
- demo config (which seller runs which mode, prices, bonds, challenge window) in env or JSON files

If you can't make something work for real, stop and say so. Don't paper over it.

## Layout

```
spec/          features.json, vectors.json, instances.md (shared contracts between Python and TS)
model/         Python: simulator, training, ONNX export, EZKL pipeline -> model/artifacts/<model-name>/
seller/        Python FastAPI seller server (x402, prove, open/fulfill), --mode honest|edit-output|swap-model|fake-input
contracts/     Foundry: HonestEscrow.sol, generated Verifier.sol, tests, deploy scripts
indexer/       TS: QuickNode Stream webhook receiver + features API
agent/         TS: `honest` CLI (buyer agent), policy.json
web/           Next.js receipt page (/r/<jobId>), deployed to Vercel
scripts/       seed wallets, register sellers, reset demo
deployments/   arc-testnet.json: chain ID, RPC env var name, USDC, HonestEscrow, verifiers, sellers
```

## Ownership

- Person A: `model/`, `seller/`, `spec/features.json`, `spec/instances.md`
- Person B: `contracts/`, `indexer/`, `agent/`, `deployments/`
- Shared: `spec/vectors.json`, `scripts/`, `web/`, README

Agents working for one person stay in that person's directories. A change to anything in `spec/` breaks the other side, so say so in the commit message and tell the other person.

## Shared contracts

- `spec/features.json` defines the 7 features: name, how it's computed from USDC transfers at or before a block, transform, clip range and the EZKL scale. The Python simulator and the TS indexer both implement it.
- `spec/vectors.json` holds transfer lists with expected features and expected field elements. Both sides run these in their tests. Feature or quantization drift makes honest proofs fail, so these tests must pass before any integration run.
- `spec/instances.md` records the EZKL instance order, how the parameter hash appears, and the verifier's function signature, all confirmed against the installed EZKL version. `HonestEscrow.challenge` and the agent's `eth_call` both build instances from it.

## Commands

Fill these in as each part is created and keep them current.

```
# model (A)
cd model && uv sync && uv run python -m model.train && uv run python -m model.ezkl_pipeline

# seller (A)
cd seller && uv run python -m seller --mode honest --port 8001

# contracts (B)
cd contracts && forge build && forge test -vv
forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast

# indexer (B)
cd indexer && pnpm i && pnpm dev

# agent (B)
cd agent && pnpm i && pnpm honest sellers

# web
cd web && pnpm i && pnpm dev
```

## Stack

- Python 3.12 with `uv`; PyTorch, ONNX, `ezkl`, FastAPI, `web3.py`
- TypeScript on Node 24 with `pnpm`; `viem` for all chain access
- Foundry for contracts, Solidity ^0.8.24
- Arc testnet, chain ID 5042002, RPC from QuickNode (`ARC_RPC_URL`)
- Next.js App Router for `web/`, deployed on Vercel

Check library APIs against the installed version (package docs or source) before writing code that depends on them. EZKL, x402 and Streams APIs move fast, and remembered flag names are often wrong.

## Secrets and config

- Private keys and API keys go in `.env` (gitignored). `.env.example` lists every variable with no values.
- Never commit `.env`, keys, or anything that contains seller weights: `model/artifacts/*/weights*`, `network.onnx`, `network.ezkl` (the compiled circuit embeds the weights) and `pk.key`. The point of the project is that seller weights stay secret. `settings.json`, `vk.key`, `Verifier.sol`, `commitment.json` and `eval.json` are fine to commit. The verifying key is shared by every model with the same architecture (see `spec/instances.md`).
- One wallet per role: deployer, each seller, the agent, and the seed wallets (generated by `scripts/seed.ts`, keys stored in `.env.seed`, also gitignored).

## Testing

- Contracts: a Foundry test for every state change in `HonestEscrow`: register, open (good and tampered terms), fulfill, finalize (before and after the window), refund, challenge that slashes, challenge that reverts on a valid proof, and challenge with a wrong input preimage. Use a real proof fixture generated by `model/` for the verifier path.
- Python and TS: `spec/vectors.json` tests on both sides.
- End to end: `scripts/e2e.sh` runs the demo sequence against Arc testnet from a reset. Run it after every merge to main from T-9 on.

## Git

- Small commits on short-lived branches, merged to `main` often. Both people pull before starting a new task.
- Commit messages say what changed and why. Mention `spec/` changes in the first line.
- Don't commit generated artifacts larger than a few MB. Keep the EZKL SRS out of git and download it in the pipeline script.

## Definition of done

A task is done when it runs against Arc testnet (or its tests pass, for contracts and spec work), the README section for that part is updated, and nothing in it breaks the no-hardcoding rule.
