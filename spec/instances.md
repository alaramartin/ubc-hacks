# EZKL proof instances

Confirmed against ezkl 23.0.5 (Python) with `input_visibility = "public"`, `output_visibility = "public"`, `param_visibility = "hashed"`.

## Layout

A proof has one instance column with 9 field elements (BN254 scalar field):

| Index | Value |
|---|---|
| 0 | Model commitment: Poseidon hash of all model parameters (one felt) |
| 1 to 7 | The 7 input features, quantized at `input_scale` |
| 8 | The output logit, quantized at the output scale |

`HonestEscrow.instancesOf(commitment, input, output)` builds exactly this array.

## Quantization

- `input_scale = 13` and output scale `13` for the current circuit (read them from `model/artifacts/riskone/settings.json`, never hardcode them).
- A value `x` becomes `round_half_even(x * 2^scale)`. A negative value `v` is encoded as `p - |v|`, where `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- The output is a logit. `risk = sigmoid(logit)`.

## Encodings

- `proof.json` in EZKL stores instances as 32-byte little-endian hex strings. `model/src/model/fixture.py` converts them to integers.
- The proof bytes for the EVM verifier are `proof.json` `hex_proof`.
- The verifier is `Halo2Verifier.verifyProof(bytes proof, uint256[] instances) returns (bool)`. A bad proof can either revert or return false, and both mean "not valid".

## Verifier sharing

The verifying key depends on the circuit (architecture, scales, logrows), not on the weights. Two models with the same architecture built from the same `settings.json` have byte-identical `vk.key` and `Verifier.sol` (checked for `riskone` and `cheaprisk`). One verifier deployed per architecture serves every seller, and a seller's model is identified only by its commitment. A model with all-zero weights does produce a different key, so the reference build uses real weights.

## Measured

| Item | Value |
|---|---|
| Proving time (M-series laptop, logrows 15) | about 2.8 s |
| Verifier runtime size | 19.8 KB |
| `verifyProof` gas on Arc testnet (`eth_estimateGas`) | about 735k |
| `verifyProof` gas in Foundry | about 1.05M |
