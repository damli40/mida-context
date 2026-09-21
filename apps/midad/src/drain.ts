import * as fs from "node:fs"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { createPublicClient, http } from "viem"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { isMidaError } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { CONTENT_FIELDS, validateCheckpoint } from "@mida/checkpoint"
import type { Checkpoint } from "@mida/checkpoint"
import { chainFor, parseDeployment } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { RegistryReader } from "@mida/api"
import { readConversation } from "@mida/compiler"
import type { compileCheckpoint } from "@mida/compiler"
import { CheckpointPayloadError, eventIdFor, unwrapCheckpoint, wrapCheckpoint } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"
import type { MidaHome } from "./home.js"
import { FLUSH_EVENTS, transcriptPathAllowed } from "./hook.js"
import { loadAgentIdentity, loadGrants } from "./keys.js"
import { appendLog } from "./log.js"
import { checkProject as checkProjectAgainstList } from "./projects.js"
import type { ProjectCheck } from "./projects.js"
import { findProjectMarker, isSafeName, listJobs, moveToBad, removeJob } from "./queue.js"
import type { CaptureJob } from "./queue.js"
import type { ServiceRuntime } from "./runtime.js"
import { isCapabilityLive } from "./skeleton.js"
import { saveCheckpoint } from "./skeleton.js"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MIN_GAP_MS = 60_000
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
  "list-tampered",
  "list-unreadable",
  "folder-mismatch",
  "check-failed",
  "transcript-project-mismatch",
])
/**
 * A checkpoint the validator rejects is usually fixed by a fresh model call, so
 * `invalid-checkpoint` is transient for the first two attempts; the third is permanent.
 */
const INVALID_CHECKPOINT_MAX_ATTEMPTS = 3
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, MAX_BACKOFF_MS)

export interface DrainDeps {
  home: MidaHome
  /** opens a fresh runtime — used when `runtime` is not supplied; the drain closes what it opens */
  open?: () => Promise<ServiceRuntime>
  /** an already-open runtime owned by the caller (the daemon) — the drain uses it and never closes it */
  runtime?: ServiceRuntime
  compile: typeof compileCheckpoint
  now?: () => Date
  minGapMs?: number
  /** The user's real home folder — the transcript rule is checked against it, injected in tests. */
  homeDir?: string
  /** The chain save — injectable so rule tests never need a chain. Defaults to saveCheckpoint. */
  save?: typeof saveCheckpoint
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
}

export interface DrainResult {
  saved: number
  skippedUnchanged: number
  skippedTooSoon: number
  failed: number
  /** Earliest epoch ms at which a held-back job becomes due, or null when nothing is waiting. */
  earliestDueMs: number | null
  /** True when a live `queue/drain.lock` stopped this run before it touched the queue. */
  lockHeld?: boolean
}

const emptyResult = (): DrainResult => ({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0, earliestDueMs: null })

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
      total.failed += result.failed
      total.skippedUnchanged += result.skippedUnchanged
      total.skippedTooSoon += result.skippedTooSoon
      const remaining = listJobs(deps.home).length
      // a job that arrived mid-pass was never listed by it: a pass that saved, or one that left
      // jobs it cannot account for, re-lists and goes again — bounded so a queue that never
      // empties cannot loop the drainer forever
      if (remaining > 0 && extraPasses < MAX_EXTRA_PASSES && (result.saved > 0 || result.earliestDueMs === null)) {
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
 * only after `60 s × 2^attempts` (capped at an hour); the eighth attempt moves the job to
 * `queue/bad/` as `gave-up`. A permanent failure removes the job and records the transcript state
 * so an identical job later skips as unchanged. A compiled envelope is cached at
 * `queue/compiled/<eventId>.json` so a retried save never pays for a second model call.
 *
 * The runtime — lock, API server, keys — is opened lazily, only once a session has actually
 * compiled, and always closed before returning. A pass that only skips never touches the chain.
 * An injected `runtime` (the daemon's) is used as-is and left open — the caller owns its life.
 */
async function drainPass(deps: DrainDeps, now: () => Date): Promise<DrainResult> {
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS
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

  pruneQueue(deps.home, now)

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
      for (const older of group.slice(0, -1)) removeJob(deps.home, older.id)
      const flush = group.some((j) => FLUSH_EVENTS.has(j.event))
      try {
        if (now().getTime() - Date.parse(job.at) > DAY_MS) {
          moveToBad(deps.home, `${job.id}.json`)
          log({ sessionId, outcome: "bad", reason: "older-than-24h" })
          continue
        }
        // the hook checked this path at enqueue, but the file could have been swapped since —
        // re-check the same rule before the drainer opens it
        if (!transcriptPathAllowed(job.transcriptPath, job.agent, homeDir)) {
          moveToBad(deps.home, `${job.id}.json`)
          log({ sessionId, outcome: "bad", reason: "bad-transcript-path" })
          continue
        }
        // the owner-signed project list decides before the transcript is even opened: a refusal
        // is permanent for this job — it is removed with the stable reason and never compiled
        const project = await checkProject({ agent: job.agent, cwd: job.cwd })
        if (!project.ok) {
          removeJob(deps.home, job.id)
          log({ sessionId, outcome: "removed", reason: project.reason })
          continue
        }
        const projectId = project.approval.projectId

        // size and last line come from ONE open descriptor — a growing transcript cannot show
        // the drainer a size and a tail from different moments
        const { bytes: transcriptBytes, lastLine } = tailOf(job.transcriptPath)
        const lastLineHash = bytesToHex(sha256(utf8ToBytes(lastLine)))
        const state = readState(deps.home, sessionId)
        const stateMatches = state !== undefined && state.transcriptBytes === transcriptBytes && state.lastLineHash === lastLineHash
        const terminal = { transcriptBytes, lastLineHash, savedAt: now().toISOString() }
        if (stateMatches && (state.attempts ?? 0) === 0) {
          counts.skippedUnchanged += 1
          removeJob(deps.home, job.id)
          continue
        }
        // a transcript that is not the Claude Code format is not sent to the model in M1 —
        // the file might have been swapped for one since the path check passed
        const convo = readConversation(job.transcriptPath)
        if (convo.format === "unknown-tail") {
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
          log({ sessionId, outcome: "removed", reason: "not-approved" })
          continue
        }
        const attempts = state?.attempts ?? 0
        if (attempts > 0 && state?.failedAt !== undefined) {
          const due = Date.parse(state.failedAt) + backoffMs(attempts)
          if (now().getTime() < due) {
            counts.skippedTooSoon += 1
            dueSooner(due)
            continue // the job stays queued: the retry fires once the backoff has passed
          }
        }
        // No saved state yet: the gap runs from the session's OLDEST queued job, so the first
        // non-flush save lands one gap after the session's first event, not immediately.
        const gapRef = Date.parse(state?.savedAt ?? group[0]!.at)
        if (!flush && now().getTime() - gapRef < minGapMs) {
          counts.skippedTooSoon += 1
          dueSooner(gapRef + minGapMs)
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
            eventId,
            cwd: job.cwd,
            homeDir,
            previous: previous.checkpoint,
          })
          const compileMs = now().getTime() - compileStart
          if (!compiled.ok) {
            if (compiled.reason === "invalid") throw new CheckpointPayloadError("invalid-checkpoint", "the compiler produced an invalid checkpoint", compiled.fields)
            throw new DrainFailure(compiled.reason)
          }
          envelope = wrapCheckpoint({
            projectId,
            sessionId,
            continuesSession: readContinues(deps.home, sessionId, projectId),
            compiledBy: compiled.compiledBy,
            checkpoint: compiled.checkpoint,
          })
          compileMeta = {
            compileMs,
            attempts: compiled.attempts,
            trimmed: compiled.trimmed,
            droppedKeys: compiled.droppedKeys,
          }
          deps.home.writeSecretJson(`queue/compiled/${eventId}.json`, { ...envelope, compileMeta })
          reusedCompiled = false
        }
        const runtime = await openRuntime()
        const saveStart = now().getTime()
        await save(runtime, job.agent, {
          projectId: envelope.projectId,
          sessionId: envelope.sessionId,
          continuesSession: envelope.continuesSession,
          compiledBy: envelope.compiledBy,
          checkpoint: envelope.checkpoint,
        })
        const saveMs = now().getTime() - saveStart
        writeState(deps.home, sessionId, terminal)
        // the saved checkpoint's content fields are the next compile's `previous`
        const content: Record<string, unknown> = {}
        for (const field of CONTENT_FIELDS) content[field] = envelope.checkpoint[field]
        deps.home.writeSecretJson(`queue/state/${sessionId}.last.json`, content)
        removeJob(deps.home, job.id)
        counts.saved += 1
        log({
          sessionId,
          outcome: "saved",
          eventId,
          compileMs: compileMeta.compileMs,
          saveMs,
          attempts: compileMeta.attempts,
          reusedCompiled,
          trimmed: compileMeta.trimmed,
          droppedKeys: compileMeta.droppedKeys,
        })
      } catch (error) {
        const code = failureCode(error)
        // field names are safe to log; values, validator messages and error.message are not
        const fields = error instanceof CheckpointPayloadError && error.fields !== undefined ? { fields: error.fields } : {}
        if (PERMANENT_FAILURES.has(code)) {
          if (code === "not-approved") {
            for (const other of listJobs(deps.home)) if (other.agent === job.agent) removeJob(deps.home, other.id)
          } else {
            moveToBad(deps.home, `${job.id}.json`)
          }
          // terminal state records the real transcript stats: an identical job later skips as unchanged
          writeState(deps.home, sessionId, terminalState(job.transcriptPath, now().toISOString()))
          log({ sessionId, outcome: "bad", reason: code, ...fields })
          continue
        }
        // transient: keep the job, count the attempt, and hold the session until the backoff passes
        const attempts = (readState(deps.home, sessionId)?.attempts ?? 0) + 1
        counts.failed += 1
        const invalidGaveUp = code === "invalid-checkpoint" && attempts >= INVALID_CHECKPOINT_MAX_ATTEMPTS
        if (attempts >= MAX_ATTEMPTS || invalidGaveUp) {
          moveToBad(deps.home, `${job.id}.json`)
          writeState(deps.home, sessionId, terminalState(job.transcriptPath, now().toISOString()))
          log({ sessionId, outcome: "bad", reason: invalidGaveUp ? "invalid-checkpoint" : "gave-up", ...fields })
          continue
        }
        writeState(deps.home, sessionId, {
          // an empty lastLineHash can never match a real transcript, so the state never reads as
          // "unchanged" — the retry is governed by attempts/failedAt alone
          transcriptBytes: statSize(job.transcriptPath),
          lastLineHash: "",
          savedAt: readState(deps.home, sessionId)?.savedAt ?? job.at,
          attempts,
          failedAt: now().toISOString(),
        })
        dueSooner(now().getTime() + backoffMs(attempts))
        log({ sessionId, outcome: "failed", reason: code, attempts, ...fields })
      }
    }
  } finally {
    if (opened !== undefined) await opened.close()
  }
  return counts
}

/** A transient failure raised inside the drain pass, carrying the stable code the log uses. */
class DrainFailure extends Error {
  constructor(readonly code: "model-failed" | "no-json") {
    super(code)
    this.name = "DrainFailure"
  }
}

/** Maps any thrown value onto a stable drain code; everything unrecognised is a transient chain-error. */
function failureCode(error: unknown): string {
  if (error instanceof DrainFailure) return error.code
  if (error instanceof CheckpointPayloadError) return error.code
  if (
    isMidaError(error, "CAPABILITY_DENIED") || isMidaError(error, "CAPABILITY_EXPIRED") ||
    isMidaError(error, "CAPABILITY_REVOKED")
  ) return "not-approved"
  // a refused send is transient: the ceiling may pass on retry after the queue settles or the
  // estimate changes — the job stays and the usual backoff applies (R3-1)
  if (isMidaError(error, "GAS_CEILING_EXCEEDED")) return "gas-ceiling"
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
async function agentApprovedOnChain(home: MidaHome, agent: string, ownerOf: () => Promise<Address | undefined>): Promise<boolean> {
  const identity = loadAgentIdentity(home, agent)
  if (identity === undefined) return false
  let owner = loadGrants(home, agent)[0]?.owner
  if (typeof owner !== "string") {
    owner = await ownerOf()
    if (typeof owner !== "string") throw new Error(`cannot determine the owner for ${agent}'s approval check`)
  }
  const stored = home.readJson<{ rpcUrl?: unknown; deployment?: unknown }>("network.json")
  if (typeof stored?.rpcUrl !== "string" || stored.deployment === undefined) {
    throw new Error("network.json is missing or incomplete; run mida init first")
  }
  const deployment = parseDeployment(stored.deployment)
  const context: ChainContext = {
    publicClient: createPublicClient({ chain: chainFor(deployment.chainId), transport: http(stored.rpcUrl) }),
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
  trimmed: string[]
  droppedKeys: string[]
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
        trimmed: Array.isArray(meta.trimmed) ? meta.trimmed : [],
        droppedKeys: Array.isArray(meta.droppedKeys) ? meta.droppedKeys : [],
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

/**
 * The session's last saved checkpoint, kept as its ten content fields at
 * `queue/state/<sessionId>.last.json`, becomes the next compile's `previous`.
 * The file is drainer-written but still untrusted input: it must hold only the
 * content fields and pass validation, or the compile starts from nothing and
 * the pass logs `previous-unreadable`.
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
  if (Object.keys(record).some((k) => !(CONTENT_FIELDS as readonly string[]).includes(k))) return { unreadable: true }
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
    return record.continues
  } catch {
    return null
  }
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

/**
 * Housekeeping on every drain: `queue/bad` and `queue/compiled` entries older than a week, stray
 * `.tmp` files older than an hour, and any JSONL log grown past 5 MB cut back to its last 1 MB
 * (starting at a line boundary so every kept line is a whole record). Nothing here throws.
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
  for (const dir of ["queue", "queue/bad", "queue/compiled", "queue/state"]) {
    for (const name of home.list(dir)) {
      if (name.endsWith(".tmp") && olderThan(home.path(`${dir}/${name}`), TMP_MAX_AGE_MS)) {
        home.remove(`${dir}/${name}`)
      }
    }
  }
  for (const name of home.list("logs")) {
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
