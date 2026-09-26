import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { verifyMessage } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "@mida/protocol"
import { loadOrCreateOwnerSecrets } from "./keys.js"
import { findProjectMarker } from "./queue.js"
import type { Runtime, ServiceRuntime } from "./runtime.js"

/**
 * The owner-signed list of which agent may use which project folder. One JSON file at the home
 * root holds `{ entries, signature }`; the signature covers a canonical form of the entries (sorted
 * by agent, projectId, root; fixed key order; no whitespace), so a hand-reordered file still
 * verifies and any content change is tampering. `root` is always the realpath of the folder that
 * holds `.mida/`, so a symlinked cwd resolves to the same row.
 *
 * `checkProject` is the read side used by the drain before any compile: it returns a stable
 * refusal reason and never throws — a missing file is `not-approved`, a file that will not read
 * or parse is `list-unreadable`, one that parses but fails shape or signature is `list-tampered`,
 * and there is no "treat corrupt as empty" path.
 *
 * Every realpath here is `realpathSync.native` (in-6 R6): plain realpathSync keeps the case a
 * path was TYPED in on macOS, so `~/documents/notes` and `~/Documents/Notes`
 * compared unequal — the approved folder answered "not approved" while approve insisted it was.
 * Rows written before the fix may carry the typed-case root, so comparisons canonicalise the
 * stored side too (a stored root that no longer exists simply cannot match).
 */

export interface ProjectApproval {
  agent: string
  projectId: string
  root: string
  approvedAt: string
}

export type ProjectCheck =
  | { ok: true; approval: ProjectApproval }
  | { ok: false; reason: "not-a-project" | "not-approved" | "list-tampered" | "list-unreadable" | "folder-mismatch" | "check-failed" }

const LIST_FILE = "approved-projects.json"
const ENTRY_KEYS: readonly (keyof ProjectApproval)[] = ["agent", "projectId", "root", "approvedAt"]

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * One root equality for stored-row comparisons: `realRoot` is already the `.native` canonical
 * form; `stored` may be a pre-fix typed-case realpath. Canonicalising the stored side bridges
 * the two; a stored root that no longer exists cannot be canonicalised and is not a match.
 */
export function sameProjectRoot(stored: string, realRoot: string): boolean {
  if (stored === realRoot) return true
  try {
    return realpathSync.native(stored) === realRoot
  } catch {
    return false
  }
}

/** The bytes the signature actually covers: sorted entries, fixed key order, no whitespace. */
export function canonicalEntries(entries: readonly ProjectApproval[]): string {
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

export type ApprovalsFile =
  | { kind: "missing" }
  | { kind: "unreadable" }
  /** `rows` is the entry count when the file held a countable list, else null — for reporting. */
  | { kind: "bad-signature"; rows: number | null }
  | { kind: "signed"; entries: ProjectApproval[] }

/**
 * Missing is not corrupt, and unreadable is not a signature failure: a read or JSON.parse throw
 * is `unreadable` — a permissions or filesystem problem with a different fix. Anything that
 * parses but fails shape or verification is `bad-signature` — content nobody signed.
 */
export async function readApprovalsFile(home: ServiceRuntime["home"], owner: Address): Promise<ApprovalsFile> {
  let raw: unknown
  try {
    raw = home.readJson(LIST_FILE)
  } catch {
    return { kind: "unreadable" }
  }
  if (raw === undefined) return { kind: "missing" }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "bad-signature", rows: null }
  const record = raw as Record<string, unknown>
  const rows = Array.isArray(record.entries) ? record.entries.length : null
  if (typeof record.signature !== "string" || !Array.isArray(record.entries)) return { kind: "bad-signature", rows }
  const entries: ProjectApproval[] = []
  for (const item of record.entries) {
    const entry = asApproval(item)
    if (entry === undefined) return { kind: "bad-signature", rows }
    entries.push(entry)
  }
  try {
    const ok = await verifyMessage({
      address: owner,
      message: canonicalEntries(entries),
      signature: record.signature as Hex,
    })
    if (!ok) return { kind: "bad-signature", rows }
  } catch {
    return { kind: "bad-signature", rows }
  }
  return { kind: "signed", entries }
}

/**
 * The list's integrity for `mida doctor` — read and signature-verified without a runtime, because
 * verification is local cryptography against the owner's address. `midad`'s lock is never needed.
 */
export async function approvalsFileStatus(home: ServiceRuntime["home"], owner: Address): Promise<"missing" | "unreadable" | "bad-signature" | "signed"> {
  return (await readApprovalsFile(home, owner)).kind
}

async function signEntries(runtime: Runtime, entries: readonly ProjectApproval[]): Promise<Hex> {
  const account = privateKeyToAccount(loadOrCreateOwnerSecrets(runtime.home).privateKey)
  return account.signMessage({ message: canonicalEntries(entries) })
}

// Owner commands run in one `mida` process, and a single command can write the list more than
// once (the grant, then the project row; a revoke, then a re-approve). read-modify-write is
// serialised so a lost update can never silently drop a row.
let listWrites: Promise<unknown> = Promise.resolve()

export function serializeListWrite<T>(write: () => Promise<T>): Promise<T> {
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
    realCwd = realpathSync.native(cwd)
  } catch {
    throw codedError("not-a-project", "not a project folder")
  }
  let realHome: string
  try {
    realHome = realpathSync.native(homeDir)
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
 * the list atomically (same-folder temp file, rename, mode 0600 — `writeSecretJson`). A list that
 * parses but will not verify is rebuilt from nothing — untrusted rows are never re-signed — and
 * `droppedRows` reports how many it discarded (null when they could not be counted). A list that
 * cannot be READ is a different problem: rebuilding it would silently destroy every other row, so
 * the command refuses with the permissions message and writes nothing.
 */
export async function approveProject(
  runtime: Runtime,
  input: { agent: string; cwd: string; homeDir?: string },
): Promise<{ approval: ProjectApproval; droppedRows: number | null; alreadyListed: boolean }> {
  const marker = ensureProjectMarker(input.cwd, input.homeDir)
  const root = realpathSync.native(marker.markerDir)
  return serializeListWrite(async () => {
    const file = await readApprovalsFile(runtime.home, runtime.owner)
    if (file.kind === "unreadable") {
      const error = new Error("the approved-projects list could not be read: check the file's permissions") as Error & { code: string }
      error.code = "list-unreadable"
      throw error
    }
    const entries = file.kind === "signed" ? file.entries : []
    // whether this exact row was already signed in — the caller's message must not claim a folder
    // was "now approved" when the list already said so. The stored side is canonicalised too, so
    // a pre-fix typed-case row dedupes instead of duplicating.
    const alreadyListed = entries.some(
      (e) => e.agent === input.agent && e.projectId === marker.projectId && sameProjectRoot(e.root, root),
    )
    const kept = entries.filter(
      (e) => !(e.agent === input.agent && e.projectId === marker.projectId && sameProjectRoot(e.root, root)),
    )
    const approval: ProjectApproval = {
      agent: input.agent,
      projectId: marker.projectId,
      root,
      approvedAt: new Date().toISOString(),
    }
    const next = [...kept, approval]
    runtime.home.writeSecretJson(LIST_FILE, { entries: next, signature: await signEntries(runtime, next) })
    return { approval, droppedRows: file.kind === "bad-signature" ? file.rows : 0, alreadyListed }
  })
}

/**
 * Writes a list the OWNER PAGE signed (M3-F2): the passkey holds the signing key, so the file
 * arrives pre-signed. The caller verifies the signature and the entry set before this runs —
 * this function only serialises the write with the software-mode writers.
 */
export async function writeSignedApprovals(
  home: ServiceRuntime["home"],
  entries: readonly ProjectApproval[],
  signature: Hex,
): Promise<void> {
  return serializeListWrite(async () => {
    home.writeSecretJson(LIST_FILE, { entries, signature })
  })
}

/**
 * Removes every row naming `agent` and re-signs what remains. A file that will not verify is
 * rewritten empty — none of its rows can be trusted. A missing file stays missing. Returns the
 * number of verified rows removed.
 */
export async function removeAgentApprovals(runtime: Runtime, agent: string): Promise<number> {
  return serializeListWrite(async () => {
    const file = await readApprovalsFile(runtime.home, runtime.owner)
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
 * is broken. Then the list: missing means nobody approved anything (`not-approved`), unreadable
 * means `list-unreadable`, a failed signature is `list-tampered`, and a signed file decides —
 * `folder-mismatch` when this agent's projectId
 * is listed under a different root (the folder was copied), else `not-approved`. Never throws.
 */
export async function checkProject(runtime: ServiceRuntime, input: { agent: string; cwd: string }): Promise<ProjectCheck> {
  try {
    const marker = findProjectMarker(input.cwd)
    if (marker === null || marker.projectId === null) return { ok: false, reason: "not-a-project" }
    let root: string
    try {
      root = realpathSync.native(marker.markerDir)
    } catch {
      return { ok: false, reason: "not-a-project" }
    }
    const file = await readApprovalsFile(runtime.home, runtime.owner)
    if (file.kind === "unreadable") return { ok: false, reason: "list-unreadable" }
    if (file.kind === "bad-signature") return { ok: false, reason: "list-tampered" }
    const entries = file.kind === "signed" ? file.entries : []
    const mine = entries.filter((e) => e.agent === input.agent && e.projectId === marker.projectId)
    const match = mine.find((e) => sameProjectRoot(e.root, root))
    if (match !== undefined) return { ok: true, approval: match }
    return { ok: false, reason: mine.length > 0 ? "folder-mismatch" : "not-approved" }
  } catch {
    // the check itself failed — unreadable-class, and never a signature claim
    return { ok: false, reason: "check-failed" }
  }
}
