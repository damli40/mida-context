// Plan Task 8: the batched lane's readers. readCheckpoints merges the batch table's anchored and
// verified-pending saves into the checkpoint list — marked anchor "ANCHORED"/"PENDING_ANCHOR",
// flush-on-switch when a pending save belongs to another agent. The handoff renders a pending
// save as its own marked block inside the fence, never as saved state. readOwnerUniverse adds
// the owner's SaveAnchored logs, each row verified and decrypted like a direct record. migrate's
// hasBatchedSaves guard refuses fail-closed. All of it runs on fakes: a stub HTTP store answers
// /batch/status and /batch/flush; the agent and chain are plain objects — no anvil, no server.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zeroHash } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  CONTEXT_KIND,
  PROVENANCE_SOURCE,
  batchContextId,
  batchLeafHash,
  batchSaveStructHash,
  namespaceId,
} from "@mida/protocol"
import type { Address, BatchSaveMessage, ContextPayload, Hex } from "@mida/protocol"
import { deriveEpochKeyPair, hexOf, sealContextObject } from "@mida/crypto"
import { parseDeployment } from "@mida/chain"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"
import { signBatchSave } from "@mida/sdk"
import type { BatchedReadItem } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import {
  MidaHome,
  buildHandoff,
  migrate,
  readCheckpoints,
  readOwnerUniverse,
  saveAgentIdentity,
  saveOwnerAddress,
  saveOwnerMode,
  wrapCheckpoint,
} from "@mida/midad"
import type { HandoffDeps, Network, Runtime, ServiceRuntime } from "@mida/midad"
import { PENDING_ANCHOR_LINE } from "../src/handoff.js"
import type { StoredCheckpoint } from "../src/skeleton.js"
import { sampleCheckpoint } from "./helpers.js"

const dir = () => mkdtempSync(join(tmpdir(), "mida-batch-readers-"))

const OWNER = `0x${"11".repeat(20)}` as Address
const ANCHOR = "0x4444444444444444444444444444444444444444" as Address
const MY_AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const OTHER_AGENT_ID = `0x${"bb".repeat(32)}` as Hex
const NS = namespaceId("goals.career")

const DEPLOYMENT_RAW = {
  chainId: "31337",
  capabilityRegistry: "0x2222222222222222222222222222222222222222",
  contextRegistry: "0x3333333333333333333333333333333333333333",
  deploymentBlock: "0",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"55".repeat(32)}`,
  policyHashV1: POLICY_HASH_V1,
}
const DEPLOYMENT = parseDeployment(DEPLOYMENT_RAW)
const DEPLOYMENT_BATCHED_RAW = { ...DEPLOYMENT_RAW, batchAnchor: ANCHOR, batchAnchorBlock: "7" }
const DEPLOYMENT_BATCHED = parseDeployment(DEPLOYMENT_BATCHED_RAW)

/** A hosted-store stub: /batch/status from `status`, and a counting POST /batch/flush. */
async function stubStore(status: { enabled: boolean; batchAnchor: string } = { enabled: true, batchAnchor: ANCHOR }): Promise<{
  url: string
  flushes: number
  paths: string[]
  close(): Promise<void>
}> {
  const flushes = { count: 0 }
  const paths: string[] = []
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub")
    paths.push(`${req.method} ${url.pathname}`)
    res.setHeader("content-type", "application/json")
    if (req.method === "GET" && url.pathname === "/batch/status") {
      res.end(JSON.stringify(status))
      return
    }
    if (req.method === "POST" && url.pathname === "/batch/flush") {
      flushes.count += 1
      res.end(JSON.stringify({ flushed: true }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ code: "not-found", error: "no such route" }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    get flushes() {
      return flushes.count
    },
    paths,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

/** The JSON-RPC calls resolveNetwork's chainId probe makes. */
async function stubRpc(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createHttpServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string }
      const reply = (result: unknown) => {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
      }
      if (call.method === "eth_chainId") return reply("0x7a69")
      if (call.method === "eth_blockNumber") return reply("0x64")
      return reply("0x")
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
}

/** The reader agent's identity — the pending item's authorAgentId is compared against it. */
function writeIdentity(home: MidaHome, name: string, agentId: Hex = MY_AGENT_ID): void {
  saveAgentIdentity(home, {
    name,
    agentId,
    signerPrivateKey: `0x${"12".repeat(32)}` as Hex,
    encryptionPrivateKey: `0x${"22".repeat(32)}` as Hex,
    encryptionPublicKey: `0x${"33".repeat(32)}` as Hex,
    callbackOrigin: "https://callback.example",
    purposeId: "general_assistance",
    manifest: {} as never,
    manifestHash: `0x${"77".repeat(32)}` as Hex,
  })
}

/** The ServiceRuntime shape readCheckpoints reads — agent and store are injected fakes. */
function fakeRuntime(home: MidaHome, over: { network?: Network; apiBaseUrl?: string; agent?: unknown } = {}): ServiceRuntime {
  return {
    home,
    owner: OWNER,
    network: over.network,
    apiBaseUrl: over.apiBaseUrl ?? "http://127.0.0.1:1",
    agent: () => over.agent,
    chain: { deployment: over.network?.deployment },
    close: async () => {},
  } as unknown as ServiceRuntime
}

const batchedNetwork = (storageUrl: string): Network =>
  ({ rpcUrl: "http://127.0.0.1:1", deployment: DEPLOYMENT_BATCHED, storageUrl }) as Network

const ENVELOPE = (eventId: string) =>
  wrapCheckpoint({
    projectId: "p-1",
    sessionId: "s1",
    continuesSession: null,
    compiledBy: "test",
    checkpoint: sampleCheckpoint({ eventId, objective: `objective-${eventId}` }),
  })

/** A ContextObject-shaped row the way agent.readBatchedWithStatus returns it. */
const anchoredObject = (contextId: Hex, eventId: string) => ({
  contextId,
  owner: OWNER,
  namespace: "goals.career",
  namespaceId: NS,
  authorId: MY_AGENT_ID,
  lineageId: contextId,
  parentId: zeroHash,
  version: 1,
  readEpoch: 1n,
  recordType: 0,
  payload: { v: 1, value: ENVELOPE(eventId), kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } },
})

const pendingItem = (contextId: Hex, eventId: string, authorAgentId: Hex) => ({
  ...anchoredObject(contextId, eventId),
  authorId: authorAgentId,
  anchor: "PENDING_ANCHOR" as const,
  authorAgentId,
})

const emptyBatched = { anchored: [], pending: [], skipped: [], partial: false }

const batchedHome = (storeUrl: string) => {
  const home = new MidaHome(dir())
  writeIdentity(home, "claude-code")
  home.writeSecretJson("network.json", {
    rpcUrl: "http://127.0.0.1:1",
    deployment: DEPLOYMENT_BATCHED_RAW,
    storageUrl: storeUrl,
    batching: true,
  })
  return home
}

describe("readCheckpoints — the batched lane's records merge in, marked", () => {
  it("an anchored batched save merges with anchor ANCHORED", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const contextId = `0x${"c1".repeat(32)}` as Hex
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => ({ ...emptyBatched, anchored: [anchoredObject(contextId, "cp-anchored")] }),
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(false)
      expect(result.skipped).toBe(0)
      expect(result.checkpoints).toHaveLength(1)
      expect(result.checkpoints[0]).toMatchObject({ contextId, anchor: "ANCHORED" })
      expect(result.checkpoints[0]!.checkpoint.objective).toBe("objective-cp-anchored")
    } finally {
      await store.close()
    }
  })

  it("an item the SDK could not verify counts into skipped, and a non-checkpoint payload does too", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const badPayload = { ...anchoredObject(`0x${"c2".repeat(32)}` as Hex, "cp-badrow"), payload: { v: 1, value: { not: "a checkpoint" } } }
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => ({
          anchored: [badPayload],
          pending: [],
          skipped: [{ contextId: `0x${"c3".repeat(32)}` as Hex, reason: "proof" }],
          partial: false,
        }),
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.checkpoints).toHaveLength(0)
      expect(result.skipped).toBe(2)
    } finally {
      await store.close()
    }
  })

  it("a pending save from the reading agent itself is PENDING_ANCHOR and never flushes", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const contextId = `0x${"d1".repeat(32)}` as Hex
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => ({ ...emptyBatched, pending: [pendingItem(contextId, "cp-own-001", MY_AGENT_ID)] }),
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1", { flushWaitMs: 300 })
      expect(result.checkpoints).toEqual([expect.objectContaining({ contextId, anchor: "PENDING_ANCHOR" })])
      expect(store.flushes).toBe(0)
    } finally {
      await store.close()
    }
  })

  it("a pending save from ANOTHER agent asks the store to flush — once", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const contextId = `0x${"d2".repeat(32)}` as Hex
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => ({ ...emptyBatched, pending: [pendingItem(contextId, "cp-foreign", OTHER_AGENT_ID)] }),
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1", { flushWaitMs: 300 })
      expect(result.checkpoints).toEqual([expect.objectContaining({ contextId, anchor: "PENDING_ANCHOR" })])
      expect(store.paths.filter((p) => p === "POST /batch/flush")).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it("a foreign pending save that anchors during the wait comes back ANCHORED", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const contextId = `0x${"d3".repeat(32)}` as Hex
      let reads = 0
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => {
          reads += 1
          return reads === 1
            ? { ...emptyBatched, pending: [pendingItem(contextId, "cp-foreign", OTHER_AGENT_ID)] }
            : { ...emptyBatched, anchored: [anchoredObject(contextId, "cp-foreign")] }
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1", { flushWaitMs: 1_000 })
      expect(result.checkpoints).toEqual([expect.objectContaining({ contextId, anchor: "ANCHORED" })])
      expect(store.flushes).toBe(1)
      expect(reads).toBeGreaterThan(1)
    } finally {
      await store.close()
    }
  })

  it("a foreign pending save that never anchors stays PENDING_ANCHOR once flushWaitMs is spent", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const contextId = `0x${"d4".repeat(32)}` as Hex
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => ({ ...emptyBatched, pending: [pendingItem(contextId, "cp-foreign", OTHER_AGENT_ID)] }),
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const started = Date.now()
      const result = await readCheckpoints(runtime, "claude-code", "p-1", { flushWaitMs: 300 })
      expect(Date.now() - started).toBeGreaterThanOrEqual(280)
      expect(result.checkpoints).toEqual([expect.objectContaining({ contextId, anchor: "PENDING_ANCHOR" })])
      expect(store.flushes).toBe(1)
    } finally {
      await store.close()
    }
  })

  it("a batched read that fails marks the result partial — never silently empty", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => {
          throw new Error("batch table blew up")
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(true)
      expect(result.checkpoints).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("a store that serves no batch surface is not treated as a missing batch table", async () => {
    // the deployment carries an anchor, but this store answers no /batch/status — a local or
    // pre-batch host — so there is no table to miss and nothing is partial
    const store = createHttpServer((_req, res) => {
      res.statusCode = 404
      res.end(JSON.stringify({ code: "not-found" }))
    })
    await new Promise<void>((resolve, reject) => {
      store.once("error", reject)
      store.listen(0, "127.0.0.1", resolve)
    })
    const url = `http://127.0.0.1:${(store.address() as AddressInfo).port}`
    try {
      const home = batchedHome(url)
      let batchedReads = 0
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => {
          batchedReads += 1
          return emptyBatched
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(url), apiBaseUrl: url, agent })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(false)
      expect(batchedReads).toBe(0)
    } finally {
      await new Promise<void>((done) => store.close(() => done()))
    }
  })
})

describe("buildHandoff — a pending save is marked, never called saved", () => {
  const runtime = {} as ServiceRuntime
  const input = { agent: "codex", cwd: "/tmp/work", authorNames: { [OTHER_AGENT_ID.toLowerCase()]: "claude-code" } }
  const deps = (checkpoints: StoredCheckpoint[]): HandoffDeps => ({
    checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
    capability: async () => "live",
    read: async () => ({ checkpoints, skipped: 0, milliseconds: 1, partial: false }),
    readFacts: async () => [],
  })
  const stored = (over: Partial<StoredCheckpoint> = {}): StoredCheckpoint => ({
    checkpoint: sampleCheckpoint({ eventId: "cp-h", objective: "the pending objective" }),
    projectId: "p1",
    sessionId: "s1",
    continuesSession: null,
    compiledBy: "test",
    contextId: `0x${"1".repeat(64)}` as Hex,
    authorId: OTHER_AGENT_ID,
    namespaceId: `0x${"2".repeat(64)}` as Hex,
    ...over,
  })

  it("a pending-only read renders the exact marker directly above the record's content", async () => {
    const pending = stored({ anchor: "PENDING_ANCHOR" })
    const result = await buildHandoff(runtime, input, deps([pending]))
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    const insideFence = result.text.split("=== BEGIN MIDA HANDOFF DATA ===")[1]!.split("=== END MIDA HANDOFF DATA ===")[0]!
    // the marker sits directly above the block's own "from" line
    expect(insideFence).toContain(`${PENDING_ANCHOR_LINE}\nfrom claude-code`)
    expect(insideFence).toContain("objective: the pending objective")
    // the pending record is never described as saved — the preamble drops the word entirely
    expect(result.text).not.toContain("saved working state")
    expect(result.text).not.toContain("Saved by")
  })

  it("an anchored-only read carries no pending marker and keeps the saved-state preamble", async () => {
    const result = await buildHandoff(runtime, input, deps([stored({ anchor: "ANCHORED" })]))
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).not.toContain("PENDING_ANCHOR")
    expect(result.text).toContain("is saved working state")
  })

  it("a mixed read marks only the pending block — the merge keeps its saved-state meaning", async () => {
    const anchored = stored({ contextId: `0x${"3".repeat(64)}` as Hex, anchor: "ANCHORED" })
    const pending = stored({ contextId: `0x${"4".repeat(64)}` as Hex, anchor: "PENDING_ANCHOR" })
    const result = await buildHandoff(runtime, input, deps([anchored, pending]))
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    const insideFence = result.text.split("=== BEGIN MIDA HANDOFF DATA ===")[1]!.split("=== END MIDA HANDOFF DATA ===")[0]!
    expect(insideFence).toContain(`${PENDING_ANCHOR_LINE}\nfrom claude-code`)
    // the marker appears once — over the pending block, never in the merged sections
    expect(result.text.split(PENDING_ANCHOR_LINE)).toHaveLength(2)
    expect(result.text).not.toContain("is saved working state")
    // the pending contextId is marked-covered but the "Saved by" line names only anchored authors
    expect(result.seen).toContain(pending.contextId)
    expect(result.savedBy).toBe("claude-code")
  })
})

describe("readOwnerUniverse — the batched half of the history", () => {
  const AGENT_SIGNER = privateKeyToAccount(generatePrivateKey())
  const SECRET = new Uint8Array(32).fill(0x42)
  const BATCH_ID = `0x${"b5".repeat(32)}` as Hex
  const BLOCK = 9n
  const BLOCK_TIME = 1_700_000_000n

  /** One sealed, signed, anchored batch save — the full fixture verifyBatchedItem can pass on. */
  async function makeAnchored() {
    const objectNonce = hexOf(randomBytes(32))
    const contextId = batchContextId({
      chainId: DEPLOYMENT_BATCHED.chainId,
      batchAnchor: ANCHOR,
      owner: OWNER,
      agentId: MY_AGENT_ID,
      namespaceId: NS,
      parentId: zeroHash,
      objectNonce,
    })
    const readEpoch = 1n
    const epochKeys = deriveEpochKeyPair(SECRET, readEpoch)
    const payload: ContextPayload = { v: 1, value: { text: "the batched checkpoint body" }, kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } }
    const sealed = sealContextObject({
      payload,
      binding: { chainId: DEPLOYMENT_BATCHED.chainId, contextRegistry: DEPLOYMENT_BATCHED.contextRegistry, contextId, namespaceId: NS, readEpoch },
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
      readEpoch,
      expiresAt: 0n,
      kind: CONTEXT_KIND.EPISODE,
      provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
    }
    const signature = await signBatchSave({ account: AGENT_SIGNER, chainId: DEPLOYMENT_BATCHED.chainId, batchAnchor: ANCHOR, message })
    // a new lineage's contract lineageId is the new record's own contextId
    const lineageId = contextId
    const leaf = batchLeafHash({ contextId, agentId: MY_AGENT_ID, lineageId, version: 1, structHash: batchSaveStructHash(message) })
    const item: BatchedReadItem = {
      state: "ANCHORED",
      save: { message: { ...message, readEpoch: "1", expiresAt: "0" }, signature, manifest: sealed.manifest, ciphertext: hexOf(sealed.ciphertext) },
      contextId,
      receivedAt: 1_700_000_000_000,
      batchId: BATCH_ID,
      position: 0,
      lineageId,
      version: 1,
      proof: [],
    }
    const log = {
      args: { owner: OWNER, contextId, namespaceId: NS, batchId: BATCH_ID, lineageId, version: 1, author: MY_AGENT_ID, position: 0, leafHash: leaf },
      blockNumber: BLOCK,
      transactionHash: `0x${"99".repeat(32)}` as Hex,
      logIndex: 0,
    }
    return { contextId, lineageId, leaf, item, log, payload }
  }

  /** A Runtime carrying a fake log client, a fake owner API and a fixed namespace secret. */
  function fakeOwnerRuntime(over: {
    deployment?: typeof DEPLOYMENT_BATCHED | typeof DEPLOYMENT
    logs?: Record<string, readonly unknown[]>
    items?: BatchedReadItem[]
    partial?: boolean
    /** What `batchOf(batchId)` answers — [root, anchoredBlock]; absent means the call throws. */
    batchRoot?: Hex
    /** Receives the event name of every getLogs call — which scans ran. */
    logCalls?: string[]
  }): Runtime {
    const deployment = over.deployment ?? DEPLOYMENT_BATCHED
    const publicClient = {
      getBlockNumber: async () => 200n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BLOCK_TIME, number: blockNumber }),
      getLogs: async ({ event }: { event: { name?: string } }) => {
        over.logCalls?.push(event.name ?? "?")
        return over.logs?.[event.name ?? ""] ?? []
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "agentIdOfSigner") return MY_AGENT_ID
        if (functionName === "batchOf" && over.batchRoot !== undefined) return [over.batchRoot, BLOCK]
        throw new Error(`unexpected chain read ${functionName}`)
      },
    }
    return {
      owner: OWNER,
      ownerStartBlock: 0n,
      network: { rpcUrl: "http://127.0.0.1:1", deployment },
      ownerChain: { publicClient },
      ownerApi: {
        listObjects: async () => ({ objects: [], partial: false }),
        listBatchSaves: async () => ({ items: over.items ?? [], partial: over.partial ?? false }),
      },
      vault: { deriveNamespaceSecret: async () => SECRET },
      reader: {},
    } as unknown as Runtime
  }

  it("a SaveAnchored log plus its verified store row becomes a lane:batched SourceRecord", async () => {
    const { contextId, lineageId, leaf, item, log, payload } = await makeAnchored()
    // batchOf answers the leaf as the batch root — a one-leaf batch with an empty proof verifies
    const runtime = fakeOwnerRuntime({ logs: { SaveAnchored: [log] }, items: [item], batchRoot: leaf })
    const records = await readOwnerUniverse(runtime)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      contextId,
      namespace: "goals.career",
      namespaceId: NS,
      authorId: MY_AGENT_ID,
      lineageId,
      version: 1,
      readEpoch: 1n,
      createdAt: BLOCK_TIME,
      expiresAt: 0n,
      lane: "batched",
      batchId: BATCH_ID,
    })
    expect(records[0]!.payload.value).toEqual(payload.value)
  })

  it("a save the chain anchored but the store cannot produce makes the read incomplete", async () => {
    const { contextId, log } = await makeAnchored()
    const runtime = fakeOwnerRuntime({ logs: { SaveAnchored: [log] }, items: [] })
    await expect(readOwnerUniverse(runtime)).rejects.toMatchObject({ code: "owner-read-incomplete", contextIds: [contextId] })
  })

  it("no batchAnchor on the deployment → the SaveAnchored scan never runs", async () => {
    const asked: string[] = []
    const runtime = fakeOwnerRuntime({ deployment: DEPLOYMENT, logCalls: asked })
    await expect(readOwnerUniverse(runtime)).resolves.toEqual([])
    expect(asked).toEqual(["ContextRegistered"])
  })
})

describe("migrate — the batched-saves guard fails closed", () => {
  const migrateDeps = async (over: {
    deploymentRaw: Record<string, unknown>
    hasBatchedSaves?: (owner: Address) => Promise<boolean>
  }) => {
    const rpc = await stubRpc()
    const home = new MidaHome(dir())
    saveOwnerMode(home, "software")
    saveOwnerAddress(home, OWNER)
    home.writeSecretJson("network.json", { rpcUrl: rpc.url, deployment: over.deploymentRaw })
    const lines: string[] = []
    const asked: Address[] = []
    const result = await migrate({
      home,
      env: {},
      confirm: async () => {
        throw new Error("confirm must not run — the guard decides first")
      },
      print: (line) => lines.push(line),
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      // the target is the same contract — a passing guard lands on "nothing-to-move" immediately
      target: DEPLOYMENT,
      ...(over.hasBatchedSaves === undefined
        ? {}
        : {
            hasBatchedSaves: async (owner: Address) => {
              asked.push(owner)
              return over.hasBatchedSaves!(owner)
            },
          }),
    })
    return { result, lines, asked, close: rpc.close }
  }

  it("hasBatchedSaves true → refuses batched-saves-present with the plain-words line", async () => {
    const { result, lines, asked, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_BATCHED_RAW,
      hasBatchedSaves: async () => true,
    })
    try {
      expect(result).toMatchObject({ outcome: "refused", code: "batched-saves-present" })
      expect(lines).toContain("this setup has batched checkpoint saves; migrate cannot move them yet")
      expect(asked).toEqual([OWNER])
    } finally {
      await close()
    }
  })

  it("a hasBatchedSaves read that throws refuses batched-check-failed — never assumes none", async () => {
    const { result, lines, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_BATCHED_RAW,
      hasBatchedSaves: async () => {
        throw new Error("rpc went away")
      },
    })
    try {
      expect(result).toMatchObject({ outcome: "refused", code: "batched-check-failed" })
      expect(lines).toContain("could not check for batched saves; migrate stops rather than guess")
    } finally {
      await close()
    }
  })

  it("hasBatchedSaves false → the run proceeds to the ordinary nothing-to-move answer", async () => {
    const { result, asked, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_BATCHED_RAW,
      hasBatchedSaves: async () => false,
    })
    try {
      expect(result.outcome).toBe("nothing-to-move")
      expect(asked).toEqual([OWNER])
    } finally {
      await close()
    }
  })

  it("no batchAnchor on the source deployment → the check is skipped entirely", async () => {
    const { result, asked, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_RAW,
      hasBatchedSaves: async () => {
        throw new Error("must never be called")
      },
    })
    try {
      expect(result.outcome).toBe("nothing-to-move")
      expect(asked).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
