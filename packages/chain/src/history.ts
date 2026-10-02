import type { Address, Hex, OwnerAgentHistory } from "@mida/protocol"
import { capabilityRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"

/** How many getCapability reads run at once — the shared transport caps requests at 10 a second per RPC origin. */
const CAPABILITY_READ_CONCURRENCY = 8

/** The contract views and the head height ownerHistory needs — viem's PublicClient is one. There is no log API: the check never scans events. */
export interface HistoryClient {
  getBlockNumber(): Promise<bigint>
  readContract(parameters: { address: Address; abi: typeof capabilityRegistryAbi; functionName: "agentEpoch" | "activeCapabilityIds"; args: readonly [Address, Hex] }): Promise<unknown>
  readContract(parameters: { address: Address; abi: typeof capabilityRegistryAbi; functionName: "getCapability"; args: readonly [Hex] }): Promise<unknown>
}

/**
 * This machine's memory of the last check for one (owner, agentId) pair (R4-9) — not where a
 * scan stopped, because there is no scan. `observedThroughBlock` records the head that check ran
 * at, and `previouslyRevoked` is a saved yes: nothing on the chain un-revokes, so a remembered
 * yes keeps answering. A cache of facts, never an authority: the caller supplies load/save (the
 * CLI keeps it at `state/history/<agentId>.json`, keyed on chain id and registry) and a missing,
 * malformed or wrong-chain answer from load() is ignored rather than guessed over. The file
 * format is unchanged, so files written by older builds still load.
 */
export interface HistoryScanCursor {
  load(): { observedThroughBlock: bigint; previouslyRevoked: boolean } | undefined | Promise<{ observedThroughBlock: bigint; previouslyRevoked: boolean } | undefined>
  save(state: { observedThroughBlock: bigint; previouslyRevoked: boolean }): void | Promise<void>
}

/**
 * The PREVIOUSLY_REVOKED input, read from contract state with no log scan. Three sources: the
 * owner-agent revoke counter (agentEpoch above 0: a whole-agent revoke, exact and permanent); the
 * revoked flag of every capability still in the agent's list (a single-capability revoke stays
 * listed until the next grant compacts the list); and this machine's saved yes from an earlier
 * check. Known limit: a single capability revoked and later compacted away by a new grant is not
 * seen from a machine that never recorded the yes. In the shipped commands only `mida migrate`
 * revokes a single capability; `mida revoke` revokes the whole agent. A failed read throws; it
 * never defaults to "not revoked". Never consults reputation or access telemetry.
 * A second limit: a capability revoked after it had expired and been compacted away is never seen;
 * no shipped command does that. After mida migrate, an agent whose replay-only capability was
 * revoked reads as revoked on the machine that ran it, until the next grant compacts the list.
 */
export async function ownerHistory(input: {
  client: HistoryClient
  deployment: Deployment
  owner: Address
  agentId: Hex
  toBlock?: bigint
  cursor?: HistoryScanCursor
}): Promise<OwnerAgentHistory> {
  const toBlock = input.toBlock ?? (await input.client.getBlockNumber())
  const answer = (previouslyRevoked: boolean): OwnerAgentHistory => ({
    owner: input.owner,
    agentId: input.agentId,
    previouslyRevoked,
    observedThroughBlock: toBlock,
  })
  // agentEpoch(owner, agentId) starts at 0, every whole-agent revoke adds 1
  // (Revocations.revokeAgentAndRotate), and nothing lowers it — a counter above 0 IS the answer,
  // in one read. A failed or malformed read throws: it never defaults to "not revoked".
  const epoch = await input.client.readContract({
    address: input.deployment.capabilityRegistry,
    abi: capabilityRegistryAbi,
    functionName: "agentEpoch",
    args: [input.owner, input.agentId],
  })
  if (typeof epoch !== "bigint") throw new Error("agentEpoch did not return an integer")
  if (epoch > 0n) return answer(true)
  // Epoch 0 rules the whole-agent revoke out. The agent's list is empty only before its first
  // grant or after an epoch-bumping revoke — _storeCapability compacts and then pushes, so a
  // granted pair never reads empty — and nothing that was never granted could have been revoked.
  const ids = await input.client.readContract({
    address: input.deployment.capabilityRegistry,
    abi: capabilityRegistryAbi,
    functionName: "activeCapabilityIds",
    args: [input.owner, input.agentId],
  })
  if (!Array.isArray(ids)) throw new Error("activeCapabilityIds did not return a list")
  if (ids.length === 0) {
    await input.cursor?.save({ observedThroughBlock: toBlock, previouslyRevoked: false })
    return answer(false)
  }
  // The second source: a single-capability revoke sets the record's revoked flag but leaves the
  // id listed until the next grant's _compact removes it — so every listed id's record is read.
  // A failed read or a non-record answer throws; it never counts as "not revoked".
  let revoked = false
  let next = 0
  const readOne = async (): Promise<void> => {
    while (!revoked && next < ids.length) {
      const id = ids[next] as Hex
      next += 1
      const capability = await input.client.readContract({
        address: input.deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName: "getCapability",
        args: [id],
      })
      if (capability === null || typeof capability !== "object" || typeof (capability as { revoked?: unknown }).revoked !== "boolean") {
        throw new Error("getCapability did not return a capability record")
      }
      if ((capability as { revoked: boolean }).revoked) revoked = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(CAPABILITY_READ_CONCURRENCY, ids.length) }, () => readOne()))
  if (revoked) {
    await input.cursor?.save({ observedThroughBlock: toBlock, previouslyRevoked: true })
    return answer(true)
  }
  // The third source is this machine's memory of an earlier yes — nothing un-revokes, so a saved
  // yes keeps answering even after the grant that compacted the revoked id away. A cursor ahead
  // of the head is impossible for an honest file — wrong chain, a redeploy or tampering — so its
  // block number is not trusted; but a remembered yes is never discarded, because no lagging or
  // ahead-of-head chain answer can un-revoke (R5-7).
  const cursor = await input.cursor?.load()
  if (cursor?.previouslyRevoked === true) {
    await input.cursor?.save({ observedThroughBlock: toBlock, previouslyRevoked: true })
    return answer(true)
  }
  await input.cursor?.save({ observedThroughBlock: toBlock, previouslyRevoked: false })
  return answer(false)
}
