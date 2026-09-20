import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { readConversation } from "@mida/compiler"
import type { compileCheckpoint } from "@mida/compiler"
import { eventIdFor } from "./checkpoint-payload.js"
import type { MidaHome } from "./home.js"
import { FLUSH_EVENTS, transcriptPathAllowed } from "./hook.js"
import { appendLog } from "./log.js"
import { listJobs, moveToBad, projectIdFor, removeJob } from "./queue.js"
import type { CaptureJob } from "./queue.js"
import type { Runtime } from "./runtime.js"
import { saveCheckpoint } from "./skeleton.js"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MIN_GAP_MS = 60_000

export interface DrainDeps {
  home: MidaHome
  open: () => Promise<Runtime>
  compile: typeof compileCheckpoint
  now?: () => Date
  minGapMs?: number
  /** The user's real home folder — the transcript rule is checked against it, injected in tests. */
  homeDir?: string
}

interface SessionState {
  transcriptBytes: number
  lastLineHash: string
  savedAt: string
}

export interface DrainResult {
  saved: number
  skippedUnchanged: number
  skippedTooSoon: number
  failed: number
}

/**
 * One pass over the queue. Jobs are grouped by `sessionId` and each session is handled once, using
 * its newest job — a burst of PostToolUse events still costs a single compile — and a session that
 * saw any flush event (Stop, StopFailure, PreCompact, SessionEnd) is treated as a flush.
 *
 * Per session the drainer remembers `{ transcriptBytes, lastLineHash, savedAt }` in
 * `queue/state/<sessionId>.json`: an unchanged transcript is skipped even on a flush, and a changed
 * one inside `minGapMs` of the last save waits — its job stays queued so a later drain (or a flush)
 * still saves it. Compile and save failures keep the job for the next pass; stale jobs (older than
 * a day) and jobs whose transcript is gone are moved to `queue/bad/`.
 *
 * The runtime — lock, API server, keys — is opened lazily, only once a session has actually
 * compiled, and always closed before returning. A pass that only skips never touches the chain.
 */
export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  const now = deps.now ?? (() => new Date())
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS
  const homeDir = deps.homeDir ?? homedir()
  const counts: DrainResult = { saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 }
  const log = (record: Record<string, unknown>) => appendLog(deps.home, "drain", record)

  const bySession = new Map<string, CaptureJob[]>()
  for (const job of listJobs(deps.home)) {
    const group = bySession.get(job.sessionId)
    if (group === undefined) bySession.set(job.sessionId, [job])
    else group.push(job)
  }

  let runtime: Runtime | undefined
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
        const projectId = projectIdFor(job.cwd)
        if (projectId === null) {
          removeJob(deps.home, job.id)
          log({ sessionId, outcome: "removed", reason: "not-a-mida-project" })
          continue
        }

        const transcriptBytes = statSync(job.transcriptPath).size
        const lastLine = lastLineOf(job.transcriptPath)
        const lastLineHash = bytesToHex(sha256(utf8ToBytes(lastLine)))
        const state = readState(deps.home, sessionId)
        if (state !== undefined && state.transcriptBytes === transcriptBytes && state.lastLineHash === lastLineHash) {
          counts.skippedUnchanged += 1
          removeJob(deps.home, job.id)
          continue
        }
        if (!flush && state !== undefined && now().getTime() - Date.parse(state.savedAt) < minGapMs) {
          counts.skippedTooSoon += 1
          continue // the job stays queued: a later drain or a flush still saves it
        }

        const eventId = eventIdFor({ projectId, sessionId, transcriptBytes, lastLine })
        // a transcript that is not the Claude Code format is not sent to the model in M1 —
        // the file might have been swapped for one since the path check passed
        if (readConversation(job.transcriptPath).format === "unknown-tail") {
          moveToBad(deps.home, `${job.id}.json`)
          log({ sessionId, outcome: "bad", reason: "unknown-transcript-format" })
          continue
        }
        const compiled = await deps.compile({
          transcriptPath: job.transcriptPath,
          agent: job.agent,
          eventId,
          cwd: job.cwd,
          homeDir,
        })
        if (!compiled.ok) {
          counts.failed += 1
          log({ sessionId, outcome: "failed", reason: `compile-${compiled.reason}` })
          continue
        }
        runtime ??= await deps.open()
        await saveCheckpoint(runtime, job.agent, {
          projectId,
          sessionId,
          continuesSession: null,
          compiledBy: compiled.compiledBy,
          checkpoint: compiled.checkpoint,
        })
        writeState(deps.home, sessionId, { transcriptBytes, lastLineHash, savedAt: now().toISOString() })
        removeJob(deps.home, job.id)
        counts.saved += 1
        log({ sessionId, outcome: "saved", eventId })
      } catch (error) {
        counts.failed += 1
        log({ sessionId, outcome: "failed", reason: error instanceof Error ? error.name : "error" })
      }
    }
  } finally {
    if (runtime !== undefined) await runtime.close()
  }
  return counts
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

/** The last non-empty line of a JSONL transcript — a trailing newline does not count as a line. */
function lastLineOf(path: string): string {
  const text = readFileSync(path, "utf8")
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1
  return text.slice(text.lastIndexOf("\n", end - 1) + 1, end)
}
