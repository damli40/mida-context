import { defuse } from "@mida/checkpoint"
import type { StoredCheckpoint } from "@mida/checkpoint"
import { checkAccess } from "./handoff.js"
import type { HandoffDeps } from "./handoff.js"
import { agoText } from "./hook-output.js"
import type { MidaHome } from "./home.js"
import { isSafeName } from "./queue.js"
import type { ServiceRuntime } from "./runtime.js"
import { authorNamesFor, readCheckpoints } from "./skeleton.js"

/**
 * What the UserPromptSubmit hook asks the daemon: did any OTHER session save to this project
 * since this session last saw context? The session keeps a watermark — `lastSeen`, the newest
 * checkpoint its handoff covered — in `state/lastseen/<sessionId>.json`. Checkpoints created
 * after it, minus the session's own, become a ≤600-char note: one line per authoring agent,
 * newest first. Nothing new means an empty answer and an untouched watermark, so a second
 * prompt never repeats what the first one already said.
 */

/** The whole note, header included, must fit in this — it is injected into a running prompt. */
const NOTE_LIMIT_CHARS = 600
export const WHATS_NEW_HEADER = "Mida update since you last checked:"

export type WhatsNewResult =
  | { kind: "updates"; note: string; updates: { agent: string; savedAt: string }[]; lastSeen: string }
  | { kind: "none"; lastSeen: string }
  | { kind: "refused"; reason: string }

export interface WhatsNewDeps {
  /** Same gate injections the handoff takes — a refused agent reads nothing here either. */
  checkProject?: HandoffDeps["checkProject"]
  capability?: HandoffDeps["capability"]
  isRevoked?: HandoffDeps["isRevoked"]
  /** The checkpoint read; defaults to the full protocol read. */
  read?: typeof readCheckpoints
  /** authorId (lower-case) → local agent name; defaults to authorNamesFor(runtime). */
  authorNames?: Record<string, string>
  now?: () => number
}

const lastSeenPath = (sessionId: string) => `state/lastseen/${sessionId}.json`

/**
 * The session's watermark, or "" when there is no usable record — a missing or corrupt file is
 * "never saw anything", so every foreign checkpoint counts as new once and the delivered
 * watermark then quietens later prompts.
 */
export function readLastSeen(home: MidaHome, sessionId: string | undefined): string {
  if (sessionId === undefined || !isSafeName(sessionId)) return ""
  try {
    const stored = home.readJson<{ lastSeen?: unknown }>(lastSeenPath(sessionId))
    return typeof stored?.lastSeen === "string" ? stored.lastSeen : ""
  } catch {
    return ""
  }
}

/** Written by the hook only — at session start (what the handoff covered) and after a delivered note. */
export function writeLastSeen(home: MidaHome, sessionId: string, lastSeen: string): void {
  if (!isSafeName(sessionId)) return
  home.writeSecretJson(lastSeenPath(sessionId), { lastSeen })
}

const parse = (iso: string): number => Date.parse(iso)

/** One note line per updating agent: name, age, the progress tail, the next action, new files. */
function updateLine(
  name: string,
  newest: StoredCheckpoint,
  baseline: StoredCheckpoint | undefined,
  now: number,
): string {
  const checkpoint = newest.checkpoint
  const parts: string[] = []
  const tail = checkpoint.progress.slice(-2).map(defuse)
  if (tail.length > 0) parts.push(tail.join("; "))
  if (checkpoint.nextAction !== "") parts.push(`next: ${defuse(checkpoint.nextAction)}`)
  const before = new Set(baseline?.checkpoint.artifacts ?? [])
  const files = checkpoint.artifacts.filter((a) => !before.has(a)).map(defuse)
  if (files.length > 0) parts.push(`files: ${files.join(", ")}`)
  const body = parts.length === 0 ? "saved a checkpoint" : parts.join("; ")
  return `- ${defuse(name)} (${agoText(checkpoint.createdAt, now)}): ${body}`
}

/** Header plus as many lines as fit, newest first; leftovers collapse into a count line. */
function buildNote(lines: string[]): string {
  const kept: string[] = []
  for (const line of lines) {
    if ([WHATS_NEW_HEADER, ...kept, line].join("\n").length > NOTE_LIMIT_CHARS) break
    kept.push(line)
  }
  const dropped = lines.length - kept.length
  if (dropped > 0) {
    const more = `…and ${dropped} more`
    if ([WHATS_NEW_HEADER, ...kept, more].join("\n").length <= NOTE_LIMIT_CHARS) kept.push(more)
  }
  const note = [WHATS_NEW_HEADER, ...kept].join("\n")
  return note.length <= NOTE_LIMIT_CHARS ? note : `${note.slice(0, NOTE_LIMIT_CHARS - 1)}…`
}

/**
 * The daemon side of the whats-new hook. It passes the same access gates as the handoff — a
 * refused agent gets `{ kind: "refused" }` and the daemon log records the reason. The answer
 * carries `lastSeen` only as a proposal: the hook writes it after the note reaches the model,
 * so a timed-out delivery can be re-sent by the next prompt instead of being silently dropped.
 */
export async function buildWhatsNew(
  runtime: ServiceRuntime,
  input: { agent: string; cwd: string; sessionId?: string },
  deps: WhatsNewDeps = {},
): Promise<WhatsNewResult> {
  try {
    const access = await checkAccess(runtime, { agent: input.agent, cwd: input.cwd }, deps)
    if (!access.ok) return { kind: "refused", reason: access.reason }
    const lastSeen = readLastSeen(runtime.home, input.sessionId)
    const { checkpoints } = await (deps.read ?? readCheckpoints)(runtime, input.agent, access.approval.projectId)
    const sinceMs = parse(lastSeen) // NaN when unset — every parseable createdAt is newer
    const isNew = (iso: string): boolean => {
      const at = parse(iso)
      return !Number.isNaN(at) && (Number.isNaN(sinceMs) || at > sinceMs)
    }
    // The watermark covers everything this read saw — the session's own checkpoints included:
    // they are always filtered out, so advancing past them costs nothing.
    let watermarkMs = Number.isNaN(sinceMs) ? 0 : sinceMs
    for (const cp of checkpoints) {
      const at = parse(cp.checkpoint.createdAt)
      if (!Number.isNaN(at) && at > watermarkMs) watermarkMs = at
    }
    // Per foreign author: the newest checkpoint after lastSeen is the line; the newest at-or-
    // before lastSeen is the baseline the artifact diff is measured against.
    const perAuthor = new Map<string, { newest?: StoredCheckpoint; baseline?: StoredCheckpoint }>()
    for (const cp of checkpoints) {
      if (cp.sessionId === input.sessionId) continue
      const entry = perAuthor.get(cp.authorId) ?? {}
      const at = parse(cp.checkpoint.createdAt)
      if (Number.isNaN(at)) continue
      if (isNew(cp.checkpoint.createdAt)) {
        if (entry.newest === undefined || at > parse(entry.newest.checkpoint.createdAt)) entry.newest = cp
      } else if (entry.baseline === undefined || at > parse(entry.baseline.checkpoint.createdAt)) {
        entry.baseline = cp
      }
      perAuthor.set(cp.authorId, entry)
    }
    const updates = [...perAuthor.entries()]
      .flatMap(([authorId, entry]) => (entry.newest === undefined ? [] : [{ authorId, ...entry, newest: entry.newest }]))
      .sort((a, b) => parse(b.newest.checkpoint.createdAt) - parse(a.newest.checkpoint.createdAt))
    if (updates.length === 0) return { kind: "none", lastSeen }
    const names = deps.authorNames ?? authorNamesFor(runtime)
    const now = (deps.now ?? Date.now)()
    const lines = updates.map((u) =>
      updateLine(names[u.authorId.toLowerCase()] ?? "unknown agent", u.newest, u.baseline, now),
    )
    return {
      kind: "updates",
      note: buildNote(lines),
      updates: updates.map((u) => ({
        agent: names[u.authorId.toLowerCase()] ?? "unknown agent",
        savedAt: u.newest.checkpoint.createdAt,
      })),
      lastSeen: new Date(watermarkMs).toISOString(),
    }
  } catch {
    return { kind: "refused", reason: "internal" }
  }
}
