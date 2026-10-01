// Single source of truth for the checkpoint shape.
// Deterministic, no dependencies. Rejects unknown keys, enforces types,
// caps every string at 2000 chars and every array at 50 items.

export const LIMITS = { maxString: 2000, maxRequest: 6000, maxArray: 50 } as const

/**
 * Cuts `text` to at most `max` UTF-16 units ending in "…". A plain slice can land between the
 * two halves of a surrogate pair and store a broken emoji — when the cut would end on a high
 * surrogate, one more unit goes so the character stays whole. Returns `text` unchanged when it
 * already fits.
 */
export function cutText(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const code = head.charCodeAt(head.length - 1)
  return `${code >= 0xd800 && code <= 0xdbff ? head.slice(0, -1) : head}…`
}

/**
 * The lists whose front entries a compile may leave out when a list passes the array cap — the
 * standing rules a handoff still shows, so a silent loss would keep a dropped rule invisible.
 * `progress`, `artifacts`, `remainingPlan` and `evidence` are cut too, but they are history and
 * earn no note.
 */
export type LimitList = "constraints" | "decisions" | "rejected"

const LIMIT_LIST_ORDER: readonly LimitList[] = ["constraints", "decisions", "rejected"]

const LIMIT_LIST_WORD: Record<LimitList, string> = {
  constraints: "constraints",
  decisions: "decisions",
  rejected: "rejected approaches",
}

/**
 * The note a checkpoint's unresolvedIssue carries when a compile left oldest entries out of a
 * capped list. It names the LISTS, never a count — a number can only go stale (a save that puts
 * an entry back would keep repeating a lie), and nothing in this wording can be inflated by
 * model text. `null` when no list lost entries.
 */
export function limitNote(lists: ReadonlySet<LimitList>): string | null {
  const named = LIMIT_LIST_ORDER.filter((list) => lists.has(list)).map((list) => LIMIT_LIST_WORD[list])
  if (named.length === 0) return null
  const names =
    named.length === 1
      ? named[0]!
      : named.length === 2
        ? `${named[0]} and ${named[1]}`
        : `${named[0]}, ${named[1]} and ${named[2]}`
  return `(Mida: a list holds at most ${LIMITS.maxArray} entries. Older ${names} were left out.)`
}

// A "(Mida: a list holds at most" segment runs to the next ")" — or to the end of the string
// when a size cut sliced the note before its bracket. The first ")" ends the segment, so a note
// nested inside another dies with its parent.
const LIMIT_NOTE_SEGMENT = /\(Mida: a list holds at most[^)]*(\)|$)/

// A well-formed note of the current wording, anywhere in the value — the whole match is the
// note, group 1 its list names. Only an exact limitNote output earns its lists back.
const LIMIT_NOTE_WELL_FORMED = /\(Mida: a list holds at most \d+ entries\. Older ([^.]*) were left out\.\)/g

// What may follow a limit note and still let it name its lists: whitespace, " | " separators,
// and other COMPLETE "(Mida: …)" notes — wrapCheckpoint appends its "(Mida: … to fit the size
// limit)" note after the limit note, and the limit note must still be read through it (UF-N).
// A note followed by any other text — an unclosed "(Mida:" included — names nothing.
const LIMIT_NOTE_TAIL = /^(?:\s|\||\(Mida:[^)]*\))*$/

/**
 * Splits an unresolvedIssue value into its free text and the lists a well-formed limit note at
 * the very END names. `text` drops every note-looking segment wherever it sits — one the model
 * forged, one a size cut left mid-word — and with each segment the ONE separator touching it:
 * the " | " (optional spaces, one pipe, optional spaces) directly before it, or if there is
 * none, the one directly after. Nothing else in the text changes — a value holding no note
 * comes back byte-for-byte, `||` and leading or trailing pipes included, because they are the
 * user's text, not our punctuation (UF-N). Only leading/trailing whitespace is trimmed at the
 * end; `text` may come back empty. `lists` is empty unless a note byte-for-byte as limitNote
 * writes it — in name order, with the real cap — is followed by nothing except whitespace,
 * separators and other complete "(Mida: …)" notes (UF-N: the size note wrapCheckpoint appends
 * after the limit note counts; any other text does not), so an old numbered note or a
 * mid-string claim names nothing.
 */
export function splitLimitNote(value: string | null): { text: string; lists: Set<LimitList> } {
  const lists = new Set<LimitList>()
  if (value === null) return { text: "", lists }
  let text = value
  for (;;) {
    const segment = LIMIT_NOTE_SEGMENT.exec(text)
    if (segment === null) break
    const before = text.slice(0, segment.index)
    const after = text.slice(segment.index + segment[0].length)
    const sepBefore = /\s*\|\s*$/.exec(before)
    if (sepBefore !== null) {
      text = before.slice(0, sepBefore.index) + after
    } else {
      const sepAfter = /^\s*\|\s*/.exec(after)
      text = before + (sepAfter === null ? after : after.slice(sepAfter[0].length))
    }
  }
  text = text.trim()
  let last: RegExpExecArray | null = null
  for (let m = LIMIT_NOTE_WELL_FORMED.exec(value); m !== null; m = LIMIT_NOTE_WELL_FORMED.exec(value)) last = m
  if (last !== null && LIMIT_NOTE_TAIL.test(value.slice(last.index + last[0].length))) {
    const named = new Set<LimitList>()
    for (const word of last[1]!.split(/, | and /)) {
      const list = LIMIT_LIST_ORDER.find((l) => LIMIT_LIST_WORD[l] === word)
      if (list !== undefined) named.add(list)
    }
    if (last[0] === limitNote(named)) for (const list of named) lists.add(list)
  }
  return { text, lists }
}

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

/**
 * Evidence names its target by position ("decisions[3]", "decisions[3].rationale"). When `dropped`
 * entries leave the FRONT of `list`, every later entry moves down by that many — so evidence for a
 * dropped entry is removed and the rest is re-pointed. Without this, each remaining evidence line
 * would vouch for a different entry than the one it was written for (CAP-29). Returns a new array;
 * anything that is not an evidence object passes through for the validator to reject.
 */
export function repointEvidence<T>(evidence: readonly T[], list: string, dropped: number): T[] {
  if (dropped <= 0) return [...evidence]
  const out: T[] = []
  for (const entry of evidence) {
    const field = isObj(entry) ? entry.field : undefined
    if (typeof field !== "string" || !field.startsWith(`${list}[`)) {
      out.push(entry)
      continue
    }
    const close = field.indexOf("]", list.length + 1)
    const digits = close === -1 ? "" : field.slice(list.length + 1, close)
    if (!/^\d+$/.test(digits)) {
      out.push(entry)
      continue
    }
    const index = Number(digits)
    if (index < dropped) continue
    out.push({ ...(entry as object), field: `${list}[${index - dropped}]${field.slice(close + 1)}` } as T)
  }
  return out
}

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
  // Date.parse alone is too lenient — it accepts "2026", "1" and
  // "March 3 2020". The timestamp must be actual ISO-8601 AND parse.
  if (
    typeof input.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(input.createdAt) ||
    Number.isNaN(Date.parse(input.createdAt))
  ) {
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
