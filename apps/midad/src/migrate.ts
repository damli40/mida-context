import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { createPublicClient, http, zeroHash } from "viem"
import type { AbiEvent } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { randomBytes } from "@noble/hashes/utils.js"
import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  MAX_PAYLOAD_BYTES,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  canonicalBytes,
  decodeUint64,
  encodeUint64,
  evidenceCommitment,
  namespaceById,
  namespaceId,
} from "@mida/protocol"
import type {
  Address,
  ContextKind,
  ContextPayload,
  Hex,
  LineagePolicy,
  ObjectManifest,
  RecordType,
} from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, generateX25519KeyPair, hexOf, openContextObject } from "@mida/crypto"
import {
  chainFor,
  contextRegistryAbi,
  createSponsoredSender,
  createWriteContext,
  getLogsChunked,
  latestTimestamp,
  parseDeployment,
  registerAgent,
} from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { predictAgentId } from "@mida/fake-vault"
import type { SealedRecord as OwnerSealedRecord } from "@mida/fake-vault"
import { manifestBindingFor, manifestBodyHash } from "@mida/grant-advisor"
import type { SealedRecord } from "@mida/sdk"
import { RegistryReader } from "@mida/api"
import type { AnchoredObject } from "@mida/api"
import { MidaHome, resolveHome } from "./home.js"
import { Runtime, makeOwnerBalanceGuard, parseSponsorUrl, sponsorReachable, NAMESPACE } from "./runtime.js"
import type { Network } from "./runtime.js"
import { FACT_NAMESPACES } from "./remember.js"
import { resolveNetwork } from "./network.js"
import { approve, authorNamesFor, isCapabilityLive } from "./skeleton.js"
import type { ApprovePreview } from "./skeleton.js"
import {
  isRevoked,
  listAgentNames,
  loadAgentIdentity,
  loadGrants,
  loadOrCreateOperatorSecrets,
  loadOrCreateSignerKey,
  loadOwnerAddress,
  loadOwnerMode,
  markRevoked,
  saveAgentIdentity,
  saveGrants,
} from "./keys.js"
import type { AgentIdentity } from "./keys.js"
import { callDaemon } from "./control.js"
import { readOwnerUniverse } from "./owner-read.js"
import type { SourceRecord } from "./owner-read.js"
import { buildManifest, payloadFingerprint, preflight, replayOrder } from "./migrate-manifest.js"
import type { Manifest, ManifestEntry } from "./migrate-manifest.js"
import { attachEnvelope, readEnvelope } from "./migration-envelope.js"
import type { MigrationEnvelope } from "./migration-envelope.js"

/**
 * Plan B Task 5: the migrate state machine. Copies every record a software-key setup owns from
 * the contract saved in its network.json to the deployment this code ships (or `deps.target`),
 * with provenance unchanged, onto a staging home at `<home>/migrate/target/` — and never changes
 * how the setup behaves (the switch and `--undo` are Task 6).
 *
 * Crash safety: every external write is PREPARE (persist the random value and the predicted id
 * to `migrate/state.json` or `migrate/sealed/<sourceId>.json`, both 0600) → COMMIT (send exactly
 * that) → VERIFY (read the target chain). A re-run reads the state file and the target chain,
 * so a crash at any point resumes without duplicating a registration, grant or record — and a
 * send that landed before the crash is recognised as done rather than sent again.
 */
export type MigrateStep =
  | "preview"
  | "paused"
  | "backed-up"
  | "manifest"
  | "target-setup"
  | "agents"
  | "approvals"
  | "records"
  | "verified"
  | "switched"

export interface MigrateDeps {
  home: MidaHome
  env: Record<string, string | undefined>
  confirm: (text: string) => Promise<boolean>
  print: (line: string) => void
  now: () => Date
  /** default: resolveNetwork(home, env).builtIn — tests inject a local deployment */
  target?: Deployment
  /** tests only: throw a `migrate-stopped` error right after persisting this step — a simulated crash */
  stopAfter?: MigrateStep
  /**
   * tests only: throw a `migrate-stopped` error right after the Nth send of this kind — the crash
   * window between a transaction landing and its local bookkeeping that `stopAfter` cannot reach
   * (it fires only at step boundaries). Production callers never set it.
   */
  throwAfterSend?: { kind: "agent" | "record"; nth: number }
  /** starts the local service once the switch (or an undo restore) has landed — the CLI injects the real spawn */
  startService?: () => unknown | Promise<unknown>
  /**
   * One plain line during a slow step — the chain scans and the sends. The CLI writes these to
   * stderr so the command's stdout keeps its shape; tests inject a collector.
   */
  progress?: (line: string) => void
}

/**
 * The stderr narration for one long chain scan: a line about every 5%, prefixed by what is being
 * read. `total` is a plan, not a promise — a provider that refuses the window size splits the
 * rest into smaller pieces and the real request count grows past it, so the line says "about".
 */
function scanReport(what: string, progress: ((line: string) => void) | undefined): ((done: number, total: number) => void) | undefined {
  if (progress === undefined) return undefined
  return (done, total) =>
    progress(
      `reading ${what} history: ${total === 0 ? 100 : Math.floor((done * 100) / total)}% (${done.toLocaleString("en-US")} of about ${total.toLocaleString("en-US")} requests)`,
    )
}

interface MigrateState {
  version: 1
  step: MigrateStep
  target: unknown
  migratedAt: string
  /** Present until the switch: the kept state must not carry it afterwards (rule "switched"). */
  hmacKey?: string
  manifest: Manifest
}

/** A plain Error carrying `.code` — `migrate-stopped` and the refusals are midad-level codes. */
function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function stoppedError(where: string): Error & { code: string } {
  return codedError("migrate-stopped", `simulated crash after "${where}"`)
}

const lower = (hex: string): Hex => hex.toLowerCase() as Hex
const sameContract = (a: Deployment, b: Deployment): boolean =>
  a.chainId === b.chainId &&
  a.capabilityRegistry.toLowerCase() === b.capabilityRegistry.toLowerCase() &&
  a.contextRegistry.toLowerCase() === b.contextRegistry.toLowerCase()
const short = (a: string): string => `${a.slice(0, 6)}…`

/** The number → name lookup replay needs (sealReplay takes the string union, the manifest stores the number). */
function nameOf<T extends Record<string, number>>(table: T, value: number): keyof T {
  const name = Object.keys(table).find((key) => table[key] === value)
  if (name === undefined) throw new Error(`unknown enum value ${value}`)
  return name as keyof T
}

const CONTEXT_REGISTERED = contextRegistryAbi.find(
  (entry) => entry.type === "event" && entry.name === "ContextRegistered",
) as AbiEvent

/** Copies one file or folder tree inside the home, keeping 0600 files and 0700 folders. */
function copyInto(home: MidaHome, fromRel: string, toRel: string): void {
  const source = home.path(fromRel)
  const stat = statSync(source)
  if (stat.isDirectory()) {
    mkdirSync(home.path(toRel), { recursive: true, mode: 0o700 })
    chmodSync(home.path(toRel), 0o700)
    for (const child of readdirSync(source)) copyInto(home, `${fromRel}/${child}`, `${toRel}/${child}`)
    return
  }
  const destination = home.path(toRel)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  chmodSync(destination, stat.mode & 0o777)
}

/**
 * The `SealedRecord` (SDK and vault shapes are identical) as it sits on disk: bigints as decimal
 * strings, ciphertext as hex. Ciphertext only — no plaintext ever touches `migrate/`.
 */
interface StoredSealed {
  contextId: Hex
  namespaceId: Hex
  readEpoch: string
  manifest: ObjectManifest
  manifestHash: Hex
  ciphertext: Hex
  onChain: {
    recordType: "CONTEXT" | "EVIDENCE"
    kind: ContextKind
    lineagePolicy: LineagePolicy
    expiresAt: string
    expectedParentId: Hex
    evidenceCommitment: Hex
    objectNonce: Hex
    provenanceSource: number
  }
}

const sealToStored = (sealed: SealedRecord | OwnerSealedRecord): StoredSealed => ({
  contextId: sealed.contextId,
  namespaceId: sealed.namespaceId,
  readEpoch: sealed.readEpoch.toString(10),
  manifest: sealed.manifest,
  manifestHash: sealed.manifestHash,
  ciphertext: hexOf(sealed.ciphertext),
  onChain: { ...sealed.onChain, expiresAt: sealed.onChain.expiresAt.toString(10) },
})

const storedToSeal = (stored: StoredSealed): SealedRecord => ({
  contextId: stored.contextId,
  namespaceId: stored.namespaceId,
  readEpoch: BigInt(stored.readEpoch),
  manifest: stored.manifest,
  manifestHash: stored.manifestHash,
  ciphertext: bytesOf(stored.ciphertext, stored.manifest.ciphertextSize),
  onChain: { ...stored.onChain, expiresAt: BigInt(stored.onChain.expiresAt) },
})

/** The local agent name behind each on-chain author id — `authorNamesFor` without a runtime. */
function authorNamesOf(home: MidaHome): Record<string, string> {
  const names: Record<string, string> = {}
  for (const name of listAgentNames(home)) {
    const identity = loadAgentIdentity(home, name)
    if (identity !== undefined) names[identity.agentId.toLowerCase()] = name
  }
  return names
}

/** The capability tuples this agent holds live on the source contract right now. */
async function liveSourceScopes(
  reader: RegistryReader,
  owner: Address,
  agentId: Hex,
): Promise<{ namespaceId: Hex; permissions: number; provenancePolicy: number; expiresAt: bigint }[]> {
  const scopes = []
  for (const capabilityId of await reader.activeCapabilityIds(owner, agentId)) {
    const capability = await reader.getCapability(capabilityId)
    if (capability === null || !(await isCapabilityLive(reader.context, capabilityId))) continue
    scopes.push({
      namespaceId: capability.namespaceId,
      permissions: capability.permissions,
      provenancePolicy: capability.provenancePolicy,
      expiresAt: capability.expiresAt,
    })
  }
  return scopes
}

/** The provenance policy bit a record's provenanceSource requires of an agent capability. */
function provenanceBitFor(source: number): number {
  switch (source) {
    case PROVENANCE_SOURCE.AGENT_INFERRED:
      return PROVENANCE_POLICY.ALLOW_INFERENCE
    case PROVENANCE_SOURCE.IMPORTED:
      return PROVENANCE_POLICY.ALLOW_IMPORTED
    case PROVENANCE_SOURCE.EXTERNAL_ATTESTATION:
      return PROVENANCE_POLICY.ALLOW_EXTERNAL_ATTESTATION
    default:
      return 0
  }
}

/** A capability or scope as one comparable string — "namespace:permissions:provenance". */
const scopeTuple = (scope: { namespaceId: string; permissions: number; provenancePolicy: number }): string =>
  `${scope.namespaceId.toLowerCase()}:${scope.permissions}:${scope.provenancePolicy}`

/** Canonical-JSON equality — the way two reference lists are compared byte for byte. */
const sameCanonical = (a: unknown, b: unknown): boolean => {
  const ab = canonicalBytes(a)
  const bb = canonicalBytes(b)
  return ab.length === bb.length && ab.every((byte, i) => byte === bb[i])
}

interface ReplayScope {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
}

/**
 * The write scopes an agent's authored records demand: CREATE where it starts a lineage,
 * SUPERSEDE_OWN or SUPERSEDE_ANY where it replaces one, plus the provenance bit each record's
 * provenanceSource requires. Used for a source-revoked agent's replay grant and for the extra
 * replay-only scopes a live agent may need in an area it no longer writes (Task 6).
 */
function replayScopesFor(
  authored: readonly ManifestEntry[],
  byId: ReadonlyMap<string, ManifestEntry>,
  name: string,
): ReplayScope[] {
  const merged = new Map<string, ReplayScope>()
  for (const entry of authored) {
    const nsId = namespaceId(entry.namespace)
    const current = merged.get(nsId) ?? { namespaceId: nsId, permissions: 0, provenancePolicy: 0 }
    current.provenancePolicy |= provenanceBitFor(entry.provenanceSource)
    if (entry.parentId.toLowerCase() === zeroHash) {
      current.permissions |= PERMISSION.CREATE
    } else {
      const root = byId.get(entry.lineageId.toLowerCase())
      current.permissions |= root !== undefined && root.authorName === name ? PERMISSION.SUPERSEDE_OWN : PERMISSION.SUPERSEDE_ANY
    }
    merged.set(nsId, current)
  }
  return [...merged.values()]
}

/** The network.json `deployment` shape — bigints as decimal strings, parseable by parseDeployment. */
function serializeDeployment(deployment: Deployment): Record<string, unknown> {
  return {
    ...deployment,
    chainId: deployment.chainId.toString(10),
    deploymentBlock: deployment.deploymentBlock.toString(10),
    batchAnchorBlock: deployment.batchAnchorBlock?.toString(10),
  }
}

/**
 * The spec §5.4 preview line plus per-agent revocation notes. "Approvals" counts the capability
 * tuples live on the source — the number the migration recreates; record counts come from the
 * manifest, never the chain, so a skipped record still shows as skipped rather than vanishing.
 */
async function previewLines(
  home: MidaHome,
  runtime: Runtime,
  source: Deployment,
  target: Deployment,
  manifest: Manifest,
): Promise<string[]> {
  const lines: string[] = []
  const agents = Object.keys(manifest.agentMap).sort()
  let approvals = 0
  const livePerAgent = new Map<string, number>()
  for (const name of agents) {
    const live = await liveSourceScopes(runtime.reader, runtime.owner, manifest.agentMap[name]!.oldAgentId)
    livePerAgent.set(name, live.length)
    approvals += live.length
  }
  const folders = home.readJson<{ entries?: unknown[] }>("approved-projects.json")?.entries?.length ?? 0
  const movable = manifest.entries.filter((entry) => !entry.status.startsWith("skipped:"))
  const areas = new Set(movable.map((entry) => entry.namespace)).size
  const facts = movable.filter((entry) => entry.kind === CONTEXT_KIND.FACT || entry.kind === CONTEXT_KIND.PREFERENCE).length
  const checkpoints = movable.filter((entry) => entry.namespace === NAMESPACE).length
  const superseded = movable.filter((entry) => entry.version > 1).length
  const evidence = movable.filter((entry) => entry.recordType === RECORD_TYPE.EVIDENCE).length
  const skipped = manifest.entries.length - movable.length
  lines.push(
    `this setup is on ${short(source.capabilityRegistry)}; it will move to ${short(target.capabilityRegistry)}: ` +
      `1 owner, ${agents.length} agent(s), ${approvals} approval(s), ${folders} approved folder(s), ` +
      `${movable.length} records in ${areas} areas (${facts} facts, ${checkpoints} checkpoints, ` +
      `${superseded} superseded versions, ${evidence} evidence records)` +
      (runtime.network.sponsorUrl === undefined ? "; gas paid by your wallet" : `; gas paid by ${new URL(runtime.network.sponsorUrl).hostname}`),
  )
  if (skipped > 0) {
    const reasons = new Map<string, number>()
    for (const entry of manifest.entries.filter((entry) => entry.status.startsWith("skipped:"))) {
      reasons.set(entry.status, (reasons.get(entry.status) ?? 0) + 1)
    }
    for (const [status, count] of reasons) lines.push(`${count} record(s) will not move: ${status}`)
  }
  for (const name of agents) {
    if ((livePerAgent.get(name) ?? 0) > 0) continue
    const authored = movable.filter((entry) => entry.authorName === name).length
    if (authored > 0) {
      lines.push(
        `${name} was revoked; it will get a temporary write grant on the new contract to copy its ${authored} record(s), then be revoked again`,
      )
    }
  }
  return lines
}

/**
 * The manifest for the "move access only" path (rule 0): the store cannot serve the records, so
 * the universe is enumerated from the owner's ContextRegistered logs alone — no store, no
 * plaintext. Every entry is `skipped:store-unreadable`; fingerprints stay zero because there is
 * nothing to fingerprint.
 */
async function storeUnreadableManifest(
  home: MidaHome,
  sourceNetwork: Network,
  source: Deployment,
  target: Deployment,
  onProgress?: (done: number, total: number) => void,
): Promise<Manifest> {
  const owner = loadOwnerAddress(home)
  if (owner === undefined) throw new Error("owner-address.json is missing — run `mida init` first")
  const client = createPublicClient({ chain: chainFor(source.chainId), transport: http(sourceNetwork.rpcUrl) })
  const logs = await getLogsChunked(client, {
    address: source.contextRegistry,
    event: CONTEXT_REGISTERED,
    args: { owner },
    fromBlock: source.deploymentBlock,
  }, { maxRange: sourceNetwork.logBlockRange, onProgress })
  const names = authorNamesOf(home)
  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const log of logs) {
    const args = log.args as { contextId: Hex; record: { namespaceId: Hex; author: Hex; recordType: number; kind: number; provenanceSource: number; lineagePolicy: number; lineageId: Hex; parentId: Hex; version: number; createdAt: bigint; expiresAt: bigint; manifestHash: Hex } }
    const contextId = args.contextId.toLowerCase() as Hex
    if (seen.has(contextId)) continue
    seen.add(contextId)
    const record = args.record
    let namespace: string
    try {
      namespace = namespaceById(record.namespaceId).name
    } catch {
      namespace = record.namespaceId
    }
    const authorId = record.author.toLowerCase() as Hex
    const authorName = authorId === zeroHash ? "owner" : (names[authorId] ?? null)
    entries.push({
      sourceId: contextId,
      sourceCommitment: record.manifestHash.toLowerCase() as Hex,
      origin: {
        chainId: source.chainId.toString(10),
        contract: source.contextRegistry,
        recordId: contextId,
        commitment: record.manifestHash.toLowerCase() as Hex,
        author: authorId,
        createdAt: new Date(Number(record.createdAt) * 1000).toISOString(),
      },
      namespace,
      authorId,
      authorName,
      provenanceSource: record.provenanceSource,
      recordType: record.recordType,
      kind: record.kind,
      lineagePolicy: record.lineagePolicy,
      expiresAt: encodeUint64(record.expiresAt),
      createdAt: new Date(Number(record.createdAt) * 1000).toISOString(),
      lineageId: record.lineageId.toLowerCase() as Hex,
      version: record.version,
      parentId: record.parentId.toLowerCase() as Hex,
      relations: [],
      fingerprint: zeroHash,
      destinationBytes: 0,
      limit: MAX_PAYLOAD_BYTES,
      status: "skipped:store-unreadable",
    })
  }
  const agentMap: Manifest["agentMap"] = {}
  for (const [authorId, name] of Object.entries(names)) {
    agentMap[name] = { oldAgentId: authorId as Hex }
  }
  return {
    version: 1,
    source: { chainId: source.chainId.toString(10), contextRegistry: source.contextRegistry },
    target: { chainId: target.chainId.toString(10), contextRegistry: target.contextRegistry },
    entries,
    agentMap,
  }
}

export async function migrate(
  deps: MigrateDeps,
): Promise<{ outcome: "moved" | "refused" | "nothing-to-move"; lines: string[] }> {
  const { home, env, confirm, now } = deps
  const lines: string[] = []
  const say = (line: string): void => {
    lines.push(line)
    deps.print(line)
  }
  const refuse = (line: string): { outcome: "refused"; lines: string[] } => {
    say(line)
    return { outcome: "refused", lines }
  }

  // ── Rule 0: refusals before any side effect ──────────────────────────────────
  if (loadOwnerMode(home) === "passkey") {
    return refuse("migrate supports software-key setups only in this version")
  }
  const resolved = await resolveNetwork(home, env, {
    ...(deps.target === undefined ? {} : { loadBuiltIn: () => deps.target! }),
  })
  const sourceNetwork = resolved.network
  const source = sourceNetwork.deployment
  const target = deps.target ?? resolved.builtIn

  let persisted: MigrateState | undefined
  if (home.has("migrate/state.json")) {
    try {
      persisted = home.readJson<MigrateState>("migrate/state.json")
      if (persisted?.version !== 1 || persisted.manifest === undefined) persisted = undefined
      if (persisted === undefined) return refuse("migrate/state.json is present but not a v1 migration state — remove migrate/ or restore a backup before re-running")
    } catch {
      return refuse("migrate/state.json could not be parsed — the migration state is corrupt; remove migrate/ or restore a backup before re-running")
    }
    const persistedTarget = parseDeployment(persisted.target)
    if (!sameContract(persistedTarget, target)) {
      return refuse(
        `a migration to ${persistedTarget.capabilityRegistry} is already in progress — this run names ${target.capabilityRegistry}`,
      )
    }
  }
  if (sameContract(source, target)) {
    say(`already on ${target.contextRegistry} — nothing to move`)
    return { outcome: "nothing-to-move", lines }
  }

  // A remote store that no longer serves the source contract cannot give the records back — the
  // owner may still move the access side (agents and approvals), after a second confirmation.
  let accessOnly = false
  if (persisted === undefined && sourceNetwork.storageUrl !== undefined) {
    let servedRegistry: string | undefined
    try {
      const reply = await fetch(sourceNetwork.storageUrl, { signal: AbortSignal.timeout(10_000) })
      const body = (await reply.json()) as { capabilityRegistry?: unknown }
      if (typeof body.capabilityRegistry === "string") servedRegistry = body.capabilityRegistry.toLowerCase()
    } catch {
      servedRegistry = undefined
    }
    if (servedRegistry !== source.capabilityRegistry.toLowerCase()) {
      say(
        servedRegistry === undefined
          ? `the store at ${sourceNetwork.storageUrl} did not answer — your records cannot be read back, but access (agents and approvals) can still move`
          : `the store at ${sourceNetwork.storageUrl} is serving a different contract (${servedRegistry}) — your records cannot be read back, but access (agents and approvals) can still move`,
      )
      if (!(await confirm("move access only — records stay behind and are listed as skipped?"))) {
        return refuse("not moved — nothing was changed")
      }
      accessOnly = true
    }
  }

  // ── State and crash helpers ──────────────────────────────────────────────────
  const migratedAt = persisted?.migratedAt ?? now().toISOString()
  let state: MigrateState | undefined = persisted
  const saveState = (): void => {
    home.writeSecretJson("migrate/state.json", state)
  }
  const crashPoint = (step: MigrateStep): void => {
    if (deps.stopAfter === step) throw stoppedError(step)
  }
  // The test-only send crash: counts actual sends this run and throws immediately after the
  // configured one — before the verify read and before any status bookkeeping is persisted.
  const sends = { agent: 0, record: 0 }
  const sendCrash = (kind: "agent" | "record"): void => {
    sends[kind] += 1
    if (deps.throwAfterSend?.kind === kind && sends[kind] === deps.throwAfterSend.nth) {
      throw stoppedError(`${kind}-send`)
    }
  }
  const finishStep = (step: MigrateStep): void => {
    state!.step = step
    saveState()
    crashPoint(step)
  }
  const at = (step: MigrateStep): number => {
    const order: MigrateStep[] = [
      "preview", "paused", "backed-up", "manifest", "target-setup", "agents", "approvals", "records", "verified", "switched",
    ]
    return order.indexOf(step)
  }
  const reached = (step: MigrateStep): boolean => state !== undefined && at(state.step) >= at(step)

  // ── The staging home and its runtime, opened lazily and shared by the write steps ──
  const staging = (): MidaHome => resolveHome({ MIDA_HOME: home.path("migrate/target") })
  let stagingRuntime: Runtime | undefined
  const targetRuntime = async (): Promise<Runtime> => {
    if (stagingRuntime === undefined) {
      const stagingNetwork = await resolveNetwork(staging(), env, { loadBuiltIn: () => target })
      stagingRuntime = await Runtime.open(staging(), stagingNetwork.network)
      stagingRuntime.progress = deps.progress
    }
    return stagingRuntime
  }
  const targetReader = async (): Promise<RegistryReader> => (await targetRuntime()).reader

  // The source universe is re-read only when a record still needs preparing — ciphertext and ids
  // are what state.json persists; plaintext lives in memory for the length of one seal.
  let sourceRecords: Map<string, SourceRecord> | undefined
  const sourceRecord = async (sourceId: Hex): Promise<SourceRecord> => {
    if (sourceRecords === undefined) {
      const runtime = await Runtime.open(home, sourceNetwork)
      runtime.progress = deps.progress
      try {
        sourceRecords = new Map(
          (await readOwnerUniverse(runtime, { onProgress: scanReport("records", deps.progress) })).map((record) => [record.contextId.toLowerCase(), record]),
        )
      } finally {
        await runtime.close()
      }
    }
    const record = sourceRecords.get(sourceId.toLowerCase())
    if (record === undefined) throw new Error(`manifest entry ${sourceId} is not in the source universe`)
    return record
  }

  try {
    // ── Rule 1: preview ────────────────────────────────────────────────────────
    if (!reached("preview")) {
      let manifest: Manifest
      let hmacKey: string
      if (accessOnly) {
        // The store cannot serve the records — enumerate the chain logs so every record is still
        // listed, as skipped:store-unreadable. Fingerprints need plaintext, so they stay zero.
        hmacKey = hexOf(randomBytes(32))
        manifest = await storeUnreadableManifest(home, sourceNetwork, source, target, scanReport("records", deps.progress))
      } else {
        const runtime = await Runtime.open(home, sourceNetwork)
        runtime.progress = deps.progress
        try {
          let records: SourceRecord[]
          try {
            records = await readOwnerUniverse(runtime, { onProgress: scanReport("records", deps.progress) })
          } catch (error) {
            if ((error as { code?: unknown }).code === "owner-read-incomplete") {
              return refuse((error as Error).message)
            }
            throw error
          }
          const key = randomBytes(32)
          manifest = buildManifest(records, authorNamesFor(runtime), source, target, key, migratedAt)
          hmacKey = hexOf(key)
          const rows = preflight(manifest)
          if (rows.length > 0) {
            for (const row of rows) say(`${row.sourceId} ${row.namespace} ${row.bytes}/${row.limit} bytes`)
            return refuse(`${rows.length} record(s) exceed their destination limit — migration refused before any change`)
          }
          // A dependency cycle cannot be replayed — refuse at the preview, not mid-write.
          try {
            replayOrder(manifest)
          } catch (error) {
            return refuse((error as Error).message)
          }
          for (const line of await previewLines(home, runtime, source, target, manifest)) say(line)
        } finally {
          await runtime.close()
        }
      }
      if (!(await confirm("move this setup to the new contract?"))) {
        return refuse("not moved — nothing was changed")
      }
      state = {
        version: 1,
        step: "preview",
        target: serializeDeployment(target),
        migratedAt,
        hmacKey,
        manifest,
      }
      saveState()
      crashPoint("preview")
    }
    const manifest = state!.manifest

    // ── Rule 2: paused ─────────────────────────────────────────────────────────
    if (!reached("paused")) {
      home.writeSecretJson("migrate/in-progress", { at: migratedAt, target: target.contextRegistry })
      const health = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
      if (health.status !== 0) {
        const pid = (health.body as { pid?: unknown } | null)?.pid
        await callDaemon(home, "/shutdown", {}, { timeoutMs: 2_000 })
        const deadline = Date.now() + 10_000
        let down = false
        while (Date.now() < deadline) {
          const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
          if (reply.status === 0) {
            down = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!down) {
          home.remove("migrate/in-progress")
          return refuse(`the Mida service (pid ${typeof pid === "number" ? pid : "?"}) did not stop within 10 s`)
        }
        say("stopped the Mida service")
      }
      finishStep("paused")
    } else if (!home.has("migrate/in-progress")) {
      // A resumed run re-writes its marker: --undo removes it while rewinding the state, so a
      // migration in flight again must carry it before it touches anything.
      home.writeSecretJson("migrate/in-progress", { at: migratedAt, target: target.contextRegistry })
    }

    // ── Rule 3: backed-up ──────────────────────────────────────────────────────
    if (!reached("backed-up")) {
      const backup = `migrate/backup-${migratedAt}`
      for (const item of ["network.json", "agents", "approved-projects.json", "state", "data"]) {
        if (home.has(item)) copyInto(home, item, `${backup}/${item}`)
      }
      finishStep("backed-up")
      say(`backed up to ${backup}`)
    }

    // ── Rule 4: manifest — already persisted with the state file; the step is the marker ──
    if (!reached("manifest")) finishStep("manifest")

    // ── Rule 5: target-setup — staging home, owner key, every manifest namespace ──
    if (!reached("target-setup")) {
      const stagingHome = staging()
      for (const item of ["owner", "owner-address.json", "operator"]) {
        if (home.has(item)) copyInto(home, item, `migrate/target/${item}`)
      }
      const saved = home.readJson<{ rpcUrl?: string; storageUrl?: string; sponsorUrl?: string }>("network.json")!
      stagingHome.writeSecretJson("network.json", {
        chainId: Number(target.chainId),
        rpcUrl: saved.rpcUrl,
        deployment: serializeDeployment(target),
        ...(saved.storageUrl === undefined ? {} : { storageUrl: saved.storageUrl }),
        ...(saved.sponsorUrl === undefined ? {} : { sponsorUrl: saved.sponsorUrl }),
      })
      const runtime = await targetRuntime()
      const sponsorUrl = parseSponsorUrl(runtime.network.sponsorUrl)
      const sponsorUp = sponsorUrl !== undefined && (await sponsorReachable(sponsorUrl))
      if (!sponsorUp) await runtime.ensureFunded(runtime.owner, "your wallet")
      const ownerKey = await runtime.reader.ownerP256Key(runtime.owner)
      if (ownerKey === null || ownerKey.qx === 0n) await runtime.vault.registerOwnerKey()
      const namespaces = new Set<string>([NAMESPACE, ...FACT_NAMESPACES])
      for (const entry of manifest.entries) {
        if (!entry.status.startsWith("skipped:")) namespaces.add(entry.namespace)
      }
      for (const namespace of namespaces) {
        if ((await runtime.reader.epochPublicKey(runtime.owner, namespaceId(namespace), 1n)) === null) {
          await runtime.vault.initializeNamespace(namespace)
        }
      }
      finishStep("target-setup")
      say(`staging home ready at migrate/target (${namespaces.size} areas on ${short(target.contextRegistry)})`)
    }

    // ── Rule 6: agents — prepare salt + encryption pair, reuse the signer, register once ──
    if (!reached("agents")) {
      const runtime = await targetRuntime()
      const operatorAccount = privateKeyToAccount(loadOrCreateOperatorSecrets(staging()).privateKey)
      const operator = createWriteContext({ rpcUrl: runtime.network.rpcUrl, deployment: target, account: operatorAccount })
      const sponsorUrl = parseSponsorUrl(runtime.network.sponsorUrl)
      if (sponsorUrl !== undefined) {
        operator.sponsor = createSponsoredSender({
          sponsorUrl,
          rpcUrl: runtime.network.rpcUrl,
          account: operatorAccount,
          deployment: target,
        })
      }
      operator.beforeSend = makeOwnerBalanceGuard({
        chain: operator,
        fund: runtime.network.fund ?? ((address) => runtime.topUpFromOwner(address)),
      })
      const sponsorUp = sponsorUrl !== undefined && (await sponsorReachable(sponsorUrl))
      if (!sponsorUp) await runtime.ensureFunded(operatorAccount.address, "the operator wallet")

      for (const name of Object.keys(manifest.agentMap).sort()) {
        const map = manifest.agentMap[name]!
        const sourceIdentity = loadAgentIdentity(home, name)
        if (sourceIdentity === undefined) throw new Error(`agent ${name} is in the manifest but has no identity on disk`)
        if (map.newAgentId === undefined) {
          // PREPARE — everything the registration will need is on disk before the send.
          const signerPrivateKey = loadOrCreateSignerKey(home, name)
          const encryption = generateX25519KeyPair()
          const agentSalt = hexOf(randomBytes(32))
          const newAgentId = predictAgentId({ deployment: target, operator: operatorAccount.address, agentSalt })
          const issuedAt = Number(await latestTimestamp(operator)) - 60
          const body = { ...sourceIdentity.manifest.manifest, agentId: newAgentId, issuedAt }
          const manifestHash = manifestBodyHash(body)
          const operatorSignature = await operatorAccount.signTypedData(
            manifestBindingFor({ chainId: target.chainId, capabilityRegistry: target.capabilityRegistry, body }) as never,
          )
          const stagingHome = staging()
          stagingHome.writeSecretJson(`agents/${name}/signer.json`, { signerPrivateKey })
          const identity: AgentIdentity = {
            name,
            agentId: newAgentId,
            signerPrivateKey,
            encryptionPrivateKey: hexOf(encryption.privateKey),
            encryptionPublicKey: hexOf(encryption.publicKey),
            callbackOrigin: sourceIdentity.callbackOrigin,
            purposeId: sourceIdentity.purposeId,
            manifest: { manifest: body, operatorSignature },
            manifestHash,
          }
          saveAgentIdentity(stagingHome, identity)
          map.newAgentId = newAgentId.toLowerCase() as Hex
          map.preparedSalt = agentSalt
          saveState()
          crashPoint("agents")
        }
        // COMMIT — skipped entirely when the deterministic id is already on the target.
        const identity = loadAgentIdentity(staging(), name)!
        const registered = await runtime.reader.getAgent(map.newAgentId!)
        if (registered === null) {
          const sent = await registerAgent(operator, {
            agentSalt: map.preparedSalt!,
            signer: privateKeyToAccount(identity.signerPrivateKey),
            encryptionPublicKey: identity.encryptionPublicKey,
            callbackOrigin: identity.callbackOrigin,
            capabilityManifestHash: identity.manifestHash,
          })
          if (sent.agentId.toLowerCase() !== map.newAgentId!.toLowerCase()) {
            throw new Error(`agent ${name}: the target registered ${sent.agentId}, not the prepared ${map.newAgentId}`)
          }
          sendCrash("agent")
        }
        // VERIFY — the chain says who landed; a mismatch is a loud stop, not a skip.
        const record = await runtime.reader.getAgent(map.newAgentId!)
        if (record === null) throw new Error(`agent ${name}: registration did not land on the target`)
        await runtime.ownerApi.putAgentManifest(identity.manifest)
        if (!sponsorUp) {
          await runtime.ensureFunded(privateKeyToAccount(identity.signerPrivateKey).address, `${name}'s wallet`)
        }
        runtime.attach(identity)
        saveState()
      }
      finishStep("agents")
      say(`registered ${Object.keys(manifest.agentMap).length} agent(s) on the target`)
    }

    // ── Rule 7: approvals — the live scopes the source shows, or a replay grant for a revoked agent ──
    const sourceReader = new RegistryReader({
      publicClient: createPublicClient({ chain: chainFor(source.chainId), transport: http(sourceNetwork.rpcUrl) }),
      deployment: source,
    })
    const sourceRevoked = new Set<string>()
    if (!reached("approvals")) {
      const runtime = await targetRuntime()
      const byId = new Map(manifest.entries.map((entry) => [entry.sourceId.toLowerCase(), entry]))
      for (const name of Object.keys(manifest.agentMap).sort()) {
        const map = manifest.agentMap[name]!
        const live = await liveSourceScopes(sourceReader, runtime.owner, map.oldAgentId)
        const authored = manifest.entries.filter(
          (entry) => entry.authorName === name && !entry.status.startsWith("skipped:"),
        )
        let scopes: { namespaceId: Hex; permissions: number; provenancePolicy: number }[]
        let capabilityExpiresAt: bigint
        // A revoked marker — or no live capability on the source — means the replay-grant path:
        // grant exactly what its records need, copy them, then rule 8b revokes it again. A revoked
        // agent is never recreated with its old authority, even if a revoke left caps lingering.
        const revoked = isRevoked(home, name) || live.length === 0
        if (!revoked) {
          const merged = new Map<string, { namespaceId: Hex; permissions: number; provenancePolicy: number }>()
          for (const capability of live) {
            const key = `${capability.namespaceId}:${capability.permissions}:${capability.provenancePolicy}`
            if (!merged.has(key)) merged.set(key, capability)
          }
          scopes = [...merged.values()]
          capabilityExpiresAt = live.some((capability) => capability.expiresAt === 0n)
            ? 0n
            : live.reduce((max, capability) => (capability.expiresAt > max ? capability.expiresAt : max), 0n)
        } else {
          // Revoked on the source (Sep-23 amendment): grant exactly the write scopes its records
          // need — CREATE on the touched namespaces, SUPERSEDE_OWN/ANY where it supersedes — then
          // rule 8b revokes it again on the target.
          if (authored.length > 0) sourceRevoked.add(name)
          scopes = replayScopesFor(authored, byId, name)
          // The replay grant is temporary by design: an hour covers the migration, satisfies the
          // HIGH-sensitivity rule that forbids open-ended grants, and rule 8b revokes it anyway.
          capabilityExpiresAt = (await latestTimestamp(runtime.chain)) + 3_600n
        }
        if (scopes.length > 0) {
          // What the target already covers is not asked for again — approve's ungrantedScopes does
          // the same check, so a re-run after a partial grant sends only the difference.
          const missing = []
          for (const scope of scopes) {
            if (!(await runtime.reader.hasAuthority(runtime.owner, map.newAgentId!, scope.namespaceId, scope.permissions, scope.provenancePolicy))) {
              missing.push(scope)
            }
          }
          if (missing.length === 0) {
            staging().remove(`agents/${name}/pending-request.json`)
          } else {
            const stagingHome = staging()
            if (!stagingHome.has(`agents/${name}/pending-request.json`)) {
              // PREPARE — the signed request is on disk before the grant send.
              const request = await runtime.agent(name).createAccessRequest({
                purposeId: loadAgentIdentity(stagingHome, name)!.purposeId,
                scopes: scopes.map((scope) => ({
                  namespace: namespaceById(scope.namespaceId).name,
                  permissions: scope.permissions,
                  provenancePolicy: scope.provenancePolicy,
                })),
                capabilityExpiresAt,
              })
              stagingHome.writeSecretJson(`agents/${name}/pending-request.json`, { request })
              saveState()
              crashPoint("approvals")
            }
            try {
              await approve(runtime, name, undefined, async (preview: ApprovePreview) =>
                confirm(
                  preview.kind === "grant"
                    ? `grant ${preview.agent} ${preview.scopes.length} scope(s) on the new contract`
                    : `approve ${preview.agent} for ${preview.projectId} on the new contract`,
                ),
              )
            } catch (error) {
              // A crash between completeAccessRequest and the pending file's removal replays as
              // "no-pending-request" — the grant already landed, so this resume is done, not refused.
              const stillMissing = []
              for (const scope of scopes) {
                if (!(await runtime.reader.hasAuthority(runtime.owner, map.newAgentId!, scope.namespaceId, scope.permissions, scope.provenancePolicy))) {
                  stillMissing.push(scope)
                }
              }
              const code = (error as { code?: unknown }).code
              if ((code !== "no-pending-request" && code !== "already-approved") || stillMissing.length > 0) throw error
              stagingHome.remove(`agents/${name}/pending-request.json`)
            }
          }
        }

        // Task 6: a live agent may own records in an area it can no longer write — its replay
        // needs a scope the source no longer grants. That goes out as a second, one-hour request
        // (the HIGH-sensitivity rule forbids open-ended grants), and the verified step revokes
        // exactly those capabilities by id — never the whole agent.
        if (!revoked) {
          const stagingHome = staging()
          const replayNeeded = replayScopesFor(authored, byId, name)
          for (let attempt = 0; attempt < 4 && replayNeeded.length > 0; attempt += 1) {
            const missing = []
            for (const scope of replayNeeded) {
              if (!(await runtime.reader.hasAuthority(runtime.owner, map.newAgentId!, scope.namespaceId, scope.permissions, scope.provenancePolicy))) {
                missing.push(scope)
              }
            }
            if (missing.length === 0) break
            if (!stagingHome.has(`agents/${name}/pending-request.json`)) {
              // PREPARE — same crash rule as every write: the signed request is on disk first.
              const request = await runtime.agent(name).createAccessRequest({
                purposeId: loadAgentIdentity(stagingHome, name)!.purposeId,
                scopes: missing.map((scope) => ({
                  namespace: namespaceById(scope.namespaceId).name,
                  permissions: scope.permissions,
                  provenancePolicy: scope.provenancePolicy,
                })),
                capabilityExpiresAt: (await latestTimestamp(runtime.chain)) + 3_600n,
              })
              stagingHome.writeSecretJson(`agents/${name}/pending-request.json`, { request })
              saveState()
              crashPoint("approvals")
            }
            try {
              await approve(runtime, name, undefined, async () =>
                confirm(`grant ${name} a temporary write scope on the new contract — only to copy its old record(s)`),
              )
            } catch (error) {
              const code = (error as { code?: unknown }).code
              if (code !== "no-pending-request" && code !== "already-approved") throw error
              stagingHome.remove(`agents/${name}/pending-request.json`)
            }
          }
          for (const scope of replayNeeded) {
            if (!(await runtime.reader.hasAuthority(runtime.owner, map.newAgentId!, scope.namespaceId, scope.permissions, scope.provenancePolicy))) {
              throw new Error(`agent ${name}: a temporary replay scope for ${scope.namespaceId} did not land on the target`)
            }
          }
        }
        saveState()
      }
      finishStep("approvals")
      say(`approvals moved for ${Object.keys(manifest.agentMap).length} agent(s)`)
    } else {
      // A resume past approvals still needs the revoked set for rule 8b — recompute it.
      const owner = (await targetRuntime()).owner
      for (const name of Object.keys(manifest.agentMap)) {
        const map = manifest.agentMap[name]!
        const live = await liveSourceScopes(sourceReader, owner, map.oldAgentId)
        const authored = manifest.entries.some((entry) => entry.authorName === name && !entry.status.startsWith("skipped:"))
        if ((isRevoked(home, name) || live.length === 0) && authored) sourceRevoked.add(name)
      }
    }

    // ── Rule 8: records — replayOrder, persisted sealed bytes, verify after each ──
    const stagingHome = staging()
    const runtime = await targetRuntime()
    // Rebuild each agent from its staging identity NOW that grants exist: MidaAgent caches the
    // grants it was attached with, so an agent attached before rule 7 would still look unauthorized.
    for (const name of Object.keys(manifest.agentMap)) {
      const identity = loadAgentIdentity(stagingHome, name)
      if (identity !== undefined) runtime.attach(identity)
    }
    const byId = new Map(manifest.entries.map((entry) => [entry.sourceId.toLowerCase(), entry]))
    // The same sponsor probe the earlier steps run, computed once before the loop: a reachable
    // sponsor pays for every send below, and only a self-paid run tops wallets up. Agent write
    // contexts carry no `beforeSend` balance guard — the agents step funds each wallet once, so a
    // multi-record replay drains it and a resume that skips that step dies on the empty wallet.
    const sponsorUrl = parseSponsorUrl(runtime.network.sponsorUrl)
    const sponsorUp = sponsorUrl !== undefined && (await sponsorReachable(sponsorUrl))
    for (const entry of replayOrder(manifest)) {
      if (entry.status.startsWith("skipped:") || entry.status === "sent" || entry.status === "verified") continue
      const sealedPath = `migrate/sealed/${entry.sourceId}.json`
      if (entry.preparedNonce === undefined || !home.has(sealedPath)) {
        // PREPARE — rewrite references to target ids, attach the true-origin envelope, seal once.
        const record = await sourceRecord(entry.sourceId)
        const references = record.payload.provenance.references?.map((reference) => ({
          ...reference,
          recordId: byId.get(reference.recordId.toLowerCase())?.targetId ?? reference.recordId,
        }))
        const base: ContextPayload =
          references === undefined
            ? record.payload
            : { ...record.payload, provenance: { ...record.payload.provenance, references } }
        const envelope: MigrationEnvelope = {
          version: 1,
          originalChainId: entry.origin.chainId,
          originalContract: entry.origin.contract,
          originalRecordId: entry.origin.recordId,
          originalCommitment: entry.origin.commitment,
          originalAuthor: entry.origin.author,
          originalCreatedAt: entry.origin.createdAt,
          migratedAt,
        }
        const payload = attachEnvelope(base, envelope)
        const nonce = entry.preparedNonce ?? hexOf(randomBytes(32))
        const expectedParentId =
          entry.parentId.toLowerCase() === zeroHash
            ? zeroHash
            : (byId.get(entry.parentId.toLowerCase())?.targetId ?? entry.parentId)
        const sealed =
          entry.authorName === "owner"
            ? await runtime.vault.sealOwnerContext({
                namespace: entry.namespace,
                payload,
                lineagePolicy: nameOf(LINEAGE_POLICY, entry.lineagePolicy),
                expectedParentId,
                evidenceCommitment:
                  references === undefined || references.length === 0 ? zeroHash : evidenceCommitment(references),
                expiresAt: decodeUint64(entry.expiresAt),
                objectNonce: nonce,
                recordType: nameOf(RECORD_TYPE, entry.recordType) as RecordType,
              })
            : await runtime.agent(entry.authorName!).sealReplay(runtime.owner, {
                namespaceId: namespaceId(entry.namespace),
                payload,
                recordType: nameOf(RECORD_TYPE, entry.recordType) as "CONTEXT" | "EVIDENCE",
                kind: nameOf(CONTEXT_KIND, entry.kind),
                lineagePolicy: nameOf(LINEAGE_POLICY, entry.lineagePolicy),
                expiresAt: decodeUint64(entry.expiresAt),
                expectedParentId,
                objectNonce: nonce,
              })
        home.writeSecretJson(sealedPath, sealToStored(sealed))
        entry.preparedNonce = nonce
        entry.targetId = sealed.contextId.toLowerCase() as Hex
        saveState()
        crashPoint("records")
      }
      // COMMIT — the persisted bytes, never a re-seal; sendSealed treats an identical anchored
      // record as done, so a crash between register and the status write below sends nothing.
      const sealed = storedToSeal(home.readJson<StoredSealed>(sealedPath)!)
      if (entry.authorName === "owner") {
        await runtime.vault.sendOwnerSealed(sealed as OwnerSealedRecord)
      } else {
        const name = entry.authorName!
        // Before EVERY send, not once per agent: ensureFunded only acts below MIN_BALANCE_WEI,
        // so this costs one balance read per record and covers the wallet the agents step's
        // single top-up (or a resume past it) left dry.
        if (!sponsorUp) {
          const identity = loadAgentIdentity(stagingHome, name)
          if (identity !== undefined) {
            await runtime.ensureFunded(
              privateKeyToAccount(identity.signerPrivateKey).address,
              `${name}'s wallet`,
            )
          }
        }
        await runtime.agent(name).sendSealed(runtime.owner, sealed)
      }
      sendCrash("record")
      // VERIFY — the record the chain holds is the one the nonce predicted.
      const anchored = await runtime.reader.getRecord(entry.targetId!)
      if (anchored === null || anchored.manifestHash !== sealed.manifestHash) {
        throw new Error(`record ${entry.sourceId}: sent but not anchored on the target as ${entry.targetId}`)
      }
      entry.status = "sent"
      saveState()
    }

    // ── Rule 8b: a source-revoked agent is re-revoked on the target — never left live ──
    const reRevoke = new Set(sourceRevoked)
    for (const name of Object.keys(manifest.agentMap)) {
      if (isRevoked(home, name)) reRevoke.add(name)
    }
    for (const name of reRevoke) {
      const newAgentId = manifest.agentMap[name]?.newAgentId
      if (newAgentId === undefined) continue
      let anyLive = false
      for (const capabilityId of await runtime.reader.activeCapabilityIds(runtime.owner, newAgentId)) {
        if (await isCapabilityLive(runtime.chain, capabilityId)) anyLive = true
      }
      if (anyLive) {
        await runtime.vault.approveRevocation({ kind: "agent", agentId: newAgentId, name })
      }
      if (stagingHome.has(`agents/${name}`)) markRevoked(stagingHome, name)
    }

    finishStep("records")
    const moved = manifest.entries.filter((entry) => !entry.status.startsWith("skipped:"))
    const skippedCount = manifest.entries.length - moved.length
    say(`replayed ${moved.length} record(s) on ${short(target.contextRegistry)}${skippedCount === 0 ? "" : ` (${skippedCount} skipped)`}`)

    // ── Rule 9: verified — every record, every envelope field, every agent's scopes. A verdict,
    //    not a one-shot: it re-runs on every resume until the switch lands, so an --undo that
    //    rewound the switch is followed by a fresh verification, never a remembered one ──
    if (!reached("switched")) {
      // Sep-23 (b): replay-only scopes granted to LIVE agents come off first, by capability id —
      // never the whole agent. A live target capability is "extra" exactly when its tuple is one
      // the replay needed and NOT one the source holds live.
      for (const name of Object.keys(manifest.agentMap).sort()) {
        const map = manifest.agentMap[name]!
        if (map.newAgentId === undefined) continue
        const live = await liveSourceScopes(sourceReader, runtime.owner, map.oldAgentId)
        if (isRevoked(home, name) || live.length === 0) continue // rule 8b already agent-revoked it
        const authored = manifest.entries.filter(
          (entry) => entry.authorName === name && !entry.status.startsWith("skipped:"),
        )
        const needed = replayScopesFor(authored, byId, name)
        if (needed.length === 0) continue
        const neededTuples = new Set(needed.map(scopeTuple))
        const liveTuples = new Set(live.map(scopeTuple))
        const dropped = new Set<string>()
        for (const capabilityId of await runtime.reader.activeCapabilityIds(runtime.owner, map.newAgentId)) {
          const capability = await runtime.reader.getCapability(capabilityId)
          if (capability === null || !(await isCapabilityLive(runtime.chain, capabilityId))) continue
          const tuple = scopeTuple(capability)
          if (neededTuples.has(tuple) && !liveTuples.has(tuple)) {
            await runtime.vault.approveRevocation({ kind: "capability", capabilityId, name })
            dropped.add(capabilityId.toLowerCase())
          }
        }
        // The revoked ids leave the saved grant list too — a switched agent must not offer the
        // store a capabilityId the chain no longer honours.
        if (dropped.size > 0 && stagingHome.has(`agents/${name}/grants.json`)) {
          saveGrants(
            stagingHome,
            name,
            loadGrants(stagingHome, name)
              .map((grant) => ({
                ...grant,
                capabilities: grant.capabilities.filter((cap) => !dropped.has(cap.capabilityId.toLowerCase())),
              }))
              .filter((grant) => grant.capabilities.length > 0),
          )
        }
      }

      // The verdict block: every failure is its own line — "<sourceId> <field>" — never a count.
      const failures: string[] = []
      const targetIds = new Set(
        moved.map((entry) => entry.targetId?.toLowerCase()).filter((id): id is string => id !== undefined),
      )
      const byTargetId = new Map(moved.map((entry) => [entry.targetId?.toLowerCase(), entry.sourceId] as const))
      const sourceIdOf = (recordId: Hex): Hex => byTargetId.get(recordId.toLowerCase()) ?? recordId

      // Extras: every record the owner has on the target must be some entry's targetId — a count
      // that matches while an intruder stands in for a missing record still fails, named both ways.
      const targetLogs = await getLogsChunked(runtime.ownerChain.publicClient, {
        address: target.contextRegistry,
        event: CONTEXT_REGISTERED,
        args: { owner: runtime.owner },
        fromBlock: target.deploymentBlock,
      }, { maxRange: runtime.network.logBlockRange, onProgress: scanReport("records", deps.progress) })
      for (const log of targetLogs) {
        const id = (log.args as { contextId: Hex }).contextId.toLowerCase()
        if (!targetIds.has(id)) failures.push(`extra record ${id}`)
      }

      const hmacKeyBytes = state!.hmacKey === undefined ? undefined : bytesOf(state!.hmacKey, 32)
      const objectsByNamespace = new Map<string, { objects: Map<string, AnchoredObject>; partial: boolean }>()
      const objectsFor = async (nsId: Hex): Promise<{ objects: Map<string, AnchoredObject>; partial: boolean }> => {
        let bucket = objectsByNamespace.get(nsId)
        if (bucket === undefined) {
          bucket = { objects: new Map(), partial: true }
          try {
            const listed = await runtime.ownerApi.listObjects({ owner: runtime.owner, namespaceId: nsId })
            for (const object of listed.objects) bucket.objects.set(object.contextId.toLowerCase(), object)
            bucket.partial = listed.partial
          } catch {
            // an unservable list is partial by definition — every record in it is reported below
          }
          objectsByNamespace.set(nsId, bucket)
        }
        return bucket
      }

      // The origin contract an envelope names may be NEITHER deployment — a second move reads the
      // contract the FIRST move happened on.
      const extraReaders = new Map<string, RegistryReader>()
      const readerForContract = (contract: string): RegistryReader => {
        const key = contract.toLowerCase()
        if (key === target.contextRegistry.toLowerCase()) return runtime.reader
        if (key === source.contextRegistry.toLowerCase()) return sourceReader
        let reader = extraReaders.get(key)
        if (reader === undefined) {
          // The address the envelope wrote keeps its letter case — lowercase it for the client,
          // which checksums mixed-case input and would refuse to call the contract at all.
          reader = new RegistryReader({
            publicClient: runtime.ownerChain.publicClient,
            deployment: { ...target, contextRegistry: contract.toLowerCase() as Address },
          })
          extraReaders.set(key, reader)
        }
        return reader
      }

      for (const entry of manifest.entries) {
        if (entry.status.startsWith("skipped:")) continue
        const sid = entry.sourceId
        const fail = (field: string): void => {
          failures.push(`${sid} ${field}`)
        }
        const record = entry.targetId === undefined ? null : await runtime.reader.getRecord(entry.targetId)
        if (record === null) {
          fail("missing on the target")
          continue
        }
        if (record.owner !== runtime.owner) fail("owner")
        const expectedAuthor =
          entry.authorName === "owner"
            ? zeroHash
            : (manifest.agentMap[entry.authorName ?? ""]?.newAgentId ?? entry.authorId)
        if (record.author.toLowerCase() !== expectedAuthor.toLowerCase()) fail("author")
        if (record.namespaceId.toLowerCase() !== namespaceId(entry.namespace).toLowerCase()) fail("namespaceId")
        if (record.version !== entry.version) fail("version")
        if (record.recordType !== entry.recordType) fail("recordType")
        if (record.kind !== entry.kind) fail("kind")
        if (record.lineagePolicy !== entry.lineagePolicy) fail("lineagePolicy")
        if (record.provenanceSource !== entry.provenanceSource) fail("provenanceSource")
        if (record.expiresAt !== decodeUint64(entry.expiresAt)) fail("expiresAt")
        const expectedParent =
          entry.parentId.toLowerCase() === zeroHash
            ? zeroHash
            : (byId.get(entry.parentId.toLowerCase())?.targetId ?? entry.parentId)
        if (record.parentId.toLowerCase() !== expectedParent.toLowerCase()) fail("parentId")
        const expectedLineage = byId.get(entry.lineageId.toLowerCase())?.targetId ?? entry.lineageId
        if (record.lineageId.toLowerCase() !== expectedLineage.toLowerCase()) fail("lineageId")
        const sealedPath = `migrate/sealed/${sid}.json`
        if (home.has(sealedPath)) {
          const stored = home.readJson<StoredSealed>(sealedPath)!
          if (record.manifestHash.toLowerCase() !== stored.manifestHash.toLowerCase()) fail("manifestHash")
        }

        // The stored object: decrypt as the owner, then the envelope and the fingerprint.
        let payload: ContextPayload | undefined
        const nsId = record.namespaceId.toLowerCase() as Hex
        const bucket = await objectsFor(nsId)
        if (bucket.partial) fail("the store's object list was partial")
        const object = bucket.objects.get(entry.targetId!.toLowerCase())
        if (object === undefined) {
          fail("object missing from the store")
        } else {
          try {
            const namespaceSecret = await runtime.vault.deriveNamespaceSecret(nsId)
            const epochKeys = deriveEpochKeyPair(namespaceSecret, record.readEpoch)
            payload = openContextObject({
              manifest: object.manifest,
              expectedManifestHash: record.manifestHash,
              ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
              epochPrivateKey: epochKeys.privateKey,
              binding: {
                chainId: target.chainId,
                contextRegistry: target.contextRegistry,
                contextId: entry.targetId!,
                namespaceId: nsId,
                readEpoch: record.readEpoch,
              },
            })
          } catch (error) {
            fail(`object could not be read back: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`)
          }
        }
        if (payload === undefined) continue

        // The envelope must equal the manifest's origin, field by field — every address and hash
        // compared case-insensitively, because an envelope copied from an earlier move keeps the
        // letter case that move wrote.
        let envelope: MigrationEnvelope | undefined
        let malformed = false
        try {
          envelope = readEnvelope(payload)
        } catch {
          malformed = true
        }
        if (malformed) {
          fail("envelope invalid")
        } else if (envelope === undefined) {
          fail("envelope missing")
        } else {
          if (envelope.originalChainId !== entry.origin.chainId) fail("envelope.originalChainId")
          if (envelope.originalContract.toLowerCase() !== entry.origin.contract.toLowerCase()) fail("envelope.originalContract")
          if (envelope.originalRecordId.toLowerCase() !== entry.origin.recordId.toLowerCase()) fail("envelope.originalRecordId")
          if (envelope.originalCommitment.toLowerCase() !== entry.origin.commitment.toLowerCase()) fail("envelope.originalCommitment")
          if (envelope.originalAuthor.toLowerCase() !== entry.origin.author.toLowerCase()) fail("envelope.originalAuthor")
          if (envelope.originalCreatedAt !== entry.origin.createdAt) fail("envelope.originalCreatedAt")
          if (envelope.migratedAt !== migratedAt) fail("envelope.migratedAt")
          const originRecord = await readerForContract(entry.origin.contract)
            .getRecord(entry.origin.recordId)
            .catch(() => null)
          if (originRecord === null || originRecord.manifestHash.toLowerCase() !== entry.origin.commitment.toLowerCase()) {
            fail("envelope.originalCommitment")
          }
        }

        // The payload itself: the manifest's HMAC fingerprint when the key still exists (every
        // normal run); after --undo stripped it, the same comparison against the freshly re-read
        // source record — identical canonical content fingerprints identically under any key.
        if (hmacKeyBytes !== undefined) {
          if (payloadFingerprint(payload, hmacKeyBytes, sourceIdOf) !== entry.fingerprint) fail("fingerprint")
        } else {
          const source = await sourceRecord(sid).catch(() => undefined)
          const key = new Uint8Array(32)
          if (source === undefined || payloadFingerprint(payload, key, sourceIdOf) !== payloadFingerprint(source.payload, key)) {
            fail("fingerprint")
          }
        }

        // References point at target ids — rewritten field by field, nothing else changed.
        const source = await sourceRecord(sid).catch(() => undefined)
        if (source !== undefined) {
          const expected = source.references.map((reference) => ({
            ...reference,
            recordId: byId.get(reference.recordId.toLowerCase())?.targetId ?? reference.recordId,
          }))
          if (!sameCanonical(payload.provenance.references ?? [], expected)) fail("references")
        }
      }

      // Agents: a source-revoked agent is dead on the target; a live agent's live scopes are
      // exactly the source's — nothing more, nothing less (the extras above are already gone).
      for (const name of Object.keys(manifest.agentMap).sort()) {
        const map = manifest.agentMap[name]!
        if (map.newAgentId === undefined) continue
        const live = await liveSourceScopes(sourceReader, runtime.owner, map.oldAgentId)
        const revokedOnSource = isRevoked(home, name) || live.length === 0
        const liveTuples = new Set(live.map(scopeTuple))
        const targetTuples = new Set<string>()
        for (const capabilityId of await runtime.reader.activeCapabilityIds(runtime.owner, map.newAgentId)) {
          const capability = await runtime.reader.getCapability(capabilityId)
          if (capability === null || !(await isCapabilityLive(runtime.chain, capabilityId))) continue
          targetTuples.add(scopeTuple(capability))
        }
        if (revokedOnSource) {
          if (targetTuples.size > 0) failures.push(`agent ${name}: still live on the target`)
          continue
        }
        for (const tuple of liveTuples) {
          if (!targetTuples.has(tuple)) failures.push(`agent ${name}: missing scope ${tuple} on the target`)
        }
        for (const tuple of targetTuples) {
          if (!liveTuples.has(tuple)) failures.push(`agent ${name}: extra scope ${tuple} on the target`)
        }
      }

      if (failures.length > 0) {
        for (const failure of failures) say(failure)
        return refuse(
          `verification failed — ${failures.length} problem(s) listed above; the setup is unchanged (run \`mida migrate\` again after fixing the target, or \`mida migrate --undo\` to go back)`,
        )
      }
      for (const entry of moved) entry.status = "verified"
      finishStep("verified")
      say(`verified ${moved.length} record(s) on ${short(target.contextRegistry)}`)
    }

    // ── Rule 10: switched — the only step that changes how the setup behaves ──
    if (!reached("switched")) {
      // The revoked set is read while the live home still shows the source's markers — the move
      // below replaces each agent directory wholesale and the cleanup deletes stale markers.
      const revokedNames = new Set(sourceRevoked)
      for (const name of Object.keys(manifest.agentMap)) {
        if (isRevoked(home, name)) revokedNames.add(name)
      }

      // The kept manifest: no HMAC key (it never had one — the key lived in state.json) and no
      // plaintext, just every entry's identity, fingerprint and origin.
      const manifestPath = `migrate/manifest-${migratedAt}.json`
      home.writeSecretJson(manifestPath, manifest)

      // The staging identities replace the local agents, then per-agent residue goes: stale
      // requests, stale revoke markers, the request store and the contract-bound save index.
      for (const name of stagingHome.list("agents")) {
        rmSync(home.path(`agents/${name}`), { recursive: true, force: true })
        copyInto(home, `migrate/target/agents/${name}`, `agents/${name}`)
        for (const residue of ["pending-request.json", "revoked.json", "revoke-pending.json", "requests"]) {
          rmSync(home.path(`agents/${name}/${residue}`), { recursive: true, force: true })
        }
      }
      rmSync(home.path("state/saved-ids.json"), { force: true })

      // The local store: the staging copy holds exactly the migrated objects — it replaces data/
      // wholesale, so no source-contract object can linger and confuse a later read.
      if (stagingHome.has("data")) {
        rmSync(home.path("data"), { recursive: true, force: true })
        copyInto(home, "migrate/target/data", "data")
      }

      // network.json keeps every key it had; the deployment moves to the target, the old one is
      // recorded under `previous`, and `manifest` names the kept manifest file. A crashed switch
      // that already wrote the file keeps the `previous` it recorded — the source, not the target.
      const savedNet = home.readJson<Record<string, unknown>>("network.json")!
      home.writeSecretJson("network.json", {
        ...savedNet,
        deployment: serializeDeployment(target),
        previous: savedNet.previous ?? { deployment: savedNet.deployment, migratedAt },
        manifest: manifestPath,
      })

      // The local marker now matches the chain: rule 8b revoked these agents on the target.
      for (const name of revokedNames) {
        if (home.has(`agents/${name}`)) markRevoked(home, name)
      }

      // The HMAC key leaves state.json (the in-memory delete only persists through finishStep's
      // save) and the marker goes — then the switch is recorded, and only then the staging home,
      // which held copies of owner and operator secrets, goes. A crash between those two points
      // resumes into the cleanup below with the secrets still gone by the time we return.
      delete state!.hmacKey
      home.remove("migrate/in-progress")
      await deps.startService?.()
      finishStep("switched")
      // The staging runtime's own close removes its lock file — it must run before the tree goes,
      // and the cached handle must clear so the `finally` close below is not a second removal.
      await stagingRuntime?.close()
      stagingRuntime = undefined
      rmSync(home.path("migrate/target"), { recursive: true, force: true })
      say(`moved ${moved.length} record${moved.length === 1 ? "" : "s"} to ${short(target.capabilityRegistry)}. Undo with \`mida migrate --undo\``)
    }
    // A resume past a crashed switch still finishes the staging cleanup.
    if (reached("switched") && home.has("migrate/target")) {
      rmSync(home.path("migrate/target"), { recursive: true, force: true })
    }

    return { outcome: "moved", lines }
  } finally {
    await stagingRuntime?.close()
  }
}

export interface MigrateUndoDeps {
  home: MidaHome
  env: Record<string, string | undefined>
  print: (line: string) => void
  now: () => Date
  /** starts the local service once the backup is back in place — the CLI injects the real spawn */
  startService?: () => unknown | Promise<unknown>
}

/**
 * `mida migrate --undo` (spec §5.4 step 7): restores the newest `migrate/backup-<ISO>` over the
 * live files. The old contract is never written to, so the restored setup simply works again.
 * Three extras keep it honest: the service is stopped first (the same dance the pause step
 * does), every source-revoked agent is revoked on the TARGET too — idempotent, by agent id —
 * and a finished migration's state rewinds to "verified" so a later `mida migrate` re-verifies
 * the target instead of pretending the switch still stands.
 */
export async function migrateUndo(deps: MigrateUndoDeps): Promise<{ outcome: "restored" | "refused"; lines: string[] }> {
  const { home, env } = deps
  const lines: string[] = []
  const say = (line: string): void => {
    lines.push(line)
    deps.print(line)
  }
  const refuse = (line: string): { outcome: "refused"; lines: string[] } => {
    say(line)
    return { outcome: "refused", lines }
  }

  const backups = home
    .list("migrate")
    .filter((name) => name.startsWith("backup-"))
    .sort()
  const newest = backups.at(-1)
  if (newest === undefined) {
    return refuse("there is no migration backup to restore — nothing was moved back")
  }
  const backup = `migrate/${newest}`

  // The service goes down first — marker or no marker, it must not keep serving while files move.
  const health = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
  if (health.status !== 0) {
    const pid = (health.body as { pid?: unknown } | null)?.pid
    await callDaemon(home, "/shutdown", {}, { timeoutMs: 2_000 })
    const deadline = Date.now() + 10_000
    let down = false
    while (Date.now() < deadline) {
      const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
      if (reply.status === 0) {
        down = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!down) {
      return refuse(`the Mida service (pid ${typeof pid === "number" ? pid : "?"}) did not stop within 10 s`)
    }
    say("stopped the Mida service")
  }

  // Sep-23: every source-revoked agent is revoked on the TARGET too — idempotent, by agent id.
  // "Source-revoked" is judged on the source chain (the old agent's live scopes), not the local
  // marker — an approve between the switch and this undo would have cleared the marker while the
  // source truth stayed revoked. It runs before the restore, while the state still names the
  // target and the backup still names the source.
  let state: MigrateState | undefined
  try {
    const read = home.readJson<MigrateState>("migrate/state.json")
    if (read?.version === 1 && read.manifest !== undefined) state = read
  } catch {
    state = undefined
  }
  if (state?.target !== undefined) {
    const target = parseDeployment(state.target)
    const resolved = await resolveNetwork(home, env, { loadBuiltIn: () => target })
    const runtime = await Runtime.open(home, { ...resolved.network, deployment: target })
    try {
      const sourceNet = home.readJson<{ rpcUrl?: unknown; deployment?: unknown }>(`${backup}/network.json`)
      const sourceReader =
        sourceNet?.deployment === undefined
          ? undefined
          : new RegistryReader({
              publicClient: createPublicClient({
                chain: chainFor(parseDeployment(sourceNet.deployment).chainId),
                transport: http(typeof sourceNet.rpcUrl === "string" ? sourceNet.rpcUrl : resolved.network.rpcUrl),
              }),
              deployment: parseDeployment(sourceNet.deployment),
            })
      for (const name of Object.keys(state.manifest.agentMap).sort()) {
        const map = state.manifest.agentMap[name]!
        if (map.newAgentId === undefined) continue
        const revokedOnSource =
          isRevoked(home, name) ||
          (sourceReader !== undefined && (await liveSourceScopes(sourceReader, runtime.owner, map.oldAgentId)).length === 0)
        if (!revokedOnSource) continue
        let anyLive = false
        for (const capabilityId of await runtime.reader.activeCapabilityIds(runtime.owner, map.newAgentId)) {
          if (await isCapabilityLive(runtime.chain, capabilityId)) anyLive = true
        }
        if (anyLive) {
          await runtime.vault.approveRevocation({ kind: "agent", agentId: map.newAgentId, name })
          say(`revoked ${name} on the new contract`)
        }
      }
    } finally {
      await runtime.close()
    }
  }

  // A switched migration's staging home was deleted at the switch — rebuild it from the live
  // (still switched) files before the restore overwrites them, so a later `mida migrate` can
  // re-verify the still-present target records and switch again. An undo taken mid-migration
  // finds the staging home still in place and leaves it alone.
  if (state?.step === "switched") {
    for (const item of ["network.json", "owner", "operator", "agents", "data", "state"]) {
      if (home.has(item)) copyInto(home, item, `migrate/target/${item}`)
    }
  }

  // Restore the backup over the live files: the live path is removed first, so files the backup
  // does not carry cannot linger from the migrated setup.
  for (const item of ["network.json", "agents", "approved-projects.json", "state", "data"]) {
    rmSync(home.path(item), { recursive: true, force: true })
    if (home.has(`${backup}/${item}`)) copyInto(home, `${backup}/${item}`, item)
  }

  // A finished migration rewinds to "verified" — a later `mida migrate` re-verifies the target
  // (the records are still there) instead of pretending the switch still stands.
  if (state?.step === "switched") {
    state.step = "verified"
    home.writeSecretJson("migrate/state.json", state)
  }
  home.remove("migrate/in-progress")
  await deps.startService?.()

  const restored = home.readJson<{ deployment?: { capabilityRegistry?: unknown } }>("network.json")
  const registry = typeof restored?.deployment?.capabilityRegistry === "string" ? restored.deployment.capabilityRegistry : "unknown"
  say(`restored ${backup} — this setup is on ${short(registry)} again`)
  return { outcome: "restored", lines }
}
