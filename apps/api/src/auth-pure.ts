import { MidaError, assertHex, canonicalTarget, httpRequestTypedData } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { isTypedDataSignedBy } from "@mida/grant-advisor"
import type { TypedDataDefinition } from "viem"
import type { NonceStore } from "./stores.js"

/**
 * The request-authentication pieces that touch no Node API — everything in `auth.ts` minus the
 * file-backed ReplayGuard. They live in their own module so the owner-page bundle can reach them
 * through `client.js` without pulling `node:fs` into a browser build: `client.js` imports from
 * here, `auth.js` keeps ReplayGuard and re-exports this module so every existing importer of
 * `auth.js` sees the same names it always did.
 */
export const AUTH_HEADERS = {
  signer: "x-mida-signer",
  timestamp: "x-mida-timestamp",
  nonce: "x-mida-nonce",
  signature: "x-mida-signature",
} as const

/**
 * in-9 R-5, hardened in in-12 N-10: an optional token naming the ONE logical read operation a
 * request belongs to (a handoff, a whats-new refresh). The server mints it — a random id, an
 * expiry and an HMAC over the requester's own signer — and hands it out on every authenticated
 * response, so the client only ever replays what it was issued. Requests carrying the same token
 * share the answers their identical NON-AUTHORIZATION chain reads already paid for; a request
 * without it, or with a forged or expired one, is simply unscoped — the token names a cache
 * bucket, never an authorization, and authorization answers are never memoized across requests.
 */
export const READ_SCOPE_HEADER = "x-mida-read-scope"

/** The token shape the server honors: `0x` + 64-hex random id, base-36 expiry ms, 64-hex HMAC. */
export const READ_SCOPE_TOKEN_PATTERN = /^0x[0-9a-f]{64}\.[0-9a-z]+\.[0-9a-f]{64}$/

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

/**
 * The presence and format checks on the four authentication headers — everything that can be decided without
 * touching state. Runs before body parsing and long before signature verification: a request whose headers
 * are missing or malformed never costs a nonce record, a store read or a chain read.
 */
export function assertAuthHeaderShape(headers: Headers): void {
  const signer = headers.get(AUTH_HEADERS.signer)
  const timestamp = headers.get(AUTH_HEADERS.timestamp)
  const nonce = headers.get(AUTH_HEADERS.nonce)
  const signature = headers.get(AUTH_HEADERS.signature)
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
}

/**
 * §12.1 authentication: an EIP-712 MidaHttpRequestV1 signature over method, canonical target, raw body bytes,
 * timestamp and nonce, under the "Mida Context API" domain for this chain and registry. Returns the proven signer.
 * Authorization happens afterwards and separately.
 */
export async function authenticateRequest(input: {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array
  chainId: bigint
  capabilityRegistry: Address
  now: bigint
  replay: NonceStore
}): Promise<Address> {
  assertAuthHeaderShape(input.headers)
  const signer = input.headers.get(AUTH_HEADERS.signer)!
  const timestamp = input.headers.get(AUTH_HEADERS.timestamp)!
  const nonce = input.headers.get(AUTH_HEADERS.nonce)!
  const signature = input.headers.get(AUTH_HEADERS.signature)!
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
  await input.replay.consume(signer as Address, nonce as Hex, signedAt, input.now)
  return signer.toLowerCase() as Address
}
