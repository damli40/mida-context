import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { MidaHome } from "./home.js"
import { findProjectMarker, isSafeName } from "./queue.js"

/**
 * Named tasks (tk-1): one Mida project can carry several efforts at once — two agents working
 * different jobs in the same folder each get their own checkpoint thread instead of one shared
 * pile. A task is just a name; the name travels inside the sealed checkpoint envelope, and the
 * only local state is which task a FOLDER defaults to (`.mida/task.json` beside the marker) and
 * which task a SESSION was captured under (`state/tasks/<sessionId>.json` in the Mida home).
 *
 * The resolution rule (invariant 1): the session's task is decided ONCE — the agent's own
 * MIDA_TASK, then whatever this session was already pinned to, then the task a predecessor
 * session's handoff recorded, then the folder's current task, then "main". Everything after that
 * first resolution reads the pin, so `mida task <other>` run mid-session can never move a live
 * session's later saves into the new task.
 */

/** The one rule every task name obeys — the refusal prints it verbatim. */
export const TASK_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
export const DEFAULT_TASK = "main"
/** The rule stated once, for `mida task`'s refusal line. */
export const TASK_RULE_TEXT = "a task name is 1-40 characters of lowercase letters, digits and '-', starting with a letter or digit"

export function isTaskName(value: unknown): value is string {
  return typeof value === "string" && TASK_NAME.test(value)
}

/** `undefined` or a valid task name — anything else in a trusted field is dropped, not trusted. */
export function taskOrUndefined(value: unknown): string | undefined {
  return isTaskName(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// The folder's current task — `<markerDir>/.mida/task.json` holding { task }
// ---------------------------------------------------------------------------

export interface FolderTask {
  /** The folder's current task — undefined means "main" (no file, or an unreadable one). */
  task: string | undefined
  /** True when a file exists but is no valid task file — worth a doctor line, never a guess. */
  invalid: boolean
}

const FOLDER_TASK_FILE = "task.json"

function folderTaskPath(markerDir: string): string {
  return join(markerDir, ".mida", FOLDER_TASK_FILE)
}

/**
 * The folder's current task. A missing file is "main" by definition; a file that will not parse,
 * or parses to something that is not a valid name, is invalid — the caller reports it and the
 * resolution falls back to main, because half a remembered task is worse than none.
 */
export function readFolderTask(markerDir: string): FolderTask {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(folderTaskPath(markerDir), "utf8"))
  } catch {
    return { task: undefined, invalid: existsSync(folderTaskPath(markerDir)) }
  }
  const task = (raw as { task?: unknown } | null)?.task
  return isTaskName(task) ? { task, invalid: false } : { task: undefined, invalid: true }
}

/**
 * The same write the project marker gets: a 0600 temp file renamed into place under a 0700
 * `.mida`. `main` and `--clear` share the empty state — setting main removes the file, so a
 * folder that never named a task and one that went back to main are indistinguishable.
 */
export function writeFolderTask(markerDir: string, task: string): void {
  if (!isTaskName(task)) throw codedTaskError("bad-task", `refused: "${task}" — ${TASK_RULE_TEXT}`)
  const file = folderTaskPath(markerDir)
  if (task === DEFAULT_TASK) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(join(markerDir, ".mida"), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ task })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Back to `main` — same empty state as never naming a task. */
export function clearFolderTask(markerDir: string): void {
  rmSync(folderTaskPath(markerDir), { force: true })
}

/**
 * The folder `cwd` runs in: its marker dir, its projectId, and its current task. Not a project
 * (no marker anywhere up the tree) reads as markerDir null — callers decide whether that is a
 * refusal or just means "default".
 */
export function folderTaskFor(cwd: string): { markerDir: string | null; projectId: string | null } & FolderTask {
  const marker = findProjectMarker(cwd)
  if (marker === null) return { markerDir: null, projectId: null, task: undefined, invalid: false }
  return { markerDir: marker.markerDir, projectId: marker.projectId, ...readFolderTask(marker.markerDir) }
}

function codedTaskError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// The session pin — `state/tasks/<sessionId>.json` holding { task, projectId }
// ---------------------------------------------------------------------------

/**
 * The task captured for a session. Only a record that names THIS project counts — a session id
 * recycled into another project must not import the old task. A missing, unreadable, malformed
 * or foreign record is simply "no pin".
 */
export function readSessionTask(home: MidaHome, sessionId: string, projectId: string): string | undefined {
  if (!isSafeName(sessionId)) return undefined
  try {
    const raw = home.readJson<unknown>(`state/tasks/${sessionId}.json`)
    if (typeof raw !== "object" || raw === null) return undefined
    const record = raw as Record<string, unknown>
    if (record.projectId !== projectId || !isTaskName(record.task)) return undefined
    // the pin ages by last use, not by write — a live session's read keeps it out of the sweep
    home.touch(`state/tasks/${sessionId}.json`)
    return record.task
  } catch {
    return undefined
  }
}

/**
 * First write wins: the pin is how a session's task stays immutable, so an existing record —
 * even a racing one — is authoritative over whatever this call resolved. Returns the task the
 * session must actually run under: the existing pin's when one was already there, this call's
 * otherwise. A failed write degrades to the resolved task in memory, never a thrown hook path.
 */
export function pinSessionTask(home: MidaHome, sessionId: string, projectId: string, task: string): string {
  if (!isSafeName(sessionId) || !isTaskName(task)) return task
  try {
    const created = home.createSecretJsonExclusive(`state/tasks/${sessionId}.json`, { task, projectId })
    if (created) return task
    return readSessionTask(home, sessionId, projectId) ?? task
  } catch {
    return task
  }
}

/**
 * The task a served handoff recorded beside its continuation link for this session —
 * `state/continues/<sessionId>.json` gains a `task` field so a resume can inherit the
 * predecessor's task when no pin was ever written (a session that crashed before its own start
 * event, or a pin write that failed). Same scoping rule as the pin: the record must name THIS
 * project; a missing or malformed task simply does not vote.
 */
export function continuedTaskFor(home: MidaHome, sessionId: string, projectId: string): string | undefined {
  if (!isSafeName(sessionId)) return undefined
  try {
    const raw = home.readJson<unknown>(`state/continues/${sessionId}.json`)
    if (typeof raw !== "object" || raw === null) return undefined
    const record = raw as Record<string, unknown>
    if (record.projectId !== projectId || !isTaskName(record.task)) return undefined
    // last use, not creation: a session still being read is still alive
    home.touch(`state/continues/${sessionId}.json`)
    return record.task
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The one resolution order every entry point shares
// ---------------------------------------------------------------------------

export type TaskSource = "explicit" | "session" | "continues" | "folder" | "default"

/**
 * Where a session's task comes from, in the order the brief fixes. `explicit` is the agent's own
 * launch request — MIDA_TASK the hooks capture, `--task`/`task` the adapter and the socket carry.
 * It wins over the pin because the pin itself was written from this same answer at session start;
 * a pin only proves what was resolved before, so when an explicit task is present it IS the
 * session's answer. `continues` is how a resumed session inherits its predecessor's task when it
 * was never pinned; `folder` is `mida task <name>`'s live default; the empty state is `main`.
 */
export function resolveSessionTask(
  home: MidaHome,
  input: { sessionId?: string; projectId?: string; cwd?: string; explicit?: string },
): { task: string; source: TaskSource } {
  if (input.explicit !== undefined) return { task: input.explicit, source: "explicit" }
  if (input.sessionId !== undefined && input.projectId !== undefined) {
    const pinned = readSessionTask(home, input.sessionId, input.projectId)
    if (pinned !== undefined) return { task: pinned, source: "session" }
    const inherited = continuedTaskFor(home, input.sessionId, input.projectId)
    if (inherited !== undefined) return { task: inherited, source: "continues" }
  }
  if (input.cwd !== undefined) {
    const { task } = folderTaskFor(input.cwd)
    if (task !== undefined) return { task, source: "folder" }
  }
  return { task: DEFAULT_TASK, source: "default" }
}
