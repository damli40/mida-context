import type { Checkpoint } from "./schema.js"

export interface StoredCheckpoint {
  checkpoint: Checkpoint
  projectId: string
  sessionId: string
  continuesSession: string | null
  compiledBy: string
  contextId: string
  authorId: string
}

export interface MergedHandoff {
  originalRequest: string | null
  objective: string
  remainingPlan: string[]
  unresolvedIssue: string | null
  nextAction: string
  decisions: Checkpoint["decisions"]
  rejected: Checkpoint["rejected"]
  constraints: string[]
  artifacts: string[]
  progress: string[]
  provenance: { agent: string; createdAt: string; contextId: string; compiledBy: string }[]
  // Session chains in the same project that were NOT merged in, newest first
  // (max 5) — a throwaway one-question session must not silently replace the
  // real handoff, but it is still surfaced so the reader knows it exists.
  otherSessions: { sessionId: string; agent: string; lastSavedAt: string; objective: string }[]
  // True when the chosen chain's continuesSession link pointed at a session
  // with no stored checkpoints — the earlier part of the history is gone.
  missingEarlierSession: boolean
}

const byTime = (a: StoredCheckpoint, b: StoredCheckpoint) =>
  Date.parse(a.checkpoint.createdAt) - Date.parse(b.checkpoint.createdAt) ||
  a.contextId.localeCompare(b.contextId)

// Dedupe key: JSON with object keys sorted, so two items that differ only in
// key order ({decision, rationale} vs {rationale, decision}) collapse to one.
function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`)
    .join(",")}}`
}

function distinct<T>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = stableKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function latest<T>(values: T[], isEmpty: (v: T) => boolean, fallback: T): T {
  for (let i = values.length - 1; i >= 0; i -= 1) if (!isEmpty(values[i]!)) return values[i]!
  return fallback
}

type ScalarKey = "objective" | "remainingPlan" | "unresolvedIssue" | "nextAction"

const isEmptyField = (v: string | string[] | null): boolean =>
  v === null || v === "" || (Array.isArray(v) && v.length === 0)

/**
 * A hook-compiler checkpoint is a FULL restatement of the session — its empty
 * fields are real information ("the plan is finished", "the issue is
 * resolved"), not missing data. An agent-tool checkpoint may be a delta, so
 * only its non-empty fields override. Rule: the latest hook-compiler in scope
 * is the base; later agent-tool checkpoints patch it field by field. With no
 * hook-compiler in scope, or when the result would leave a required field
 * empty, fall back to the latest non-empty value.
 */
function mergedField<K extends ScalarKey>(cps: Checkpoint[], key: K, fallback: Checkpoint[K]): Checkpoint[K] {
  let lastHook = -1
  for (let i = 0; i < cps.length; i++) if (cps[i]!.source === "hook-compiler") lastHook = i
  const latestNonEmpty = (): Checkpoint[K] => {
    for (let i = cps.length - 1; i >= 0; i--) if (!isEmptyField(cps[i]![key])) return cps[i]![key]
    return fallback
  }
  if (lastHook < 0) return latestNonEmpty()
  let value = cps[lastHook]![key]
  for (let i = lastHook + 1; i < cps.length; i++) {
    const c = cps[i]!
    if (c.source === "agent-tool" && !isEmptyField(c[key])) value = c[key]
  }
  if ((key === "objective" || key === "nextAction") && value === "") return latestNonEmpty()
  return value
}

interface SessionChain {
  checkpoints: StoredCheckpoint[] // members, sorted by createdAt then contextId
  newest: StoredCheckpoint
  missing: boolean // a continuesSession link pointed at a session with no checkpoints
}

export function mergeCheckpoints(all: readonly StoredCheckpoint[]): MergedHandoff | null {
  if (all.length === 0) return null
  if (new Set(all.map((s) => s.projectId)).size !== 1) throw new Error("mergeCheckpoints needs checkpoints from one project")
  const sorted = [...all].sort(byTime)

  // Session → every session it claims to continue. The link can sit on ANY of
  // a session's checkpoints, not only its earliest — a continuation recorded
  // on a session's second save still joins the chain.
  const bySession = new Map<string, StoredCheckpoint[]>()
  const links = new Map<string, Set<string>>()
  const targeted = new Set<string>()
  for (const s of sorted) {
    const list = bySession.get(s.sessionId)
    if (list) list.push(s)
    else bySession.set(s.sessionId, [s])
    if (s.continuesSession !== null) {
      const set = links.get(s.sessionId) ?? new Set<string>()
      set.add(s.continuesSession)
      links.set(s.sessionId, set)
      targeted.add(s.continuesSession)
    }
  }

  // A chain is a head session plus every session reachable by following its
  // continuation links backwards. Heads are sessions nothing continues from;
  // a pure continuation cycle has no head, so a second pass picks up whatever
  // was left over. Both are cycle-safe via `visited`.
  const visited = new Set<string>()
  const chains: SessionChain[] = []
  const buildChain = (head: string) => {
    const checkpoints: StoredCheckpoint[] = []
    let missing = false
    const queue = [head]
    while (queue.length > 0) {
      const sid = queue.shift()!
      if (visited.has(sid)) continue
      visited.add(sid)
      const cps = bySession.get(sid)
      if (cps === undefined) {
        missing = true
        continue
      }
      checkpoints.push(...cps)
      for (const next of links.get(sid) ?? []) if (!visited.has(next)) queue.push(next)
    }
    checkpoints.sort(byTime)
    chains.push({ checkpoints, newest: checkpoints[checkpoints.length - 1]!, missing })
  }
  for (const s of sorted) if (!visited.has(s.sessionId) && !targeted.has(s.sessionId)) buildChain(s.sessionId)
  for (const s of sorted) if (!visited.has(s.sessionId)) buildChain(s.sessionId)

  // Newest chain first; equal timestamps break by contextId so input order
  // never decides. A chain counts as WORKING when any of its checkpoints has
  // real content — a session that only asked a question must not displace
  // the session that did the work.
  const byNewest = (a: SessionChain, b: SessionChain) =>
    Date.parse(b.newest.checkpoint.createdAt) - Date.parse(a.newest.checkpoint.createdAt) ||
    a.newest.contextId.localeCompare(b.newest.contextId)
  const isWorking = (c: SessionChain) =>
    c.checkpoints.some(
      (s) =>
        s.checkpoint.remainingPlan.length > 0 ||
        s.checkpoint.progress.length > 0 ||
        s.checkpoint.artifacts.length > 0 ||
        s.checkpoint.decisions.length > 0,
    )
  const ordered = [...chains].sort(byNewest)
  const chosen = ordered.find(isWorking) ?? ordered[0]!
  const scope = chosen.checkpoints
  const cps = scope.map((s) => s.checkpoint)
  return {
    originalRequest: cps.find((c) => c.originalRequest !== null)?.originalRequest ?? null,
    objective: mergedField(cps, "objective", ""),
    remainingPlan: mergedField(cps, "remainingPlan", []),
    unresolvedIssue: mergedField(cps, "unresolvedIssue", null),
    nextAction: mergedField(cps, "nextAction", ""),
    decisions: distinct(cps.flatMap((c) => c.decisions)),
    rejected: distinct(cps.flatMap((c) => c.rejected)),
    constraints: distinct(cps.flatMap((c) => c.constraints)),
    artifacts: distinct(cps.flatMap((c) => c.artifacts)),
    progress: distinct(cps.flatMap((c) => c.progress)),
    provenance: scope.map((s) => ({ agent: s.checkpoint.agent, createdAt: s.checkpoint.createdAt, contextId: s.contextId, compiledBy: s.compiledBy })),
    otherSessions: ordered
      .filter((c) => c !== chosen)
      .slice(0, 5)
      .map((c) => ({
        sessionId: c.newest.sessionId,
        agent: c.newest.checkpoint.agent,
        lastSavedAt: c.newest.checkpoint.createdAt,
        objective: c.newest.checkpoint.objective,
      })),
    missingEarlierSession: chosen.missing,
  }
}
