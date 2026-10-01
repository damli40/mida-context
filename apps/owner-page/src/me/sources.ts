/**
 * The data gatherer behind the owner page.
 *
 * One list, checked: the store's object and batched-save lists are the list of records, and the
 * chain decides what each one is. Verification is per lane: every direct object is re-read on
 * ContextRegistry (matching fields → "anchored", missing or mismatched → "unverified"); every
 * ANCHORED batched item re-derives its Merkle leaf — the save signature recovers the signer,
 * agentIdOfSigner names the agent — and the proof is checked against the on-chain batch root. A
 * batched contextId never reaches ContextRegistry.
 *
 * The page does not list agents: that needs a lookup of every grant the contracts emitted, and
 * a scan from the browser needed ~39,000 requests against a public RPC that allows ~500 inside
 * the page's deadline. Nothing here throws out of loadMe — a failure degrades to "unverified",
 * a line in `incomplete`, or the shortened agent id, never a blank page.
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
  isAcceptableAgentName,
  verifyMerkleProof,
} from "@mida/protocol"
import type { Address, AgentRecord, BatchSaveMessage, Hex } from "@mida/protocol"
import { bytesOf, ciphertextHash, manifestHash } from "@mida/crypto"
import type { CapabilityView, ContextApiRoutes, ContextRecordView } from "@mida/api/browser"
import { DEPLOYMENT } from "../owner/core.js"
import type { AnchorState, Lane } from "./model.js"

/** The exact banner a truncated store list earns — pinned by the plan. */
export const PARTIAL_LIST_TEXT = "list incomplete — the store ran out of chain reads; reload"
/**
 * The sentence the page prints where an agent list would be. Listing agents needs a lookup of
 * every grant the contracts emitted; a scan from the browser needed ~39,000 requests against a
 * public RPC that allows ~500 inside the page's budget, so the page does not try.
 */
export const AGENTS_NOT_LISTED_TEXT =
  "This page does not list your agents yet. Run mida doctor in your terminal to see the agents approved on that machine. The records below are still checked against Monad."
/**
 * The header badge. It names the page's method, never an outcome: a failed store or chain read
 * shows in the dot (`degraded`) and in the banners, not in this sentence.
 */
export const SOURCE_BADGE_TEXT = "Records come from the store and are checked on Monad"

// The three owner areas flows.ts opens on setup — duplicated there and here on purpose: this
// module stays import-light.
const OWNER_NAMESPACE_IDS = ["projects.current", "preferences.communication", "profile.skills"].map((name) =>
  namespaceId(name),
)

// ---------------------------------------------------------------------------------------------
// Ports and rows.

export interface MePorts {
  store: Pick<ContextApiRoutes, "listObjects" | "listBatchSaves" | "listRevocations" | "batchStatus" | "getAgentManifest">
  chain: {
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
  }
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
  records: RecordRow[]
  incomplete: string[]
  /**
   * True when every store listing call failed — then `records: []` is a dead lookup, not an
   * empty store, and the page must not read it as "the store holds no records".
   */
  recordsUnavailable: boolean
  /**
   * True when a list was incomplete, a check could not run, or the store did not answer: the
   * header badge shows its warning dot. The banners in `incomplete` say what went wrong.
   */
  degraded: boolean
  batchingOn: boolean | null
}

// Wire shapes lifted off the route types so this module never re-declares the API's wire format.
type StoreObject = Awaited<ReturnType<ContextApiRoutes["listObjects"]>>["objects"][number]
type StoreBatchedItem = Awaited<ReturnType<ContextApiRoutes["listBatchSaves"]>>["items"][number]

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

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

function uint64Of(value: unknown): bigint {
  try {
    return decodeUint64(value as string)
  } catch {
    return 0n
  }
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

export async function loadMe(owner: Address, ports: MePorts): Promise<MeData> {
  const ownerKey = lower(owner)
  const incomplete: string[] = []
  const note = (text: string) => {
    if (!incomplete.includes(text)) incomplete.push(text)
  }

  // Independent facts start together: the store's batching flag and its pending denies.
  const [batchStatus, denies] = await Promise.all([
    safe(() => ports.store.batchStatus()),
    safe(() => ports.store.listRevocations("active")),
  ])
  const batchingOn = batchStatus === null ? null : batchStatus.enabled
  // The deployment's BatchAnchor is the only contract this page can check — roots are read from
  // it and signatures are recovered under its domain. A store advertising a different address
  // anchors its batches to a contract this deployment does not run: flag it, and nothing the
  // store calls "anchored" can be believed here.
  const batchAnchor: Address | null = DEPLOYMENT.batchAnchor ?? null
  const storeAnchor = batchStatus?.batchAnchor ?? null
  const anchorMismatch = storeAnchor !== null && (batchAnchor === null || !sameHex(storeAnchor, batchAnchor))
  if (anchorMismatch) note("the store serves a different batch contract — batched rows are shown as unverified")
  if (denies === null) note("the store's pending-revocation list could not be read — a blocked save may read as waiting")
  const deniedAgents = new Set<string>()
  const deniedCapabilities = new Set<string>()
  for (const intent of Array.isArray(denies) ? denies : []) {
    if (intent?.target?.kind === "agent" && isString(intent.target.agentId)) {
      deniedAgents.add(lower(intent.target.agentId))
    } else if (intent?.target?.kind === "capability" && isString(intent.target.capabilityId)) {
      deniedCapabilities.add(lower(intent.target.capabilityId))
    }
  }

  const areaIds = new Set<string>(OWNER_NAMESPACE_IDS.map(lower))

  // --- author names: chain agent record → content-addressed manifest → name ------------------
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
          // The store's manifest check can sit inside its verification cache, so /me runs the
          // shared agent-name rule itself (in-31 V-4, in-32 X-2): a refused name — one carrying
          // a line-forging character, a quote or look-alike, or nothing but joiners — is shown
          // as unreadable, never rendered.
          if (typeof name === "string" && name.length > 0) {
            return isAcceptableAgentName(name) ? name : "an agent with an unreadable name"
          }
        }
        return shortId(agentId)
      })()
      nameCache.set(key, cached)
    }
    return cached
  }

  // --- records: the store lists what it holds; the chain decides what is anchored ------------
  const listedObjects: StoreObject[] = []
  const listedBatched: { item: StoreBatchedItem; namespaceId: Hex }[] = []
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
        batchedFailed += 1
        note(`the store could not list batched saves for ${areaName(nsId)} — those records may be missing`)
      } else {
        if (batched.partial) {
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
    // The row's stamp is the chain record's own createdAt; a row the chain did not return has
    // no placement. The page has no source for a direct record's block or log index.
    const createdAt = record !== null ? Number(record.createdAt) * 1000 : 0
    records.push({
      contextId: object.contextId,
      namespaceId: object.namespaceId,
      area: areaName(object.namespaceId),
      readEpoch: record?.readEpoch ?? uint64Of(object.manifest?.readEpoch),
      lane: "direct",
      state: directCheckFailed ? "unknown" : record !== null && directMatches(record, object, ownerKey) ? "anchored" : "unverified",
      authorId: object.authorId,
      authorName: await nameFor(object.authorId),
      // Provenance is the chain record's word or nothing: a row the chain did not confirm
      // carries none.
      source: record?.provenanceSource ?? null,
      batchId: null,
      ciphertext: object.ciphertext,
      manifest: object.manifest,
      createdAt,
      ...(createdAt === 0 ? {} : { chain: { at: createdAt } }),
    })
  }

  // Batched lane: the contextId belongs to BatchAnchor's Merkle root, never to ContextRegistry.
  // The author is recovered from the save's own signature — the same derivation the contract ran
  // at anchor — and resolved to an agentId by the chain. Null when that read fails.
  const resolvedAgentOfSigner = new Map<string, Promise<Hex | null>>()
  const agentOfSigner = (signer: Address): Promise<Hex | null> => {
    const key = lower(signer)
    let cached = resolvedAgentOfSigner.get(key)
    if (cached === undefined) {
      cached = safe(() => ports.chain.agentIdOfSigner(signer))
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
  const capabilityDenyHits = async (author: Hex, nsId: Hex): Promise<boolean> => {
    for (const capabilityId of deniedCapabilities) {
      const capability = await deniedCapabilityOf(capabilityId)
      if (capability !== null && sameHex(capability.agentId, author) && sameHex(capability.namespaceId, nsId)) {
        return true
      }
    }
    return false
  }

  for (const { item, namespaceId: listedUnder } of listedBatched) {
    const message = wireMessageOf(item)
    // The author is whoever signed the save: recover the signer, then ask the chain which agent
    // that signer is. Null when either step could not answer.
    let signerAgent: Hex | null = null
    if (message !== null && batchAnchor !== null) {
      const signer = await safe(() =>
        recoverTypedDataAddress({
          ...batchSaveTypedData({ chainId: DEPLOYMENT.chainId, batchAnchor, message }),
          signature: item.save.signature,
        } as never),
      )
      if (signer !== null) signerAgent = await agentOfSigner(signer as Address)
    }

    let state: AnchorState = "pending"
    const authorId: Hex = signerAgent ?? zeroHash
    // A signed save that names another owner is not this owner's record at all — the store
    // filed it wrong or it was never meant for this page. Unverified, whatever the proof says.
    const ownerMismatch = message !== null && !sameHex(message.owner, ownerKey)
    if (anchorMismatch || ownerMismatch) {
      state = "unverified"
    } else if (item.state === "ANCHORED") {
      const batchId = item.batchId ?? null
      const lineageId = item.lineageId ?? null
      const version = item.version ?? null
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
        if (root !== null && root !== "failed" && signerAgent !== null) {
          try {
            // The leaf is built from the signer's agent id. A wrong author can only fail the
            // proof — the check is fail-closed, never fail-open.
            const leaf = batchLeafHash({
              contextId: item.contextId,
              agentId: signerAgent,
              lineageId,
              version,
              structHash: batchSaveStructHash(message),
            })
            anchored = verifyMerkleProof(leaf, item.proof, root)
          } catch {
            anchored = false
          }
        }
      }
      if (anchored) {
        state = "anchored"
      } else if (root === "failed" || (root !== null && signerAgent === null)) {
        // The root read never returned, or the author could not be established (the signer
        // lookup failed) — either way the proof check never ran, so this is "could not check",
        // never a verdict of unverified.
        state = "unknown"
      } else {
        state = "unverified"
      }
    } else {
      // QUEUED/SUBMITTED is still in line; HELD is the store's own verdict that the author is
      // denied. The batcher re-asks the same two questions every tick — deny list and Monad's
      // authority — so this label runs them too: a save that can never anchor must never read
      // as merely "waiting to be anchored".
      const saveNamespace = message?.namespaceId ?? listedUnder
      const denied =
        item.state === "HELD" ||
        (signerAgent !== null &&
          (deniedAgents.has(lower(signerAgent)) || (await capabilityDenyHits(signerAgent, saveNamespace))))
      if (denied) {
        state = "blocked"
      } else if (message === null || signerAgent === null) {
        // No author or decoded message to judge — the row is genuinely just waiting.
        state = "pending"
      } else {
        const allowed = await pendingWriteAllowed(message, signerAgent, saveNamespace)
        // A Monad read that never returned means the check did not run — "unknown", not a pass.
        state = allowed === null ? "unknown" : allowed ? "pending" : "blocked"
      }
    }
    // An anchored save's stamp is the anchor block's own timestamp — the store's receivedAt is
    // the queue's clock, which never orders the list. The position inside the batch is the
    // save's order within that block.
    let chain: RecordRow["chain"] | undefined
    if (state === "anchored") {
      const batchIdForBlock = item.batchId ?? null
      const anchorBlock = batchIdForBlock !== null ? await anchorBlockOf(batchIdForBlock) : null
      if (anchorBlock !== null) {
        const at = await blockTimeOf(anchorBlock)
        // A stamp we could not read orders nothing — better no placement than a guessed one.
        if (at !== null) {
          const position = item.position ?? undefined
          chain = { at: at * 1000, block: Number(anchorBlock), ...(position === undefined ? {} : { index: position }) }
        }
      }
    }
    const rowNamespace = message?.namespaceId ?? listedUnder
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
      batchId: item.batchId ?? null,
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
    // `index` is a save's position inside its own batch — comparable only between two saves of
    // the SAME batch. Nothing the page reads can order across batches in one block, or against
    // a direct record, so those ties fall straight to the contextId rather than comparing two
    // different units as if they were one (in-13 M-5).
    const aIndex = a.chain?.index
    const bIndex = b.chain?.index
    if (aIndex !== undefined || bIndex !== undefined) {
      const sameBatch = a.lane === "batched" && b.lane === "batched" && a.batchId === b.batchId
      if (sameBatch) {
        if (aIndex === undefined) return 1
        if (bIndex === undefined) return -1
        if (aIndex !== bIndex) return bIndex - aIndex
      }
    }
    return a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0
  })
  return {
    owner,
    records,
    incomplete,
    recordsUnavailable,
    degraded: incomplete.length > 0 || recordsUnavailable,
    batchingOn,
  }
}
