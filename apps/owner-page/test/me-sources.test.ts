// Task 3's /me sources layer. The page loads index-first with a chain-log fallback for agents;
// every direct object is re-proven against ContextRegistry, and every batched save is proven on
// its own Merkle proof — a batched contextId must never reach ContextRegistry. All three ports
// are in-memory fakes: no network, no real store. The batched fixtures are really signed — the
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
import type { AnchoredObject, BatchedReadItem, ContextRecordView, RevocationIntentView } from "@mida/api"
import { DEPLOYMENT } from "../src/owner/core.js"
import { AGENTS_QUERY, BATCHED_QUERY, COUNTS_QUERY, loadMe } from "../src/me/sources.js"
import type { GrantLog, MePorts } from "../src/me/sources.js"

const OWNER = `0x${"11".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const OTHER_ID = `0x${"bb".repeat(32)}` as Hex
const CAP_ID = `0x${"c1".padStart(64, "0")}` as Hex
const CAP2_ID = `0x${"c2".padStart(64, "0")}` as Hex
const BATCH_ID = `0x${"b5".repeat(32)}` as Hex
const ANCHOR = DEPLOYMENT.batchAnchor as Address
const NS = namespaceId("projects.current")
const NS_SKILLS = namespaceId("profile.skills")
const TX1 = `0x${"01".repeat(32)}` as Hex
const TX2 = `0x${"02".repeat(32)}` as Hex
const TX3 = `0x${"03".repeat(32)}` as Hex
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

function grantRow(over: Record<string, unknown> = {}) {
  return {
    id: CAP_ID,
    agent: AGENT_ID,
    namespaceId: NS,
    permissions: 3, // READ | CREATE
    provenancePolicy: 1,
    expiresAt: "9999999999",
    grantedBlock: 100,
    revokedBlock: null,
    revokedBy: null,
    txHash: TX1,
    ...over,
  }
}

// --- Hasura strictness ------------------------------------------------------------------------
// Envio serves Hasura-flavoured GraphQL: a LIST field takes where/limit/order_by/offset/
// distinct_on and answers an ARRAY; a single row is `<Entity>_by_pk(id: ...)`. The fake index
// enforces both halves — a query calling a list field with `id:` is rejected before it is
// answered, and an answer carrying an object where an array belongs is rejected too — so the
// old `GlobalStats(id: "global")` / `Owner(id: $owner)` forms can never pass here.
const LIST_FIELD_ARGS = new Set(["where", "limit", "order_by", "offset", "distinct_on"])

function checkQueryShape(gql: string): void {
  for (const match of gql.matchAll(/([A-Za-z_]\w*)\s*\(([^()]*)\)/g)) {
    const field = match[1]!
    const args = match[2]!
    // the operation header itself — `query MeAgents($owner: ...)` — is not a field call
    const before = gql.slice(0, match.index).trimEnd()
    if (/(^|\s)(query|mutation|subscription)$/.test(before)) continue
    for (const arg of args.split(",")) {
      const name = arg.split(":")[0]!.trim()
      if (name.length === 0) continue
      if (name === "id") {
        if (!field.endsWith("_by_pk")) throw new Error(`${field} is a list field — id: is not a valid argument (use ${field}_by_pk or where)`)
      } else if (!LIST_FIELD_ARGS.has(name)) {
        throw new Error(`${field} called with non-Hasura argument "${name}"`)
      }
    }
  }
}

function checkAnswerShape(answer: unknown): void {
  if (answer === null || typeof answer !== "object") return
  for (const [key, value] of Object.entries(answer)) {
    if (value === undefined || value === null) continue
    if (key.endsWith("_by_pk")) {
      if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must answer one object, not an array`)
    } else if (!Array.isArray(value)) {
      throw new Error(`${key} is a list field — it must answer an array`)
    }
  }
}

function world() {
  const state = {
    // spies
    getRecordsCalls: [] as Hex[][],
    // index answers — undefined keys mean "query throws"
    indexFails: false,
    indexAbsent: false,
    agentsResult: {
      Grant: [grantRow()],
      Revocation: [] as unknown[],
      _meta: [{ chainId: Number(DEPLOYMENT.chainId), progressBlock: 999, sourceBlock: 1000, isReady: true }],
    } as unknown,
    batchedResult: { BatchedSave: [] as unknown[], Agent: [{ id: AGENT_ID, signer: AGENT_KEY.address }] } as unknown,
    countsResult: {
      Owner_by_pk: { records: 1, batchedSaves: 1 },
      ContextRecord: [] as unknown[],
    } as unknown,
    // store answers
    objects: new Map<string, AnchoredObject[]>(),
    batched: new Map<string, BatchedReadItem[]>(),
    objectPartial: false,
    batchedPartial: false,
    denies: [] as RevocationIntentView[],
    deniesError: null as Error | null,
    batchStatus: { enabled: true, batchAnchor: ANCHOR } as { enabled: boolean; batchAnchor: Address } | Error,
    manifests: new Map<string, SignedAgentCapabilityManifest>([[MANIFEST_HASH.toLowerCase(), AGENT_MANIFEST]]),
    manifestsError: null as Error | null,
    // chain answers
    validCaps: new Map<string, boolean>([[CAP_ID.toLowerCase(), true]]),
    chainRecords: new Map<string, ContextRecordView>(),
    batchRoots: new Map<string, Hex>(),
    grantLogs: [] as GrantLog[],
    grantLogsError: null as Error | null,
    agentRecords: new Map<string, AgentRecord>([[AGENT_ID.toLowerCase(), AGENT_RECORD]]),
    signerAgents: new Map<string, Hex>([[AGENT_KEY.address.toLowerCase(), AGENT_ID]]),
    chainTime: NOW + 5,
  }

  const ports: MePorts = {
    index: state.indexAbsent
      ? null
      : {
          query: async <T>(gql: string): Promise<T> => {
            if (state.indexFails) throw new Error("index down")
            checkQueryShape(gql)
            const answer =
              gql === AGENTS_QUERY ? state.agentsResult
              : gql === BATCHED_QUERY ? state.batchedResult
              : gql === COUNTS_QUERY ? state.countsResult
              : null
            if (answer === null) throw new Error(`unexpected index query: ${gql.slice(0, 40)}`)
            checkAnswerShape(answer)
            return answer as T
          },
        },
    store: {
      listObjects: async ({ namespaceId: ns }) => ({
        objects: state.objects.get(ns.toLowerCase()) ?? [],
        partial: state.objectPartial,
      }),
      listBatchSaves: async ({ namespaceId: ns }) => ({
        items: state.batched.get(ns.toLowerCase()) ?? [],
        partial: state.batchedPartial,
      }),
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
      isCapabilityValid: async (capabilityId) => state.validCaps.get(capabilityId.toLowerCase()) ?? false,
      getRecords: async (ids) => {
        state.getRecordsCalls.push([...ids])
        return ids.map((id) => state.chainRecords.get(id.toLowerCase()) ?? null)
      },
      batchRoot: async (batchId) => state.batchRoots.get(batchId.toLowerCase()) ?? null,
      ownerGrantLogs: async () => {
        if (state.grantLogsError !== null) throw state.grantLogsError
        return state.grantLogs
      },
      agentIdOfSigner: async (signer) => state.signerAgents.get(signer.toLowerCase()) ?? null,
      getAgent: async (agentId) => state.agentRecords.get(agentId.toLowerCase()) ?? null,
      latestTimestamp: async () => state.chainTime,
    },
  }
  return { state, ports }
}

/** One sealed, signed batched save — the same fixture shape verifyBatchedItem passes on. */
async function makeBatchedItem(opts: { anchored: boolean } = { anchored: true }) {
  const objectNonce = `0x${"99".repeat(32)}` as Hex
  const contextId = batchContextId({
    chainId: DEPLOYMENT.chainId,
    batchAnchor: ANCHOR,
    owner: OWNER,
    agentId: AGENT_ID,
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
    owner: OWNER,
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
  const signature = await AGENT_KEY.signTypedData(
    batchSaveTypedData({ chainId: DEPLOYMENT.chainId, batchAnchor: ANCHOR, message }) as never,
  )
  // A new lineage's contract lineageId is the new record's own contextId.
  const lineageId = contextId
  const leaf = batchLeafHash({ contextId, agentId: AGENT_ID, lineageId, version: 1, structHash: batchSaveStructHash(message) })
  const leaves = [leaf, `0x${"de".repeat(32)}` as Hex]
  const root = merkleRoot(leaves)
  const proof = merkleProof(leaves, 0)
  const item: BatchedReadItem = {
    state: opts.anchored ? "ANCHORED" : "QUEUED",
    save: { message: { ...message, readEpoch: "1", expiresAt: "0" }, signature, manifest: sealed.manifest, ciphertext: hexOf(sealed.ciphertext) },
    contextId,
    receivedAt: (NOW - 60) * 1000,
    ...(opts.anchored ? { batchId: BATCH_ID, position: 0, lineageId, version: 1, proof } : {}),
  }
  return { item, contextId, root, leaf }
}

function makeDirectObject() {
  const contextId = `0x${"dd".repeat(32)}` as Hex
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
    createdAt: BigInt(NOW - 3600),
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
    state.batchedResult = {
      BatchedSave: [{ id: contextId, namespaceId: NS, batchId: BATCH_ID, position: 0, lineageId: contextId, version: 1, agentId: AGENT_ID, block: 150, txHash: TX2 }],
      Agent: [{ id: AGENT_ID, signer: AGENT_KEY.address }],
    }
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === contextId)
    expect(row).toBeDefined()
    expect(row!.lane).toBe("batched")
    expect(row!.state).toBe("anchored")
    expect(row!.batchId).toBe(BATCH_ID)
    expect(row!.tx).toBe(TX2)
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

  it("a store object whose chain record matches is anchored, with index tx attached", async () => {
    const { state, ports } = world()
    const { obj, record } = makeDirectObject()
    state.objects.set(NS_SKILLS, [obj])
    state.chainRecords.set(record.contextId, record)
    state.countsResult = {
      Owner_by_pk: { records: 1, batchedSaves: 0 },
      ContextRecord: [{ id: record.contextId, namespaceId: NS_SKILLS, provenanceSource: 1, createdAt: String(NOW - 3600), txHash: TX3 }],
    }
    const data = await loadMe(OWNER, ports)
    const row = data.records.find((r) => r.contextId === obj.contextId)
    expect(row).toBeDefined()
    expect(row!.state).toBe("anchored")
    expect(row!.lane).toBe("direct")
    expect(row!.source).toBe(1)
    expect(row!.tx).toBe(TX3)
    expect(row!.readEpoch).toBe(1n)
  })
})

describe("loadMe — incomplete lists and index contradictions stay visible", () => {
  it("a partial listBatchSaves adds the reload banner and hides counts", async () => {
    const { state, ports } = world()
    state.batchedPartial = true
    const data = await loadMe(OWNER, ports)
    expect(data.incomplete).toContain("list incomplete — the store ran out of chain reads; reload")
    expect(data.counts).toBeNull()
  })

  it("a grant the index calls live but the chain calls invalid is flagged, not live", async () => {
    const { state, ports } = world()
    state.validCaps.set(CAP_ID, false)
    const data = await loadMe(OWNER, ports)
    const agent = data.agents.find((a) => a.agentId === AGENT_ID)
    expect(agent).toBeDefined()
    const grant = agent!.grants.find((g) => g.capabilityId === CAP_ID)
    expect(grant).toBeDefined()
    expect(grant!.status.label).toBe("Expired or revoked on Monad")
    expect(grant!.status.flagged).toBe(true)
    expect(agent!.readLive).toBe(false)
  })

  it("an active store deny blocks the agent even while the chain grant is live", async () => {
    const { state, ports } = world()
    state.denies = [
      { intentId: `0x${"d1".repeat(32)}` as Hex, state: "active", target: { kind: "agent", agentId: AGENT_ID }, agentEpochAtIntent: "1" },
    ]
    const data = await loadMe(OWNER, ports)
    const agent = data.agents.find((a) => a.agentId === AGENT_ID)
    expect(agent!.blockedAtStore).toBe(true)
    expect(agent!.readLive).toBe(false)
    // The chain still says the grant is valid — the page shows both facts, not a merged fiction.
    expect(agent!.grants[0]!.status.label).toBe("Can read")
  })
})

describe("the index queries are Hasura-shaped", () => {
  it("every exported query uses only where/limit/order_by on list fields, id: only on _by_pk, and _meta for progress", () => {
    for (const gql of [AGENTS_QUERY, BATCHED_QUERY, COUNTS_QUERY]) {
      expect(() => checkQueryShape(gql)).not.toThrow()
    }
    // the regression this guard exists for: a list field must never be called with id:
    expect(() => checkQueryShape(`query X { GlobalStats(id: "global") { lastTimestamp } }`)).toThrow(/list field/)
    expect(() => checkQueryShape(`query X($owner: String!) { Owner(id: $owner) { records } }`)).toThrow(/list field/)
    // and the allowed forms do pass: _by_pk, where/limit/order_by, and the bare _meta list
    expect(() => checkQueryShape(`query X($owner: String!) { Owner_by_pk(id: $owner) { records } }`)).not.toThrow()
    expect(() => checkQueryShape(`query X { _meta { chainId progressBlock sourceBlock isReady } }`)).not.toThrow()
  })

  it("index lag comes from _meta's own progress — blocks behind, read as seconds at ~0.4 s/block", async () => {
    const { state, ports } = world()
    state.agentsResult = {
      ...(state.agentsResult as object),
      _meta: [{ chainId: Number(DEPLOYMENT.chainId), progressBlock: 1000 - 25, sourceBlock: 1000, isReady: true }],
    }
    const data = await loadMe(OWNER, ports)
    // 25 blocks at ~0.4 s/block ≈ 10 s
    expect(data.lag).toEqual({ text: "≈ 10 s behind Monad", stale: false })
    expect(data.source).toBe("index")
  })

  it("an index more than 150 blocks behind reports stale", async () => {
    const { state, ports } = world()
    state.agentsResult = {
      ...(state.agentsResult as object),
      _meta: [{ chainId: Number(DEPLOYMENT.chainId), progressBlock: 1000 - 400, sourceBlock: 1000, isReady: true }],
    }
    const data = await loadMe(OWNER, ports)
    expect(data.lag.stale).toBe(true)
    expect(data.lag.text).toBe("≈ 160 s behind Monad")
  })
})

describe("loadMe — chain-log fallback and names", () => {
  it("when the index is down, agents come from ownerGrantLogs", async () => {
    const { state, ports } = world()
    state.indexFails = true
    state.grantLogs = [
      { kind: "granted", agentId: AGENT_ID, capabilityId: CAP_ID, namespaceId: NS, permissions: 3, block: 100, txHash: TX1 },
      { kind: "granted", agentId: OTHER_ID, capabilityId: CAP2_ID, namespaceId: NS, permissions: 1, block: 101, txHash: TX2 },
      { kind: "revoked", agentId: OTHER_ID, capabilityId: null, namespaceId: null, permissions: null, block: 102, txHash: TX3 },
    ]
    state.validCaps.set(CAP_ID, true)
    state.validCaps.set(CAP2_ID, false)
    const data = await loadMe(OWNER, ports)
    expect(data.source).toBe("chain-logs")
    expect(data.counts).toBeNull()
    expect(data.lag.text).toBe("index unavailable")
    const live = data.agents.find((a) => a.agentId === AGENT_ID)
    expect(live).toBeDefined()
    expect(live!.grants[0]!.capabilityId).toBe(CAP_ID)
    expect(live!.grants[0]!.status.label).toBe("Can read")
    expect(live!.readLive).toBe(true)
    const dead = data.agents.find((a) => a.agentId === OTHER_ID)
    expect(dead).toBeDefined()
    expect(dead!.grants[0]!.status.label).toBe("Revoked")
    expect(dead!.revokedTx).toBe(TX3)
    expect(dead!.readLive).toBe(false)
  })

  it("a manifest fetch failure degrades to the shortened agent id, never an empty name", async () => {
    const { state, ports } = world()
    state.manifestsError = new Error("store lost the manifest")
    const data = await loadMe(OWNER, ports)
    const agent = data.agents.find((a) => a.agentId === AGENT_ID)
    expect(agent!.name).toBe("0xaaaa…aaaa")
    expect(agent!.name.length).toBeGreaterThan(0)
  })

  it("a failed getAgent call also degrades to the shortened id", async () => {
    const { state, ports } = world()
    state.agentRecords.clear()
    const data = await loadMe(OWNER, ports)
    const agent = data.agents.find((a) => a.agentId === AGENT_ID)
    expect(agent!.name).toBe("0xaaaa…aaaa")
    expect(agent!.name.length).toBeGreaterThan(0)
  })
})
