import { getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import type { Address, Hex } from "@mida/protocol"
import { contextRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"
import { chainFor } from "./deployment.js"
import { SAFE_LOG_BLOCK_RANGE, blockWindows, getLogsChunked } from "./logs.js"
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
 * The narrow slice of viem's PublicClient the tie-break scan needs: log windows, the latest
 * block, and — since in-12 N-5 corrects the estimate with the chain's own observed block rate —
 * a single numbered block's timestamp. A missing block answers `null`, never a throw.
 */
export interface TieScanClient extends LogClient {
  getBlock(parameters?: { blockTag: "latest" } | { blockNumber: bigint }): Promise<{ number: bigint | null; timestamp: bigint } | null>
}

/**
 * Half the blocks a same-second tie scans around its corrected estimate — 50 each side, so the
 * window is at most SAFE_LOG_BLOCK_RANGE (100) blocks wide and never exceeds the public RPC's
 * getLogs cap. Kept exported under its in-9 name.
 */
export const PLACEMENT_TIE_SPAN = SAFE_LOG_BLOCK_RANGE / 2n

/**
 * contextId → placement, recovered ONLY for records whose chain stamps share a second — the one
 * case where `createdAt` alone cannot order them (in-9 R-1). The event sits in a block whose
 * timestamp is that second; finding it costs at most three getBlock calls per tied second —
 * the shared head, an estimate probe, and one correction — because the observed rate between
 * two real blocks is a better ruler than viem's static blockTime (in-12 N-5: a chain running
 * 410–500 ms instead of its nominal 400, or recovering from a stall, threw the old estimate
 * tens of thousands of blocks off). The scan itself opens a window of at most 100 blocks around
 * the corrected center — never wider, so the public RPC's getLogs cap cannot refuse it —
 * and overlapping windows merge then re-slice into ≤100-block requests.
 *
 * Completeness is per tied second, not per record: if the scan finds only SOME of the records
 * sharing a second, that second keeps no placements at all — a found record ordering before an
 * unfound one on a partial answer is exactly the wrong-but-plausible outcome this exists to
 * prevent, so the whole tie falls back to the contextId order together.
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
  if (head === null || head.number === null) return map
  const lower = input.deployment.deploymentBlock
  const upper = head.number
  const clampBlock = (n: bigint): bigint => (n < lower ? lower : n > upper ? upper : n)
  const probe = async (n: bigint): Promise<{ number: bigint; timestamp: bigint } | null> => {
    try {
      const block = await input.client.getBlock({ blockNumber: clampBlock(n) })
      if (block === null || block.number === null) return null
      return { number: block.number, timestamp: block.timestamp }
    } catch {
      return null
    }
  }
  // The observed ms-per-block between two real blocks — undefined when the pair cannot say
  // (same block, same timestamp, or the rate comes out backwards: a stalled or rewound head).
  const rateBetween = (a: { number: bigint; timestamp: bigint }, b: { number: bigint; timestamp: bigint }): bigint | undefined => {
    if (a.number === b.number || a.timestamp === b.timestamp) return undefined
    const rate = ((a.timestamp - b.timestamp) * 1_000n) / (a.number - b.number)
    return rate > 0n ? rate : undefined
  }
  // The first estimate's ruler: the chain's declared blockTime when viem knows it (Monad is
  // 400 ms), else a one-block-per-second guess — the probes below correct whatever it misses.
  let guessedMsPerBlock = 1_000n
  try {
    const blockTime = chainFor(input.deployment.chainId).blockTime
    if (blockTime !== undefined && blockTime > 0) guessedMsPerBlock = BigInt(blockTime)
  } catch {
    // an unknown chain keeps the guess
  }
  const headPoint = { number: head.number, timestamp: head.timestamp }
  // One corrected center per tied second — the probes of different seconds run together.
  const groups = await Promise.all(
    [...input.tied].map(async ([second, contextIds]) => {
      const age = head.timestamp > second ? head.timestamp - second : 0n
      let center = headPoint.number - (age * 1_000n) / guessedMsPerBlock
      // Probe 1: the block the guess points at — its own timestamp is the ruler check.
      const first = await probe(center)
      if (first !== null) {
        if (first.timestamp === second) {
          center = first.number
        } else {
          const observed = rateBetween(headPoint, first)
          if (observed !== undefined) {
            center = first.number + ((second - first.timestamp) * 1_000n) / observed
          }
          // Probe 2: the corrected guess — landing on the second exactly pins the center;
          // otherwise one last correction by the LOCAL rate between the two probes, with no
          // third call — the ±50-block window absorbs whatever error is left.
          const second2 = await probe(center)
          if (second2 !== null) {
            if (second2.timestamp === second) {
              center = second2.number
            } else {
              const local = rateBetween(second2, first) ?? rateBetween(headPoint, second2)
              if (local !== undefined) center = second2.number + ((second - second2.timestamp) * 1_000n) / local
            }
          }
        }
      }
      return { second, contextIds, center: clampBlock(center) }
    }),
  )
  // One ≤100-block window per group center; adjacent windows merge, then every merged span is
  // served in ≤100-block requests so no provider cap can ever refuse a piece (in-12 N-5).
  const windows: { fromBlock: bigint; toBlock: bigint; contextIds: Set<string> }[] = []
  for (const group of groups) {
    const ids = new Set(group.contextIds.map((id) => id.toLowerCase()))
    const fromBlock = clampBlock(group.center - PLACEMENT_TIE_SPAN)
    const toBlock = clampBlock(group.center + PLACEMENT_TIE_SPAN - 1n)
    if (fromBlock > toBlock) continue
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
  const requests = windows.flatMap((window) =>
    blockWindows(window.fromBlock, window.toBlock, SAFE_LOG_BLOCK_RANGE).map((piece) => ({ piece, contextIds: window.contextIds })),
  )
  const pages = await Promise.all(
    requests.map(({ piece, contextIds }) =>
      input.client.getLogs({
        address: input.deployment.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { ...args, contextId: [...contextIds] },
        fromBlock: piece.fromBlock,
        toBlock: piece.toBlock,
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
  // A tie only orders by placement when EVERY record sharing its second was found — a partial
  // answer would let a found record beat an unfound one on the same stamp, so the whole second
  // drops to the contextId tie-break together (in-12 N-5).
  for (const group of groups) {
    const found = group.contextIds.filter((id) => map.has(id.toLowerCase()))
    if (found.length > 0 && found.length < group.contextIds.length) {
      for (const id of found) map.delete(id.toLowerCase())
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
