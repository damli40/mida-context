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
import { StoreHttpError } from "@mida/api"
import type { BatchReceipt } from "@mida/api"
import { MidaError } from "@mida/protocol"
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
} from "@mida/midad"
import type { DoctorDeps, DrainDeps, Network, ServiceRuntime } from "@mida/midad"
import {
  addPendingAnchor,
  decideLane,
  followPendingAnchors,
  keepPendingPlaintext,
  laneWhyText,
  pendingAnchors,
  pendingPlaintext,
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
async function stubStore(status: { enabled: boolean; batchAnchor?: string } = { enabled: true, batchAnchor: ANCHOR }): Promise<{
  url: string
  host: string
  status: { enabled: boolean; batchAnchor?: string }
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

  it("a status answer without a usable batchAnchor is store-disabled — never a crash (in-20 T-1)", async () => {
    // A lane degraded by bad store config reports enabled:false and may carry no anchor; a
    // malformed answer that claims enabled:true but omits it must not throw on .toLowerCase().
    for (const answer of [{ enabled: false }, { enabled: true }, { enabled: true, batchAnchor: 7 }]) {
      const lane = await decideLane({
        saved: saved(true),
        deployment: DEPLOYMENT_BATCHED,
        storageUrl: "http://store.example",
        status: (async () => answer) as never,
      })
      expect(lane).toEqual({ kind: "direct", why: "store-disabled" })
    }
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
        findDuplicate: async () => undefined,
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
      let creates = 0
      const agent = {
        findDuplicate: async () => earlier,
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
        findDuplicate: async () => {
          throw new MidaError("PARTIAL_READ", "the batched checkpoint list was incomplete — refusing to risk a duplicate save")
        },
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

  it("a lane-closed answer at POST time — the lane went down between the status check and the save — still lands, on the direct lane (in-20 T-1)", async () => {
    // The status probe said enabled, then the store's batching config broke before the POST:
    // the save must take the direct lane, not die on a lane that is already closed.
    const store = await stubStore()
    try {
      for (const code of ["BATCHING_DISABLED", "BATCH_UNAVAILABLE", "OWNER_NOT_ALLOWED"] as const) {
        const home = batchedHome(store.url)
        const agent = {
          findDuplicate: async () => undefined,
          createBatched: async () => {
            throw new MidaError(code as never, "the batched lane is closed")
          },
          create: async () => ({ contextId: CONTEXT_ID, transactionHash: `0x${"ee".repeat(32)}` as Hex }),
        }
        const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
        const result = await saveCheckpoint(runtime, "claude-code", saveInput)
        expect(result.lane).toBe("direct")
        expect(result.contextId).toBe(CONTEXT_ID)
        expect(result.transactionHash).toBe(`0x${"ee".repeat(32)}`)
        expect(result.laneWhy).toBe("store-disabled")
        expect(pendingAnchors(home)).toHaveLength(0)
      }
    } finally {
      await store.close()
    }
  })

  it("batching on but the store says off → the save still happens directly, with laneWhy recorded", async () => {
    const store = await stubStore({ enabled: false, batchAnchor: ANCHOR })
    try {
      const home = batchedHome(store.url)
      const agent = {
        findDuplicate: async () => undefined,
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
      findDuplicate: async () => undefined,
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
      findDuplicate: async () => undefined,
      create: async () => ({ contextId: CONTEXT_ID, transactionHash: null }),
    }
    const runtime = fakeRuntime(home, { agent })
    const result = await saveCheckpoint(runtime, "claude-code", saveInput)
    expect(result.lane).toBe("direct")
    expect(result.laneWhy).toBeUndefined()
    expect(result.batched).toBeUndefined()
  })

  // in-14 F-3: the store can hold the save already (an earlier POST landed, its answer died
  // on the wire) — it answers ALREADY_QUEUED with the id it holds. That is a queued save,
  // not an error: the drain records the ledgers under that id and never posts it again.
  it("a store already holding the save answers ALREADY_QUEUED with its id — queued, ledgers written, never re-posted", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      let posts = 0
      const agent = {
        findDuplicate: async () => undefined,
        createBatched: async () => {
          posts += 1
          const error = new MidaError("ALREADY_QUEUED" as never, "the store already holds this save")
          ;(error as { contextId?: Hex }).contextId = CONTEXT_ID
          throw error
        },
        create: async () => {
          throw new Error("unreachable")
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      const result = await saveCheckpoint(runtime, "claude-code", saveInput)
      expect(result).toMatchObject({ contextId: CONTEXT_ID, transactionHash: null, duplicate: false, lane: "batched" })
      expect(result.batched).toMatchObject({ state: "QUEUED" })
      // the ledgers own the save under the id the store holds — plaintext kept for resubmits
      expect(pendingAnchors(home)).toEqual([
        expect.objectContaining({ contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", state: "QUEUED" }),
      ])
      expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
      expect((home.readJson<Record<string, string>>("state/saved-ids.json") ?? {})[EVENT_ID]).toBe(CONTEXT_ID)
      // and the drain asking again for the same eventId answers duplicate — never a second POST
      const again = await saveCheckpoint(runtime, "claude-code", saveInput)
      expect(again.duplicate).toBe(true)
      expect(again.contextId).toBe(CONTEXT_ID)
      expect(posts).toBe(1)
    } finally {
      await store.close()
    }
  })

  it("ALREADY_QUEUED carrying no id cannot be followed — the save surfaces as an error, nothing written", async () => {
    const store = await stubStore()
    try {
      const home = batchedHome(store.url)
      const agent = {
        findDuplicate: async () => undefined,
        createBatched: async () => {
          throw new MidaError("ALREADY_QUEUED" as never, "no id to follow")
        },
        create: async () => {
          throw new Error("unreachable")
        },
      }
      const runtime = fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url, agent })
      await expect(saveCheckpoint(runtime, "claude-code", saveInput)).rejects.toMatchObject({ code: "ALREADY_QUEUED" })
      expect(pendingAnchors(home)).toHaveLength(0)
      expect(pendingPlaintext(home, CONTEXT_ID)).toBeUndefined()
    } finally {
      await store.close()
    }
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
      // the kept plaintext names which model wrote the save — the batched lane's saved line
      // must carry it the way the direct lane does (UF-P2R)
      keepPendingPlaintext(home, CONTEXT_ID, { value: { ...saveInput, compiledBy: "codex-luna" } })
      const batchId = `0x${"b1".repeat(32)}` as Hex
      store.saves.set(CONTEXT_ID, { state: "ANCHORED", reason: null, batchId })
      const logged: Record<string, unknown>[] = []
      const counts = await followPendingAnchors(fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }), (r) => logged.push(r))
      expect(counts).toEqual({ anchored: 1, rejected: 0, waiting: 0 })
      expect(pendingAnchors(home)).toHaveLength(0)
      expect(logged).toEqual([expect.objectContaining({ outcome: "saved", lane: "batched", contextId: CONTEXT_ID, batchId, sessionId: SESSION_ID, eventId: EVENT_ID, model: "codex-luna" })])
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

  // in-11 R-7: a stale-epoch resubmission met by a store that could not say — busy, 5xx, a
  // pending deny — must wait for the next pass unspent, not be recorded as finally rejected
  // with its recoverable plaintext deleted.
  describe("a stale-epoch resubmission that cannot get an answer waits unspent (in-11 R-7)", () => {
    const homeWithStaleRejected = async (store: Awaited<ReturnType<typeof stubStore>>) => {
      const home = new MidaHome(dir())
      writeIdentity(home, "claude-code")
      addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: "2026-09-24T10:00:00.000Z" })
      keepPendingPlaintext(home, CONTEXT_ID, { value: { type: "mida-checkpoint" }, kind: "EPISODE", source: "AGENT_INFERRED", tags: [] })
      store.saves.set(CONTEXT_ID, { state: "REJECTED", reason: "BAD_EPOCH" })
      return home
    }

    const resubmitWith = (store: Awaited<ReturnType<typeof stubStore>>, home: MidaHome, thrown: () => unknown) => {
      const runtime = {
        ...fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }),
        agent: () => ({ createBatched: async () => { throw thrown() } }),
        reader: { hasAuthority: async () => true },
      } as unknown as ServiceRuntime
      const logged: Record<string, unknown>[] = []
      return { runtime, logged }
    }

    for (const code of ["CHAIN_UNAVAILABLE", "INTERNAL_ERROR", "WRITE_DENIED"] as const) {
      it(`a ${code} answer to the resubmission keeps the save waiting and the plaintext kept`, async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const { runtime, logged } = resubmitWith(store, home, () => new MidaError(code, "the answer never came"))
          const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
          expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
          // never recorded as rejected — and the retry cap is not spent on a non-answer
          expect(rejectedAnchors(home)).toHaveLength(0)
          expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID })])
          expect(pendingAnchors(home)[0]!.retries ?? 0).toBe(0)
          expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
          expect(logged).toHaveLength(0)
        } finally {
          await store.close()
        }
      })
    }

    it("a 5xx page with no Mida body waits unspent — any 5xx counts", async () => {
      const store = await stubStore()
      try {
        const home = await homeWithStaleRejected(store)
        const { runtime, logged } = resubmitWith(store, home, () => new StoreHttpError(503, "Service Unavailable"))
        const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
        expect(counts.waiting).toBe(1)
        expect(rejectedAnchors(home)).toHaveLength(0)
        expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
      } finally {
        await store.close()
      }
    })

    it("a store refusal that judges the save is still final — CAPABILITY_DENIED refuses", async () => {
      const store = await stubStore()
      try {
        const home = await homeWithStaleRejected(store)
        const { runtime, logged } = resubmitWith(store, home, () => new MidaError("CAPABILITY_DENIED", "no live grant"))
        const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
        expect(counts).toEqual({ anchored: 0, rejected: 1, waiting: 0 })
        expect(rejectedAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, reason: "BAD_EPOCH" })])
        expect(pendingPlaintext(home, CONTEXT_ID)).toBeUndefined()
        expect(logged).toEqual([expect.objectContaining({ outcome: "failed", reason: "batch-rejected:BAD_EPOCH" })])
      } finally {
        await store.close()
      }
    })

    // in-12 N-3: finality is an ALLOWLIST of authority answers now — under the old "any string
    // code but EPOCH_STALE" rule, every one of these wiped the pending entry and its plaintext.
    describe("the final-code allowlist — a store error page can never delete the save (in-12 N-3)", () => {
      const waitsUnspent: [string, () => unknown][] = [
        ["a StoreHttpError 429 rate-limit page", () => new StoreHttpError(429, "<html>rate limited</html>")],
        ["a StoreHttpError 403 challenge page", () => new StoreHttpError(403, "<html>Attention Required</html>")],
        ["a StoreHttpError 404 plain-text page", () => new StoreHttpError(404, "404 Not Found")],
        ["the store's own RATE_LIMITED limiter", () => new MidaError("RATE_LIMITED" as never, "too many requests")],
        ["the store's CHAIN_MISCONFIGURED", () => new MidaError("CHAIN_MISCONFIGURED" as never, "no contract")],
        ["the store's RPC_AUTH_REJECTED", () => new MidaError("RPC_AUTH_REJECTED" as never, "refused key")],
        ["an error carrying no code at all", () => new TypeError("fetch failed")],
        ["a code this build does not know", () => new MidaError("FUTURE_STORE_CODE" as never, "new refusal")],
      ]
      for (const [label, thrown] of waitsUnspent) {
        it(`${label} waits unspent — entry, plaintext and retry budget all kept`, async () => {
          const store = await stubStore()
          try {
            const home = await homeWithStaleRejected(store)
            const { runtime, logged } = resubmitWith(store, home, thrown)
            const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
            expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
            expect(rejectedAnchors(home)).toHaveLength(0)
            expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID })])
            expect(pendingAnchors(home)[0]!.retries ?? 0).toBe(0)
            expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
            expect(logged).toHaveLength(0)
          } finally {
            await store.close()
          }
        })
      }

      // in-13 M-4: ALREADY_QUEUED leaves the final set — the store already holding the save is
      // the successful POST's answer through the error channel, tested below.
      for (const code of ["CAPABILITY_DENIED", "CAPABILITY_REVOKED", "CAPABILITY_EXPIRED", "NOT_AN_AGENT", "SIGNER_MISMATCH"] as const) {
        it(`a ${code} answer is final — the save is judged, its plaintext dropped`, async () => {
          const store = await stubStore()
          try {
            const home = await homeWithStaleRejected(store)
            const { runtime, logged } = resubmitWith(store, home, () => new MidaError(code as never, "the store judged the save"))
            const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
            expect(counts).toEqual({ anchored: 0, rejected: 1, waiting: 0 })
            expect(rejectedAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID })])
            expect(pendingAnchors(home)).toHaveLength(0)
            expect(pendingPlaintext(home, CONTEXT_ID)).toBeUndefined()
            expect(logged).toEqual([expect.objectContaining({ outcome: "failed" })])
          } finally {
            await store.close()
          }
        })
      }

      it("EPOCH_STALE answering the resubmission itself spends one retry against the cap", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const { runtime, logged } = resubmitWith(store, home, () => new MidaError("EPOCH_STALE" as never, "still stale"))
          const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
          expect(counts.waiting).toBe(1)
          expect(pendingAnchors(home)[0]!.retries).toBe(1)
          expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
        } finally {
          await store.close()
        }
      })
    })

    // in-13 M-4: the resubmission's answer is one of four classes, not two. The allowlist above
    // is only the authority class — under the old code ALREADY_QUEUED deleted the kept plaintext
    // (recorded as a refusal while the save sat queued at the store), and a "will not change"
    // answer burned a POST on every drain pass forever, silently.
    describe("the resubmission answer's other three classes (in-13 M-4)", () => {
      const RESUBMIT_ID = `0x${"dd".repeat(32)}` as Hex

      const carryingContextId = (error: Error, contextId: Hex): Error => {
        ;(error as { contextId?: Hex }).contextId = contextId
        return error
      }

      it("ALREADY_QUEUED is a successful POST wearing an error — the save is followed under the id the store holds", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const { runtime, logged } = resubmitWith(store, home, () => carryingContextId(new MidaError("ALREADY_QUEUED" as never, "the store already holds this save"), RESUBMIT_ID))
          const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
          // exactly the successful-POST bookkeeping: pending entry, kept plaintext and the
          // saved-id index all move onto the contextId the resubmission attempted — and nothing
          // is ever recorded or logged as failed.
          expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
          expect(rejectedAnchors(home)).toHaveLength(0)
          expect(pendingAnchors(home)).toEqual([
            expect.objectContaining({ contextId: RESUBMIT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", state: "QUEUED" }),
          ])
          expect(pendingPlaintext(home, RESUBMIT_ID)).toBeDefined()
          expect(pendingPlaintext(home, CONTEXT_ID)).toBeUndefined()
          expect((home.readJson<Record<string, string>>("state/saved-ids.json") ?? {})[EVENT_ID]).toBe(RESUBMIT_ID)
          expect(logged).toEqual([expect.objectContaining({ outcome: "requeued", contextId: RESUBMIT_ID, previousContextId: CONTEXT_ID })])
        } finally {
          await store.close()
        }
      })

      it("ALREADY_QUEUED carrying no attempted id cannot be followed — the save waits unjudged", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const { runtime, logged } = resubmitWith(store, home, () => new MidaError("ALREADY_QUEUED" as never, "no id to follow"))
          const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
          expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
          expect(rejectedAnchors(home)).toHaveLength(0)
          expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID })])
          expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
          expect(logged).toHaveLength(0)
        } finally {
          await store.close()
        }
      })

      for (const code of ["BATCHING_DISABLED", "BATCH_UNAVAILABLE", "OWNER_NOT_ALLOWED", "TOO_LARGE", "BAD_SHAPE", "COMMITMENT_MISMATCH", "INVALID_WIRE"] as const) {
        it(`a ${code} answer marks the save stuck — plaintext kept, entry kept, nothing final recorded`, async () => {
          const store = await stubStore()
          try {
            const home = await homeWithStaleRejected(store)
            const { runtime, logged } = resubmitWith(store, home, () => new MidaError(code as never, "the store judged the save as composed"))
            const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
            expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
            expect(rejectedAnchors(home)).toHaveLength(0)
            const [entry] = pendingAnchors(home)
            expect(entry).toMatchObject({ contextId: CONTEXT_ID, stuck: code })
            expect(typeof entry?.stuckAt).toBe("string")
            expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
            expect(logged).toHaveLength(0)
          } finally {
            await store.close()
          }
        })
      }

      it("a marked save re-POSTs at most once an hour — the passes inside the hour send nothing", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          let posts = 0
          const runtime = {
            ...fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }),
            agent: () => ({
              createBatched: async () => {
                posts += 1
                throw new MidaError("BAD_SHAPE" as never, "malformed")
              },
            }),
            reader: { hasAuthority: async () => true },
          } as unknown as ServiceRuntime
          const first = await followPendingAnchors(runtime, () => {})
          expect(posts).toBe(1) // the attempt that marked it
          expect(first.waiting).toBe(1)
          const second = await followPendingAnchors(runtime, () => {})
          expect(posts).toBe(1) // inside the hour: the store is asked, the save is not re-POSTed
          expect(second.waiting).toBe(1)
          expect(store.paths.filter((p) => p.startsWith("GET /batch/saves/")).length).toBeGreaterThan(0)
          expect(pendingAnchors(home)[0]).toMatchObject({ contextId: CONTEXT_ID, stuck: "BAD_SHAPE" })
        } finally {
          await store.close()
        }
      })

      it("an hour after the last attempt the save is tried again — a fresh stuck answer re-stamps the wait", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const hourAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString()
          addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: "2026-09-24T10:00:00.000Z", stuck: "BAD_SHAPE", stuckAt: hourAgo })
          let posts = 0
          const runtime = {
            ...fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }),
            agent: () => ({
              createBatched: async () => {
                posts += 1
                throw new MidaError("BAD_SHAPE" as never, "still malformed")
              },
            }),
            reader: { hasAuthority: async () => true },
          } as unknown as ServiceRuntime
          const counts = await followPendingAnchors(runtime, () => {})
          expect(posts).toBe(1)
          expect(counts.waiting).toBe(1)
          const [entry] = pendingAnchors(home)
          expect(entry).toMatchObject({ stuck: "BAD_SHAPE" })
          expect(Date.parse(entry!.stuckAt!)).toBeGreaterThan(Date.parse(hourAgo))
          // and the pass right after does not POST again — the fresh stamp opened a new hour
          const again = await followPendingAnchors(runtime, () => {})
          expect(posts).toBe(1)
          expect(again.waiting).toBe(1)
        } finally {
          await store.close()
        }
      })
    })

    // in-14 F-3: BATCHING_DISABLED and OWNER_NOT_ALLOWED mean the batched lane itself is
    // closed — to this owner or entirely. Re-POSTing the same bytes there once an hour can
    // never land. The resubmit takes the DIRECT lane instead: the ordinary one-transaction
    // save from the kept plaintext.
    describe("a resubmission that meets a closed lane lands through the direct lane (in-14 F-3)", () => {
      const DIRECT_ID = `0x${"e1".repeat(32)}` as Hex
      const DIRECT_TX = `0x${"9a".repeat(32)}` as Hex

      const directResubmitRuntime = (store: Awaited<ReturnType<typeof stubStore>>, home: MidaHome, over: { thrown: () => unknown; create?: (input: unknown) => Promise<unknown> }) => {
        const created: unknown[] = []
        const runtime = {
          ...fakeRuntime(home, { network: batchedNetwork(store.url), apiBaseUrl: store.url }),
          agent: () => ({
            createBatched: async () => {
              throw over.thrown()
            },
            create: async (_owner: Address, _namespace: string, input: unknown) => {
              created.push(input)
              if (over.create !== undefined) return over.create(input)
              return { contextId: DIRECT_ID, transactionHash: DIRECT_TX }
            },
          }),
          reader: { hasAuthority: async () => true },
        } as unknown as ServiceRuntime
        return { runtime, created }
      }

      for (const code of ["BATCHING_DISABLED", "BATCH_UNAVAILABLE", "OWNER_NOT_ALLOWED"] as const) {
        it(`a ${code} answer resubmits through the direct lane — the save lands, not stuck`, async () => {
          const store = await stubStore()
          try {
            const home = await homeWithStaleRejected(store)
            const { runtime, created } = directResubmitRuntime(store, home, { thrown: () => new MidaError(code as never, "the batched lane is closed") })
            const logged: Record<string, unknown>[] = []
            const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
            expect(counts).toEqual({ anchored: 1, rejected: 0, waiting: 0 })
            // the kept createBatched input went to create — same envelope, kind, source, tags
            expect(created).toEqual([{ value: { type: "mida-checkpoint" }, kind: "EPISODE", source: "AGENT_INFERRED", tags: [] }])
            // the save is done: pending entry gone, plaintext spent, saved id is the new record's
            expect(pendingAnchors(home)).toHaveLength(0)
            expect(pendingPlaintext(home, CONTEXT_ID)).toBeUndefined()
            expect(rejectedAnchors(home)).toHaveLength(0)
            expect((home.readJson<Record<string, string>>("state/saved-ids.json") ?? {})[EVENT_ID]).toBe(DIRECT_ID)
            expect(logged).toEqual([
              expect.objectContaining({ outcome: "saved", lane: "direct", contextId: DIRECT_ID, previousContextId: CONTEXT_ID, transactionHash: DIRECT_TX }),
            ])
          } finally {
            await store.close()
          }
        })
      }

      it("a direct-lane resubmit that cannot get an answer waits — nothing final recorded", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const { runtime } = directResubmitRuntime(store, home, {
            thrown: () => new MidaError("BATCHING_DISABLED" as never, "closed"),
            create: async () => {
              throw new TypeError("fetch failed")
            },
          })
          const logged: Record<string, unknown>[] = []
          const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
          expect(counts).toEqual({ anchored: 0, rejected: 0, waiting: 1 })
          expect(pendingAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID })])
          expect(rejectedAnchors(home)).toHaveLength(0)
          expect(pendingPlaintext(home, CONTEXT_ID)).toBeDefined()
          expect(logged).toHaveLength(0)
        } finally {
          await store.close()
        }
      })

      it("a direct-lane refusal on authority grounds is final — the save is judged, plaintext dropped", async () => {
        const store = await stubStore()
        try {
          const home = await homeWithStaleRejected(store)
          const { runtime } = directResubmitRuntime(store, home, {
            thrown: () => new MidaError("OWNER_NOT_ALLOWED" as never, "closed"),
            create: async () => {
              throw new MidaError("CAPABILITY_DENIED" as never, "no live grant")
            },
          })
          const logged: Record<string, unknown>[] = []
          const counts = await followPendingAnchors(runtime, (r) => logged.push(r))
          expect(counts).toEqual({ anchored: 0, rejected: 1, waiting: 0 })
          expect(pendingAnchors(home)).toHaveLength(0)
          expect(rejectedAnchors(home)).toEqual([expect.objectContaining({ contextId: CONTEXT_ID, reason: "BAD_EPOCH" })])
          expect(pendingPlaintext(home, CONTEXT_ID)).toBeUndefined()
          expect(logged).toEqual([expect.objectContaining({ outcome: "failed", reason: "batch-rejected:BAD_EPOCH" })])
        } finally {
          await store.close()
        }
      })
    })
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

  it("a store answering enabled:false with no anchor — the config-invalid shape — is store-disabled, not unreachable (in-20 T-1)", async () => {
    // The degraded store's status may carry no batchAnchor at all; it ANSWERED, so the honest
    // reason is "not offering batching on this setup's contracts", never "did not answer".
    const store = await stubStore({ enabled: false })
    try {
      const lines = await doctorLines(batchedHome(store.url, true))
      expect(lines).toContain("ok: checkpoint saves: one transaction each")
      expect(lines).toContain(
        "PROBLEM: batching is on but saves are taking the direct lane: the hosted store is not offering batching on this setup's contracts — check the store or run `mida batching off`",
      )
    } finally {
      await store.close()
    }
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

  it("a save the store cannot accept is a PROBLEM naming the save, the plain reason and the fix (in-13 M-4)", async () => {
    const home = batchedHome("http://127.0.0.1:1", false)
    addPendingAnchor(home, {
      contextId: CONTEXT_ID,
      eventId: EVENT_ID,
      sessionId: SESSION_ID,
      agent: "claude-code",
      queuedAt: "2026-09-24T10:00:00.000Z",
      stuck: "TOO_LARGE",
      stuckAt: "2026-09-24T11:00:00.000Z",
    })
    const lines = await doctorLines(home)
    // in-14 F-3: a deterministic refusal can NEVER land — the line must say so, name where the
    // save's text is kept on this laptop, and name it a bug to report. `mida batching off` is
    // never the fix: the same bytes take the direct lane malformed too.
    expect(lines).toContain(
      `PROBLEM: a checkpoint save (cp-batched-1, session s1) cannot be resubmitted: the save does not fit in a batch — its text is kept on this laptop at ${home.path("state/batch-plaintext/" + CONTEXT_ID.toLowerCase() + ".json")} — the save can never land as it is; this is a bug to report; it retries once an hour meanwhile`,
    )
    // it is not ALSO reported as silently pending or probed as a stuck batch
    expect(lines.every((line) => !line.includes("pending anchor"))).toBe(true)
    expect(lines.every((line) => !line.includes("waiting to anchor"))).toBe(true)
  })

  it("every stuck code has a plain-words line — never the raw wire code alone", async () => {
    for (const [code, words] of [
      ["BATCHING_DISABLED", "no longer offering batching"],
      ["BATCH_UNAVAILABLE", "batch lane is unavailable"],
      ["OWNER_NOT_ALLOWED", "not allowed to write"],
      ["TOO_LARGE", "does not fit"],
      ["BAD_SHAPE", "malformed"],
      ["COMMITMENT_MISMATCH", "does not match"],
      ["INVALID_WIRE", "not valid"],
    ] as const) {
      const home = batchedHome("http://127.0.0.1:1", false)
      addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: "2026-09-24T10:00:00.000Z", stuck: code, stuckAt: "2026-09-24T11:00:00.000Z" })
      const lines = await doctorLines(home)
      const problem = lines.find((line) => line.startsWith("PROBLEM: a checkpoint save"))
      expect(problem).toBeDefined()
      expect(problem).toContain(words)
      expect(problem).toContain("retries once an hour")
    }
  })

  // in-14 F-3: the line's fix clause splits by what the code means. A closed LANE
  // (BATCHING_DISABLED, OWNER_NOT_ALLOWED) heals itself — the resubmit goes out on the save's
  // own transaction. A save the store judged AS COMPOSED can never land: `mida batching off`
  // is the wrong advice (the same bytes fail the direct lane too) — the line says the text is
  // kept on this laptop, where, and that this is a bug to report.
  it("a closed lane says the save goes out on its own transaction — a refused-as-composed save names its kept text and the bug report", async () => {
    for (const code of ["BATCHING_DISABLED", "BATCH_UNAVAILABLE", "OWNER_NOT_ALLOWED"] as const) {
      const home = batchedHome("http://127.0.0.1:1", false)
      addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: "2026-09-24T10:00:00.000Z", stuck: code, stuckAt: "2026-09-24T11:00:00.000Z" })
      const lines = await doctorLines(home)
      const problem = lines.find((line) => line.startsWith("PROBLEM: a checkpoint save"))
      expect(problem).toBeDefined()
      expect(problem).toContain("resent on its own transaction")
      // the save still lands — nothing here needs the switch
      expect(problem).not.toContain("mida batching off")
    }
    for (const code of ["TOO_LARGE", "BAD_SHAPE", "COMMITMENT_MISMATCH", "INVALID_WIRE"] as const) {
      const home = batchedHome("http://127.0.0.1:1", false)
      addPendingAnchor(home, { contextId: CONTEXT_ID, eventId: EVENT_ID, sessionId: SESSION_ID, agent: "claude-code", queuedAt: "2026-09-24T10:00:00.000Z", stuck: code, stuckAt: "2026-09-24T11:00:00.000Z" })
      const lines = await doctorLines(home)
      const problem = lines.find((line) => line.startsWith("PROBLEM: a checkpoint save"))
      expect(problem).toBeDefined()
      expect(problem).toContain("its text is kept on this laptop at " + home.path("state/batch-plaintext/" + CONTEXT_ID.toLowerCase() + ".json"))
      expect(problem).toContain("bug to report")
      expect(problem).not.toContain("mida batching off")
    }
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
