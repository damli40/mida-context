import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { MidaError, assertHex, canonicalTarget, httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { isTypedDataSignedBy } from "@mida/grant-advisor"
import type { TypedDataDefinition } from "viem"
import { writeJsonAtomic } from "./secure-fs.js"

export const AUTH_HEADERS = {
  signer: "x-mida-signer",
  timestamp: "x-mida-timestamp",
  nonce: "x-mida-nonce",
  signature: "x-mida-signature",
} as const

export const REQUEST_WINDOW_SECONDS = 60n

/** Builds the §12.1 canonical target from a URL: path plus query sorted by key. Repeated keys are rejected. */
export function targetOf(url: URL): string {
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) throw new MidaError("AUTH_INVALID", `query parameter ${key} is repeated`)
    query[key] = value
  }
  return canonicalTarget(url.pathname, query)
}

interface SeenNonce {
  signer: Address
  nonce: Hex
  /** The request's signed timestamp, base-10 Unix seconds. */
  timestamp: string
}

/**
 * Durable (signer, nonce) record for the §12.1 validity window. Each accepted pair is written to disk, atomically and
 * synchronously, before authentication returns, so neither a restart nor a crash can forget a nonce that was accepted.
 * An entry is pruned once its signed timestamp is more than 60 seconds old, because the timestamp check alone then
 * rejects the request. An unreadable store fails closed rather than starting empty.
 */
export class ReplayGuard {
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

  consume(signer: Address, nonce: Hex, signedAt: bigint, now: bigint): void {
    for (const [key, entry] of this.#seen) {
      if (BigInt(entry.timestamp) < now - REQUEST_WINDOW_SECONDS) this.#seen.delete(key)
    }
    const key = ReplayGuard.#key(signer, nonce)
    if (this.#seen.has(key)) throw new MidaError("REPLAY", "request nonce was already used")
    this.#seen.set(key, { signer: signer.toLowerCase() as Address, nonce: nonce.toLowerCase() as Hex, timestamp: signedAt.toString(10) })
    writeJsonAtomic(dirname(this.#file), this.#file, [...this.#seen.values()])
  }
}

/**
 * §12.1 authentication: an EIP-712 MidaHttpRequestV1 signature over method, canonical target, raw body bytes,
 * timestamp and nonce, under the "Mida Context API" domain for this chain and registry. Returns the proven signer.
 * Authorization happens afterwards and separately.
 */
export function authenticateRequest(input: {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array
  chainId: bigint
  capabilityRegistry: Address
  now: bigint
  replay: ReplayGuard
}): Address {
  const signer = input.headers.get(AUTH_HEADERS.signer)
  const timestamp = input.headers.get(AUTH_HEADERS.timestamp)
  const nonce = input.headers.get(AUTH_HEADERS.nonce)
  const signature = input.headers.get(AUTH_HEADERS.signature)
  if (signer === null || timestamp === null || nonce === null || signature === null) {
    throw new MidaError("AUTH_INVALID", "missing request authentication headers")
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer) || !/^(0|[1-9][0-9]*)$/.test(timestamp) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new MidaError("AUTH_INVALID", "malformed request authentication headers")
  }
  try {
    assertHex(nonce, 32)
  } catch {
    throw new MidaError("AUTH_INVALID", "nonce must be lowercase bytes32")
  }
  const signedAt = BigInt(timestamp)
  const skew = input.now > signedAt ? input.now - signedAt : signedAt - input.now
  if (skew > REQUEST_WINDOW_SECONDS) throw new MidaError("AUTH_INVALID", "request timestamp is outside the 60 second window")

  const typedData = httpRequestTypedData({
    chainId: input.chainId,
    capabilityRegistry: input.capabilityRegistry,
    signer: signer as Address,
    method: input.method,
    target: targetOf(input.url),
    body: input.body,
    timestamp: signedAt,
    nonce: nonce as Hex,
  })
  if (!isTypedDataSignedBy(typedData as unknown as TypedDataDefinition, signature as Hex, signer as Address)) {
    throw new MidaError("AUTH_INVALID", "request signature does not match the signed method, target, body and time")
  }
  input.replay.consume(signer as Address, nonce as Hex, signedAt, input.now)
  return signer.toLowerCase() as Address
}
