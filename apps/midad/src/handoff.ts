import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { isMidaError } from "@mida/protocol"
import { isReadDeadlineError } from "@mida/chain"
import { compareChainOrder, defuse, handoffHeader, mergeCheckpoints, otherTasksBlock, otherTasksFor, renderHandoffReport, taskOf } from "@mida/checkpoint"
import type { MergedHandoff, MigrationEnvelope, StoredCheckpoint } from "@mida/checkpoint"
import { chainRefusalReason } from "./chain-busy.js"
import { CHAIN_REFUSAL_TEXT, HANDOFF_BEGIN, HANDOFF_TAIL } from "./hook-output.js"
import { CODING_CLIENTS } from "./install.js"
import { isRevoked, loadAgentIdentity, loadGrants } from "./keys.js"
import { movedOnSuffix } from "./migration-envelope.js"
import { checkProject } from "./projects.js"
import type { ProjectCheck } from "./projects.js"
import { isSafeName, peekJobs, projectIdFor } from "./queue.js"
import type { CaptureJob } from "./queue.js"
import { DEFAULT_TASK, pinSessionTask, resolveSessionTask, taskOrUndefined } from "./task.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import { readUnsent } from "./unsent.js"
import { pendingAnchors, pendingPlaintext } from "./batching.js"
import { readOwnerFacts } from "./remember.js"
import type { MidaHome } from "./home.js"
import type { ServiceRuntime } from "./runtime.js"
import { isCapabilityLive, readCheckpoints } from "./skeleton.js"

/**
 * Spec §5D — what a fresh agent's session-start hook prints. One of three outcomes: the merged
 * handoff text (already fenced by render.ts), the "connected, nothing saved yet" line, or one
 * plain refusal line. A refusal is never a partial or stale handoff: any gate that cannot be
 * answered cleanly answers with a stable code instead.
 */
export type HandoffResult =
  | {
      kind: "handoff"
      text: string
      checkpoints: number
      facts: number
      factsFailed: string | null
      readMs: number
      /** The resolved name of the agent that saved the newest covered checkpoint — for the owner's line. */
      savedBy: string
      /** The newest covered checkpoint's createdAt — the point a whats-new read continues from. */
      savedAt: string
      /** The foreign contextIds this handoff covered, oldest first — the session's whats-new seen set starts here. */
      seen: string[]
      /** The render's size target — the daemon logs it next to the text's length. */
      limitChars: number
      /** The oldest entries of one or more history lists were left out so the text fits the limit — the owner sees "older entries trimmed". */
      cut: boolean
      /** Still over the size target after trimming — the owner sees "above the size target". */
      oversized: boolean
      /** The reasons behind decisions and rejected approaches were left out to fit — every entry stayed. */
      reasonsLeftOut: boolean
      /** The store's list was incomplete — the text opens with the may-be-incomplete line and the owner sees "(incomplete …)". */
      partial: boolean
    }
  | { kind: "empty"; text: string; facts: number; factsFailed: string | null; readMs: number; seen: string[]; partial: boolean }
  | { kind: "refused"; text: string; reason: string }

/** What the chain says about the agent's grants: one is live, at least one was revoked, or nothing valid remains. */
export type CapabilityState = "live" | "none" | "revoked"

export interface HandoffDeps {
  /** The read must finish inside this budget so the daemon answers before the hook's 8 s client timeout. Default 7.5 s. */
  limitMs?: number
  checkProject?: (runtime: ServiceRuntime, input: { agent: string; cwd: string }) => Promise<ProjectCheck>
  capability?: (runtime: ServiceRuntime, agent: string) => Promise<CapabilityState>
  read?: typeof readCheckpoints
  /** The owner-fact read; defaults to readOwnerFacts. A failure here degrades, never refuses. */
  readFacts?: typeof readOwnerFacts
  /**
   * "The owner revoked this agent" — the marker `mida revoke` writes into the home. Consulted
   * when the project check answers not-approved: the revoked agent's list row is gone by then,
   * so the check alone cannot tell "never approved" from "revoked" (R4-3). Defaults to the
   * real file; tests inject it.
   */
  isRevoked?: (agent: string) => boolean
  now?: () => number
}

const HANDOFF_READ_LIMIT_MS = 7_500

const notApprovedText = (agent: string): string =>
  `Mida: ${agent} is not approved for this project — run \`mida approve ${agent}\` in this folder.`
export const generalAssistanceText = (agent: string): string =>
  `Mida: ${agent} is a general assistant and cannot read project context — run \`mida install <client>\`.`

/**
 * The one question every "run `mida approve <agent>`" hint must ask first: a general-assistance
 * identity gets its whole grant at init and can never hold a project row, so approve-advice for it
 * is an endless loop. An identity that cannot be read answers false — the plain hint stands.
 */
export function isGeneralAssistant(home: MidaHome, agent: string): boolean {
  try {
    return loadAgentIdentity(home, agent)?.purposeId === "general_assistance"
  } catch {
    return false
  }
}
const revokedText = (agent: string): string =>
  `Mida: ${agent}'s access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.`
export const noIdentityText = (agent: string, homeRoot: string): string =>
  `Mida: no agent "${agent}" is set up in this Mida home (${homeRoot}). Nothing was shared.`
export const identityUnreadableText = (agent: string, homeRoot: string): string =>
  `Mida: ${agent}'s identity in this Mida home (${homeRoot}) exists but could not be read. Nothing was shared. Run \`mida doctor\`.`
const TAMPERED_TEXT = "Mida: the approved-projects list failed its signature check. Nothing was shared. Run `mida doctor`."
const UNREADABLE_TEXT = "Mida: the approved-projects list could not be read: check the file's permissions. Nothing was shared. Run `mida doctor`."
const EMPTY_TEXT = "Mida: connected. Nothing has been saved for this project yet."
/**
 * The one line a partial read adds at the top of the model text (M3-D): the store verified what it
 * served but could not check every row, so what follows may be missing context. The same sentence
 * is the whole text when nothing rendered at all.
 */
export const PARTIAL_LINE = "Some saved context could not be loaded yet; what follows may be incomplete."

/**
 * The exact line a still-pending batched save carries (Amendment B.3) — the words are the
 * contract: a PENDING_ANCHOR record is never called saved, final or verified on chain, and this
 * marker sits directly above that record's own content.
 */
export const PENDING_ANCHOR_LINE = "PENDING_ANCHOR: not yet anchored on Monad; may still be rejected"
// both fence lines are defined on the hook-output leaf so the MCP adapter's cap can reach them
// without importing this module (mcp.test.ts walks that graph)
export { HANDOFF_TAIL }

/** The queued-job scan reads at most this many files — a flooded queue costs one bounded look. */
const QUEUE_NOTE_SCAN_LIMIT = 200

/**
 * H4 — the handoff says when Mida's own newer saves have not left this machine yet. One bounded,
 * strictly read-only look at the hook queue: jobs belonging to THIS project (a folder with no
 * `.mida` marker, or a marker that cannot be read, tells us nothing and is skipped) are counted
 * per agent, and a session state showing a failed drain attempt adds the retry clause. The count
 * is distinct SESSIONS, not jobs — the drain merges a session's jobs into one save, so counting
 * jobs would overstate what is behind (in-11 R-14). The note
 * reports what is queued — it never removes, re-orders, waits on or triggers a job, and a queue
 * that cannot be read degrades to no line at all, never a refused handoff.
 */
export interface QueuedSaves {
  /** agent → its counted sessions (distinct sessions, not jobs) */
  perAgent: Map<string, Set<string>>
  /** session → its newest queued change (ms) */
  newestChange: Map<string, number>
  lastTryFailed: boolean
  /**
   * UF-QA: at least one counted session has a failed try for a reason that is NOT one of the
   * three wait reasons (attempts > 0 on another code) — so a "waiting on" clause must say
   * "some are" and name the retries still happening beside it.
   */
  otherFailures: boolean
  /**
   * Every wait reason present among the counted sessions, in WAIT_ORDER (UF-QD — the note names
   * them all): "sponsor-limit" means the gas sponsor's daily cap, which resets at 00:00 UTC;
   * the other two mean no summary model can write right now (UF-P3).
   */
  waitReasons: WaitReason[]
  stuck: number
}

/**
 * The capacity waits a session state can carry, in the order the note reports them when several
 * counted sessions wait on different reasons: the sponsor's cap first, then the summary model.
 * (UF-P3: a fixed priority, not arrival order.)
 */
type WaitReason = "sponsor-limit" | "summarizer-limit" | "no-summarizer"
const WAIT_ORDER: readonly WaitReason[] = ["sponsor-limit", "summarizer-limit", "no-summarizer"]

function readQueuedSaves(home: MidaHome, projectId: string): QueuedSaves | null {
  let jobs: CaptureJob[]
  try {
    jobs = peekJobs(home, QUEUE_NOTE_SCAN_LIMIT)
  } catch {
    return null
  }
  const perAgent = new Map<string, Set<string>>()
  let lastTryFailed = false
  let otherFailures = false
  const waitSeen = new Set<WaitReason>()
  // CAP-26: each counted session's NEWEST queued change. The drain merges a session's jobs and
  // keeps only the newest, so that is all the queue can honestly tell. The stalest of those is the
  // signal: a session with no new change for an hour that is still not on Monad is stuck.
  const newestChange = new Map<string, number>()
  for (const job of jobs) {
    if (!isSafeName(job.agent)) continue
    let jobProject: string | null
    try {
      jobProject = projectIdFor(job.cwd)
    } catch {
      continue
    }
    if (jobProject !== projectId) continue
    const sessions = perAgent.get(job.agent) ?? new Set<string>()
    sessions.add(job.sessionId)
    perAgent.set(job.agent, sessions)
    // asJob already refused a job whose `at` will not parse
    newestChange.set(job.sessionId, Math.max(newestChange.get(job.sessionId) ?? Number.NEGATIVE_INFINITY, Date.parse(job.at)))
    // the drainer records a failed try on the session's own state file — read-only, and an
    // unreadable or malformed state only loses the retry clause, never the count
    try {
      const state = home.readJson<{ attempts?: unknown; reason?: unknown; failedAt?: unknown }>(`queue/state/${job.sessionId}.json`)
      if (typeof state?.attempts === "number" && state.attempts > 0) {
        lastTryFailed = true
        // UF-QA: a failed try on a reason that is not one of the three waits still means Mida is
        // retrying that session — the "waiting on" clause must not claim every wait is the same
        if (!(WAIT_ORDER as readonly string[]).includes(state.reason as string)) otherFailures = true
      }
      // UF-O/UF-P3: a capacity wait carries no attempts — an allowance, not a failed try — so
      // it is noticed by reason + failedAt, and it never sets lastTryFailed above
      if (typeof state?.failedAt === "string" && (WAIT_ORDER as readonly string[]).includes(state.reason as string)) {
        waitSeen.add(state.reason as WaitReason)
      }
    } catch { /* keep the count, drop the clause */ }
  }
  const waitReasons = WAIT_ORDER.filter((reason) => waitSeen.has(reason))
  // in-13 M-4: a batched save the store refused as composed sits between ledgers — rejected at
  // the store, plaintext kept for the hourly retry — so no queue job names it and no
  // PENDING_ANCHOR block reaches the handoff. Its project comes from the kept plaintext's
  // envelope (the entry alone never carried one), and an unreadable plaintext only loses that
  // save's count, never the note itself. in-14 F-3: a stuck save is NOT a "newer save this
  // record may be behind" — nothing says it is newer than the record shown, and it may never
  // land at all. It gets its own short clause pointing at doctor.
  let stuck = 0
  for (const entry of pendingAnchors(home)) {
    if (entry.stuck === undefined || !isSafeName(entry.agent)) continue
    const value = pendingPlaintext(home, entry.contextId)?.value
    if (typeof value !== "object" || value === null || (value as { projectId?: unknown }).projectId !== projectId) continue
    stuck += 1
  }
  return { perAgent, newestChange, lastTryFailed, otherFailures, waitReasons, stuck }
}

/** Two queue snapshots as one: every session either saw, its newest change, any failed try. */
export function mergeQueued(a: QueuedSaves | null, b: QueuedSaves | null): QueuedSaves | null {
  if (a === null) return b
  if (b === null) return a
  const perAgent = new Map<string, Set<string>>()
  for (const q of [a, b]) {
    for (const [agent, sessions] of q.perAgent) perAgent.set(agent, new Set([...(perAgent.get(agent) ?? []), ...sessions]))
  }
  const newestChange = new Map(a.newestChange)
  for (const [session, at] of b.newestChange) newestChange.set(session, Math.max(newestChange.get(session) ?? Number.NEGATIVE_INFINITY, at))
  return {
    perAgent,
    newestChange,
    lastTryFailed: a.lastTryFailed || b.lastTryFailed,
    otherFailures: a.otherFailures || b.otherFailures,
    // the union of both lists, in the same fixed order readQueuedSaves applies (UF-QD)
    waitReasons: WAIT_ORDER.filter((reason) => a.waitReasons.includes(reason) || b.waitReasons.includes(reason)),
    stuck: Math.max(a.stuck, b.stuck),
  }
}

/**
 * The note's text for what readQueuedSaves found. `shownUnsent` is how many of the counted sessions
 * have their compiled-but-unsent save shown below, marked UNSENT (CAP-26).
 */
export function queuedSavesNote(queued: QueuedSaves | null, nowMs: number, shownUnsent: number): string | null {
  if (queued === null) return null
  const { perAgent, newestChange, lastTryFailed, otherFailures, waitReasons, stuck } = queued
  if (perAgent.size === 0 && stuck === 0) return null
  const clauses: string[] = []
  if (perAgent.size > 0) {
    const parts = [...perAgent.entries()].map(([name, sessions], index) =>
      index === 0 ? `${sessions.size} newer save${sessions.size === 1 ? "" : "s"} from ${name}` : `${sessions.size} from ${name}`,
    )
    const total = [...perAgent.values()].reduce((sum, sessions) => sum + sessions.size, 0)
    const stalest = Math.min(...newestChange.values())
    const age = ageText(nowMs - stalest)
    const clause =
      total === 1
        ? `${parts.join(", ")} has not reached Monad yet (its newest change is ${age} old); this record may be behind it`
        : `${parts.join(", ")} have not reached Monad yet (${
            age === "under a minute" ? "each changed within the last minute" : `one of them has not changed for ${age}`
          }); this record may be behind them`
    const shown =
      shownUnsent === 0
        ? ""
        : total === 1
          ? "; it is shown below, marked UNSENT"
          : `; ${shownUnsent} of them ${shownUnsent === 1 ? "is" : "are"} shown below, marked UNSENT`
    // UF-O/UF-P3: a capacity wait is an allowance or a missing model, not a failed try — its
    // clause says so and the "last try failed" clause is not added on top of it. UF-QD: every
    // wait reason present is named — one alone with no other failure keeps the plain clause,
    // otherwise each is "some are …", and when another counted session DID fail a try for a
    // different reason the clause names the retries beside the waits.
    const inner = (reason: WaitReason): string =>
      reason === "sponsor-limit"
        ? "waiting for the gas sponsor's daily limit to reset at 00:00 UTC"
        : reason === "summarizer-limit"
          ? "waiting for the model that writes Mida's summaries: it hit its usage limit"
          : "waiting: no model is set up to write Mida's summaries; the user can run mida summarizer"
    const waiting =
      waitReasons.length === 0
        ? lastTryFailed
          ? " (the last try failed; Mida keeps retrying)"
          : ""
        : waitReasons.length === 1 && !otherFailures
          ? ` (${inner(waitReasons[0]!)})`
          : ` (${waitReasons.map((reason) => `some are ${inner(reason)}`).join("; ")}${otherFailures ? "; Mida keeps retrying the others" : ""})`
    clauses.push(`${clause}${waiting}${shown}`)
  }
  if (stuck > 0) clauses.push(`${stuck} save${stuck === 1 ? "" : "s"} could not be sent to Monad: see \`mida doctor\``)
  return `Mida note: ${clauses.join(". ")}.`
}

/** An age in the note's words; a future stamp (clock skew) counts as 0. */
function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return "under a minute"
  if (minutes < 120) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h`
}

/** The generic refusal line — the only text a session-start hook prints on its own failures. */
export function noContextText(code: string): string {
  return `Mida: no context available right now (${code}).`
}

const refused = (reason: string, text: string): HandoffResult => ({ kind: "refused", reason, text })

/**
 * The refusal a failed project check carries — one mapping shared by checkAccess and the CLI's
 * `read --as <agent> projects.current` (F7): same gate, same answer. A revoked agent's project
 * row is gone, so `not-approved` consults the marker `mida revoke` left behind to say why access
 * really ended (R4-3); a marker that cannot be read leaves the not-approved answer standing.
 */
export function projectCheckRefusal(
  runtime: ServiceRuntime,
  agent: string,
  check: Exclude<ProjectCheck, { ok: true }>,
  isRevokedDep?: (name: string) => boolean,
): { reason: string; text: string } {
  if (check.reason === "list-tampered") return { reason: "list-tampered", text: TAMPERED_TEXT }
  if (check.reason === "list-unreadable") return { reason: "list-unreadable", text: UNREADABLE_TEXT }
  // a failed check names no cause the owner could act on — the generic line, not a guess
  if (check.reason === "check-failed") return { reason: "check-failed", text: noContextText("check-failed") }
  if (check.reason === "not-approved") {
    try {
      if ((isRevokedDep ?? ((name) => isRevoked(runtime.home, name)))(agent)) {
        return { reason: "revoked", text: revokedText(agent) }
      }
    } catch { /* fall through to not-approved */ }
    // A general-assistance identity can never hold a project row — telling the owner to run
    // `mida approve <agent>` would loop forever, so the line names the real fix instead: a
    // client identity provisioned by `mida install <client>`. An identity that cannot be read
    // keeps the plain not-approved answer.
    if (isGeneralAssistant(runtime.home, agent)) {
      return { reason: "general-assistance", text: generalAssistanceText(agent) }
    }
  }
  return { reason: check.reason, text: notApprovedText(agent) }
}

/**
 * Asks the chain — never a local flag — whether the agent currently holds a live capability.
 * Two chain signals both mean "revoked": a capability record marked revoked, or a granted
 * capability whose captured agent epoch the owner has moved past (the agent-level revoke
 * increments it and empties activeCapabilityIds entirely — which is why the ids to inspect
 * come from grants.json as well; grants.json only supplies WHICH ids to ask about, the chain
 * records give the verdict). Anything else — expired, superseded, never granted — is "none",
 * the not-approved refusal: if the chain cannot tell those cases apart, neither can we.
 */
export async function capabilityState(runtime: ServiceRuntime, agent: string): Promise<CapabilityState> {
  const identity = loadAgentIdentity(runtime.home, agent)
  if (identity === undefined) return "none"
  const ids = new Set(await runtime.reader.activeCapabilityIds(runtime.owner, identity.agentId))
  for (const grant of loadGrants(runtime.home, agent)) {
    for (const capability of grant.capabilities) ids.add(capability.capabilityId)
  }
  if (ids.size === 0) return "none"
  const agentEpoch = await runtime.reader.agentEpoch(runtime.owner, identity.agentId)
  // The per-id questions are independent of each other — asked together, not one at a time
  // (in-9 R-5). A live answer still wins over every other verdict, exactly as the serial loop.
  const verdicts = await Promise.all(
    [...ids].map(async (id) => {
      const live = await isCapabilityLive(runtime.chain, id)
      const capability = live ? null : await runtime.reader.getCapability(id).catch(() => null)
      return { live, capability }
    }),
  )
  if (verdicts.some((verdict) => verdict.live)) return "live"
  const sawRevoked = verdicts.some(
    ({ capability }) =>
      capability !== null && capability.owner === runtime.owner && (capability.revoked || capability.agentEpoch !== agentEpoch),
  )
  return sawRevoked ? "revoked" : "none"
}

/**
 * The gates every context read passes through, in their security order: the agent name and the
 * cwd are proven safe, then the owner-signed project list answers, and only a live chain
 * capability opens the read. The whats-new read goes through exactly this — a refused agent gets
 * nothing there either (R5-5).
 */
export type AccessCheck =
  | { ok: true; approval: Extract<ProjectCheck, { ok: true }>["approval"] }
  | { ok: false; reason: string; text: string }

export async function checkAccess(
  runtime: ServiceRuntime,
  input: { agent: string; cwd: string },
  deps: Pick<HandoffDeps, "checkProject" | "capability" | "isRevoked"> = {},
): Promise<AccessCheck> {
  const agent = input.agent
  // the name is interpolated into refusal text — only after it is proven a safe local agent name
  if (!isSafeName(agent)) return { ok: false, reason: "bad-agent", text: noContextText("bad-agent") }
  // a relative cwd would be resolved against the DAEMON's working directory — refuse it outright
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
    return { ok: false, reason: "bad-input", text: noContextText("bad-input") }
  }
  // an agent with no identity here is its own answer — never "not approved", never another
  // agent's context. Absent and unreadable are different answers: `loadAgentIdentity` is quiet
  // for a missing file AND for a stat the system refused — `home.has` uses existsSync, which
  // reports EPERM/EACCES as absent — so a real stat asks again, and only ENOENT (or a path
  // component that is not a directory) counts as "not set up". A file that is there but will
  // not load — corrupt, or a refused read — gets its own refusal, not "no agent is set up".
  let identity: ReturnType<typeof loadAgentIdentity>
  try {
    identity = loadAgentIdentity(runtime.home, agent)
  } catch {
    identity = undefined
  }
  if (identity === undefined) {
    let absent = false
    try {
      statSync(runtime.home.path(`agents/${agent}/identity.json`))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      absent = code === "ENOENT" || code === "ENOTDIR"
    }
    return absent
      ? { ok: false, reason: "no-identity", text: noIdentityText(agent, runtime.home.root) }
      : { ok: false, reason: "identity-unreadable", text: identityUnreadableText(agent, runtime.home.root) }
  }
  const check = await (deps.checkProject ?? checkProject)(runtime, { agent, cwd: input.cwd })
  if (!check.ok) return { ok: false, ...projectCheckRefusal(runtime, agent, check, deps.isRevoked) }
  const state = await (deps.capability ?? capabilityState)(runtime, agent)
  if (state === "revoked") return { ok: false, reason: "revoked", text: revokedText(agent) }
  if (state !== "live") return { ok: false, reason: "not-approved", text: notApprovedText(agent) }
  return { ok: true, approval: check.approval }
}

type ReadOutcome =
  | { status: "ok"; checkpoints: Awaited<ReturnType<typeof readCheckpoints>>["checkpoints"]; partial: boolean }
  | { status: "failed"; error: unknown }
  | { status: "slow" }

type ReadCheckpoint = Awaited<ReturnType<typeof readCheckpoints>>["checkpoints"][number]

/**
 * One pending batched save rendered as its own block: the marker line, then who wrote it, then the
 * checkpoint's own non-empty fields — the marker sits directly above the record's content (B.3).
 * "from", never "saved": the store holds it and the signature checked out, but Monad has not
 * anchored it and still may reject it.
 */
function pendingBlock(cp: ReadCheckpoint, authorNames: Record<string, string>, merged: Pick<MergedHandoff, "constraints" | "decisions" | "rejected"> | null, bare = false): string {
  const c = cp.checkpoint
  const who = authorNames[cp.authorId.toLowerCase()] ?? "unknown agent"
  const lines = [
    PENDING_ANCHOR_LINE,
    `from ${defuse(who)} at ${defuse(c.createdAt)} (session ${defuse(cp.sessionId)}, record ${defuse(cp.contextId)})`,
  ]
  const { rules, history } = checkpointFieldLines(c, merged)
  // UF-QA: a bare block keeps only its rule lines — history pays for the fit before any reason
  // does, and the count line says honestly what was left out
  lines.push(...rules)
  if (bare) {
    if (history.length > 0) lines.push(`… ${history.length} more line${history.length === 1 ? "" : "s"} of this pending save left out`)
  } else {
    lines.push(...history)
  }
  return lines.join("\n")
}

/**
 * A checkpoint's non-empty fields, one line each — shared by the marked blocks. `rules` are the
 * lines a cut must never drop (constraints first: they outrank what was decided): constraint,
 * objective, plan, next action, unresolved issue, decision and rejected-approach lines. `history`
 * is what a budget may leave out: artifact, progress and evidence lines (UF-J). When a merged
 * record renders above the block, a rule that is also in that record is left out of the block —
 * one line where the rule lines end counts what was not repeated (UF-K). With no merged record
 * (the pending-only handoff) nothing is omitted and no such line is printed.
 */
function checkpointFieldLines(
  c: ReadCheckpoint["checkpoint"],
  merged: Pick<MergedHandoff, "constraints" | "decisions" | "rejected"> | null = null,
): { rules: string[]; history: string[] } {
  // each value defused, then flattened to one line: a newline in saved text could otherwise start a
  // line identical to one of this block's own labels ("next action:", "plan step:") (Fable review)
  const one = (text: string) => defuse(text).replace(/\s*\n\s*/g, " / ")
  // a rule matches the record only as a whole entry: a constraint on its text, a decision on
  // decision AND reason, a rejected approach on approach AND why — the same decision text with
  // a different reason is a different rule and stays (UF-K). The key is a JSON pair, never a
  // plain join: "a"+"bc" equals "ab"+"c", which would omit a DIFFERENT decision as if it were
  // already shown (UF-L).
  const mergedConstraints = new Set(merged?.constraints ?? [])
  const mergedDecisions = new Set((merged?.decisions ?? []).map((d) => JSON.stringify([d.decision, d.rationale])))
  const mergedRejected = new Set((merged?.rejected ?? []).map((r) => JSON.stringify([r.approach, r.why])))
  // the count line counts DISTINCT rules the record already shows — a rule listed twice in the
  // block was still repeated once (UF-L)
  const repeated = { constraints: new Set<string>(), decisions: new Set<string>(), rejected: new Set<string>() }
  const rules: string[] = []
  for (const k of c.constraints) {
    if (mergedConstraints.has(k)) repeated.constraints.add(k)
    else rules.push(`constraint: ${one(k)}`)
  }
  if (c.objective !== "") rules.push(`objective: ${one(c.objective)}`)
  for (const step of c.remainingPlan) rules.push(`plan step: ${one(step)}`)
  if (c.nextAction !== "") rules.push(`next action: ${one(c.nextAction)}`)
  if (c.unresolvedIssue !== null && c.unresolvedIssue !== "") rules.push(`unresolved issue: ${one(c.unresolvedIssue)}`)
  for (const d of c.decisions) {
    const key = JSON.stringify([d.decision, d.rationale])
    if (mergedDecisions.has(key)) repeated.decisions.add(key)
    else rules.push(`decision: ${one(d.decision)} — because: ${one(d.rationale)}`)
  }
  for (const r of c.rejected) {
    const key = JSON.stringify([r.approach, r.why])
    if (mergedRejected.has(key)) repeated.rejected.add(key)
    else rules.push(`rejected approach: ${one(r.approach)} — ${one(r.why)}`)
  }
  const notRepeated = [
    repeated.constraints.size === 0 ? null : `${repeated.constraints.size} constraint${repeated.constraints.size === 1 ? "" : "s"}`,
    repeated.decisions.size === 0 ? null : `${repeated.decisions.size} decision${repeated.decisions.size === 1 ? "" : "s"}`,
    repeated.rejected.size === 0 ? null : `${repeated.rejected.size} rejected approach${repeated.rejected.size === 1 ? "" : "es"}`,
  ].filter((part): part is string => part !== null)
  if (notRepeated.length > 0) rules.push(`the same as in the record above, not repeated: ${notRepeated.join(", ")}`)
  const history: string[] = []
  for (const a of c.artifacts) history.push(`artifact: ${one(a)}`)
  for (const p of c.progress) history.push(`progress: ${one(p)}`)
  for (const e of c.evidence) history.push(`evidence: ${one(e.field)} — ${one(e.ref)}`)
  return { rules, history }
}

/** The marker on a save compiled on this machine but not yet on Monad (CAP-26). */
export const UNSENT_LINE =
  "UNSENT: compiled on this machine and not yet on Monad. The chain has not checked who wrote it, and it may still change or be rejected. It is here so you can pick up at once; check the current state before you act on it."

/** The whole handoff's size (the MCP tool's reply cap is 40,000; Claude Code files away context over 10,000). */
const HANDOFF_MAX_CHARS = 8_000
/** What the marked blocks may take together; the merged record keeps at least MERGED_MIN_CHARS. */
const UNSENT_TOTAL_CHARS = 3_000
const MERGED_MIN_CHARS = 4_500
/** Below this, an UNSENT block cannot say what it is and one useful field — it is not shown. */
const UNSENT_MIN_CHARS = 450

/**
 * One compiled-but-unsent save as its own marked block (CAP-26): the marker, who queued it (the
 * local job's agent name — the chain has not checked it), then its fields. UF-J: the rule lines —
 * every constraint, decision and rejected approach — are ALWAYS shown, even past the block's
 * budget; the budget only decides how many history lines (artifacts, progress, evidence) fit, and
 * the left-out count speaks of those alone.
 */
function unsentBlock(envelope: CheckpointEnvelope, agent: string, budget: number, newerBy: string | null, merged: Pick<MergedHandoff, "constraints" | "decisions" | "rejected"> | null, bare = false): string {
  const c = envelope.checkpoint
  const lines = [UNSENT_LINE, `from ${defuse(agent)} at ${defuse(c.createdAt)} (session ${defuse(envelope.sessionId)}, not verified by the chain)`]
  // after failed sends the mark keeps pointing at an older compile while the session moves on —
  // the block must not pass for the session's newest state (CAP-26 review)
  if (newerBy !== null) lines.push(`note: this session changed again after this compile (its newest change is ${newerBy} old); that newer work is not in it`)
  const { rules, history } = checkpointFieldLines(c, merged)
  lines.push(...rules)
  const more = (n: number) => `… ${n} more line${n === 1 ? "" : "s"} of this unsent save left out`
  // UF-QA: a bare block keeps no history lines at all — the whole history count rides the
  // "more" line, so the block still says honestly what it left out
  let used = lines.join("\n").length
  let shown = 0
  if (!bare) {
    for (const line of history) {
      // keep room for the "more" line whenever something will be left out
      if (used + 1 + line.length + (shown + 1 < history.length ? 1 + more(history.length).length : 0) > budget) break
      lines.push(line)
      used += 1 + line.length
      shown += 1
    }
  }
  if (shown < history.length) lines.push(more(history.length - shown))
  return lines.join("\n")
}

/**
 * The UNSENT blocks, oldest compile first, while the shared `budget` has room to start one — the
 * budget only decides whether a block begins and how many of its HISTORY lines show; a block's
 * rule lines always render whole, so a rendered block can run past what was left. A block whose
 * remaining room cannot hold its marker and one useful field is not shown — and `shown` counts
 * only the blocks rendered, so the note's "shown below" is true.
 */
function unsentBlocks(
  found: { agent: string; sessionId: string; envelope: CheckpointEnvelope; coveredAt?: number }[],
  queued: QueuedSaves | null,
  nowMs: number,
  budget: number,
  merged: Pick<MergedHandoff, "constraints" | "decisions" | "rejected"> | null,
  bare = false,
): { text: string; shown: number; lastAgent?: string; lastCreatedAt?: string } {
  const blocks: string[] = []
  let left = budget
  let lastAgent: string | undefined
  let lastCreatedAt: string | undefined
  for (const u of found) {
    const room = left - (blocks.length > 0 ? 2 : 0)
    if (room < UNSENT_MIN_CHARS) break
    const newest = queued?.newestChange.get(u.sessionId)
    // what the compile covered (the drain's transcript read); a mark from before that was recorded
    // falls back to the compile's own time, which can only miss a change, never invent one
    const covered = u.coveredAt ?? Date.parse(u.envelope.checkpoint.createdAt)
    const newerBy = newest !== undefined && !Number.isNaN(covered) && newest > covered ? ageText(nowMs - newest) : null
    const block = unsentBlock(u.envelope, u.agent, room, newerBy, merged, bare)
    blocks.push(block)
    left = room - block.length
    lastAgent = u.agent
    lastCreatedAt = u.envelope.checkpoint.createdAt
  }
  return {
    text: blocks.join("\n\n"),
    shown: blocks.length,
    ...(lastAgent === undefined ? {} : { lastAgent }),
    ...(lastCreatedAt === undefined ? {} : { lastCreatedAt }),
  }
}

/**
 * The compiled-but-unsent saves another agent may see: for each session the queue counted (it
 * still has a queued job, so its save has not landed), the session's marked envelope — skipping the
 * asking session itself, another project's, and another task's. Oldest compile first.
 */
function unsentSaves(
  home: MidaHome,
  queued: QueuedSaves | null,
  scope: { projectId: string; task: string; askingAgent: string; askingSession?: string; isRevoked: (agent: string) => boolean },
): { agent: string; sessionId: string; envelope: CheckpointEnvelope; coveredAt?: number }[] {
  if (queued === null) return []
  // An MCP caller's session id (`mcp-<agent>-…`) is never its hook session's id, so "its own save"
  // cannot be matched by session there: an MCP or session-less caller skips its own agent's saves.
  const byAgentOnly = scope.askingSession === undefined || scope.askingSession.startsWith("mcp-")
  const seen = new Set<string>()
  const found: { agent: string; sessionId: string; envelope: CheckpointEnvelope; coveredAt?: number }[] = []
  for (const [agent, sessions] of queued.perAgent) {
    if (scope.isRevoked(agent)) continue // a revoked agent's last save is never offered
    if (byAgentOnly && agent === scope.askingAgent) continue
    for (const sessionId of sessions) {
      if (sessionId === scope.askingSession || seen.has(sessionId)) continue
      seen.add(sessionId) // one session queued under two agent names is still one block
      const marked = readUnsent(home, sessionId)
      if (marked === undefined) continue
      const { envelope } = marked
      if (envelope.projectId !== scope.projectId) continue
      if ((envelope.task ?? DEFAULT_TASK) !== scope.task) continue
      found.push({ agent, sessionId, envelope, ...(marked.coveredAt === undefined ? {} : { coveredAt: marked.coveredAt }) })
    }
  }
  return found.sort((a, b) => Date.parse(a.envelope.checkpoint.createdAt) - Date.parse(b.envelope.checkpoint.createdAt))
}

type FactOutcome = { status: "ok"; facts: Awaited<ReturnType<typeof readOwnerFacts>> } | { status: "failed" } | { status: "slow" }

/**
 * The gate order is the security property: the owner-signed project list answers first and a
 * refusal there means zero further reads — no chain call, no server call. Then the chain's own
 * answer on the agent's capability, then the full protocol read, merged and rendered.
 */
export async function buildHandoff(
  runtime: ServiceRuntime,
  input: { agent: string; cwd: string; authorNames: Record<string, string>; sessionId?: string; task?: string },
  deps: HandoffDeps = {},
): Promise<HandoffResult> {
  const agent = input.agent
  try {
    const limitMs = deps.limitMs ?? HANDOFF_READ_LIMIT_MS
    // in-9 R-5: one read memo and one deadline for the whole operation — the capability gate,
    // the checkpoint read and the fact read share it, so each distinct chain question costs
    // one wire request and nothing new starts once the budget is spent. A test double built
    // as a bare `{ home }` object has no readScope and runs unscoped, exactly as before.
    const scoped = runtime.readScope?.({ deadlineMs: limitMs }) ?? runtime
    const access = await checkAccess(scoped, { agent, cwd: input.cwd }, deps)
    if (!access.ok) return refused(access.reason, access.text)
    const check = access.approval

    // tk-1, invariant 1: the session's task is resolved ONCE, here at session start — the
    // caller's explicit task (the launch's MIDA_TASK, or the deliberate `task show` name), then
    // the pin written on an earlier call, then the predecessor's, then the folder default, then
    // main. A session that names itself is pinned under state/tasks/<sid>.json — every later
    // event reads the pin, so a `mida task` switch mid-session can never migrate a live session.
    const resolved = resolveSessionTask(runtime.home, {
      sessionId: input.sessionId,
      projectId: check.projectId,
      cwd: input.cwd,
      // a malformed explicit task is treated as absent — a bad MIDA_TASK falls back to the
      // folder default; it never breaks a hook that must fail open
      explicit: taskOrUndefined(input.task),
    })
    const task = resolved.task
    if (isSafeName(input.sessionId) && resolved.source !== "session") {
      // best-effort: a failed pin only means the NEXT event re-resolves — never a refused handoff;
      // a resolution that came FROM the pin needs no write — the file provably exists already
      pinSessionTask(runtime.home, input.sessionId, check.projectId, task)
    }

    // A coding client's "current state" is concrete — its workspace — so its handoff names where
    // to check. Every other identity gets the header's generic words only. The line stays out of
    // the checkpoint package: "files" and "git" are adapter knowledge, not core vocabulary.
    const adapterNote = CODING_CLIENTS.includes(agent)
      ? "Here the current state is the files and git: check git status / git diff before changing anything."
      : undefined

    // Mida's own undelivered saves are newer work this record cannot know — one read-only count,
    // after access is granted and scoped to this project. Never a queue control.
    const now = deps.now ?? (() => Date.now())
    // CAP-26 (Fable review): the queue as it was BEFORE the read — a save that lands while the read
    // runs is missing from what the read returns AND from the queue after it; this snapshot keeps
    // the note's "this record may be behind it" for exactly that fast-switch moment
    const queuedBefore = readQueuedSaves(runtime.home, check.projectId)
    const readStarted = now()
    // `settled` never rejects, so a read that finishes or fails after the deadline is discarded
    // quietly — no unhandled rejection, and its text is never logged or rendered.
    const settled = (deps.read ?? readCheckpoints)(scoped, agent, check.projectId).then(
      (value): ReadOutcome => ({ status: "ok", checkpoints: value.checkpoints, partial: value.partial }),
      (error): ReadOutcome => ({ status: "failed", error }),
    )
    // The owner-fact read shares the deadline but degrades, never refuses: a failure here means a
    // handoff with facts: 0 and a stable code for the daemon log — unlike a checkpoint failure.
    const factSettled = (deps.readFacts ?? readOwnerFacts)(scoped, agent).then(
      (facts): FactOutcome => ({ status: "ok", facts }),
      (): FactOutcome => ({ status: "failed" }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = new Promise<ReadOutcome | FactOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: "slow" }), limitMs)
    })
    // The two reads are independent and run concurrently (R4-2): each is raced against the one
    // shared deadline, so the facts read gets the checkpoint read's leftover time, not a fresh
    // budget — and its slow/failed outcome still degrades inside the handoff.
    const [outcome, factOutcome] = await Promise.all([
      Promise.race([settled, slow]) as Promise<ReadOutcome>,
      Promise.race([factSettled, slow]) as Promise<FactOutcome>,
    ])
    clearTimeout(timer)
    const readMs = now() - readStarted

    if (outcome.status === "slow") return refused("read-slow", noContextText("read-slow"))
    if (outcome.status === "failed") {
      const error = outcome.error
      // a scope-deadline refusal IS the slow answer — it only fires once the budget is spent
      if (isReadDeadlineError(error)) return refused("read-slow", noContextText("read-slow"))
      if (isMidaError(error, "CAPABILITY_REVOKED")) return refused("revoked", revokedText(agent))
      if (isMidaError(error, "CAPABILITY_DENIED") || isMidaError(error, "CAPABILITY_EXPIRED")) {
        return refused("not-approved", notApprovedText(agent))
      }
      // the chain could not be ASKED — a refusal, but it names the real cause (a busy,
      // misconfigured or refused-key RPC), never "not approved" (in-11 R-8)
      const chainReason = chainRefusalReason(error)
      if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
      return refused("read-failed", noContextText("read-failed"))
    }
    const facts = factOutcome.status === "ok" ? factOutcome.facts : []
    const factsFailed = factOutcome.status === "ok" ? null : factOutcome.status === "slow" ? "facts-read-slow" : "facts-read-failed"
    // tk-1: this handoff is the session task's thread ONLY — another task's checkpoint never
    // enters the merge, the pending blocks or any rendered field. Foreign tasks contribute one
    // awareness line each and nothing more (invariant 3). `taskOf` applies the absent-is-main
    // rule, so records from before tasks exist all land in `main`.
    const inTask = (cp: StoredCheckpoint) => taskOf(cp) === task
    // The other tasks' newest checkpoint each — awareness, not context: name, last saver, age.
    // One shared computation (in-19): the SDK's context() answers the identical list, so the
    // two reads can never disagree about which other tasks exist.
    const otherTasks = otherTasksFor(outcome.checkpoints, task, input.authorNames, now())
    // A pending batched save is usable at once but is never described as saved (Amendment B.3):
    // it stays OUT of the merge — every merged section reads as anchored state, and the header's
    // save time counts anchored records only — and renders as its own marked block inside the
    // fence instead.
    const pending = outcome.checkpoints.filter((cp) => cp.anchor === "PENDING_ANCHOR" && inTask(cp))
    const merged = mergeCheckpoints(outcome.checkpoints.filter((cp) => cp.anchor !== "PENDING_ANCHOR" && inTask(cp)))
    const pendingText = pending.map((cp) => pendingBlock(cp, input.authorNames, merged)).join("\n\n")
    // the marked blocks — pending (stored, not anchored) and UNSENT (compiled here, not sent) — sit
    // inside the fence beside the merge, never in it: neither is anchored state
    // CAP-26: another session's save compiled here but not yet on Monad, shown marked UNSENT.
    // Read AFTER the chain read: a save that landed meanwhile (its eventId is in what the read
    // returned, anchored or pending) is dropped, never shown twice. The note counts only the
    // blocks the shared budget still had room to render, so "shown below" is true.
    const queued = readQueuedSaves(runtime.home, check.projectId)
    const landed = new Set(outcome.checkpoints.map((cp) => cp.checkpoint.eventId))
    const revokedCheck = deps.isRevoked ?? ((name: string) => isRevoked(runtime.home, name))
    const unsentFound = unsentSaves(runtime.home, queued, {
      projectId: check.projectId,
      task,
      askingAgent: agent,
      askingSession: input.sessionId,
      // a queue job only needs a safe file name, not a valid identity name — the revoke check
      // throws on e.g. "Claude.Code", and one such job must never refuse every handoff: skip it
      isRevoked: (name) => {
        try {
          return revokedCheck(name)
        } catch {
          return true
        }
      },
    }).filter((u) => !landed.has(u.envelope.checkpoint.eventId))
    const unsent = unsentBlocks(unsentFound, queued, now(), Math.max(0, UNSENT_TOTAL_CHARS - pendingText.length), merged)
    const pendingSavesNote = queuedSavesNote(mergeQueued(queuedBefore, queued), now(), unsent.shown) ?? undefined
    const markedText = [pendingText, unsent.text].filter((t) => t !== "").join("\n\n")
    // the checkpoints this session may treat as covered — its own never count: a session's own
    // saves are never updates for it and must never enter its seen set. A pending save that was
    // shown marked counts as covered — the session saw it, whatever the chain later decides.
    // Foreign-task checkpoints count too: their mention line WAS shown.
    const covered = outcome.checkpoints
      .filter((cp) => cp.sessionId !== input.sessionId)
      .sort(compareChainOrder)
      .map((cp) => cp.contextId)
    // A partial read still produces a handoff — the served checkpoints are real — but both
    // channels must say the list was incomplete: the model text opens with PARTIAL_LINE, the
    // owner's line adds "(incomplete — try again in a moment)", the daemon log records it.
    if (merged === null) {
      if (markedText === "") {
        // A brand-new project is exactly where the queued-saves note matters most: the record is
        // empty AND undelivered saves sit in the queue — the model must hear both halves (R-14).
        // Named-task wording: the "nothing saved" claim is about THIS task — other tasks get
        // the same mention block a merged handoff renders, so silence about them never reads
        // as "no other work exists".
        const emptyLine =
          task === DEFAULT_TASK
            ? EMPTY_TEXT
            : `Mida: connected. Nothing has been saved for task "${task}" in this project yet.`
        const mentions = otherTasksBlock(otherTasks, now())
        return {
          kind: "empty",
          text: [outcome.partial ? `Mida: connected. ${PARTIAL_LINE}` : emptyLine, pendingSavesNote, mentions === "" ? undefined : mentions]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
          facts: facts.length,
          factsFailed,
          readMs,
          // the mention lines WERE delivered — the foreign ids they summarized count as covered
          seen: covered,
          partial: outcome.partial,
        }
      }
      // Nothing anchored yet, but pending saves exist — the handoff is the marked blocks alone,
      // inside the same fence. The header says the honest thing: no merged record carries a
      // chain stamp, so the save time is "not yet confirmed on Monad"; each pending record is
      // still marked "from", never "saved".
      // Pending saves carry no chain placement — this orders on the writer's claim alone, which
      // is all a not-yet-anchored record has; it only picks whose line renders, never "current".
      const newestPending = pending.slice().sort(compareChainOrder).at(-1)
      const preamble = [handoffHeader(null), adapterNote, pendingSavesNote].filter((line): line is string => line !== undefined).join("\n")
      const mentionsBlock = otherTasksBlock(otherTasks, now())
      const mentionsText = mentionsBlock === "" ? "" : `\n\n${mentionsBlock}`
      const markedOnly = `${outcome.partial ? `${PARTIAL_LINE}\n\n` : ""}${preamble}\n${HANDOFF_BEGIN}\n\n${markedText}${mentionsText}\n\n${HANDOFF_TAIL}`
      return {
        kind: "handoff",
        text: markedOnly,
        checkpoints: outcome.checkpoints.length,
        facts: facts.length,
        factsFailed,
        readMs,
        savedBy:
          newestPending !== undefined
            ? (input.authorNames[newestPending.authorId.toLowerCase()] ?? "unknown agent")
            : (unsent.lastAgent ?? "unknown agent"),
        savedAt: newestPending?.checkpoint.createdAt ?? unsent.lastCreatedAt ?? "",
        seen: covered,
        limitChars: HANDOFF_MAX_CHARS,
        cut: false,
        reasonsLeftOut: false,
        // pending blocks are not budgeted (batched saves, off by default), so say so when they overflow
        oversized: markedOnly.length > HANDOFF_MAX_CHARS,
        partial: outcome.partial,
      }
    }
    // Serving a handoff to a named new session binds it to the chain it was shown: the drainer's
    // saves for that session read state/continues/<sessionId>.json into continuesSession. A record
    // scoped to this project, a session never continues itself, and a write that fails only means
    // the link is missing later — never a refused handoff. A partial merge may be missing the
    // real head, so it binds nothing — the next complete read links the session properly (M3-D).
    if (!outcome.partial && isSafeName(input.sessionId) && input.sessionId !== merged.headSessionId) {
      try {
        runtime.home.writeSecretJson(`state/continues/${input.sessionId}.json`, {
          continues: merged.headSessionId,
          projectId: check.projectId,
          // tk-1: the task this session resolved under rides beside the link, so a resumed
          // session with no pin still inherits it — "main" serializes as no field, the same
          // absent-is-main rule the envelope keeps
          ...(task === DEFAULT_TASK ? {} : { task }),
        })
      } catch {
        // a failed record degrades to continuesSession null at save time
      }
    }
    // the newest record the merge covered — scope is time-sorted, so the last provenance row is it
    const newest = merged.provenance.at(-1)
    const savedBy =
      newest === undefined ? "unknown agent" : (input.authorNames[newest.authorId.toLowerCase()] ?? "unknown agent")
    // A checkpoint the migration moved keeps its original author and save time; the envelope's
    // move date rides beside them in the saved-by line. The suffix goes on a render-only copy —
    // merged itself (and the saved-at summary taken from it above) stays untouched.
    const movedOn = new Map<string, MigrationEnvelope>()
    for (const stored of outcome.checkpoints) {
      if (stored.migration !== undefined) movedOn.set(stored.contextId, stored.migration)
    }
    // `restFor` is the characters the final text carries besides the merged render for a given
    // marked-blocks text — the blocks plus the joins, and a partial read's PARTIAL_LINE the
    // same way (UF-H).
    const restFor = (marked: string) => (marked === "" ? 0 : marked.length + 2) + (outcome.partial ? PARTIAL_LINE.length + 2 : 0)
    const assemble = (reasons: "keep" | "drop", budget: number, marked: string, forceOversizeNote = false) => {
      const rendered = renderHandoffReport(
        {
          ...merged,
          provenance: merged.provenance.map((row) => {
            const migration = movedOn.get(row.contextId)
            return migration === undefined ? row : { ...row, createdAt: `${row.createdAt} ${movedOnSuffix(migration)}` }
          }),
        },
        {
          authorNames: input.authorNames,
          facts,
          factsFailed,
          adapterNote,
          pendingSavesNote,
          otherTasks,
          now,
          reasons,
          ...(forceOversizeNote ? { forceOversizeNote: true } : {}),
          // CAP-26 review: the marked blocks sit outside this fit, so the merge gets what they leave of
          // the 8,000-char handoff (Claude Code moves injected context over 10,000 chars to a file; the
          // MCP tool's reply cap is 40,000) — dropping its oldest progress first, never the blocks' markers.
          ...(restFor(marked) === 0 && !forceOversizeNote ? {} : { maxChars: budget }),
        },
      )
      const text = (() => {
        if (marked === "") return rendered.text
        // inside the fence, before the END line — the marked pending blocks sit beside the merged
        // sections, each under its own "not yet anchored" marker; the header's save time is the
        // anchored merge's newest effective instant, which is exactly what it claims to be
        // sliced, never String.replace: a '$&' in saved text would paste the matched END line and
        // break the fence (CAP-26 review)
        const at = rendered.text.lastIndexOf(`\n\n${HANDOFF_TAIL}`)
        return at >= 0 ? `${rendered.text.slice(0, at)}\n\n${marked}${rendered.text.slice(at)}` : `${rendered.text}\n\n${marked}`
      })()
      return { rendered, finalText: outcome.partial ? `${PARTIAL_LINE}\n\n${text}` : text }
    }
    // UF-N2, the owner's order: to make the delivered text fit its 8,000 target, history goes
    // first — progress, the saved-by lines, file lists — and only then the reasons behind
    // decisions and rejected approaches; a constraint, decision or rejected approach is never
    // left out. Below the floor a render stays whole, so the retry drops the floor and hands the
    // merge only what is actually left once the untrimmable marked blocks are counted — that is
    // where the oldest progress goes (the floor render's no-trim answer was hiding it). Reasons
    // leave the data only when even a fully-trimmed history cannot fit; and when nothing fits
    // the first render goes out whole with the over-target note forced on, because a delivered
    // text over 8,000 must always say so. Each reported flag describes the chosen text.
    // UF-QA: the marked blocks carry their own history lines, and the same owner's order applies
    // to them — once the merge's own trimmed history cannot fit, the blocks are rebuilt WITHOUT
    // their history lines (rules stay, each keeping its left-out count) and the fit is tried
    // again with reasons kept. Only then do reasons leave, against the bare blocks; the final
    // fallback uses them too.
    const flooredBudget = Math.max(MERGED_MIN_CHARS, HANDOFF_MAX_CHARS - restFor(markedText))
    const first = assemble("keep", flooredBudget, markedText)
    const chosen =
      first.finalText.length <= HANDOFF_MAX_CHARS
        ? first
        : (() => {
            const leftover = Math.max(0, HANDOFF_MAX_CHARS - restFor(markedText))
            const trimmed = assemble("keep", leftover, markedText)
            if (trimmed.finalText.length <= HANDOFF_MAX_CHARS) return trimmed
            const pendingBare = pending.map((cp) => pendingBlock(cp, input.authorNames, merged, true)).join("\n\n")
            const unsentBare = unsentBlocks(unsentFound, queued, now(), Math.max(0, UNSENT_TOTAL_CHARS - pendingBare.length), merged, true)
            const markedBare = [pendingBare, unsentBare.text].filter((t) => t !== "").join("\n\n")
            const marked2 = markedBare === markedText ? markedText : markedBare
            const rest2 = restFor(marked2)
            const leftover2 = Math.max(0, HANDOFF_MAX_CHARS - rest2)
            if (marked2 !== markedText) {
              const bare = assemble("keep", leftover2, marked2)
              if (bare.finalText.length <= HANDOFF_MAX_CHARS) return bare
            }
            const dropped = assemble("drop", leftover2, marked2)
            if (dropped.finalText.length <= HANDOFF_MAX_CHARS) return dropped
            return assemble("keep", Math.max(MERGED_MIN_CHARS, HANDOFF_MAX_CHARS - rest2), marked2, true)
          })()
    const { rendered, finalText } = chosen
    return {
      kind: "handoff",
      text: finalText,
      checkpoints: outcome.checkpoints.length,
      facts: facts.length,
      factsFailed,
      readMs,
      savedBy,
      savedAt: newest?.createdAt ?? "",
      seen: covered,
      // UF-J: the log pairs the final text's size with the target it is judged against —
      // the marked blocks' share shrinks the merge's render budget, but never the real limit
      limitChars: HANDOFF_MAX_CHARS,
      cut: rendered.cut,
      reasonsLeftOut: rendered.reasonsLeftOut,
      // UF-H: oversized answers for what the model actually receives — the partial line and the
      // marked blocks included — not the merge alone (which was fitted against a smaller budget)
      oversized: finalText.length > HANDOFF_MAX_CHARS,
      partial: outcome.partial,
    }
  } catch (error) {
    // a chain answer that never arrived gets its own reason — the capability check's throw is
    // how a rate-limited RPC used to reach "internal" (and, at the store, "not-approved")
    const chainReason = chainRefusalReason(error)
    if (chainReason !== undefined) return refused(chainReason, CHAIN_REFUSAL_TEXT[chainReason])
    if (isReadDeadlineError(error)) return refused("read-slow", noContextText("read-slow"))
    return refused("internal", noContextText("internal"))
  }
}
