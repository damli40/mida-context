import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MULTICALL3_ADDRESS, chainFor, readScopeProbe, rpcTransportProbe } from "@mida/chain"
import type { Hex } from "@mida/protocol"
import { localEnvironment, startApiServer } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome, Runtime, approve, authorNamesFor, buildHandoff, callDaemon, init, requestAccess,
  runCli, saveCheckpoint, startDaemon, startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, HandoffResult, Network } from "@mida/midad"
import { followPendingAnchors, pendingAnchors } from "../src/batching.js"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const MULTICALL3_FIXTURE = fileURLToPath(new URL("./fixtures/multicall3-runtime.hex", import.meta.url))

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

/**
 * The Multicall3 runtime bytes, verbatim — comment lines (starting with `#`) dropped, the rest
 * joined. Verified Monad-testnet code; viem's shipped creation bytecode deploys empty on a
 * default Anvil, so the real bytes live in the fixture.
 */
const multicall3Code = (): Hex =>
  readFileSync(MULTICALL3_FIXTURE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("") as Hex

const anvilRpc = async (rpcUrl: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: unknown }
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

/**
 * A loopback JSON-RPC forwarder: POSTs arrive on its own port and are relayed verbatim to the
 * node. The store's public client is built on THIS url while every client-side reader keeps the
 * node's real one — so a fetch spy can split "store-side" from "client-side" by the request's
 * target, which survives viem's multicall scheduler firing the aggregate call from a context
 * that carries no caller frames (a stack sniff cannot attribute batched calls).
 */
const startRpcProxy = async (upstream: string): Promise<{ url: string; close(): Promise<void> }> =>
  new Promise((resolve) => {
    // Bound at creation, before any measurement spy wraps globalThis.fetch — a forwarded POST
    // must not be counted as a second, client-side request by the tally.
    const forward = globalThis.fetch
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        void forward(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks),
        })
          .then(async (response) => {
            res.writeHead(response.status, { "content-type": "application/json" })
            res.end(await response.text())
          })
          .catch((error: unknown) => {
            res.writeHead(502)
            res.end(String(error))
          })
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) throw new Error("rpc proxy has no port")
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })

/**
 * Counts every JSON-RPC request to the node while `run` executes, split by which side of the
 * store boundary sent it: the store's client is aimed at `storeRpcUrl` (the proxy above),
 * everything else at the node's real `rpcUrl`. One request = one tally row; a multicall
 * eth_call is one row (its `to` is Multicall3, its `data` the aggregate3 selector).
 */
const tallyRequests = async <T>(
  rpcUrl: string,
  storeRpcUrl: string,
  run: () => Promise<T>,
): Promise<{ result: T; tally: Map<string, number> }> => {
  const realFetch = globalThis.fetch
  const tally = new Map<string, number>()
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const side = url.startsWith(storeRpcUrl) ? "store" : url.startsWith(rpcUrl) ? "client" : undefined
    if (side !== undefined) {
      let what = "?"
      try {
        const body = JSON.parse(String(init?.body)) as { method?: string; params?: { to?: string; data?: string }[] }
        const first = body.params?.[0]
        what =
          body.method === "eth_call"
            ? first?.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()
              ? "eth_call:multicall3"
              : `eth_call:${String(first?.data ?? "").slice(0, 10)}`
            : String(body.method)
      } catch {
        // not JSON — still one request
      }
      const key = `${side} ${what}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    return realFetch(input as never, init as never)
  }) as typeof fetch
  try {
    return { result: await run(), tally }
  } finally {
    globalThis.fetch = realFetch
  }
}

/**
 * The R2 measurement: how many HTTP requests one session-start handoff costs on the local chain
 * with three saved checkpoints. The daemon runs in-process, so rpcTransportProbe counts every
 * chain call the handoff makes — the project check, the capability questions and the read.
 * Since in-13b M-3 this Anvil carries the real Multicall3 runtime at the canonical address and
 * the local chain object declares it, so every chain-aware batched client — the store's
 * included — aggregates reads exactly as it does on Monad testnet.
 */
describe("the RPC request count of one session-start handoff (in-6 R2)", () => {
  let env: ScenarioEnvironment
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let batchApi: { baseUrl: string; close(): Promise<void> }
  let rpcProxy: { url: string; close(): Promise<void> }
  let home: MidaHome
  let daemon: DaemonHandle | undefined
  let workDir: string

  beforeAll(async () => {
    env = await localEnvironment({ batching: { waitMs: 200 } })
    // in-13b M-3: production carries Multicall3; put the verified runtime code on this Anvil,
    // then declare it on the shared local chain object. viem resolves chain.contracts.multicall3
    // per batched call, so every client built by this file — env's own API server included —
    // engages `batch: { multicall: true }` from this point.
    await anvilRpc(env.rpcUrl, "anvil_setCode", [MULTICALL3_ADDRESS, multicall3Code()])
    const installed = (await anvilRpc(env.rpcUrl, "eth_getCode", [MULTICALL3_ADDRESS, "latest"])) as string
    expect(installed.length, "anvil_setCode did not install the Multicall3 runtime").toBeGreaterThan(2)
    const localChain = chainFor(env.deployment.chainId) as { contracts?: Record<string, unknown> }
    localChain.contracts = { ...(localChain.contracts ?? {}), multicall3: { address: MULTICALL3_ADDRESS } }
    // The store side of every measured handoff is aimed at the proxy so the request split is
    // attributable by URL, not by call-stack luck.
    rpcProxy = await startRpcProxy(env.rpcUrl)
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: rpcProxy.url, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-reqcount-data-")) })
    // A second store with the batch lane live, also reading through the proxy — the batched
    // saves the scaling measurement needs are staged and anchored by this one.
    batchApi = await startApiServer({ rpcUrl: rpcProxy.url, deployment: env.deployment, batching: { waitMs: 200 } })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-reqcount-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-reqcount-work-"))
    mark(workDir, "proj-reqcount")
    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      for (const [sessionId, eventId] of [["sess-a", "cp-rc-01"], ["sess-b", "cp-rc-02"], ["sess-c", "cp-rc-03"]] as const) {
        await saveCheckpoint(runtime, "claude-code", {
          projectId: "proj-reqcount",
          sessionId,
          continuesSession: null,
          compiledBy: "test",
          checkpoint: sampleCheckpoint({ eventId, agent: "claude-code", objective: `o-${sessionId}` }),
        })
      }
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile: async () => { throw new Error("no saves in this test") },
      now: () => Date.now(),
      log: () => {},
      tickMs: 60_000,
    })
  }, 600_000)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await batchApi?.close()
    await rpcProxy?.close()
    await env?.stop()
  }, 120_000)

  it("one handoff resolves with 3 checkpoints, and its request count is recorded", async () => {
    rpcTransportProbe.reset()
    readScopeProbe.reset()
    const { result, tally } = await tallyRequests(env.rpcUrl, rpcProxy.url, async () =>
      (await callDaemon(home, "/handoff", { agent: "codex", cwd: workDir }, { timeoutMs: STEP_TIMEOUT })).body as HandoffResult,
    )
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.checkpoints).toBe(3)
    const count = rpcTransportProbe.sentAt.length
    const store = [...tally.keys()].filter((key) => key.startsWith("store ")).reduce((n, key) => n + tally.get(key)!, 0)
    const client = [...tally.keys()].filter((key) => key.startsWith("client ")).reduce((n, key) => n + tally.get(key)!, 0)
    console.log(
      `in-6 R2 / in-9 R5 / in-13b M-3: one session-start handoff made ${count} HTTP request(s) on the local chain ` +
        `(store ${store} / client ${client}; read scope: ${readScopeProbe.hits} shared calls, ${readScopeProbe.misses} new questions)`,
    )
    console.log(`in-13b M-3 [3] breakdown: ${[...tally.entries()].sort().map(([key, n]) => `${key}=${n}`).join(" ")}`)
    // in-9 R-5: one operation asks each distinct question once. The repeated capability,
    // agent-record and block lookups (~30 of ~47 requests before the fix) collapse to one
    // wire call apiece; what remains is the per-object record reads and the capability gate.
    expect(count).toBeLessThanOrEqual(30)
  }, STEP_TIMEOUT)

  /**
   * in-9 R-1, the promotion of the review probe's mining case: before the fix the placements
   * scan walked ContextRegistered logs from deploymentBlock on every read — 42 eth_getLogs
   * calls after 20k mined blocks and a `read-slow` refusal at 12.3 s. Now the same handoff
   * must still answer `handoff` with at most a bounded tie-scan (≤3 getLogs; usually 0 —
   * the three checkpoints were saved seconds apart).
   */
  it("the same handoff 20k and 120k blocks past deployment — still `handoff`, no log scan (in-9 R-1)", async () => {
    const realFetch = globalThis.fetch
    let getLogs = 0
    const spy = () => {
      getLogs = 0
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith(env.rpcUrl) && typeof init?.body === "string") {
          try {
            const parsed = JSON.parse(init.body) as unknown
            for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
              if ((m as { method?: unknown }).method === "eth_getLogs") getLogs += 1
            }
          } catch { /* not JSON — nothing to count */ }
        }
        return realFetch(input, init)
      }) as typeof fetch
    }
    try {
      for (const blocks of [20_000, 120_000]) {
        const res = await realFetch(env.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_mine", params: [`0x${blocks.toString(16)}`, "0x0"] }),
        })
        expect(res.status).toBe(200)
        spy()
        const result = (await callDaemon(home, "/handoff", { agent: "codex", cwd: workDir }, { timeoutMs: STEP_TIMEOUT })).body as HandoffResult
        globalThis.fetch = realFetch
        expect(result.kind).toBe("handoff")
        console.log(`in-9 R-1: handoff at +${blocks} blocks made ${getLogs} eth_getLogs request(s)`)
        // ≤3 = the bounded same-second-tie window; the old code needed 42+ at 20k blocks
        expect(getLogs).toBeLessThanOrEqual(3)
      }
    } finally {
      globalThis.fetch = realFetch
    }
  }, STEP_TIMEOUT * 3)

  /**
   * in-13b M-3 — the reviewer's scaling measurement re-run the way production now reads: saves
   * on the batched lane (`mida batching on`, each settled through followPendingAnchors), the
   * store read through a chain-aware multicall client aimed at the RPC proxy, and Multicall3
   * installed on the Anvil. Asserts the wire-request count per handoff at 5, 10 and 20 anchored
   * batched checkpoints, split by which side of the store boundary sent each request. in-14 F-4:
   * the measured totals 35/43/60 become assertions at ~20% headroom (42/52/72) so a request-count
   * regression fails this test instead of being logged past. The daemon is closed first so its
   * ticks cannot land inside a measured window.
   */
  it("handoff wire requests at 5/10/20 batched checkpoints, split store/client (in-13b M-3)", async () => {
    await daemon?.close()
    daemon = undefined
    const batchNetwork: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: batchApi.baseUrl }
    const batchHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-reqcount-batch-")))
    const batchDir = mkdtempSync(join(tmpdir(), "mida-reqcount-batchwork-"))
    mark(batchDir, "proj-reqcount-batch")
    const runtime2 = await Runtime.open(batchHome, batchNetwork)
    try {
      await init(runtime2, ["claude-code", "codex"])
      for (const name of ["claude-code", "codex"] as const) {
        await requestAccess(runtime2, name)
        await approve(runtime2, name, batchDir)
      }
      const code = await runCli(["batching", "on"], {
        home: batchHome,
        network: batchNetwork,
        print: () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        prompt: async () => "yes",
        drainInput: () => {},
        kickDaemon: () => {},
      })
      expect(code).toBe(0)
      const settle = async () => {
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline && pendingAnchors(batchHome).length > 0) {
          await followPendingAnchors(runtime2, () => {})
          if (pendingAnchors(batchHome).length > 0) await new Promise((resolve) => setTimeout(resolve, 200))
        }
        expect(pendingAnchors(batchHome), "a batched save never anchored").toHaveLength(0)
      }
      let saved = 0
      // in-14 F-4: the measured totals 35/43/60 become regression caps at ~20% headroom
      const MAX_REQUESTS: Record<number, number> = { 5: 42, 10: 52, 20: 72 }
      for (const target of [5, 10, 20]) {
        for (; saved < target; saved++) {
          const agent = saved % 2 === 0 ? "claude-code" : "codex"
          const save = await saveCheckpoint(runtime2, agent, {
            projectId: "proj-reqcount-batch",
            sessionId: `s-${saved}`,
            continuesSession: null,
            compiledBy: "test",
            checkpoint: sampleCheckpoint({ eventId: `cp-rcb-${String(saved).padStart(4, "0")}`, agent, objective: `o-${saved}` }),
          })
          expect(save.lane, `save ${saved} did not take the batched lane`).toBe("batched")
          await settle()
        }
        rpcTransportProbe.reset()
        readScopeProbe.reset()
        const { result, tally } = await tallyRequests(env.rpcUrl, rpcProxy.url, () =>
          buildHandoff(runtime2, { agent: "codex", cwd: batchDir, authorNames: authorNamesFor(runtime2) }),
        )
        expect(result.kind).toBe("handoff")
        if (result.kind !== "handoff") return
        expect(result.checkpoints).toBe(target)
        const count = rpcTransportProbe.sentAt.length
        const store = [...tally.keys()].filter((key) => key.startsWith("store ")).reduce((n, key) => n + tally.get(key)!, 0)
        const client = [...tally.keys()].filter((key) => key.startsWith("client ")).reduce((n, key) => n + tally.get(key)!, 0)
        console.log(
          `in-13b M-3: handoff with ${target} anchored batched checkpoints -> ${count} wire request(s) ` +
            `(store ${store} / client ${client}; read scope: ${readScopeProbe.hits} shared calls, ${readScopeProbe.misses} new questions)`,
        )
        console.log(`in-13b M-3 [${target}] breakdown: ${[...tally.entries()].sort().map(([key, n]) => `${key}=${n}`).join(" ")}`)
        // the count is asserted now — a wire-request regression fails here, not just the log
        expect(count, `handoff with ${target} batched checkpoints spent ${count} wire requests (cap ${MAX_REQUESTS[target]})`).toBeLessThanOrEqual(MAX_REQUESTS[target]!)
      }
    } finally {
      await runtime2.close()
    }
  }, STEP_TIMEOUT * 10)
})
