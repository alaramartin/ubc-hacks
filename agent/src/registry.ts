import type { Address } from "viem";
import { escrow, publicClient } from "./chain.ts";

export type SellerView = {
  address: Address;
  commitment: bigint;
  price: bigint;
  bond: bigint;
  slashed: boolean;
  registered: boolean;
  endpoint: string;
};

/** Every seller registered in the escrow, read from chain. */
export async function listSellers(): Promise<SellerView[]> {
  const n = (await publicClient.readContract({ ...escrow, functionName: "sellerCount" })) as bigint;
  const addrs = await Promise.all(
    Array.from({ length: Number(n) }, (_, i) =>
      publicClient.readContract({ ...escrow, functionName: "sellerList", args: [BigInt(i)] }) as Promise<Address>,
    ),
  );
  return Promise.all(addrs.map(getSeller));
}

export async function getSeller(address: Address): Promise<SellerView> {
  const [commitment, price, bond, slashed, registered, endpoint] = (await publicClient.readContract({
    ...escrow,
    functionName: "sellers",
    args: [address],
  })) as [bigint, bigint, bigint, boolean, boolean, string];
  return { address, commitment, price, bond, slashed, registered, endpoint };
}
