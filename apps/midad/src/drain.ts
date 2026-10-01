import * as fs from "node:fs"
import { lstatSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { createPublicClient } from "viem"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { isMidaError } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { CONTENT_FIELDS, validateCheckpoint } from "@mida/checkpoint"
import type { Checkpoint } from "@mida/checkpoint"
import { chainFor, rpcTransport, sponsorDailyLimitOf } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { RegistryReader, StoreHttpError } from "@mida/api"
import { readTranscriptFor, scrubSecrets } from "@mida/compiler"
import { devinSessionStat } from "@mida/compiler"
import type { OpenDevinDb, compileCheckpoint } from "@mida/compiler"
import { chainRefusalReason, isOutOfGasError, isWalletLow } from "./chain-busy.js"
import { CheckpointPayloadError, eventIdFor, unwrapCheckpoint, wrapCheckpoint } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import { devinDbPathAllowed } from "./devin-facts.js"
import type { MidaHome } from "./home.js"
import { FLUSH_EVENTS, transcriptPathAllowed } from "./hook.js"
import { isRevoked, loadAgentIdentity, loadGrants } from "./keys.js"
import { appendLog } from "./log.js"
import { resolveNetwork } from "./network.js"
import { checkProject as checkProjectAgainstList } from "./projects.js"
import type { ProjectCheck } from "./projects.js"
import { findProjectMarker, firstQueuedAt, isSafeName, listJobs, moveToBad, peekJobs, removeJob, stampFirstAt } from "./queue.js"
import type { CaptureJob } from "./queue.js"
import { clearUnsent, markUnsent } from "./unsent.js"
import { resolveSessionTask, taskOrUndefined } from "./task.js"
import type { ServiceRuntime } from "./runtime.js"
import { followPendingAnchors, pendingAnchors, sweepPendingPlaintexts } from "./batching.js"
import { isCapabilityLive } from "./skeleton.js"
import { saveCheckpoint } from "./skeleton.js"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MIN_GAP_MS = 60_000
/**
 * A session's FIRST save owes only this gap: one run from its first event, so a session that
 * dies inside its first minute still leaves a checkpoint. Every later save keeps `minGapMs`.
 */
const DEFAULT_FIRST_GAP_MS = 10_000
const DRAIN_LOCK = "queue/drain.lock"
const DRAIN_LOCK_MAX_AGE_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 8
const MAX_BACKOFF_MS = 60 * 60 * 1000
/** A settle round sleeps at most this long, and at most three waits happen before giving up. */
const SETTLE_CAP_MS = 65_000
const MAX_SETTLE_WAITS = 3
/** A job that lands mid-pass is invisible to that pass's counts; at most this many extra passes chase it. */
const MAX_EXTRA_PASSES = 5
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const TMP_MAX_AGE_MS = 60 * 60 * 1000
const LOG_MAX_BYTES = 5 * 1024 * 1024
const LOG_KEEP_BYTES = 1024 * 1024
/**
 * The folders every `new Mida()` session leaves files in (in-21 U-4): its task pin, its
 * last-seen mark and its continues record. A file untouched for a month belongs to a session
 * that is over, and the cap bounds a pass over a home that was never swept.
 */
const SESSION_STATE_DIRS = ["state/tasks", "state/lastseen", "state/continues"] as const
const SESSION_STATE_MAX_AGE_MS = 30 * DAY_MS
const SESSION_STATE_MAX_REMOVALS = 500
/** Housekeeping is housekeeping, not the pass: at most once an hour per process (in-22 N-D). */
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000
const lastHousekeepingAt = new WeakMap<MidaHome, number>()
/**
 * The marks every process on this home shares (in-23 R-3): `lastSweepAt` holds the hourly gate
 * across detached drainer spawns — the WeakMap alone re-swept on each — and `skippedLoggedAt`
 * bounds the session-sweep-skipped note to once a day, so an entry the sweep can never remove
 * is not reported on every hourly pass forever.
 */
const HOUSEKEEPING_MARK = "state/housekeeping.json"
/** How much of a failed provider answer a drain log line may quote — scrubbed first, then cut. */
const LOG_SAMPLE_CHARS = 120

/**
 * Stable failure codes. PERMANENT means this transcript state can never save — the job leaves the
 * queue and the transcript state is recorded so an identical job later skips without work. Anything
 * else is TRANSIENT: the job stays and the session waits out an exponential backoff.
 */
const PERMANENT_FAILURES = new Set([
  "too-large",
  "bad-transcript-path",
  "unknown-transcript-format",
  "not-a-project",
  "not-approved",
  "revoked",
  "denied-pending-revoke",
  "list-tampered",
  "list-unreadable",
  "folder-mismatch",
  "check-failed",
  "transcript-project-mismatch",
  // the devin sessions-db failures — none of them is fixed by waiting
  "devin-needs-node-22.13",
  "devin-session-not-found",
  "devin-db-unreadable",
])
/**
 * A checkpoint the validator rejects is usually fixed by a fresh model call, so
 * `invalid-checkpoint` is transient for the first two attempts; the third is permanent.
 */
const INVALID_CHECKPOINT_MAX_ATTEMPTS = 3
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, MAX_BACKOFF_MS)
/**
 * Transient codes that are a capacity wait, not a failed attempt: the sponsor's daily cap (UF-O),
 * or a compile with no model able to write the summary — the whole chain at its usage limit, or
 * nothing installed at all (UF-P3). They never count an attempt and never reach queue/bad
 * through gave-up.
 */
const LIMIT_WAIT_REASONS = new Set(["sponsor-limit", "summarizer-limit", "no-summarizer"])

export interface DrainDeps {
  home: MidaHome
  /** opens a fresh runtime — used when `runtime` is not supplied; the drain closes what it opens */
  open?: () => Promise<ServiceRuntime>
  /** an already-open runtime owned by the caller (the daemon) — the drain uses it and never closes it */
  runtime?: ServiceRuntime
  compile: typeof compileCheckpoint
  now?: () => Date
  minGapMs?: number
  /** Gap for a session's FIRST save only — defaults to ten seconds; later saves use `minGapMs`. */
  firstGapMs?: number
  /** The user's real home folder — the transcript rule is checked against it, injected in tests. */
  homeDir?: string
  /** The chain save — injectable so rule tests never need a chain. Defaults to saveCheckpoint. */
  save?: typeof saveCheckpoint
  /** The env the devin db path resolves against — injected in tests; defaults to the process env. */
  env?: NodeJS.ProcessEnv
  /** Opens the devin sessions database — injectable so tests can model node:sqlite absence or a synthetic file's opener. */
  openDevinDb?: OpenDevinDb
  /** The owner's approval check — injectable in tests. Defaults to a read-only chain lookup. */
  isApproved?: (agent: string) => Promise<boolean>
  /**
   * The owner-signed project-folder check — injectable in tests. Defaults to the real check on the
   * drain's runtime, with a fast `not-a-project` answer for marker-less folders that never opens it.
   */
  checkProject?: (input: { agent: string; cwd: string }) => Promise<ProjectCheck>
  /** Injected in tests that move the clock; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>
}

interface SessionState {
  transcriptBytes: number
  lastLineHash: string
  savedAt: string
  /** Consecutive transient failures on this transcript state; absent means the state is terminal. */
  attempts?: number
  failedAt?: string
  /** The drain code the last attempt failed with — what the wait is waiting on (in-29 S-2). */
  reason?: string
}

export interface DrainResult {
  saved: number
  /** Saves the store queued for a shared batch — not final; the pending ledger owns them until ANCHORED or REJECTED. */
  queued?: number
  skippedUnchanged: number
  skippedTooSoon: number
  failed: number
  /** Earliest epoch ms at which a held-back job becomes due, or null when nothing is waiting. */
  earliestDueMs: number | null
  /** True when a live `queue/drain.lock` stopped this run before it touched the queue. */
  lockHeld?: boolean
}

const emptyResult = (): DrainResult => ({ saved: 0, queued: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0, earliestDueMs: null })

/**
 * One drain under `queue/drain.lock`: hooks fire often, so a second drainer that finds a live
 * lock-holder younger than ten minutes exits at once — before compiling anything — while a stale
 * or dead one is taken over. The lock is released in a `finally`, whatever the pass did.
 */
export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  const now = deps.now ?? (() => new Date())
  const lock = acquireDrainLock(deps.home, now)
  if (lock === null) {
    // a held lock is not an empty pass — logging "pass" with zeros would read as
    // "ran and found nothing" while a job visibly waits in the queue
    appendLog(deps.home, "drain", { outcome: "lock-held" })
    return { ...emptyResult(), lockHeld: true }
  }
  try {
    return await drainPass(deps, now)
  } finally {
    lock.release()
  }
}

/**
 * Drains until nothing is waiting: a pass that ends with jobs held back by the save gap or a retry
 * backoff sleeps until the earliest one is due (never more than 65 s) and drains again — up to
 * three waits, all inside one `queue/drain.lock`, so a second drainer can never duplicate the work.
 */
export async function drainUntilSettled(deps: DrainDeps): Promise<DrainResult> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const lock = acquireDrainLock(deps.home, now)
  if (lock === null) {
    appendLog(deps.home, "drain", { outcome: "lock-held" })
    return { ...emptyResult(), lockHeld: true }
  }
  try {
    const total = emptyResult()
    let waits = 0
    let extraPasses = 0
    for (;;) {
      const result = await drainPass(deps, now)
      total.saved += result.saved
      total.queued = (total.queued ?? 0) + (result.queued ?? 0)
      total.failed += result.failed
      total.skippedUnchanged += result.skippedUnchanged
      total.skippedTooSoon += result.skippedTooSoon
      const remaining = listJobs(deps.home).length
      // a job that arrived mid-pass was never listed by it: a pass that saved, or one that left
      // jobs it cannot account for, re-lists and goes again — bounded so a queue that never
      // empties cannot loop the drainer forever
      if (remaining > 0 && extraPasses < MAX_EXTRA_PASSES && (result.saved > 0 || (result.queued ?? 0) > 0 || result.earliestDueMs === null)) {
        extraPasses += 1
        continue
      }
      if (result.earliestDueMs === null || waits >= MAX_SETTLE_WAITS || remaining === 0) {
        total.earliestDueMs = result.earliestDueMs
        return total
      }
      waits += 1
      await sleep(Math.max(0, Math.min(result.earliestDueMs - now().getTime(), SETTLE_CAP_MS)))
    }
  } finally {
    lock.release()
  }
}

/**
 * One pass over the queue. Jobs are grouped by `sessionId` and each session is handled once, using
 * its newest job — a burst of PostToolUse events still costs a single compile — and a session that
 * saw any flush event (Stop, StopFailure, PreCompact, SessionEnd) is treated as a flush.
 *
 * Per session the drainer remembers `{ transcriptBytes, lastLineHash, savedAt }` in
 * `queue/state/<sessionId>.json`: an unchanged transcript is skipped even on a flush, and a changed
 * one inside `minGapMs` of the last save waits — its job stays queued so a later drain (or a flush)
 * still saves it. A transient failure is recorded as `attempts`/`failedAt` on the state and retried
 * only after `60 s × 2^attempts` (capped at an hour). Only an answered-but-unusable model reply
 * gives up on a count (`no-json` at eight tries, `invalid-checkpoint` at three); every other
 * transient failure keeps retrying until the seven-day age rule drops the job. A permanent
 * failure removes the job and records the transcript state
 * so an identical job later skips as unchanged. A compiled envelope is cached at
 * `queue/compiled/<eventId>.json` so a retried save never pays for a second model call.
 *
 * The runtime — lock, API server, keys — is opened lazily, only once a session has actually
 * compiled, and always closed before returning. A pass that only skips never touches the chain.
 * An injected `runtime` (the daemon's) is used as-is and left open — the caller owns its life.
 */
async function drainPass(deps: DrainDeps, now: () => Date): Promise<DrainResult> {
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS
  const firstGapMs = deps.firstGapMs ?? DEFAULT_FIRST_GAP_MS
  const homeDir = deps.homeDir ?? homedir()
  const save = deps.save ?? saveCheckpoint
  const isApproved =
    deps.isApproved ?? ((agent: string) => agentApprovedOnChain(deps.home, agent, async () => (await openRuntime()).owner))
  const counts = emptyResult()
  const dueSooner = (at: number) => {
    if (counts.earliestDueMs === null || at < counts.earliestDueMs) counts.earliestDueMs = at
  }
  const log = (record: Record<string, unknown>) => appendLog(deps.home, "drain", record)
  const approved = new Map<string, boolean>()
  const checkApproved = async (agent: string): Promise<boolean> => {
    const known = approved.get(agent)
    if (known !== undefined) return known
    const ok = await isApproved(agent)
    approved.set(agent, ok)
    return ok
  }

  // in-24 (review N-4): the cap on logs/*.jsonl is the only bound on them — appendLog has none
  // — so it runs on every pass, outside the housekeeping step a throw or a skipped hour kills.
  capLogs(deps.home)

  // Housekeeping runs at most once an hour per home — a drain pass every 15 s does not need
  // a sweep every pass (in-22 N-D), and the persisted mark makes every process honour the same
  // hour (in-23 R-3). And it can never starve the queue: one malformed entry or one failed
  // sweep is logged once and the pass still saves (in-22 V-3).
  if (housekeepingDue(deps.home, now)) {
    try {
      pruneQueue(deps.home, now)
      // written only after the sweep survives — a failed pass holds no hour on disk, so the
      // next process retries instead of waiting out a sweep that never ran
      writeHousekeepingMark(deps.home, { lastSweepAt: now().toISOString() })
    } catch {
      log({ outcome: "note", reason: "housekeeping-failed" })
    }
  }

  const bySession = new Map<string, CaptureJob[]>()
  for (const job of listJobs(deps.home)) {
    const group = bySession.get(job.sessionId)
    if (group === undefined) bySession.set(job.sessionId, [job])
    else group.push(job)
  }

  let opened: ServiceRuntime | undefined
  const openRuntime = async (): Promise<ServiceRuntime> => {
    if (deps.runtime !== undefined) return deps.runtime
    if (deps.open === undefined) throw new Error("drain needs either a runtime or an open()")
    opened ??= await deps.open()
    return opened
  }
  const checkProject =
    deps.checkProject ??
    (async (input: { agent: string; cwd: string }): Promise<ProjectCheck> => {
      // a folder with no marker is not-a-project without paying for a runtime at all
      if (findProjectMarker(input.cwd) === null) return { ok: false, reason: "not-a-project" }
      return checkProjectAgainstList(await openRuntime(), input)
    })
  try {
    for (const [sessionId, group] of bySession) {
      const job = group[group.length - 1]! // listJobs is oldest-first, so the last is newest
      // CAP-28: the session's first queue time survives the merge, so the first-save gap runs from
      // its first event — not from whichever job a previous pass happened to keep
      const firstAt = firstQueuedAt(group)
      // stamp BEFORE removing the older jobs: a crash in between then loses nothing (review)
      stampFirstAt(deps.home, job, firstAt)
      for (const older of group.slice(0, -1)) removeJob(deps.home, older.id)
      const flush = group.some((j) => FLUSH_EVENTS.has(j.event))
      try {
        // UF-QC: ONE age rule for every job, whatever happened to it — a queued save is kept
        // for seven days. The session's state is read here anyway and reused below; it no
        // longer decides staleness, so a wait reason clearing can never drop the save.
        const state = readState(deps.home, sessionId)
        if (now().getTime() - Date.parse(job.at) > WEEK_MS) {
          moveToBad(deps.home, `${job.id}.json`)
          log({ sessionId, outcome: "bad", reason: "older-than-7d" })
          continue
        }
        // the hook checked this path at enqueue, but the file could have been swapped since —
        // re-check the same rule before the drainer opens it. A devin job's "transcript" is
        // the sessions database — the check is the configured-path rule, not a .jsonl root.
        const sourceOk =
          job.agent === "devin"
            ? devinDbPathAllowed(job.transcriptPath, deps.env ?? process.env, homeDir)
            : transcriptPathAllowed(job.transcriptPath, job.agent, homeDir, deps.home)
        if (!sourceOk) {
          moveToBad(deps.home, `${job.id}.json`)
          log({ sessionId, outcome: "bad", reason: "bad-transcript-path" })
          continue
        }
        // the owner-signed project list decides before the transcript is even opened: a refusal
        // is permanent for this job — it is removed with the stable reason and never compiled
        const project = await checkProject({ agent: job.agent, cwd: job.cwd })
        if (!project.ok) {
          removeJob(deps.home, job.id)
          log({ sessionId, outcome: "removed", reason: removalReason(deps.home, job.agent, project.reason) })
          continue
        }
        const projectId = project.approval.projectId
        // tk-1: the task rides the job file from enqueue — stamped once, immutable for the
        // session (invariant 1). A job written before tasks exist carries none and resolves
        // here the same way the hook would have: pin → predecessor → folder default → main.
        const task = resolveSessionTask(deps.home, {
          sessionId,
          projectId,
          cwd: job.cwd,
          explicit: taskOrUndefined(job.task),
        }).task

        // size and last line come from ONE open descriptor — a growing transcript cannot show
        // the drainer a size and a tail from different moments. A devin session has no file:
        // its fingerprint is (main_chain_id, max node_id, node count) from one database read.
        // CAP-26: what a compile from this read covers — the next agent's "newer work" check
        const coveredAt = now().toISOString()
        const { bytes: transcriptBytes, lastLine } =
          job.agent === "devin"
            ? devinFingerprintOf(job.transcriptPath, sessionId, deps.openDevinDb)
            : tailOf(job.transcriptPath)
        const lastLineHash = bytesToHex(sha256(utf8ToBytes(lastLine)))
        const stateMatches = state !== undefined && state.transcriptBytes === transcriptBytes && state.lastLineHash === lastLineHash
        const terminal = { transcriptBytes, lastLineHash, savedAt: now().toISOString() }
        if (stateMatches && (state.attempts ?? 0) === 0) {
          counts.skippedUnchanged += 1
          removeJob(deps.home, job.id)
          continue
        }
        // the reader is chosen by the agent that wrote the transcript — an agent with no
        // reader, or a file in no known format (it might have been swapped for one since
        // the path check passed), is not sent to the model. A devin job reads its session
        // from the sessions database — the reader needs the session id to pick the rows.
        const convo = readTranscriptFor(job.agent, job.transcriptPath, { sessionId })
        if (convo === null || convo.format === "unknown-tail") {
          moveToBad(deps.home, `${job.id}.json`)
          writeState(deps.home, sessionId, terminal)
          log({ sessionId, outcome: "bad", reason: "unknown-transcript-format" })
          continue
        }
        // the folders the transcript itself recorded must agree with the approved project: a
        // session whose lines carry another marked project's folder was never this project's to
        // save — permanent, and nothing is saved. A folder with no marker is "no record" and a
        // transcript with no cwd fields at all keeps the old behaviour.
        const foreign = convo.cwds.some((folder) => {
          const marker = findProjectMarker(folder)
          return marker !== null && marker.projectId !== null && marker.projectId !== projectId
        })
        if (foreign) {
          moveToBad(deps.home, `${job.id}.json`)
          writeState(deps.home, sessionId, terminal)
          log({ sessionId, outcome: "bad", reason: "transcript-project-mismatch" })
          continue
        }
        // nothing is saved for an agent the owner has not approved — decided before any model call
        if (!(await checkApproved(job.agent))) {
          for (const other of listJobs(deps.home)) if (other.agent === job.agent) removeJob(deps.home, other.id)
          writeState(deps.home, sessionId, terminal)
          log({ sessionId, outcome: "removed", reason: removalReason(deps.home, job.agent, "not-approved") })
          continue
        }
        const due = state === undefined ? undefined : dueAfterFailureMs(state)
        if (due !== undefined && now().getTime() < due) {
          counts.skippedTooSoon += 1
          dueSooner(due)
          continue // the job stays queued: the retry fires once the wait has passed
        }
        // No saved state yet: the gap runs from the session's FIRST queued job (CAP-28). The FIRST save
        // owes only the short first gap — a session killed in its first minute still leaves a
        // checkpoint; every later save keeps the full gap. A session inside a retry backoff never
        // reaches this line — the backoff check above already holds it.
        const first = state?.savedAt === undefined
        const gapRef = Date.parse(state?.savedAt ?? firstAt)
        const gapMs = first ? firstGapMs : minGapMs
        if (!flush && now().getTime() - gapRef < gapMs) {
          counts.skippedTooSoon += 1
          dueSooner(gapRef + gapMs)
          continue // the job stays queued: a later drain or a flush still saves it
        }

        const eventId = eventIdFor({ projectId, sessionId, transcriptBytes, lastLine })
        // A compiled envelope survives a failed save: the retry spends no model call on it.
        const cached = readCompiled(deps.home, eventId)
        let envelope: CheckpointEnvelope
        let compileMeta: CompileMeta
        let reusedCompiled: boolean
        if (cached !== undefined) {
          envelope = cached.envelope
          compileMeta = cached.meta
          reusedCompiled = true
        } else {
          // the session's last saved checkpoint becomes the next compile's
          // starting point — each save updates it instead of restating the
          // whole session in fresh words
          const previous = readPrevious(deps.home, sessionId)
          if (previous.unreadable) log({ sessionId, outcome: "note", reason: "previous-unreadable" })
          const compileStart = now().getTime()
          const compiled = await deps.compile({
            transcriptPath: job.transcriptPath,
            agent: job.agent,
            sessionId: job.sessionId,
            eventId,
            cwd: job.cwd,
            homeDir,
            previous: previous.checkpoint,
          })
          const compileMs = now().getTime() - compileStart
          if (!compiled.ok) {
            // a fallback that ran and still lost belongs in the log — "model-failed" alone
            // would hide that the second model was tried too
            if (compiled.fellBack !== undefined) log({ sessionId, outcome: "note", reason: "compile-fallback-failed", fellBack: compiled.fellBack })
            if (compiled.reason === "invalid") throw new CheckpointPayloadError("invalid-checkpoint", "the compiler produced an invalid checkpoint", compiled.fields, compiled.sample)
            throw new DrainFailure(compiled.reason, compiled.sample)
          }
          envelope = wrapCheckpoint({
            projectId,
            sessionId,
            continuesSession: readContinues(deps.home, sessionId, projectId),
            compiledBy: compiled.compiledBy,
            checkpoint: compiled.checkpoint,
            task,
          })
          compileMeta = {
            compileMs,
            attempts: compiled.attempts,
            retried: compiled.retried,
            trimmed: compiled.trimmed,
            droppedKeys: compiled.droppedKeys,
            ...(compiled.fellBack !== undefined ? { fellBack: compiled.fellBack } : {}),
            ...(compiled.cacheHitTokens !== undefined ? { cacheHit: compiled.cacheHitTokens } : {}),
            ...(compiled.cacheMissTokens !== undefined ? { cacheMiss: compiled.cacheMissTokens } : {}),
            ...(compiled.inputTokens !== undefined ? { inputTokens: compiled.inputTokens } : {}),
            ...(compiled.outputTokens !== undefined ? { outputTokens: compiled.outputTokens } : {}),
          }
          deps.home.writeSecretJson(`queue/compiled/${eventId}.json`, { ...envelope, compileMeta })
          reusedCompiled = false
        }
        // CAP-26: from here until it lands (or fails for good) this compiled save is the session's
        // newest state — the next agent's handoff may show it, marked UNSENT, for a fast switch
        markUnsent(deps.home, sessionId, eventId, coveredAt)
        const runtime = await openRuntime()
        const saved = await save(runtime, job.agent, {
          projectId: envelope.projectId,
          sessionId: envelope.sessionId,
          continuesSession: envelope.continuesSession,
          compiledBy: envelope.compiledBy,
          checkpoint: envelope.checkpoint,
          ...(envelope.task === undefined ? {} : { task: envelope.task }),
        })
        writeState(deps.home, sessionId, terminal)
        // landed (stored, or batched for anchoring — the pending ledger shows that one): never UNSENT again
        clearUnsent(deps.home, sessionId)
        // the saved checkpoint's content fields — and its verbatim
        // originalRequest — are the next compile's `previous`: without the
        // request in the file, a post-/compact save can never keep the
        // session's first ask
        const content: Record<string, unknown> = {}
        for (const field of CONTENT_FIELDS) content[field] = envelope.checkpoint[field]
        content.originalRequest = envelope.checkpoint.originalRequest
        deps.home.writeSecretJson(`queue/state/${sessionId}.last.json`, content)
        removeJob(deps.home, job.id)
        if (saved.batched !== undefined) {
          counts.queued = (counts.queued ?? 0) + 1
          // the store took responsibility for the save, so the job is done — but "queued" is all
          // it is: the pending ledger owns it now, and "saved" is logged only when
          // followPendingAnchors sees the batch ANCHORED on chain
          log({
            sessionId,
            outcome: "queued",
            lane: "batched",
            eventId,
            contextId: saved.contextId,
            model: envelope.compiledBy,
            compileMs: compileMeta.compileMs,
            saveMs: saved.milliseconds,
            attempts: compileMeta.attempts,
            retried: compileMeta.retried,
            reusedCompiled,
            trimmed: compileMeta.trimmed,
            droppedKeys: compileMeta.droppedKeys,
            fellBack: compileMeta.fellBack,
            cacheHit: compileMeta.cacheHit,
            cacheMiss: compileMeta.cacheMiss,
            inputTokens: compileMeta.inputTokens,
            outputTokens: compileMeta.outputTokens,
          })
          continue
        }
        counts.saved += 1
        log({
          sessionId,
          outcome: "saved",
          lane: saved.lane ?? "direct",
          // laneWhy is set only when the setup asked for batching and the save went direct anyway —
          // the store was disabled, unreachable, or the lane check itself failed
          ...(saved.laneWhy !== undefined ? { laneWhy: saved.laneWhy } : {}),
          eventId,
          // the model that actually wrote the checkpoint — a fallback save names the fallback
          model: envelope.compiledBy,
          compileMs: compileMeta.compileMs,
          // the save's own measurement: a wall-clock span here would fold in the receipt
          // read-back, which is reported separately as receiptMs
          saveMs: saved.milliseconds,
          attempts: compileMeta.attempts,
          retried: compileMeta.retried,
          reusedCompiled,
          trimmed: compileMeta.trimmed,
          droppedKeys: compileMeta.droppedKeys,
          fellBack: compileMeta.fellBack,
          // absent means unknown: JSON.stringify drops an undefined field, so a provider that
          // reported nothing leaves the keys off the record entirely
          cacheHit: compileMeta.cacheHit,
          cacheMiss: compileMeta.cacheMiss,
          inputTokens: compileMeta.inputTokens,
          outputTokens: compileMeta.outputTokens,
          // a duplicate save sent no transaction: every key below stays absent — the gas fields
          // describe a transaction that exists, never a zero
          ...(saved.transactionHash !== null ? { transactionHash: saved.transactionHash } : {}),
          // the read-back's own cost, present whenever one was attempted — even one that
          // failed and left no receipt — so it is visible instead of hidden inside saveMs
          ...(saved.receiptMs !== undefined ? { receiptMs: saved.receiptMs } : {}),
          ...(saved.receipt !== undefined
            ? {
                gasUsed: saved.receipt.gasUsed,
                gasLimit: saved.receipt.gasLimit,
                effectiveGasPrice: saved.receipt.effectiveGasPrice,
                sponsored: saved.receipt.sponsored,
              }
            : {}),
        })
      } catch (error) {
        // an error whose properties throw when read (a hostile getter or Proxy) must still count as
        // a transient failure with its attempt and backoff recorded — never abort the pass (CAP-26 review)
        let code: string
        try {
          code = failureCode(error)
        } catch {
          code = "chain-error"
        }
        // field names are safe to log; values, validator messages and error.message are not
        // (CAP-26: a chain-error adds its error names and numeric codes — never a message)
        const fields = {
          ...(error instanceof CheckpointPayloadError && error.fields !== undefined ? { fields: error.fields } : {}),
          ...(code === "chain-error" ? chainErrorShape(error) : {}),
        }
        // a prefix of the last provider answer belongs on the TERMINAL failure only — re-quoting
        // it on every retry would repeat provider output once per attempt. Scrubbed and capped
        // again here rather than trusting the bound upstream set.
        const rawSample =
          error instanceof DrainFailure ? error.sample
            : error instanceof CheckpointPayloadError ? error.sample
              : undefined
        const sample = rawSample === undefined ? {} : { sample: scrubSecrets(rawSample).slice(0, LOG_SAMPLE_CHARS) }
        if (PERMANENT_FAILURES.has(code)) {
          if (code === "not-approved" || code === "revoked" || code === "denied-pending-revoke") {
            // every queued job for this agent fails the same way — remove them all, like not-approved
            for (const other of listJobs(deps.home)) if (other.agent === job.agent) removeJob(deps.home, other.id)
          } else {
            moveToBad(deps.home, `${job.id}.json`)
          }
          // terminal state records the real transcript stats: an identical job later skips as
          // unchanged — except denied-pending-revoke, whose deny may still clear. Terminalising
          // it would make the same transcript read as already-saved forever; leaving the state
          // untouched lets a later job save it once the store opens again (in-3 I6).
          if (code !== "denied-pending-revoke") {
            writeState(deps.home, sessionId, terminalStateFor(job, now().toISOString(), deps.openDevinDb))
          }
          log({ sessionId, outcome: "bad", reason: code, ...fields, ...sample })
          clearUnsent(deps.home, sessionId) // it will never land: not "on its way" any more
          continue
        }
        // transient: keep the job, count the attempt, and hold the session until the backoff passes.
        // A capacity wait is different (UF-O sponsor-limit; UF-P3 summarizer-limit/no-summarizer):
        // the limit is not an error — the attempt count must not grow (it would only march the
        // job to queue/bad for a limit the owner may lift), so the state keeps whatever attempts
        // it already had and is left out when there were none.
        const priorState = readState(deps.home, sessionId)
        const attempts = LIMIT_WAIT_REASONS.has(code) ? (priorState?.attempts ?? 0) : (priorState?.attempts ?? 0) + 1
        counts.failed += 1
        // UF-QD: only an answered-but-unusable model reply is terminal on a count — no-json
        // after eight tries, invalid-checkpoint after three. Every other transient reason
        // retries until the seven-day age rule drops the job: the count is not a death sentence
        // for a chain problem or a model that is down for the afternoon.
        const invalidGaveUp = code === "invalid-checkpoint" && attempts >= INVALID_CHECKPOINT_MAX_ATTEMPTS
        const noJsonGaveUp = code === "no-json" && attempts >= MAX_ATTEMPTS
        if (invalidGaveUp || noJsonGaveUp) {
          moveToBad(deps.home, `${job.id}.json`)
          writeState(deps.home, sessionId, terminalStateFor(job, now().toISOString(), deps.openDevinDb))
          log({ sessionId, outcome: "bad", reason: invalidGaveUp ? "invalid-checkpoint" : "gave-up", lastReason: code, ...fields, ...sample })
          clearUnsent(deps.home, sessionId)
          continue
        }
        const waiting: SessionState = {
          // an empty lastLineHash can never match a real transcript, so the state never reads as
          // "unchanged" — the retry is governed by attempts/failedAt alone
          transcriptBytes: statSize(job.transcriptPath),
          lastLineHash: "",
          savedAt: priorState?.savedAt ?? job.at,
          ...(LIMIT_WAIT_REASONS.has(code) && priorState?.attempts === undefined ? {} : { attempts }),
          failedAt: now().toISOString(),
          // the reason rides the wait record: doctor names it and a funding reset clears it
          reason: code,
        }
        writeState(deps.home, sessionId, waiting)
        const waitUntil = dueAfterFailureMs(waiting)
        if (waitUntil !== undefined) dueSooner(waitUntil)
        // transient: no sample — it is quoted once, on the terminal "bad" line above
        log({
          sessionId,
          outcome: "failed",
          reason: code,
          attempts,
          ...(code === "sponsor-limit" ? { sponsorReason: sponsorDailyLimitOf(error)!.slice(0, 200) } : {}),
          ...fields,
        })
      } finally {
        // CAP-26: a session whose job left the queue this pass — saved, skipped as unchanged,
        // dropped, moved aside — has no save on its way, so it can never be shown as UNSENT. One
        // check for every exit, including a restart after a crash between saving and clearing.
        if (!deps.home.has(`queue/${job.id}.json`)) clearUnsent(deps.home, sessionId)
      }
    }
    // The batched lane's follow-up: every pass asks the store where each ledger-owned save stands.
    // ANCHORED is logged "saved" here — the only place a batched save earns that outcome — and a
    // status error leaves the entry untouched, never dropped, never called final. An empty ledger
    // costs nothing and opens nothing.
    try {
      // Housekeeping runs on every pass, ledger empty or not: a kept plaintext whose pending
      // entry is gone — a crash between the two queue writes — is an orphan no resubmission
      // will ever name again.
      sweepPendingPlaintexts(deps.home)
      if (pendingAnchors(deps.home).length > 0) {
        await followPendingAnchors(await openRuntime(), log)
      }
    } catch {
      log({ outcome: "note", reason: "pending-follow-failed" })
    }
  } finally {
    if (opened !== undefined) await opened.close()
  }
  return counts
}

/**
 * The reason a job-removal logs. "not-approved" from either gate hides the real cause for an
 * agent the owner revoked: its project-list row and its live capabilities are gone by then, so
 * both gates answer not-approved. The marker `mida revoke` wrote is the tell (R4-3).
 */
function removalReason(home: MidaHome, agent: string, reason: string): string {
  if (reason !== "not-approved") return reason
  try {
    return isRevoked(home, agent) ? "revoked" : "not-approved"
  } catch {
    return "not-approved"
  }
}

/** A transient failure raised inside the drain pass, carrying the stable code the log uses. */
class DrainFailure extends Error {
  constructor(
    readonly code: "model-failed" | "no-json" | "summarizer-limit" | "no-summarizer",
    /** A bounded, already-scrubbed prefix of the provider's last answer — the compiler supplies it. */
    readonly sample?: string,
  ) {
    super(code)
    this.name = "DrainFailure"
  }
}

/**
 * CAP-26: what KIND of error a chain-error was — so the log can say why a save keeps failing
 * without quoting it. Only names and closed-list codes leave: the `.name` of the error and each
 * nested `.cause` (outermost first, at most 8, so viem's usual 4-deep write chain keeps its root;
 * a name outside a plain identifier shape reads "Unknown"), the first integer `.code` (a JSON-RPC
 * code), the first upper-snake string `.code` (a MidaError's closed-list code such as SEND_TIMEOUT
 * — the most useful single fact, review finding), and the first HTTP `.status` along that chain.
 * Never a message, URL, body or detail: those can carry RPC keys and transcript text (H5). A
 * thrown non-object — or an error whose properties throw when read — is `["Unknown"]`, so a hostile
 * error can never abort the drain pass before its attempt and backoff are recorded.
 */
export function chainErrorShape(error: unknown): { errorChain: string[]; rpcCode?: number; errorCode?: string; httpStatus?: number } {
  try {
    const errorChain: string[] = []
    let rpcCode: number | undefined
    let errorCode: string | undefined
    let httpStatus: number | undefined
    let current: unknown = error
    while (errorChain.length < 8 && typeof current === "object" && current !== null) {
      const { name, code, status, cause } = current as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown }
      errorChain.push(typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Unknown")
      if (rpcCode === undefined && typeof code === "number" && Number.isInteger(code)) rpcCode = code
      if (errorCode === undefined && typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) errorCode = code
      if (httpStatus === undefined && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status
      current = cause
    }
    if (errorChain.length === 0) errorChain.push("Unknown")
    return {
      errorChain,
      ...(rpcCode === undefined ? {} : { rpcCode }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }
  } catch {
    return { errorChain: ["Unknown"] }
  }
}

/** Maps any thrown value onto a stable drain code; everything unrecognised is a transient chain-error. */
function failureCode(error: unknown): string {
  if (error instanceof DrainFailure) return error.code
  if (error instanceof CheckpointPayloadError) return error.code
  // the store refused the write while the owner's revoke is still pending — the job is dropped
  // but the transcript state is left unsaved, not terminal, so it can save once the deny clears
  if (isMidaError(error, "WRITE_DENIED")) return "denied-pending-revoke"
  // the chain's own "revoked" stays distinct from "not approved" — the cause is different (R4-3)
  if (isMidaError(error, "CAPABILITY_REVOKED")) return "revoked"
  if (isMidaError(error, "CAPABILITY_DENIED") || isMidaError(error, "CAPABILITY_EXPIRED")) return "not-approved"
  // a refused send is transient: the ceiling may pass on retry after the queue settles or the
  // estimate changes — the job stays and the usual backoff applies (R3-1)
  if (isMidaError(error, "GAS_CEILING_EXCEEDED")) return "gas-ceiling"
  // the sponsor's daily limit refused and the wallet could not pay either (the marker sendContract
  // sets): not a chain fault — the save waits for the limit's UTC reset instead of retrying to death
  if (sponsorDailyLimitOf(error) !== undefined) return "sponsor-limit"
  // the chain's own insufficient-funds refusal names itself (in-29 S-2): a wallet that ran dry
  // is fixed by funding or the sponsor, not by retrying the same error — so it is not chain-error
  if (isOutOfGasError(error)) return "out-of-gas"
  // a wallet that cannot pay is transient like a chain hiccup — funding refills it (in-6 R4)
  if (isWalletLow(error)) return "wallet-low"
  // the store answered with bytes that are not a Mida body — an old deploy's plain-text 404, a
  // proxy error page. Named so it can never read as chain trouble; transient like chain-error:
  // the job waits out the backoff, the bytes stay (in-11 R-3).
  if (error instanceof StoreHttpError) return "store-error"
  // the chain could not be asked — or it answered "wrong setup" / "refused key". All three are
  // transient (the job waits out the backoff, the bytes stay) but the log names what actually
  // happened: chain-busy, chain-misconfigured or rpc-auth — never "not-approved" (Sep 25's
  // wrong label), and misconfiguration no longer wears "busy" (in-11 R-8).
  const chainReason = chainRefusalReason(error)
  if (chainReason !== undefined) return chainReason
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && PERMANENT_FAILURES.has(code)) return code
    if (error.message.includes("already holds this home")) return "lock-timeout"
    if (error.message.includes("network.json")) return "network-missing"
  }
  return "chain-error"
}

/**
 * The approval check the drainer can afford before every compile: a missing local identity means
 * the agent was never set up here (not-approved with no chain call), and a read-only registry
 * reader built from `network.json` — no owner key, no `midad.lock` — confirms at least one
 * capability is still live on chain. `grants.json` supplies the owner to ask about, but it is only
 * the local index: when it is absent the owner comes from the runtime (`ownerOf`), because a
 * missing file proves nothing. A runtime that cannot open or has no owner throws — "cannot
 * determine" is transient — and only the chain's own "no live capability" is permanent.
 */
export async function agentApprovedOnChain(
  home: MidaHome,
  agent: string,
  ownerOf: () => Promise<Address | undefined>,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const identity = loadAgentIdentity(home, agent)
  if (identity === undefined) return false
  let owner = loadGrants(home, agent)[0]?.owner
  if (typeof owner !== "string") {
    owner = await ownerOf()
    if (typeof owner !== "string") throw new Error(`cannot determine the owner for ${agent}'s approval check`)
  }
  // The same resolveNetwork every entry point uses — MONAD_TESTNET_RPC, then network.json, then
  // the public default — so the drainer answers about the same RPC the daemon it serves does.
  const resolved = await resolveNetwork(home, env, { probeChainId: false })
  const deployment = resolved.network.deployment
  const context: ChainContext = {
    publicClient: createPublicClient({ chain: chainFor(deployment.chainId), batch: { multicall: true }, transport: rpcTransport(resolved.network.rpcUrl) }),
    deployment,
  }
  const reader = new RegistryReader(context)
  for (const capabilityId of await reader.activeCapabilityIds(owner as Address, identity.agentId)) {
    if (await isCapabilityLive(context, capabilityId)) return true
  }
  return false
}

/** What a compile cost, kept beside the cached envelope so a retried save logs the real numbers. */
interface CompileMeta {
  compileMs: number
  attempts: number
  /** Whether the compile spent its one same-provider shape retry on the primary (0 or 1). */
  retried: number
  trimmed: string[]
  droppedKeys: string[]
  /** When the compile fell back to the second model: who failed, who wrote, and why. */
  fellBack?: { from: string; to: string; reason: string }
  /** Provider-reported prompt-cache counters — absent when the provider didn't say. */
  cacheHit?: number
  cacheMiss?: number
  /** Provider-reported total prompt/completion tokens — the same usage object, the same rule. */
  inputTokens?: number
  outputTokens?: number
}

/**
 * The compiled-envelope cache at `queue/compiled/<eventId>.json`; a corrupt entry is ignored and
 * recompiled. Entries written before the metrics existed carry no `compileMeta` — the compile did
 * run, so attempts reads as at least 1 and the rest as empty.
 */
function readCompiled(home: MidaHome, eventId: string): { envelope: CheckpointEnvelope; meta: CompileMeta } | undefined {
  try {
    const raw = home.readJson<Record<string, unknown>>(`queue/compiled/${eventId}.json`)
    if (raw === undefined) return undefined
    const envelope = unwrapCheckpoint(raw)
    if (envelope === null) return undefined
    const meta = (raw.compileMeta ?? {}) as Partial<CompileMeta>
    return {
      envelope,
      meta: {
        compileMs: typeof meta.compileMs === "number" ? meta.compileMs : 0,
        attempts: typeof meta.attempts === "number" ? meta.attempts : 1,
        // entries written before the field existed read as 0 — no retry was possible then
        retried: typeof meta.retried === "number" ? meta.retried : 0,
        trimmed: Array.isArray(meta.trimmed) ? meta.trimmed : [],
        droppedKeys: Array.isArray(meta.droppedKeys) ? meta.droppedKeys : [],
        ...(typeof meta.fellBack === "object" && meta.fellBack !== null ? { fellBack: meta.fellBack } : {}),
        ...(typeof meta.cacheHit === "number" ? { cacheHit: meta.cacheHit } : {}),
        ...(typeof meta.cacheMiss === "number" ? { cacheMiss: meta.cacheMiss } : {}),
        ...(typeof meta.inputTokens === "number" ? { inputTokens: meta.inputTokens } : {}),
        ...(typeof meta.outputTokens === "number" ? { outputTokens: meta.outputTokens } : {}),
      },
    }
  } catch {
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Creates `queue/drain.lock` with flag `wx`. A live lock younger than ten minutes means another
 * drainer owns the queue — return null. A dead or ancient lock is stale and gets replaced.
 */
function acquireDrainLock(home: MidaHome, now: () => Date): { release: () => void } | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (home.createSecretJsonExclusive(DRAIN_LOCK, { pid: process.pid, startedAt: now().toISOString() })) {
      return { release: () => home.remove(DRAIN_LOCK) }
    }
    let live = false
    try {
      const held = home.readJson<{ pid?: unknown; startedAt?: unknown }>(DRAIN_LOCK)
      if (typeof held?.pid === "number" && typeof held.startedAt === "string") {
        live = processAlive(held.pid) && now().getTime() - Date.parse(held.startedAt) < DRAIN_LOCK_MAX_AGE_MS
      }
    } catch {
      // an unreadable lock file is treated as stale
    }
    if (live) return null
    home.remove(DRAIN_LOCK)
  }
  return null
}

// The keys a `.last.json` may hold: the ten content fields plus the verbatim
// originalRequest the next compile needs to keep the session's first ask.
// The request stays code-side — buildExtractPrompt sends the content fields
// only — but it must round-trip through the file or it is lost between saves.
const PREVIOUS_KEYS = new Set<string>([...CONTENT_FIELDS, "originalRequest"])

/**
 * The session's last saved checkpoint, kept as its ten content fields plus its
 * verbatim originalRequest at `queue/state/<sessionId>.last.json`, becomes the
 * next compile's `previous`. The file is drainer-written but still untrusted
 * input: it must hold only those keys and pass validation, or the compile
 * starts from nothing and the pass logs `previous-unreadable`.
 */
function readPrevious(home: MidaHome, sessionId: string): { checkpoint?: Checkpoint; unreadable: boolean } {
  let raw: unknown
  try {
    raw = home.readJson<unknown>(`queue/state/${sessionId}.last.json`)
  } catch {
    return { unreadable: true }
  }
  if (raw === undefined) return { unreadable: false }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { unreadable: true }
  const record = raw as Record<string, unknown>
  if (Object.keys(record).some((k) => !PREVIOUS_KEYS.has(k))) return { unreadable: true }
  // the placeholders below are never seen by the model — buildExtractPrompt
  // sends the ten content fields only — but validation needs a full record
  const checked = validateCheckpoint({
    eventId: "cp-previous",
    agent: "unknown",
    source: "hook-compiler",
    createdAt: "1970-01-01T00:00:00.000Z",
    ...record,
  })
  if (!checked.ok) return { unreadable: true }
  return { checkpoint: checked.value, unreadable: false }
}

/**
 * The continuation a served handoff recorded for this session at `state/continues/<sessionId>.json`:
 * which earlier session's chain head it continues, scoped to the project the handoff was served
 * under. A missing, unreadable, unsafe or wrong-project record is null — never a guess.
 */
function readContinues(home: MidaHome, sessionId: string, projectId: string): string | null {
  try {
    const raw = home.readJson<unknown>(`state/continues/${sessionId}.json`)
    if (typeof raw !== "object" || raw === null) return null
    const record = raw as Record<string, unknown>
    if (record.projectId !== projectId || !isSafeName(record.continues)) return null
    // last use, not creation: a session still being read is still alive
    home.touch(`state/continues/${sessionId}.json`)
    return record.continues
  } catch {
    return null
  }
}

/**
 * A sponsor's daily limit resets at 00:00 UTC. The hourly retry is cheap for the sponsor (a
 * refused try makes at most three calls to its provider) and picks up a limit the sponsor's
 * owner raised during the day.
 *
 * When the next try on a failed session becomes due — the ONE rule the pass and `sessionWaits`
 * share so they can never disagree: a sponsor-limit failure waits the EARLIER of `failedAt + 60
 * minutes` and the first 00:00:00 UTC after `failedAt` + 60 seconds; any other recorded failure
 * with attempts waits `failedAt + backoffMs(attempts)`; anything else owes no failure wait.
 */
function dueAfterFailureMs(state: SessionState): number | undefined {
  if (state.failedAt === undefined) return undefined
  const failedAt = Date.parse(state.failedAt)
  // UF-P3: a summarizer wait retries on the hour only — the UTC-midnight rule is the sponsor's
  if (state.reason === "summarizer-limit" || state.reason === "no-summarizer") return failedAt + 60 * 60 * 1000
  if (state.reason === "sponsor-limit") {
    const nextMidnight = (Math.floor(failedAt / DAY_MS) + 1) * DAY_MS
    return Math.min(failedAt + 60 * 60 * 1000, nextMidnight + 60_000)
  }
  return (state.attempts ?? 0) > 0 ? failedAt + backoffMs(state.attempts!) : undefined
}

function readState(home: MidaHome, sessionId: string): SessionState | undefined {
  try {
    const raw = home.readJson<SessionState>(`queue/state/${sessionId}.json`)
    if (
      typeof raw?.transcriptBytes !== "number" || typeof raw.lastLineHash !== "string" ||
      typeof raw.savedAt !== "string"
    ) return undefined
    return raw
  } catch {
    return undefined // a corrupt cache is rebuilt by saving again — the safe direction
  }
}

function writeState(home: MidaHome, sessionId: string, state: SessionState): void {
  home.writeSecretJson(`queue/state/${sessionId}.json`, state)
}

/** One queued session's wait, as doctor reports it: the next-try time and what it waits on. */
export interface SessionWait {
  sessionId: string
  agent: string
  /** Epoch ms at which the session's next try becomes due — the same deadline the pass computes. */
  dueAtMs: number
  /** The drain code the last attempt failed with — absent on a gap wait or a pre-in-29 record. */
  reason: string | undefined
}

/**
 * What each queued session is waiting for and until when — the same arithmetic the pass applies
 * (in-29 S-2): a recorded failure waits out `60 s × 2^attempts` from `failedAt`; a session with no
 * failure waits out its save gap (the short first-save gap, else the minute); a flush job owes
 * nothing and is due whenever a pass runs. Jobs are grouped exactly as the pass groups them —
 * oldest-first list, newest job stands for the session, any flush event in the group counts.
 */
export function sessionWaits(home: MidaHome, jobs: CaptureJob[]): SessionWait[] {
  const bySession = new Map<string, CaptureJob[]>()
  for (const job of jobs) {
    const group = bySession.get(job.sessionId)
    if (group === undefined) bySession.set(job.sessionId, [job])
    else group.push(job)
  }
  const waits: SessionWait[] = []
  for (const [sessionId, group] of bySession) {
    const job = group[group.length - 1]!
    const state = readState(home, sessionId)
    const reason = state?.reason
    const dueAtMs = state === undefined ? undefined : dueAfterFailureMs(state)
    if (dueAtMs !== undefined) {
      waits.push({ sessionId, agent: job.agent, dueAtMs, reason })
      continue
    }
    if (group.some((j) => FLUSH_EVENTS.has(j.event))) {
      waits.push({ sessionId, agent: job.agent, dueAtMs: 0, reason })
      continue
    }
    const gapRef = Date.parse(state?.savedAt ?? firstQueuedAt(group))
    waits.push({ sessionId, agent: job.agent, dueAtMs: gapRef + (state?.savedAt === undefined ? DEFAULT_FIRST_GAP_MS : DEFAULT_MIN_GAP_MS), reason })
  }
  return waits
}

/**
 * The wait reasons a funded wallet — or the gas sponsor — makes stale: the send-side "cannot pay"
 * failures. Funding one wallet does not prove the others are funded, but the waits it clears only
 * cost one early retry each if it was not — the waiting direction is the broken one.
 */
const GAS_WAIT_REASONS = new Set(["out-of-gas", "wallet-low", "sponsor-limit"])

/**
 * Clears the recorded failure backoff on every session whose wait was about gas — run after
 * `mida init`'s funding pass and after `mida sponsor on`, so saves resume on the next pass
 * instead of waiting out a backoff that described a dry wallet (in-29 S-2). A wait recorded
 * before reasons existed clears too; a wait that was not about gas keeps its deadline. Returns
 * the number of waits cleared. Never throws: a state file that will not parse is left for the
 * drain's own unreadable-state handling.
 */
export function resetOutOfGasWaits(home: MidaHome): number {
  let cleared = 0
  let names: string[]
  try {
    names = home.list("queue/state")
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".last.json")) continue
    const sessionId = name.slice(0, -".json".length)
    if (!isSafeName(sessionId)) continue
    const state = readState(home, sessionId)
    // a sponsor-limit wait carries no attempts field — it never counted one — so the attempts
    // check must not skip it (UF-O)
    if (state === undefined || state.failedAt === undefined) continue
    if (state.attempts === undefined && state.reason !== "sponsor-limit") continue
    if (state.reason !== undefined && !GAS_WAIT_REASONS.has(state.reason)) continue
    const { attempts: _a, failedAt: _f, reason: _r, ...rest } = state
    writeState(home, sessionId, rest)
    cleared += 1
  }
  return cleared
}

/**
 * The wait reasons a summarizer change — `mida summarizer use …` — makes stale: no model could
 * write the summary, or every model hit its usage limit. A sponsor's cap or a chain failure is
 * not the new choice's business, so those waits keep their deadlines.
 */
const SUMMARIZER_WAIT_REASONS = new Set(["summarizer-limit", "no-summarizer"])

/**
 * Clears the recorded failure wait on every session that was waiting on the summary model —
 * run after `mida summarizer use agents`/`use key` writes the new choice, so the next pass
 * retries the save at once instead of waiting out the hour. A wait recorded with no attempts
 * clears too — summarizer waits never counted one. Returns how many of the cleared waits belong
 * to a session that still has a job in the queue right now — the number the "will be tried
 * again" line depends on (UF-QC). Never throws: a state file that will not parse is left for
 * the drain's own handling.
 */
export function resetSummarizerWaits(home: MidaHome): number {
  let cleared = 0
  let names: string[]
  try {
    names = home.list("queue/state")
  } catch {
    return 0
  }
  // UF-QC: the count answers "how many queued saves just became due" — a cleared wait whose
  // session has no job in the queue right now clears anyway (it costs nothing) but is not
  // counted, so the "will be tried again" line only prints when something will
  const queued = new Set(peekJobs(home).map((job) => job.sessionId))
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".last.json")) continue
    const sessionId = name.slice(0, -".json".length)
    if (!isSafeName(sessionId)) continue
    const state = readState(home, sessionId)
    if (state === undefined || state.failedAt === undefined) continue
    if (state.reason === undefined || !SUMMARIZER_WAIT_REASONS.has(state.reason)) continue
    const { attempts: _a, failedAt: _f, reason: _r, ...rest } = state
    writeState(home, sessionId, rest)
    if (queued.has(sessionId)) cleared += 1
  }
  return cleared
}

/**
 * The only bound on `logs/*.jsonl` — appendLog itself has none — so the cap runs on every pass
 * and outside pruneQueue: a throwing sweep or a skipped housekeeping pass must never turn it
 * off (in-24, review N-4). A log grown past 5 MB keeps its last 1 MB, cut at a line boundary so
 * every kept line is a whole record; a file that will not truncate is left for the next pass.
 */
function capLogs(home: MidaHome): void {
  let names: string[]
  try {
    names = home.list("logs")
  } catch {
    return // a logs folder that will not list is left for the next pass
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    try {
      const full = home.path(`logs/${name}`)
      const size = statSync(full).size
      if (size <= LOG_MAX_BYTES) continue
      const fd = fs.openSync(full, "r")
      let tail: Buffer
      try {
        const buffer = Buffer.alloc(LOG_KEEP_BYTES)
        const read = fs.readSync(fd, buffer, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES)
        tail = buffer.subarray(0, read)
      } finally {
        fs.closeSync(fd)
      }
      // a mid-line cut would leave a corrupt first record — drop the partial line
      const firstNewline = tail.indexOf(10)
      fs.writeFileSync(full, firstNewline === -1 ? tail : tail.subarray(firstNewline + 1))
    } catch {
      // a log that will not truncate is left for the next pass
    }
  }
}

/**
 * Housekeeping, run at most once an hour per process: `queue/bad` and `queue/compiled` entries
 * older than a week, stray `.tmp` files older than an hour, and sdk- session-state files
 * (`state/tasks`, `state/lastseen`, `state/continues`) untouched for a month — at most 500 a
 * pass. The caller wraps the whole step so a failure here is logged once and never starves the
 * queue below it.
 */
function pruneQueue(home: MidaHome, now: () => Date): void {
  const nowMs = now().getTime()
  const olderThan = (path: string, ms: number): boolean => {
    try {
      return nowMs - statSync(path).mtimeMs > ms
    } catch {
      return false
    }
  }
  for (const dir of ["queue/bad", "queue/compiled"]) {
    for (const name of home.list(dir)) {
      if (olderThan(home.path(`${dir}/${name}`), WEEK_MS)) home.remove(`${dir}/${name}`)
    }
  }
  for (const dir of ["queue", "queue/bad", "queue/compiled", "queue/state", "queue/unsent"]) {
    for (const name of home.list(dir)) {
      if (name.endsWith(".tmp") && olderThan(home.path(`${dir}/${name}`), TMP_MAX_AGE_MS)) {
        home.remove(`${dir}/${name}`)
      }
    }
  }
  // CAP-26: an UNSENT mark whose session has no queued job left is a leftover (its job was removed
  // on some other pass) — swept, so a later job of that session can never resurrect an old save
  const queuedSessions = new Set(listJobs(home).map((job) => job.sessionId))
  for (const name of home.list("queue/unsent")) {
    if (name.endsWith(".json") && !queuedSessions.has(name.slice(0, -".json".length))) home.remove(`queue/unsent/${name}`)
  }
  // in-21 U-4 / in-22 V-2: each `new Mida()` mints one `sdk-…` session, the only unbounded
  // session source — so the sweep takes sdk- files ONLY and leaves hook and MCP session files
  // alone. Thirty days idle is past any resume, and "idle" means last USE: every successful
  // read of one of these files refreshes its mtime, so a live SDK handle is never swept.
  // in-22 V-3 (G-3): entries are judged by lstat — a directory, a link, or anything whose stat
  // or removal throws is skipped and counted, never followed and never fatal to the pass.
  let swept = 0
  let skipped = 0
  for (const dir of SESSION_STATE_DIRS) {
    let names: string[]
    try {
      names = home.list(dir)
    } catch {
      skipped += 1
      continue
    }
    for (const name of names) {
      if (swept >= SESSION_STATE_MAX_REMOVALS) break
      if (!name.startsWith("sdk-") || !name.endsWith(".json")) continue
      try {
        const rel = `${dir}/${name}`
        const stat = lstatSync(home.path(rel))
        if (!stat.isFile() || nowMs - stat.mtimeMs <= SESSION_STATE_MAX_AGE_MS) continue
        home.remove(rel)
        swept += 1
      } catch {
        skipped += 1
      }
    }
  }
  if (skipped > 0) {
    // in-23 R-3: a stuck entry is reported at most once a day — the mark persists across
    // processes, so the same bad file cannot fill the log on every spawned drainer's sweep
    const mark = readHousekeepingMark(home)
    const reported = typeof mark.skippedLoggedAt === "string" ? Date.parse(mark.skippedLoggedAt) : NaN
    if (!Number.isFinite(reported) || stampInFuture(home, reported, nowMs) || nowMs - reported >= DAY_MS) {
      appendLog(home, "drain", { outcome: "note", reason: "session-sweep-skipped", skipped })
      writeHousekeepingMark(home, { skippedLoggedAt: new Date(nowMs).toISOString() })
    }
  }
}

/** The persisted marks' object — absent or malformed fields read as "no mark yet". */
function readHousekeepingMark(home: MidaHome): Record<string, unknown> {
  try {
    const raw = home.readJson<unknown>(HOUSEKEEPING_MARK)
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Merges a field into the marks file; a mark that will not write never blocks a pass. */
const unwritableMarkLogged = new WeakSet<MidaHome>()
function writeHousekeepingMark(home: MidaHome, patch: Record<string, unknown>): void {
  try {
    home.writeSecretJson(HOUSEKEEPING_MARK, { ...readHousekeepingMark(home), ...patch })
  } catch {
    // in-24 (review N-3): a mark that will not write degrades the home silently no longer —
    // the failure is told once per process, and the per-process gate above still bounds this
    // process, so the pass carries on and the next spawn simply re-sweeps
    if (!unwritableMarkLogged.has(home)) {
      unwritableMarkLogged.add(home)
      appendLog(home, "drain", { outcome: "note", reason: "housekeeping-mark-unwritable" })
    }
  }
}

/**
 * True once an hour per home — the 15 s drain loop pays for a sweep hourly, not per pass. The
 * file's mark is authoritative across processes (in-23 R-3): a fresh drainer honours the sweep
 * a previous spawn ran, where the WeakMap alone could not see it.
 */
function housekeepingDue(home: MidaHome, now: () => Date): boolean {
  const at = now().getTime()
  const last = lastHousekeepingAt.get(home)
  if (last !== undefined && at - last < HOUSEKEEPING_INTERVAL_MS) return false
  const mark = readHousekeepingMark(home)
  const stamp = typeof mark.lastSweepAt === "string" ? Date.parse(mark.lastSweepAt) : NaN
  if (Number.isFinite(stamp) && !stampInFuture(home, stamp, at)) {
    lastHousekeepingAt.set(home, stamp)
    if (at - stamp < HOUSEKEEPING_INTERVAL_MS) return false
  }
  lastHousekeepingAt.set(home, at)
  return true
}

/**
 * in-24 (review F-1): a stamp the clock has not reached is not a mark that happened — a stamp
 * more than an hour ahead reads as "less than an hour ago" forever and would hold housekeeping
 * off until that date. True means reject it and treat the field as absent: the caller sweeps
 * and rewrites the mark. An hour of slack still absorbs ordinary clock drift, and the note is
 * logged once per process per home so a stamp that keeps coming back is not re-reported.
 */
const futureStampLogged = new WeakSet<MidaHome>()
function stampInFuture(home: MidaHome, stamp: number, at: number): boolean {
  if (stamp - at <= HOUSEKEEPING_INTERVAL_MS) return false
  if (!futureStampLogged.has(home)) {
    futureStampLogged.add(home)
    appendLog(home, "drain", { outcome: "note", reason: "housekeeping-stamp-in-future" })
  }
  return true
}

/** A transcript that no longer stats is sized 0 — the caller has already decided the job is done. */
function statSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** The real transcript stats for a terminal state, or zeroes when the file is already gone. */
function terminalState(path: string, savedAt: string): SessionState {
  try {
    const { bytes, lastLine } = tailOf(path)
    return {
      transcriptBytes: bytes,
      lastLineHash: bytesToHex(sha256(utf8ToBytes(lastLine))),
      savedAt,
    }
  } catch {
    return { transcriptBytes: 0, lastLineHash: "", savedAt }
  }
}

/**
 * A devin session's fingerprint in the SessionState shape: node count stands in for
 * transcriptBytes and `${main_chain_id}:${max_node_id}` for the last line — the three
 * fields that change exactly when the session changes, so an untouched session still
 * skips as unchanged and a grown one never does.
 */
function devinFingerprintOf(
  dbPath: string,
  sessionId: string,
  openDevinDb?: OpenDevinDb,
): { bytes: number; lastLine: string } {
  const stat = devinSessionStat(dbPath, sessionId, openDevinDb)
  return { bytes: stat.nodeCount, lastLine: `${stat.mainChainId ?? "none"}:${stat.maxNodeId}` }
}

/** terminalState, for whichever capture source the job's agent uses. */
function terminalStateFor(
  job: CaptureJob,
  savedAt: string,
  openDevinDb?: OpenDevinDb,
): SessionState {
  if (job.agent === "devin") {
    try {
      const { bytes, lastLine } = devinFingerprintOf(job.transcriptPath, job.sessionId, openDevinDb)
      return { transcriptBytes: bytes, lastLineHash: bytesToHex(sha256(utf8ToBytes(lastLine))), savedAt }
    } catch {
      return { transcriptBytes: 0, lastLineHash: "", savedAt }
    }
  }
  return terminalState(job.transcriptPath, savedAt)
}

/** How much of a transcript's tail is read to find its last line. */
const TAIL_BYTES = 64 * 1024

/**
 * The transcript's size and last non-empty line from one open file descriptor — a positioned read
 * of at most the final 64 KB, so a huge transcript costs a bounded read and the size and tail
 * describe the same moment. `read` is injectable so a test can count the bytes it pulls.
 */
export function tailOf(
  path: string,
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number = fs.readSync,
): { bytes: number; lastLine: string } {
  const fd = fs.openSync(path, "r")
  try {
    const bytes = fs.fstatSync(fd).size
    const length = Math.min(bytes, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const got = length === 0 ? 0 : read(fd, buffer, 0, length, bytes - length)
    const text = buffer.subarray(0, got).toString("utf8")
    let end = text.length
    while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1
    return { bytes, lastLine: text.slice(text.lastIndexOf("\n", end - 1) + 1, end) }
  } finally {
    fs.closeSync(fd)
  }
}
