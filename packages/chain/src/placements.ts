import { getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import type { Address, Hex } from "@mida/protocol"
import { contextRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"
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
