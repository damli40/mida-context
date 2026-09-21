import type { Address, Hex, OwnerAgentHistory } from "@mida/protocol"
import { getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"
import { blockWindows, getLogsChunked } from "./logs.js"
import type { LogClient } from "./logs.js"

const CAPABILITY_REVOKED = getAbiItem({ abi: capabilityRegistryAbi, name: "CapabilityRevoked" }) as AbiEvent
const AGENT_REVOKED = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase()

/**
 * §14.6 PREVIOUSLY_REVOKED input. Built only from CapabilityRevoked and AgentRevoked events for exactly
 * this (owner, agentId) pair. Topic filters narrow the query; the explicit comparison below guards against
 * a provider that ignores them. Never consults reputation or access telemetry.
 */
/** A log client that can also read a contract view — viem's PublicClient is one. */
export interface HistoryClient extends LogClient {
  readContract?(parameters: { address: Address; abi: typeof capabilityRegistryAbi; functionName: "agentEpoch"; args: readonly [Address, Hex] }): Promise<unknown>
}

/**
 * Where the last successful scan stopped for one (owner, agentId) pair (R4-9). A cache of chain
 * facts, never an authority: the caller supplies load/save (the CLI keeps it at
 * `state/history/<agentId>.json`, keyed on chain id and registry) and a missing, malformed or
 * wrong-chain answer from load() means a full scan, not a guess. `previouslyRevoked` is sticky —
 * nothing on the chain un-revokes — so a saved true answers without any scan at all.
 */
export interface HistoryScanCursor {
  load(): { observedThroughBlock: bigint; previouslyRevoked: boolean } | undefined | Promise<{ observedThroughBlock: bigint; previouslyRevoked: boolean } | undefined>
  save(state: { observedThroughBlock: bigint; previouslyRevoked: boolean }): void | Promise<void>
}

export async function ownerHistory(input: {
  client: HistoryClient
  deployment: Deployment
  owner: Address
  agentId: Hex
  toBlock?: bigint
  cursor?: HistoryScanCursor
  /** Called once, before the log scan starts, with the number of requests it will take. */
  onScan?: (requests: number) => void
}): Promise<OwnerAgentHistory> {
  const toBlock = input.toBlock ?? (await input.client.getBlockNumber())
  // Ask the contract before scanning anything. `agentEpoch(owner, agentId)` starts at 0, every
  // agent-level revoke adds 1, and nothing lowers it — so a value above 0 IS the answer, in one
  // request. (Live, Sep 21: the scan alone outlasted the 10-minute request window, so re-approving
  // a revoked agent could never succeed.) A failed read throws: it never defaults to "not revoked".
  let agentLevelRevokePossible = true
  if (input.client.readContract !== undefined) {
    const epoch = await input.client.readContract({
      address: input.deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "agentEpoch",
      args: [input.owner, input.agentId],
    })
    if (typeof epoch !== "bigint") throw new Error("agentEpoch did not return an integer")
    if (epoch > 0n) return { owner: input.owner, agentId: input.agentId, previouslyRevoked: true, observedThroughBlock: toBlock }
    // Counter 0: no AgentRevoked event can exist for this pair. Only a single-capability revoke,
    // which does not move the counter, could — so that one event still has to be scanned for.
    agentLevelRevokePossible = false
  }
  // The cursor is consulted only AFTER the contract answered: an epoch above 0 already proved a
  // revoke with one request, and no cache should shadow that. A saved true is sticky — revoked is
  // forever — and a position at or past the head leaves nothing new to scan.
  const cursor = await input.cursor?.load()
  if (cursor !== undefined) {
    if (cursor.previouslyRevoked) {
      return { owner: input.owner, agentId: input.agentId, previouslyRevoked: true, observedThroughBlock: toBlock }
    }
    if (cursor.observedThroughBlock >= toBlock) {
      return { owner: input.owner, agentId: input.agentId, previouslyRevoked: false, observedThroughBlock: toBlock }
    }
  }
  const fromBlock =
    cursor !== undefined && cursor.observedThroughBlock + 1n > input.deployment.deploymentBlock
      ? cursor.observedThroughBlock + 1n
      : input.deployment.deploymentBlock
  const filter = { owner: input.owner, agentId: input.agentId }
  input.onScan?.(blockWindows(fromBlock, toBlock).length)
  const logs = [
    ...(await getLogsChunked(input.client, { address: input.deployment.capabilityRegistry, fromBlock, toBlock, event: CAPABILITY_REVOKED, args: filter })),
    ...(agentLevelRevokePossible ? await getLogsChunked(input.client, { address: input.deployment.capabilityRegistry, fromBlock, toBlock, event: AGENT_REVOKED, args: filter }) : []),
  ]
  const previouslyRevoked = logs.some((log) => same(log.args.owner, input.owner) && same(log.args.agentId, input.agentId))
  // Only a complete scan may move the cursor — a failed window threw above, so what is saved here
  // always covers every block up to toBlock.
  await input.cursor?.save({ observedThroughBlock: toBlock, previouslyRevoked })
  return { owner: input.owner, agentId: input.agentId, previouslyRevoked, observedThroughBlock: toBlock }
}
