import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
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

async function signEntries(runtime: { home: ServiceRuntime["home"] }, entries: readonly ProjectApproval[]): Promise<Hex> {
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

function codedError(code: string, message: string): Error {
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

/**
 * Everything a signed-list command needs: the home the file lives in and the owner address that
 * verifies it. Signing is local cryptography — `mida link`, `mida unlink` and `mida project new`
 * never open a runtime and never reach the chain.
 *
 * `owner` is allowed to be absent (in-16 L8): a plan can refuse before any owner material exists,
 * and a refused command must not create the key file to do so. With no owner a missing list is
 * simply empty; a list that EXISTS cannot be verified, which is its own refusal (`no-owner`).
 * The write paths sign through `signEntries`, which creates the key only by then — after the
 * owner answered yes.
 */
export type ListOwner = { home: ServiceRuntime["home"]; owner: Address | undefined }

const LIST_UNREADABLE = "the approved-projects list could not be read: check the file's permissions"
const LIST_TAMPERED = "the approved-projects list failed its signature check — run `mida doctor`"
const NO_OWNER = "this home has no owner yet — run `mida init` first"

function listRefusal(code: "list-unreadable" | "list-tampered" | "no-owner"): Error {
  const error = new Error(
    code === "list-unreadable" ? LIST_UNREADABLE : code === "list-tampered" ? LIST_TAMPERED : NO_OWNER,
  ) as Error & { code: string }
  error.code = code
  return error
}

/**
 * The signed list for a command that may run before any owner material exists. With an owner
 * address this is `readApprovalsFile`. Without one: a missing file is empty, anything on disk is
 * unverifiable — never silently treated as empty, and never verified against a made-up address.
 */
export type ListRead = ApprovalsFile | { kind: "no-owner" }

async function readListForPlan(
  home: ServiceRuntime["home"],
  owner: Address | undefined,
): Promise<ListRead> {
  if (owner !== undefined) return readApprovalsFile(home, owner)
  return home.has(LIST_FILE) ? { kind: "no-owner" } : { kind: "missing" }
}

/** Writes `<dir>/.mida/project.json` — the same marker, modes and atomic write approve uses. */
export function writeProjectMarker(dir: string, projectId: string): void {
  mkdirSync(join(dir, ".mida"), { recursive: true, mode: 0o700 })
  writeMarkerFile(join(dir, ".mida", "project.json"), projectId)
}

/** Removes a folder's own marker; `.mida/` goes only when the marker was all it held. */
export function removeProjectMarker(markerDir: string): void {
  const midaDir = join(markerDir, ".mida")
  rmSync(join(midaDir, "project.json"), { force: true })
  try {
    rmdirSync(midaDir)
  } catch {
    // something else lives in .mida — the marker is gone, the rest is untouched
  }
}

/** `link <folder>` accepts every spelling of a folder: ~, relative-to-cwd, absolute, symlinked. */
function resolveFolderInput(folder: string, cwd: string, homeDir: string): string {
  if (folder === "~" || folder.startsWith("~/")) return join(homeDir, folder.slice(1))
  return resolve(cwd, folder)
}

const realpathOr = (dir: string, fallback: string): string => {
  try {
    return realpathSync.native(dir)
  } catch {
    return fallback
  }
}

/**
 * The canonical form of a path that may not exist (a deleted folder, a path under a symlinked
 * parent): realpath the longest ancestor still on disk and keep the tail. That lands on the same
 * string the rows store — which were realpaths when written — so a gone folder's rows still match.
 */
function canonicalPath(path: string): string {
  let probe = path
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(probe), ...tail)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return path
      tail.unshift(basename(probe))
      probe = parent
    }
  }
}

/** The projectId inside `<dir>/.mida/project.json`, or null when there is none or it will not parse. */
function markerProjectId(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, ".mida", "project.json"), "utf8"))
    const id = (parsed as { projectId?: unknown } | null)?.projectId
    return typeof id === "string" && id !== "" ? id : null
  } catch {
    return null
  }
}

/**
 * The folders a project still HAS — canonical roots its signed rows name that exist on disk and
 * still carry this project's marker. A deleted folder, or one `project new` re-pointed, does not
 * keep a project alive, so it must not count against the only-folder guard or the folder move's
 * "Project X: • N folders" line (in-16 B2/L5): counting rows there counted folders that were
 * already gone.
 */
function liveProjectFolders(entries: readonly ProjectApproval[], projectId: string): Set<string> {
  const roots = new Set<string>()
  for (const entry of entries) {
    if (entry.projectId !== projectId) continue
    let real: string
    try {
      real = realpathSync.native(entry.root)
    } catch {
      continue
    }
    if (markerProjectId(real) !== projectId) continue
    roots.add(real)
  }
  return roots
}

/**
 * What `mida link <folder>` must show the owner before the typed yes — or the refusal to print.
 * `<folder>` is any folder inside the project to join; it resolves by the same nearest-marker
 * rule every project lookup uses. `ok` carries everything the confirmation line names; `already`
 * means B is linked already and the command exits 0 changing nothing.
 *
 * `move` (in-16 K-2/B5) means this folder already answers for ANOTHER project — its own marker,
 * or an ancestor's marker it inherits. The link is then a folder move: its rows under the old
 * project leave and its rows under the new one land in ONE signed write, and the marker flips
 * only after. `fromFolders` counts the old project's live folders (this one included);
 * `checkpoints` is the saved-record count the owner can verify locally — null when counting
 * would need the chain (the prompt says "unknown number of", never a guess).
 */
export type ProjectLinkPlan =
  | { kind: "ok"; projectId: string; sourceRoot: string; root: string; agents: string[] }
  | {
      kind: "move"
      projectId: string
      fromProjectId: string
      sourceRoot: string
      root: string
      agents: string[]
      fromFolders: number
      checkpoints: number | null
    }
  | { kind: "already"; projectId: string; agents: string[]; message?: string }
  | { kind: "refused"; code: "no-project" | "same-folder" | "list-unreadable" | "list-tampered" | "no-owner"; message: string }

export async function planProjectLink(
  runtime: ListOwner,
  input: { folder: string; cwd: string; homeDir?: string },
): Promise<ProjectLinkPlan> {
  const folder = resolveFolderInput(input.folder, input.cwd, input.homeDir ?? homedir())
  try {
    if (!statSync(folder).isDirectory()) throw new Error()
  } catch {
    return { kind: "refused", code: "no-project", message: `${input.folder} is not a folder that exists — nothing to join` }
  }
  const source = findProjectMarker(folder)
  if (source === null || source.projectId === null) {
    return { kind: "refused", code: "no-project", message: `${folder} is not inside a Mida project — no .mida/project.json above it` }
  }
  const sourceRoot = realpathSync.native(source.markerDir)
  let root: string
  try {
    root = realpathSync.native(input.cwd)
  } catch {
    return { kind: "refused", code: "no-project", message: "this folder cannot be read — nothing to link" }
  }
  if (root === sourceRoot) {
    return { kind: "refused", code: "same-folder", message: `this folder already IS ${sourceRoot} — nothing to link` }
  }
  // does B carry its own marker? A marker found in B itself (canonical compare — a symlinked
  // cwd still lands on the same folder) means this folder already answers for a project.
  const own = findProjectMarker(input.cwd)
  const ownIsSelf = own !== null && realpathOr(own.markerDir, resolve(own.markerDir)) === root
  const file = await readListForPlan(runtime.home, runtime.owner)
  // which agents the project allows lives only in the signed list — a list it cannot verify or
  // read makes that unknowable, so link refuses rather than guess or rebuild
  if (file.kind === "no-owner") {
    return { kind: "refused", code: "no-owner", message: NO_OWNER }
  }
  if (file.kind === "unreadable") {
    return { kind: "refused", code: "list-unreadable", message: LIST_UNREADABLE }
  }
  if (file.kind === "bad-signature") {
    return { kind: "refused", code: "list-tampered", message: LIST_TAMPERED }
  }
  const entries = file.kind === "signed" ? file.entries : []
  // every agent the project already allows — the list is the authority, whatever folder their
  // rows name. Each one gets a row for B.
  const agents = [...new Set(entries.filter((e) => e.projectId === source.projectId).map((e) => e.agent))].sort()
  // This folder already answers for a DIFFERENT project — its own marker (a worktree approved
  // before linking existed) or the marker of the project tree it sits inside. Either way the
  // link is a folder move and the owner is told what the folder leaves (in-16 K-2/B5).
  if (own !== null && own.projectId !== null && own.projectId !== source.projectId) {
    const folders = liveProjectFolders(entries, own.projectId)
    if (ownIsSelf) folders.add(root)
    return {
      kind: "move",
      projectId: source.projectId,
      fromProjectId: own.projectId,
      sourceRoot,
      root,
      agents,
      fromFolders: folders.size,
      checkpoints: null,
    }
  }
  const missing = agents.filter(
    (agent) => !entries.some((e) => e.agent === agent && e.projectId === source.projectId && sameProjectRoot(e.root, root)),
  )
  if (own !== null && own.projectId === source.projectId && !ownIsSelf) {
    // B sits inside the very project it is being linked to — its nearest marker already names
    // it. Splitting the subfolder off with its own marker would change what the folder answers
    // for, so the link is a stated no-op, not a write (in-16 B4).
    return {
      kind: "already",
      projectId: source.projectId,
      agents,
      message: `this folder already belongs to project ${source.projectId} (the nearest .mida/project.json wins); nothing to link`,
    }
  }
  if (ownIsSelf && missing.length === 0) {
    return { kind: "already", projectId: source.projectId, agents }
  }
  return { kind: "ok", projectId: source.projectId, sourceRoot, root, agents }
}

/**
 * The post-confirmation half of `mida link` — and, when `fromProjectId` is set, of a folder
 * move (in-16 K-2): this root's rows under its old project leave and its rows under the new
 * one land in the SAME serialized, signed write, so the list is never half-moved. The marker
 * flips only after that write landed; a marker write that fails puts the list back (the moved
 * folder's old rows return, the new rows leave), so the folder keeps answering for its old
 * project. Unlike approve it never rebuilds an unverifiable list from empty: the agents to add
 * live in that list, so a failed verification can only refuse. No transaction, no chain read
 * of any kind — the list is local, owner-signed data.
 */
export async function linkProject(
  runtime: ListOwner,
  input: { projectId: string; dir: string; fromProjectId?: string },
): Promise<{ root: string; agents: string[]; added: string[] }> {
  const root = realpathSync.native(input.dir)
  let removed: ProjectApproval[] = []
  const result = await serializeListWrite(async () => {
    const file = await readListForPlan(runtime.home, runtime.owner)
    if (file.kind === "no-owner") throw listRefusal("no-owner")
    if (file.kind === "unreadable") throw listRefusal("list-unreadable")
    if (file.kind === "bad-signature") throw listRefusal("list-tampered")
    const entries = file.kind === "signed" ? file.entries : []
    const agents = [...new Set(entries.filter((e) => e.projectId === input.projectId).map((e) => e.agent))].sort()
    // a folder move: every row this root carried under the old project goes in the same write —
    // kept verbatim for the undo path so a failed marker write restores exactly what was signed
    removed = input.fromProjectId === undefined
      ? []
      : entries.filter((e) => e.projectId === input.fromProjectId && sameProjectRoot(e.root, root))
    const kept = entries.filter((e) => !removed.includes(e))
    // canonical comparison decides what is missing — a symlink, typed case or relative spelling
    // of the same folder can never land a second row
    const added = agents.filter(
      (agent) => !kept.some((e) => e.agent === agent && e.projectId === input.projectId && sameProjectRoot(e.root, root)),
    )
    const approvedAt = new Date().toISOString()
    const next = [...kept, ...added.map((agent) => ({ agent, projectId: input.projectId, root, approvedAt }))]
    runtime.home.writeSecretJson(LIST_FILE, { entries: next, signature: await signEntries(runtime, next) })
    return { root, agents, added }
  })
  try {
    writeProjectMarker(input.dir, input.projectId)
  } catch (error) {
    // the marker could not flip — put the list back so the folder still answers for the project
    // it answered for before; only the rows THIS call added leave (pre-existing ones stay), and
    // the old project's rows return verbatim
    const addedAgents = new Set(result.added)
    const restored = await serializeListWrite(async () => {
      const file = await readListForPlan(runtime.home, runtime.owner)
      if (file.kind !== "signed") return false // a list that broke mid-move is never rewritten blind
      const kept = file.entries.filter(
        (e) => !(e.projectId === input.projectId && sameProjectRoot(e.root, root) && addedAgents.has(e.agent)),
      )
      const next = [...kept, ...removed]
      runtime.home.writeSecretJson(LIST_FILE, { entries: next, signature: await signEntries(runtime, next) })
      return true
    }).catch(() => false)
    if (!restored) {
      throw codedError(
        "move-not-undone",
        `the folder move could not be undone — the signed list already carries this folder's ${input.projectId} rows while its marker still names ${input.fromProjectId ?? "its old project"}; run \`mida doctor\` and repair before linking again`,
      )
    }
    throw error
  }
  return result
}

/**
 * What `mida unlink` must show the owner before the typed yes — or the refusal. `rows` are the
 * signed rows this folder's root carries (every agent); `otherRoots` are the project's other
 * approved folders. A project with no other approved folder cannot be unlinked — that would
 * orphan the project, and the refusal says so.
 */
export type ProjectUnlinkPlan =
  | { kind: "ok"; projectId: string; markerDir: string; root: string; rows: ProjectApproval[]; otherRoots: string[] }
  | { kind: "refused"; code: "not-a-project" | "only-folder" | "list-unreadable" | "list-tampered" | "no-owner"; message: string }

export async function planProjectUnlink(
  runtime: ListOwner,
  input: { cwd: string },
): Promise<ProjectUnlinkPlan> {
  const marker = findProjectMarker(input.cwd)
  if (marker === null || marker.projectId === null) {
    return { kind: "refused", code: "not-a-project", message: "this folder has no project of its own — nothing to unlink" }
  }
  const root = realpathSync.native(marker.markerDir)
  const file = await readListForPlan(runtime.home, runtime.owner)
  // unlink removes rows — with a list it cannot verify or read, which rows name this folder is
  // unknowable. Unlike approve it never rebuilds from empty: that would drop every project's
  // rows to remove one folder's. It refuses instead.
  if (file.kind === "no-owner") {
    return { kind: "refused", code: "no-owner", message: NO_OWNER }
  }
  if (file.kind === "unreadable") {
    return { kind: "refused", code: "list-unreadable", message: LIST_UNREADABLE }
  }
  if (file.kind === "bad-signature") {
    return { kind: "refused", code: "list-tampered", message: LIST_TAMPERED }
  }
  const entries = file.kind === "signed" ? file.entries : []
  const rows = entries.filter((e) => e.projectId === marker.projectId && sameProjectRoot(e.root, root))
  // The only-folder guard counts FOLDERS, not approval rows (in-16 B2/L5): a project whose
  // owner approved zero agents has no rows anywhere, so counting rows said "no other folder"
  // about a project that plainly had one. A listed root counts only while the folder still
  // exists and still carries this project's marker — a deleted folder, or one `project new`
  // re-pointed, does not keep the project alive. When the project has no rows at all there is
  // nothing the list could orphan, so unlinking the marker is allowed.
  const live = liveProjectFolders(entries, marker.projectId)
  live.delete(root)
  const otherRoots = [...live].sort()
  // The guard fires only when this folder carries rows and no other live folder remains: a
  // marker-only unlink removes nothing from the list, so it cannot orphan signed state — even
  // when the project's other rows name folders that are already gone.
  if (otherRoots.length === 0 && rows.length > 0) {
    return {
      kind: "refused",
      code: "only-folder",
      message: `project ${marker.projectId} has no other folder — unlinking would orphan it; run \`mida link <other project's folder>\` here to move this folder instead`,
    }
  }
  return { kind: "ok", projectId: marker.projectId, markerDir: marker.markerDir, root, rows, otherRoots }
}

/**
 * The post-confirmation half of `mida unlink`: every signed row naming this folder's canonical
 * root (for this project, every agent) leaves the list, and the folder's own `.mida/` marker is
 * removed. The project, its other folders and all its records are untouched — the only write is
 * the re-signed list.
 */
export async function unlinkProject(
  runtime: ListOwner,
  input: { projectId: string; markerDir: string },
): Promise<{ root: string; removed: number }> {
  const root = realpathSync.native(input.markerDir)
  const removed = await serializeListWrite(async () => {
    const file = await readListForPlan(runtime.home, runtime.owner)
    if (file.kind === "no-owner") throw listRefusal("no-owner")
    if (file.kind === "unreadable") throw listRefusal("list-unreadable")
    if (file.kind === "bad-signature") throw listRefusal("list-tampered")
    const entries = file.kind === "signed" ? file.entries : []
    const kept = entries.filter((e) => !(e.projectId === input.projectId && sameProjectRoot(e.root, root)))
    runtime.home.writeSecretJson(LIST_FILE, { entries: kept, signature: await signEntries(runtime, kept) })
    return entries.length - kept.length
  })
  removeProjectMarker(input.markerDir)
  return { root, removed }
}

/**
 * What `mida unlink --folder <path>` shows before the typed yes (in-16 B3): the flag exists for
 * the folder unlink cannot reach from inside — deleted, or otherwise unreachable — where doctor's
 * old advice ("run `mida unlink` in that folder") was impossible, and hand-editing the list would
 * break the owner signature for every agent. A folder that still lives and carries its own marker
 * is a normal unlink (the only-folder guard applies), so the plan delegates to it; anything else
 * is rows-only: every signed row naming the folder's canonical root, grouped by project, removed
 * in one signed write. The marker is never the target here — a gone folder has none left that
 * matters, and a live one went through the normal plan.
 */
export type FolderUnlinkPlan =
  | {
      kind: "ok"
      root: string
      /** The path as typed, resolved absolute — a second match form for rows stored non-canonical. */
      asTyped: string
      gone: boolean
      removals: { projectId: string; rows: ProjectApproval[] }[]
    }
  | { kind: "refused"; code: "nothing" | "no-owner" | "list-unreadable" | "list-tampered"; message: string }

export async function planFolderUnlink(
  runtime: ListOwner,
  input: { folder: string; cwd: string; homeDir?: string },
): Promise<ProjectUnlinkPlan | FolderUnlinkPlan> {
  const resolved = resolveFolderInput(input.folder, input.cwd, input.homeDir ?? homedir())
  const root = canonicalPath(resolved)
  let exists = false
  try {
    exists = statSync(root).isDirectory()
  } catch {
    exists = false
  }
  const marker = exists ? findProjectMarker(resolved) : null
  // still a live marked folder — the normal plan (and its only-folder guard) answers
  if (
    marker !== null &&
    marker.projectId !== null &&
    realpathOr(marker.markerDir, resolve(marker.markerDir)) === root
  ) {
    return planProjectUnlink(runtime, { cwd: resolved })
  }
  const file = await readListForPlan(runtime.home, runtime.owner)
  if (file.kind === "no-owner") return { kind: "refused", code: "no-owner", message: NO_OWNER }
  if (file.kind === "unreadable") return { kind: "refused", code: "list-unreadable", message: LIST_UNREADABLE }
  if (file.kind === "bad-signature") return { kind: "refused", code: "list-tampered", message: LIST_TAMPERED }
  const entries = file.kind === "signed" ? file.entries : []
  const byProject = new Map<string, ProjectApproval[]>()
  for (const entry of entries) {
    // a row for a deleted folder can no longer be canonicalised, so match the canonical path AND
    // the absolute spelling the owner typed — a pre-fix row's stored string still lands
    if (!sameProjectRoot(entry.root, root) && entry.root !== resolve(resolved)) continue
    const list = byProject.get(entry.projectId) ?? []
    list.push(entry)
    byProject.set(entry.projectId, list)
  }
  if (byProject.size === 0) {
    return {
      kind: "refused",
      code: "nothing",
      message:
        marker !== null && marker.projectId !== null
          ? `${resolved} has no marker of its own — it currently uses project ${marker.projectId} (marker in ${marker.markerDir}); nothing to unlink`
          : `the signed list names no rows for ${resolved} — nothing to unlink`,
    }
  }
  const removals = [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, rows]) => ({ projectId, rows }))
  return { kind: "ok", root, asTyped: resolve(resolved), gone: !exists, removals }
}

/** The write half of `mida unlink --folder`: every row naming the root under the named projects leaves, in one signed write. */
export async function unlinkFolderRows(
  runtime: ListOwner,
  input: { root: string; asTyped: string; projectIds: readonly string[] },
): Promise<{ removed: number }> {
  return serializeListWrite(async () => {
    const file = await readListForPlan(runtime.home, runtime.owner)
    if (file.kind === "no-owner") throw listRefusal("no-owner")
    if (file.kind === "unreadable") throw listRefusal("list-unreadable")
    if (file.kind === "bad-signature") throw listRefusal("list-tampered")
    const entries = file.kind === "signed" ? file.entries : []
    const ids = new Set(input.projectIds)
    const kept = entries.filter(
      (e) =>
        !(
          ids.has(e.projectId) &&
          (sameProjectRoot(e.root, input.root) || e.root === input.root || e.root === input.asTyped)
        ),
    )
    runtime.home.writeSecretJson(LIST_FILE, { entries: kept, signature: await signEntries(runtime, kept) })
    return { removed: entries.length - kept.length }
  })
}

/**
 * What `mida project new` must know before it writes — or the refusal. The same guard
 * `ensureProjectMarker` applies to marker creation refuses the owner's home folder and the
 * filesystem root; a folder that already holds its own usable marker is already its own project
 * and refuses plainly; `parent` is the project this folder would stop using, so the command can
 * ask for a typed yes.
 */
export type ProjectNewPlan =
  | { kind: "ok"; parent: { markerDir: string; projectId: string } | null }
  | { kind: "refused"; code: "not-a-project" | "own-marker"; message: string }

export function projectNewPlan(cwd: string, homeDir: string = homedir()): ProjectNewPlan {
  let realCwd: string
  try {
    realCwd = realpathSync.native(cwd)
  } catch {
    return { kind: "refused", code: "not-a-project", message: "this folder cannot be read — nothing to mark" }
  }
  let realHome: string
  try {
    realHome = realpathSync.native(homeDir)
  } catch {
    realHome = resolve(homeDir)
  }
  const found = findProjectMarker(cwd)
  // a marker found in THIS folder means the folder already answers for a project — a fresh id
  // here would strand the old one's rows; it must be detached first, or kept.
  if (found !== null && realpathOr(found.markerDir, resolve(found.markerDir)) === realCwd) {
    if (found.projectId !== null) {
      return {
        kind: "refused",
        code: "own-marker",
        message: `this folder is already its own project ${found.projectId} — run \`mida unlink\` here first, or keep it`,
      }
    }
    // a marker file that carries no usable id is replaced, as ensureProjectMarker replaces it
    return { kind: "ok", parent: null }
  }
  // a new marker here would claim a project out of the owner's home or the filesystem root —
  // the same refusal ensureProjectMarker makes when it would create one
  if (realCwd === realHome || realCwd === "/") {
    return { kind: "refused", code: "not-a-project", message: "refusing to create a project marker here" }
  }
  if (found === null) return { kind: "ok", parent: null }
  // an ancestor's marker wins today — the new marker makes this folder stop using that project
  if (found.projectId === null) return { kind: "ok", parent: null }
  return { kind: "ok", parent: { markerDir: realpathOr(found.markerDir, resolve(found.markerDir)), projectId: found.projectId } }
}

/** The post-confirmation half of `mida project new`: a fresh project id in this folder's own marker. */
export function newProject(cwd: string): { projectId: string } {
  const projectId = randomUUID()
  writeProjectMarker(cwd, projectId)
  return { projectId }
}


