import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { MidaHome } from "./home.js"
import type { HookEvent } from "./hook.js"

/**
 * The disk queue is the contract between the hook (milliseconds, fail-open) and the drainer (slow,
 * owns the chain). A job is one JSON file under `queue/`; filenames sort oldest-first because they
 * lead with the enqueue instant. Files that will not parse, are stale, or lost their transcript are
 * moved aside into `queue/bad/` rather than retried forever.
 */
export interface CaptureJob {
  id: string
  agent: string
  /** A Claude Code save event, or Devin's `PostCompaction` — the one devin-only save event. */
  event: HookEvent | "PostCompaction"
  sessionId: string
  /** The session's capture source — a transcript file, or the Devin sessions database. */
  transcriptPath: string
  cwd: string
  error: string | null
  at: string
}

/**
 * Hook input is untrusted: a session id or agent name becomes a filename inside the home
 * (`queue/state/<sessionId>.json`, `agents/<agent>/…`), so it can only be a short safe name —
 * never a path. "." and ".." are safe-name-shaped but mean folders, so they are out too.
 */
export const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/

export function isSafeName(value: unknown): value is string {
  return typeof value === "string" && SAFE_NAME.test(value) && value !== "." && value !== ".."
}

export function enqueue(
  home: MidaHome,
  job: Omit<CaptureJob, "id" | "at">,
  now: () => Date = () => new Date(),
): CaptureJob {
  if (!isSafeName(job.agent)) throw new Error("bad-agent")
  if (!isSafeName(job.sessionId)) throw new Error("bad-session-id")
  const at = now().toISOString()
  const id = `${at}-${randomBytes(4).toString("hex")}`
  const full: CaptureJob = { ...job, id, at }
  home.writeSecretJson(`queue/${id}.json`, full)
  return full
}

/** Oldest first. Files that will not parse or lack the job shape are moved to `queue/bad/`. */
export function listJobs(home: MidaHome): CaptureJob[] {
  const jobs: CaptureJob[] = []
  for (const name of home.list("queue").filter((n) => n.endsWith(".json")).sort()) {
    try {
      const job = asJob(home.readJson<unknown>(`queue/${name}`), name.slice(0, -".json".length))
      if (job === undefined) throw new Error("not a job file")
      jobs.push(job)
    } catch {
      moveToBad(home, name)
    }
  }
  return jobs
}

/**
 * The same listing as listJobs but strictly read-only, for a caller that only reports on the
 * queue — the handoff's "newer saves have not reached Monad" line. A file that will not parse
 * is skipped in place, never moved aside: reporting must not reorder, quarantine or otherwise
 * touch the drainer's work list. `limit` bounds the files READ, oldest first — a flooded queue
 * costs one bounded look, not an unbounded one. A queue folder that cannot be listed at all
 * still throws — the caller decides whether that is a refused answer or a quietly missing note.
 */
export function peekJobs(home: MidaHome, limit = Number.POSITIVE_INFINITY): CaptureJob[] {
  const jobs: CaptureJob[] = []
  for (const name of home.list("queue").filter((n) => n.endsWith(".json")).sort().slice(0, limit)) {
    try {
      const job = asJob(home.readJson<unknown>(`queue/${name}`), name.slice(0, -".json".length))
      if (job !== undefined) jobs.push(job)
    } catch {
      // skipped where it sits — a read-only view leaves even a corrupt file exactly as found
    }
  }
  return jobs
}

export function removeJob(home: MidaHome, id: string): void {
  home.remove(`queue/${id}.json`)
}

/** Moves one queue file aside into `queue/bad/`, where it is never listed or retried. */
export function moveToBad(home: MidaHome, fileName: string): void {
  try {
    const to = home.path(`queue/bad/${fileName}`)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    renameSync(home.path(`queue/${fileName}`), to)
  } catch {
    // a file that will not move stays put; the next pass tries again
  }
}

function asJob(raw: unknown, id: string): CaptureJob | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (
    typeof r.agent !== "string" || typeof r.event !== "string" || typeof r.sessionId !== "string" ||
    typeof r.transcriptPath !== "string" || typeof r.cwd !== "string" ||
    // an `at` that will not parse could never age past the 24-hour stale rule — treat it as corrupt
    typeof r.at !== "string" || Number.isNaN(Date.parse(r.at)) ||
    (r.error !== null && typeof r.error !== "string") ||
    // a hand-crafted file with path-shaped names must never reach writeState/loadAgentIdentity
    !isSafeName(r.agent) || !isSafeName(r.sessionId)
  ) return undefined
  return {
    id, // the filename is canonical: it is what removeJob/moveToBad address
    agent: r.agent,
    event: r.event as HookEvent | "PostCompaction",
    sessionId: r.sessionId,
    transcriptPath: r.transcriptPath,
    cwd: r.cwd,
    error: r.error as string | null,
    at: r.at,
  }
}

/**
 * Walks from `cwd` up to the filesystem root looking for `.mida/project.json` — the marker that a
 * folder is a Mida project. Returns the folder that holds `.mida` (`markerDir`, unresolved — callers
 * needing the canonical path take its realpath) and the marker's `projectId`. A marker that exists
 * but does not carry a non-empty string `projectId` means "not a Mida project" (`projectId: null`),
 * not "keep walking": attributing the session to some ancestor's project would save the checkpoint
 * under the wrong id.
 */
export function findProjectMarker(cwd: string): { markerDir: string; projectId: string | null } | null {
  let dir = resolve(cwd)
  for (;;) {
    const marker = join(dir, ".mida", "project.json")
    if (existsSync(marker)) {
      let projectId: string | null = null
      try {
        const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"))
        const id = (parsed as { projectId?: unknown } | null)?.projectId
        projectId = typeof id === "string" && id !== "" ? id : null
      } catch {
        projectId = null
      }
      return { markerDir: dir, projectId }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The marker's `projectId`, or `null` when `cwd` is not inside a marked project. */
export function projectIdFor(cwd: string): string | null {
  return findProjectMarker(cwd)?.projectId ?? null
}
