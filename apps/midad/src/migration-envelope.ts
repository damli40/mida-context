import type { ContextPayload } from "@mida/protocol"
import type { MigrationEnvelope } from "@mida/checkpoint"

// The type itself is declared in @mida/checkpoint beside StoredCheckpoint — the package that
// carries it cannot import from this app. (@mida/protocol holds an identical declaration for
// ContextPayload.migration; the two are structurally interchangeable.) Re-exported here so every
// midad caller imports the envelope, its validator and its placement helpers from one module.
export type { MigrationEnvelope }

const FIELDS = [
  "version",
  "originalChainId",
  "originalContract",
  "originalRecordId",
  "originalCommitment",
  "originalAuthor",
  "originalCreatedAt",
  "migratedAt",
] as const

const DECIMAL = /^\d+$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * A plain Error carrying `.code` — `invalid-migration-envelope` is a midad-level refusal, not a
 * protocol code, so MidaError's closed union cannot carry it.
 * The message leads with the code, the way MidaError formats it.
 */
function envelopeError(code: string, detail: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${detail}`), { code })
}

/**
 * The migration envelope is a closed shape — the eight fields, nothing else. `ok` returns a
 * rebuilt value holding exactly those fields in this order, so a wrapped-then-unwrapped copy
 * serializes identically every time.
 */
export function validateMigrationEnvelope(input: unknown): { ok: true; value: MigrationEnvelope } | { ok: false; errors: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["envelope must be an object"] }
  }
  const raw = input as Record<string, unknown>
  const errors: string[] = []
  for (const key of Object.keys(raw)) {
    if (!(FIELDS as readonly string[]).includes(key)) errors.push(`${key}: unknown field`)
  }
  if (raw.version !== 1) errors.push("version: must be the number 1")
  if (typeof raw.originalChainId !== "string" || !DECIMAL.test(raw.originalChainId)) {
    errors.push("originalChainId: must be a decimal string")
  }
  if (typeof raw.originalContract !== "string" || !ADDRESS.test(raw.originalContract)) {
    errors.push("originalContract: must be a 0x-prefixed 20-byte address")
  }
  for (const field of ["originalRecordId", "originalCommitment", "originalAuthor"] as const) {
    const value = raw[field]
    if (typeof value !== "string" || !HASH.test(value)) errors.push(`${field}: must be a 0x-prefixed 32-byte hex`)
  }
  for (const field of ["originalCreatedAt", "migratedAt"] as const) {
    const value = raw[field]
    if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
      errors.push(`${field}: must be an ISO-8601 timestamp`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      version: 1,
      originalChainId: raw.originalChainId as string,
      originalContract: raw.originalContract as `0x${string}`,
      originalRecordId: raw.originalRecordId as `0x${string}`,
      originalCommitment: raw.originalCommitment as `0x${string}`,
      originalAuthor: raw.originalAuthor as `0x${string}`,
      originalCreatedAt: raw.originalCreatedAt as string,
      migratedAt: raw.migratedAt as string,
    },
  }
}

/** The object `value`'s own envelope slot — undefined for a string value, which has none. */
function innerEnvelope(value: ContextPayload["value"]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return (value as { migration?: unknown }).migration
}

/**
 * Seals the envelope into a payload. A checkpoint payload's `value` IS the CheckpointEnvelope,
 * so `value.migration` is `CheckpointEnvelope.migration`; for a fact it lands beside `text` and
 * `assertedAt`; a record whose `value` is a string carries it beside the content, at
 * `payload.migration` — the value itself is never changed. Attaching to a payload that already
 * carries an envelope in the OTHER slot would leave it carried twice: `invalid-migration-envelope`.
 * The input payload is never mutated.
 */
export function attachEnvelope(payload: ContextPayload, envelope: MigrationEnvelope): ContextPayload {
  const checked = validateMigrationEnvelope(envelope)
  if (!checked.ok) {
    throw envelopeError("invalid-migration-envelope", `invalid migration envelope: ${checked.errors.join("; ")}`)
  }
  const value = payload.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...payload, migration: checked.value }
  }
  if (payload.migration !== undefined) {
    throw envelopeError("invalid-migration-envelope", "the payload already carries a migration envelope beside its value")
  }
  return { ...payload, value: { ...value, migration: checked.value } }
}

/**
 * The envelope a sealed payload carries, validated: inside an object `value`, beside a string
 * one — `undefined` when neither slot holds a valid envelope (a malformed one must never render
 * as if it were real). A payload carrying the envelope in BOTH places is contradictory —
 * `invalid-migration-envelope`.
 */
export function readEnvelope(payload: ContextPayload): MigrationEnvelope | undefined {
  const inner = innerEnvelope(payload.value)
  const outer = payload.migration
  if (inner !== undefined && outer !== undefined) {
    throw envelopeError("invalid-migration-envelope", "the migration envelope is carried in two places")
  }
  const checked = validateMigrationEnvelope(inner !== undefined ? inner : outer)
  return checked.ok ? checked.value : undefined
}

/**
 * `(moved on YYYY-MM-DD)` — the marker every reader appends to a migrated record's original
 * attribution; the date is `migratedAt`'s day.
 */
export function movedOnSuffix(envelope: MigrationEnvelope): string {
  return `(moved on ${envelope.migratedAt.slice(0, 10)})`
}
