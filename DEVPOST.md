# Devpost submission

Paste each section into the matching Devpost field.

**Project name:** zkReceipt

**Tagline:** Agents only pay for answers the committed model actually gave. Lying costs the seller its bond.

**Tracks:** Agentic Payments & AI, Best use of Arc, QuickNode Streams

**Links**
- Repo: https://github.com/alaramartin/ubc-hacks
- Receipts: https://zkreceipt.vercel.app
- ReceiptEscrow on Arc testnet: https://testnet.arcscan.app/address/0xb292Ca92b5Cc6f621Ca15f2eb05f5066305b2905
- Video: (add the YouTube or Drive link once it's uploaded)

**Built with:** Arc, USDC, x402, EIP-3009, EZKL, Halo2, Solidity, Foundry, PyTorch, ONNX, FastAPI, TypeScript, viem, QuickNode Streams, Next.js, Vercel, Neon Postgres

## What did you build?

A payment layer for AI answers on Arc. A buyer agent pays for a risk score on a wallet address through x402, but the USDC goes into an escrow contract instead of to the seller. The seller has to answer with a zk proof that the model it committed to, run on the agent's own inputs, produced that score. If the proof is good, the seller gets paid after a short window. If it's bad, the agent challenges it, the contract checks the proof itself, and the seller's bond is slashed.

It has four parts: the `ReceiptEscrow` contract with an EZKL-generated verifier on Arc testnet, a seller server that proves each answer, a terminal agent (`zkr`) that pays, verifies and challenges, and a Next.js app that indexes Arc through a QuickNode Stream and shows a receipt page for every job.

## What problem does it solve?

Agents are starting to buy answers from other services before they move money: is this address a drainer, is this invoice fraud, is this wallet a sybil. A cheating or cost-cutting seller can return "safe" and the agent can't tell. Today the only defence is trusting the vendor.

In our demo a plain x402 buyer asks the cheapest seller about a drainer wallet, gets a score of 0.005 and pays the drainer. Our agent asks the same seller about the same wallet, sees the proof fail, gets its money back from the seller's bond, buys the check from the honest seller instead (0.9999) and refuses to pay. Every step is a real transaction on Arc testnet.

## How does it work?

1. A seller registers a Poseidon hash of its secret model weights in `ReceiptEscrow` and posts a USDC bond.
2. The agent computes the model's 7 input features itself, from its own index of Arc USDC transfers. A QuickNode Stream on `arc-testnet` logs filters Arc's native USDC transfer events and the escrow's events, and posts them to a webhook on Vercel, which stores them in Postgres.
3. The agent calls the seller and gets an HTTP 402. It checks every field of the payment request against the chain, then signs an EIP-3009 authorization whose nonce binds the seller, the input hash and the deadline. The seller can't change the terms after the agent signs.
4. The seller opens the job, which pulls the payment into escrow, runs its model in EZKL (about 3 seconds), and posts the input, output and proof with `fulfill`.
5. The agent reads the job back from the chain and verifies the proof with a free `eth_call`, against the commitment, its own input and the posted output.
6. If the proof fails, the agent calls `challenge`. The contract builds the public inputs from storage and runs the verifier with a fixed gas amount, so nobody can fake a failure by starving the call. A failed proof refunds the buyer and slashes the seller. A valid proof makes the challenge revert.
7. Otherwise anyone can `finalize` after the 60 second window and the seller is paid.

The agent's rules (price cap, minimum bond, daily budget, risk threshold, human approval above 1 USDC) live in `policy.json`. It has no list of good or bad sellers. It finds out a seller cheats only from a failed proof.

We tested three ways to cheat, each one a real seller mode: editing the score after proving, running a cheaper model, and changing the agent's input. All three get slashed onchain.

## What makes it unique?

Most zkML demos stop at "here is a proof". We tied the proof to money. The escrow only releases payment for an answer the committed model gave, and a bad proof is settled by the contract with no oracle or committee. Because the agent computes the input from its own Stream index, a seller can't quietly prove a different question either.

Arc makes this practical. USDC is the gas token, so the agent holds one asset for payments, bonds and verification gas, and a full onchain verification costs about 0.02 USDC.

The receipt pages let anyone re-run the verifier from their browser against the onchain record, so a judge doesn't have to take our word for any result.

## What would you build next?

- Bigger models. EZKL proves small models well. Proofs for LLM inference exist (Anthropic's FlashProve) but are about 19 MB per 1,024 tokens, too large for onchain verification. The escrow only needs a commitment and a verifier, so a succinct wrapper around those proofs would plug into the same contract.
- Real risk models from real data, so sellers compete on accuracy as well as honesty.
- Third-party watchers. The input and proof are already onchain, so anyone can challenge any job and earn part of the bond. A small watcher service would make it unsafe to cheat even agents that don't verify.
- A standard x402 "escrow" scheme other sellers can adopt for any provable answer, not only risk scores.
