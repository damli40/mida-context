import { MidaError } from "@mida/protocol"
import type { AccessRequest, Hex } from "@mida/protocol"

export interface StoredAccessRequest {
  request: AccessRequest
  consumed: boolean
}

/** Where `createAccessRequest` persists originals by requestId so `completeAccessRequest` can check against them (§13.3). */
export interface AccessRequestStore {
  save(request: AccessRequest): Promise<void>
  load(requestId: Hex): Promise<StoredAccessRequest | undefined>
  markConsumed(requestId: Hex): Promise<void>
}

/**
 * In-memory store for Project 1. A consumed entry is kept for the life of the process so a requestId can never be
 * completed twice. Production agents persist this across restarts.
 */
export class MemoryAccessRequestStore implements AccessRequestStore {
  readonly #entries = new Map<string, StoredAccessRequest>()

  async save(request: AccessRequest): Promise<void> {
    const key = request.requestId.toLowerCase()
    if (this.#entries.has(key)) throw new MidaError("REPLAY", "requestId was already used")
    this.#entries.set(key, { request, consumed: false })
  }

  async load(requestId: Hex): Promise<StoredAccessRequest | undefined> {
    const entry = this.#entries.get(requestId.toLowerCase())
    return entry === undefined ? undefined : { request: entry.request, consumed: entry.consumed }
  }

  async markConsumed(requestId: Hex): Promise<void> {
    const entry = this.#entries.get(requestId.toLowerCase())
    if (entry === undefined) throw new MidaError("NOT_FOUND", "no stored request for this requestId")
    entry.consumed = true
  }
}
