import { closeSync, openSync } from "node:fs"
import { MidaError } from "@mida/protocol"
import type { AccessRequest, Hex } from "@mida/protocol"
import type { AccessRequestStore, StoredAccessRequest } from "@mida/sdk"
import type { MidaHome } from "./home.js"

/**
 * Pending approval requests on disk, one file per request, so a restart between "agent asked" and "owner approved"
 * loses nothing. "Consumed" is a marker file created with the exclusive flag: the operating system lets exactly one
 * creator win, which keeps the SDK's "a request completes at most once" rule true across processes.
 */
export class FileAccessRequestStore implements AccessRequestStore {
  readonly #home: MidaHome
  readonly #folder: string

  constructor(home: MidaHome, agentName: string) {
    if (!/^[a-z0-9-]+$/.test(agentName)) throw new Error(`bad agent name: ${agentName}`)
    this.#home = home
    this.#folder = `requests/${agentName}`
  }

  #file(requestId: Hex): string {
    if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) throw new MidaError("INVALID_WIRE", "requestId must be 32 bytes of hex")
    return `${this.#folder}/${requestId.toLowerCase()}.json`
  }

  async save(request: AccessRequest): Promise<void> {
    const file = this.#file(request.requestId)
    if (this.#home.has(file)) throw new MidaError("REPLAY", "requestId was already used")
    this.#home.writeSecretJson(file, request)
  }

  async load(requestId: Hex): Promise<StoredAccessRequest | undefined> {
    const file = this.#file(requestId)
    const request = this.#home.readJson<AccessRequest>(file)
    if (request === undefined) return undefined
    return { request, consumed: this.#home.has(`${file}.consumed`) }
  }

  async markConsumed(requestId: Hex): Promise<void> {
    const file = this.#file(requestId)
    if (!this.#home.has(file)) throw new MidaError("NOT_FOUND", "no stored request for this requestId")
    try {
      closeSync(openSync(this.#home.path(`${file}.consumed`), "wx", 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MidaError("REQUEST_CONSUMED", "this requestId was already completed")
      throw error
    }
  }
}
