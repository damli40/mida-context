import { MidaError } from "@mida/protocol"
import type { Address, AgentRecord, Hex } from "@mida/protocol"
import type { CapabilityView, RegistryReader } from "./chain-views.js"
import type { DenyOverlay } from "./deny-overlay.js"

export interface AgentAuthorization {
  agentId: Hex
  agent: AgentRecord
  capability: CapabilityView
  now: bigint
}

/**
 * §12.1 normative, fail-closed validation order for every agent operation. Step 1 (authentication) has already
 * produced `signer`. Each later step stops at the first failure with its §12.6 code. A final exact `hasAuthority`
 * read keeps the API chain-bounded: it can deny sooner than Monad, never allow what Monad does not.
 */
export async function authorizeAgent(input: {
  reader: RegistryReader
  overlay: DenyOverlay
  signer: Address
  owner: Address
  capabilityId: Hex | undefined
  namespaceId: Hex
  permission: number
  agentKeyVersion?: number
}): Promise<AgentAuthorization> {
  const owner = input.owner.toLowerCase() as Address
  const namespaceId = input.namespaceId.toLowerCase() as Hex

  // 2. resolve active agent identity
  const agentId = await input.reader.agentIdOfSigner(input.signer)
  if (agentId === null) throw new MidaError("CAPABILITY_DENIED", "signer is not the current signer of a registered agent")
  const agent = await input.reader.getAgent(agentId)
  if (agent === null || !agent.active) throw new MidaError("CAPABILITY_DENIED", "agent is not active")

  // 3. load the exact capability; require it exists for this owner and agent
  if (input.capabilityId === undefined) throw new MidaError("CAPABILITY_DENIED", "request names no capability")
  const capability = await input.reader.getCapability(input.capabilityId)
  if (capability === null || capability.owner !== owner || capability.agentId !== agentId) {
    throw new MidaError("CAPABILITY_DENIED", "capability does not exist for this owner and agent")
  }

  // 4. local deny, on-chain revocation, agent-epoch mismatch
  await input.overlay.reconcile(input.reader)
  if (input.overlay.denies({ owner, agentId, capabilityId: input.capabilityId })) {
    throw new MidaError("CAPABILITY_REVOKED", "owner revocation intent is active")
  }
  if (capability.revoked) throw new MidaError("CAPABILITY_REVOKED", "capability was revoked on-chain")
  if ((await input.reader.agentEpoch(owner, agentId)) !== capability.agentEpoch) {
    throw new MidaError("CAPABILITY_REVOKED", "owner revoked every capability of this agent")
  }

  // 5. expiry, inclusive at expiresAt, on chain time (same boundary as CapabilityStore._isLive)
  const now = await input.reader.now()
  if (capability.expiresAt !== 0n && now >= capability.expiresAt) throw new MidaError("CAPABILITY_EXPIRED", "capability expired")

  // 6. exact namespace
  if (capability.namespaceId !== namespaceId) throw new MidaError("CAPABILITY_DENIED", "capability is for another namespace")

  // 7. permission bit
  if ((capability.permissions & input.permission) !== input.permission) {
    throw new MidaError("CAPABILITY_DENIED", "capability lacks the requested permission")
  }

  // 8. current registered encryption key version, where the operation involves one
  if (input.agentKeyVersion !== undefined && input.agentKeyVersion !== agent.encryptionKeyVersion) {
    throw new MidaError("WRAP_KEY_VERSION_MISMATCH", "encryption key version is not the agent's current version")
  }

  if (!(await input.reader.hasAuthority(owner, agentId, namespaceId, input.permission, 0))) {
    throw new MidaError("CAPABILITY_DENIED", "Monad does not currently authorize this operation")
  }
  return { agentId, agent, capability, now }
}
