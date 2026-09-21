import type { Address, Hex, OwnerAgentHistory } from "@mida/protocol"
import { getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import { capabilityRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"
import { getLogsChunked } from "./logs.js"
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

export async function ownerHistory(input: {
  client: HistoryClient
  deployment: Deployment
  owner: Address
  agentId: Hex
  toBlock?: bigint
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
  const scan = { address: input.deployment.capabilityRegistry, fromBlock: input.deployment.deploymentBlock, toBlock }
  const filter = { owner: input.owner, agentId: input.agentId }
  const logs = [
    ...(await getLogsChunked(input.client, { ...scan, event: CAPABILITY_REVOKED, args: filter })),
    ...(agentLevelRevokePossible ? await getLogsChunked(input.client, { ...scan, event: AGENT_REVOKED, args: filter }) : []),
  ]
  const previouslyRevoked = logs.some((log) => same(log.args.owner, input.owner) && same(log.args.agentId, input.agentId))
  return { owner: input.owner, agentId: input.agentId, previouslyRevoked, observedThroughBlock: toBlock }
}
