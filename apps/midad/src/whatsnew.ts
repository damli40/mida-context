import { compareChainOrder, defuse, orderTime, recordedAt } from "@mida/checkpoint"
import { MidaError } from "@mida/protocol"
import { PENDING_ANCHOR_LINE, capabilityState, checkAccess } from "./handoff.js"
import type { HandoffDeps } from "./handoff.js"
import { agoText } from "./hook-output.js"
import type { MidaHome } from "./home.js"
import { checkProject } from "./projects.js"
import type { ServiceRuntime } from "./runtime.js"
import { SEEN_MAX, readSeen } from "./seen.js"
import { authorNamesFor, readCheckpoints } from "./skeleton.js"
import type { StoredCheckpoint } from "./skeleton.js"

/**
 * What the UserPromptSubmit hook asks the daemon: did any OTHER session save to this project
 * since this session last saw context? The session keeps a set — `seen`, the foreign contextIds
 * already delivered to it or covered by its handoff — in `state/lastseen/<sessionId>.json`. A
 * foreign checkpoint whose id is not in the set is new, whenever it was compiled: checkpoints
 * are stamped at compile time but land on-chain seconds later, so a time watermark loses the
 * ones that arrive late, and another machine's slow clock must not matter either. New
 * checkpoints become a ≤600-char note: one line per authoring agent, newest first. Nothing new
 * means an empty answer and an untouched set, so a second prompt never repeats what the first
 * one already said.
 *
 * The answer always comes from the daemon's memory copy — never from a network read a prompt
 * cannot wait for (a real chain+storage read takes seconds; the hook hangs up at 1.5 s). A stale
 * or absent copy starts ONE background refresh, shared across requests, which serves the NEXT
 * prompt. The gates still run per request: the local revoke marker and the owner-signed project
 * approval are local files, and only the on-chain capability answer is reused — a "live" verdict
 * for at most CAPABILITY_REUSE_MS, a refusal never.
 */

/** The whole note, header included, must fit in this — it is injected into a running prompt. */
const NOTE_LIMIT_CHARS = 600
export const WHATS_NEW_HEADER = "Mida update since you last checked:"

/** A copy older than this refreshes behind the request that noticed — the request answers from it anyway. */
const COPY_STALE_MS = 20_000
/**
 * A "live" capability verdict may be reused for this long per (agent, projectId). What it trades:
 * a grant revoked from ANOTHER machine can leak one more ≤600-character note for up to 30 s —
 * the chain is only re-asked after this. A revoke on THIS machine cannot leak: the local marker
 * file and the re-signed project list are checked on every single request, so the next prompt
 * already refuses. A refused verdict is never stored — only "live" answers are.
 */
const CAPABILITY_REUSE_MS = 30_000
/** The copy is decrypted checkpoints in daemon memory — at most this many keys, least-recently-used out. */
const COPY_MAX_KEYS = 20
/** A failed refresh logs at most this often per key — a dead network must not spam the daemon log. */
const REFRESH_FAIL_LOG_MS = 60_000

interface CopyEntry {
  /** The decrypted list — daemon memory only, never written to disk. */
  checkpoints: StoredCheckpoint[]
  /** When the list last came from a successful read — 0 means never (always stale). */
  fetchedAt: number
  /** The shared in-flight refresh: a second request reuses it instead of starting another read. */
  inflight?: Promise<void>
  /** Refresh failures log at most once per REFRESH_FAIL_LOG_MS — this is the last time one did. */
  failLogAt: number
  /** When the chain last answered "live" for this key — reusable for CAPABILITY_REUSE_MS. */
  liveAt?: number
}

/**
 * The daemon's per-(agent, projectId) checkpoint copies. The copy holds decrypted checkpoints in
 * memory only — never on disk — and every trace of an agent is dropped the moment access is
 * refused, so a revoked agent's decrypted context leaves memory with its access.
 */
export class CheckpointCopies {
  readonly #now: () => number
  /** Insertion-ordered map: the first key is always the least recently used one. */
  readonly #entries = new Map<string, CopyEntry>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  #key(agent: string, projectId: string): string {
    return `${agent}\n${projectId}`
  }

  /** Creates-or-moves an entry to the newest end of the LRU order, evicting the coldest at the bound. */
  #entry(agent: string, projectId: string): CopyEntry {
    const key = this.#key(agent, projectId)
    let entry = this.#entries.get(key)
    if (entry === undefined) {
      entry = { checkpoints: [], fetchedAt: 0, failLogAt: 0 }
      this.#entries.set(key, entry)
      while (this.#entries.size > COPY_MAX_KEYS) {
        this.#entries.delete(this.#entries.keys().next().value as string)
      }
    } else {
      this.#entries.delete(key)
      this.#entries.set(key, entry)
    }
    return entry
  }

  /** The list this key holds — possibly stale; freshness is the caller's call. Touches the LRU order. */
  get(agent: string, projectId: string): CopyEntry | undefined {
    const key = this.#key(agent, projectId)
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry
  }

  /** A successful read replaces the list — the handoff's read and the background refresh land here. */
  seed(agent: string, projectId: string, checkpoints: StoredCheckpoint[]): void {
    const entry = this.#entry(agent, projectId)
    entry.checkpoints = checkpoints
    entry.fetchedAt = this.#now()
  }

  /**
   * A drain save teaches every copy of this project the new checkpoint at once — and creates the
   * saver's own key as a fresh copy when none exists — so the next prompt sees it with no read
   * at all. An existing entry keeps its own freshness: a stale copy stays stale (it may be missing
   * other checkpoints), it just also holds this one.
   */
  noteSaved(agent: string, checkpoint: StoredCheckpoint): void {
    const key = this.#key(agent, checkpoint.projectId)
    if (!this.#entries.has(key)) {
      const own = this.#entry(agent, checkpoint.projectId)
      own.checkpoints = [checkpoint]
      own.fetchedAt = this.#now()
    }
    for (const [otherKey, entry] of this.#entries) {
      if (!otherKey.endsWith(`\n${checkpoint.projectId}`)) continue
      if (!entry.checkpoints.some((held) => held.contextId === checkpoint.contextId)) {
        entry.checkpoints.push(checkpoint)
      }
    }
  }

  /** Whether the chain's last "live" answer for this key is still inside the reuse window. */
  capabilityLive(agent: string, projectId: string): boolean {
    const entry = this.#entries.get(this.#key(agent, projectId))
    return entry?.liveAt !== undefined && this.#now() - entry.liveAt < CAPABILITY_REUSE_MS
  }

  /** Records a "live" verdict — the only verdict ever stored. A refusal is never cached. */
  noteLive(agent: string, projectId: string): void {
    this.#entry(agent, projectId).liveAt = this.#now()
  }

  /**
   * Starts the key's one background refresh unless one is already in flight — two prompts during
   * a slow read share a single network call. A success replaces the list; a failure keeps it.
   */
  refresh(agent: string, projectId: string, work: () => Promise<StoredCheckpoint[]>, onFail: () => void): void {
    const entry = this.#entry(agent, projectId)
    if (entry.inflight !== undefined) return
    const key = this.#key(agent, projectId)
    entry.inflight = Promise.resolve()
      .then(work)
      .then(
        (checkpoints) => {
          // the copy may have been dropped (revoked) or evicted while the read ran — only land the
          // result when the slot the request opened is still the one the map holds
          if (this.#entries.get(key) === entry) {
            entry.checkpoints = checkpoints
            entry.fetchedAt = this.#now()
          }
        },
        () => {
          if (this.#entries.get(key) === entry) onFail()
        },
      )
      .finally(() => {
        entry.inflight = undefined
      })
  }

  /** True at most once a minute per key — the caller emits the line, the copy only throttles. */
  failLogDue(agent: string, projectId: string): boolean {
    const entry = this.#entry(agent, projectId)
    if (this.#now() - entry.failLogAt < REFRESH_FAIL_LOG_MS) return false
    entry.failLogAt = this.#now()
    return true
  }

  /** Every trace of the agent — lists, live verdicts, refresh bookkeeping — gone on a refusal. */
  dropAgent(agent: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(`${agent}\n`)) this.#entries.delete(key)
    }
  }

  /** Tests wait for background refreshes with this — a real request never does. */
  async idle(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.inflight))
  }
}

export type WhatsNewResult =
  | { kind: "updates"; note: string; updates: { agent: string; savedAt: string }[]; seen: string[] }
  | { kind: "none" }
  | { kind: "refused"; reason: string }

export interface WhatsNewDeps {
  /** Same gate injections the handoff takes — a refused agent reads nothing here either. */
  checkProject?: HandoffDeps["checkProject"]
  capability?: HandoffDeps["capability"]
  isRevoked?: HandoffDeps["isRevoked"]
  /** The checkpoint read — only ever a background refresh; the answer never waits for it. */
  read?: typeof readCheckpoints
  /** authorId (lower-case) → local agent name; defaults to authorNamesFor(runtime). */
  authorNames?: Record<string, string>
  now?: () => number
  /** The daemon's memory-held checkpoint copies — absent means a throwaway empty store. */
  copies?: CheckpointCopies
  /** Where refresh failures land — the daemon passes its own log; absent means silent. */
  log?: (entry: object) => void
}

// readSeen/writeSeen live in seen.ts — a leaf module the MCP adapter can import without pulling
// in this file's key-reading graph. Re-exported so index.ts and existing callers are unchanged.
export { readSeen, writeSeen } from "./seen.js"

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
  // A save the store queued but Monad has not anchored is never described as saved — it carries
  // the same marker the handoff prints, so the note claims no more than the chain has proven.
  // Pushed as a part so the "saved a checkpoint" fallback can never apply to it either.
  if (newest.anchor === "PENDING_ANCHOR") parts.push(PENDING_ANCHOR_LINE)
  const body = parts.length === 0 ? "saved a checkpoint" : parts.join("; ")
  // the age shown is Monad's stamp when the record carries one — the writer's own clock claim
  // is what renders only for a record the chain never placed
  return `- ${defuse(name)} (${agoText(recordedAt(newest), now)}): ${body}`
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
 * The daemon side of the whats-new hook — answered from the memory copy, never by awaiting the
 * read itself. It passes the same access gates as the handoff — a refused agent gets
 * `{ kind: "refused" }` and the daemon log records the reason — with one relaxation: the on-chain
 * capability verdict may be reused for CAPABILITY_REUSE_MS, because the local gates still refuse
 * a revoke made here on the very next prompt. The answer carries `seen` only as a proposal:
 * the hook writes it after the note reaches the model, so a timed-out delivery can be re-sent
 * by the next prompt instead of being silently dropped.
 */
export async function buildWhatsNew(
  runtime: ServiceRuntime,
  input: { agent: string; cwd: string; sessionId?: string },
  deps: WhatsNewDeps = {},
): Promise<WhatsNewResult> {
  try {
    const now = deps.now ?? Date.now
    const copies = deps.copies ?? new CheckpointCopies(now)
    // the capability cache is keyed (agent, projectId) — the project check produces the id first
    let projectId = ""
    const access = await checkAccess(runtime, { agent: input.agent, cwd: input.cwd }, {
      isRevoked: deps.isRevoked,
      checkProject: async (rt, i) => {
        const check = await (deps.checkProject ?? checkProject)(rt, i)
        if (check.ok) projectId = check.approval.projectId
        return check
      },
      capability: async (rt, agent) => {
        if (copies.capabilityLive(agent, projectId)) return "live"
        const state = await (deps.capability ?? capabilityState)(rt, agent)
        if (state === "live") copies.noteLive(agent, projectId)
        return state
      },
    })
    if (!access.ok) {
      // a refusal invalidates everything held for this agent — decrypted copies included
      copies.dropAgent(input.agent)
      return { kind: "refused", reason: access.reason }
    }
    const seen = readSeen(runtime.home, input.sessionId)
    const entry = copies.get(input.agent, access.approval.projectId)
    if (entry === undefined || now() - entry.fetchedAt >= COPY_STALE_MS) {
      // refresh behind the prompt's back — the old copy (or none) answers right now, and this
      // request shares the refresh a previous one already started rather than opening another
      copies.refresh(
        input.agent,
        access.approval.projectId,
        async () => {
          const result = await (deps.read ?? readCheckpoints)(runtime, input.agent, access.approval.projectId)
          // a list the store itself calls incomplete must never replace the copy — treated as a
          // failed refresh, so the last complete list keeps answering until a full one lands (M3-D)
          if (result.partial) throw new MidaError("PARTIAL_READ", "the store's list was incomplete")
          return result.checkpoints
        },
        () => {
          if (copies.failLogDue(input.agent, access.approval.projectId)) {
            deps.log?.({ event: "whatsnew-refresh-failed", agent: input.agent, projectId: access.approval.projectId })
          }
        },
      )
    }
    const checkpoints = entry?.checkpoints ?? []
    // Per foreign author: the newest checkpoint the session has NOT seen is the line; the
    // newest one it HAS seen is the baseline the artifact diff is measured against. "Newest" is
    // the record's effective instant — Monad's stamp, a moved record lowered toward its
    // envelope's originalCreatedAt — then its position in the chain's order; never the writer's
    // own createdAt claim on a chain-placed record. A record with neither can neither lead a
    // line nor serve as a baseline, but it still lands in the covered set so it is never
    // offered either.
    const perAuthor = new Map<string, { newest?: StoredCheckpoint; baseline?: StoredCheckpoint }>()
    const foreignIds: { id: string; at: number }[] = []
    for (const cp of checkpoints) {
      if (cp.sessionId === input.sessionId) continue
      const at = orderTime(cp)
      foreignIds.push({ id: cp.contextId, at: Number.isNaN(at) ? 0 : at })
      if (Number.isNaN(at)) continue
      const bucket = perAuthor.get(cp.authorId) ?? {}
      if (!seen.has(cp.contextId)) {
        if (bucket.newest === undefined || compareChainOrder(cp, bucket.newest) > 0) bucket.newest = cp
      } else if (bucket.baseline === undefined || compareChainOrder(cp, bucket.baseline) > 0) {
        bucket.baseline = cp
      }
      perAuthor.set(cp.authorId, bucket)
    }
    const updates = [...perAuthor.entries()]
      .flatMap(([authorId, bucket]) => (bucket.newest === undefined ? [] : [{ authorId, ...bucket, newest: bucket.newest }]))
      .sort((a, b) => compareChainOrder(b.newest, a.newest))
    if (updates.length === 0) return { kind: "none" }
    const names = deps.authorNames ?? authorNamesFor(runtime)
    const lines = updates.map((u) =>
      updateLine(names[u.authorId.toLowerCase()] ?? "unknown agent", u.newest, u.baseline, now()),
    )
    // the proposed set covers every foreign checkpoint this answer saw — shown in the note or
    // folded into "…and N more" — appended newest-last so the record's cap drops the oldest
    const known = new Set(seen)
    const arrived: { id: string; at: number }[] = []
    for (const f of foreignIds) {
      if (known.has(f.id)) continue
      known.add(f.id) // a duplicate record in the copy lands its id once
      arrived.push(f)
    }
    arrived.sort((a, b) => a.at - b.at)
    const proposed = [...seen, ...arrived.map((f) => f.id)].slice(-SEEN_MAX)
    return {
      kind: "updates",
      note: buildNote(lines),
      updates: updates.map((u) => ({
        agent: names[u.authorId.toLowerCase()] ?? "unknown agent",
        savedAt: recordedAt(u.newest),
      })),
      seen: proposed,
    }
  } catch {
    return { kind: "refused", reason: "internal" }
  }
}
