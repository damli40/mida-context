import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { writeJsonAtomic } from "./secure-fs.js"
import type { RegistryReader } from "./chain-views.js"
import type { DenyStore } from "./stores.js"

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

/** The persisted shape `denies`, `reconcileOwner` and `cancel` dereference; a malformed entry fails construction. */
export function isRevocationIntent(value: unknown): value is RevocationIntent {
  if (value === null || typeof value !== "object") return false
  const intent = value as RevocationIntent
  const target = intent.target as RevocationTarget | undefined
  const targetOk =
    target !== null &&
    typeof target === "object" &&
    ((target.kind === "capability" && typeof target.capabilityId === "string") ||
      (target.kind === "agent" && typeof target.agentId === "string"))
  return (
    typeof intent.id === "string" &&
    typeof intent.owner === "string" &&
    targetOk &&
    (intent.state === "active" || intent.state === "anchored" || intent.state === "cancelled") &&
    (intent.agentEpochAtIntent === null || typeof intent.agentEpochAtIntent === "string") &&
    (intent.cancellationNonce === null || typeof intent.cancellationNonce === "string")
  )
}

/**
 * The file-backed DenyStore: the revocation intents as one JSON file, kept in memory once loaded and rewritten
 * atomically on every mutation. An unreadable or malformed file fails closed at construction: starting empty would
 * silently restore authority a pending deny removed, which §12.5 forbids. Only a missing file means a fresh start.
 */
export class FileDenyStore implements DenyStore {
  readonly #file: string
  #intents: RevocationIntent[]

  constructor(file: string) {
    this.#file = file
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#intents = []
        return
      }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || !parsed.every(isRevocationIntent)) {
      throw new MidaError("INVALID_WIRE", `${file} is not a revocation intent array`)
    }
    this.#intents = parsed
  }

  async list(): Promise<RevocationIntent[]> {
    return this.#intents.map((intent) => ({ ...intent }))
  }

  async get(id: Hex): Promise<RevocationIntent | undefined> {
    const intent = this.#intents.find((candidate) => candidate.id === id.toLowerCase())
    return intent === undefined ? undefined : { ...intent }
  }

  async insert(intent: RevocationIntent): Promise<void> {
    this.#intents.push({ ...intent })
    this.#save()
  }

  async update(intent: RevocationIntent): Promise<void> {
    const index = this.#intents.findIndex((candidate) => candidate.id === intent.id.toLowerCase())
    if (index === -1) throw new MidaError("NOT_FOUND", "revocation intent not found")
    this.#intents[index] = { ...intent }
    this.#save()
  }

  #save(): void {
    writeJsonAtomic(dirname(this.#file), this.#file, this.#intents)
  }
}

/**
 * §12.5 fast revocation overlay over a DenyStore. Exactly three transitions exist:
 *   active → anchored   matching Monad revocation observed (reconcile)
 *   active → active     transaction failed, missing or reorged out (no timeout ever clears a deny)
 *   active → cancelled  fresh owner P256-approved cancellation (cancel)
 * It can only reduce authority: `effectiveAllowed = currentlyAllowedByMonad AND NOT localDeny`.
 */
export class DenyOverlay {
  readonly #store: DenyStore

  constructor(store: DenyStore | string) {
    this.#store = typeof store === "string" ? new FileDenyStore(store) : store
  }

  async list(): Promise<RevocationIntent[]> {
    return this.#store.list()
  }

  async get(id: Hex): Promise<RevocationIntent | undefined> {
    return this.#store.get(id)
  }

  async create(owner: Address, target: RevocationTarget, agentEpochAtIntent: bigint | null): Promise<RevocationIntent> {
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
    await this.#store.insert(intent)
    return { ...intent }
  }

  /** True when an active deny matches this owner and either this agent relationship or this exact capability. */
  async denies(input: { owner: Address; agentId: Hex; capabilityId: Hex }): Promise<boolean> {
    const owner = input.owner.toLowerCase()
    for (const intent of await this.#store.list()) {
      if (
        intent.state === "active" &&
        intent.owner === owner &&
        (intent.target.kind === "agent"
          ? intent.target.agentId === input.agentId.toLowerCase()
          : intent.target.capabilityId === input.capabilityId.toLowerCase())
      ) {
        return true
      }
    }
    return false
  }

  /**
   * For wrap publication, which names no capability: an active deny on this agent, or on any of its capabilities in
   * this namespace, blocks publication.
   */
  async deniesRelationship(reader: RegistryReader, input: { owner: Address; agentId: Hex; namespaceId: Hex }): Promise<boolean> {
    const owner = input.owner.toLowerCase()
    const agentId = input.agentId.toLowerCase()
    for (const intent of await this.#store.list()) {
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

  /**
   * The only reconcile: the active → anchored pass narrowed to one owner (M3-D6). Every request is
   * about exactly one owner, and its chain-read budget must not be spent on other owners' intents —
   * reconcile only what the caller may see.
   */
  async reconcileOwner(reader: RegistryReader, owner: Address): Promise<void> {
    const lower = owner.toLowerCase()
    for (const intent of await this.#store.list()) {
      if (intent.owner !== lower) continue
      await this.#reconcileIntent(reader, intent)
    }
  }

  async #reconcileIntent(reader: RegistryReader, intent: RevocationIntent): Promise<void> {
    if (intent.state !== "active") return
    const anchored =
      intent.target.kind === "capability"
        ? (await reader.getCapability(intent.target.capabilityId))?.revoked === true
        : (await reader.agentEpoch(intent.owner, intent.target.agentId)) > BigInt(intent.agentEpochAtIntent ?? "0")
    if (anchored) await this.#store.update({ ...intent, state: "anchored", cancellationNonce: null })
  }

  /**
   * Re-arms an active intent with a fresh cancellation nonce and retires the old ticket (M3-D4).
   * The creation response is the only other place a nonce leaves the store; an owner clearing a
   * stale deny it did not just stage — a revoke that failed on an earlier run — needs a new one.
   * Anything but active refuses: an anchored intent must never be re-armed.
   */
  async reissueNonce(id: Hex, owner: Address): Promise<RevocationIntent> {
    const intent = await this.#store.get(id)
    if (intent === undefined || intent.owner !== owner.toLowerCase()) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active") throw new MidaError("REPLAY", "revocation intent is not reissuable")
    const reissued: RevocationIntent = { ...intent, cancellationNonce: BigInt(hexOf(randomBytes(32))).toString(10) }
    await this.#store.update(reissued)
    return { ...reissued }
  }

  /** active → cancelled. The caller must already have verified a fresh P256 assertion over this nonce. */
  async cancel(id: Hex, owner: Address, nonce: bigint): Promise<RevocationIntent> {
    const intent = await this.#store.get(id)
    if (intent === undefined || intent.owner !== owner.toLowerCase()) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null || BigInt(intent.cancellationNonce) !== nonce) {
      throw new MidaError("REPLAY", "revocation intent is not cancellable with this nonce")
    }
    const cancelled: RevocationIntent = { ...intent, state: "cancelled", cancellationNonce: null }
    await this.#store.update(cancelled)
    return { ...cancelled }
  }
}
