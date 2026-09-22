import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { writeJsonAtomic } from "./secure-fs.js"
import type { NonceStore } from "./stores.js"
import { REQUEST_WINDOW_SECONDS } from "./auth-pure.js"

// The pure half of request authentication — headers, canonical target, signature check — lives in
// auth-pure.js so the browser bundle can reach it through client.js without node:fs. Re-exported
// here so every importer of auth.js (app.ts, file-stores.ts, index.ts, tests) is unchanged.
export { AUTH_HEADERS, REQUEST_WINDOW_SECONDS, targetOf, assertAuthHeaderShape, authenticateRequest } from "./auth-pure.js"

interface SeenNonce {
  signer: Address
  nonce: Hex
  /** The request's signed timestamp, base-10 Unix seconds. */
  timestamp: string
}

/**
 * The file-backed NonceStore: a durable (signer, nonce) record for the §12.1 validity window. Each accepted pair is
 * written to disk, atomically and synchronously, before authentication returns, so neither a restart nor a crash can
 * forget a nonce that was accepted. Expired entries are deleted by `sweep`, which the scheduled job calls — never the
 * request path. An unreadable store fails closed rather than starting empty.
 */
export class ReplayGuard implements NonceStore {
  readonly #file: string
  readonly #seen = new Map<string, SeenNonce>()

  constructor(file: string) {
    this.#file = file
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of JSON.parse(text) as SeenNonce[]) this.#seen.set(ReplayGuard.#key(entry.signer, entry.nonce), entry)
  }

  static #key(signer: Address, nonce: Hex): string {
    return `${signer.toLowerCase()}:${nonce.toLowerCase()}`
  }

  /** Atomically checks and records a nonce; an entry already present means this exact request was seen before. */
  async consume(signer: Address, nonce: Hex, signedAt: bigint, now: bigint): Promise<void> {
    const key = ReplayGuard.#key(signer, nonce)
    if (this.#seen.has(key)) throw new MidaError("REPLAY", "request nonce was already used")
    this.#seen.set(key, { signer: signer.toLowerCase() as Address, nonce: nonce.toLowerCase() as Hex, timestamp: signedAt.toString(10) })
    writeJsonAtomic(dirname(this.#file), this.#file, [...this.#seen.values()])
  }

  /** Removes nonces whose signed timestamp is more than 60 seconds old; returns how many were deleted. */
  async sweep(now: bigint): Promise<number> {
    const before = this.#seen.size
    for (const [key, entry] of this.#seen) {
      if (BigInt(entry.timestamp) < now - REQUEST_WINDOW_SECONDS) this.#seen.delete(key)
    }
    const removed = before - this.#seen.size
    if (removed > 0) writeJsonAtomic(dirname(this.#file), this.#file, [...this.#seen.values()])
    return removed
  }
}
