import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { canonicalBytes, encodeUint64, MAX_PAYLOAD_BYTES } from "@mida/protocol"
import type { ContextPayload, Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { zeroHash } from "viem"
import type { MigrationEnvelope } from "./migration-envelope.js"
import { attachEnvelope, validateMigrationEnvelope } from "./migration-envelope.js"
import { MAX_VALUE_BYTES, unwrapCheckpoint } from "./checkpoint-payload.js"
import type { SourceRecord } from "./owner-read.js"

/**
 * The migration manifest (migrate B4): one entry per source record, built before any side
 * effect. Verification is per record, never by counts — so every entry carries the record's
 * identity (`sourceId`, not its content — identical text is still two records), an HMAC
 * fingerprint of the canonical payload, and the exact size its destination serialization will
 * occupy on the new contract. Nothing here touches the chain, the disk or the network: the
 * manifest is computed from the records Task 3 already decrypted.
 */
export type EntryStatus =
  | "pending"
  | "sent"
  | "verified"
  | "skipped:unknown-author"
  | "skipped:dangling-relation"
  | "skipped:store-unreadable"

/** A record's TRUE origin — what its destination envelope must name. See `ManifestEntry.origin`. */
export interface ManifestOrigin {
  chainId: string
  contract: `0x${string}`
  recordId: Hex
  commitment: Hex
  author: Hex
  createdAt: string
}

export interface ManifestEntry {
  sourceId: Hex
  sourceCommitment: Hex
  /**
   * The record's TRUE origin (Task 4b): a valid migration envelope already on the record is
   * copied verbatim, so a record moved A → B → C still names A; otherwise the immediate source.
   * `sourceId`/`sourceCommitment`/`createdAt` stay the immediate source's — replay order and
   * per-record verification key on them; `origin` is what the destination envelope names.
   */
  origin: ManifestOrigin
  namespace: string
  authorId: Hex
  /** The local name behind the on-chain author — "owner" for owner-authored, null when unknown. */
  authorName: string | null
  provenanceSource: number
  recordType: number
  kind: number
  lineagePolicy: number
  /** Unix seconds as a decimal string — Task 5 hands it back to the write path as a bigint. */
  expiresAt: string
  /** ISO-8601: the checkpoint's own `createdAt`, the chain record's for everything else. */
  createdAt: string
  lineageId: Hex
  version: number
  parentId: Hex
  /** The records this record points at, with their relation names and source ids. */
  relations: { relation: string; sourceId: Hex }[]
  /** HMAC-SHA256(key, canonical payload) — references as source ids, envelope excluded. */
  fingerprint: Hex
  /** The exact byte size of this record's destination serialization, envelope attached. */
  destinationBytes: number
  /** MAX_VALUE_BYTES for a checkpoint, MAX_PAYLOAD_BYTES for any other record. */
  limit: number
  /**
   * Set when the record's `value` cannot carry the envelope (a string value): the envelope was
   * never attached, so `destinationBytes`/`limit` describe the record as it is — preflight
   * refuses it under `envelope-unplaceable` rather than measuring a destination that cannot exist.
   */
  envelopeUnplaceable?: true
  preparedNonce?: Hex
  targetId?: Hex
  status: EntryStatus
}

export interface Manifest {
  version: 1
  source: { chainId: string; contextRegistry: `0x${string}` }
  target: { chainId: string; contextRegistry: `0x${string}` }
  entries: ManifestEntry[]
  /** Local agent name → its id on the source contract; Task 5 fills in the target side. */
  agentMap: Record<string, { oldAgentId: Hex; newAgentId?: Hex; preparedSalt?: Hex }>
}

/** The id shape every target record gets: a 32-byte hex, the length a rewritten reference takes. */
const PLACEHOLDER_TARGET_ID = `0x${"11".repeat(32)}` as Hex

/** A plain Error carrying `.code` — `relation-cycle` is a midad-level refusal, not a protocol code. */
function manifestError(code: string, detail: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${detail}`), { code })
}

const lower = (hex: string): Hex => hex.toLowerCase() as Hex
const iso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString()

/**
 * The fingerprint both sides of a move agree on: the canonical payload with the migration
 * envelope stripped and every reference expressed as a source id. On the source both hold
 * already — the payload was never enveloped and its references are source ids — so Task 4 calls
 * this with the payload as read. Task 6 recomputes it on the target after rewriting references
 * back through the manifest, which is why `sourceIdOf` is a parameter: identical content on
 * either contract fingerprints identically, which is what makes per-record verification possible.
 */
export function payloadFingerprint(
  payload: ContextPayload,
  hmacKey: Uint8Array,
  sourceIdOf: (recordId: Hex) => Hex = (recordId) => recordId,
): Hex {
  const value = payload.value
  const stripped =
    typeof value === "object" && value !== null && !Array.isArray(value) && "migration" in value
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "migration"))
      : value
  const references = payload.provenance.references
  const canonical: ContextPayload = {
    ...payload,
    value: stripped,
    provenance: {
      ...payload.provenance,
      ...(references === undefined
        ? {}
        : { references: references.map((reference) => ({ ...reference, recordId: sourceIdOf(reference.recordId) })) }),
    },
  }
  return `0x${bytesToHex(hmac(sha256, hmacKey, canonicalBytes(canonical)))}` as Hex
}

/** `createdAt` as the spec fixes it: a checkpoint's own field, the chain record's for the rest. */
function createdAtOf(record: SourceRecord): string {
  const checkpoint = unwrapCheckpoint(record.payload.value)
  return checkpoint === null ? iso(record.createdAt) : checkpoint.checkpoint.createdAt
}

/** Every reference rewritten to a same-length placeholder — the size is exact, never estimated. */
function withPlaceholderReferences(payload: ContextPayload): ContextPayload {
  const references = payload.provenance.references
  if (references === undefined || references.length === 0) return payload
  return {
    ...payload,
    provenance: {
      ...payload.provenance,
      references: references.map((reference) => ({ ...reference, recordId: PLACEHOLDER_TARGET_ID })),
    },
  }
}

/**
 * The exact destination serialization, encoded the way the write encodes it. A checkpoint is
 * measured on its envelope (`payload.value`) against MAX_VALUE_BYTES — the limit
 * `wrapCheckpoint` enforces; every other record on the whole canonical payload against
 * MAX_PAYLOAD_BYTES — the limit `encodePayload` enforces. The migration envelope is attached
 * for real — built from the entry's `origin`, so a re-migrated record still names its first
 * contract — and every reference is rewritten to a 32-byte placeholder, so the byte count is
 * the byte count the destination contract will store.
 */
function measureDestination(
  record: SourceRecord,
  origin: ManifestOrigin,
  migratedAt: string,
): { destinationBytes: number; limit: number; envelopeUnplaceable?: true } {
  const envelope: MigrationEnvelope = {
    version: 1,
    originalChainId: origin.chainId,
    originalContract: origin.contract,
    originalRecordId: origin.recordId,
    originalCommitment: origin.commitment,
    originalAuthor: origin.author,
    originalCreatedAt: origin.createdAt,
    migratedAt,
  }
  let destination: ContextPayload
  try {
    destination = withPlaceholderReferences(attachEnvelope(record.payload, envelope))
  } catch (error) {
    if ((error as { code?: string }).code === "envelope-unplaceable") {
      return { destinationBytes: canonicalBytes(record.payload).length, limit: MAX_PAYLOAD_BYTES, envelopeUnplaceable: true }
    }
    throw error
  }
  if (unwrapCheckpoint(destination.value) !== null) {
    return { destinationBytes: canonicalBytes(destination.value).length, limit: MAX_VALUE_BYTES }
  }
  return { destinationBytes: canonicalBytes(destination).length, limit: MAX_PAYLOAD_BYTES }
}

/**
 * The record's TRUE origin (Task 4b). A payload carrying a valid migration envelope was moved
 * at least once already — its origin is that envelope's, copied verbatim, so moving it again
 * still names the first contract and the first stating time. A payload with no envelope
 * originates on the immediate source. A `migration` key that fails validation is never silently
 * overwritten: `invalid-source-envelope`, naming the record.
 */
function originOf(record: SourceRecord, createdAt: string, source: Deployment): ManifestOrigin {
  const value = record.payload.value
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "migration" in value) {
    const checked = validateMigrationEnvelope((value as { migration?: unknown }).migration)
    if (!checked.ok) {
      throw manifestError("invalid-source-envelope", `${lower(record.contextId)}: ${checked.errors.join("; ")}`)
    }
    const existing = checked.value
    return {
      chainId: existing.originalChainId,
      contract: existing.originalContract,
      recordId: existing.originalRecordId,
      commitment: existing.originalCommitment,
      author: existing.originalAuthor,
      createdAt: existing.originalCreatedAt,
    }
  }
  return {
    chainId: source.chainId.toString(10),
    contract: source.contextRegistry,
    recordId: lower(record.contextId),
    commitment: lower(record.manifestHash),
    author: lower(record.authorId),
    createdAt,
  }
}

/** The in-manifest records an entry must come after: its superseded parent and its references. */
function dependencyIds(entry: ManifestEntry, byId: ReadonlyMap<string, ManifestEntry>): Hex[] {
  const ids: Hex[] = []
  const parent = entry.parentId.toLowerCase()
  if (parent !== zeroHash && byId.has(parent)) ids.push(parent as Hex)
  for (const relation of entry.relations) {
    const id = relation.sourceId.toLowerCase()
    if (byId.has(id)) ids.push(id as Hex)
  }
  return ids
}

/**
 * One manifest entry per source record. Authors resolve through `authorNames` (the local agent
 * name behind each on-chain id); the owner marker — author `bytes32(0)` — is "owner". An author
 * with no local identity marks its record `skipped:unknown-author`, and anything that references
 * or supersedes a skipped record follows it into `skipped:dangling-relation`, transitively.
 * Zero records is a legal input: `entries` is empty and the owner, agents and approvals still move.
 */
export function buildManifest(
  records: SourceRecord[],
  authorNames: Record<string, string>,
  source: Deployment,
  target: Deployment,
  hmacKey: Uint8Array,
  migratedAt: string,
): Manifest {
  const entries: ManifestEntry[] = records.map((record) => {
    const authorId = lower(record.authorId)
    const authorName = authorId === zeroHash ? "owner" : authorNames[authorId] ?? null
    const createdAt = createdAtOf(record)
    const origin = originOf(record, createdAt, source)
    const measured = measureDestination(record, origin, migratedAt)
    return {
      sourceId: lower(record.contextId),
      sourceCommitment: lower(record.manifestHash),
      origin,
      namespace: record.namespace,
      authorId,
      authorName,
      provenanceSource: record.provenanceSource,
      recordType: record.recordType,
      kind: record.kind,
      lineagePolicy: record.lineagePolicy,
      expiresAt: encodeUint64(record.expiresAt),
      createdAt,
      lineageId: lower(record.lineageId),
      version: record.version,
      parentId: lower(record.parentId),
      relations: record.references.map((reference) => ({
        relation: reference.relation,
        sourceId: lower(reference.recordId),
      })),
      fingerprint: payloadFingerprint(record.payload, hmacKey),
      destinationBytes: measured.destinationBytes,
      limit: measured.limit,
      ...(measured.envelopeUnplaceable === true ? { envelopeUnplaceable: true as const } : {}),
      status: authorName === null ? ("skipped:unknown-author" as const) : ("pending" as const),
    }
  })

  const byId = new Map(entries.map((entry) => [entry.sourceId.toLowerCase(), entry]))
  // Dangling propagates: any record that points at a skipped record cannot replay, whatever the
  // skipped record's reason — loop until nothing new is marked (each pass settles one more hop).
  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries) {
      if (entry.status !== "pending") continue
      const dangling = dependencyIds(entry, byId).some((id) => byId.get(id)!.status.startsWith("skipped:"))
      if (dangling) {
        entry.status = "skipped:dangling-relation"
        changed = true
      }
    }
  }

  const agentMap: Manifest["agentMap"] = {}
  for (const [authorId, name] of Object.entries(authorNames)) {
    if (authorId.toLowerCase() === zeroHash) continue
    agentMap[name] = { oldAgentId: authorId.toLowerCase() as Hex }
  }

  return {
    version: 1,
    source: { chainId: source.chainId.toString(10), contextRegistry: source.contextRegistry },
    target: { chainId: target.chainId.toString(10), contextRegistry: target.contextRegistry },
    entries,
    agentMap,
  }
}

/**
 * The order records must be written in: a superseded version before the record that replaces it,
 * a referenced record before the records that point at it. Dependencies are parent links
 * (`parentId`, ordered by `version` within a lineage as well) and `relations`; ids outside the
 * manifest are not dependencies — a reference to a record the owner does not carry stays as-is.
 * Skipped entries keep their place in the output: Task 5 lists them, it does not write them.
 * A dependency cycle cannot be replayed — `relation-cycle`, naming the records involved.
 */
export function replayOrder(manifest: Manifest): ManifestEntry[] {
  const entries = manifest.entries
  const byId = new Map(entries.map((entry) => [entry.sourceId.toLowerCase(), entry]))
  const dependencies = new Map<ManifestEntry, Set<ManifestEntry>>()
  const dependents = new Map<ManifestEntry, Set<ManifestEntry>>()
  const link = (before: ManifestEntry, after: ManifestEntry) => {
    if (!dependencies.has(after)) dependencies.set(after, new Set())
    if (dependencies.get(after)!.has(before)) return
    dependencies.get(after)!.add(before)
    if (!dependents.has(before)) dependents.set(before, new Set())
    dependents.get(before)!.add(after)
  }
  for (const entry of entries) {
    for (const id of dependencyIds(entry, byId)) link(byId.get(id)!, entry)
  }
  // A lineage replays in version order even when a parent id sits outside the manifest.
  const lineages = new Map<string, ManifestEntry[]>()
  for (const entry of entries) {
    const lineageId = entry.lineageId.toLowerCase()
    if (lineageId === zeroHash) continue
    const members = lineages.get(lineageId) ?? []
    members.push(entry)
    lineages.set(lineageId, members)
  }
  for (const members of lineages.values()) {
    members.sort((a, b) => a.version - b.version)
    for (let i = 1; i < members.length; i++) link(members[i - 1]!, members[i]!)
  }

  // Kahn's algorithm; ties fall back to manifest order so the output is deterministic.
  const remaining = new Map(entries.map((entry) => [entry, dependencies.get(entry)?.size ?? 0]))
  const queue = entries.filter((entry) => remaining.get(entry) === 0)
  const ordered: ManifestEntry[] = []
  while (queue.length > 0) {
    const entry = queue.shift()!
    ordered.push(entry)
    for (const dependent of dependents.get(entry) ?? []) {
      const left = remaining.get(dependent)! - 1
      remaining.set(dependent, left)
      if (left === 0) queue.push(dependent)
    }
  }
  if (ordered.length !== entries.length) {
    const placed = new Set(ordered)
    const cycle = entries.filter((entry) => !placed.has(entry)).map((entry) => entry.sourceId)
    throw manifestError("relation-cycle", `records form a dependency cycle: ${cycle.join(", ")}`)
  }
  return ordered
}

/**
 * The refusal list for the whole migration: every entry whose destination bytes exceed its
 * limit, or whose value cannot carry the migration envelope. Empty means the migration may
 * proceed — there is no per-record escape hatch, and no limit is ever raised.
 */
export function preflight(
  manifest: Manifest,
): { sourceId: Hex; namespace: string; bytes: number; limit: number; reason: "too-large" | "envelope-unplaceable" }[] {
  const rows = []
  for (const entry of manifest.entries) {
    if (entry.envelopeUnplaceable === true) {
      rows.push({ sourceId: entry.sourceId, namespace: entry.namespace, bytes: entry.destinationBytes, limit: entry.limit, reason: "envelope-unplaceable" as const })
    } else if (entry.destinationBytes > entry.limit) {
      rows.push({ sourceId: entry.sourceId, namespace: entry.namespace, bytes: entry.destinationBytes, limit: entry.limit, reason: "too-large" as const })
    }
  }
  return rows
}
