import { randomBytes } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { zeroHash } from "viem"
import { CONTEXT_KIND, OWNER_AUTHOR_ID, PROVENANCE_SOURCE, RECORD_TYPE, canonicalBytes } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { orderTime } from "@mida/checkpoint"
import type { Checkpoint, StoredCheckpoint } from "@mida/checkpoint"
import type { MidaHome } from "./home.js"
import { loadOwnerAddress, loadOwnerMode } from "./keys.js"
import { peekJobs } from "./queue.js"
import { readOwnerUniverse } from "./owner-read.js"
import type { SourceRecord } from "./owner-read.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { authorNamesFor } from "./skeleton.js"
import { movedOnSuffix, readEnvelope } from "./migration-envelope.js"
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
 * runs a synchronous process-level cleanup, and a kill -9 or power cut is covered by the marker
 * file the next export's sweep removes before writing. The rename to <folder> happens once, at
 * the end.
 */

export type ExportResult =
  | { outcome: "exported"; records: number; namespaces: number; folder: string; queued: number }
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
  /** Test seam: the owner read. Default: readOwnerUniverse with keepEncrypted on. */
  readUniverse?: (runtime: Runtime, onProgress: (done: number, total: number) => void) => Promise<SourceRecord[]>
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
  /** True on the highest version in the record's lineage — the record a read would answer with. */
  current: boolean
  /** The record that replaced this one, or null. */
  supersededBy: Hex | null
  lane: "direct" | "batched"
  batchId: Hex | null
  /** The read epoch the record was sealed under — a decimal string. */
  readEpoch: string
  references: { relation: string; recordId: Hex }[]
  /** The chain's commitment to the stored object — keccak256 of the canonical manifest. */
  manifestHash: Hex
  /** The decrypted payload, exactly as read back — plaintext. */
  payload: unknown
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
 * Written FIRST inside every `<dest>.partial-*` staging folder — proof that a leftover is a
 * half-written Mida export holding plaintext. The next run's sweep deletes only folders that
 * carry it; a folder without it is somebody else's and stays untouched.
 */
const STAGING_MARKER = ".mida-export-staging"

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
 * Deletes sibling `<dest>.partial-*` folders a previous export left behind — a kill -9 or a
 * power cut can never run this process's own cleanup, so the NEXT run removes them before
 * writing. The marker file is the proof the folder is ours and half-written: without it, the
 * folder stays untouched. One printed line per removed folder — it held plaintext.
 */
function sweepLeftoverStaging(dest: string, print: (line: string) => void): void {
  const parent = dirname(dest)
  const prefix = `${basename(dest)}.partial-`
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return // the parent cannot be listed — a run that needs it fails on its own write
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const dir = join(parent, name)
    try {
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, STAGING_MARKER))) continue
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
    throw codedError("export-inconsistent", `record ${contextId} carries a ${what} value (${value}) this build does not know`)
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
        throw codedError("export-inconsistent", `lineage ${lineage} has two records naming ${record.parentId} as parent`)
      }
      childOf.set(parent, record)
    }
    for (const [parent, child] of childOf) supersededBy.set(parent, child.contextId)
  }
  return supersededBy
}

/** The highest version in each lineage — the records a reader would call current. */
function currentIds(records: readonly SourceRecord[]): Set<string> {
  const byLineage = new Map<string, number>()
  for (const record of records) {
    const key = (record.lineageId === zeroHash ? record.contextId : record.lineageId).toLowerCase()
    byLineage.set(key, Math.max(byLineage.get(key) ?? -1, record.version))
  }
  const current = new Set<string>()
  for (const record of records) {
    const key = (record.lineageId === zeroHash ? record.contextId : record.lineageId).toLowerCase()
    if (record.version === byLineage.get(key)) current.add(record.contextId.toLowerCase())
  }
  return current
}

/**
 * writtenAt by the in-12 merge rule (packages/checkpoint merge.ts orderTime): the chain's stamp
 * decides, and a migrated record keeps the earlier of its original write day and its replay's
 * stamp — never the writer's own claim, and never a day after Monad saw it.
 */
function writtenAtMs(record: SourceRecord): number {
  const migration = readEnvelope(record.payload)
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
  current: Set<string>,
  now: Date,
): ExportEntry {
  const authorName =
    record.authorId.toLowerCase() === OWNER_AUTHOR_ID.toLowerCase()
      ? "you"
      : names[record.authorId.toLowerCase()] ?? record.authorId
  return {
    contextId: record.contextId,
    namespace: record.namespace,
    namespaceId: record.namespaceId,
    recordType: enumName(RECORD_TYPE, record.recordType, "record type", record.contextId),
    kind: enumName(CONTEXT_KIND, record.kind, "kind", record.contextId),
    source: enumName(PROVENANCE_SOURCE, record.provenanceSource, "provenance source", record.contextId),
    author: { id: record.authorId, name: authorName },
    writtenAt: msIso(writtenAtMs(record)),
    chainTime: iso(record.createdAt),
    expiresAt: record.expiresAt === 0n ? null : iso(record.expiresAt),
    expired: record.expiresAt !== 0n && record.expiresAt * 1_000n <= BigInt(now.getTime()),
    lineageId: record.lineageId,
    version: record.version,
    parentId: record.parentId,
    current: current.has(record.contextId.toLowerCase()),
    supersededBy: supersededBy.get(record.contextId.toLowerCase()) ?? null,
    lane: record.lane ?? "direct",
    batchId: record.batchId ?? null,
    readEpoch: record.readEpoch.toString(10),
    references: record.references.map((reference) => ({ relation: reference.relation, recordId: reference.recordId })),
    manifestHash: record.manifestHash,
    payload: record.payload,
  }
}

/** A checkpoint envelope's fields in the order a handoff reader would tell them. */
function checkpointLines(envelope: CheckpointEnvelope): string[] {
  const c = envelope.checkpoint
  const lines: string[] = [`project ${envelope.projectId} · session ${envelope.sessionId} · compiled by ${envelope.compiledBy}`]
  lines.push(`objective: ${c.objective}`)
  if (c.originalRequest !== null) lines.push(`asked: ${c.originalRequest}`)
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
  const migration = readEnvelope(record.payload)
  if (migration !== undefined) {
    raw.push(
      `${movedOnSuffix(migration)} — originally record ${migration.originalRecordId} on contract ${migration.originalContract}, chain ${migration.originalChainId}`,
    )
  }
  return raw.map((line) => (line === "" ? ">" : `> ${line}`))
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
    "This file lists your records in readable form. It contains no keys. Anyone who can read it can read your context.",
    "",
    `Exported ${exportedAt} — ${entries.length} record${entries.length === 1 ? "" : "s"} in ${byNamespace.size} context area${byNamespace.size === 1 ? "" : "s"}.`,
    "",
  ]
  for (const [namespace, group] of [...byNamespace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${namespace} (${group.length})`, "")
    const newestFirst = [...group].sort((a, b) => b.entry.writtenAt.localeCompare(a.entry.writtenAt) || a.entry.contextId.localeCompare(b.entry.contextId))
    for (const { entry, record } of newestFirst) {
      const flags = [
        entry.current ? "current" : `superseded → ${entry.supersededBy ?? "unknown"}`,
        ...(entry.expired ? ["expired"] : []),
        ...(entry.lane === "batched" ? [`batched in ${entry.batchId}`] : []),
      ]
      lines.push(
        `### ${entry.kind} — ${entry.writtenAt} — by ${entry.author.name}`,
        "",
        `\`${entry.contextId}\` · v${entry.version} · ${entry.recordType} · ${flags.join(" · ")}`,
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

This folder holds your records in readable form. It contains no keys. Anyone who can read it can read your context.

\`mida export\` wrote this folder on ${input.exportedAt}. It is a leaving-Mida package: every record
Monad attributes to your owner account, decrypted so you can read it, plus the exact manifest and
ciphertext bytes the store serves — so what this folder claims can be checked against the chain
itself, without trusting Mida or this machine.

## What is inside

- \`records.json\` — every record, machine-readable. Times are ISO-8601 UTC; bigints are decimal strings.
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

1. \`batchSaveStructHash(save.message)\` (packages/protocol/src/batch.ts) — the EIP-712
   MidaBatchSaveV1 struct hash, domain-separated by chain id and the BatchAnchor address.
2. \`batchLeafHash({contextId, agentId, lineageId, version, structHash})\` — \`agentId\` is the
   signer's agent id: recover who signed \`save.signature\` over the EIP-712 hash of \`save.message\`,
   then \`CapabilityRegistry.agentIdOfSigner(signer)\`.
3. \`BatchAnchor.batchOf(batchId)\` returns the batch's Merkle root;
   \`verifyMerkleProof(leafHash, proof, root)\` — keccak256 over sorted pairs — must hold. The leaf
   is also in the batch's own \`SaveAnchored\` log for this contextId; it must equal the recomputed leaf.
4. \`save.message.manifestHash\` must equal the record's \`manifestHash\`; the manifest and ciphertext
   files then check exactly as for a direct save.

Decrypting needs the owner's per-area keys — not included, by design.

## What is NOT in this folder

- **Saves still queued on this laptop: ${input.queued}.** The \`queue/\` in your Mida home holds
  captures the hooks took that have not reached Monad yet — they are not chain records, so an
  export cannot certify them. When the count is not 0, let the Mida service finish (or run
  \`mida doctor\`) and export again.
- **Keys.** None — not your owner key, not any agent's key, not the per-area decryption keys.
  records.json and records.md are plaintext: keep this folder private, or delete it when you are done.
`
}

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
  // point removes a leftover half-written folder first. Only folders carrying our marker are
  // touched.
  sweepLeftoverStaging(dest, deps.print)

  const runtime = await (deps.openRuntime ?? Runtime.open)(home, network)
  try {
    // readOwnerUniverse's progress is the log scan's (block ranges), not a record count — say so.
    const onProgress = (done: number, total: number): void => {
      deps.progress?.(`scanning the chain's record log — ${done} of ${total}`)
    }
    deps.progress?.("reading every record the chain attributes to you…")
    const read = deps.readUniverse ?? ((rt, progress) => readOwnerUniverse(rt, { keepEncrypted: true, onProgress: progress }))
    const records = await read(runtime, onProgress)
    for (const record of records) {
      if (record.encrypted === undefined) {
        throw codedError("export-incomplete", `record ${record.contextId} came back without its encrypted store bytes`)
      }
    }
    const names = authorNamesFor(runtime)
    const now = deps.now?.() ?? new Date()
    const supersededBy = supersededByMap(records)
    const current = currentIds(records)
    const entries = records.map((record) => entryFor(record, names, supersededBy, current, now))
    const namespaces = new Set(entries.map((entry) => entry.namespace))
    const exportedAt = now.toISOString()
    const blockNumber = await runtime.chain.publicClient.getBlockNumber({ cacheTime: 0 })
    const block = await runtime.chain.publicClient.getBlock({ blockNumber })
    const queued = peekJobs(home).length

    const temp = `${dest}.partial-${randomBytes(6).toString("hex")}`
    mkdirSync(temp, { mode: 0o700 })
    // Set false only if the post-rename parent fsync fails — reported as a warning below.
    let parentFlushed = true
    // FIRST file: the marker proves a leftover is a half-written Mida export — the next run's
    // sweep deletes only folders that carry it. And while the folder exists, a signal must
    // delete it before the process exits — Ctrl-C mid-write must not leave plaintext.
    write0600(join(temp, STAGING_MARKER), `${exportedAt}\n`)
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
    if (queued > 0) {
      deps.print(`${queued} save${queued === 1 ? "" : "s"} still queued on this laptop ${queued === 1 ? "is" : "are"} not in the export — ${queued === 1 ? "it has" : "they have"} not reached Monad yet`)
    }
    return { outcome: "exported", records: records.length, namespaces: namespaces.size, folder: dest, queued }
  } finally {
    await runtime.close()
  }
}
