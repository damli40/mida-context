import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { verifyMessage } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Hex } from "@mida/protocol"
import { loadOrCreateOwnerSecrets } from "./keys.js"
import { findProjectMarker } from "./queue.js"
import type { Runtime } from "./runtime.js"

/**
 * The owner-signed list of which agent may use which project folder. One JSON file at the home
 * root holds `{ entries, signature }`; the signature covers a canonical form of the entries (sorted
 * by agent, projectId, root; fixed key order; no whitespace), so a hand-reordered file still
 * verifies and any content change is tampering. `root` is always the realpath of the folder that
 * holds `.mida/`, so a symlinked cwd resolves to the same row.
 *
 * `checkProject` is the read side used by the drain before any compile: it returns a stable
 * refusal reason and never throws — a missing file is `not-approved`, anything present but wrong
 * is `list-tampered`, and there is no "treat corrupt as empty" path.
 */

export interface ProjectApproval {
  agent: string
  projectId: string
  root: string
  approvedAt: string
}

export type ProjectCheck =
  | { ok: true; approval: ProjectApproval }
  | { ok: false; reason: "not-a-project" | "not-approved" | "list-tampered" | "folder-mismatch" }

const LIST_FILE = "approved-projects.json"
const ENTRY_KEYS: readonly (keyof ProjectApproval)[] = ["agent", "projectId", "root", "approvedAt"]

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The bytes the signature actually covers: sorted entries, fixed key order, no whitespace. */
function canonicalEntries(entries: readonly ProjectApproval[]): string {
  const sorted = [...entries].sort(
    (a, b) => cmp(a.agent, b.agent) || cmp(a.projectId, b.projectId) || cmp(a.root, b.root),
  )
  return JSON.stringify(sorted.map((e) => ({ agent: e.agent, projectId: e.projectId, root: e.root, approvedAt: e.approvedAt })))
}

function asApproval(raw: unknown): ProjectApproval | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  // exactly the four signed fields — an extra key would be content the signature does not cover
  if (Object.keys(record).length !== ENTRY_KEYS.length) return undefined
  for (const key of ENTRY_KEYS) {
    if (typeof record[key] !== "string" || record[key] === "") return undefined
  }
  return record as unknown as ProjectApproval
}

type ApprovalsFile =
  | { kind: "missing" }
  | { kind: "tampered" }
  | { kind: "signed"; entries: ProjectApproval[] }

/** Missing is not corrupt: only a file that exists but will not parse or verify is tampered. */
async function readApprovalsFile(runtime: Runtime): Promise<ApprovalsFile> {
  let raw: unknown
  try {
    raw = runtime.home.readJson(LIST_FILE)
  } catch {
    return { kind: "tampered" }
  }
  if (raw === undefined) return { kind: "missing" }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "tampered" }
  const record = raw as Record<string, unknown>
  if (typeof record.signature !== "string" || !Array.isArray(record.entries)) return { kind: "tampered" }
  const entries: ProjectApproval[] = []
  for (const item of record.entries) {
    const entry = asApproval(item)
    if (entry === undefined) return { kind: "tampered" }
    entries.push(entry)
  }
  try {
    const ok = await verifyMessage({
      address: runtime.owner,
      message: canonicalEntries(entries),
      signature: record.signature as Hex,
    })
    if (!ok) return { kind: "tampered" }
  } catch {
    return { kind: "tampered" }
  }
  return { kind: "signed", entries }
}

async function signEntries(runtime: Runtime, entries: readonly ProjectApproval[]): Promise<Hex> {
  const account = privateKeyToAccount(loadOrCreateOwnerSecrets(runtime.home).privateKey)
  return account.signMessage({ message: canonicalEntries(entries) })
}

// Two writers in one process (e.g. two /cli calls on the daemon) read-modify-write the same file;
// serialising the critical section keeps a lost update from silently dropping a row.
let listWrites: Promise<unknown> = Promise.resolve()

function serializeListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = listWrites.then(write, write)
  listWrites = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * The folder `cwd` runs in must be a project. With no marker anywhere up the tree, `cwd` itself
 * becomes the project — unless it is the owner's home folder or the filesystem root, where creating
 * a marker would claim a project out of a directory that is not one; that throws `not-a-project`.
 * A marker that exists but carries no usable `projectId` is replaced with a fresh one.
 */
export function ensureProjectMarker(cwd: string, homeDir: string = homedir()): { markerDir: string; projectId: string } {
  const found = findProjectMarker(cwd)
  if (found !== null) {
    if (found.projectId !== null) return { markerDir: found.markerDir, projectId: found.projectId }
    const projectId = randomUUID()
    writeMarkerFile(join(found.markerDir, ".mida", "project.json"), projectId)
    return { markerDir: found.markerDir, projectId }
  }
  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    throw codedError("not-a-project", "not a project folder")
  }
  let realHome: string
  try {
    realHome = realpathSync(homeDir)
  } catch {
    realHome = resolve(homeDir)
  }
  if (realCwd === realHome || realCwd === "/") {
    throw codedError("not-a-project", "refusing to create a project marker here")
  }
  const projectId = randomUUID()
  mkdirSync(join(cwd, ".mida"), { recursive: true, mode: 0o700 })
  writeMarkerFile(join(cwd, ".mida", "project.json"), projectId)
  return { markerDir: cwd, projectId }
}

function writeMarkerFile(file: string, projectId: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ projectId })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function codedError(code: "not-a-project", message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/**
 * Adds (or refreshes) the `agent → projectId → root` row for the folder `cwd` runs in and re-signs
 * the list atomically (same-folder temp file, rename, mode 0600 — `writeSecretJson`). A list file
 * that will not verify is rebuilt from nothing: untrusted rows are never re-signed.
 */
export async function approveProject(
  runtime: Runtime,
  input: { agent: string; cwd: string; homeDir?: string },
): Promise<ProjectApproval> {
  const marker = ensureProjectMarker(input.cwd, input.homeDir)
  const root = realpathSync(marker.markerDir)
  return serializeListWrite(async () => {
    const file = await readApprovalsFile(runtime)
    const entries = file.kind === "signed" ? file.entries : []
    const kept = entries.filter(
      (e) => !(e.agent === input.agent && e.projectId === marker.projectId && e.root === root),
    )
    const approval: ProjectApproval = {
      agent: input.agent,
      projectId: marker.projectId,
      root,
      approvedAt: new Date().toISOString(),
    }
    const next = [...kept, approval]
    runtime.home.writeSecretJson(LIST_FILE, { entries: next, signature: await signEntries(runtime, next) })
    return approval
  })
}

/**
 * Removes every row naming `agent` and re-signs what remains. A file that will not verify is
 * rewritten empty — none of its rows can be trusted. A missing file stays missing. Returns the
 * number of verified rows removed.
 */
export async function removeAgentApprovals(runtime: Runtime, agent: string): Promise<number> {
  return serializeListWrite(async () => {
    const file = await readApprovalsFile(runtime)
    if (file.kind === "missing") return 0
    const entries = file.kind === "signed" ? file.entries : []
    const kept = entries.filter((e) => e.agent !== agent)
    runtime.home.writeSecretJson(LIST_FILE, { entries: kept, signature: await signEntries(runtime, kept) })
    return entries.length - kept.length
  })
}

/**
 * The drain-time gate: does the folder this job ran in belong to a project the owner approved for
 * this agent? Marker first — a folder with no marker is `not-a-project` even when the list itself
 * is broken. Then the list: missing means nobody approved anything (`not-approved`), unverifiable
 * means `list-tampered`, and a signed file decides — `folder-mismatch` when this agent's projectId
 * is listed under a different root (the folder was copied), else `not-approved`. Never throws.
 */
export async function checkProject(runtime: Runtime, input: { agent: string; cwd: string }): Promise<ProjectCheck> {
  try {
    const marker = findProjectMarker(input.cwd)
    if (marker === null || marker.projectId === null) return { ok: false, reason: "not-a-project" }
    let root: string
    try {
      root = realpathSync(marker.markerDir)
    } catch {
      return { ok: false, reason: "not-a-project" }
    }
    const file = await readApprovalsFile(runtime)
    if (file.kind === "tampered") return { ok: false, reason: "list-tampered" }
    const entries = file.kind === "signed" ? file.entries : []
    const mine = entries.filter((e) => e.agent === input.agent && e.projectId === marker.projectId)
    const match = mine.find((e) => e.root === root)
    if (match !== undefined) return { ok: true, approval: match }
    return { ok: false, reason: mine.length > 0 ? "folder-mismatch" : "not-approved" }
  } catch {
    return { ok: false, reason: "list-tampered" }
  }
}
