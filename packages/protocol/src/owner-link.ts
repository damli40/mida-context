import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { UNACCEPTABLE_REQUEST_CHARS, UNACCEPTABLE_REQUEST_TEXT } from "./errors.js"
import type { Address, Hex } from "./types.js"

/**
 * The wire contract between the terminal (`mida init --passkey`, `approve`, `revoke`) and the
 * owner page at https://app.midacontext.xyz. `apps/owner-page/PROTOCOL.md` is the spec; this
 * file is the ONE implementation both sides share — the page and the terminal must never drift
 * on request shape, hashing or the pairing code.
 *
 * In:  `https://<origin>/<flow>#v=1&req=<base64url JSON>&port=<n>&nonce=<hex16>`
 * Out: `http://127.0.0.1:<port>/mida-return#nonce=<nonce>&result=<base64url JSON>`
 *
 * Two rules do the security work:
 *  - Everything identity-relevant lives inside `req`, so `requestHash = sha256(reqBytes)` covers
 *    all of it — and the same bytes feed the pairing code.
 *  - The result carries no secret material — `buildOwnerResult` runs the sanitiser and refuses
 *    to serialize a 32-byte value under a key whose name contains prf, seed, secret, private, key.
 *
 * This module is bundled into the browser page — no node imports, no Buffer, no process.
 */

export type OwnerLinkFlow = "signup" | "approve" | "revoke"

export class OwnerLinkError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = "OwnerLinkError"
    this.reason = reason
  }
}

const MAX_REQ_BYTES = 8 * 1024
const NONCE_RE = /^[0-9a-f]{16}$/i
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

export interface OwnerLinkProject {
  id: string
  label: string
}

/**
 * The decoded `req` envelope. Fields are flow-specific: `request`+`manifest` belong to approve,
 * `agentId`+`readers` to revoke, `entries` to the project-list signature the page returns. The
 * parser checks the envelope's shape and field types; the flows verify the contents (agent
 * signature, manifest hash, chain state) before any passkey prompt.
 */
export interface OwnerLinkRequest {
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
  project?: OwnerLinkProject
  /** Current project-list entries the page re-signs after an approve. */
  entries?: Record<string, unknown>[]
  /** The new approved-projects row to append (approve): {agent, projectId, root}. */
  entry?: { agent: string; projectId: string; root: string }
}

export interface ParsedOwnerLink {
  flow: OwnerLinkFlow
  /** The exact decoded req bytes — the pairing code and requestHash both derive from these. */
  requestBytes: Uint8Array
  requestHash: Hex
  req: OwnerLinkRequest
  nonce: string
  /** Absent when the link carries no port — the page then shows the result instead of returning. */
  port?: number
}

const ALLOWED_PARAMS = new Set(["v", "req", "port", "nonce"])
const ALLOWED_REQ_KEYS = new Set(["chainId", "owner", "request", "manifest", "agentId", "readers", "project", "entries", "entry"])

function fail(reason: string): never {
  throw new OwnerLinkError(reason)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// --- byte helpers (browser-safe twins of apps/owner-page/src/check/bytes.ts) -----------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

export function ownerLinkBase64UrlEncode(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined
    out += B64URL[a >> 2]! + B64URL[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!
    if (b !== undefined) out += B64URL[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!
    if (c !== undefined) out += B64URL[c & 0x3f]!
  }
  return out
}

export function ownerLinkBase64UrlDecode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "")
  if (clean.length % 4 === 1) throw new OwnerLinkError("not base64url")
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of clean) {
    const v = B64URL.indexOf(ch)
    if (v < 0) throw new OwnerLinkError("not base64url")
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

// --- the no-secret-material guard (moved from the page's check/report.ts — both sides share it)

const SECRET_KEY = /(prf|seed|secret|private|key)/i

function isThirtyTwoBytes(value: unknown): boolean {
  if (value instanceof Uint8Array) return value.length === 32
  if (Array.isArray(value)) return value.length === 32 && value.every((v) => typeof v === "number")
  if (typeof value === "string") return /^(0x)?[0-9a-fA-F]{64}$/.test(value)
  return false
}

/** Throws on the first 32-byte value found under a secret-looking key, anywhere in the tree. */
export function assertNoSecretMaterial(value: unknown, path = "report"): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoSecretMaterial(value[i], `${path}[${i}]`)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && isThirtyTwoBytes(child)) {
        throw new Error(`report would expose "${path}.${key}" — a 32-byte value under a secret-looking name`)
      }
      assertNoSecretMaterial(child, `${path}.${key}`)
    }
  }
}

// --- the pairing code ------------------------------------------------------------------------

const DOMAIN = utf8ToBytes("mida.pair.v1")

/**
 * 256 common, distinct words — one per byte value. Chosen to be easy to say over a screen share
 * and hard to confuse with each other; the list is the contract, so the entries and their order
 * never change.
 */
export const PAIRING_WORDS: readonly string[] = [
  "apple", "arrow", "atlas", "autumn", "badge", "bamboo", "banner", "beacon",
  "beetle", "birch", "blossom", "bonnet", "border", "bottle", "bridge", "bronze",
  "brook", "bucket", "butter", "cabin", "cactus", "canoe", "canvas", "castle",
  "cedar", "cello", "chalk", "chapel", "cheese", "cherry", "chimney", "cider",
  "cinema", "circle", "cliff", "clover", "coast", "cobalt", "cocoa", "comet",
  "compass", "copper", "corner", "cotton", "cradle", "crane", "crater", "cricket",
  "crystal", "dagger", "daisy", "dancer", "delta", "desert", "diamond", "dinner",
  "dome", "donkey", "dragon", "drizzle", "drum", "dusk", "eagle", "engine",
  "estuary", "fabric", "falcon", "feather", "fennel", "fern", "finch", "fjord",
  "flame", "flint", "flute", "foam", "forest", "fountain", "frost", "galaxy",
  "garden", "garlic", "garnet", "gate", "glacier", "glen", "globe", "glove",
  "goat", "gold", "goose", "granite", "grape", "gravel", "grove", "guitar",
  "harbor", "harp", "hazel", "hearth", "hedge", "heron", "hill", "honey",
  "horizon", "iceberg", "igloo", "index", "ink", "island", "ivory", "jacket",
  "jade", "jasmine", "jasper", "jewel", "jigsaw", "journal", "jungle", "kayak",
  "kettle", "keystone", "kingdom", "kite", "ladder", "lagoon", "lantern", "lark",
  "lava", "lemon", "lens", "lilac", "linen", "lion", "locket", "lodge",
  "lotus", "lumber", "magnet", "maple", "marble", "meadow", "melody", "melon",
  "mercury", "mermaid", "mint", "mirror", "mist", "monkey", "moon", "mosaic",
  "moth", "mountain", "mouse", "muffin", "museum", "mushroom", "music", "nectar",
  "needle", "nest", "nickel", "north", "oak", "oasis", "ocean", "olive",
  "onion", "opal", "orange", "orbit", "orchard", "oval", "owl", "paddle",
  "palace", "palm", "panda", "parcel", "parrot", "peach", "pebble", "pelican",
  "pencil", "pepper", "piano", "picnic", "pillar", "pine", "planet", "plum",
  "pocket", "porch", "potato", "prairie", "prism", "pumpkin", "puzzle", "quartz",
  "quiver", "rabbit", "radar", "rainbow", "raven", "reed", "ribbon", "ridge",
  "river", "rocket", "root", "rose", "ruby", "saddle", "saffron", "sail",
  "salmon", "sand", "sapphire", "satin", "scarab", "scent", "seed", "shadow",
  "shell", "shield", "shore", "silk", "silver", "skylark", "slate", "smoke",
  "snow", "soap", "solar", "sparrow", "spear", "spice", "spider", "spiral",
  "sponge", "spring", "spruce", "square", "stable", "star", "steam", "stone",
  "storm", "stream", "string", "sugar", "summer", "summit", "sunset", "swan",
]

/**
 * Three words and two digits from the exact request bytes. Example: "atlas sugar orbit 07".
 * Both sides call this on the same bytes and must print the same string.
 *
 * FROZEN: the word list, the domain separator, and the byte-to-code mapping are the wire
 * contract between the page and the terminal. Changing any of them orphans every in-flight
 * request — bump the "v1" tag instead, never edit in place.
 */
export function pairingCode(requestBytes: Uint8Array): string {
  const digest = sha256(concatBytes(DOMAIN, requestBytes))
  const words = [digest[0]!, digest[1]!, digest[2]!].map((b) => PAIRING_WORDS[b]!)
  const digits = String(digest[3]! % 100).padStart(2, "0")
  return `${words.join(" ")} ${digits}`
}

/** sha256 of the exact request bytes, as 0x-hex — what the result's `requestHash` must equal. */
export function requestHash(requestBytes: Uint8Array): Hex {
  return `0x${bytesToHex(sha256(requestBytes))}` as Hex
}

// --- request validation (shared by parse and build) ------------------------------------------

/**
 * Field-by-field validation of the decoded request object, returning a normalized copy — only
 * allowed keys, lowercased hex, rebuilt rows — so `buildOwnerLink` serializes canonical bytes and
 * `parseOwnerLink` returns a shape the flows can trust. Throws OwnerLinkError on anything off.
 */
function validateRequestObject(decoded: unknown, flow: OwnerLinkFlow): OwnerLinkRequest {
  if (!isPlainObject(decoded)) fail("the link's request is not a JSON object")
  for (const key of Object.keys(decoded)) {
    if (!ALLOWED_REQ_KEYS.has(key)) fail(`the request carries a field this page does not know ("${key}")`)
  }

  const req: OwnerLinkRequest = { chainId: 0 }
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
    const rows: Record<string, unknown>[] = []
    for (const row of decoded.entries) {
      const keys = Object.keys(row)
      if (keys.length !== 4 || !["agent", "projectId", "root", "approvedAt"].every((k) => typeof row[k] === "string" && row[k] !== "")) {
        fail("an entries row is not the signed {agent, projectId, root, approvedAt} shape")
      }
      rows.push({ agent: row.agent, projectId: row.projectId, root: row.root, approvedAt: row.approvedAt })
    }
    req.entries = rows
  }
  if (decoded.entry !== undefined) {
    if (
      !isPlainObject(decoded.entry) ||
      Object.keys(decoded.entry).length !== 3 ||
      typeof decoded.entry.agent !== "string" ||
      decoded.entry.agent === "" ||
      typeof decoded.entry.projectId !== "string" ||
      decoded.entry.projectId === "" ||
      typeof decoded.entry.root !== "string" ||
      decoded.entry.root === ""
    ) {
      fail("the request's entry field is not {agent, projectId, root}")
    }
    req.entry = { agent: decoded.entry.agent, projectId: decoded.entry.projectId, root: decoded.entry.root }
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

  // A control character in any string the page renders can forge a line of the approve summary —
  // no legitimate project label, folder root or agent name carries one (in-27 R-1). One sentence
  // refuses all of them; which field tripped the check stays off the page.
  const rendered = [
    req.project?.id,
    req.project?.label,
    req.entry?.agent,
    req.entry?.projectId,
    req.entry?.root,
    ...(req.entries ?? []).flatMap((row) => [row.agent, row.projectId, row.root, row.approvedAt]),
  ]
  for (const value of rendered) {
    if (typeof value === "string" && UNACCEPTABLE_REQUEST_CHARS.test(value)) fail(UNACCEPTABLE_REQUEST_TEXT)
  }
  // A `"` is legal in a label or a root — but inside an agent NAME it closes the approve
  // summary's `agent "…"` quotes early and plants a forged `(run by …)` before the real one
  // (in-31 V-1). Names refuse it with the same sentence.
  for (const name of [req.entry?.agent, ...(req.entries ?? []).map((row) => row.agent)]) {
    if (typeof name === "string" && name.includes('"')) fail(UNACCEPTABLE_REQUEST_TEXT)
  }
  return req
}

/**
 * Parse the link fragment. `fragment` is everything after `#` in the page URL. Every check that
 * can fail throws OwnerLinkError with a plain-words reason — a malformed link is refused before
 * any passkey prompt, and the page shows the reason so the owner can tell a broken terminal from
 * a forged link.
 */
export function parseOwnerLink(fragment: string, flow: OwnerLinkFlow): ParsedOwnerLink {
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
    requestBytes = ownerLinkBase64UrlDecode(reqParam)
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
  const req = validateRequestObject(decoded, flow)

  return { flow, requestBytes, requestHash: requestHash(requestBytes), req, nonce, port }
}

/**
 * Terminal side: build the page link for a request. The request object is validated by the same
 * rules the page applies, then serialized once — `requestBytes` is exactly what the page decodes,
 * so the pairing code and the result's `requestHash` can never drift apart.
 */
export function buildOwnerLink(input: {
  origin: string
  flow: OwnerLinkFlow
  req: OwnerLinkRequest
  nonce: string
  port?: number
}): { url: string; requestBytes: Uint8Array; requestHash: Hex } {
  if (typeof input.origin !== "string" || !/^https?:\/\/[^/#?]+/.test(input.origin)) {
    fail("the page origin is not an http(s) origin")
  }
  if (!NONCE_RE.test(input.nonce)) fail("the nonce is not the 16-hex-digit value the terminal issues")
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535)) {
    fail("the return port is outside 1024–65535")
  }
  const req = validateRequestObject(input.req, input.flow)
  const requestBytes = new TextEncoder().encode(JSON.stringify(req))
  if (requestBytes.length > MAX_REQ_BYTES) fail("the request is larger than 8 KB")
  const fragment = `v=1&req=${ownerLinkBase64UrlEncode(requestBytes)}${input.port === undefined ? "" : `&port=${input.port}`}&nonce=${input.nonce}`
  return { url: `${input.origin}/${input.flow}#${fragment}`, requestBytes, requestHash: requestHash(requestBytes) }
}

// --- the result ------------------------------------------------------------------------------

/** What the page hands back to the terminal — and nothing more. See PROTOCOL.md. */
export interface OwnerLinkResult {
  v: 1
  /** "pending" is the sponsor-accepted-but-unconfirmed state — carries the operation hash, never a resend. */
  status: "success" | "cancelled" | "failed" | "pending"
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

const ALLOWED_RESULT_KEYS = new Set([
  "v", "status", "nonce", "requestHash", "owner", "transactions", "operations", "entry", "publicKey", "reason",
])
const RESULT_STATUS = new Set(["success", "cancelled", "failed", "pending"])

/**
 * Build the result object the page returns. The sanitiser is the guard: any 32-byte value under
 * a secret-looking key name — anywhere in the structure — throws before it can reach the URL.
 */
export function buildOwnerResult(result: OwnerLinkResult): OwnerLinkResult {
  assertNoSecretMaterial(result, "result")
  return result
}

/**
 * Serialize the result and wrap it in the local return URL. The host is ALWAYS the literal
 * 127.0.0.1 — never a name, never taken from the link — so a crafted link cannot aim the result
 * at another machine.
 */
export function buildOwnerReturnUrl(port: number, nonce: string, result: OwnerLinkResult): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new OwnerLinkError("the return port is outside 1024–65535")
  }
  const json = new TextEncoder().encode(JSON.stringify(buildOwnerResult(result)))
  return `http://127.0.0.1:${port}/mida-return#nonce=${nonce}&result=${ownerLinkBase64UrlEncode(json)}`
}

function isBytes32List(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && BYTES32_RE.test(v))
}

/**
 * Terminal side: decode and validate the `result=` fragment parameter. Strict about keys, types
 * and the no-secret-material rule — a result that does not match this shape is a page bug or a
 * forgery and is refused before the caller reads a single field.
 */
export function parseOwnerResult(encoded: string): OwnerLinkResult {
  let bytes: Uint8Array
  try {
    bytes = ownerLinkBase64UrlDecode(encoded)
  } catch {
    fail("the returned result is not base64url")
  }
  if (bytes.length > 16 * 1024) fail("the returned result is larger than 16 KB")
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    fail("the returned result is not JSON")
  }
  if (!isPlainObject(decoded)) fail("the returned result is not a JSON object")
  for (const key of Object.keys(decoded)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) fail(`the result carries a field the terminal does not know ("${key}")`)
  }
  if (decoded.v !== 1) fail("the result version is not one this terminal understands")
  if (typeof decoded.status !== "string" || !RESULT_STATUS.has(decoded.status)) {
    fail("the result's status is not a known value")
  }
  if (typeof decoded.nonce !== "string" || !NONCE_RE.test(decoded.nonce)) fail("the result's nonce is not 16 hex digits")
  if (typeof decoded.requestHash !== "string" || !BYTES32_RE.test(decoded.requestHash)) {
    fail("the result's requestHash is not a bytes32 hex value")
  }
  if (decoded.owner !== null && (typeof decoded.owner !== "string" || !ADDRESS_RE.test(decoded.owner))) {
    fail("the result's owner is not an address or null")
  }
  if (!isBytes32List(decoded.transactions)) fail("the result's transactions are not bytes32 hex values")
  if (!isBytes32List(decoded.operations)) fail("the result's operations are not bytes32 hex values")
  if (decoded.reason !== undefined && typeof decoded.reason !== "string") fail("the result's reason is not a string")
  if (decoded.entry !== undefined && !isPlainObject(decoded.entry)) fail("the result's entry is not an object")
  let publicKey: { x: Hex; y: Hex } | undefined
  if (decoded.publicKey !== undefined) {
    const pk = decoded.publicKey
    if (
      !isPlainObject(pk) ||
      typeof pk.x !== "string" ||
      !BYTES32_RE.test(pk.x) ||
      typeof pk.y !== "string" ||
      !BYTES32_RE.test(pk.y)
    ) {
      fail("the result's publicKey is not a P-256 point")
    }
    publicKey = { x: pk.x.toLowerCase() as Hex, y: pk.y.toLowerCase() as Hex }
  }
  const result: OwnerLinkResult = {
    v: 1,
    status: decoded.status as OwnerLinkResult["status"],
    nonce: decoded.nonce,
    requestHash: decoded.requestHash.toLowerCase() as Hex,
    owner: decoded.owner === null ? null : (decoded.owner as string).toLowerCase() as Address,
    transactions: (decoded.transactions as string[]).map((h) => h.toLowerCase() as Hex),
    operations: (decoded.operations as string[]).map((h) => h.toLowerCase() as Hex),
    ...(decoded.entry !== undefined ? { entry: decoded.entry } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
    ...(decoded.reason !== undefined ? { reason: decoded.reason } : {}),
  }
  assertNoSecretMaterial(result, "result")
  return result
}
