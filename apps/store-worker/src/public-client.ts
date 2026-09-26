import { createPublicClient } from "viem"
import type { PublicClient } from "viem"
import { rpcChain, rpcTransport } from "@mida/chain"

/**
 * The chain-read client every store-side component builds the same way (in-13 M-2). The `chain`
 * argument is what lets `batch: { multicall: true }` find Multicall3 — the worker's config comes
 * from env vars, so without this line viem silently sent one eth_call per read, the root cause
 * of the Sep 25 RPC-limit incident. `rpcChain` declares Multicall3 only on Monad testnet; any
 * other chain keeps plain per-read calls.
 */
export function storePublicClient(rpcUrl: string, chainId: bigint): PublicClient {
  return createPublicClient({ chain: rpcChain(chainId), batch: { multicall: true }, transport: rpcTransport(rpcUrl) })
}
