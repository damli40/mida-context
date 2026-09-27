// Plan Task 8: the batched lane's readers. readCheckpoints merges the batch table's anchored and
// verified-pending saves into the checkpoint list — marked anchor "ANCHORED"/"PENDING_ANCHOR",
// flush-on-switch when a pending save belongs to another agent. The handoff renders a pending
// save as its own marked block inside the fence, never as saved state. readOwnerUniverse adds
// the owner's SaveAnchored logs, each row verified and decrypted like a direct record. migrate's
// hasBatchedSaves guard refuses fail-closed. All of it runs on fakes: a stub HTTP store answers
// /batch/status and /batch/flush; the agent and chain are plain objects — no anvil, no server.

import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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

/** A store that 404s every route — a local or pre-batch host with no batch surface at all. */
async function noBatchStore(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createHttpServer((_req, res) => {
    res.statusCode = 404
    res.end(JSON.stringify({ code: "not-found" }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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

/** The ServiceRuntime shape readCheckpoints reads — agent, store and chain are injected fakes. */
function fakeRuntime(home: MidaHome, over: {
  network?: Network
  apiBaseUrl?: string
  agent?: unknown
  /** What `BatchAnchor.hasBatchedSaves(owner)` answers; absent makes the chain read throw. */
  hasBatchedSaves?: (owner: Address) => Promise<boolean>
  /**
   * The tie-scan surface `recordPlacementsNear` reads (in-13 M-5): `head`/`tsOf` answer
   * getBlock, `direct`/`batched` are the ContextRegistered and SaveAnchored logs a getLogs
   * window returns, keyed by the address it was asked.
   */
  tieScan?: {
    head: bigint
    tsOf: (n: bigint) => bigint
    direct?: Map<string, { block: bigint; logIndex: number; transactionIndex: number }>
    batched?: Map<string, { block: bigint; position: number; transactionIndex: number }>
  }
  /** Replaces the publicClient wholesale — for tests that count or fail every chain call. */
  client?: unknown
} = {}): ServiceRuntime {
  return {
    home,
    owner: OWNER,
    network: over.network,
    apiBaseUrl: over.apiBaseUrl ?? "http://127.0.0.1:1",
    agent: () => over.agent,
    chain: {
      deployment: over.network?.deployment,
      publicClient: over.client ?? {
        readContract: async ({ functionName, args }: { functionName: string; args: [Address] }) => {
          if (functionName === "hasBatchedSaves" && over.hasBatchedSaves !== undefined) {
            return over.hasBatchedSaves(args[0])
          }
          throw new Error(`unexpected chain read ${functionName}`)
        },
        getBlock: async (parameters?: { blockTag?: string; blockNumber?: bigint }) => {
          const scan = over.tieScan
          if (scan === undefined) throw new Error("no tie-scan fake")
          if (parameters?.blockNumber !== undefined) {
            const n = parameters.blockNumber
            if (n < 0 || n > scan.head) return null
            return { number: n, timestamp: scan.tsOf(n) }
          }
          return { number: scan.head, timestamp: scan.tsOf(scan.head) }
        },
        getLogs: async (parameters: { address?: string; fromBlock: bigint; toBlock: bigint; args?: { contextId?: string[] } }) => {
          const scan = over.tieScan
          if (scan === undefined) throw new Error("no tie-scan fake")
          const wanted = parameters.args?.contextId?.map((c) => c.toLowerCase())
          const inWindow = (block: bigint) => block >= parameters.fromBlock && block <= parameters.toBlock
          if (parameters.address === DEPLOYMENT_BATCHED.batchAnchor) {
            return [...(scan.batched ?? new Map()).entries()]
              .filter(([cid, p]) => (wanted === undefined || wanted.includes(cid)) && inWindow(p.block))
              .map(([cid, p]) => ({ args: { contextId: cid, position: p.position }, blockNumber: p.block, logIndex: p.position, transactionIndex: p.transactionIndex }))
          }
          return [...(scan.direct ?? new Map()).entries()]
            .filter(([cid, p]) => (wanted === undefined || wanted.includes(cid)) && inWindow(p.block))
            .map(([cid, p]) => ({ args: { contextId: cid }, blockNumber: p.block, logIndex: p.logIndex, transactionIndex: p.transactionIndex }))
        },
        getBlockNumber: async () => {
          const scan = over.tieScan
          if (scan === undefined) throw new Error("no tie-scan fake")
          return scan.head
        },
      },
    },
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
const anchoredObject = (
  contextId: Hex,
  eventId: string,
  chain?: { at: bigint; block?: bigint; index?: number; batchId?: Hex },
) => ({
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
  ...(chain === undefined ? {} : { chain }),
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

  it("a store with no batch surface skips the table when the chain says this owner has none", async () => {
    // the deployment carries an anchor and this store answers no /batch/status — a local or
    // pre-batch host. hasBatchedSaves is the contract's own flag: false means there really is
    // no table to miss, so the read is complete and the batch read never runs.
    const store = await noBatchStore()
    try {
      const home = batchedHome(store.url)
      let batchedReads = 0
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => {
          batchedReads += 1
          return emptyBatched
        },
      }
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent,
        hasBatchedSaves: async () => false,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(false)
      expect(batchedReads).toBe(0)
    } finally {
      await store.close()
    }
  })

  it("a store with no batch surface while the chain holds batched saves marks the read partial", async () => {
    // the contract's flag proves a batch table exists somewhere — a store that cannot serve it
    // must not answer as if the batch side were empty
    const store = await noBatchStore()
    try {
      const home = batchedHome(store.url)
      let batchedReads = 0
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => {
          batchedReads += 1
          return emptyBatched
        },
      }
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent,
        hasBatchedSaves: async () => true,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(true)
      expect(batchedReads).toBe(0)
    } finally {
      await store.close()
    }
  })

  it("a store with no batch surface whose chain check fails marks the read partial — unknown is never none", async () => {
    const store = await noBatchStore()
    try {
      const home = batchedHome(store.url)
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => emptyBatched,
      }
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent,
        hasBatchedSaves: async () => {
          throw new Error("rpc went away")
        },
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(true)
    } finally {
      await store.close()
    }
  })

  it("a batch status answering for a DIFFERENT anchor is no surface either — the flag still decides", async () => {
    const store = await stubStore({ enabled: true, batchAnchor: `0x${"99".repeat(20)}` })
    try {
      const home = batchedHome(store.url)
      const agent = {
        readWithStatus: async () => ({ objects: [], partial: false }),
        readBatchedWithStatus: async () => emptyBatched,
      }
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent,
        hasBatchedSaves: async () => true,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.partial).toBe(true)
    } finally {
      await store.close()
    }
  })
})

describe("readCheckpoints — a same-second tie across the two lanes (in-13 M-5)", () => {
  /**
   * A direct record gets a placement only when it ties with another DIRECT record — the
   * SDK's own scan never sees the batched lane. A cross-lane tie reaches readCheckpoints
   * with the batched record stamped {at, block, position} and the direct one holding only
   * {at}, so "no block sorts first" would crown the batched record whatever really landed
   * later. The merge-level scan must place EVERY member of the tie — (block, the anchoring
   * transaction's index inside it, position inside the transaction) — and a group it
   * cannot complete keeps none.
   */
  const SECOND = 1_500n
  const tsOf = (n: bigint) => 2_000n - (1_000n - n) // one second per block; SECOND sits at block 500
  const tiedObjects = (directObj: unknown, batchedObj: unknown) => ({
    readWithStatus: async () => ({ objects: [directObj], partial: false }),
    readBatchedWithStatus: async () => ({ ...emptyBatched, anchored: [batchedObj] }),
  })
  const tieScan = (events: {
    direct?: Map<string, { block: bigint; logIndex: number; transactionIndex: number }>
    batched?: Map<string, { block: bigint; position: number; transactionIndex: number }>
  }) => ({ head: 1_000n, tsOf, ...events })

  it("a direct save that landed after a batched one in the same second is current — different blocks", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const directId = `0x${"e1".repeat(32)}` as Hex
      const batchedId = `0x${"e2".repeat(32)}` as Hex
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: tiedObjects(
          anchoredObject(directId, "cp-direct", { at: SECOND }),
          anchoredObject(batchedId, "cp-batched", { at: SECOND, block: 480n, index: 0 }),
        ),
        tieScan: tieScan({
          direct: new Map([[directId, { block: 500n, logIndex: 40, transactionIndex: 2 }]]),
          batched: new Map([[batchedId, { block: 480n, position: 0, transactionIndex: 5 }]]),
        }),
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([batchedId, directId])
      expect(result.checkpoints[1]!.checkpoint.objective).toBe("objective-cp-direct")
      // the direct record gained its real placement — the batched one keeps its position
      expect(result.checkpoints[1]!.chain).toEqual({ at: SECOND, block: 500n, index: 40, transaction: 2 })
      expect(result.checkpoints[0]!.chain).toEqual({ at: SECOND, block: 480n, index: 0, transaction: 5 })
    } finally {
      await store.close()
    }
  })

  it("a direct save that landed after a batched one in the same second is current — same block, later transaction", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const directId = `0x${"e3".repeat(32)}` as Hex
      const batchedId = `0x${"e4".repeat(32)}` as Hex
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: tiedObjects(
          anchoredObject(directId, "cp-direct", { at: SECOND }),
          anchoredObject(batchedId, "cp-batched", { at: SECOND, block: 500n, index: 0 }),
        ),
        tieScan: tieScan({
          direct: new Map([[directId, { block: 500n, logIndex: 3, transactionIndex: 7 }]]),
          batched: new Map([[batchedId, { block: 500n, position: 0, transactionIndex: 2 }]]),
        }),
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([batchedId, directId])
      expect(result.checkpoints[1]!.checkpoint.objective).toBe("objective-cp-direct")
      expect(result.checkpoints[1]!.chain).toEqual({ at: SECOND, block: 500n, index: 3, transaction: 7 })
    } finally {
      await store.close()
    }
  })

  it("a batched save that landed after a direct one in the same second is current — different blocks", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const directId = `0x${"e5".repeat(32)}` as Hex
      const batchedId = `0x${"e6".repeat(32)}` as Hex
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: tiedObjects(
          anchoredObject(directId, "cp-direct", { at: SECOND }),
          anchoredObject(batchedId, "cp-batched", { at: SECOND, block: 500n, index: 0 }),
        ),
        tieScan: tieScan({
          direct: new Map([[directId, { block: 480n, logIndex: 2, transactionIndex: 1 }]]),
          batched: new Map([[batchedId, { block: 500n, position: 0, transactionIndex: 3 }]]),
        }),
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([directId, batchedId])
      expect(result.checkpoints[1]!.checkpoint.objective).toBe("objective-cp-batched")
    } finally {
      await store.close()
    }
  })

  it("a tie the scan cannot complete keeps NO member's placement — the whole second falls to contextId together", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const directId = `0x${"aa".repeat(32)}` as Hex // id-sorted before batchedId on purpose
      const batchedId = `0x${"bb".repeat(32)}` as Hex
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: tiedObjects(
          anchoredObject(directId, "cp-direct", { at: SECOND }),
          anchoredObject(batchedId, "cp-batched", { at: SECOND, block: 500n, index: 0 }),
        ),
        tieScan: tieScan({
          // the direct record's ContextRegistered is nowhere in the window — partial answer
          batched: new Map([[batchedId, { block: 500n, position: 0, transactionIndex: 3 }]]),
        }),
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      // a found record may never order before an unfound one on the same stamp: the batched
      // row's own {block, index} is dropped too, and the contextId orders both together
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([directId, batchedId])
      expect(result.checkpoints[0]!.chain).toEqual({ at: SECOND })
      expect(result.checkpoints[1]!.chain).toEqual({ at: SECOND })
    } finally {
      await store.close()
    }
  })
})

describe("readCheckpoints — a same-batch tie orders by position with no chain calls (in-14 F-1)", () => {
  /**
   * Converted from .devin/briefs/probes/zz-rv13-batch-tie.test.ts. Two saves anchored by ONE
   * batch already carry their order — the batch position is authoritative. The in-13 M-5 rule
   * re-scanned ANY same-second group holding a batched member (batched rows carry no
   * transaction index), so a same-batch pair cost ~4 chain calls per read, and a scan that
   * failed or came back partial threw the positions away and let the contextId decide. The
   * scan now runs only where some pair inside the second cannot be ordered without it —
   * different lanes, or different batches in one block. `batchId`, which the SDK now carries
   * on the row's chain placement, is what says two rows belong to one batch.
   */
  const SECOND = 1_500n
  const BATCH_A = `0x${"b1".repeat(32)}` as Hex
  const BATCH_B = `0x${"b2".repeat(32)}` as Hex
  const tsOf = (n: bigint) => 2_000n - (1_000n - n)

  /**
   * The ordinary tie-scan fake from `fakeRuntime`, wrapped so every chain call is counted —
   * `fail` makes the underlying calls throw, so a scan that must not run is provably never
   * attempted.
   */
  const countingClient = (
    home: MidaHome,
    scan?: {
      direct?: Map<string, { block: bigint; logIndex: number; transactionIndex: number }>
      batched?: Map<string, { block: bigint; position: number; transactionIndex: number }>
    },
    fail = false,
  ) => {
    const calls = { chainCalls: 0 }
    const tick = () => {
      calls.chainCalls += 1
      if (fail) throw new Error("chain down")
    }
    const delegate = (
      fakeRuntime(home, { tieScan: { head: 1_000n, tsOf, ...(scan ?? {}) } }).chain as {
        publicClient: {
          getBlock: (p?: unknown) => Promise<unknown>
          getLogs: (p?: unknown) => Promise<unknown>
          getBlockNumber: () => Promise<bigint>
        }
      }
    ).publicClient
    const client = {
      readContract: async () => {
        tick()
        throw new Error("unexpected chain read")
      },
      getBlock: async (parameters?: unknown) => {
        tick()
        return delegate.getBlock(parameters)
      },
      getLogs: async (parameters?: unknown) => {
        tick()
        return delegate.getLogs(parameters)
      },
      getBlockNumber: async () => {
        tick()
        return delegate.getBlockNumber()
      },
    }
    return { calls, client }
  }

  const oneBatch = (earlier: Hex, later: Hex) => ({
    readWithStatus: async () => ({ objects: [], partial: false }),
    readBatchedWithStatus: async () => ({
      ...emptyBatched,
      anchored: [
        // listed newest-first, and "later" sorts before "earlier" on the contextId —
        // the position order must beat both
        anchoredObject(later, "later-pos1", { at: SECOND, block: 500n, index: 1, batchId: BATCH_A }),
        anchoredObject(earlier, "earlier-pos0", { at: SECOND, block: 500n, index: 0, batchId: BATCH_A }),
      ],
    }),
  })

  it("two members of one batch order by position — zero chain calls", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const earlier = `0x${"f1".repeat(32)}` as Hex // position 0; id-sorts LAST on purpose
      const later = `0x${"a1".repeat(32)}` as Hex // position 1; id-sorts FIRST on purpose
      const { calls, client } = countingClient(home)
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: oneBatch(earlier, later),
        client,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(calls.chainCalls, "a same-batch tie paid for a placement scan").toBe(0)
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([earlier, later])
      expect(result.checkpoints[0]!.chain).toEqual({ at: SECOND, block: 500n, index: 0, batchId: BATCH_A })
    } finally {
      await store.close()
    }
  })

  it("the same tie with the chain down still orders by position — the scan is never attempted", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const earlier = `0x${"f2".repeat(32)}` as Hex
      const later = `0x${"a2".repeat(32)}` as Hex
      const { calls, client } = countingClient(home, undefined, true)
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: oneBatch(earlier, later),
        client,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(calls.chainCalls).toBe(0)
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([earlier, later])
      expect(result.checkpoints[0]!.chain).toEqual({ at: SECOND, block: 500n, index: 0, batchId: BATCH_A })
    } finally {
      await store.close()
    }
  })

  it("a same-second tie across the two lanes still scans — their placements really are missing", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const directId = `0x${"a3".repeat(32)}` as Hex // id-sorts first — the scan's answer must beat it
      const batchedId = `0x${"f3".repeat(32)}` as Hex
      const { calls, client } = countingClient(home, {
        direct: new Map([[directId, { block: 500n, logIndex: 40, transactionIndex: 2 }]]),
        batched: new Map([[batchedId, { block: 500n, position: 0, transactionIndex: 5 }]]),
      })
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: {
          readWithStatus: async () => ({ objects: [anchoredObject(directId, "cp-direct", { at: SECOND })], partial: false }),
          readBatchedWithStatus: async () => ({
            ...emptyBatched,
            anchored: [anchoredObject(batchedId, "cp-batched", { at: SECOND, block: 500n, index: 0, batchId: BATCH_A })],
          }),
        },
        client,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(calls.chainCalls, "a mixed-lane tie must still pay for the scan").toBeGreaterThan(0)
      // direct tx 2 before batched tx 5 — the direct save really is earlier this time
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([directId, batchedId])
      expect(result.checkpoints[1]!.chain).toEqual({ at: SECOND, block: 500n, index: 0, transaction: 5, batchId: BATCH_A })
    } finally {
      await store.close()
    }
  })

  it("two batches anchored in one block still scan — positions alone cannot order them", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const firstTx = `0x${"a4".repeat(32)}` as Hex // batch A anchored in tx 2 — really earlier
      const secondTx = `0x${"f4".repeat(32)}` as Hex // batch B anchored in tx 5 — really later
      const { calls, client } = countingClient(home, {
        batched: new Map([
          [firstTx, { block: 500n, position: 0, transactionIndex: 2 }],
          [secondTx, { block: 500n, position: 0, transactionIndex: 5 }],
        ]),
      })
      const runtime = fakeRuntime(home, {
        network: batchedNetwork(store.url),
        apiBaseUrl: store.url,
        agent: {
          readWithStatus: async () => ({ objects: [], partial: false }),
          readBatchedWithStatus: async () => ({
            ...emptyBatched,
            anchored: [
              anchoredObject(secondTx, "cp-batchB", { at: SECOND, block: 500n, index: 0, batchId: BATCH_B }),
              anchoredObject(firstTx, "cp-batchA", { at: SECOND, block: 500n, index: 0, batchId: BATCH_A }),
            ],
          }),
        },
        client,
      })
      const result = await readCheckpoints(runtime, "claude-code", "p-1")
      expect(calls.chainCalls, "positions in different batches need the anchoring transaction").toBeGreaterThan(0)
      expect(result.checkpoints.map((cp) => cp.contextId)).toEqual([firstTx, secondTx])
    } finally {
      await store.close()
    }
  })
})

describe("buildHandoff — a pending save is marked, never called saved", () => {
  // checkAccess's identity gate answers before any stubbed dep is consulted, so the runtime
  // needs a real home holding a loadable codex identity — every answer after it is stubbed.
  const handoffHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-batch-handoff-")))
  {
    const key = `0x${"cd".repeat(32)}`
    mkdirSync(join(handoffHome.root, "agents", "codex"), { recursive: true })
    writeFileSync(
      join(handoffHome.root, "agents", "codex", "identity.json"),
      JSON.stringify({
        name: "codex",
        agentId: key,
        signerPrivateKey: key,
        encryptionPrivateKey: key,
        encryptionPublicKey: key,
        manifestHash: key,
        callbackOrigin: "http://localhost",
        purposeId: "project_assistance",
        manifest: {},
      }),
    )
  }
  const runtime = { home: handoffHome } as unknown as ServiceRuntime
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
    // nothing here carries a chain stamp — the header's save time is the honest unconfirmed
    // form, and no part of the text calls the pending record "saved"
    expect(result.text.startsWith("MIDA HANDOFF — save time not yet confirmed on Monad")).toBe(true)
    expect(result.text).not.toContain("saved working state")
    expect(result.text).not.toContain("Saved by")
  })

  it("an anchored-only read carries no pending marker and its header names the chain's save time", async () => {
    const result = await buildHandoff(runtime, input, deps([stored({ anchor: "ANCHORED", chain: { at: 1_700_000_000n } })]))
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).not.toContain("PENDING_ANCHOR")
    // the header's save time is the chain's own stamp — 1_700_000_000 s = 2023-11-14 22:13 UTC
    expect(result.text.startsWith("MIDA HANDOFF — saved 2023-11-14 22:13 UTC (")).toBe(true)
  })

  it("a mixed read marks only the pending block — the header keeps the anchored merge's chain time", async () => {
    const anchored = stored({ contextId: `0x${"3".repeat(64)}` as Hex, anchor: "ANCHORED", chain: { at: 1_700_000_000n } })
    const pending = stored({ contextId: `0x${"4".repeat(64)}` as Hex, anchor: "PENDING_ANCHOR" })
    const result = await buildHandoff(runtime, input, deps([anchored, pending]))
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    const insideFence = result.text.split("=== BEGIN MIDA HANDOFF DATA ===")[1]!.split("=== END MIDA HANDOFF DATA ===")[0]!
    expect(insideFence).toContain(`${PENDING_ANCHOR_LINE}\nfrom claude-code`)
    // the marker appears once — over the pending block, never in the merged sections
    expect(result.text.split(PENDING_ANCHOR_LINE)).toHaveLength(2)
    // the header's save time is the anchored merge's chain stamp — the pending block sits
    // inside the fence under its own marker, not under the confirmed save time
    expect(result.text.startsWith("MIDA HANDOFF — saved 2023-11-14 22:13 UTC (")).toBe(true)
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
    /**
     * Answers for an after-head getLogs scan — one whose fromBlock is past the bound (these
     * tests bound reads at block 100, so a fromBlock > 100 is the post-bound query). Keyed by
     * event name like `logs`.
     */
    lateLogs?: Record<string, readonly unknown[]>
    items?: BatchedReadItem[]
    partial?: boolean
    /** What `batchOf(batchId)` answers — [root, anchoredBlock]; absent means the call throws. */
    batchRoot?: Hex
    /** Receives the event name of every getLogs call — which scans ran. */
    logCalls?: string[]
    /**
     * What `GET /batch/status` answers; "absent" makes the call throw — a store with no batch
     * surface at all. Defaults to serving this deployment's anchor.
     */
    batchStatus?: { enabled: boolean; batchAnchor: Address } | "absent"
    /** What `BatchAnchor.hasBatchedSaves(owner)` answers; absent means the call throws. */
    hasBatchedSaves?: boolean | Error
  }): Runtime {
    const deployment = over.deployment ?? DEPLOYMENT_BATCHED
    const publicClient = {
      getBlockNumber: async () => 200n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BLOCK_TIME, number: blockNumber }),
      getLogs: async ({ event, fromBlock }: { event: { name?: string }; fromBlock?: bigint }) => {
        over.logCalls?.push(event.name ?? "?")
        if (fromBlock !== undefined && fromBlock > 100n) return over.lateLogs?.[event.name ?? ""] ?? []
        return over.logs?.[event.name ?? ""] ?? []
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "agentIdOfSigner") return MY_AGENT_ID
        if (functionName === "batchOf" && over.batchRoot !== undefined) return [over.batchRoot, BLOCK]
        if (functionName === "hasBatchedSaves") {
          if (over.hasBatchedSaves instanceof Error) throw over.hasBatchedSaves
          if (over.hasBatchedSaves === undefined) throw new Error(`unexpected chain read ${functionName}`)
          return over.hasBatchedSaves
        }
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
        batchStatus: async () => {
          const status = over.batchStatus ?? { enabled: true, batchAnchor: ANCHOR }
          if (status === "absent") throw new Error("no such route")
          return status
        },
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

  it("a batched save anchored after the bound is newer than the read — counted, not refused", async () => {
    // ex-3 E-4: two ANCHORED rows sit in the store's batch table; the bounded SaveAnchored
    // scan (toBlock 100) knows only the first. The second's log landed after the bound, so
    // the after-head scan finds it: the row is excluded and reported, not an inconsistency.
    const old = await makeAnchored()
    const late = await makeAnchored()
    const runtime = fakeOwnerRuntime({
      logs: { SaveAnchored: [old.log] },
      lateLogs: { SaveAnchored: [late.log] },
      items: [old.item, late.item],
      batchRoot: old.leaf,
    })
    const afterHead = new Set<Hex>()
    const records = await readOwnerUniverse(runtime, { keepEncrypted: true, toBlock: 100n, afterHead })
    expect(records.map((record) => record.contextId)).toEqual([old.contextId])
    expect([...afterHead]).toEqual([late.contextId])
  })

  it("three anchored store rows the bound never logged cost ONE post-bound scan", async () => {
    // ex-4 G-3, batched lane: every missed ANCHORED row is judged by a single SaveAnchored
    // scan past the bound — not one fresh range scan per row.
    const old = await makeAnchored()
    const late = [await makeAnchored(), await makeAnchored(), await makeAnchored()]
    const logCalls: string[] = []
    const runtime = fakeOwnerRuntime({
      logs: { SaveAnchored: [old.log] },
      lateLogs: { SaveAnchored: late.map((entry) => entry.log) },
      items: [old.item, ...late.map((entry) => entry.item)],
      batchRoot: old.leaf,
      logCalls,
    })
    const afterHead = new Set<Hex>()
    const records = await readOwnerUniverse(runtime, { keepEncrypted: true, toBlock: 100n, afterHead })
    expect(records.map((record) => record.contextId)).toEqual([old.contextId])
    expect([...afterHead].sort()).toEqual(late.map((entry) => entry.contextId).sort())
    // one bounded SaveAnchored scan + the single post-bound re-check — never one scan per row
    expect(logCalls.filter((name) => name === "SaveAnchored")).toHaveLength(2)
  })

  it("a batched row with no SaveAnchored anywhere still refuses — the bound is not an excuse", async () => {
    const old = await makeAnchored()
    const late = await makeAnchored()
    const runtime = fakeOwnerRuntime({
      logs: { SaveAnchored: [old.log] },
      lateLogs: {},
      items: [old.item, late.item],
      batchRoot: old.leaf,
    })
    const failure = await readOwnerUniverse(runtime, { toBlock: 100n }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "owner-read-incomplete", contextIds: [late.contextId] })
  })

  it("no batchAnchor on the deployment → the SaveAnchored scan never runs", async () => {
    const asked: string[] = []
    const runtime = fakeOwnerRuntime({ deployment: DEPLOYMENT, logCalls: asked })
    await expect(readOwnerUniverse(runtime)).resolves.toEqual([])
    expect(asked).toEqual(["ContextRegistered"])
  })

  it("a store with no batch surface and no batched saves on chain → the read stays complete", async () => {
    // the contract's flag is what may say "nothing to miss" — not the store's missing routes
    const runtime = fakeOwnerRuntime({ batchStatus: "absent", hasBatchedSaves: false })
    await expect(readOwnerUniverse(runtime)).resolves.toEqual([])
  })

  it("a store with no batch surface while the chain holds batched saves → owner-read-incomplete naming why", async () => {
    const runtime = fakeOwnerRuntime({ batchStatus: "absent", hasBatchedSaves: true })
    const failure = await readOwnerUniverse(runtime).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "owner-read-incomplete" })
    expect((failure as Error).message).toContain("batched saves exist on chain but this store serves none")
  })

  it("a store with no batch surface whose chain check fails → owner-read-incomplete, never 'nothing to miss'", async () => {
    const runtime = fakeOwnerRuntime({ batchStatus: "absent", hasBatchedSaves: new Error("rpc went away") })
    const failure = await readOwnerUniverse(runtime).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "owner-read-incomplete" })
    expect((failure as Error).message).toContain("the chain could not say whether batched saves exist")
  })

  it("a batch status answering for a DIFFERENT anchor is no surface either — the flag still decides", async () => {
    const runtime = fakeOwnerRuntime({
      batchStatus: { enabled: true, batchAnchor: `0x${"99".repeat(20)}` as Address },
      hasBatchedSaves: true,
    })
    const failure = await readOwnerUniverse(runtime).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "owner-read-incomplete" })
    expect((failure as Error).message).toContain("batched saves exist on chain but this store serves none")
  })
})

describe("migrate — the batched-saves guard fails closed", () => {
  /** One well-formed in-flight entry for state/batch-pending.json — QUEUED means "not final yet". */
  const PENDING_ENTRY = {
    contextId: `0x${"cc".repeat(32)}`,
    eventId: "ev-pending-1",
    sessionId: "sess-pending-1",
    agent: "claude-code",
    queuedAt: "2026-09-24T11:00:00.000Z",
    state: "QUEUED",
  }

  const migrateDeps = async (over: {
    deploymentRaw: Record<string, unknown>
    hasBatchedSaves?: (owner: Address) => Promise<boolean>
    /** seeds state/batch-pending.json: a ledger object, or "corrupt-json" for raw unparseable bytes */
    pendingLedger?: { entries: unknown[] } | "corrupt-json"
  }) => {
    const rpc = await stubRpc()
    const home = new MidaHome(dir())
    saveOwnerMode(home, "software")
    saveOwnerAddress(home, OWNER)
    home.writeSecretJson("network.json", { rpcUrl: rpc.url, deployment: over.deploymentRaw })
    if (over.pendingLedger === "corrupt-json") {
      mkdirSync(home.path("state"), { recursive: true })
      writeFileSync(home.path("state/batch-pending.json"), "{not json")
    } else if (over.pendingLedger !== undefined) {
      home.writeSecretJson("state/batch-pending.json", over.pendingLedger)
    }
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

  it("a queued save in the local ledger refuses — the chain flag cannot see what was never submitted", async () => {
    // No batchAnchor at all on this source: the chain guard is skipped, so only the local
    // ledger can know a save is still in flight. That is the hole this guard exists for.
    const { result, lines, asked, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_RAW,
      pendingLedger: { entries: [PENDING_ENTRY] },
    })
    try {
      expect(result).toMatchObject({ outcome: "refused", code: "batched-saves-pending" })
      expect(lines[0]).toContain("1 batched checkpoint save(s) still waiting on the chain")
      expect(asked).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it("a pending ledger refuses even when the chain flag itself is false", async () => {
    const { result, asked, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_BATCHED_RAW,
      hasBatchedSaves: async () => false, // nothing anchored yet — the ledger still says QUEUED
      pendingLedger: { entries: [PENDING_ENTRY] },
    })
    try {
      expect(result).toMatchObject({ outcome: "refused", code: "batched-saves-pending" })
      expect(asked).toEqual([OWNER])
    } finally {
      await close()
    }
  })

  it("a pending ledger that will not parse refuses batched-check-failed — corrupt is never 'none'", async () => {
    const { result, lines, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_RAW,
      pendingLedger: "corrupt-json",
    })
    try {
      expect(result).toMatchObject({ outcome: "refused", code: "batched-check-failed" })
      expect(lines).toContain("could not read the local batched-saves ledger; migrate stops rather than guess")
    } finally {
      await close()
    }
  })

  it("a pending ledger whose entry is not a well-formed in-flight save refuses the same way", async () => {
    const { result, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_RAW,
      // parses fine, is an array, but the entry is missing fields — unknown, and unknown refuses
      pendingLedger: { entries: [{ contextId: `0x${"dd".repeat(32)}` }] },
    })
    try {
      expect(result).toMatchObject({ outcome: "refused", code: "batched-check-failed" })
    } finally {
      await close()
    }
  })

  it("an empty pending ledger lets the run on to the ordinary answer", async () => {
    const { result, close } = await migrateDeps({
      deploymentRaw: DEPLOYMENT_RAW,
      pendingLedger: { entries: [] },
    })
    try {
      expect(result.outcome).toBe("nothing-to-move")
    } finally {
      await close()
    }
  })
})
