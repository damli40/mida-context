import { getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import type { Address, Hex } from "@mida/protocol"
import { contextRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"
import { chainFor } from "./deployment.js"
import { getLogsChunked } from "./logs.js"
import type { LogClient } from "./logs.js"

const CONTEXT_REGISTERED = getAbiItem({ abi: contextRegistryAbi, name: "ContextRegistered" }) as AbiEvent

/**
 * Where Monad placed one save: the block its anchoring event sits in and the log's index inside
 * that block — the chain's own intra-block order. `record.createdAt` already carries Monad's
 * timestamp (the contract stores `block.timestamp`); the block and index exist only in the event
 * log, so a reader that needs them scans it.
 */
export interface RecordPlacement {
  block: bigint
  index: number
}

/**
 * contextId → the placement of its ContextRegistered log. The owner — and optionally the
 * namespace — ride the indexed topics, so one bounded scan answers for every record a read is
 * about to return. Keys are lower-cased contextIds; a record whose log is somehow absent simply
 * has no entry — its callers still order on the chain-stored createdAt and degrade only the
 * same-second tie-break, never the timestamp itself.
 */
export async function recordPlacements(input: {
  client: LogClient
  deployment: Deployment
  owner: Address
  namespaceId?: Hex
  toBlock?: bigint
  maxRange?: bigint
}): Promise<Map<string, RecordPlacement>> {
  const logs = await getLogsChunked(
    input.client,
    {
      address: input.deployment.contextRegistry,
      event: CONTEXT_REGISTERED,
      args:
        input.namespaceId === undefined
          ? { owner: input.owner }
          : { owner: input.owner, namespaceId: input.namespaceId },
      fromBlock: input.deployment.deploymentBlock,
      ...(input.toBlock === undefined ? {} : { toBlock: input.toBlock }),
    },
    input.maxRange === undefined ? {} : { maxRange: input.maxRange },
  )
  const map = new Map<string, RecordPlacement>()
  for (const log of logs) {
    const contextId = (log.args as { contextId?: unknown }).contextId
    if (typeof contextId !== "string" || log.blockNumber === null || log.logIndex === null) continue
    map.set(contextId.toLowerCase(), { block: log.blockNumber, index: log.logIndex })
  }
  return map
}

/** The narrow slice of viem's PublicClient a block-time lookup needs. */
export interface BlockClient {
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

// ---------------------------------------------------------------------------
// in-9 R-1 — the bounded placement scan for same-second ties
// ---------------------------------------------------------------------------

/**
 * The narrow slice of viem's PublicClient the tie-break scan needs: log windows plus the latest
 * block's number and timestamp, which is what anchors a record's second back to a block.
 */
export interface TieScanClient extends LogClient {
  getBlock(parameters?: { blockTag?: "latest" }): Promise<{ number: bigint | null; timestamp: bigint }>
}

/** The window a same-second tie opens around its estimated block — ±64 blocks, never the history. */
export const PLACEMENT_TIE_SPAN = 64n

/**
 * contextId → placement, recovered ONLY for records whose chain stamps share a second — the one
 * case where `createdAt` alone cannot order them (in-9 R-1). The event sits in a block whose
 * timestamp is that second, so the record's stamp plus the head block estimate where to look:
 * estimate = head − (head's age at that second × this chain's blocks/second), scanned ±SPAN.
 * One getLogs per disjoint window; overlapping windows merge, so a handful of ties costs 1–3
 * requests. A miss is a miss — the caller falls back to the contextId tie-break, never to a
 * whole-history scan.
 */
export async function recordPlacementsNear(input: {
  client: TieScanClient
  deployment: Deployment
  owner: Address
  namespaceId?: Hex
  /** The tied second (the records' shared `createdAt`) → the contextIds stamped with it. */
  tied: ReadonlyMap<bigint, readonly Hex[]>
}): Promise<Map<string, RecordPlacement>> {
  const map = new Map<string, RecordPlacement>()
  if (input.tied.size === 0) return map
  const head = await input.client.getBlock({ blockTag: "latest" })
  if (head.number === null) return map
  // Blocks per second for the estimate: the chain's own blockTime when viem knows it (Monad is
  // 400 ms), else a one-block-per-second guess — only the estimate's aim depends on it, and a
  // bad aim just means a window that finds nothing.
  let msPerBlock = 1_000n
  try {
    const blockTime = chainFor(input.deployment.chainId).blockTime
    if (blockTime !== undefined && blockTime > 0) msPerBlock = BigInt(blockTime)
  } catch {
    // an unknown chain keeps the guess
  }
  // One ±SPAN window per tied second; adjacent windows merge into one scan.
  const windows: { fromBlock: bigint; toBlock: bigint; contextIds: Set<string> }[] = []
  for (const [second, contextIds] of input.tied) {
    const age = head.timestamp > second ? head.timestamp - second : 0n
    const estimate = head.number - (age * 1_000n) / msPerBlock
    const fromBlock =
      estimate - PLACEMENT_TIE_SPAN > input.deployment.deploymentBlock ? estimate - PLACEMENT_TIE_SPAN : input.deployment.deploymentBlock
    if (fromBlock > head.number) continue // the estimate lands past the head — nothing to scan
    const toBlock = estimate + PLACEMENT_TIE_SPAN < head.number ? estimate + PLACEMENT_TIE_SPAN : head.number
    const ids = new Set(contextIds.map((id) => id.toLowerCase()))
    const overlapping = windows.find((w) => w.fromBlock <= toBlock && fromBlock <= w.toBlock)
    if (overlapping === undefined) {
      windows.push({ fromBlock, toBlock, contextIds: ids })
    } else {
      if (fromBlock < overlapping.fromBlock) overlapping.fromBlock = fromBlock
      if (toBlock > overlapping.toBlock) overlapping.toBlock = toBlock
      for (const id of ids) overlapping.contextIds.add(id)
    }
  }
  const args =
    input.namespaceId === undefined
      ? ({ owner: input.owner } as Record<string, unknown>)
      : { owner: input.owner, namespaceId: input.namespaceId }
  const pages = await Promise.all(
    windows.map((window) =>
      input.client.getLogs({
        address: input.deployment.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { ...args, contextId: [...window.contextIds] },
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        strict: true,
      }),
    ),
  )
  for (const logs of pages) {
    for (const log of logs) {
      const decoded = log as DecodedLogForPlacement
      const contextId = decoded.args.contextId
      if (typeof contextId !== "string" || decoded.blockNumber === null || decoded.logIndex === null) continue
      map.set(contextId.toLowerCase(), { block: decoded.blockNumber, index: decoded.logIndex })
    }
  }
  return map
}

interface DecodedLogForPlacement {
  args: Record<string, unknown>
  blockNumber: bigint | null
  logIndex: number | null
}

/**
 * One `getBlock` per distinct block, shared across a whole call — a read that anchors many saves
 * out of a handful of blocks asks once each. The in-flight promise is cached so concurrent
 * callers share the request (and one another's failure).
 */
export function blockTimeCache(client: BlockClient): (block: bigint) => Promise<bigint> {
  const cache = new Map<bigint, Promise<bigint>>()
  return (block) => {
    let cached = cache.get(block)
    if (cached === undefined) {
      cached = client.getBlock({ blockNumber: block }).then((b) => b.timestamp)
      cache.set(block, cached)
    }
    return cached
  }
}
