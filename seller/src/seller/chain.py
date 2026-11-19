"""Arc testnet access for the seller: escrow contract, transactions."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from eth_account import Account
from web3 import Web3

ROOT = Path(__file__).resolve().parents[3]
DEPLOYMENT = json.loads((ROOT / "deployments" / "arc-testnet.json").read_text())
ESCROW_ABI = json.loads((ROOT / "deployments" / "abi" / "HonestEscrow.json").read_text())
ERC20_ABI = [
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"name": "s", "type": "address"}, {"name": "v", "type": "uint256"}], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}], "outputs": [{"type": "uint256"}]},
]


@dataclass
class TxResult:
    hash: str
    gas_used: int
    block: int


class Chain:
    def __init__(self, private_key: str):
        rpc = os.environ.get(DEPLOYMENT["rpcEnv"])
        if not rpc:
            raise RuntimeError(f"{DEPLOYMENT['rpcEnv']} is not set")
        self.w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30}))
        self.account = Account.from_key(private_key)
        self.address = self.account.address
        self.escrow = self.w3.eth.contract(address=Web3.to_checksum_address(DEPLOYMENT["escrow"]), abi=ESCROW_ABI)
        self.usdc = self.w3.eth.contract(address=Web3.to_checksum_address(DEPLOYMENT["usdc"]), abi=ERC20_ABI)
        self._lock = threading.Lock()

    def send(self, fn, gas: int | None = None) -> TxResult:
        """Build, sign and send a contract call, wait for the receipt, raise if it reverted."""
        with self._lock:
            tx = fn.build_transaction(
                {
                    "from": self.address,
                    "nonce": self.w3.eth.get_transaction_count(self.address, "pending"),
                    "chainId": DEPLOYMENT["chainId"],
                }
            )
            if gas is not None:
                tx["gas"] = gas
            signed = self.account.sign_transaction(tx)
            h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        r = self.w3.eth.wait_for_transaction_receipt(h, timeout=60, poll_latency=0.25)
        if r["status"] != 1:
            raise RuntimeError(f"transaction {h.hex()} reverted")
        return TxResult("0x" + h.hex().removeprefix("0x"), r["gasUsed"], r["blockNumber"])
