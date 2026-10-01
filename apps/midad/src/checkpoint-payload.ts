import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { LIMITS, cutText, repointEvidence, validateCheckpoint } from "@mida/checkpoint"
import type { Checkpoint, MigrationEnvelope } from "@mida/checkpoint"
import { validateMigrationEnvelope } from "./migration-envelope.js"
import { DEFAULT_TASK, isTaskName } from "./task.js"

export const CHECKPOINT_TYPE = "mida.checkpoint.v1"
/**
 * The protocol caps the canonical JSON of the whole ContextPayload at 65,536 bytes; the envelope
 * the checkpoint fills is about 147 bytes smaller, so the envelope cap keeps 256 bytes of headroom.
 */
export const MAX_VALUE_BYTES = 65_536 - 256

/** Stable failure codes the drainer maps onto its permanent/transient retry rules. */
export type PayloadErrorCode = "too-large" | "invalid-checkpoint"

export class CheckpointPayloadError extends Error {
  readonly code: PayloadErrorCode
  /** Leading field paths from the validator — names only, never values; safe for logs. */
  readonly fields?: string[]
  /** A bounded, already-scrubbed prefix of the provider's last answer — the compiler supplies it. */
  readonly sample?: string
  constructor(code: PayloadErrorCode, message: string, fields?: string[], sample?: string) {
    super(message)
    this.name = "CheckpointPayloadError"
    this.code = code
    this.fields = fields
    this.sample = sample
  }
}

/** "decisions[3].rationale: expected string, got number" → "decisions[3].rationale" — the loggable part only. */
export function fieldPathsFromErrors(errors: string[]): string[] {
  return [...new Set(errors.map((e) => e.split(":")[0]!))]
}

export interface CheckpointEnvelope {
  type: typeof CHECKPOINT_TYPE
  projectId: string
  sessionId: string
  continuesSession: string | null
  compiledBy: string
  checkpoint: Checkpoint
  /**
   * Which named task this checkpoint belongs to (tk-1). Content, not identity: it lives inside
   * the sealed envelope and touches nothing on chain — not the record id, the grants, or the
   * namespace. Omitted entirely for `main` (and on every pre-tasks record), so a save that names
   * no task serializes byte-for-byte as it always did, and a missing field reads as `main`.
   */
  task?: string
  /**
   * Where the record came from — set only on records `mida migrate` moved here, sealed beside
   * the checkpoint. Omitted entirely on ordinary saves, so their bytes never change.
   */
  migration?: MigrationEnvelope
}

/**
 * The save ID. It hashes the transcript's byte length and last line — never the text — so it changes whenever the
 * transcript grows and is identical on a retry of the same transcript (spike bug F1).
 */
export function eventIdFor(input: { projectId: string; sessionId: string; transcriptBytes: number; lastLine: string }): string {
  const lastLineHash = bytesToHex(sha256(utf8ToBytes(input.lastLine)))
  const digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify([input.projectId, input.sessionId, input.transcriptBytes, lastLineHash]))))
  return `cp-${digest.slice(0, 40)}`
}

// The order in which a too-big checkpoint gives things up: oldest progress first (each taking its own
// evidence with it), then evidence,
// artifacts, rejected and decisions. originalRequest, remainingPlan, nextAction and objective are
// never dropped or cut — they are what make a handoff usable.
const DROPPABLE = ["progress", "evidence", "artifacts", "rejected", "decisions"] as const
const CUT_TO = 300

/**
 * A present migration envelope is validated like the checkpoint itself: an invalid one rejects
 * the whole write with invalid-checkpoint naming the field — the envelope is provenance, and
 * half of it must not save.
 */
function checkedMigration(migration: unknown): MigrationEnvelope | undefined {
  if (migration === undefined) return undefined
  const checked = validateMigrationEnvelope(migration)
  if (!checked.ok) {
    throw new CheckpointPayloadError("invalid-checkpoint", `invalid migration envelope: ${checked.errors.join("; ")}`, fieldPathsFromErrors(checked.errors))
  }
  return checked.value
}

/**
 * Appends a "(Mida: …)" note to `unresolvedIssue` so every note in the field stays whole: when
 * the join would pass the string cap, the free text before the first " | (Mida:" is what
 * shortens — dropped, with its separator, when nothing of it would remain. (UF-K: a note pushed
 * the field past 2,000 chars and the stored save then failed validation on read — invisible.)
 */
function joinIssueNote(issue: string | null, note: string): string {
  if (issue === null) return note
  const joined = `${issue} | ${note}`
  if (joined.length <= LIMITS.maxString) return joined
  const first = issue.indexOf(" | (Mida:")
  const notes = `${first === -1 ? "" : issue.slice(first)} | ${note}`
  const head = first === -1 ? issue : issue.slice(0, first)
  const room = LIMITS.maxString - notes.length
  const kept = room <= 0 ? "" : cutText(head, room)
  return kept === "" ? notes.slice(3) : `${kept}${notes}`
}

/**
 * Validates the checkpoint and wraps it in the v1 envelope. If the serialized envelope would exceed
 * the byte cap, the checkpoint is shrunk in the DROPPABLE order — oldest entries first — and any
 * string still longer than 300 chars outside the protected fields is cut to 300 with an ellipsis.
 * A `(Mida: …)` note records every field that lost content: it goes on the end of constraints, or —
 * when constraints already holds the maximum — is appended to unresolvedIssue, never by deleting a
 * real constraint. Throws CheckpointPayloadError("too-large") when nothing can shrink it further.
 */
export function wrapCheckpoint(input: Omit<CheckpointEnvelope, "type">): CheckpointEnvelope {
  if (typeof input?.projectId !== "string" || input.projectId === "") throw new Error("projectId must be a non-empty string")
  if (typeof input.sessionId !== "string" || input.sessionId === "") throw new Error("sessionId must be a non-empty string")
  if (input.continuesSession !== null && typeof input.continuesSession !== "string") throw new Error("continuesSession must be a string or null")
  const checked = validateCheckpoint(input.checkpoint)
  if (!checked.ok) {
    throw new CheckpointPayloadError("invalid-checkpoint", `invalid checkpoint: ${checked.errors.join("; ")}`, fieldPathsFromErrors(checked.errors))
  }
  const migration = checkedMigration(input.migration)
  // a task name is validated like the rest of the envelope — and normalized: `main` is the empty
  // state, so it serializes as no field at all and stays byte-identical with a task-less save
  const task = input.task === undefined ? undefined : isTaskName(input.task) ? input.task : undefined
  if (input.task !== undefined && task === undefined) {
    throw new CheckpointPayloadError("invalid-checkpoint", `invalid task name: ${JSON.stringify(input.task)}`, ["task"])
  }
  const checkpoint: Checkpoint = {
    ...checked.value,
    progress: [...checked.value.progress],
    evidence: [...checked.value.evidence],
    artifacts: [...checked.value.artifacts],
    rejected: [...checked.value.rejected],
    decisions: [...checked.value.decisions],
    constraints: [...checked.value.constraints],
    remainingPlan: [...checked.value.remainingPlan],
  }
  const envelope = (): CheckpointEnvelope => ({
    type: CHECKPOINT_TYPE,
    projectId: input.projectId,
    sessionId: input.sessionId,
    continuesSession: input.continuesSession,
    compiledBy: input.compiledBy,
    checkpoint,
    ...(task === undefined || task === DEFAULT_TASK ? {} : { task }),
    ...(migration === undefined ? {} : { migration }),
  })
  const bytes = () => Buffer.byteLength(JSON.stringify(envelope()))

  const dropped = new Map<string, number>()
  const dropOldest = (): boolean => {
    for (const field of DROPPABLE) {
      if (checkpoint[field].length === 0) continue
      checkpoint[field].shift()
      dropped.set(field, (dropped.get(field) ?? 0) + 1)
      if (field !== "evidence") {
        // evidence names its target by position ("progress[3]"): follow the entries that just moved
        // down one, and let go of the evidence for the entry that left (CAP-29)
        const kept = repointEvidence(checkpoint.evidence, field, 1)
        const gone = checkpoint.evidence.length - kept.length
        if (gone > 0) dropped.set("evidence", (dropped.get("evidence") ?? 0) + gone)
        checkpoint.evidence = kept
      }
      return true
    }
    return false
  }
  while (bytes() > MAX_VALUE_BYTES && dropOldest()) { /* shrink until it fits or nothing is left to drop */ }

  const trimmed = new Set<string>()
  const cut = (field: string, text: string): string => {
    if (text.length <= CUT_TO) return text
    trimmed.add(field)
    return cutText(text, CUT_TO + 1) // CUT_TO units plus the ellipsis — never a split surrogate
  }
  if (bytes() > MAX_VALUE_BYTES) {
    checkpoint.agent = cut("agent", checkpoint.agent)
    checkpoint.constraints = checkpoint.constraints.map((c) => cut("constraints", c))
    if (checkpoint.unresolvedIssue !== null) checkpoint.unresolvedIssue = cut("unresolvedIssue", checkpoint.unresolvedIssue)
  }

  if (dropped.size > 0 || trimmed.size > 0) {
    const parts: string[] = []
    if (dropped.size > 0) parts.push(`left out ${[...dropped.entries()].map(([field, n]) => `${n} ${field}`).join(", ")}`)
    if (trimmed.size > 0) parts.push(`cut long strings in ${[...trimmed].join(", ")}`)
    const note = `(Mida: ${parts.join("; ")} to fit the size limit)`
    // The note itself counts toward the cap — but it is appended, never swapped for a real constraint.
    if (checkpoint.constraints.length < LIMITS.maxArray) {
      checkpoint.constraints.push(note)
    } else {
      checkpoint.unresolvedIssue = joinIssueNote(checkpoint.unresolvedIssue, note)
    }
    // the note costs bytes too — drop whatever else can go before giving up
    while (bytes() > MAX_VALUE_BYTES && dropOldest()) { /* keep shrinking */ }
  }
  if (bytes() > MAX_VALUE_BYTES) {
    const what = [...dropped.entries()].map(([field, n]) => `${n} ${field}`).join(", ") || "nothing"
    throw new CheckpointPayloadError("too-large", `checkpoint envelope exceeds the ${MAX_VALUE_BYTES}-byte cap even after dropping ${what}`)
  }
  // A save must never be stored in a form that cannot be read back: the shrink steps above edit
  // the checkpoint after the input validation, so the result is validated once more (UF-K).
  const final = envelope()
  const rechecked = validateCheckpoint(final.checkpoint)
  if (!rechecked.ok) {
    throw new CheckpointPayloadError("invalid-checkpoint", `invalid checkpoint: ${rechecked.errors.join("; ")}`, fieldPathsFromErrors(rechecked.errors))
  }
  return final
}

/** Reads back a v1 envelope. Anything else — wrong type, missing field, invalid checkpoint — is null, never a throw. */
export function unwrapCheckpoint(value: unknown): CheckpointEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type !== CHECKPOINT_TYPE) return null
  if (typeof record.projectId !== "string" || record.projectId === "") return null
  if (typeof record.sessionId !== "string" || record.sessionId === "") return null
  if (record.continuesSession !== null && typeof record.continuesSession !== "string") return null
  if (typeof record.compiledBy !== "string") return null
  const checked = validateCheckpoint(record.checkpoint)
  if (!checked.ok) return null
  // absent reads as `main`; a present-but-invalid name makes the whole record unreadable rather
  // than silently filing a named checkpoint under the default task
  let task: string | undefined
  if (record.task !== undefined) {
    if (!isTaskName(record.task)) return null
    if (record.task !== DEFAULT_TASK) task = record.task
  }
  let migration: MigrationEnvelope | undefined
  if (record.migration !== undefined) {
    const checkedEnvelope = validateMigrationEnvelope(record.migration)
    if (!checkedEnvelope.ok) return null
    migration = checkedEnvelope.value
  }
  return {
    type: CHECKPOINT_TYPE,
    projectId: record.projectId,
    sessionId: record.sessionId,
    continuesSession: record.continuesSession,
    compiledBy: record.compiledBy,
    checkpoint: checked.value,
    ...(task === undefined ? {} : { task }),
    ...(migration === undefined ? {} : { migration }),
  }
}
