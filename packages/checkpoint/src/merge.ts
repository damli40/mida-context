import type { Checkpoint } from "./schema.js"

/**
 * Where a migrated record came from — sealed inside the encrypted payload by `mida migrate`,
 * validated there (`validateMigrationEnvelope` in apps/midad) and defined here so a
 * StoredCheckpoint can carry it as an ordinary typed field. Hex fields are `0x${string}` —
 * structurally the Hex/Address template type — so this package stays dependency-free.
 */
export interface MigrationEnvelope {
  version: 1
  /** The chain the record was copied from, as a decimal string. */
  originalChainId: string
  /** The ContextRegistry the record lived on before the move. */
  originalContract: `0x${string}`
  originalRecordId: `0x${string}`
  /** The old record's on-chain manifestHash. */
  originalCommitment: `0x${string}`
  /** The old record's on-chain author id. */
  originalAuthor: `0x${string}`
  /** When the record was first written — ISO-8601. */
  originalCreatedAt: string
  /** When the move happened — ISO-8601; its day is what "(moved on …)" renders. */
  migratedAt: string
}

export interface StoredCheckpoint {
  checkpoint: Checkpoint
  projectId: string
  sessionId: string
  continuesSession: string | null
  compiledBy: string
  contextId: string
  authorId: string
  /** The chain record's namespace — the context area this checkpoint lives in. */
  namespaceId: string
  /**
   * Monad's own placement of the save — carried by every record the SDK's reads return. `at` is
   * the timestamp the chain stamped (the registry row's createdAt for a direct save, the anchor
   * block's time for a batched one); `block` and `index` are its position in the chain's order
   * (log index for a direct save, batch position for a batched one). Absent for a save the chain
   * has not placed — a pending batched save, or a fixture built by hand — and `block`/`index`
   * absent when only the stamp was recoverable. `checkpoint.createdAt` is the writer's claim and
   * never orders anything: every comparison in this file runs on this field when it exists.
   */
  chain?: { at: bigint; block?: bigint; index?: number }
  /**
   * Set only on records `mida migrate` moved here — the sealed envelope carried beside the
   * checkpoint. It is encrypted content the writer controls, so `orderTime` trusts it only
   * downward: a forged originalCreatedAt can age its own record, never make it newer.
   */
  migration?: MigrationEnvelope
}

export interface MergedHandoff {
  // The newest session in the chosen chain — the session a handoff recipient continues.
  headSessionId: string
  /**
   * The save time the handoff header reports: Monad's stamp on the newest chain-placed record
   * the merge covered, ISO-8601. `checkpoint.createdAt` is the writer's own claim and never
   * fills this — when no merged record carries a chain placement (a fixture, or a merge made
   * of hand-built records) it is null and the header says "not yet confirmed" instead.
   */
  savedAt: string | null
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
  // `authorId` is the on-chain author the chain recorded for the record — `agent` is only what
  // the checkpoint claims, so anything that names who saved must read authorId.
  provenance: { agent: string; authorId: string; createdAt: string; contextId: string; compiledBy: string }[]
  // Session chains in the same project that were NOT merged in, newest first
  // (max 5) — a throwaway one-question session must not silently replace the
  // real handoff, but it is still surfaced so the reader knows it exists.
  otherSessions: { sessionId: string; agent: string; authorId: string; lastSavedAt: string; objective: string }[]
  // True when the chosen chain's continuesSession link pointed at a session
  // with no stored checkpoints — the earlier part of the history is gone.
  missingEarlierSession: boolean
  // True when the newest hook-compiler save held fewer than half the previous
  // save's decisions+constraints — a bad compile — so the earlier save's
  // lists were restored as the base and the newer save's entries appended.
  carriedForwardFromEarlierSave: boolean
}

/**
 * The instant a checkpoint is ordered by, in milliseconds: Monad's stamp whenever the record
 * carries its chain placement — the checkpoint's own createdAt claim only when the chain never
 * placed it (pending saves never reach the merge at all; this is for hand-built records).
 * A record `mida migrate` moved sorts by min(its envelope's originalCreatedAt, that stamp):
 * the envelope is writer-controlled encrypted content, so it may only AGE the record it rides
 * on — a claim dated past the chain stamp collapses back to the stamp, and a forged "newer"
 * original can never win an ordering. A genuinely older moved record keeps its real place.
 */
export const orderTime = (s: StoredCheckpoint): number => {
  const at = s.chain === undefined ? Date.parse(s.checkpoint.createdAt) : Number(s.chain.at) * 1000
  if (s.migration === undefined) return at
  const original = Date.parse(s.migration.originalCreatedAt)
  return Number.isNaN(original) ? at : Math.min(original, at)
}

/** The ISO stamp a record is reported with — Monad's when carried, else the writer's claim. */
export const recordedAt = (s: StoredCheckpoint): string =>
  s.chain === undefined ? s.checkpoint.createdAt : new Date(Number(s.chain.at) * 1000).toISOString()

/**
 * The order Monad wrote the saves in: each record's effective instant (its chain stamp, moved
 * records lowered toward their migration envelope's originalCreatedAt — see `orderTime`), then
 * block, then log index — the contextId only ever breaks a tie between records that carry none
 * of those. A record the chain placed sorts after an unplaced one at the same instant (absent
 * fields order first); a pending save never enters this comparison — the handoff keeps it out
 * of the merge entirely.
 */
export const compareChainOrder = (a: StoredCheckpoint, b: StoredCheckpoint): number => {
  const time = orderTime(a) - orderTime(b)
  if (time !== 0) return time
  const aBlock = a.chain?.block
  const bBlock = b.chain?.block
  if (aBlock !== undefined || bBlock !== undefined) {
    if (aBlock === undefined) return -1
    if (bBlock === undefined) return 1
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1
  }
  const aIndex = a.chain?.index
  const bIndex = b.chain?.index
  if (aIndex !== undefined || bIndex !== undefined) {
    if (aIndex === undefined) return -1
    if (bIndex === undefined) return 1
    if (aIndex !== bIndex) return aIndex - bIndex
  }
  return a.contextId.localeCompare(b.contextId)
}

const byTime = compareChainOrder

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
type ListKey = "decisions" | "rejected" | "constraints" | "artifacts" | "progress"

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
  checkpoints: StoredCheckpoint[] // members, sorted by the chain's order, then contextId
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

  // Newest chain first by the chain's own order; equal placements break by contextId so input
  // order never decides. A chain counts as WORKING when any of its checkpoints has
  // real content — a session that only asked a question must not displace
  // the session that did the work.
  const byNewest = (a: SessionChain, b: SessionChain) => compareChainOrder(b.newest, a.newest)
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

  // A hook-compiler save is a full restatement, and each compile updates the
  // previous one — so when the newest save in scope is hook-compiler it alone
  // is the base for the list fields; unioning earlier saves would only re-add
  // the same entries in fresh words. Entries from LATER agent-tool saves are
  // appended, deduped. With no hook-compiler in scope the lists are the plain
  // union of every checkpoint, as before.
  let lastHook = -1
  let prevHook = -1
  for (let i = 0; i < cps.length; i++) {
    if (cps[i]!.source === "hook-compiler") {
      prevHook = lastHook
      lastHook = i
    }
  }
  // One bad compile must not lose the session's history: a newest save holding
  // fewer than half the previous save's decisions+constraints looks truncated,
  // so the earlier lists become the base and the newer save's entries append.
  const listSize = (i: number) => cps[i]!.decisions.length + cps[i]!.constraints.length
  const carriedForwardFromEarlierSave = prevHook >= 0 && listSize(lastHook) * 2 < listSize(prevHook)
  const mergedList = <K extends ListKey>(key: K): Checkpoint[K] => {
    if (lastHook < 0) return distinct(cps.flatMap((c) => c[key] as unknown[])) as Checkpoint[K]
    const baseIdx = carriedForwardFromEarlierSave ? prevHook : lastHook
    const items: unknown[] = [...cps[baseIdx]![key]]
    if (carriedForwardFromEarlierSave) items.push(...cps[lastHook]![key])
    for (let i = lastHook + 1; i < cps.length; i++) {
      if (cps[i]!.source === "agent-tool") items.push(...cps[i]![key])
    }
    return distinct(items) as Checkpoint[K]
  }

  // The header's "saved <time>" is the newest CONFIRMED stamp in the merge — the largest
  // chain.at any scoped record carries. A record with no chain placement (a hand-built one;
  // pending saves never reach the merge) cannot set it, and cannot suppress it either.
  const savedAt = scope.reduce<bigint | undefined>(
    (max, s) => (s.chain === undefined ? max : max === undefined || s.chain.at > max ? s.chain.at : max),
    undefined,
  )

  return {
    headSessionId: chosen.newest.sessionId,
    savedAt: savedAt === undefined ? null : new Date(Number(savedAt) * 1000).toISOString(),
    originalRequest: cps.find((c) => c.originalRequest !== null)?.originalRequest ?? null,
    objective: mergedField(cps, "objective", ""),
    remainingPlan: mergedField(cps, "remainingPlan", []),
    unresolvedIssue: mergedField(cps, "unresolvedIssue", null),
    nextAction: mergedField(cps, "nextAction", ""),
    decisions: mergedList("decisions"),
    rejected: mergedList("rejected"),
    constraints: mergedList("constraints"),
    artifacts: mergedList("artifacts"),
    progress: mergedList("progress"),
    provenance: scope.map((s) => ({ agent: s.checkpoint.agent, authorId: s.authorId, createdAt: recordedAt(s), contextId: s.contextId, compiledBy: s.compiledBy })),
    otherSessions: ordered
      .filter((c) => c !== chosen)
      .slice(0, 5)
      .map((c) => ({
        sessionId: c.newest.sessionId,
        agent: c.newest.checkpoint.agent,
        authorId: c.newest.authorId,
        lastSavedAt: recordedAt(c.newest),
        objective: c.newest.checkpoint.objective,
      })),
    missingEarlierSession: chosen.missing,
    carriedForwardFromEarlierSave,
  }
}
