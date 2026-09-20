import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { LIMITS, validateCheckpoint } from "@mida/checkpoint"
import type { Checkpoint } from "@mida/checkpoint"

export const CHECKPOINT_TYPE = "mida.checkpoint.v1"
/** Protocol limit: the encoded context value must fit in 65,536 bytes. */
export const MAX_VALUE_BYTES = 65_536

export interface CheckpointEnvelope {
  type: typeof CHECKPOINT_TYPE
  projectId: string
  sessionId: string
  continuesSession: string | null
  compiledBy: string
  checkpoint: Checkpoint
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

/**
 * Validates the checkpoint and wraps it in the v1 envelope. If the serialized envelope would exceed the byte cap,
 * the oldest progress entries are dropped first, then the oldest evidence entries, and a constraint line records how
 * many were left out. Throws when nothing removable remains and the value is still too large.
 */
export function wrapCheckpoint(input: Omit<CheckpointEnvelope, "type">): CheckpointEnvelope {
  if (typeof input?.projectId !== "string" || input.projectId === "") throw new Error("projectId must be a non-empty string")
  if (typeof input.sessionId !== "string" || input.sessionId === "") throw new Error("sessionId must be a non-empty string")
  if (input.continuesSession !== null && typeof input.continuesSession !== "string") throw new Error("continuesSession must be a string or null")
  const checked = validateCheckpoint(input.checkpoint)
  if (!checked.ok) throw new Error(`invalid checkpoint: ${checked.errors.join("; ")}`)
  const checkpoint: Checkpoint = {
    ...checked.value,
    progress: [...checked.value.progress],
    evidence: [...checked.value.evidence],
    constraints: [...checked.value.constraints],
  }
  const envelope = (): CheckpointEnvelope => ({
    type: CHECKPOINT_TYPE,
    projectId: input.projectId,
    sessionId: input.sessionId,
    continuesSession: input.continuesSession,
    compiledBy: input.compiledBy,
    checkpoint,
  })
  const bytes = () => Buffer.byteLength(JSON.stringify(envelope()))
  let droppedProgress = 0
  let droppedEvidence = 0
  const dropOldest = (): boolean => {
    if (checkpoint.progress.length > 0) {
      checkpoint.progress.shift()
      droppedProgress += 1
      return true
    }
    if (checkpoint.evidence.length > 0) {
      checkpoint.evidence.shift()
      droppedEvidence += 1
      return true
    }
    return false
  }
  const marker = () => `(Mida: ${droppedProgress} progress and ${droppedEvidence} evidence entries were left out to fit the size limit)`
  while (bytes() > MAX_VALUE_BYTES && dropOldest()) { /* shrink until it fits or nothing is left to drop */ }
  if (droppedProgress + droppedEvidence > 0) {
    // The marker itself counts toward the cap, so it goes in before the last shrink pass and check.
    if (checkpoint.constraints.length >= LIMITS.maxArray) checkpoint.constraints.shift()
    checkpoint.constraints.push(marker())
    while (bytes() > MAX_VALUE_BYTES && dropOldest()) checkpoint.constraints[checkpoint.constraints.length - 1] = marker()
  }
  if (bytes() > MAX_VALUE_BYTES) {
    throw new Error(`checkpoint envelope exceeds the 65,536-byte cap even after dropping ${droppedProgress} progress and ${droppedEvidence} evidence entries`)
  }
  return envelope()
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
  return {
    type: CHECKPOINT_TYPE,
    projectId: record.projectId,
    sessionId: record.sessionId,
    continuesSession: record.continuesSession,
    compiledBy: record.compiledBy,
    checkpoint: checked.value,
  }
}
