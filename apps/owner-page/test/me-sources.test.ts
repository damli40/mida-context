// The /me sources layer. The page does not list agents (a scan of the chain's history needed
// ~39,000 requests against a public RPC that allows ~500 inside the page's deadline, so nothing
// here scans). Every direct object is re-proven against ContextRegistry, and every batched save
// is proven on its own Merkle proof — a batched contextId must never reach ContextRegistry. Both
// ports are in-memory fakes: no network, no real store. The batched fixtures are really signed — the
// test account signs the same MidaBatchSaveV1 typed data the contract verifies — so the leaf and
// proof checks run on the actual hashes.

import { describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { zeroHash } from "viem"
import {
  CONTEXT_KIND,
  PROVENANCE_SOURCE,
  batchContextId,
  batchLeafHash,
  batchSaveStructHash,
  batchSaveTypedData,
  merkleProof,
  merkleRoot,
  namespaceId,
} from "@mida/protocol"
import type { Address, AgentRecord, BatchSaveMessage, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { deriveEpochKeyPair, hexOf, sealContextObject } from "@mida/crypto"
import type { AnchoredObject, BatchedReadItem, CapabilityView, ContextRecordView, RevocationIntentView } from "@mida/api"
import { DEPLOYMENT } from "../src/owner/core.js"
import { AGENTS_NOT_LISTED_TEXT, SOURCE_BADGE_TEXT, loadMe } from "../src/me/sources.js"
import type { MePorts } from "../src/me/sources.js"

const OWNER = `0x${"11".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const OTHER_ID = `0x${"bb".repeat(32)}` as Hex
const CAP_ID = `0x${"c1".padStart(64, "0")}` as Hex
const CAP2_ID = `0x${"c2".padStart(64, "0")}` as Hex
const BATCH_ID = `0x${"b5".repeat(32)}` as Hex
const ANCHOR = DEPLOYMENT.batchAnchor as Address
const NS = namespaceId("projects.current")
const NS_SKILLS = namespaceId("profile.skills")
const MANIFEST_HASH = `0x${"77".repeat(32)}` as Hex
const AGENT_KEY = privateKeyToAccount(`0x${"a5".repeat(32)}` as Hex)
const SECRET = new Uint8Array(32).fill(0x42)
const NOW = 1_700_000_000

const AGENT_RECORD: AgentRecord = {
  agentId: AGENT_ID,
  operator: `0x${"22".repeat(20)}` as Address,
  signer: AGENT_KEY.address,
  encryptionPublicKey: `0x${"55".repeat(33)}` as Hex,
  encryptionKeyVersion: 1,
  callbackOriginHash: zeroHash,
  capabilityManifestHash: MANIFEST_HASH,
  capabilityManifestVersion: 1,
  active: true,
}

const AGENT_MANIFEST: SignedAgentCapabilityManifest = {
  manifest: {
    v: 1,
    agentId: AGENT_ID,
    manifestVersion: 1,
    name: "claude-code",
    purposes: [],
    scopeDeclarations: [],
    issuedAt: 1,
  },
  operatorSignature: `0x${"00".repeat(65)}` as Hex,
}

/** The chain's capability row for CAP_ID — matching owner, agent and area, never expiring. */
function capabilityView(over: Partial<CapabilityView> = {}): CapabilityView {
  return {
    owner: OWNER,
    agentId: AGENT_ID,
    namespaceId: NS,
    permissions: 3,
    provenancePolicy: 1,
    issuedAt: 1n,
    expiresAt: 0n,
    agentEpoch: 0n,
    grantedAtReadEpoch: 0n,
    revoked: false,
    ...over,
  }
}

function world() {
  const state = {
    // spies
    getRecordsCalls: [] as Hex[][],
    // store answers
    objects: new Map<string, AnchoredObject[]>(),
    batched: new Map<string, BatchedReadItem[]>(),
    objectsError: null as Error | null,
    batchedListError: null as Error | null,
    objectPartial: false,
    batchedPartial: false,
    denies: [] as RevocationIntentView[],
    deniesError: null as Error | null,
    batchStatus: { enabled: true, batchAnchor: ANCHOR } as { enabled: boolean; batchAnchor: Address } | Error,
    manifests: new Map<string, SignedAgentCapabilityManifest>([[MANIFEST_HASH.toLowerCase(), AGENT_MANIFEST]]),
    manifestsError: null as Error | null,
    // chain answers
    capabilities: new Map<string, CapabilityView>([[CAP_ID.toLowerCase(), capabilityView()]]),
    chainRecords: new Map<string, ContextRecordView>(),
    getRecordsError: null as Error | null,
    batchRoots: new Map<string, Hex>(),
    batchRootsError: null as Error | null,
    // Monad's own placement answers: batchId → the block its anchor mined in, block → its timestamp
    batchBlocks: new Map<string, number>(),
    batchBlocksError: null as Error | null,
    blockTimes: new Map<number, number>(),
    blockTimesError: null as Error | null,
    agentRecords: new Map<string, AgentRecord>([[AGENT_ID.toLowerCase(), AGENT_RECORD]]),
    signerAgents: new Map<string, Hex>([[AGENT_KEY.address.toLowerCase(), AGENT_ID]]),
    // pending-row write checks — key: `${agentId}:${permission}`; absent means authorized
    authorities: new Map<string, boolean>(),
    authorityError: null as Error | null,
  }

  const ports: MePorts = {
    store: {
      listObjects: async ({ namespaceId: ns }) => {
        if (state.objectsError !== null) throw state.objectsError
        return {
          objects: state.objects.get(ns.toLowerCase()) ?? [],
          partial: state.objectPartial,
        }
      },
      listBatchSaves: async ({ namespaceId: ns }) => {
        if (state.batchedListError !== null) throw state.batchedListError
        return { items: state.batched.get(ns.toLowerCase()) ?? [], partial: state.batchedPartial }
      },
      listRevocations: async () => {
        if (state.deniesError !== null) throw state.deniesError
        return state.denies
      },
      batchStatus: async () => {
        if (state.batchStatus instanceof Error) throw state.batchStatus
        return state.batchStatus
      },
      getAgentManifest: async (hash) => {
        if (state.manifestsError !== null) throw state.manifestsError
        const manifest = state.manifests.get(hash.toLowerCase())
        if (manifest === undefined) throw new Error("manifest not stored")
        return manifest
      },
    },
    chain: {
      getCapability: async (capabilityId) => state.capabilities.get(capabilityId.toLowerCase()) ?? null,
      getRecords: async (ids) => {
        state.getRecordsCalls.push([...ids])
        if (state.getRecordsError !== null) throw state.getRecordsError
        return ids.map((id) => state.chainRecords.get(id.toLowerCase()) ?? null)
      },
      batchRoot: async (batchId) => {
        if (state.batchRootsError !== null) throw state.batchRootsError
        return state.batchRoots.get(batchId.toLowerCase()) ?? null
      },
      batchBlock: async (batchId) => {
        if (state.batchBlocksError !== null) throw state.batchBlocksError
        const found = state.batchBlocks.get(batchId.toLowerCase())
        return found === undefined ? null : BigInt(found)
      },
      blockTime: async (block) => {
        if (state.blockTimesError !== null) throw state.blockTimesError
        return state.blockTimes.get(Number(block)) ?? null
      },
      agentIdOfSigner: async (signer) => state.signerAgents.get(signer.toLowerCase()) ?? null,
      getAgent: async (agentId) => state.agentRecords.get(agentId.toLowerCase()) ?? null,
      hasAuthority: async (_owner, agentId, _namespaceId, permission) => {
        if (state.authorityError !== null) throw state.authorityError
        return state.authorities.get(`${agentId.toLowerCase()}:${permission}`) ?? true
      },
    },
  }
  return { state, ports }
}

/** One sealed, signed batched save — the same fixture shape verifyBatchedItem passes on. */
async function makeBatchedItem(
  opts: { anchored?: boolean; owner?: Address; agentId?: Hex; key?: typeof AGENT_KEY; nonce?: Hex } = {},
) {
  const anchored = opts.anchored ?? true
  const owner = opts.owner ?? OWNER
  const agent = opts.agentId ?? AGENT_ID
  const key = opts.key ?? AGENT_KEY
  const objectNonce = opts.nonce ?? (`0x${"99".repeat(32)}` as Hex)
  const contextId = batchContextId({
    chainId: DEPLOYMENT.chainId,
    batchAnchor: ANCHOR,
    owner,
    agentId: agent,
    namespaceId: NS,
    parentId: zeroHash,
    objectNonce,
  })
  const epochKeys = deriveEpochKeyPair(SECRET, 1n)
  const sealed = sealContextObject({
    payload: { v: 1, value: { text: "the batched checkpoint body" }, kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } },
    binding: {
      chainId: DEPLOYMENT.chainId,
      contextRegistry: DEPLOYMENT.contextRegistry,
      contextId,
      namespaceId: NS,
      readEpoch: 1n,
    },
    epochPublicKey: epochKeys.publicKey,
  })
  const message: BatchSaveMessage = {
    owner,
    namespaceId: NS,
    objectNonce,
    lineageId: zeroHash,
    parentId: zeroHash,
    parentVersion: 0,
    rootAuthor: zeroHash,
    manifestHash: sealed.manifestHash,
    ciphertextCommitment: sealed.ciphertextCommitment,
    readEpoch: 1n,
    expiresAt: 0n,
    kind: CONTEXT_KIND.EPISODE,
    provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
  }
  const signature = await key.signTypedData(
    batchSaveTypedData({ chainId: DEPLOYMENT.chainId, batchAnchor: ANCHOR, message }) as never,
  )
  // A new lineage's contract lineageId is the new record's own contextId.
  const lineageId = contextId
  const leaf = batchLeafHash({ contextId, agentId: agent, lineageId, version: 1, structHash: batchSaveStructHash(message) })
  const leaves = [leaf, `0x${"de".repeat(32)}` as Hex]
  const root = merkleRoot(leaves)
  const proof = merkleProof(leaves, 0)
  const item: BatchedReadItem = {
    state: anchored ? "ANCHORED" : "QUEUED",
    save: { message: { ...message, readEpoch: "1", expiresAt: "0" }, signature, manifest: sealed.manifest, ciphertext: hexOf(sealed.ciphertext) },
    contextId,
    receivedAt: (NOW - 60) * 1000,
    ...(anchored ? { batchId: BATCH_ID, position: 0, lineageId, version: 1, proof } : {}),
  }
  return { item, contextId, root, leaf }
}

function makeDirectObject(over: { contextId?: Hex; createdAt?: bigint } = {}) {
  const contextId = over.contextId ?? (`0x${"dd".repeat(32)}` as Hex)
  const epochKeys = deriveEpochKeyPair(SECRET, 1n)
  const sealed = sealContextObject({
    payload: { v: 1, value: { text: "prefers short answers" }, kind: "PREFERENCE", provenance: { source: "USER_ASSERTED" } },
    binding: {
      chainId: DEPLOYMENT.chainId,
      contextRegistry: DEPLOYMENT.contextRegistry,
      contextId,
      namespaceId: NS_SKILLS,
      readEpoch: 1n,
    },
    epochPublicKey: epochKeys.publicKey,
  })
  const obj: AnchoredObject = {
    contextId,
    owner: OWNER,
    namespaceId: NS_SKILLS,
    authorId: zeroHash,
    manifest: sealed.manifest,
    manifestHash: sealed.manifestHash,
    ciphertext: hexOf(sealed.ciphertext),
  }
  const record: ContextRecordView = {
    contextId,
    owner: OWNER,
    author: zeroHash,
    namespaceId: NS_SKILLS,
    lineageId: contextId,
    parentId: zeroHash,
    manifestHash: sealed.manifestHash,
    ciphertextCommitment: sealed.ciphertextCommitment,
    evidenceCommitment: zeroHash,
    readEpoch: 1n,
    createdAt: over.createdAt ?? BigInt(NOW - 3600),
    expiresAt: 0n,
    version: 1,
    recordType: 0,
    lineagePolicy: 0,
    kind: 2,
    provenanceSource: 1,
  }
  return { obj, record }
}

describe("loadMe — batched records verify on their own proof", () => {
  it("a valid ANCHORED batched item is anchored, and its contextId never reaches getRecords", async () => {
    const { state, ports } = world()
    const { item, root, contextId } = await makeBatchedItem()
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root)
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row).toBeDefined()
    expect(row!.lane).toBe("batched")
    expect(row!.state).toBe("anchored")
    expect(row!.batchId).toBe(BATCH_ID)
    expect(row!.authorId).toBe(AGENT_ID)
    expect(row!.authorName).toBe("claude-code")
    // The one rule that keeps the lanes honest: ContextRegistry never sees a batched contextId.
    expect(state.getRecordsCalls.flat()).not.toContain(contextId)
  })

  it("a QUEUED batched item is pending — saved and checked, not yet on Monad", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row).toBeDefined()
    expect(row!.lane).toBe("batched")
    expect(row!.state).toBe("pending")
    expect(row!.authorName).toBe("claude-code")
  })

  it("an ANCHORED item whose proof does not reach the on-chain root is unverified", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem()
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, `0x${"ff".repeat(32)}` as Hex) // a root this leaf cannot reach
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row!.state).toBe("unverified")
  })
})

describe("loadMe — direct records re-verify on ContextRegistry", () => {
  it("a store object with no chain record lists as unverified, not omitted", async () => {
    const { state, ports } = world()
    const { obj } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === obj.contextId)
    expect(row).toBeDefined()
    expect(row!.lane).toBe("direct")
    expect(row!.state).toBe("unverified")
  })

  it("a store object whose chain record matches is anchored", async () => {
    const { state, ports } = world()
    const { obj, record } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    state.chainRecords.set(record.contextId, record)
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === obj.contextId)
    expect(row).toBeDefined()
    expect(row!.state).toBe("anchored")
    expect(row!.lane).toBe("direct")
    expect(row!.source).toBe(1)
    expect(row!.readEpoch).toBe(1n)
  })
})

describe("loadMe — the record list orders by Monad's placement", () => {
  it("two direct records in the same second fall to the contextId — the only order the page can prove", async () => {
    const { state, ports } = world()
    // The page has no source for a direct record's block or log index, so a same-second tie is
    // broken by the contextId alone, the same way on every load.
    const a = makeDirectObject() // 0xdd…
    const b = makeDirectObject({ contextId: `0x${"1c".padEnd(64, "0")}` as Hex, createdAt: BigInt(NOW) })
    a.record.createdAt = BigInt(NOW)
    state.objects.set(NS_SKILLS, [a.obj, b.obj])
    state.chainRecords.set(a.obj.contextId.toLowerCase(), a.record)
    state.chainRecords.set(b.obj.contextId.toLowerCase(), b.record)
    const data = await loadMe(OWNER, ports)
    expect(data.records.map((r) => r.contextId)).toEqual([b.obj.contextId, a.obj.contextId])
  })

  it("an anchored batched row sorts by its anchor block's time, not the store's receivedAt", async () => {
    const { state, ports } = world()
    const { item, contextId, root } = await makeBatchedItem()
    // receivedAt says the store queued it AFTER the direct save's chain time — but the batch
    // anchored in a LATER block, and Monad's stamp is the one that orders the list.
    item.receivedAt = (NOW - 60) * 1000
    const direct = makeDirectObject({ createdAt: BigInt(NOW - 30) })
    state.objects.set(NS_SKILLS, [direct.obj])
    state.chainRecords.set(direct.obj.contextId.toLowerCase(), direct.record)
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root)
    // Monad's own placement: the batch anchored in block 150, stamped NOW.
    state.batchBlocks.set(BATCH_ID.toLowerCase(), 150)
    state.blockTimes.set(150, NOW)
    const data = await loadMe(OWNER, ports)
    expect(data.records.map((r) => r.contextId)).toEqual([contextId, direct.obj.contextId])
    const batchedRow = data.records[0]!
    expect(batchedRow.createdAt).toBe(NOW * 1000)
  })
})

describe("loadMe — incomplete lists stay visible", () => {
  it("a partial listBatchSaves adds the reload banner", async () => {
    const { state, ports } = world()
    state.batchedPartial = true
    const data = await loadMe(OWNER, ports)
    expect(data.incomplete).toContain("list incomplete — the store ran out of chain reads; reload")
  })

})

describe("loadMe — what the page may claim about itself", () => {
  it("the two sentences the page prints name no index", () => {
    expect(AGENTS_NOT_LISTED_TEXT).not.toMatch(/\bindex/i)
    expect(AGENTS_NOT_LISTED_TEXT).toContain("Run mida doctor in your terminal")
    expect(SOURCE_BADGE_TEXT).toBe("Records come from the store and are checked on Monad")
  })

  it("a clean read is not degraded — the badge dot stays calm", async () => {
    const { state, ports } = world()
    const { obj, record } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    state.chainRecords.set(record.contextId, record)
    const data = await loadMe(OWNER, ports)
    expect(data.incomplete).toEqual([])
    expect(data.degraded).toBe(false)
  })

  it("a list incomplete, a check that could not run, or a silent store → degraded, so the dot warns", async () => {
    const partial = world()
    partial.state.batchedPartial = true
    expect((await loadMe(OWNER, partial.ports)).degraded).toBe(true)

    const unchecked = world()
    const { obj } = makeDirectObject()
    unchecked.state.objects.set(NS_SKILLS, [obj])
    unchecked.state.getRecordsError = new Error("rpc down")
    expect((await loadMe(OWNER, unchecked.ports)).degraded).toBe(true)

    const down = world()
    down.state.objectsError = new Error("store down")
    down.state.batchedListError = new Error("store down")
    const data = await loadMe(OWNER, down.ports)
    expect(data.recordsUnavailable).toBe(true)
    expect(data.degraded).toBe(true)
  })
})

describe("loadMe — a record author's name", () => {
  it("a manifest fetch failure degrades to the shortened agent id, never an empty name", async () => {
    const { state, ports } = world()
    state.manifestsError = new Error("store lost the manifest")
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.authorName).toBe("0xaaaa…aaaa")
  })

  it("a failed getAgent call also degrades to the shortened id", async () => {
    const { state, ports } = world()
    state.agentRecords.clear()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.authorName).toBe("0xaaaa…aaaa")
  })

  it("a refused manifest name reads 'an agent with an unreadable name' — /me runs the check itself (in-31 V-4)", async () => {
    // The store's own manifest check can sit inside its cache, so a refused name CAN reach
    // the page. A bidi control inside it would let the name forge or hide part of a rendered
    // line — the page swaps it for the fallback before it is shown on a record's author line.
    const { state, ports } = world()
    state.manifests.set(MANIFEST_HASH.toLowerCase(), {
      ...AGENT_MANIFEST,
      manifest: { ...AGENT_MANIFEST.manifest, name: `hel${String.fromCharCode(0x202a)}per` },
    })
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.authorName).toBe("an agent with an unreadable name")
  })

  it("a name with a straight or look-alike quote falls back too — /me runs the shared name rule (in-32 X-2)", async () => {
    // `"` was never in the old refused set — the page rendered it raw. Under the shared
    // isAcceptableAgentName rule both `"` and its look-alikes (U+201D here) take the fallback.
    for (const bad of [`x" (run by 0xDEAD…BEEF) is asking to:`, `x” (run by 0xDEAD…BEEF) is asking to:`]) {
      const { state, ports } = world()
      state.manifests.set(MANIFEST_HASH.toLowerCase(), {
        ...AGENT_MANIFEST,
        manifest: { ...AGENT_MANIFEST.manifest, name: bad },
      })
      const { item, contextId } = await makeBatchedItem({ anchored: false })
      state.batched.set(NS, [item])
      const data = await loadMe(OWNER, ports)
      expect(data.records.find((r) => r.contextId === contextId)!.authorName).toBe("an agent with an unreadable name")
    }
  })
})

describe("loadMe — a failed chain check is 'unknown', never 'unverified'", () => {
  it("a getRecords RPC failure marks direct rows unknown — the check never ran", async () => {
    const { state, ports } = world()
    const { obj, record } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    state.chainRecords.set(record.contextId, record) // a matching record EXISTS — the read just failed
    state.getRecordsError = new Error("rpc down")
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === obj.contextId)
    expect(row).toBeDefined()
    expect(row!.state).toBe("unknown")
    expect(data.incomplete.some((t) => t.includes("chain record check failed"))).toBe(true)
  })

  it("a getRecords that answered 'no record' stays unverified — the check completed", async () => {
    const { state, ports } = world()
    const { obj } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    // the RPC answered; the contextId is simply not on ContextRegistry — a verdict, not a failure
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === obj.contextId)
    expect(row!.state).toBe("unverified")
  })

  it("a batchRoot RPC failure marks the ANCHORED batched row unknown", async () => {
    const { state, ports } = world()
    const { item, contextId, root } = await makeBatchedItem()
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root) // the root exists — the read just failed
    state.batchRootsError = new Error("rpc down")
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row!.state).toBe("unknown")
  })

  it("a batchRoot answering 'no such root' stays unverified — the check completed", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem()
    state.batched.set(NS, [item])
    // batchRoots holds nothing for BATCH_ID — the chain answered null: the batch is not on Monad
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row!.state).toBe("unverified")
  })

  it("a batched row whose author lookup failed reads 'could not check', not 'unverified'", async () => {
    const { state, ports } = world()
    const { item, contextId, root } = await makeBatchedItem()
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root) // the root exists — the proof could run if the author were known
    // the chain cannot name the signer — the leaf can never be built, so the check never ran
    ports.chain.agentIdOfSigner = () => Promise.reject(new Error("rpc down"))
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row!.state).toBe("unknown")
  })
})

describe("loadMe — a failed listing is not an empty store", () => {
  it("every store listing call failing leaves recordsUnavailable — the empty list is a lie there", async () => {
    const { state, ports } = world()
    state.objectsError = new Error("store down")
    state.batchedListError = new Error("store down")
    const data = await loadMe(OWNER, ports)
    expect(data.records).toEqual([])
    expect(data.recordsUnavailable).toBe(true)
  })

  it("one lane failing while the other listed leaves recordsUnavailable false", async () => {
    const { state, ports } = world()
    state.batchedListError = new Error("store down")
    const { obj } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    const data = await loadMe(OWNER, ports)
    expect(data.recordsUnavailable).toBe(false)
    expect(data.records.length).toBe(1)
    // the missing lane is named — that banner is what hides the page's figures
    expect(data.incomplete.some((t) => t.includes("could not list batched saves"))).toBe(true)
    expect(data.degraded).toBe(true)
  })

  it("a deny list the store could not return is named — a blocked save may read as waiting", async () => {
    const { state, ports } = world()
    state.deniesError = new Error("store down")
    const data = await loadMe(OWNER, ports)
    expect(data.incomplete).toContain(
      "the store's pending-revocation list could not be read — a blocked save may read as waiting",
    )
    expect(data.degraded).toBe(true)
  })
})

describe("loadMe — provenance only rides on verified rows", () => {
  it("an unverified direct row carries no provenance claim", async () => {
    const { state, ports } = world()
    const { obj } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    // The chain holds no such record, so the row carries no provenance at all.
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === obj.contextId)
    expect(row!.state).toBe("unverified")
    expect(row!.source).toBeNull()
  })

  it("an ANCHORED batched save whose signed message names another owner is unverified, whatever the proof", async () => {
    const { state, ports } = world()
    const foreignOwner = `0x${"33".repeat(20)}` as Address
    const { item, contextId, root } = await makeBatchedItem({ owner: foreignOwner })
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root) // the Merkle proof verifies — the row still is not ours
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row).toBeDefined()
    expect(row!.state).toBe("unverified")
  })

  it("a QUEUED batched save naming another owner is unverified, not pending", async () => {
    const { state, ports } = world()
    const foreignOwner = `0x${"33".repeat(20)}` as Address
    const { item, contextId } = await makeBatchedItem({ anchored: false, owner: foreignOwner })
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("unverified")
  })
})

describe("loadMe — one BatchAnchor, the deployment's", () => {
  it("a store advertising a different batch contract marks every batched row unverified and says so", async () => {
    const { state, ports } = world()
    const { item, contextId, root } = await makeBatchedItem()
    const queued = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item, queued.item])
    state.batchRoots.set(BATCH_ID, root) // the proof even verifies — the contract is still not ours
    state.batchStatus = { enabled: true, batchAnchor: `0x${"55".repeat(20)}` as Address }
    const data = await loadMe(OWNER, ports)
    // The anchored item AND the still-queued one — the wrong contract makes both unverifiable.
    const batchedRows = data.records.filter((r) => r.lane === "batched")
    expect(batchedRows).toHaveLength(2)
    expect(batchedRows.every((r) => r.state === "unverified")).toBe(true)
    expect(contextId).toBe(queued.contextId) // same fixture nonce — the pair differs only by state
    expect(data.incomplete.some((t) => t.includes("the store serves a different batch contract"))).toBe(true)
  })

  it("a store advertising the deployment's anchor leaves verification alone", async () => {
    const { state, ports } = world()
    const { item, contextId, root } = await makeBatchedItem()
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root)
    // batchStatus already returns ANCHOR = DEPLOYMENT.batchAnchor — no notice, normal verdict
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("anchored")
    expect(data.incomplete.some((t) => t.includes("different batch contract"))).toBe(false)
  })

  it("a batchStatus failure is not a mismatch — verification still runs on the deployment anchor", async () => {
    const { state, ports } = world()
    const { item, contextId, root } = await makeBatchedItem()
    state.batched.set(NS, [item])
    state.batchRoots.set(BATCH_ID, root)
    state.batchStatus = new Error("status unreadable")
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("anchored")
    expect(data.incomplete.some((t) => t.includes("different batch contract"))).toBe(false)
  })
})

describe("loadMe — a pending save reads blocked when its author cannot write", () => {
  // in-3 I7: while a revoke is pending on Monad the store hold (HELD) or the deny list makes the
  // row "blocked", never "pending"; the same goes for an author Monad itself no longer grants.

  it("a QUEUED save by a deny-listed agent reads blocked", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    state.denies = [
      { intentId: `0x${"09".repeat(32)}`, state: "active", target: { kind: "agent", agentId: AGENT_ID }, agentEpochAtIntent: null } as RevocationIntentView,
    ]
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("blocked")
    // Blocked is not pending — nothing may count it as still waiting.
    expect(data.records.filter((r) => r.state === "pending")).toHaveLength(0)
  })

  it("a HELD save reads blocked on the store's own verdict, deny list or not", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    item.state = "HELD"
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("blocked")
  })

  it("a QUEUED save whose author lost Monad authority reads blocked", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    // The revoke already landed: CREATE is dead for this owner+agent+namespace.
    state.authorities.set(`${AGENT_ID.toLowerCase()}:2`, false) // PERMISSION.CREATE
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("blocked")
  })

  it("a QUEUED save by a live, authorized agent still reads pending", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("pending")
    expect(data.records.filter((r) => r.state === "pending")).toHaveLength(1)
  })

  it("an unrelated agent's QUEUED save stays pending beside a denied one", async () => {
    const { state, ports } = world()
    const OTHER_KEY = privateKeyToAccount(`0x${"b6".repeat(32)}` as Hex)
    const denied = await makeBatchedItem({ anchored: false })
    const other = await makeBatchedItem({
      anchored: false,
      key: OTHER_KEY,
      agentId: OTHER_ID,
      nonce: `0x${"88".repeat(32)}` as Hex,
    })
    state.signerAgents.set(OTHER_KEY.address.toLowerCase(), OTHER_ID)
    state.batched.set(NS, [denied.item, other.item])
    state.denies = [
      { intentId: `0x${"09".repeat(32)}`, state: "active", target: { kind: "agent", agentId: AGENT_ID }, agentEpochAtIntent: null } as RevocationIntentView,
    ]
    const data = await loadMe(OWNER, ports)
    const rows = data.records.filter((r) => r.lane === "batched")
    expect(rows.find((r) => r.contextId === denied.contextId)!.state).toBe("blocked")
    expect(rows.find((r) => r.contextId === other.contextId)!.state).toBe("pending")
  })

  it("a capability-level deny blocks the save of the agent it names", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    state.denies = [
      { intentId: `0x${"09".repeat(32)}`, state: "active", target: { kind: "capability", capabilityId: CAP_ID }, agentEpochAtIntent: null } as RevocationIntentView,
    ]
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("blocked")
  })

  it("a capability deny for another agent does not block this save", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    // CAP2_ID belongs to a different agent — the deny row resolves away from this author.
    state.capabilities.set(CAP2_ID.toLowerCase(), capabilityView({ agentId: OTHER_ID }))
    state.denies = [
      { intentId: `0x${"09".repeat(32)}`, state: "active", target: { kind: "capability", capabilityId: CAP2_ID }, agentEpochAtIntent: null } as RevocationIntentView,
    ]
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("pending")
  })

  it("a hasAuthority RPC failure reads unknown — the check never ran", async () => {
    const { state, ports } = world()
    const { item, contextId } = await makeBatchedItem({ anchored: false })
    state.batched.set(NS, [item])
    state.authorityError = new Error("rpc down")
    const data = await loadMe(OWNER, ports)
    expect(data.records.find((r) => r.contextId === contextId)!.state).toBe("unknown")
  })
})
