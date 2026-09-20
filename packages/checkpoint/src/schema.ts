// Single source of truth for the checkpoint shape.
// Deterministic, no dependencies. Rejects unknown keys, enforces types,
// caps every string at 2000 chars and every array at 50 items.

export const LIMITS = { maxString: 2000, maxRequest: 6000, maxArray: 50 } as const

export type CheckpointSource = "agent-tool" | "hook-compiler"

export interface Checkpoint {
  eventId: string
  agent: string
  source: CheckpointSource
  createdAt: string
  objective: string
  originalRequest: string | null
  progress: string[]
  decisions: { decision: string; rationale: string }[]
  rejected: { approach: string; why: string }[]
  constraints: string[]
  artifacts: string[]
  unresolvedIssue: string | null
  nextAction: string
  remainingPlan: string[]
  evidence: { field: string; ref: string }[]
}

// The fields a model may write. originalRequest is excluded on purpose: it is
// copied from the transcript by code, never written by the model.
export const CONTENT_FIELDS: readonly (keyof Checkpoint)[] = [
  "objective",
  "progress",
  "decisions",
  "rejected",
  "constraints",
  "artifacts",
  "unresolvedIssue",
  "nextAction",
  "remainingPlan",
  "evidence",
]

const SOURCES = new Set<string>(["agent-tool", "hook-compiler"])
const ALL_KEYS = new Set<string>(["eventId", "agent", "source", "createdAt", ...CONTENT_FIELDS, "originalRequest"])

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function str(v: unknown, path: string, errors: string[], { required = false } = {}) {
  if (typeof v !== "string") {
    errors.push(`${path}: expected string, got ${v === null ? "null" : typeof v}`)
    return
  }
  if (required && v.trim() === "") errors.push(`${path}: must be non-empty`)
  if (v.length > LIMITS.maxString) errors.push(`${path}: string exceeds ${LIMITS.maxString} chars`)
}

function strList(v: unknown, path: string, errors: string[]) {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected array, got ${typeof v}`)
    return
  }
  if (v.length > LIMITS.maxArray) errors.push(`${path}: array exceeds ${LIMITS.maxArray} items`)
  v.forEach((item, i) => str(item, `${path}[${i}]`, errors))
}

function pairList(v: unknown, path: string, keys: readonly string[], errors: string[]) {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected array, got ${typeof v}`)
    return
  }
  if (v.length > LIMITS.maxArray) errors.push(`${path}: array exceeds ${LIMITS.maxArray} items`)
  v.forEach((item, i) => {
    const p = `${path}[${i}]`
    if (!isObj(item)) {
      errors.push(`${p}: expected object`)
      return
    }
    for (const k of Object.keys(item)) {
      if (!keys.includes(k)) errors.push(`${p}.${k}: unknown key`)
    }
    for (const k of keys) str(item[k], `${p}.${k}`, errors)
  })
}

// Validates a full checkpoint record. `createdAt` is required here (the
// caller that stores the checkpoint stamps it before validating).
export function validateCheckpoint(
  input: unknown,
): { ok: true; value: Checkpoint } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ["checkpoint: expected object"] }

  for (const k of Object.keys(input)) {
    if (!ALL_KEYS.has(k)) errors.push(`${k}: unknown top-level key`)
  }

  str(input.eventId, "eventId", errors, { required: true })
  if (typeof input.eventId === "string" && (input.eventId.length < 8 || input.eventId.length > 128)) {
    errors.push("eventId: must be 8-128 chars")
  }
  str(input.agent, "agent", errors, { required: true })
  if (typeof input.source !== "string" || !SOURCES.has(input.source)) {
    errors.push(`source: must be one of ${[...SOURCES].join(" | ")}`)
  }
  if (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) {
    errors.push("createdAt: must be an ISO-8601 date string")
  }

  str(input.objective, "objective", errors, { required: true })
  str(input.nextAction, "nextAction", errors, { required: true })
  if (input.originalRequest !== undefined && input.originalRequest !== null) {
    if (typeof input.originalRequest !== "string") {
      errors.push(`originalRequest: expected string or null, got ${typeof input.originalRequest}`)
    } else if (input.originalRequest.length > LIMITS.maxRequest) {
      errors.push(`originalRequest: string exceeds ${LIMITS.maxRequest} chars`)
    }
  }
  for (const k of ["progress", "constraints", "artifacts", "remainingPlan"]) {
    strList(input[k] ?? [], k, errors)
  }
  pairList(input.decisions ?? [], "decisions", ["decision", "rationale"], errors)
  pairList(input.rejected ?? [], "rejected", ["approach", "why"], errors)
  pairList(input.evidence ?? [], "evidence", ["field", "ref"], errors)
  if (input.unresolvedIssue !== undefined && input.unresolvedIssue !== null) {
    str(input.unresolvedIssue, "unresolvedIssue", errors)
  }

  if (errors.length) return { ok: false, errors }
  const value: Checkpoint = {
    eventId: input.eventId as string,
    agent: input.agent as string,
    source: input.source as CheckpointSource,
    createdAt: input.createdAt as string,
    objective: input.objective as string,
    nextAction: input.nextAction as string,
    originalRequest: (input.originalRequest ?? null) as string | null,
    unresolvedIssue: (input.unresolvedIssue ?? null) as string | null,
    progress: (input.progress ?? []) as string[],
    decisions: (input.decisions ?? []) as Checkpoint["decisions"],
    rejected: (input.rejected ?? []) as Checkpoint["rejected"],
    constraints: (input.constraints ?? []) as string[],
    artifacts: (input.artifacts ?? []) as string[],
    remainingPlan: (input.remainingPlan ?? []) as string[],
    evidence: (input.evidence ?? []) as Checkpoint["evidence"],
  }
  return { ok: true, value }
}
