// Plan Task 7: the batched checkpoint lane — the switch in network.json, the lane decision,
// the pending/rejected ledgers, the drain follow-up, doctor's "batching" check and
// `mida batching on|off`. Everything here runs on fakes: a stub JSON-RPC answers the eth_*
// calls Runtime.open makes, a stub HTTP store answers /batch/status and /batch/saves/:id —
// no chain, no real API server. The end-to-end run against a local chain is Task 10's.

import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDeployment } from "@mida/chain"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"
import type { compileCheckpoint } from "@mida/compiler"
import type { BatchReceipt } from "@mida/api"
import type { Address, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import {
  MidaHome,
  drainOnce,
  enqueue,
  listJobs,
  projectIdFor,
  resolveNetwork,
  runCli,
  runDoctor,
  saveAgentIdentity,
  saveCheckpoint,
  saveOwnerAddress,
  saveOwnerMode,
  wrapCheckpoint,
} from "@mida/midad"
import type { DoctorDeps, DrainDeps, Network, ServiceRuntime } from "@mida/midad"
import {
  addPendingAnchor,
  decideLane,
  followPendingAnchors,
  laneWhyText,
  pendingAnchors,
  rejectedAnchors,
} from "../src/batching.js"
import { setBatchingFlag } from "../src/network.js"
import type { SavedNetwork } from "../src/network.js"
import { sampleCheckpoint } from "./helpers.js"

const dir = () => mkdtempSync(join(tmpdir(), "mida-batching-"))

const OWNER = `0x${"11".repeat(20)}` as Address
const ANCHOR = "0x4444444444444444444444444444444444444444" as Address
const OTHER_ANCHOR = "0x5555555555555555555555555555555555555555" as Address
const CONTEXT_ID = `0x${"cc".repeat(32)}` as Hex
const EVENT_ID = "cp-batched-1"
const SESSION_ID = "s1"

/** A 31337 (foundry) deployment record — raw form for network.json, parsed form for code. */
const DEPLOYMENT_RAW = {
  chainId: "31337",
  capabilityRegistry: "0x2222222222222222222222222222222222222222",
  contextRegistry: "0x3333333333333333333333333333333333333333",
  deploymentBlock: "0",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"55".repeat(32)}`,
  // the real policy hash — Runtime.open's FakeVaultAuthority rejects any other
  policyHashV1: POLICY_HASH_V1,
}
const DEPLOYMENT = parseDeployment(DEPLOYMENT_RAW)
const DEPLOYMENT_BATCHED_RAW = { ...DEPLOYMENT_RAW, batchAnchor: ANCHOR, batchAnchorBlock: "7" }
const DEPLOYMENT_BATCHED = parseDeployment(DEPLOYMENT_BATCHED_RAW)

/** The JSON-RPC calls Runtime.open and friends actually make — everything else gets "0x". */
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
      if (call.method === "eth_getTransactionCount") return reply("0x0")
      if (call.method === "eth_getBalance") return reply("0x0")
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

type SaveAnswer = { state: string; reason: string | null; batchId?: Hex } | { httpError: number }

/** A fake hosted store: /batch/status from `status`, /batch/saves/<id> from the `saves` map. */
async function stubStore(status: { enabled: boolean; batchAnchor: string } = { enabled: true, batchAnchor: ANCHOR }): Promise<{
  url: string
  host: string
  status: { enabled: boolean; batchAnchor: string }
  saves: Map<string, SaveAnswer>
  paths: string[]
  close(): Promise<void>
}> {
  const saves = new Map<string, SaveAnswer>()
  const paths: string[] = []
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub")
    paths.push(`${req.method} ${url.pathname}`)
    res.setHeader("content-type", "application/json")
    if (req.method === "GET" && url.pathname === "/batch/status") {
      res.end(JSON.stringify(status))
      return
    }
    const match = /^\/batch\/saves\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname)
    if (req.method === "GET" && match !== null) {
      const entry = saves.get(match[1]!.toLowerCase())
      if (entry === undefined) {
        res.statusCode = 404
        res.end(JSON.stringify({ code: "not-found", error: "no such save" }))
        return
      }
      if ("httpError" in entry) {
        res.statusCode = entry.httpError
        res.end(JSON.stringify({ code: "boom", error: "store error" }))
        return
      }
      res.end(JSON.stringify({ state: entry.state, reason: entry.reason, ...(entry.batchId === undefined ? {} : { item: { batchId: entry.batchId } }) }))
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
    host: `127.0.0.1:${port}`,
    status,
    saves,
    paths,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

/** A valid-looking agent identity — only shape matters: the stub store never checks the signature. */
function writeIdentity(home: MidaHome, name: string): void {
  saveAgentIdentity(home, {
    name,
    agentId: `0x${"aa".repeat(32)}` as Hex,
    signerPrivateKey: `0x${"12".repeat(32)}` as Hex,
    encryptionPrivateKey: `0x${"22".repeat(32)}` as Hex,
    encryptionPublicKey: `0x${"33".repeat(32)}` as Hex,
    callbackOrigin: "https://callback.example",
    purposeId: "general_assistance",
    manifest: {} as SignedAgentCapabilityManifest,
    manifestHash: `0x${"77".repeat(32)}` as Hex,
  })
}

/** The ServiceRuntime shape saveCheckpoint/followPendingAnchors/drain read — no chain attached. */
function fakeRuntime(home: MidaHome, over: { network?: Network; apiBaseUrl?: string; agent?: unknown } = {}): ServiceRuntime {
  return {
    home,
    owner: OWNER,
    network: over.network,
    apiBaseUrl: over.apiBaseUrl ?? "http://127.0.0.1:1",
    agent: () => over.agent,
    chain: {
      deployment: over.network?.deployment,
      publicClient: {
        getTransactionReceipt: async () => {
          throw new Error("no chain in this test")
        },
        getTransaction: async () => {
          throw new Error("no chain in this test")
        },
      },
    },
    close: async () => {},
  } as unknown as ServiceRuntime
}

const batchedNetwork = (storageUrl: string | undefined): Network =>
  ({ rpcUrl: "http://127.0.0.1:1", deployment: DEPLOYMENT_BATCHED, ...(storageUrl === undefined ? {} : { storageUrl }) }) as Network

const saveInput = {
  projectId: "p-1",
  sessionId: SESSION_ID,
  continuesSession: null,
  compiledBy: "stub",
  checkpoint: sampleCheckpoint({ eventId: EVENT_ID }),
}

const receipt: BatchReceipt = { contextId: CONTEXT_ID, receivedAt: 1_700_000_000_000, sequence: "7", signature: `0x${"99".repeat(65)}` as Hex }

describe("decideLane — batched only when every condition holds", () => {
  const saved = (batching?: boolean): SavedNetwork => ({
    rpcUrl: "http://rpc.example",
    deployment: DEPLOYMENT_BATCHED,
    storageUrl: "http://store.example",
    ...(batching === undefined ? {} : { batching }),
  })
  const ok = { enabled: true, batchAnchor: ANCHOR }

  it("batching absent or false → direct, switch-off", async () => {
    for (const flag of [undefined, false]) {
      const lane = await decideLane({ saved: saved(flag), deployment: DEPLOYMENT_BATCHED, storageUrl: "http://store.example", status: async () => ok })
      expect(lane).toEqual({ kind: "direct", why: "switch-off" })
    }
    // and no saved file at all is the same off
    const lane = await decideLane({ saved: undefined, deployment: DEPLOYMENT_BATCHED, storageUrl: "http://store.example", status: async () => ok })
    expect(lane).toEqual({ kind: "direct", why: "switch-off" })
  })

  it("no batchAnchor in the deployment → direct, no-batch-anchor", async () => {
    const lane = await decideLane({ saved: saved(true), deployment: DEPLOYMENT, storageUrl: "http://store.example", status: async () => ok })
    expect(lane).toEqual({ kind: "direct", why: "no-batch-anchor" })
  })

  it("no hosted store → direct, local-store", async () => {
    const lane = await decideLane({ saved: saved(true), deployment: DEPLOYMENT_BATCHED, storageUrl: undefined, status: async () => ok })
    expect(lane).toEqual({ kind: "direct", why: "local-store" })
  })

  it("a status call that fails or answers null → direct, store-unreachable", async () => {
    const dead = await decideLane({ saved: saved(true), deployment: DEPLOYMENT_BATCHED, storageUrl: "http://store.example", status: async () => null })
    expect(dead).toEqual({ kind: "direct", why: "store-unreachable" })
    const thrown = await decideLane({
      saved: saved(true),
      deployment: DEPLOYMENT_BATCHED,
      storageUrl: "http://store.example",
      status: () => Promise.reject(new Error("connection refused")),
    })
    expect(thrown).toEqual({ kind: "direct", why: "store-unreachable" })
  })

  it("a store that is off, or on for a different anchor → direct, store-disabled", async () => {
    const off = await decideLane({ saved: saved(true), deployment: DEPLOYMENT_BATCHED, storageUrl: "http://store.example", status: async () => ({ enabled: false, batchAnchor: ANCHOR }) })
    expect(off).toEqual({ kind: "direct", why: "store-disabled" })
    const other = await decideLane({ saved: saved(true), deployment: DEPLOYMENT_BATCHED, storageUrl: "http://store.example", status: async () => ({ enabled: true, batchAnchor: OTHER_ANCHOR }) })
    expect(other).toEqual({ kind: "direct", why: "store-disabled" })
  })

  it("switch on + anchor + hosted store + matching status → batched", async () => {
    const lane = await decideLane({ saved: saved(true), deployment: DEPLOYMENT_BATCHED, storageUrl: "http://store.example", status: async () => ok })
    expect(lane).toEqual({ kind: "batched", storeUrl: "http://store.example", batchAnchor: ANCHOR })
  })

  it("every why has a plain-words line for the refusal and doctor", () => {
    expect(laneWhyText("switch-off")).toContain("not turned on")
    expect(laneWhyText("no-batch-anchor")).toContain("BatchAnchor")
    expect(laneWhyText("local-store")).toContain("on this machine")
    expect(laneWhyText("store-disabled")).toContain("not offering batching")
    expect(laneWhyText("store-unreachable")).toContain("did not answer")
  })
})

describe("resolveNetwork — the shipped BatchAnchor is adopted for older setups", () => {
  it("a saved deployment without batchAnchor adopts the built-in's when the contract matches", async () => {
    const home = new MidaHome(dir())
    home.writeSecretJson("network.json", { rpcUrl: "http://rpc.example", deployment: DEPLOYMENT_RAW })
    const before = readFileSync(home.path("network.json"), "utf8")
    const resolved = await resolveNetwork(home, {}, { loadBuiltIn: () => DEPLOYMENT_BATCHED, probeChainId: false })
    expect(resolved.network.deployment.batchAnchor).toBe(ANCHOR)
    expect(resolved.network.deployment.batchAnchorBlock).toBe(7n)
    // additive only: every other saved field keeps its value, and the file is never rewritten
    expect(resolved.network.deployment.capabilityRegistry).toBe(DEPLOYMENT.capabilityRegistry)
    expect(resolved.network.deployment.deploymentBlock).toBe(0n)
    expect(readFileSync(home.path("network.json"), "utf8")).toBe(before)
  })

  it("a different capabilityRegistry adopts nothing — and still flags the mismatch", async () => {
    const home = new MidaHome(dir())
    home.writeSecretJson("network.json", { rpcUrl: "http://rpc.example", deployment: DEPLOYMENT_RAW })
    const other = parseDeployment({ ...DEPLOYMENT_BATCHED_RAW, capabilityRegistry: "0x6666666666666666666666666666666666666666" })
    const resolved = await resolveNetwork(home, {}, { loadBuiltIn: () => other, probeChainId: false })
    expect(resolved.network.deployment.batchAnchor).toBeUndefined()
    expect(resolved.mismatch).toBeDefined()
  })

  it("a saved deployment that already carries an anchor keeps its own — never the built-in's", async () => {
    const home = new MidaHome(dir())
    home.writeSecretJson("network.json", { rpcUrl: "http://rpc.example", deployment: DEPLOYMENT_BATCHED_RAW })
    const builtIn = parseDeployment({ ...DEPLOYMENT_BATCHED_RAW, batchAnchor: OTHER_ANCHOR, batchAnchorBlock: "9" })
    const resolved = await resolveNetwork(home, {}, { loadBuiltIn: () => builtIn, probeChainId: false })
    expect(resolved.network.deployment.batchAnchor).toBe(ANCHOR)
    expect(resolved.network.deployment.batchAnchorBlock).toBe(7n)
  })
})

describe("setBatchingFlag — only the flag's bytes may change", () => {
  it("writes batching:true into a file that never had it, preserving every other byte", () => {
    const home = new MidaHome(dir())
    home.writeSecretJson("network.json", { rpcUrl: "http://rpc.example", deployment: DEPLOYMENT_RAW, storageUrl: "http://store.example", sponsorUrl: "https://sponsor.example" })
    const before = readFileSync(home.path("network.json"), "utf8")
    setBatchingFlag(home, true)
    const after = readFileSync(home.path("network.json"), "utf8")
    // the flag is spliced in as the first key, reusing the file's own leading whitespace —
    // everything from the original first key on is the same bytes
    const leading = before.slice(1, before.indexOf('"', 1))
    expect(after).toBe(`{${leading}"batching": true,${before.slice(1)}`)
    const parsed = JSON.parse(after) as Record<string, unknown>
    expect(parsed.batching).toBe(true)
    expect(parsed.rpcUrl).toBe("http://rpc.example")
    expect(parsed.storageUrl).toBe("http://store.example")
    expect(parsed.sponsorUrl).toBe("https://sponsor.example")
    expect(parsed.deployment).toEqual(DEPLOYMENT_RAW)
  })

  it("replaces an existing flag in place — a mid-file key, compact layout, all other bytes kept", () => {
    const home = new MidaHome(dir())
    const compact = `{"rpcUrl":"http://rpc.example","batching":true,"deployment":${JSON.stringify(DEPLOYMENT_RAW)},"storageUrl":"http://store.example"}`
    writeFileSync(home.path("network.json"), compact)
    setBatchingFlag(home, false)
    expect(readFileSync(home.path("network.json"), "utf8")).toBe(compact.replace('"batching":true', '"batching":false'))
  })

  it("writes into an empty object and refuses a missing or corrupt file", () => {
    const home = new MidaHome(dir())
    writeFileSync(home.path("network.json"), "{}")
    setBatchingFlag(home, true)
    expect(readFileSync(home.path("network.json"), "utf8")).toBe('{"batching": true}')
    expect(() => setBatchingFlag(new MidaHome(dir()), true)).toThrow("network.json")
    const broken = new MidaHome(dir())
    writeFileSync(broken.path("network.json"), "not json {")
    expect(() => setBatchingFlag(broken, true)).toThrow("could not be parsed")
  })
})

describe("saveCheckpoint — the batched lane", () => {
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

  it("a batched save calls createBatched with the create arguments, returns QUEUED and writes the pending ledger", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const calls: Record<string, unknown>[] = []
      const agent = {
        read: async () => [],
        readBatchedWithStatus: async () => ({ anchored: [], pending: [], skipped: [], partial: false }),
        createBatched: async (_owner: Address, _namespace: string, input: Record<string, unknown>) => {
          calls.push(input)
          return { contextId: CONTEXT_ID, state: "QUEUED" as const, receipt }
        },
        create: async () => {
          throw new Error("the direct lane must not run for a batched save")
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await saveCheckpoint(runtime, "claude-code", saveInput)
      expect(result).toMatchObject({ contextId: CONTEXT_ID, transactionHash: null, duplicate: false, lane: "batched" })
      expect(result.batched).toEqual({ state: "QUEUED", receipt })
      // the same arguments agent.create would have been given — same envelope, same kind/source/tags
      expect(calls).toHaveLength(1)
      const arg = calls[0]! as { value: { type: string; checkpoint: { eventId: string } }; kind: string; source: string; tags: string[] }
      expect(arg.kind).toBe("EPISODE")
      expect(arg.source).toBe("AGENT_INFERRED")
      expect(arg.tags).toContain(EVENT_ID)
      expect(arg.value.type).toBe("mida.checkpoint.v1")
      expect(arg.value.checkpoint.eventId).toBe(EVENT_ID)
      // the pending ledger owns it now — QUEUED, keyed by the queued contextId
      expect(pendingAnchors(home)).toEqual([
        expect.objectContaining({ contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", state: "QUEUED" }),
      ])
      // and the local saved-id index records it, so a retry answers duplicate without a write
      expect((home.readJson<Record<string, string>>("state/saved-ids.json") ?? {})[EVENT_ID]).toBe(CONTEXT_ID)
    } finally {
      await store.close()
    }
  })

  it("the duplicate check sees a still-pending batched save — no second create", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const earlier = `0x${"bb".repeat(32)}` as Hex
      const envelope = wrapCheckpoint({ ...saveInput })
      let creates = 0
      const agent = {
        read: async () => [],
        readBatchedWithStatus: async () => ({
          anchored: [],
          pending: [{ contextId: earlier, payload: { value: envelope }, anchor: "PENDING_ANCHOR" as const, authorAgentId: `0x${"aa".repeat(32)}` as Hex }],
          skipped: [],
          partial: false,
        }),
        createBatched: async () => {
          creates += 1
          return { contextId: CONTEXT_ID, state: "QUEUED" as const, receipt }
        },
        create: async () => {
          throw new Error("unreachable")
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await saveCheckpoint(runtime, "claude-code", saveInput)
      expect(result.duplicate).toBe(true)
      expect(result.contextId).toBe(earlier)
      expect(creates).toBe(0)
      expect(pendingAnchors(home)).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("a partial batched read refuses the save rather than risking a duplicate", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const agent = {
        read: async () => [],
        readBatchedWithStatus: async () => ({ anchored: [], pending: [], skipped: [], partial: true }),
        createBatched: async () => {
          throw new Error("must not queue on a partial read")
        },
        create: async () => {
          throw new Error("unreachable")
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      await expect(saveCheckpoint(runtime, "claude-code", saveInput)).rejects.toMatchObject({ code: "PARTIAL_READ" })
    } finally {
      await store.close()
    }
  })

  it("batching on but the store says off → the save still happens directly, with laneWhy recorded", async () => {
    const store = await stubStore({ enabled: false, batchAnchor: ANCHOR })
    try {
      const home = batchedHome(store.url)
      const agent = {
        read: async () => [],
        create: async () => ({ contextId: CONTEXT_ID, transactionHash: `0x${"ee".repeat(32)}` as Hex }),
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await saveCheckpoint(runtime, "claude-code", saveInput)
      expect(result.lane).toBe("direct")
      expect(result.laneWhy).toBe("store-disabled")
      expect(result.transactionHash).toBe(`0x${"ee".repeat(32)}`)
      expect(result.batched).toBeUndefined()
      expect(pendingAnchors(home)).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("a lane-decision failure falls back to the direct lane — the save happens, laneWhy names the failure", async () => {
    const home = new MidaHome(dir())
    writeFileSync(home.path("network.json"), "not json {") // readSavedNetwork throws network-json-invalid
    const agent = {
      read: async () => [],
      create: async () => ({ contextId: CONTEXT_ID, transactionHash: null }),
    }
    const runtime = fakeRuntime(home, { network: batchedNetwork("http://127.0.0.1:1"), agent })
    const result = await saveCheckpoint(runtime, "claude-code", saveInput)
    expect(result.duplicate).toBe(false)
    expect(result.lane).toBe("direct")
    expect(result.laneWhy).toBe("network-json-invalid")
  })

  it("batching absent → the direct lane exactly as before, no laneWhy", async () => {
    const home = new MidaHome(dir()) // no network.json at all
    const agent = {
      read: async () => [],
      create: async () => ({ contextId: CONTEXT_ID, transactionHash: null }),
    }
    const runtime = fakeRuntime(home, { agent })
    const result = await saveCheckpoint(runtime, "claude-code", saveInput)
    expect(result.lane).toBe("direct")
    expect(result.laneWhy).toBeUndefined()
    expect(result.batched).toBeUndefined()
  })
})

describe("followPendingAnchors — the ledger's follow-up", () => {
  const entry = () => ({ contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: "2026-09-24T10:00:00.000Z" })

  const homeWithPending = (agent: string | null = "claude-code") => {
    const home = new MidaHome(dir())
    if (agent !== null) writeIdentity(home, agent)
    addPendingAnchor(home, { ...entry(), agent: agent ?? "ghost-agent" })
    return home
  }

  it("ANCHORED removes the entry and logs saved with the batch id — the only saved a batched save earns", async () => {
    const store = await stubStore()
    try {
      const home = homeWithPending()
      const batchId = `0x${"b1".repeat(32)}` as Hex
      store.saves.set(CONTEXT_ID, { state: "ANCHORED", reason: null, batchId })
      const logged: Record<string, unknown>[] = []
      const counts = await followPendingAnchors(fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }), (r) => logged.push(r))
      expect(counts).toEqual({ anchored: 1, rejected: 0, waiting: 0 })
      expect(pendingAnchors(home)).toHaveLength(0)
      expect(logged).toEqual([expect.objectContaining({ outcome: "saved", lane: "batched", contextId: CONTEXT_ID, batchId, sessionId: SESSION_ID, eventId: EVENT_ID })])
    } finally {
      await store.close()
    }
  })

  it("REJECTED moves the entry to the rejected ledger and logs the contract's reason", async () => {
    const store = await stubStore()
    try {
      const home = homeWithPending()
      store.saves.set(CONTEXT_ID, { state: "REJECTED", reason: "NO_AUTHORITY" })
      const logged: Record<string, unknown>[] = []
      const counts = await followPendingAnchors(fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }), (r) => logged.push(r))
      expect(counts).toEqual({ anchored: 0, rejected: 1, waiting: 0 })
      expect(pendingAnchors(home)).toHaveLength(0)
      expect(rejectedAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", reason: "NO_AUTHORITY" })])
      expect(logged).toEqual([expect.objectContaining({ outcome: "failed", lane: "batched", reason: "batch-rejected:NO_AUTHORITY", contextId: CONTEXT_ID })])
    } finally {
      await store.close()
    }
  })

  it("QUEUED and SUBMITTED keep the entry waiting — SUBMITTED updates the recorded state", async () => {
    const store = await stubStore()
    try {
      const home = homeWithPending()
      store.saves.set(CONTEXT_ID, { state: "SUBMITTED", reason: null })
      const logged: Record<string, unknown>[] = []
      const counts = await followPendingAnchors(fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }), (r) => logged.push(r))
      expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
      expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, state: "SUBMITTED" })])
      expect(logged).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("a status error never drops the entry — it stays exactly as it was, nothing logged", async () => {
    const store = await stubStore()
    try {
      const home = homeWithPending()
      store.saves.set(CONTEXT_ID, { httpError: 500 })
      const logged: Record<string, unknown>[] = []
      const counts = await followPendingAnchors(fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }), (r) => logged.push(r))
      expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
      expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, state: "QUEUED" })])
      expect(rejectedAnchors(home)).toHaveLength(0)
      expect(logged).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("an entry whose agent identity is gone cannot be asked about — it waits, untouched", async () => {
    const store = await stubStore()
    try {
      const home = homeWithPending(null) // no identity file for ghost-agent
      const logged: Record<string, unknown>[] = []
      const counts = await followPendingAnchors(fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }), (r) => logged.push(r))
      expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
      expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, agent: "ghost-agent" })])
      expect(store.paths.filter((p) => p.startsWith("GET /batch/saves/"))).toHaveLength(0)
      expect(logged).toHaveLength(0)
    } finally {
      await store.close()
    }
  })
})

describe("drain — a batched save is queued, not saved, until the store says ANCHORED", () => {
  const T0 = Date.parse("2026-09-24T10:00:00.000Z")

  function setup(store: { url: string }) {
    const d = dir()
    const home = new MidaHome(join(d, "mida"))
    writeIdentity(home, "claude-code")
    const homeDir = join(d, "user-home")
    mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
    const transcriptPath = join(homeDir, ".claude", "projects", "proj", "t.jsonl")
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
    const cwd = join(d, "work")
    mkdirSync(join(cwd, ".mida"), { recursive: true })
    writeFileSync(join(cwd, ".mida", "project.json"), JSON.stringify({ projectId: "p-1" }))
    const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url })
    // stands in for the real saveCheckpoint on the batched lane: receipt + ledger entry, no transaction
    const save: typeof saveCheckpoint = async () => {
      addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: new Date().toISOString() })
      return { contextId: CONTEXT_ID, transactionHash: null, milliseconds: 1, duplicate: false, lane: "batched", batched: { state: "QUEUED", receipt } }
    }
    const compile: typeof compileCheckpoint = async (input) => ({
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      retried: 0,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    })
    const checkProject: NonNullable<DrainDeps["checkProject"]> = async (input) => {
      const projectId = projectIdFor(input.cwd)
      return projectId === null
        ? { ok: false, reason: "not-a-project" }
        : { ok: true, approval: { agent: input.agent, projectId, root: input.cwd, approvedAt: "2026-09-24T00:00:00.000Z" } }
    }
    const drain = () =>
      drainOnce({ home, runtime, compile, save, homeDir, checkProject, isApproved: async () => true, now: () => new Date(T0 + 120_000) })
    const drainLog = () =>
      readFileSync(home.path("logs/drain.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    return { home, transcriptPath, cwd, drain, drainLog }
  }

  it("the job leaves the queue at QUEUED — the ledger owns it — and only ANCHORED earns a saved line", async () => {
    const store = await stubStore()
    try {
      const { home, transcriptPath, cwd, drain, drainLog } = setup(store)
      // the store has seen the save but not yet anchored it
      store.saves.set(CONTEXT_ID, { state: "SUBMITTED", reason: null })
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: SESSION_ID, transcriptPath, cwd, error: null }, () => new Date(T0))
      const first = await drain()
      expect(first.queued).toBe(1)
      expect(first.saved).toBe(0)
      expect(listJobs(home)).toHaveLength(0)
      const firstLog = drainLog()
      const queued = firstLog.find((r) => r.outcome === "queued")
      expect(queued).toMatchObject({ sessionId: SESSION_ID, lane: "batched", contextId: CONTEXT_ID })
      expect(firstLog.filter((r) => r.outcome === "saved")).toHaveLength(0)
      expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, state: "SUBMITTED" })])

      // a later pass — the queue is empty, but the ledger still asks the store; ANCHORED logs saved
      const batchId = `0x${"b2".repeat(32)}` as Hex
      store.saves.set(CONTEXT_ID, { state: "ANCHORED", reason: null, batchId })
      const second = await drain()
      expect(second.saved).toBe(0)
      const saved = drainLog().find((r) => r.outcome === "saved")
      expect(saved).toMatchObject({ lane: "batched", contextId: CONTEXT_ID, batchId, sessionId: SESSION_ID, eventId: EVENT_ID })
      expect(pendingAnchors(home)).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("a rejected save logs failed with batch-rejected:<reason> — never saved", async () => {
    const store = await stubStore()
    try {
      const { home, transcriptPath, cwd, drain, drainLog } = setup(store)
      store.saves.set(CONTEXT_ID, { state: "REJECTED", reason: "PARENT_MISMATCH" })
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: SESSION_ID, transcriptPath, cwd, error: null }, () => new Date(T0))
      await drain()
      const log = drainLog()
      expect(log.find((r) => r.outcome === "queued")).toMatchObject({ lane: "batched", contextId: CONTEXT_ID })
      expect(log.find((r) => r.outcome === "failed")).toMatchObject({ lane: "batched", reason: "batch-rejected:PARENT_MISMATCH" })
      expect(log.filter((r) => r.outcome === "saved")).toHaveLength(0)
      expect(rejectedAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, reason: "PARENT_MISMATCH" })])
    } finally {
      await store.close()
    }
  })
})

describe("doctor — the batching check", () => {
  const doctorLines = async (home: MidaHome, over: Partial<DoctorDeps> = {}): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({ home, print: (line: string) => lines.push(line), env: {}, daemonProbeMs: 50, ...over })
    return lines
  }

  const batchedHome = (storeUrl: string | undefined, batching: boolean) => {
    const home = new MidaHome(dir())
    home.writeSecretJson("network.json", {
      rpcUrl: "http://127.0.0.1:1",
      deployment: DEPLOYMENT_BATCHED_RAW,
      ...(storeUrl === undefined ? {} : { storageUrl: storeUrl }),
      ...(batching ? { batching: true } : {}),
    })
    return home
  }

  it("a switched-on setup with a cooperating store reports the batched lane", async () => {
    const store = await stubStore()
    try {
      const lines = await doctorLines(batchedHome(store.url, true))
      expect(lines).toContain(`ok: checkpoint saves: batched via ${store.host}`)
    } finally {
      await store.close()
    }
  })

  it("batching absent reports one transaction each — today's behaviour", async () => {
    const store = await stubStore()
    try {
      const lines = await doctorLines(batchedHome(store.url, false))
      expect(lines).toContain("ok: checkpoint saves: one transaction each")
      expect(lines.every((line) => !line.startsWith("PROBLEM: batching"))).toBe(true)
    } finally {
      await store.close()
    }
  })

  it("batching on but the lane is still direct is a PROBLEM naming the plain reason", async () => {
    const lines = await doctorLines(batchedHome("http://127.0.0.1:1", true)) // a store that never answers
    expect(lines).toContain("ok: checkpoint saves: one transaction each")
    expect(lines).toContain("PROBLEM: batching is on but saves are taking the direct lane: the hosted store did not answer the batching check — check the store or run `mida batching off`")
  })

  it("rejected saves each print a PROBLEM naming the reason and session", async () => {
    const home = batchedHome("http://127.0.0.1:1", false)
    home.writeSecretJson("state/batch-rejected.json", {
      entries: [{ contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", reason: "NO_AUTHORITY", at: "2026-09-24T10:05:00.000Z" }],
    })
    const lines = await doctorLines(home)
    expect(lines).toContain("PROBLEM: a checkpoint save was rejected on chain (NO_AUTHORITY, session s1) — it was not anchored; check the agent's approval with `mida doctor`")
  })

  it("young pending entries are a PENDING_ANCHOR note — never a problem, never 'saved'", async () => {
    const home = batchedHome("http://127.0.0.1:1", false)
    const NOW = Date.parse("2026-09-24T12:00:00.000Z")
    addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: new Date(NOW - 60_000).toISOString() })
    const lines = await doctorLines(home, { now: () => NOW })
    expect(lines).toContain("note: 1 checkpoint save(s) pending anchor (PENDING_ANCHOR)")
    expect(lines.every((line) => !line.includes("waiting to anchor"))).toBe(true)
  })

  it("pending entries older than ten minutes are a PROBLEM — unless the store already reports a final state", async () => {
    const home = batchedHome("http://127.0.0.1:1", false)
    const NOW = Date.parse("2026-09-24T12:00:00.000Z")
    addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: new Date(NOW - 11 * 60_000).toISOString() })
    // the store cannot be asked → stuck
    const stuck = await doctorLines(home, { now: () => NOW, probeBatchSave: async () => null })
    expect(stuck).toContain("PROBLEM: 1 checkpoint save(s) waiting to anchor for over 10 minutes — check the store at 127.0.0.1:1")
    // the store says it already anchored — quiet, not a stuck report
    const settled = await doctorLines(home, { now: () => NOW, probeBatchSave: async () => ({ state: "ANCHORED", reason: null }) })
    expect(settled.every((line) => !line.includes("waiting to anchor"))).toBe(true)
    // the store says it was rejected — the rejection problem, not the stuck one
    const rejected = await doctorLines(home, { now: () => NOW, probeBatchSave: async () => ({ state: "REJECTED", reason: "READ_EPOCH_STALE" }) })
    expect(rejected).toContain("PROBLEM: a checkpoint save was rejected on chain (READ_EPOCH_STALE, session s1) — it was not anchored; check the agent's approval with `mida doctor`")
  })
})

describe("mida batching on|off", () => {
  const setup = async (over: { batching?: boolean; withStore?: boolean; batchAnchor?: boolean; networkJson?: boolean } = {}) => {
    const rpc = await stubRpc()
    const store = over.withStore === false ? undefined : await stubStore()
    const home = new MidaHome(dir())
    if (over.networkJson !== false) {
      const deployment = over.batchAnchor === false ? DEPLOYMENT_RAW : DEPLOYMENT_BATCHED_RAW
      home.writeSecretJson("network.json", {
        rpcUrl: rpc.url,
        deployment,
        ...(store === undefined ? {} : { storageUrl: store.url }),
        sponsorUrl: "https://sponsor.example",
        ...(over.batching === undefined ? {} : { batching: over.batching }),
      })
    }
    const network: Network = {
      rpcUrl: rpc.url,
      deployment: over.batchAnchor === false ? DEPLOYMENT : DEPLOYMENT_BATCHED,
      ...(store === undefined ? {} : { storageUrl: store.url }),
    }
    const lines: string[] = []
    const asked: string[] = []
    const kicks: number[] = []
    let answer = "yes"
    const run = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => lines.push(line),
        drainInput: async () => {},
        prompt: async (question) => {
          asked.push(question)
          return answer
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
        kickDaemon: () => void kicks.push(1),
      })
    const close = async () => {
      await rpc.close()
      await store?.close()
    }
    return { rpc, store, home, lines, asked, kicks, run, close, sayNo: () => (answer = "no") }
  }

  it("on switches the flag, kicks the daemon, and leaves every other byte of network.json alone", async () => {
    const { store, home, lines, asked, kicks, run, close } = await setup({ withStore: true })
    try {
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(await run("batching", "on")).toBe(0)
      expect(lines).toContain(
        `automatic checkpoint saves will be anchored in shared batches via ${store!.host}; grants, revokes and facts are unaffected; saves are usable at once and marked PENDING_ANCHOR until anchored`,
      )
      expect(lines).toContain("batching is on")
      expect(asked).toEqual(["Type yes to turn batching on: "])
      expect(kicks).toHaveLength(1)
      const after = readFileSync(home.path("network.json"), "utf8")
      const leading = before.slice(1, before.indexOf('"', 1))
      expect(after).toBe(`{${leading}"batching": true,${before.slice(1)}`)
      // rpcUrl, deployment, storageUrl, sponsorUrl — identical, byte for byte
      const parsed = JSON.parse(after) as Record<string, unknown>
      for (const key of ["rpcUrl", "deployment", "storageUrl", "sponsorUrl"]) {
        expect(parsed[key]).toEqual((JSON.parse(before) as Record<string, unknown>)[key])
      }
    } finally {
      await close()
    }
  })

  it("on refuses with the plain reason when the lane would still be direct — nothing is written", async () => {
    // the store answers, but it does not offer batching on this contract
    const dead = await setup({ withStore: true })
    try {
      dead.store!.status.enabled = false
      const before = readFileSync(dead.home.path("network.json"), "utf8")
      expect(await dead.run("batching", "on")).toBe(1)
      expect(dead.lines).toContain("batching cannot be turned on: the hosted store is not offering batching on this setup's contracts")
      expect(readFileSync(dead.home.path("network.json"), "utf8")).toBe(before)
      expect(dead.kicks).toHaveLength(0)
    } finally {
      await dead.close()
    }
    // and a setup on the local store refuses the same way
    const local = await setup({ withStore: false })
    try {
      expect(await local.run("batching", "on")).toBe(1)
      expect(local.lines).toContain("batching cannot be turned on: this setup keeps context on this machine — batching needs the hosted store")
    } finally {
      await local.close()
    }
    // a deployment that predates BatchAnchor refuses too
    const old = await setup({ withStore: true, batchAnchor: false })
    try {
      expect(await old.run("batching", "on")).toBe(1)
      expect(old.lines).toContain("batching cannot be turned on: this setup's contracts do not include a BatchAnchor")
    } finally {
      await old.close()
    }
  })

  it("off writes batching:false, preserves the rest, and says queued saves still finish", async () => {
    const { home, lines, kicks, run, close } = await setup({ withStore: true, batching: true })
    try {
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(await run("batching", "off")).toBe(0)
      expect(lines).toContain("batching is off; saves already queued will still finish")
      expect(kicks).toHaveLength(1)
      expect(readFileSync(home.path("network.json"), "utf8")).toBe(before.replace('"batching": true', '"batching": false'))
    } finally {
      await close()
    }
  })

  it("a passkey home runs the same switch — off needs no owner signature and no owner key", async () => {
    const { home, lines, kicks, run, close } = await setup({ withStore: true, batching: true })
    try {
      saveOwnerMode(home, "passkey")
      saveOwnerAddress(home, OWNER)
      expect(await run("batching", "off")).toBe(0)
      expect(lines).toContain("batching is off; saves already queued will still finish")
      expect(kicks).toHaveLength(1)
      expect((home.readJson<Record<string, unknown>>("network.json") ?? {}).batching).toBe(false)
      // the passkey path must never have created owner secrets
      expect(home.has("owner/secrets.json")).toBe(false)
    } finally {
      await close()
    }
  })

  it("an answer other than yes writes nothing; a missing argument is usage; no network.json refuses plainly", async () => {
    const { home, lines, run, close, sayNo } = await setup({ withStore: true })
    try {
      sayNo()
      const before = readFileSync(home.path("network.json"), "utf8")
      expect(await run("batching", "on")).toBe(1)
      expect(lines).toContain("not approved")
      expect(readFileSync(home.path("network.json"), "utf8")).toBe(before)
      expect(await run("batching")).toBe(2)
    } finally {
      await close()
    }
    const bare = await setup({ withStore: true, networkJson: false })
    try {
      expect(await bare.run("batching", "off")).toBe(1)
      expect(bare.lines).toContain("batching cannot be turned off: there is no network.json to switch — run `mida init` first")
    } finally {
      await bare.close()
    }
  })
})
