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
export async function ownerHistory(input: {
  client: LogClient
  deployment: Deployment
  owner: Address
  agentId: Hex
  toBlock?: bigint
}): Promise<OwnerAgentHistory> {
  const toBlock = input.toBlock ?? (await input.client.getBlockNumber())
  const scan = { address: input.deployment.capabilityRegistry, fromBlock: input.deployment.deploymentBlock, toBlock }
  const filter = { owner: input.owner, agentId: input.agentId }
  const logs = [
    ...(await getLogsChunked(input.client, { ...scan, event: CAPABILITY_REVOKED, args: filter })),
    ...(await getLogsChunked(input.client, { ...scan, event: AGENT_REVOKED, args: filter })),
  ]
  const previouslyRevoked = logs.some((log) => same(log.args.owner, input.owner) && same(log.args.agentId, input.agentId))
  return { owner: input.owner, agentId: input.agentId, previouslyRevoked, observedThroughBlock: toBlock }
}
