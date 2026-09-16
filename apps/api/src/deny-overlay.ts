import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { RegistryReader } from "./chain-views.js"

export type RevocationTarget = { kind: "capability"; capabilityId: Hex } | { kind: "agent"; agentId: Hex }

export type DenyState = "active" | "anchored" | "cancelled"

export interface RevocationIntent {
  id: Hex
  owner: Address
  target: RevocationTarget
  state: DenyState
  /** Owner-agent epoch when the intent was recorded; an agent revocation is anchored once the chain epoch exceeds it. */
  agentEpochAtIntent: string | null
  /** Base-10 uint256 consumed by a successful cancellation; null once consumed or no longer cancellable. */
  cancellationNonce: string | null
}

/**
 * §12.5 fast revocation overlay, persisted as one JSON file. Exactly three transitions exist:
 *   active → anchored   matching Monad revocation observed (reconcile)
 *   active → active     transaction failed, missing or reorged out (no timeout ever clears a deny)
 *   active → cancelled  fresh owner P256-approved cancellation (cancel)
 * It can only reduce authority: `effectiveAllowed = currentlyAllowedByMonad AND NOT localDeny`.
 */
export class DenyOverlay {
  readonly #file: string
  #intents: RevocationIntent[]

  constructor(file: string) {
    this.#file = file
    try {
      this.#intents = JSON.parse(readFileSync(file, "utf8")) as RevocationIntent[]
    } catch {
      this.#intents = []
    }
  }

  list(): readonly RevocationIntent[] {
    return this.#intents.map((intent) => ({ ...intent }))
  }

  get(id: Hex): RevocationIntent | undefined {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    return intent === undefined ? undefined : { ...intent }
  }

  create(owner: Address, target: RevocationTarget, agentEpochAtIntent: bigint | null): RevocationIntent {
    const intent: RevocationIntent = {
      id: hexOf(randomBytes(32)),
      owner: owner.toLowerCase() as Address,
      target:
        target.kind === "capability"
          ? { kind: "capability", capabilityId: target.capabilityId.toLowerCase() as Hex }
          : { kind: "agent", agentId: target.agentId.toLowerCase() as Hex },
      state: "active",
      agentEpochAtIntent: agentEpochAtIntent === null ? null : agentEpochAtIntent.toString(10),
      cancellationNonce: BigInt(hexOf(randomBytes(32))).toString(10),
    }
    this.#intents.push(intent)
    this.#save()
    return { ...intent }
  }

  /** True when an active deny matches this owner and either this agent relationship or this exact capability. */
  denies(input: { owner: Address; agentId: Hex; capabilityId: Hex }): boolean {
    const owner = input.owner.toLowerCase()
    return this.#intents.some(
      (intent) =>
        intent.state === "active" &&
        intent.owner === owner &&
        (intent.target.kind === "agent"
          ? intent.target.agentId === input.agentId.toLowerCase()
          : intent.target.capabilityId === input.capabilityId.toLowerCase()),
    )
  }

  /**
   * For wrap publication, which names no capability: an active deny on this agent, or on any of its capabilities in
   * this namespace, blocks publication.
   */
  async deniesRelationship(reader: RegistryReader, input: { owner: Address; agentId: Hex; namespaceId: Hex }): Promise<boolean> {
    const owner = input.owner.toLowerCase()
    const agentId = input.agentId.toLowerCase()
    for (const intent of this.#intents) {
      if (intent.state !== "active" || intent.owner !== owner) continue
      if (intent.target.kind === "agent") {
        if (intent.target.agentId === agentId) return true
        continue
      }
      const capability = await reader.getCapability(intent.target.capabilityId)
      if (capability !== null && capability.agentId === agentId && capability.namespaceId === input.namespaceId.toLowerCase()) return true
    }
    return false
  }

  /** active → anchored only when Monad shows the matching revocation. Failed or missing transactions leave it active. */
  async reconcile(reader: RegistryReader): Promise<void> {
    let changed = false
    for (const intent of this.#intents) {
      if (intent.state !== "active") continue
      const anchored =
        intent.target.kind === "capability"
          ? (await reader.getCapability(intent.target.capabilityId))?.revoked === true
          : (await reader.agentEpoch(intent.owner, intent.target.agentId)) > BigInt(intent.agentEpochAtIntent ?? "0")
      if (anchored) {
        intent.state = "anchored"
        intent.cancellationNonce = null
        changed = true
      }
    }
    if (changed) this.#save()
  }

  /** active → cancelled. The caller must already have verified a fresh P256 assertion over this nonce. */
  cancel(id: Hex, owner: Address, nonce: bigint): RevocationIntent {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    if (intent === undefined || intent.owner !== owner.toLowerCase()) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null || BigInt(intent.cancellationNonce) !== nonce) {
      throw new MidaError("REPLAY", "revocation intent is not cancellable with this nonce")
    }
    intent.state = "cancelled"
    intent.cancellationNonce = null
    this.#save()
    return { ...intent }
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.#intents, null, 2))
    renameSync(temporary, this.#file)
  }
}
