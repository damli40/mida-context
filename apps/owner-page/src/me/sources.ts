/**
 * /me Task 3 — the data gatherer behind the owner page.
 *
 * Two sources, kept honest about which spoke: the Envio index for the agent list (grants,
 * revocations, batch anchors, totals — there is no chain-scan fallback; the scan needed
 * ~39,000 requests against a public RPC that allows ~500 inside the page's deadline), and the
 * store's object/batched-save lists as the list of records. Verification is per lane: every
 * direct object is re-read on ContextRegistry (matching fields → "anchored", missing or
 * mismatched → "unverified"); every ANCHORED batched item re-derives its Merkle leaf — the save
 * signature recovers the signer, agentIdOfSigner names the agent — and the proof is checked
 * against the on-chain batch root. A batched contextId never reaches ContextRegistry.
 *
 * The chain port carries two reads beyond the plan's printed shape, both already consumed by
 * design: getAgent (the index's Agent row does not store capabilityManifestHash — agent names
 * live behind it) and agentIdOfSigner (BatchedReadItem carries no agentId, and the Merkle leaf
 * cannot be rebuilt without it). Nothing here throws out of loadMe — a failure degrades to
 * "unverified", a line in `incomplete`, or the shortened agent id, never a blank page.
 */

import { recoverTypedDataAddress, zeroHash } from "viem"
import {
  PERMISSION,
  PROVENANCE_POLICY,
  batchLeafHash,
  batchSaveStructHash,
  batchSaveTypedData,
  decodeUint64,
  namespaceById,
  namespaceId,
  verifyMerkleProof,
} from "@mida/protocol"
import type { Address, AgentRecord, BatchSaveMessage, Hex } from "@mida/protocol"
import { bytesOf, ciphertextHash, manifestHash } from "@mida/crypto"
import type { CapabilityView, ContextApiRoutes, ContextRecordView } from "@mida/api/browser"
import { DEPLOYMENT } from "../owner/core.js"
import { grantStatus, isTxHash, lagText } from "./model.js"
import type { AnchorState, Lane } from "./model.js"

// ---------------------------------------------------------------------------------------------
// GraphQL documents — exported so Task 5's index adapter reuses them verbatim.
// Hasura-style Envio queries: entity names as declared in apps/indexer/schema.graphql.

export const AGENTS_QUERY = `query MeAgents($owner: String!, $limit: Int!) {
  Grant(where: { owner: { _eq: $owner } }, limit: $limit) {
    id
    agent
    namespaceId
    permissions
    provenancePolicy
    expiresAt
    grantedBlock
    revokedBlock
    revokedBy
    txHash
  }
  Revocation(where: { owner: { _eq: $owner } }, limit: $limit) {
    id
    kind
    agentId
    namespaceId
    capabilityId
    block
    txHash
  }
  _meta {
    chainId
    progressBlock
    sourceBlock
    isReady
  }
}`

export const BATCHED_QUERY = `query MeBatched($owner: String!, $agents: [String!], $limit: Int!) {
  BatchedSave(where: { owner: { _eq: $owner } }, limit: $limit) {
    id
    namespaceId
    batchId
    position
    lineageId
    version
    agentId
    block
    txHash
  }
  Agent(where: { id: { _in: $agents } }, limit: $limit) {
    id
    signer
  }
}`

export const COUNTS_QUERY = `query MeCounts($owner: String!, $limit: Int!) {
  Owner_by_pk(id: $owner) {
    records
    batchedSaves
  }
  ContextRecord(where: { owner: { _eq: $owner } }, limit: $limit) {
    id
    namespaceId
    provenanceSource
    createdAt
    registeredBlock
    txHash
  }
  TimelineEntry(where: { owner: { _eq: $owner } }, limit: $limit) {
    kind
    contextId
    block
    logIndex
  }
}`

/** The exact banner a truncated store list earns — pinned by the plan. */
export const PARTIAL_LIST_TEXT = "list incomplete — the store ran out of chain reads; reload"
/**
 * The exact wording when the agent list cannot be read: no index configured, or the index
 * unreachable. The list comes only from the index — the old chain-log scan needed ~39,000
 * requests against a public RPC that allows ~500 inside the page's budget, so it could never
 * answer and no longer runs. Pinned verbatim by in-25 P-4.
 */
export const AGENT_LIST_NEEDS_INDEX =
  "Your agent list comes from the index, and the index is not reachable right now. The records below are still checked against Monad."
/**
 * The mid-sync case: the index answered but reports `isReady: false` — its Grant rows are a
 * partial scan, not a list.
 */
export const AGENT_LIST_SYNCING = "Agent list unavailable — the index is still catching up and the chain scan did not finish"
/** The banner when an index answer fills the query's page — more rows may exist unsent. */
export const INDEX_LIMIT_TEXT = "list may be incomplete — the index has more rows than the page asked for"
/** The exact agent-state wording for a store deny — pinned by the plan, rendered by the page. */
export const BLOCKED_AT_STORE_TEXT = "blocked at the store · revoke pending on Monad"

const INDEX_TIMEOUT_MS = 6_000
// The three owner areas flows.ts opens on setup — duplicated there and here on purpose: this
// module stays import-light, and the record lists need them even when every index call is down.
const OWNER_NAMESPACE_IDS = ["projects.current", "preferences.communication", "profile.skills"].map((name) =>
  namespaceId(name),
)

// ---------------------------------------------------------------------------------------------
// Ports and rows — the plan's Task 3 interface, plus the two chain reads named above.

export interface MePorts {
  index: { query<T>(gql: string, vars: Record<string, unknown>): Promise<T> } | null
  store: Pick<ContextApiRoutes, "listObjects" | "listBatchSaves" | "listRevocations" | "batchStatus" | "getAgentManifest">
  chain: {
    isCapabilityValid(capabilityId: Hex): Promise<boolean>
    getCapability(capabilityId: Hex): Promise<CapabilityView | null>
    getRecords(ids: Hex[]): Promise<(ContextRecordView | null)[]>
    batchRoot(batchId: Hex): Promise<Hex | null>
    /** The block a batch anchored in (`batchOf().blockNumber`) — null when no such batch exists. */
    batchBlock(batchId: Hex): Promise<bigint | null>
    /** Monad's timestamp for a block, in seconds — null when the block could not be read. */
    blockTime(block: bigint): Promise<number | null>
    agentIdOfSigner(signer: Address): Promise<Hex | null>
    getAgent(agentId: Hex): Promise<AgentRecord | null>
    /**
     * Monad's live write authority for one agent relationship — the same question the contract
     * asks at anchor time. The pending-row label runs it so a save whose author lost its grant
     * (a revoke that landed, or one still pending under an already-rotated epoch) reads "blocked",
     * never "waiting".
     */
    hasAuthority(owner: Address, agentId: Hex, namespaceId: Hex, permission: number, provenancePolicy: number): Promise<boolean>
    latestTimestamp(): Promise<number>
    /** eth_blockNumber — the lag owed to the owner is measured against this, not the index's say-so. */
    latestBlock(): Promise<bigint>
  }
}

export interface AgentRow {
  agentId: Hex
  name: string
  grants: {
    namespaceId: Hex
    area: string
    permissions: number
    capabilityId: Hex
    status: ReturnType<typeof grantStatus>
    approvedTx: Hex | null
  }[]
  revokedTx: Hex | null
  blockedAtStore: boolean
  readLive: boolean
  /**
   * At least one grant's chain check could not run — the agent is not known-live, but "not
   * verified" must still count in the headline rather than collapsing into "0 agents can read".
   */
  unverified: boolean
}

export interface RecordRow {
  contextId: Hex
  namespaceId: Hex
  area: string
  readEpoch: bigint
  lane: Lane
  state: AnchorState
  authorId: Hex
  authorName: string
  source: number | null
  tx: Hex | null
  batchId: Hex | null
  ciphertext: Hex
  manifest: unknown
  createdAt: number
  /**
   * Monad's placement of the record when it is known: `at` is the chain's own stamp in
   * milliseconds (the registry row's createdAt for a direct record, the anchor block's time for
   * a batched one); `block`/`index` are its position in the chain's order. Absent for records
   * the chain has not placed — pending saves and unverifiable rows — and `block`/`index` absent
   * when only the stamp was recoverable. Ordering runs on this field; the writer's or store's
   * own clock claims never do.
   */
  chain?: { at: number; block?: number; index?: number }
}

export interface MeData {
  owner: Address
  agents: AgentRow[]
  records: RecordRow[]
  incomplete: string[]
  /**
   * Null when the list is complete; otherwise the banner sentence itself — the flag carries
   * its own blame so the page never re-derives which source failed.
   */
  agentsUnavailable: string | null
  /**
   * True when every store listing call failed — then `records: []` is a dead lookup, not an
   * empty store, and the page must not read it as "the store holds no records".
   */
  recordsUnavailable: boolean
  /** Where the agent list came from: the index, or nothing — "unavailable" never claims a scan. */
  source: "index" | "unavailable"
  lag: { text: string; stale: boolean }
  batchingOn: boolean | null
  /**
   * False when any listBatchSaves call failed or came back partial — the pending figure is a
   * store fact, and an incomplete store list means it cannot be shown.
   */
  batchedListComplete: boolean
  counts: { records: number; youSaid: number; pending: number } | null
}

// ---------------------------------------------------------------------------------------------
// Index answer shapes — only the fields the queries ask for.

interface IndexGrant {
  id: string
  agent: string
  namespaceId: string
  permissions: number
  grantedBlock: number
  revokedBlock: number | null
  txHash: string
}

interface IndexRevocation {
  kind: string
  agentId: string
  capabilityId: string | null
  block: number
  txHash: string
}

interface IndexBatchedSave {
  id: string
  namespaceId: string
  batchId: string
  lineageId: string
  version: number
  agentId: string
  /** The block the batch anchored in — the batch's place in the chain's order. */
  block?: number
  /** The save's position inside its batch — its order within the anchor block. */
  position?: number
  txHash: string
}

interface IndexRecord {
  id: string
  namespaceId: string
  provenanceSource: number
  createdAt: string
  /** The block the record registered in — the index's report of the chain's placement. */
  registeredBlock?: number
  txHash: string
}

/** One timeline row — `context_registered` entries give a direct record its exact chain place. */
interface IndexPlacement {
  kind: string
  contextId: string | null
  block: number
  logIndex: number
}

/** Envio's `_meta` view — one row per indexed chain, the index's own progress report. */
interface IndexMeta {
  chainId: number | string
  progressBlock: number | string
  sourceBlock: number | string
  isReady?: boolean
}

interface AgentsAnswer {
  Grant?: IndexGrant[]
  Revocation?: IndexRevocation[]
  _meta?: IndexMeta[] | IndexMeta | null
}

interface BatchedAnswer {
  BatchedSave?: IndexBatchedSave[]
  Agent?: { id: string; signer: string }[]
}

interface CountsAnswer {
  Owner_by_pk?: { records: number; batchedSaves: number } | null
  ContextRecord?: IndexRecord[]
  TimelineEntry?: IndexPlacement[]
}

// Wire shapes lifted off the route types so this module never re-declares the API's wire format.
type StoreObject = Awaited<ReturnType<ContextApiRoutes["listObjects"]>>["objects"][number]
type StoreBatchedItem = Awaited<ReturnType<ContextApiRoutes["listBatchSaves"]>>["items"][number]

interface GrantSeed {
  agentId: Hex
  capabilityId: Hex
  namespaceId: Hex
  /** The index's claim — the chain's capability row, not this field, supplies what is shown. */
  permissions: number
  /** What the listing claimed — an index Grant row's revokedBlock. */
  sourceSaysLive: boolean
  approvedTx: Hex | null
}

const lower = (value: string) => value.toLowerCase()
const sameHex = (a: string, b: string) => lower(a) === lower(b)

function shortId(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

function areaName(id: unknown): string {
  if (typeof id !== "string") return "unknown area"
  try {
    return namespaceById(id as Hex).name
  } catch {
    return id
  }
}

const isString = (v: unknown): v is string => typeof v === "string"
const isNumber = (v: unknown): v is number => typeof v === "number"

/**
 * The primary index answer is trusted only after it proves its shape — a malformed Grant or
 * Revocation row means this index answer cannot be the source of truth for the agents list, so
 * the whole answer is discarded and the list reports unavailable. Half-parsed state must
 * never mix with a partial answer, so this check runs before any row is consumed.
 */
function isAgentsAnswer(value: unknown): value is AgentsAnswer {
  if (value === null || typeof value !== "object") return false
  const answer = value as AgentsAnswer
  for (const grant of answer.Grant ?? []) {
    if (
      !isString(grant.id) ||
      !isString(grant.agent) ||
      !isString(grant.namespaceId) ||
      !isNumber(grant.permissions) ||
      !isNumber(grant.grantedBlock) ||
      !(grant.revokedBlock === null || isNumber(grant.revokedBlock)) ||
      !isString(grant.txHash)
    ) {
      return false
    }
  }
  for (const revocation of answer.Revocation ?? []) {
    if (
      !isString(revocation.agentId) ||
      !isNumber(revocation.block) ||
      !isString(revocation.txHash) ||
      !(revocation.capabilityId === null || isString(revocation.capabilityId))
    ) {
      return false
    }
  }
  return true
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

function secondsOf(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/**
 * The `_meta` row for this deployment's chain: progressBlock is how far the index has read,
 * sourceBlock how far the chain has got — their difference IS the lag, measured in blocks. A
 * missing row or unreadable numbers mean the index answered but cannot say how fresh it is.
 */
function metaRowOf(
  meta: AgentsAnswer["_meta"],
): { progressBlock: number; blocksBehind: number; isReady: boolean } | null {
  const rows = Array.isArray(meta) ? meta : meta != null && typeof meta === "object" ? [meta] : []
  const chainId = Number(DEPLOYMENT.chainId)
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue
    if (Number(row.chainId) !== chainId) continue
    const progress = Number(row.progressBlock)
    const source = Number(row.sourceBlock)
    if (!Number.isFinite(progress) || !Number.isFinite(source)) return null
    return { progressBlock: progress, blocksBehind: source - progress, isReady: row.isReady !== false }
  }
  return null
}

function uint64Of(value: unknown): bigint {
  try {
    return decodeUint64(value as string)
  } catch {
    return 0n
  }
}

/**
 * One index call with a six-second ceiling. The fetch adapter passes AbortSignal.timeout(6000)
 * to fetch so the request itself aborts; this races the same deadline on the caller side, so a
 * hung query can never stall the page past six seconds either.
 */
function queryIndex<T>(index: NonNullable<MePorts["index"]>, gql: string, vars: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(INDEX_TIMEOUT_MS)
    const fail = () => reject(new Error("index query timed out"))
    signal.addEventListener("abort", fail, { once: true })
    index.query<T>(gql, vars).then(
      (value) => {
        signal.removeEventListener("abort", fail)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", fail)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * A store object counts as anchored only when the chain record for its contextId exists and
 * agrees on owner, namespace, author and both commitments — the manifest and ciphertext the
 * page later decrypts must be the bytes the record committed to.
 */
function directMatches(record: ContextRecordView, object: StoreObject, ownerKey: string): boolean {
  if (!sameHex(record.owner, ownerKey)) return false
  if (!sameHex(record.namespaceId, object.namespaceId)) return false
  if (!sameHex(record.author, object.authorId)) return false
  try {
    if (!sameHex(record.manifestHash, manifestHash(object.manifest))) return false
    const bytes = bytesOf(object.ciphertext, (object.ciphertext.length - 2) / 2)
    if (!sameHex(record.ciphertextCommitment, ciphertextHash(bytes))) return false
  } catch {
    return false
  }
  return true
}

/** The ciphertext and manifest must be the bytes the signed save committed to. */
function batchedCommitmentsMatch(item: StoreBatchedItem, message: BatchSaveMessage): boolean {
  try {
    const bytes = bytesOf(item.save.ciphertext, (item.save.ciphertext.length - 2) / 2)
    if (!sameHex(ciphertextHash(bytes), message.ciphertextCommitment)) return false
    return sameHex(manifestHash(item.save.manifest), message.manifestHash)
  } catch {
    return false
  }
}

function wireMessageOf(item: StoreBatchedItem): BatchSaveMessage | null {
  try {
    return {
      ...item.save.message,
      readEpoch: decodeUint64(item.save.message.readEpoch),
      expiresAt: decodeUint64(item.save.message.expiresAt),
    }
  } catch {
    return null
  }
}

export async function loadMe(owner: Address, ports: MePorts, limit = 500): Promise<MeData> {
  const ownerKey = lower(owner)
  const incomplete: string[] = []
  const note = (text: string) => {
    if (!incomplete.includes(text)) incomplete.push(text)
  }

  // Independent facts start together: the store's batching flag, its pending denies, the chain
  // clock — the clock tells an expired grant apart from a revoked one — and the chain's own
  // block number, which is what the index's progress is measured against.
  const [batchStatus, denies, latestSeconds, chainTip] = await Promise.all([
    safe(() => ports.store.batchStatus()),
    safe(() => ports.store.listRevocations("active")),
    safe(() => ports.chain.latestTimestamp()),
    safe(() => ports.chain.latestBlock()),
  ])
  const nowSeconds =
    latestSeconds === null || !Number.isFinite(latestSeconds) ? null : BigInt(Math.floor(latestSeconds))
  const chainBlock = chainTip === null ? null : Number(chainTip)
  const batchingOn = batchStatus === null ? null : batchStatus.enabled
  // The deployment's BatchAnchor is the only contract this page can check — roots are read from
  // it and signatures are recovered under its domain. A store advertising a different address
  // anchors its batches to a contract this deployment does not run: flag it, and nothing the
  // store calls "anchored" can be believed here.
  const batchAnchor: Address | null = DEPLOYMENT.batchAnchor ?? null
  const storeAnchor = batchStatus?.batchAnchor ?? null
  const anchorMismatch = storeAnchor !== null && (batchAnchor === null || !sameHex(storeAnchor, batchAnchor))
  if (anchorMismatch) note("the store serves a different batch contract — batched rows are shown as unverified")
  if (denies === null) note("the store's pending-revocation list could not be read — 'can read' may overstate access")
  const deniedAgents = new Set<string>()
  const deniedCapabilities = new Set<string>()
  for (const intent of Array.isArray(denies) ? denies : []) {
    if (intent?.target?.kind === "agent" && isString(intent.target.agentId)) {
      deniedAgents.add(lower(intent.target.agentId))
    } else if (intent?.target?.kind === "capability" && isString(intent.target.capabilityId)) {
      deniedCapabilities.add(lower(intent.target.capabilityId))
    }
  }

  // --- agents: the index only — the chain-log scan it used to fall back to could never finish --
  const grantSeeds: GrantSeed[] = []
  const revokeByAgent = new Map<string, { block: number; txHash: Hex }>()
  const rememberRevoke = (agentId: string, block: number, txHash: string) => {
    const key = lower(agentId)
    const prev = revokeByAgent.get(key)
    // Transaction fields only ever travel onward when they are renderable links (model.isTxHash).
    if (isTxHash(txHash) && (prev === undefined || block >= prev.block)) revokeByAgent.set(key, { block, txHash })
  }

  const areaIds = new Set<string>(OWNER_NAMESPACE_IDS.map(lower))
  const indexBatched = new Map<string, IndexBatchedSave>()
  const signerToAgent = new Map<string, Hex>()
  const indexRecords = new Map<string, IndexRecord>()
  // contextId → the chain's placement of its ContextRegistered event (block + log index).
  const timelineByContext = new Map<string, { block: number; index: number }>()
  let source: MeData["source"] = "index"
  let agentsUnavailable: string | null = null
  // The lag is measured against Monad's own block number — the index's self-reported lag is only
  // the fallback when the chain could not be asked. Null when the index cannot say how fresh it is.
  let indexLag: number | null = null
  // isReady === false means the index answered but is still catching up: its Grant rows are a
  // partial scan, not a list, so they are never consumed.
  let indexSyncing = false
  let ownerCounts: { records: number; batchedSaves: number } | null = null
  let youSaidCount = 0

  if (ports.index !== null) {
    const raw = await safe(() => queryIndex<AgentsAnswer>(ports.index!, AGENTS_QUERY, { owner: ownerKey, limit }))
    const primary = raw !== null && isAgentsAnswer(raw) ? raw : null
    const meta = primary === null ? null : metaRowOf(primary._meta)
    if (primary === null) {
      source = "unavailable"
    } else if (meta !== null && !meta.isReady) {
      source = "unavailable"
      indexSyncing = true
    } else {
      indexLag =
        meta === null
          ? null
          : chainBlock !== null
            ? chainBlock - meta.progressBlock
            : meta.blocksBehind
      const grants = primary.Grant ?? []
      const revocations = primary.Revocation ?? []
      // A page-sized answer may be only the first page — the banner warns, it never hides.
      if (grants.length >= limit || revocations.length >= limit) note(INDEX_LIMIT_TEXT)
      for (const grant of grants) {
        grantSeeds.push({
          agentId: grant.agent as Hex,
          capabilityId: grant.id as Hex,
          namespaceId: grant.namespaceId as Hex,
          permissions: grant.permissions,
          sourceSaysLive: grant.revokedBlock === null,
          approvedTx: isTxHash(grant.txHash) ? grant.txHash : null,
        })
        areaIds.add(lower(grant.namespaceId))
      }
      for (const revocation of revocations) rememberRevoke(revocation.agentId, revocation.block, revocation.txHash)
      const agentIds = [...new Set(grantSeeds.map((g) => lower(g.agentId)))]
      // Secondary queries degrade their own corner of the page rather than poisoning the
      // primary answer: the agents list already came from the index and stays index-sourced.
      const [batchedAnswer, countsAnswer] = await Promise.all([
        safe(() => queryIndex<BatchedAnswer>(ports.index!, BATCHED_QUERY, { owner: ownerKey, agents: agentIds, limit })),
        safe(() => queryIndex<CountsAnswer>(ports.index!, COUNTS_QUERY, { owner: ownerKey, limit })),
      ])
      if (batchedAnswer === null) {
        note("the index's batch detail could not be read — batch transaction links may be missing")
      } else {
        if ((batchedAnswer.BatchedSave ?? []).length >= limit) note(INDEX_LIMIT_TEXT)
        for (const row of batchedAnswer.BatchedSave ?? []) {
          if (!isString(row.id) || !isString(row.namespaceId)) continue
          indexBatched.set(lower(row.id), row)
          areaIds.add(lower(row.namespaceId))
        }
        for (const agent of batchedAnswer.Agent ?? []) {
          if (!isString(agent.id) || !isString(agent.signer)) continue
          signerToAgent.set(lower(agent.signer), agent.id as Hex)
        }
      }
      if (countsAnswer === null) {
        note("the index's totals could not be read — counts are hidden")
      } else {
        if ((countsAnswer.ContextRecord ?? []).length >= limit) note(INDEX_LIMIT_TEXT)
        for (const record of countsAnswer.ContextRecord ?? []) {
          if (!isString(record.id) || !isString(record.namespaceId)) continue
          indexRecords.set(lower(record.id), record)
          areaIds.add(lower(record.namespaceId))
        }
        // context_registered timeline rows give each direct record its exact place in the chain —
        // block and log index — for the same-second tie the block alone cannot break.
        for (const entry of countsAnswer.TimelineEntry ?? []) {
          if (entry.kind !== "context_registered") continue
          if (!isString(entry.contextId) || !isNumber(entry.block) || !isNumber(entry.logIndex)) continue
          timelineByContext.set(lower(entry.contextId), { block: entry.block, index: entry.logIndex })
        }
        if (countsAnswer.Owner_by_pk === null || countsAnswer.Owner_by_pk === undefined) {
          ownerCounts = { records: 0, batchedSaves: 0 } // no Owner row = nothing indexed yet
        } else if (isNumber(countsAnswer.Owner_by_pk.records) && isNumber(countsAnswer.Owner_by_pk.batchedSaves)) {
          ownerCounts = { records: countsAnswer.Owner_by_pk.records, batchedSaves: countsAnswer.Owner_by_pk.batchedSaves }
        } else {
          note("the index's totals could not be read — counts are hidden")
        }
        youSaidCount = (countsAnswer.ContextRecord ?? []).filter((r) => r.provenanceSource === 1 || r.provenanceSource === 2).length
      }
    }
  } else {
    source = "unavailable"
  }

  if (source !== "index") {
    // There is no second source for the agent list: the old chain-log fallback needed ~39,000
    // requests against a public RPC that allows ~500 inside the page's deadline, so it could
    // never produce the list it was asked for. The page names the missing index instead of
    // pretending to scan; the per-record chain checks below are unchanged.
    agentsUnavailable = indexSyncing ? AGENT_LIST_SYNCING : AGENT_LIST_NEEDS_INDEX
  }

  // --- agent names: chain agent record → content-addressed manifest → name -------------------
  const nameCache = new Map<string, Promise<string>>()
  const nameFor = (agentId: Hex): Promise<string> => {
    const key = lower(agentId)
    if (key === zeroHash) return Promise.resolve("you") // OWNER_AUTHOR_ID: the owner wrote it
    let cached = nameCache.get(key)
    if (cached === undefined) {
      cached = (async () => {
        const record = await safe(() => ports.chain.getAgent(agentId))
        const hash = record?.capabilityManifestHash
        if (hash !== undefined) {
          const manifest = await safe(() => ports.store.getAgentManifest(hash))
          const name = manifest?.manifest?.name
          if (typeof name === "string" && name.length > 0) return name
        }
        return shortId(agentId)
      })()
      nameCache.set(key, cached)
    }
    return cached
  }

  // --- grant truth: the index or the logs said it, the chain is asked ------------------------
  // getCapability answers who the grant is for and when it ends; isCapabilityValid answers
  // whether it works right now. Both reads run together, and the row only claims "Can read"
  // when the capability's owner/agent/area all match the listing.
  const agents = new Map<string, AgentRow>()
  for (const seed of grantSeeds) {
    const [capability, chainSaysValid] = await Promise.all([
      safe(() => ports.chain.getCapability(seed.capabilityId)),
      safe(() => ports.chain.isCapabilityValid(seed.capabilityId)),
    ])
    const capMatches =
      capability !== null &&
      sameHex(capability.owner, ownerKey) &&
      sameHex(capability.agentId, seed.agentId) &&
      sameHex(capability.namespaceId, seed.namespaceId)
    const status = grantStatus({
      sourceSaysLive: seed.sourceSaysLive,
      capability: capability === null ? null : {
        owner: capability.owner,
        agentId: capability.agentId,
        namespaceId: capability.namespaceId,
        expiresAt: capability.expiresAt,
      },
      chainSaysValid,
      owner: ownerKey,
      agentId: seed.agentId,
      namespaceId: seed.namespaceId,
      nowSeconds,
    })
    let row = agents.get(lower(seed.agentId))
    if (row === undefined) {
      row = {
        agentId: seed.agentId,
        name: "",
        grants: [],
        revokedTx: revokeByAgent.get(lower(seed.agentId))?.txHash ?? null,
        blockedAtStore: false,
        readLive: false,
        unverified: false,
      }
      agents.set(lower(seed.agentId), row)
    }
    row.grants.push({
      namespaceId: seed.namespaceId,
      area: areaName(seed.namespaceId),
      // Permission bits come from the chain's capability row; the listing's claim only shows on
      // a row the chain could not confirm.
      permissions: capMatches && capability !== null ? capability.permissions : seed.permissions,
      capabilityId: seed.capabilityId,
      status,
      approvedTx: seed.approvedTx,
    })
  }
  for (const row of agents.values()) {
    // An agent-level deny blocks it outright; a capability-level deny on one of its grants blocks
    // the same way — the store refuses reads either way while the revoke is pending on Monad.
    row.blockedAtStore =
      deniedAgents.has(lower(row.agentId)) || row.grants.some((g) => deniedCapabilities.has(lower(g.capabilityId)))
    row.readLive =
      !row.blockedAtStore && row.grants.some((g) => (g.permissions & 1) !== 0 && g.status.label === "Can read")
    row.unverified = row.grants.some((g) => g.status.label === "Unverified")
    row.name = await nameFor(row.agentId)
  }

  // --- records: the store lists what it holds; the chain decides what is anchored ------------
  const listedObjects: StoreObject[] = []
  const listedBatched: { item: StoreBatchedItem; namespaceId: Hex }[] = []
  let anyPartial = false
  let batchedListComplete = true
  // A listing that threw is a hole, not an empty answer — count them per lane so "records: []"
  // can be told apart from "the store never produced a list".
  let objectsFailed = 0
  let batchedFailed = 0
  await Promise.all(
    [...areaIds].map(async (id) => {
      const nsId = id as Hex
      const [objects, batched] = await Promise.all([
        safe(() => ports.store.listObjects({ owner, namespaceId: nsId })),
        safe(() => ports.store.listBatchSaves({ owner, namespaceId: nsId })),
      ])
      if (objects === null) {
        objectsFailed += 1
        note(`the store could not list ${areaName(nsId)} — those records may be missing`)
      } else {
        if (objects.partial) {
          anyPartial = true
          note(PARTIAL_LIST_TEXT)
        }
        for (const object of Array.isArray(objects.objects) ? objects.objects : []) {
          if (
            isString(object?.contextId) &&
            isString(object?.namespaceId) &&
            isString(object?.authorId) &&
            isString(object?.ciphertext)
          ) {
            listedObjects.push(object)
          } else {
            note("a store row was malformed and skipped")
          }
        }
      }
      if (batched === null) {
        batchedListComplete = false
        batchedFailed += 1
        note(`the store could not list batched saves for ${areaName(nsId)} — those records may be missing`)
      } else {
        if (batched.partial) {
          batchedListComplete = false
          anyPartial = true
          note(PARTIAL_LIST_TEXT)
        }
        for (const item of Array.isArray(batched.items) ? batched.items : []) {
          if (isString(item?.contextId) && item?.save !== undefined) {
            listedBatched.push({ item, namespaceId: nsId })
          } else {
            note("a store row was malformed and skipped")
          }
        }
      }
    }),
  )

  // Direct lane: one getRecords batch answers "is this contextId on ContextRegistry, and does it
  // say what the store says". A throw marks every direct row UNKNOWN — the check never ran, so
  // nothing was disproven — rather than dropping the rows or calling them unverified.
  let chainRecords: Map<string, ContextRecordView> | null = null
  let directCheckFailed = false
  if (listedObjects.length > 0) {
    const found = await safe(() => ports.chain.getRecords(listedObjects.map((o) => o.contextId)))
    if (found === null) {
      directCheckFailed = true
      note("the chain record check failed — direct records could not be checked against Monad; reload")
    } else {
      chainRecords = new Map()
      for (const record of found) {
        if (record !== null) chainRecords.set(lower(record.contextId), record)
      }
    }
  }

  const records: RecordRow[] = []
  for (const object of listedObjects) {
    const record = chainRecords?.get(lower(object.contextId)) ?? null
    const indexRecord = indexRecords.get(lower(object.contextId))
    const placement = timelineByContext.get(lower(object.contextId))
    const createdAt =
      record !== null
        ? Number(record.createdAt) * 1000
        : indexRecord !== undefined
          ? (secondsOf(indexRecord.createdAt) ?? 0) * 1000
          : 0
    // The row's place in the chain's order, when any part of it is known: the stamp above is
    // already Monad's (the chain record's word first, the index's report as the only fallback);
    // the block and log index ride alongside whenever the index observed the register event.
    const chain =
      createdAt === 0
        ? undefined
        : {
            at: createdAt,
            ...(placement !== undefined
              ? { block: placement.block, index: placement.index }
              : indexRecord !== undefined && isNumber(indexRecord.registeredBlock)
                ? { block: indexRecord.registeredBlock }
                : {}),
          }
    records.push({
      contextId: object.contextId,
      namespaceId: object.namespaceId,
      area: areaName(object.namespaceId),
      readEpoch: record?.readEpoch ?? uint64Of(object.manifest?.readEpoch),
      lane: "direct",
      state: directCheckFailed ? "unknown" : record !== null && directMatches(record, object, ownerKey) ? "anchored" : "unverified",
      authorId: object.authorId,
      authorName: await nameFor(object.authorId),
      // Provenance is the chain record's word or nothing — the index's claim is never borrowed
      // for a row the chain did not confirm.
      source: record?.provenanceSource ?? null,
      tx: indexRecord !== undefined && isTxHash(indexRecord.txHash) ? indexRecord.txHash : null,
      batchId: null,
      ciphertext: object.ciphertext,
      manifest: object.manifest,
      createdAt,
      ...(chain === undefined ? {} : { chain }),
    })
  }

  // Batched lane: the contextId belongs to BatchAnchor's Merkle root, never to ContextRegistry.
  // The author is recovered from the save's own signature — the same derivation the contract ran
  // at anchor — resolved to an agentId by the chain, with the index's Agent signer map and
  // BatchedSave row as fallback sources when that read fails.
  const resolvedAgentOfSigner = new Map<string, Promise<Hex | null>>()
  const agentOfSigner = (signer: Address): Promise<Hex | null> => {
    const key = lower(signer)
    let cached = resolvedAgentOfSigner.get(key)
    if (cached === undefined) {
      cached = (async () => {
        const fromChain = await safe(() => ports.chain.agentIdOfSigner(signer))
        return fromChain ?? signerToAgent.get(key) ?? null
      })()
      resolvedAgentOfSigner.set(key, cached)
    }
    return cached
  }

  // The anchor block (and its timestamp) is the chain's placement for every save in one batch —
  // looked up once per batchId/block and shared across its rows; a failed read degrades the
  // row's chain field, never the page.
  const memo = <K, V>(fn: (key: K) => Promise<V>) => {
    const cache = new Map<string, Promise<V>>()
    return (key: K): Promise<V> => {
      const id = String(key)
      let hit = cache.get(id)
      if (hit === undefined) {
        hit = fn(key)
        cache.set(id, hit)
      }
      return hit
    }
  }
  const anchorBlockOf = memo((batchId: Hex) => safe(() => ports.chain.batchBlock(batchId)))
  const blockTimeOf = memo((block: bigint) => safe(() => ports.chain.blockTime(block)))

  // --- pending verdicts: a queued/held save is judged by the same two questions the batcher ---
  // re-asks every tick — is the author on the store's deny list, and does Monad still grant the
  // write. A row that fails either is "blocked", never merely "waiting". null means the Monad
  // read itself failed: the check did not run, so the row is "unknown", not acquitted.
  const pendingWriteAllowed = async (
    message: BatchSaveMessage,
    author: Hex,
    nsId: Hex,
  ): Promise<boolean | null> => {
    const ask = (permission: number) =>
      safe(() =>
        ports.chain.hasAuthority(owner, author, nsId, permission, PROVENANCE_POLICY.ALLOW_INFERENCE),
      )
    if (message.parentId === zeroHash) return await ask(PERMISSION.CREATE)
    // Replacement: SUPERSEDE_OWN when the author opened the lineage; SUPERSEDE_ANY otherwise —
    // the same disjunction BatchAnchor applies at anchor time.
    const own = sameHex(message.rootAuthor, author) ? await ask(PERMISSION.SUPERSEDE_OWN) : false
    if (own === true) return true
    const any = await ask(PERMISSION.SUPERSEDE_ANY)
    if (any === true) return true
    return own === null || any === null ? null : false
  }

  // A capability-level deny names a grant, not an agent — the capability row is the only link
  // from it to the author this page can test. Memoized: the list is short and shared by rows.
  const deniedCapabilityOf = memo((capabilityId: string) =>
    safe(() => ports.chain.getCapability(capabilityId as Hex)),
  )
  const capabilityDenyHits = async (candidates: Hex[], nsId: Hex): Promise<boolean> => {
    for (const capabilityId of deniedCapabilities) {
      const capability = await deniedCapabilityOf(capabilityId)
      if (
        capability !== null &&
        candidates.some((id) => sameHex(capability.agentId, id)) &&
        sameHex(capability.namespaceId, nsId)
      ) {
        return true
      }
    }
    return false
  }

  for (const { item, namespaceId: listedUnder } of listedBatched) {
    const message = wireMessageOf(item)
    const candidates: Hex[] = []
    if (message !== null && batchAnchor !== null) {
      const signer = await safe(() =>
        recoverTypedDataAddress({
          ...batchSaveTypedData({ chainId: DEPLOYMENT.chainId, batchAnchor, message }),
          signature: item.save.signature,
        } as never),
      )
      if (signer !== null) {
        const agentId = await agentOfSigner(signer as Address)
        if (agentId !== null) candidates.push(agentId)
      }
    }
    const indexRow = indexBatched.get(lower(item.contextId))
    if (indexRow !== undefined && !candidates.some((c) => sameHex(c, indexRow.agentId))) {
      candidates.push(indexRow.agentId as Hex)
    }

    let state: AnchorState = "pending"
    let authorId: Hex = candidates[0] ?? zeroHash
    // A signed save that names another owner is not this owner's record at all — the store
    // filed it wrong or it was never meant for this page. Unverified, whatever the proof says.
    const ownerMismatch = message !== null && !sameHex(message.owner, ownerKey)
    if (anchorMismatch || ownerMismatch) {
      state = "unverified"
    } else if (item.state === "ANCHORED") {
      const batchId = item.batchId ?? (indexRow?.batchId as Hex | undefined) ?? null
      const lineageId = item.lineageId ?? (indexRow?.lineageId as Hex | undefined) ?? null
      const version = item.version ?? indexRow?.version ?? null
      let anchored = false
      // null = the chain answered "no such root"; "failed" = the read itself never returned.
      // Only the second is "unknown" — a thrown read must not read as "not on Monad".
      let root: Hex | null | "failed" = null
      if (
        message !== null &&
        batchId !== null &&
        lineageId !== null &&
        version !== null &&
        Array.isArray(item.proof) &&
        batchedCommitmentsMatch(item, message)
      ) {
        try {
          root = await ports.chain.batchRoot(batchId)
        } catch {
          root = "failed"
        }
        if (root !== null && root !== "failed") {
          try {
            const structHash = batchSaveStructHash(message)
            // Each candidate agentId produces a different leaf; whichever one the on-chain root
            // accepts is the verified author. A wrong candidate can only fail the proof — the
            // check is fail-closed, never fail-open.
            for (const candidate of candidates) {
              const leaf = batchLeafHash({
                contextId: item.contextId,
                agentId: candidate,
                lineageId,
                version,
                structHash,
              })
              if (verifyMerkleProof(leaf, item.proof, root)) {
                anchored = true
                authorId = candidate
                break
              }
            }
          } catch {
            anchored = false
          }
        }
      }
      if (anchored) {
        state = "anchored"
      } else if (root === "failed" || (root !== null && candidates.length === 0)) {
        // The root read never returned, or no author candidate could be established (the signer
        // lookup failed and the index named nobody) — either way the proof check never ran, so
        // this is "could not check", never a verdict of unverified.
        state = "unknown"
      } else {
        state = "unverified"
      }
    } else {
      // QUEUED/SUBMITTED is still in line; HELD is the store's own verdict that the author is
      // denied. The batcher re-asks the same two questions every tick — deny list and Monad's
      // authority — so this label runs them too: a save that can never anchor must never read
      // as merely "waiting to be anchored".
      const saveNamespace =
        message?.namespaceId ?? (indexRow?.namespaceId as Hex | undefined) ?? listedUnder
      const denied =
        item.state === "HELD" ||
        candidates.some((id) => deniedAgents.has(lower(id))) ||
        (await capabilityDenyHits(candidates, saveNamespace))
      if (denied) {
        state = "blocked"
      } else {
        const author = candidates[0]
        if (message === null || author === undefined) {
          // No author or decoded message to judge — the row is genuinely just waiting.
          state = "pending"
        } else {
          const allowed = await pendingWriteAllowed(message, author, saveNamespace)
          // A Monad read that never returned means the check did not run — "unknown", not a pass.
          state = allowed === null ? "unknown" : allowed ? "pending" : "blocked"
        }
      }
    }
    // An anchored save's stamp is the anchor block's own timestamp — the store's receivedAt is
    // the queue's clock, which never orders the list. The position inside the batch is the
    // save's order within that block; the index's row supplies it when the store's item didn't.
    let chain: RecordRow["chain"] | undefined
    if (state === "anchored") {
      const batchIdForBlock = (item.batchId ?? indexRow?.batchId ?? null) as Hex | null
      const anchorBlock =
        batchIdForBlock !== null
          ? (await anchorBlockOf(batchIdForBlock)) ?? (indexRow?.block !== undefined ? BigInt(indexRow.block) : null)
          : null
      if (anchorBlock !== null) {
        const at = await blockTimeOf(anchorBlock)
        // A stamp we could not read orders nothing — better no placement than a guessed one.
        if (at !== null) {
          const position = item.position ?? indexRow?.position
          chain = { at: at * 1000, block: Number(anchorBlock), ...(position === undefined ? {} : { index: position }) }
        }
      }
    }
    const rowNamespace = message?.namespaceId ?? (indexRow?.namespaceId as Hex | undefined) ?? listedUnder
    records.push({
      contextId: item.contextId,
      namespaceId: rowNamespace,
      area: areaName(rowNamespace),
      readEpoch: message?.readEpoch ?? 0n,
      lane: "batched",
      state,
      authorId,
      authorName: authorId === zeroHash ? "an agent" : await nameFor(authorId),
      source: message?.provenanceSource ?? null,
      tx: indexRow !== undefined && isTxHash(indexRow.txHash) ? indexRow.txHash : null,
      batchId: item.batchId ?? (indexRow?.batchId as Hex | undefined) ?? null,
      ciphertext: item.save.ciphertext,
      manifest: item.save.manifest,
      createdAt: chain?.at ?? (isNumber(item.receivedAt) ? item.receivedAt : 0),
      ...(chain === undefined ? {} : { chain }),
    })
  }

  // Both lanes failing for every namespace means records:[] is a dead store lookup, not an
  // empty store — the page must say it could not load the list, not claim the store is empty.
  const recordsUnavailable =
    areaIds.size > 0 && objectsFailed === areaIds.size && batchedFailed === areaIds.size

  // Monad's order, newest first: the chain's stamp, then block, then the record's position in
  // it. A record the chain never placed sorts behind placed ones at the same instant; only when
  // nothing but the instant is known does the contextId break the tie — a random id never
  // outranks a real placement.
  records.sort((a, b) => {
    const t = (b.chain?.at ?? b.createdAt) - (a.chain?.at ?? a.createdAt)
    if (t !== 0) return t
    const aBlock = a.chain?.block
    const bBlock = b.chain?.block
    if (aBlock !== undefined || bBlock !== undefined) {
      if (aBlock === undefined) return 1
      if (bBlock === undefined) return -1
      if (aBlock !== bBlock) return bBlock - aBlock
    }
    // `index` is a log index on the direct lane and a position inside its own batch on the
    // batched one — comparable only between two direct records, or two saves of the SAME
    // batch. The page's sources carry no per-transaction index that could order across lanes
    // or across batches in one block, so those ties fall straight to the contextId rather
    // than comparing two different units as if they were one (in-13 M-5).
    const aIndex = a.chain?.index
    const bIndex = b.chain?.index
    if (aIndex !== undefined || bIndex !== undefined) {
      const sameUnit = a.lane === b.lane && (a.lane === "direct" || a.batchId === b.batchId)
      if (sameUnit) {
        if (aIndex === undefined) return 1
        if (bIndex === undefined) return -1
        if (aIndex !== bIndex) return bIndex - aIndex
      }
    }
    return a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0
  })
  const agentList = [...agents.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.agentId < b.agentId ? -1 : 1),
  )

  const pending = records.filter((r) => r.lane === "batched" && r.state === "pending").length
  const counts =
    source === "index" && ownerCounts !== null && !anyPartial
      ? { records: ownerCounts.records + ownerCounts.batchedSaves, youSaid: youSaidCount, pending }
      : null
  // The lag line names which source is speaking: no index configured at all, an index that is
  // still catching up, an index that failed to answer, or the progress measured against Monad's
  // own block number.
  const lag =
    ports.index === null
      ? { text: "index not configured", stale: true }
      : indexSyncing
        ? { text: "index still catching up", stale: true }
        : source !== "index"
          ? { text: "index unavailable", stale: true }
          : lagText(indexLag)

  return { owner, agents: agentList, records, incomplete, agentsUnavailable, recordsUnavailable, source, lag, batchingOn, batchedListComplete, counts }
}
