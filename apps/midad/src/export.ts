import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs"
import { hostname } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { zeroHash } from "viem"
import { CONTEXT_KIND, OWNER_AUTHOR_ID, PROVENANCE_SOURCE, RECORD_TYPE, canonicalBytes } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { mergeCheckpoints, onlyScaffolding, orderTime, taskOf } from "@mida/checkpoint"
import type { Checkpoint, StoredCheckpoint } from "@mida/checkpoint"
import type { MidaHome } from "./home.js"
import { loadOwnerAddress, loadOwnerMode } from "./keys.js"
import { peekJobs } from "./queue.js"
import { pendingAnchorsStrict } from "./batching.js"
import { readOwnerUniverse } from "./owner-read.js"
import type { SourceRecord } from "./owner-read.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { authorNamesFor } from "./skeleton.js"
import { movedOnSuffix, readEnvelope } from "./migration-envelope.js"
import type { MigrationEnvelope } from "./migration-envelope.js"
import { unwrapCheckpoint } from "./checkpoint-payload.js"
import type { CheckpointEnvelope } from "./checkpoint-payload.js"

/**
 * `mida export <folder>` — leaving Mida in one command. Everything the owner's Monad account
 * holds, decrypted into records.json and records.md, plus the exact manifest and ciphertext
 * bytes the store serves under encrypted/, so anyone can check the folder against the chain
 * without trusting this machine. The whole integrity story stays with the owner read: a record
 * that cannot be verified against its chain commitment throws owner-read-incomplete and nothing
 * is written.
 *
 * Never in the folder: the owner seed, the owner P-256 key, any agent key, any epoch or
 * namespace key — only payloads (decrypted) and store bytes (still encrypted). The temp sibling
 * folder `<folder>.partial-<random>` holds plaintext for the duration of the write, so it is
 * deleted on every path out: a rejected promise runs the catch, Ctrl-C (SIGINT, SIGTERM, SIGHUP)
 * runs a synchronous process-level cleanup, and a kill -9 or power cut is covered by the JSON
 * marker file — it names the writer's host, pid and that process's start time, so the next
 * export into the same parent removes only `.partial-*` siblings whose writer is provably
 * gone: a live writer (same machine, same pid, same start time) is kept and named, and so is
 * anything staged on another machine. The rename to <folder> happens once, at the end.
 */

export type ExportResult =
  | {
      outcome: "exported"
      records: number
      namespaces: number
      folder: string
      queued: number
      batchedPending: number
      /** Saves the chain registered after the export block — left out, counted here. */
      landedAfter: number
    }
  | { outcome: "refused"; code: string }

export interface ExportDeps {
  home: MidaHome
  network: Network
  /** The folder to create — a path the owner chose, resolved against `cwd`. */
  folder: string
  cwd?: string
  print: (line: string) => void
  progress?: (line: string) => void
  now?: () => Date
  /** Test seam: the owner-runtime opener. Default: Runtime.open — which needs owner/secrets.json. */
  openRuntime?: (home: MidaHome, network: Network) => Promise<Runtime>
  /**
   * Test seam: the owner read. Default: readOwnerUniverse with keepEncrypted on. `toBlock` is
   * the already-read head — the universe must be scanned no further than it — and `afterHead`
   * collects the contextIds of store rows whose registration came after it.
   */
  readUniverse?: (
    runtime: Runtime,
    onProgress: (done: number, total: number) => void,
    toBlock: bigint,
    afterHead: Set<Hex>,
  ) => Promise<SourceRecord[]>
  /**
   * Test seam: the host/process facts the leftover sweep decides on — production uses
   * os.hostname(), kill(pid, 0) and `ps -o lstart= -p <pid>`. See SweepProbes.
   */
  sweep?: SweepProbes
  /** Test seam: stop the export right after this step, as if the write had failed there. */
  stopAfter?: "staged" | "files"
}

/** One records.json entry — every field the chain holds about a record, plus its plaintext. */
export interface ExportEntry {
  contextId: Hex
  namespace: string
  namespaceId: Hex
  recordType: string
  kind: string
  source: string
  author: { id: Hex; name: string }
  /** The effective instant by merge.ts's rule: the chain stamp, or a moved record's original day. */
  writtenAt: string
  /** Monad's own stamp on the record — createdAt, ISO-8601 UTC. */
  chainTime: string
  expiresAt: string | null
  /** Whether expiresAt was already past at export time. */
  expired: boolean
  lineageId: Hex
  version: number
  parentId: Hex
  /** True when a later version in the same lineage exists — a read would answer with that one. */
  superseded: boolean
  /** The record that replaced this one (names it in parentId), or null. */
  supersededBy: Hex | null
  /**
   * Checkpoints only: the record's named task — "main" when the envelope names none
   * (absent reads as main everywhere). Absent on every non-checkpoint record.
   */
  task?: string
  /**
   * Checkpoints only: the checkpoint a handoff for this record's task opens with — the
   * head of the working-session chain mergeCheckpoints chooses WITHIN that task, so a
   * newer session with no real work is not flagged, and two tasks in one project each
   * flag their own head. Ordered by the chain's own stamps, never the writer's claim.
   * False on every non-checkpoint record.
   */
  newestCheckpoint: boolean
  lane: "direct" | "batched"
  batchId: Hex | null
  /** The read epoch the record was sealed under — a decimal string. */
  readEpoch: string
  references: { relation: string; recordId: Hex }[]
  /** The chain's commitment to the stored object — keccak256 of the canonical manifest. */
  manifestHash: Hex
  /** The decrypted payload, exactly as read back — plaintext. */
  payload: unknown
  /**
   * "unreadable" only: the record carried a migration envelope this build could not read (a
   * payload carrying it in both slots is contradictory). The record still exports — the
   * decrypted payload is preserved as-is and writtenAt is Monad's stamp, not the envelope's
   * claim. `newestCheckpoint` is unaffected: on a checkpoint it follows the handoff's rule,
   * which reads the envelope inside the checkpoint itself. Absent on every ordinary record.
   */
  envelope?: "unreadable"
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** One refusal line, one plain answer — nothing was written yet on every path that calls this. */
function refuse(deps: ExportDeps, code: string, line: string): ExportResult {
  deps.print(line)
  return { outcome: "refused", code }
}

/**
 * Written FIRST inside every `<dest>.partial-*` staging folder — a JSON proof that a leftover
 * is a half-written Mida export holding plaintext. The next run's sweep deletes only folders
 * that carry a parseable one; a folder without it is somebody else's and stays untouched.
 */
const STAGING_MARKER = ".mida-export-staging"

/**
 * The suffix every staging folder name carries: `.partial-` plus the 12 lowercase hex chars of
 * `randomBytes(6)`. Anything else that merely LOOKS staged — a user folder, an older marker
 * format — never matches, so it is never swept.
 */
const PARTIAL_SUFFIX = /\.partial-[0-9a-f]{12}$/

/**
 * The marker written FIRST inside every staging folder: JSON naming the destination, the
 * writer's pid, the machine it runs on (`host`) and that process's own start time
 * (`pidStarted` — the `ps -o lstart=` string). The sweep below deletes a leftover only when
 * this parses AND its writer is provably gone: the marker's host must be this machine, and
 * its pid must be dead or running under a different start time — a pid alive with the
 * recorded start time IS the writer, still working; a pid alive with another start time is a
 * stranger that inherited the dead writer's number. A marker a previous format wrote — no
 * host, no start time — never parses as this shape, so its folder is never swept by mistake.
 */
interface StagingMarker {
  dest: string
  pid: number
  host: string
  pidStarted: string
  startedAt: string
}

function readStagingMarker(dir: string): StagingMarker | undefined {
  try {
    const marker: unknown = JSON.parse(readFileSync(join(dir, STAGING_MARKER), "utf8"))
    if (typeof marker !== "object" || marker === null) return undefined
    const { dest, pid, host, pidStarted, startedAt } = marker as {
      dest?: unknown; pid?: unknown; host?: unknown; pidStarted?: unknown; startedAt?: unknown
    }
    if (typeof dest !== "string" || typeof startedAt !== "string") return undefined
    if (typeof host !== "string" || host === "") return undefined
    if (typeof pidStarted !== "string" || pidStarted === "") return undefined
    // Only a positive integer may reach process.kill — anything else is not a marker we wrote.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined
    return marker as StagingMarker
  } catch {
    return undefined
  }
}

/**
 * `kill(pid, 0)` asks whether a process exists without signalling it. EPERM means it exists
 * but belongs to another user — still alive, still not ours to delete.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * `ps -o lstart= -p <pid>` — the start time of the process that pid currently names, as one
 * comparable string. Pids get reused, so "pid is alive" alone cannot prove a staging writer
 * still runs; equality between this answer and the marker's `pidStarted` is the proof.
 * undefined means the lookup failed — never proof of death.
 */
function pidStartedAt(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()
    return out === "" ? undefined : out
  } catch {
    return undefined
  }
}

/**
 * The host/process facts the sweep decides on — injectable so tests never depend on the real
 * process table. `pidStarted` answering undefined means "cannot check": a leftover that cannot
 * be proven dead is kept, never deleted on a guess.
 */
export interface SweepProbes {
  host?: string
  pidAlive?: (pid: number) => boolean
  pidStarted?: (pid: number) => string | undefined
}

/**
 * Every staging folder this process is still writing. While the set is non-empty, SIGINT,
 * SIGTERM and SIGHUP get handlers that delete the folders synchronously and exit with the
 * conventional code — a bare exit would leave plaintext on disk, and an async cleanup would
 * never run. Handlers are removed the moment the set empties, so a finished export leaves the
 * process untouched.
 */
const stagingFolders = new Set<string>()
const STAGING_SIGNALS = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const

const stagingHandlers = {
  SIGINT: () => onStagingSignal("SIGINT"),
  SIGHUP: () => onStagingSignal("SIGHUP"),
  SIGTERM: () => onStagingSignal("SIGTERM"),
} as const

function onStagingSignal(signal: keyof typeof STAGING_SIGNALS): void {
  for (const dir of stagingFolders) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort — the marker still names it for the next run's sweep
    }
  }
  process.exit(STAGING_SIGNALS[signal])
}

function watchStaging(dir: string): void {
  if (stagingFolders.size === 0) {
    for (const signal of Object.keys(stagingHandlers) as (keyof typeof stagingHandlers)[]) {
      process.on(signal, stagingHandlers[signal])
    }
  }
  stagingFolders.add(dir)
}

function unwatchStaging(dir: string): void {
  stagingFolders.delete(dir)
  if (stagingFolders.size === 0) {
    for (const signal of Object.keys(stagingHandlers) as (keyof typeof stagingHandlers)[]) {
      process.removeListener(signal, stagingHandlers[signal])
    }
  }
}

/**
 * Deletes `*.partial-*` leftovers a previous export to ANY destination in this parent left
 * behind — a kill -9 or a power cut can never run that process's own cleanup, so the next run
 * removes them before writing. Each candidate must survive three checks before deletion:
 * lstat says it is a real directory (a symlink — even one whose target holds a marker — and
 * every non-directory stay untouched), the JSON marker parses, and the marker's writer is
 * provably gone — the marker's `host` must be this machine (a folder staged on another host
 * is never this run's to delete, however dead its pid looks here), and its pid must either be
 * dead or alive under a DIFFERENT start time than the marker recorded (a reused pid is a
 * stranger, not the writer). A pid alive with the recorded start is a live export mid-write.
 * Every folder the sweep decides is not safe to remove — another host's, a live writer's, one
 * whose writer cannot be checked — is kept AND named in one printed line; every folder
 * removed is printed too. Nothing is ever silent while it still holds plaintext.
 */
function sweepLeftoverStaging(dest: string, print: (line: string) => void, probes: SweepProbes = {}): void {
  const host = probes.host ?? hostname()
  const pidAlive = probes.pidAlive ?? processAlive
  const pidStarted = probes.pidStarted ?? pidStartedAt
  const parent = dirname(dest)
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return // the parent cannot be listed — a run that needs it fails on its own write
  }
  for (const name of names) {
    if (!PARTIAL_SUFFIX.test(name)) continue
    const dir = join(parent, name)
    try {
      const info = lstatSync(dir)
      if (info.isSymbolicLink() || !info.isDirectory()) continue
      const marker = readStagingMarker(dir)
      if (marker === undefined) continue
      if (marker.host !== host) {
        print(`kept a leftover half-written export: ${name} — its marker names ${marker.host}, not this machine`)
        continue
      }
      if (pidAlive(marker.pid)) {
        const started = pidStarted(marker.pid)
        if (started === undefined) {
          print(`kept a leftover half-written export: ${name} — pid ${marker.pid} is alive but its start time could not be checked`)
          continue
        }
        if (started === marker.pidStarted) {
          print(`kept a leftover half-written export: ${name} — pid ${marker.pid} is still writing it`)
          continue
        }
        // The pid is alive but started at a different time than the marker's writer: the
        // writer is dead and a stranger owns the number now — the leftover is ours to remove.
      }
      rmSync(dir, { recursive: true, force: true })
      print(`removed a leftover half-written export: ${name} — it held plaintext`)
    } catch {
      // leave it — a leftover is better than a wrongly deleted folder
    }
  }
}

/** lstat that tolerates absence — a symlink (even a broken one) counts as existing. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where `dest` will actually land once existing ancestors' symlinks resolve: realpath the deepest
 * ancestor that exists, then append the rest. The containment check must run on this — a lexical
 * path that LOOKS outside the Mida home but resolves inside it is how an export folder ends up
 * inside the secrets' reach.
 */
function resolvedDest(dest: string): string {
  let dir = dest
  const tail: string[] = []
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return dest
    tail.unshift(basename(dir))
    dir = parent
  }
  return join(realpathSync.native(dir), ...tail)
}

/** true when `candidate` is `root` itself or lives beneath it — realpath'ed both. */
function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 0600 file writes — the export's files hold plaintext. `wx`: never overwrite. */
function write0600(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600)
  try {
    writeSync(fd, typeof data === "string" ? new TextEncoder().encode(data) : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The name an enum's numeric value prints as — a value this build does not know fails closed. */
function enumName(table: Record<string, number>, value: number, what: string, contextId: Hex): string {
  const name = Object.keys(table).find((key) => table[key] === value)
  if (name === undefined) {
    // `unknownField`/`unknownValue` ride on the error so the printed line can say plainly that
    // this version of mida does not recognise the value — this build's gap, not a chain anomaly
    // (ex-4 G-4).
    throw Object.assign(
      codedError("export-inconsistent", `record ${contextId} carries a ${what} value (${value}) this build does not know`),
      { contextIds: [contextId], unknownField: what, unknownValue: value },
    )
  }
  return name
}

/**
 * Who superseded whom, from the chain's own parentId links — never inferred from array order.
 * One lineage's records group under their shared lineageId (a record with no lineage is its own
 * group); a child names its predecessor in parentId. Two children claiming the same parent is a
 * chain state this export cannot describe, so it refuses rather than pick one.
 */
function supersededByMap(records: readonly SourceRecord[]): Map<string, Hex> {
  const byLineage = new Map<string, SourceRecord[]>()
  for (const record of records) {
    const key = (record.lineageId === zeroHash ? record.contextId : record.lineageId).toLowerCase()
    const group = byLineage.get(key)
    if (group === undefined) byLineage.set(key, [record])
    else group.push(record)
  }
  const supersededBy = new Map<string, Hex>()
  for (const [lineage, group] of byLineage) {
    const childOf = new Map<string, SourceRecord>()
    for (const record of group) {
      if (record.parentId === zeroHash) continue
      const parent = record.parentId.toLowerCase()
      if (childOf.has(parent)) {
        const first = childOf.get(parent)!
        // lineage + both contextIds ride on the error so the CLI's printed line can name the
        // records in short form without re-parsing this message (ex-3 E-2).
        throw Object.assign(
          codedError(
            "export-inconsistent",
            `lineage ${lineage}: records ${first.contextId} and ${record.contextId} both name ${record.parentId} as parent`,
          ),
          { lineage, contextIds: [first.contextId, record.contextId] },
        )
      }
      childOf.set(parent, record)
    }
    for (const [parent, child] of childOf) supersededBy.set(parent, child.contextId)
  }
  return supersededBy
}

/** The highest-version contextIds in each lineage — the records a plain read would answer with. */
function latestInLineage(records: readonly SourceRecord[]): Set<string> {
  const byLineage = new Map<string, number>()
  for (const record of records) {
    const key = (record.lineageId === zeroHash ? record.contextId : record.lineageId).toLowerCase()
    byLineage.set(key, Math.max(byLineage.get(key) ?? -1, record.version))
  }
  const latest = new Set<string>()
  for (const record of records) {
    const key = (record.lineageId === zeroHash ? record.contextId : record.lineageId).toLowerCase()
    if (record.version === byLineage.get(key)) latest.add(record.contextId.toLowerCase())
  }
  return latest
}

/**
 * The checkpoint a handoff opens with in each project × task thread — mergeCheckpoints's
 * own pick (the chosen chain's head). Only records carrying a checkpoint envelope take
 * part, grouped by projectId AND the same taskOf() the handoff filters on — a handoff
 * continues per task, so one project-wide merge would flag a single head and leave every
 * other task's real head unmarked (in-18 B3). Each record is rebuilt as the
 * StoredCheckpoint the merge consumes, envelope task included, with Monad's own placement
 * as its order.
 */
function newestCheckpointIds(records: readonly SourceRecord[]): Set<string> {
  // Key: projectId + NUL + task — the first NUL splits uniquely because a task
  // name (a-z0-9- only) can never contain one.
  const byThread = new Map<string, StoredCheckpoint[]>()
  for (const record of records) {
    const envelope = unwrapCheckpoint(record.payload.value)
    if (envelope === null) continue
    const stored: StoredCheckpoint = {
      checkpoint: envelope.checkpoint,
      projectId: envelope.projectId,
      sessionId: envelope.sessionId,
      continuesSession: envelope.continuesSession,
      compiledBy: envelope.compiledBy,
      contextId: record.contextId,
      authorId: record.authorId,
      namespaceId: record.namespaceId,
      chain: {
        at: record.createdAt,
        ...(record.chain?.block === undefined ? {} : { block: record.chain.block }),
        ...(record.chain?.index === undefined ? {} : { index: record.chain.index }),
      },
      ...(envelope.task === undefined ? {} : { task: envelope.task }),
      ...(envelope.migration === undefined ? {} : { migration: envelope.migration }),
    }
    const key = `${envelope.projectId}\0${taskOf(stored)}`
    const list = byThread.get(key)
    if (list === undefined) byThread.set(key, [stored])
    else list.push(stored)
  }
  const newest = new Set<string>()
  for (const checkpoints of byThread.values()) {
    // provenance is the chosen chain in chain order — its last row is the head a handoff
    // for this project × task would continue from.
    const merged = mergeCheckpoints(checkpoints)
    const head = merged?.provenance.at(-1)?.contextId
    if (head !== undefined) newest.add(head.toLowerCase())
  }
  return newest
}

/**
 * readEnvelope that never throws `invalid-migration-envelope` at the owner: a payload carrying
 * the envelope in both slots is contradictory — the record still exports, flagged "unreadable",
 * and nothing from the envelope is trusted. One malformed record must never block the owner
 * from leaving. Any other error still propagates.
 */
function envelopeOf(record: SourceRecord): { migration?: MigrationEnvelope; unreadable: boolean } {
  try {
    return { migration: readEnvelope(record.payload), unreadable: false }
  } catch (error) {
    if ((error as { code?: unknown }).code === "invalid-migration-envelope") return { unreadable: true }
    throw error
  }
}

/**
 * writtenAt by the in-12 merge rule (packages/checkpoint merge.ts orderTime): the chain's stamp
 * decides, and a migrated record keeps the earlier of its original write day and its replay's
 * stamp — never the writer's own claim, and never a day after Monad saw it. An unreadable
 * envelope claims nothing — writtenAt is the chain stamp, plain.
 */
function writtenAtMs(record: SourceRecord, migration: MigrationEnvelope | undefined): number {
  return orderTime({
    checkpoint: {} as Checkpoint,
    chain: { at: record.createdAt },
    ...(migration === undefined ? {} : { migration }),
  } as StoredCheckpoint)
}

const iso = (seconds: bigint): string => new Date(Number(seconds) * 1_000).toISOString()
const msIso = (ms: number): string => new Date(ms).toISOString()

function entryFor(
  record: SourceRecord,
  names: Record<string, string>,
  supersededBy: Map<string, Hex>,
  latest: Set<string>,
  newestCheckpoints: Set<string>,
  now: Date,
): ExportEntry {
  const authorName =
    record.authorId.toLowerCase() === OWNER_AUTHOR_ID.toLowerCase()
      ? "you"
      : names[record.authorId.toLowerCase()] ?? record.authorId
  const { migration, unreadable } = envelopeOf(record)
  const checkpointEnvelope = unwrapCheckpoint(record.payload.value)
  return {
    contextId: record.contextId,
    namespace: record.namespace,
    namespaceId: record.namespaceId,
    recordType: enumName(RECORD_TYPE, record.recordType, "record type", record.contextId),
    kind: enumName(CONTEXT_KIND, record.kind, "kind", record.contextId),
    source: enumName(PROVENANCE_SOURCE, record.provenanceSource, "provenance source", record.contextId),
    author: { id: record.authorId, name: authorName },
    writtenAt: msIso(writtenAtMs(record, migration)),
    chainTime: iso(record.createdAt),
    expiresAt: record.expiresAt === 0n ? null : iso(record.expiresAt),
    expired: record.expiresAt !== 0n && record.expiresAt * 1_000n <= BigInt(now.getTime()),
    lineageId: record.lineageId,
    version: record.version,
    parentId: record.parentId,
    // superseded = a later version exists in the lineage — whether the link was a supersede
    // (supersededBy names it) or the chain simply holds a higher version.
    superseded: supersededBy.has(record.contextId.toLowerCase()) || !latest.has(record.contextId.toLowerCase()),
    supersededBy: supersededBy.get(record.contextId.toLowerCase()) ?? null,
    ...(checkpointEnvelope === null ? {} : { task: taskOf(checkpointEnvelope) }),
    newestCheckpoint: newestCheckpoints.has(record.contextId.toLowerCase()),
    lane: record.lane ?? "direct",
    batchId: record.batchId ?? null,
    readEpoch: record.readEpoch.toString(10),
    references: record.references.map((reference) => ({ relation: reference.relation, recordId: reference.recordId })),
    manifestHash: record.manifestHash,
    payload: record.payload,
    ...(unreadable ? { envelope: "unreadable" as const } : {}),
  }
}

/** A checkpoint envelope's fields in the order a handoff reader would tell them. */
function checkpointLines(envelope: CheckpointEnvelope): string[] {
  const c = envelope.checkpoint
  const lines: string[] = [`project ${envelope.projectId} · session ${envelope.sessionId} · task ${taskOf(envelope)} · compiled by ${envelope.compiledBy}`]
  lines.push(`objective: ${c.objective}`)
  // UF-C41B B4 — a stored request that is only system scaffolding (a saved
  // <local-command-caveat> and nothing else) is not the user's ask: the same
  // onlyScaffolding test the merge and the compiler share suppresses the line.
  if (c.originalRequest !== null && !onlyScaffolding(c.originalRequest)) lines.push(`asked: ${c.originalRequest}`)
  for (const item of c.progress) lines.push(`progress: ${item}`)
  for (const d of c.decisions) lines.push(`decision: ${d.decision} — ${d.rationale}`)
  for (const r of c.rejected) lines.push(`rejected: ${r.approach} — ${r.why}`)
  for (const item of c.constraints) lines.push(`constraint: ${item}`)
  for (const item of c.artifacts) lines.push(`artifact: ${item}`)
  if (c.unresolvedIssue !== null) lines.push(`unresolved: ${c.unresolvedIssue}`)
  lines.push(`next: ${c.nextAction}`)
  for (const item of c.remainingPlan) lines.push(`plan: ${item}`)
  for (const e of c.evidence) lines.push(`evidence: ${e.field} = ${e.ref}`)
  return lines
}

/**
 * The record's content as plain quoted lines — every line starts with "> " so no payload line
 * can ever masquerade as export structure. A checkpoint renders its fields; an object renders
 * its `text` then its other fields; anything else is one fenced JSON block.
 */
function contentLines(record: SourceRecord): string[] {
  const value = record.payload.value
  const raw: string[] = []
  const envelope = typeof value === "object" && value !== null ? unwrapCheckpoint(value) : null
  if (envelope !== null) {
    raw.push(...checkpointLines(envelope))
  } else if (typeof value === "string") {
    raw.push(...value.split(/\r?\n/))
  } else if (typeof value === "object" && value !== null) {
    const fields = value as Record<string, unknown>
    if (typeof fields.text === "string") raw.push(...fields.text.split(/\r?\n/))
    for (const [key, field] of Object.entries(fields)) {
      if (key === "text") continue
      raw.push(`${key}: ${typeof field === "string" ? field : JSON.stringify(field, bigintJson)}`)
    }
  } else {
    raw.push("```", JSON.stringify(value, bigintJson, 2) ?? "null", "```")
  }
  // A moved record carries its provenance as a sealed envelope — the same "(moved on …)" marker
  // every Mida list appends, plus where it originally lived, so the export keeps attribution.
  // An unreadable envelope claims nothing: the flag in the header line already names it.
  const { migration, unreadable } = envelopeOf(record)
  if (unreadable) {
    raw.push("(its migration envelope could not be read — the payload above is exactly as stored)")
  } else if (migration !== undefined) {
    raw.push(
      `${movedOnSuffix(migration)} — originally record ${migration.originalRecordId} on contract ${migration.originalContract}, chain ${migration.originalChainId}`,
    )
  }
  // UF-C41C E5: the entries above are logical fields, not lines; a checkpoint
  // request, a field value, or the fenced JSON block can each carry embedded
  // newlines. Split every one first so no continuation line ever stands
  // outside the quote.
  return raw.flatMap((line) => line.split(/\r?\n/)).map((line) => (line === "" ? ">" : `> ${line}`))
}

function recordsMarkdown(entries: ExportEntry[], records: readonly SourceRecord[], exportedAt: string): string {
  const byNamespace = new Map<string, { entry: ExportEntry; record: SourceRecord }[]>()
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const group = byNamespace.get(entry.namespace)
    const pair = { entry, record: records[i]! }
    if (group === undefined) byNamespace.set(entry.namespace, [pair])
    else group.push(pair)
  }
  const lines: string[] = [
    "# Mida export — readable records",
    "",
    "This file lists your records in readable form. It contains no Mida keys — but anything you saved as a credential appears here in readable form. Anyone who can read it can read your context.",
    "",
    `Exported ${exportedAt} — ${entries.length} record${entries.length === 1 ? "" : "s"} in ${byNamespace.size} context area${byNamespace.size === 1 ? "" : "s"}.`,
    "",
  ]
  for (const [namespace, group] of [...byNamespace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${namespace} (${group.length})`, "")
    const newestFirst = [...group].sort((a, b) => b.entry.writtenAt.localeCompare(a.entry.writtenAt) || a.entry.contextId.localeCompare(b.entry.contextId))
    for (const { entry, record } of newestFirst) {
      // Honest labels only: a record is superseded (a later version exists) or it is the
      // checkpoint a handoff would continue from — there is no "current" flag to overclaim.
      const flags = [
        ...(entry.superseded ? [entry.supersededBy === null ? "superseded" : `superseded → ${entry.supersededBy}`] : []),
        ...(entry.newestCheckpoint ? ["the checkpoint a handoff for this task opens with"] : []),
        ...(entry.expired ? ["expired"] : []),
        ...(entry.lane === "batched" ? [`batched in ${entry.batchId}`] : []),
        ...(entry.envelope === "unreadable" ? ["migration envelope unreadable"] : []),
      ]
      lines.push(
        `### ${entry.kind} — ${entry.writtenAt} — by ${entry.author.name}`,
        "",
        `\`${entry.contextId}\` · v${entry.version} · ${entry.recordType}${flags.length === 0 ? "" : ` · ${flags.join(" · ")}`}`,
        "",
        ...contentLines(record),
        "",
      )
    }
  }
  return `${lines.join("\n")}\n`
}

/** The JSON.stringify replacer every exported JSON file uses: bigints are decimal strings. */
function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value
}

function readme(input: {
  exportedAt: string
  entries: ExportEntry[]
  owner: string
  network: Network
  apiBaseUrl: string
  blockNumber: bigint
  blockTime: bigint
  queued: number
  batchedPending: number
  /** Saves Monad registered after the export block — newer than this folder, left out. */
  landedAfter: number
  /** contextIds whose migration envelope could not be read — named so the export is honest. */
  unreadableIds: string[]
}): string {
  const { entries, network } = input
  const namespaces = new Map<string, number>()
  let direct = 0
  let batched = 0
  for (const entry of entries) {
    namespaces.set(entry.namespace, (namespaces.get(entry.namespace) ?? 0) + 1)
    if (entry.lane === "batched") batched += 1
    else direct += 1
  }
  const d = network.deployment
  return `# Mida export

This folder holds your records in readable form. It contains no Mida keys — but anything you saved
as a credential appears here in readable form, so keep the folder private or delete it when you are
done.

\`mida export\` wrote this folder on ${input.exportedAt}. It is a leaving-Mida package: every record
Monad attributes to your owner account, decrypted so you can read it, plus the exact manifest and
ciphertext bytes the store serves. The encrypted files can be checked against Monad without trusting
Mida; the readable files are what this machine decrypted from them.

The folder is written in one move: everything is staged in a sibling \`…​.partial-…​\` folder and
renamed into place at the end — if an export is interrupted by a crash or power loss, the next
export into the same parent folder removes the leftover, but only once its writer is provably
gone: the staging marker records the writer's machine, pid and that process's start time, so a
leftover still being written — on this machine or another — is kept and named instead.

## What is inside

- \`records.json\` — every record, machine-readable. Times are ISO-8601 UTC; bigints are decimal strings.
  On checkpoint records, \`task\` names the record's task ("main" when the envelope names none)
  and \`newestCheckpoint\` marks the checkpoint a handoff for this task opens with — the
  head of that task's working-session chain, so a newer session with no real work
  is not flagged and two tasks in one project each flag their own head.
- \`records.md\` — the same records readable, grouped by context area, newest first.
- \`encrypted/<contextId>.manifest.json\` — the manifest the store serves for that record, in the
  canonical JSON form the protocol hashes (\`canonicalBytes\`, packages/protocol/src/wire.ts — RFC 8785).
- \`encrypted/<contextId>.ciphertext\` — the exact ciphertext bytes the store serves.
- \`encrypted/<contextId>.batched.json\` — batched records only: the store's whole batch row
  (the signed save message, the signature, the Merkle proof) for the check below.

## Counts

- ${entries.length} record${entries.length === 1 ? "" : "s"} in ${namespaces.size} context area${namespaces.size === 1 ? "" : "s"}:
${[...namespaces.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `  - ${name}: ${count}`).join("\n")}
- lanes: ${direct} direct, ${batched} batched

## Where this export came from

- owner: ${input.owner}
- chain id: ${d.chainId}
- ContextRegistry: ${d.contextRegistry}
- CapabilityRegistry: ${d.capabilityRegistry}${d.batchAnchor === undefined ? "" : `\n- BatchAnchor: ${d.batchAnchor}`}
- store: ${input.apiBaseUrl}
- export block: ${input.blockNumber} (${new Date(Number(input.blockTime) * 1_000).toISOString()})

## Checking the encrypted files against Monad

For a record whose \`lane\` is "direct" (a ContextRegistry save of its own):

1. \`keccak256\` of \`encrypted/<contextId>.manifest.json\` must equal the record's \`manifestHash\`
   in records.json — the file IS the canonical bytes the protocol hashes (\`manifestHash\` in
   packages/crypto/src/object.ts is \`keccak256(canonicalBytes(manifest))\`).
2. \`ContextRegistry.getRecord(contextId)\` — the contract read the code itself uses
   (apps/api/src/chain-views.ts) — returns the chain's row; its \`manifestHash\` must equal the same
   value. That is what binds the file to Monad rather than to this export.
3. \`sha256\` of \`encrypted/<contextId>.ciphertext\` must equal \`ciphertextHash\` inside the manifest,
   and the file's byte length must equal \`ciphertextSize\`.

For a record whose \`lane\` is "batched" there is no \`getRecord\` row — the BatchAnchor committed
the batch, not the save. \`encrypted/<contextId>.batched.json\` holds the store's row:
\`save.message\`, \`save.signature\`, \`batchId\`, \`position\`, \`lineageId\`, \`version\`, \`proof\`.
Inside \`save.message\`, \`readEpoch\` and \`expiresAt\` are decimal strings — parse them to
integers; \`parentVersion\`, \`kind\` and \`provenanceSource\` are already numbers. The steps need
only a keccak256, an ABI encoder and an EIP-712 hasher — no Mida code.

1. The struct hash. \`typeHash = keccak256("MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)")\`.
   Then \`structHash = keccak256(abiEncode([bytes32, address, bytes32, bytes32, bytes32, bytes32, uint32, bytes32, bytes32, bytes32, uint64, uint64, uint8, uint8], [typeHash, owner, namespaceId, objectNonce, lineageId, parentId, parentVersion, rootAuthor, manifestHash, ciphertextCommitment, readEpoch, expiresAt, kind, provenanceSource]))\`
   — the message's own fields, in that order.
2. The signer. The signature is over the EIP-712 digest \`keccak256(0x1901 ‖ domainSeparator ‖ structHash)\`
   where the domain is \`{ name: "Mida Batch Anchor", version: "1", chainId: <the chain id above>, verifyingContract: <the BatchAnchor above> }\`
   (standard \`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)\`).
   Recover the signing address from \`save.signature\` over that digest, then read
   \`agentId = CapabilityRegistry.agentIdOfSigner(signer)\` — the agent the chain attributes the
   signature to.
3. The leaf. \`leafHash = keccak256(abiEncode([string, bytes32, bytes32, bytes32, uint32, bytes32], ["MIDA_BATCH_LEAF_V1", contextId, agentId, lineageId, version, structHash]))\`
   — the record's contextId, the agentId from step 2, and the row's own lineageId and version.
4. The root. \`BatchAnchor.batchOf(batchId)\` returns \`(root, blockNumber, acceptedCount)\`.
   Fold the row's \`proof\` onto the leaf: for each sibling, \`node = keccak256(min(node, sibling) ‖ max(node, sibling))\`
   (byte order decides the pair order — sorted, so a proof can never be replayed in the wrong
   position). The final node must equal \`root\`.
5. The anchor log. The batch's \`SaveAnchored\` event for this contextId carries a \`leafHash\`
   field — it must equal the leaf computed in step 3, and its \`batchId\`, \`lineageId\`,
   \`version\` and \`author\` (= agentId) must match the row's.
6. \`save.message.manifestHash\` must equal the record's \`manifestHash\` in records.json; the
   manifest and ciphertext files then check exactly as for a direct save.

Decrypting needs the owner's per-area keys — not included, by design.

## What is NOT in this folder

- **Saves still queued on this laptop: ${input.queued}.** The \`queue/\` in your Mida home holds
  captures the hooks took that have not reached Monad yet — they are not chain records, so an
  export cannot certify them. When the count is not 0, let the Mida service finish (or run
  \`mida doctor\`) and export again.
- **Batched saves still waiting for Monad: ${input.batchedPending}.** \`state/batch-pending.json\`
  in your Mida home holds saves the store accepted but the chain has not anchored yet — the same
  reason they cannot be in this folder. A non-zero count means export again after they land.
- **Saves that landed after the export began: ${input.landedAfter}.** A save Monad registered
  after the export block above is newer than this folder — left out, not lost. A non-zero
  count means run \`mida export\` again to include it.
- **Keys.** None — not your owner key, not any agent's key, not the per-area decryption keys.
  records.json and records.md are plaintext: keep this folder private, or delete it when you are done.
${input.unreadableIds.length === 0 ? "" : `
## Records with an unreadable migration envelope

${input.unreadableIds.length === 1 ? "This record" : "These records"} carried a migration envelope this build could
not read. ${input.unreadableIds.length === 1 ? "It" : "They"} exported anyway — the decrypted payload is in records.json
exactly as stored and \`envelope\` is "unreadable". \`writtenAt\` is Monad's own stamp — the
unreadable envelope's dates are not trusted for it. On a checkpoint, \`newestCheckpoint\` still
follows the handoff's rule: the handoff reads the envelope inside the checkpoint, and the flag
answers the same question it would for that record's task.

${input.unreadableIds.map((id) => `- \`${id}\``).join("\n")}
`}
`}

/**
 * `mida export <folder>` end to end. Order of gates, each refusing before anything is written:
 * the home must have a software owner (a passkey home holds no local owner key to decrypt with,
 * and opening the runtime must not create one); the folder must not exist yet — even as a broken
 * symlink — and must not resolve inside the Mida home; then the chain/store read runs with the
 * owner read's own completeness rules.
 */
export async function exportRecords(deps: ExportDeps): Promise<ExportResult> {
  const { home, network } = deps
  const mode = loadOwnerMode(home)
  if (mode === "passkey") {
    return refuse(deps, "passkey-owner", "export supports software-key setups only in this version")
  }
  if (mode === undefined || loadOwnerAddress(home) === undefined) {
    return refuse(deps, "no-owner", "this home has no owner yet — run `mida init` first")
  }
  // The key must already exist — export opens the runtime load-only so a missing secrets file
  // is a refusal, never a freshly minted owner key in a home that lost one.
  if (!home.has("owner/secrets.json")) {
    return refuse(deps, "no-owner-key", "no owner key on this machine — export needs the local software owner key")
  }
  if (typeof deps.folder !== "string" || deps.folder.trim() === "") {
    return refuse(deps, "no-folder", "export needs a folder to write to: mida export <folder>")
  }
  const dest = resolve(deps.cwd ?? process.cwd(), deps.folder)
  if (pathExists(dest)) {
    return refuse(deps, "export-exists", `the folder ${dest} already exists — export will not overwrite it`)
  }
  const realHome = existsSync(home.root) ? realpathSync.native(home.root) : resolve(home.root)
  const realDest = resolvedDest(dest)
  if (inside(realHome, realDest)) {
    return refuse(deps, "export-inside-home", `the export folder would land inside the Mida home — choose a folder outside ${home.root}`)
  }
  if (!existsSync(dirname(dest))) {
    return refuse(deps, "export-parent-missing", `the folder's parent does not exist: ${dirname(dest)}`)
  }

  // A kill -9 or a power cut can never run the cleanup below — the next export that reaches this
  // point removes every stale half-written `.partial-*` sibling first. Only real folders carrying
  // our marker with a provably-gone writer are touched — symlinks, look-alikes, live exports and
  // other machines' staging stay, and a kept leftover is named on the output.
  sweepLeftoverStaging(dest, deps.print, deps.sweep)

  const runtime = await (deps.openRuntime ?? ((h, n) => Runtime.open(h, n, undefined, "load-only")))(home, network)
  try {
    // readOwnerUniverse's progress is the log scan's (block ranges), not a record count — say so.
    const onProgress = (done: number, total: number): void => {
      deps.progress?.(`scanning the chain's record log — ${done} of ${total}`)
    }
    // The export block is read FIRST and the scans stop at it: the README states this number as
    // the upper bound of everything the folder holds, so the bound must be taken before the scan,
    // not after — otherwise a save landing mid-scan could make the stated block newer than the
    // data it claims to bound.
    const blockNumber = await runtime.chain.publicClient.getBlockNumber({ cacheTime: 0 })
    const block = await runtime.chain.publicClient.getBlock({ blockNumber })
    deps.progress?.("reading every record the chain attributes to you…")
    const landedAfterHead = new Set<Hex>()
    const read =
      deps.readUniverse ??
      ((rt, progress, toBlock, afterHead) =>
        readOwnerUniverse(rt, { keepEncrypted: true, onProgress: progress, toBlock, afterHead }))
    const records = await read(runtime, onProgress, blockNumber, landedAfterHead)
    for (const record of records) {
      if (record.encrypted === undefined) {
        throw codedError("export-incomplete", `record ${record.contextId} came back without its encrypted store bytes`)
      }
    }
    const names = authorNamesFor(runtime)
    const now = deps.now?.() ?? new Date()
    const supersededBy = supersededByMap(records)
    const latest = latestInLineage(records)
    const newestCheckpoints = newestCheckpointIds(records)
    const entries = records.map((record) => entryFor(record, names, supersededBy, latest, newestCheckpoints, now))
    const unreadableIds = entries.filter((entry) => entry.envelope === "unreadable").map((entry) => entry.contextId)
    const namespaces = new Set(entries.map((entry) => entry.namespace))
    const exportedAt = now.toISOString()
    const queued = peekJobs(home).length
    // Two different waits, counted separately: queue/ is hook captures not yet saved, and
    // state/batch-pending.json is saves the store accepted but Monad has not anchored. The
    // ledger is read strictly — a file that will not parse means "unknown", and unknown is
    // never "0 waiting", so the export refuses rather than print a count it cannot stand by.
    let batchedPending: number
    try {
      batchedPending = pendingAnchorsStrict(home).length
    } catch {
      return refuse(deps, "batch-ledger-unreadable", "the batched-saves ledger could not be read — export cannot say what is still waiting on Monad")
    }

    const temp = `${dest}.partial-${randomBytes(6).toString("hex")}`
    mkdirSync(temp, { mode: 0o700 })
    // Set false only if the post-rename parent fsync fails — reported as a warning below.
    let parentFlushed = true
    // FIRST file: the marker proves a leftover is a half-written Mida export — JSON naming the
    // destination, this host, this pid and THIS PROCESS's start time, so the next run's sweep
    // removes a leftover only when the writer is provably gone — never a live export's working
    // folder, never a pid a dead writer used to hold, never another machine's staging. And
    // while the folder exists, a signal must delete it before the process exits — Ctrl-C
    // mid-write must not leave plaintext.
    write0600(
      join(temp, STAGING_MARKER),
      `${JSON.stringify({
        dest,
        pid: process.pid,
        host: deps.sweep?.host ?? hostname(),
        pidStarted: deps.sweep?.pidStarted?.(process.pid) ?? pidStartedAt(process.pid) ?? "",
        startedAt: exportedAt,
      })}\n`,
    )
    watchStaging(temp)
    try {
      if (deps.stopAfter === "staged") throw codedError("export-stopped", `the export stopped after staging ${temp}`)
      mkdirSync(join(temp, "encrypted"), { mode: 0o700 })
      // A process-level signal handler cannot interrupt synchronous work — Node dispatches it at
      // the next event-loop turn, which would be AFTER the rename and the unwatch. The write
      // therefore yields periodically so a queued SIGINT/SIGTERM/SIGHUP runs its cleanup while
      // the staging folder still exists.
      let written = 0
      for (const record of records) {
        const encrypted = record.encrypted!
        const id = record.contextId.toLowerCase()
        write0600(join(temp, "encrypted", `${id}.manifest.json`), canonicalBytes(encrypted.manifest))
        write0600(join(temp, "encrypted", `${id}.ciphertext`), encrypted.ciphertext)
        if (encrypted.batchItem !== undefined) {
          write0600(join(temp, "encrypted", `${id}.batched.json`), `${JSON.stringify(encrypted.batchItem, bigintJson, 2)}\n`)
        }
        written += 1
        if (written % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      write0600(join(temp, "records.json"), `${JSON.stringify(entries, bigintJson, 2)}\n`)
      await new Promise<void>((resolve) => setImmediate(resolve))
      write0600(join(temp, "records.md"), recordsMarkdown(entries, records, exportedAt))
      if (deps.stopAfter === "files") throw codedError("export-stopped", `the export stopped after writing the record files`)
      await new Promise<void>((resolve) => setImmediate(resolve))
      write0600(
        join(temp, "README.md"),
        readme({
          exportedAt,
          entries,
          owner: runtime.owner,
          network,
          apiBaseUrl: runtime.apiBaseUrl,
          blockNumber,
          blockTime: block.timestamp,
          queued,
          batchedPending,
          landedAfter: landedAfterHead.size,
          unreadableIds,
        }),
      )
      // The one moment the destination matters again: if it appeared while we wrote, refuse and
      // take the staged folder down with us — export never overwrites.
      if (pathExists(dest)) {
        throw codedError("export-exists", `the folder ${dest} appeared while the export was running`)
      }
      renameSync(temp, dest)
      // The marker's job ended with the rename — a finished export is not a staging folder.
      // Best effort: a stubborn marker is a hidden timestamp file, nothing more.
      try {
        rmSync(join(dest, STAGING_MARKER))
      } catch {
        // leave it — it carries no data
      }
      // The rename made the export complete — flushing the parent's directory entry is the
      // last durability step and strictly best effort: a filesystem that refuses a directory
      // fsync (or the open) must not report failure over a finished folder, nor delete it.
      try {
        const parent = openSync(dirname(dest), "r")
        try {
          fsyncSync(parent)
        } finally {
          closeSync(parent)
        }
      } catch {
        parentFlushed = false
      }
    } catch (error) {
      // The staged folder holds plaintext — whatever failed, it leaves nothing behind.
      rmSync(temp, { recursive: true, force: true })
      throw error
    } finally {
      // Staging is over on every path: a signal from here on must not exit a finished export.
      unwatchStaging(temp)
    }

    deps.print(`Exported ${records.length} record${records.length === 1 ? "" : "s"} (${namespaces.size} namespace${namespaces.size === 1 ? "" : "s"}) to ${dest}.`)
    if (!parentFlushed) {
      deps.print("warning: the folder's parent directory could not be flushed to disk — the export is complete, but a power loss in the next moments could lose the rename")
    }
    if (queued > 0 || batchedPending > 0) {
      deps.print(
        `${queued} save${queued === 1 ? "" : "s"} ${queued === 1 ? "is" : "are"} still queued on this laptop and ${batchedPending} batched save${batchedPending === 1 ? "" : "s"} ${batchedPending === 1 ? "is" : "are"} waiting for Monad; they are not in this export. Run export again after they land.`,
      )
    }
    if (unreadableIds.length > 0) {
      deps.print(
        `warning: ${unreadableIds.length} record${unreadableIds.length === 1 ? "" : "s"} carried an unreadable migration envelope and exported as-is (marked in records.json): ${unreadableIds.join(", ")}`,
      )
    }
    if (landedAfterHead.size > 0) {
      deps.print(
        `${landedAfterHead.size} save${landedAfterHead.size === 1 ? "" : "s"} landed after the export started; run export again to include them`,
      )
    }
    return {
      outcome: "exported",
      records: records.length,
      namespaces: namespaces.size,
      folder: dest,
      queued,
      batchedPending,
      landedAfter: landedAfterHead.size,
    }
  } finally {
    await runtime.close()
  }
}
