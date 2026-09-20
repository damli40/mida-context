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
}

const byTime = (a: StoredCheckpoint, b: StoredCheckpoint) =>
  Date.parse(a.checkpoint.createdAt) - Date.parse(b.checkpoint.createdAt)

function distinct<T>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function latest<T>(values: T[], isEmpty: (v: T) => boolean, fallback: T): T {
  for (let i = values.length - 1; i >= 0; i -= 1) if (!isEmpty(values[i]!)) return values[i]!
  return fallback
}

export function mergeCheckpoints(all: readonly StoredCheckpoint[]): MergedHandoff | null {
  if (all.length === 0) return null
  if (new Set(all.map((s) => s.projectId)).size !== 1) throw new Error("mergeCheckpoints needs checkpoints from one project")
  const sorted = [...all].sort(byTime)
  const sessions = new Set<string>()
  let cursor: string | null = sorted[sorted.length - 1]!.sessionId
  while (cursor !== null && !sessions.has(cursor)) {
    sessions.add(cursor)
    const first = sorted.find((s) => s.sessionId === cursor)
    cursor = first?.continuesSession ?? null
  }
  const scope = sorted.filter((s) => sessions.has(s.sessionId))
  const cps = scope.map((s) => s.checkpoint)
  return {
    originalRequest: cps.find((c) => c.originalRequest !== null)?.originalRequest ?? null,
    objective: latest(cps.map((c) => c.objective), (v) => v === "", ""),
    remainingPlan: latest(cps.map((c) => c.remainingPlan), (v) => v.length === 0, []),
    unresolvedIssue: latest(cps.map((c) => c.unresolvedIssue), (v) => v === null || v === "", null),
    nextAction: latest(cps.map((c) => c.nextAction), (v) => v === "", ""),
    decisions: distinct(cps.flatMap((c) => c.decisions)),
    rejected: distinct(cps.flatMap((c) => c.rejected)),
    constraints: distinct(cps.flatMap((c) => c.constraints)),
    artifacts: distinct(cps.flatMap((c) => c.artifacts)),
    progress: distinct(cps.flatMap((c) => c.progress)),
    provenance: scope.map((s) => ({ agent: s.checkpoint.agent, createdAt: s.checkpoint.createdAt, contextId: s.contextId, compiledBy: s.compiledBy })),
  }
}
