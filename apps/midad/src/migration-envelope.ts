import type { ContextPayload } from "@mida/protocol"
import type { MigrationEnvelope } from "@mida/checkpoint"

// The type itself is declared in @mida/checkpoint beside StoredCheckpoint — the package that
// carries it cannot import from this app. Re-exported here so every midad caller imports the
// envelope, its validator and its placement helpers from one module.
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
 * A plain Error carrying `.code` — `envelope-unplaceable` and `invalid-migration-envelope` are
 * midad-level refusals, not protocol codes, so MidaError's closed union cannot carry them.
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

/**
 * Seals the envelope into a payload. A checkpoint payload's `value` IS the CheckpointEnvelope,
 * so `value.migration` is `CheckpointEnvelope.migration`; for a fact it lands beside `text` and
 * `assertedAt`. A record whose `value` is a string has nowhere to carry it without changing the
 * value's type — `envelope-unplaceable`, which Task 4's preflight turns into a refusal naming
 * the record. The input payload is never mutated.
 */
export function attachEnvelope(payload: ContextPayload, envelope: MigrationEnvelope): ContextPayload {
  const checked = validateMigrationEnvelope(envelope)
  if (!checked.ok) {
    throw envelopeError("invalid-migration-envelope", `invalid migration envelope: ${checked.errors.join("; ")}`)
  }
  if (typeof payload.value !== "object" || payload.value === null || Array.isArray(payload.value)) {
    throw envelopeError("envelope-unplaceable", "a record whose value is a string cannot carry a migration envelope without changing what it is")
  }
  return { ...payload, value: { ...payload.value, migration: checked.value } }
}

/**
 * The envelope a sealed payload carries, validated — `undefined` when the key is absent or the
 * value is not an object, and also when the envelope is present but invalid (a malformed
 * envelope must never render as if it were real).
 */
export function readEnvelope(payload: ContextPayload): MigrationEnvelope | undefined {
  const value = payload.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const checked = validateMigrationEnvelope((value as { migration?: unknown }).migration)
  return checked.ok ? checked.value : undefined
}

/**
 * `(moved on YYYY-MM-DD)` — the marker every reader appends to a migrated record's original
 * attribution; the date is `migratedAt`'s day.
 */
export function movedOnSuffix(envelope: MigrationEnvelope): string {
  return `(moved on ${envelope.migratedAt.slice(0, 10)})`
}
