import { sha256 } from "@noble/hashes/sha2.js"
import type { Address, Hex } from "@mida/protocol"
import { base64UrlDecode, base64UrlEncode } from "../check/bytes.js"
import { assertNoSecretMaterial } from "../check/report.js"

/**
 * The wire contract between the terminal and this page (PROTOCOL.md is the spec; this file is
 * the page-side implementation).
 *
 * In:  `https://<origin>/<flow>#v=1&req=<base64url JSON>&port=<n>&nonce=<hex16>`
 * Out: `http://127.0.0.1:<port>/mida-return#nonce=<nonce>&result=<base64url JSON>`
 *
 * Two rules do the security work:
 *  - Everything identity-relevant lives inside `req`, so `requestHash = sha256(reqBytes)` covers
 *    all of it — and the same bytes feed the pairing code.
 *  - The result carries no secret material — `buildResult` runs the report sanitiser and refuses
 *    to serialize a 32-byte value under a key named like prf*, seed*, secret*, private*, key.
 */

export type FlowName = "signup" | "approve" | "revoke"

export class LinkError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = "LinkError"
    this.reason = reason
  }
}

const MAX_REQ_BYTES = 8 * 1024
const NONCE_RE = /^[0-9a-f]{16}$/i
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

export interface ProjectLabel {
  id: string
  label: string
}

/**
 * The decoded `req` envelope. Fields are flow-specific: `request`+`manifest` belong to approve,
 * `agentId`+`readers` to revoke, `entries` to the project-list signature the page returns. The
 * parser checks the envelope's shape and field types; the flows verify the contents (agent
 * signature, manifest hash, chain state) before any passkey prompt.
 */
export interface LinkRequest {
  chainId: number
  /** Expected owner address — present on approve/revoke, absent on signup. */
  owner?: Address
  /** The agent's signed access request (approve). Deep verification happens in the advisor. */
  request?: Record<string, unknown>
  /** The agent's signed manifest, if the terminal inlined it; else the page fetches it. */
  manifest?: Record<string, unknown>
  /** The agent to revoke (revoke). */
  agentId?: Hex
  /** Agent ids the terminal believes survive a revoke — re-checked on chain before re-wrapping. */
  readers?: Hex[]
  project?: ProjectLabel
  /** Current project-list entries the page re-signs after an approve. */
  entries?: Record<string, unknown>[]
}

export interface ParsedLink {
  flow: FlowName
  /** The exact decoded req bytes — the pairing code and requestHash both derive from these. */
  requestBytes: Uint8Array
  requestHash: Hex
  req: LinkRequest
  nonce: string
  /** Absent when the link carries no port — the page then shows the result instead of returning. */
  port?: number
}

const ALLOWED_PARAMS = new Set(["v", "req", "port", "nonce"])
const ALLOWED_REQ_KEYS = new Set(["chainId", "owner", "request", "manifest", "agentId", "readers", "project", "entries"])

function fail(reason: string): never {
  throw new LinkError(reason)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse the link fragment. `fragment` is everything after `#` in the page URL. Every check that
 * can fail throws LinkError with a plain-words reason — a malformed link is refused before any
 * passkey prompt, and the page shows the reason so the owner can tell a broken terminal from a
 * forged link.
 */
export function parseLinkFragment(fragment: string, flow: FlowName): ParsedLink {
  const params = new URLSearchParams(fragment)
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) fail(`the link carries a field this page does not know ("${key}")`)
  }
  if (params.get("v") !== "1") fail("the link version is not one this page understands")

  const nonce = params.get("nonce") ?? fail("the link carries no nonce")
  if (!NONCE_RE.test(nonce)) fail("the link's nonce is not the 16-hex-digit value the terminal issues")

  let port: number | undefined
  const portParam = params.get("port")
  if (portParam !== null) {
    if (!/^\d+$/.test(portParam)) fail("the link's port is not a number")
    port = Number(portParam)
    if (port < 1024 || port > 65535) fail("the link's port is outside 1024–65535")
  }

  const reqParam = params.get("req") ?? fail("the link carries no request")
  let requestBytes: Uint8Array
  try {
    requestBytes = base64UrlDecode(reqParam)
  } catch {
    fail("the link's request is not base64url")
  }
  if (requestBytes.length > MAX_REQ_BYTES) fail("the link's request is larger than 8 KB")

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(requestBytes))
  } catch {
    fail("the link's request is not JSON")
  }
  if (!isPlainObject(decoded)) fail("the link's request is not a JSON object")
  for (const key of Object.keys(decoded)) {
    if (!ALLOWED_REQ_KEYS.has(key)) fail(`the request carries a field this page does not know ("${key}")`)
  }

  const req: LinkRequest = { chainId: 0 }
  if (typeof decoded.chainId !== "number" || !Number.isInteger(decoded.chainId) || decoded.chainId <= 0) {
    fail("the request's chainId is missing or not a positive integer")
  }
  req.chainId = decoded.chainId

  if (decoded.owner !== undefined) {
    if (typeof decoded.owner !== "string" || !ADDRESS_RE.test(decoded.owner)) {
      fail("the request's owner is not an address")
    }
    req.owner = decoded.owner.toLowerCase() as Address
  }
  if (decoded.request !== undefined) {
    if (!isPlainObject(decoded.request)) fail("the request's request field is not an object")
    req.request = decoded.request
  }
  if (decoded.manifest !== undefined) {
    if (!isPlainObject(decoded.manifest)) fail("the request's manifest field is not an object")
    req.manifest = decoded.manifest
  }
  if (decoded.agentId !== undefined) {
    if (typeof decoded.agentId !== "string" || !BYTES32_RE.test(decoded.agentId)) {
      fail("the request's agentId is not a bytes32 hex value")
    }
    req.agentId = decoded.agentId.toLowerCase() as Hex
  }
  if (decoded.readers !== undefined) {
    if (!Array.isArray(decoded.readers) || decoded.readers.length > 64) {
      fail("the request's readers field is not a short array")
    }
    for (const reader of decoded.readers) {
      if (typeof reader !== "string" || !BYTES32_RE.test(reader)) fail("a readers entry is not a bytes32 hex value")
    }
    req.readers = decoded.readers.map((r) => (r as string).toLowerCase() as Hex)
  }
  if (decoded.project !== undefined) {
    if (!isPlainObject(decoded.project) || typeof decoded.project.id !== "string" || typeof decoded.project.label !== "string") {
      fail("the request's project field is not {id, label}")
    }
    req.project = { id: decoded.project.id, label: decoded.project.label }
  }
  if (decoded.entries !== undefined) {
    if (!Array.isArray(decoded.entries) || decoded.entries.length > 256 || !decoded.entries.every(isPlainObject)) {
      fail("the request's entries field is not an array of objects")
    }
    req.entries = decoded.entries
  }

  // Per-flow requirements — an approve link with no request, or a revoke link naming no agent,
  // is refused here rather than mid-flow.
  if (flow === "signup" && req.owner !== undefined) fail("a signup link names an owner — signup creates the owner")
  if (flow === "approve" && (req.owner === undefined || req.request === undefined)) {
    fail("an approve link must name the owner and carry the agent's signed request")
  }
  if (flow === "revoke" && (req.owner === undefined || req.agentId === undefined)) {
    fail("a revoke link must name the owner and the agent")
  }

  const requestHash = `0x${Array.from(sha256(requestBytes), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex
  return { flow, requestBytes, requestHash, req, nonce, port }
}

/** What the page hands back to the terminal — and nothing more. See PROTOCOL.md. */
export interface FlowResult {
  v: 1
  status: "success" | "cancelled" | "failed"
  nonce: string
  requestHash: Hex
  owner: Address | null
  transactions: Hex[]
  operations: Hex[]
  /** The signed project-list entry (approve only). */
  entry?: Record<string, unknown>
  /** The passkey's P-256 point (signup only). */
  publicKey?: { x: Hex; y: Hex }
  /** Plain-words reason when status is "failed" or "cancelled". */
  reason?: string
}

/**
 * Build the result object the page returns. The sanitiser is the guard: any 32-byte value under
 * a secret-looking key name — anywhere in the structure — throws before it can reach the URL.
 */
export function buildResult(result: FlowResult): FlowResult {
  assertNoSecretMaterial(result, "result")
  return result
}

/**
 * Serialize the result and wrap it in the local return URL. The host is ALWAYS the literal
 * 127.0.0.1 — never a name, never taken from the link — so a crafted link cannot aim the result
 * at another machine.
 */
export function buildReturnUrl(port: number, nonce: string, result: FlowResult): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new LinkError("the return port is outside 1024–65535")
  }
  const json = new TextEncoder().encode(JSON.stringify(buildResult(result)))
  return `http://127.0.0.1:${port}/mida-return#nonce=${nonce}&result=${base64UrlEncode(json)}`
}
