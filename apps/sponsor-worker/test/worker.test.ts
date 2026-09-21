// M3-B item 2: the Worker end to end. esbuild produces the bundle workerd actually runs, Miniflare
// dispatches real JSON-RPC requests into it, the budget tables are a real SQLite D1, and the only
// things stubbed are the two upstreams: a fake provider that records what it was sent, and a fake
// chain that answers eth_getCode. The flow the brief demands: a signed user operation arrives, the
// policy checks it, the budget ticks, and only then does the provider see it.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import type { Hex } from "viem"
import type { D1Like } from "../src/budget.js"
import {
  CAP,
  CHAIN_ID,
  CHAIN_ID_HEX,
  CTX,
  ENTRY_POINT,
  IMPL,
  THIRD_CONTRACT,
  ZERO,
  batchCall,
  executeCall,
  midaCallData,
  randomAddress,
  runtimeWrapped,
  validAuth,
  validUserOp,
} from "./helpers.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const POLICY_ID = "test-policy-xyz-keep-out-of-clients"
const PROVIDER_KEY_HINT = "provider-key-in-url"

interface RecordedCall {
  method: string
  params: unknown
}

/** The upstream bundler/paymaster — records every call it receives and answers canned results. */
async function startFakeProvider(): Promise<{
  url: string
  calls: RecordedCall[]
  failNext(error: { code: number; message: string }): void
  close(): Promise<void>
}> {
  const calls: RecordedCall[] = []
  let failure: { code: number; message: string } | null = null
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown }
      calls.push({ method, params })
      res.setHeader("content-type", "application/json")
      if (failure) {
        const error = failure
        failure = null
        return res.end(JSON.stringify({ jsonrpc: "2.0", id, error }))
      }
      switch (method) {
        case "eth_sendUserOperation":
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${"aa".repeat(32)}` }))
        case "pm_getPaymasterStubData":
          return res.end(
            JSON.stringify({ jsonrpc: "2.0", id, result: { paymaster: `0x${"77".repeat(20)}`, paymasterData: "0x1234" } }),
          )
        case "pm_getPaymasterData":
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { paymasterAndData: `0x${"77".repeat(20)}1234` } }))
        case "eth_chainId":
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: CHAIN_ID_HEX }))
        case "eth_supportedEntryPoints":
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: [ENTRY_POINT] }))
        case "pimlico_getUserOperationGasPrice":
          return res.end(
            JSON.stringify({ jsonrpc: "2.0", id, result: { slow: "0x1", standard: "0x1", fast: "0x2" } }),
          )
        default:
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/${PROVIDER_KEY_HINT}`,
    calls,
    failNext(error) {
      failure = error
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The chain read the Worker makes when an operation carries no authorization: eth_getCode. */
async function startFakeChain(codeMap: Map<string, string>): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: [string, string] }
      res.setHeader("content-type", "application/json")
      if (method !== "eth_getCode") return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: method } }))
      const code = codeMap.get(params[0].toLowerCase()) ?? "0x"
      return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: code }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function bundleWorker(): Promise<string> {
  const outfile = join(mkdtempSync(join(tmpdir(), "mida-sponsor-")), "worker.mjs")
  await build({
    entryPoints: [join(HERE, "..", "src", "worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
    outfile,
    logLevel: "silent",
  })
  return readFileSync(outfile, "utf8")
}

let mf: Miniflare
let db: D1Like
let provider: Awaited<ReturnType<typeof startFakeProvider>>
let chain: Awaited<ReturnType<typeof startFakeChain>>
const delegatedCode = new Map<string, string>()

beforeAll(async () => {
  provider = await startFakeProvider()
  chain = await startFakeChain(delegatedCode)
  const script = await bundleWorker()
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    bindings: {
      PROVIDER_URL: provider.url,
      POLICY_ID,
      RPC_URL: chain.url,
      CHAIN_ID: CHAIN_ID.toString(10),
      CAPABILITY_REGISTRY: CAP,
      CONTEXT_REGISTRY: CTX,
      ALLOWED_IMPLEMENTATIONS: IMPL,
      PER_SENDER_DAILY_LIMIT: "30",
      GLOBAL_DAILY_LIMIT: "2000",
    },
  })
  db = (await mf.getD1Database("DB")) as unknown as D1Like
  // schema.sql's comments must be stripped before D1 sees it — `exec` refuses a comment line.
  const statements = readFileSync(join(HERE, "..", "schema.sql"), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
  for (const sql of statements) await db.prepare(sql).run()
})

afterAll(async () => {
  await mf.dispose()
  await provider.close()
  await chain.close()
})

interface RpcReply {
  result?: unknown
  error?: { code: number; message: string }
}

async function rpc(method: string, params?: unknown): Promise<RpcReply> {
  const res = await mf.dispatchFetch("http://worker.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  return (await res.json()) as RpcReply
}

function sendOp(op: Record<string, unknown>): Promise<RpcReply> {
  return rpc("eth_sendUserOperation", [op, ENTRY_POINT])
}

const today = () => new Date().toISOString().slice(0, 10)

describe("HTTP and envelope behaviour", () => {
  it("GET / describes the endpoint: chain, both contracts, limits, and the can/cannot line", async () => {
    const res = await mf.dispatchFetch("http://worker.test/")
    expect(res.status).toBe(200)
    const info = (await res.json()) as Record<string, unknown>
    expect(info.chainId).toBe(CHAIN_ID.toString(10))
    expect(info.capabilityRegistry).toBe(CAP)
    expect(info.contextRegistry).toBe(CTX)
    expect(info.description).toContain("It can pay for a call or refuse to. It cannot sign, read, grant or revoke.")
    expect((info.limits as Record<string, unknown>).perSenderPerDay).toBe(30)
    expect((info.methods as string[])).toContain("eth_sendUserOperation")
  })

  it("refuses batch bodies outright — batching is how a policy check gets skipped", async () => {
    const res = await mf.dispatchFetch("http://worker.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [validUserOp(), ENTRY_POINT] },
        { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] },
      ]),
    })
    const body = (await res.json()) as RpcReply
    expect(body.error?.code).toBe(-32600)
    expect(body.error?.message).toMatch(/no batches/)
  })

  it("unknown methods get -32601 and never reach the provider", async () => {
    const before = provider.calls.length
    for (const method of ["eth_sendRawTransaction", "eth_call", "pm_sponsorUserOperation", "web3_clientVersion"]) {
      const reply = await rpc(method, [])
      expect(reply.error?.code).toBe(-32601)
    }
    expect(provider.calls.length).toBe(before)
  })
})

describe("the happy path — a valid Mida operation is paid for", () => {
  it("forwards a valid eth_sendUserOperation; the sender is the user's own address", async () => {
    const sender = randomAddress()
    const op = validUserOp({ sender })
    const reply = await sendOp(op)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toBe(`0x${"aa".repeat(32)}`)
    const last = provider.calls.at(-1)!
    expect(last.method).toBe("eth_sendUserOperation")
    const forwarded = (last.params as unknown[])[0] as { sender: string }
    // The whole point: the payer changed, the sender did not — never a sponsor address.
    expect(forwarded.sender.toLowerCase()).toBe(sender.toLowerCase())
    expect((last.params as unknown[])[1]).toBe(ENTRY_POINT)
  })

  it("forwards an Alchemy-wrapped operation too", async () => {
    const op = validUserOp({ callData: runtimeWrapped(executeCall(CAP, 0n, midaCallData())) })
    const reply = await sendOp(op)
    expect(reply.error).toBeUndefined()
  })

  it("eth_estimateUserOperationGas is policy-checked and forwarded", async () => {
    const reply = await rpc("eth_estimateUserOperationGas", [validUserOp(), ENTRY_POINT])
    expect(reply.error).toBeUndefined()
    // A non-Mida estimate is refused, not estimated.
    const bad = await rpc("eth_estimateUserOperationGas", [
      validUserOp({ callData: executeCall(THIRD_CONTRACT, 0n, midaCallData()) }),
      ENTRY_POINT,
    ])
    expect(bad.error?.code).toBe(-32000)
  })

  it("non-operation methods pass straight through", async () => {
    expect((await rpc("eth_chainId")).result).toBe(CHAIN_ID_HEX)
    expect((await rpc("eth_supportedEntryPoints")).result).toEqual([ENTRY_POINT])
    expect((await rpc("pimlico_getUserOperationGasPrice")).result).toBeTruthy()
    expect((await rpc("eth_getUserOperationReceipt", [`0x${"aa".repeat(32)}`])).error).toBeUndefined()
  })
})

describe("the policy id is injected, never taken", () => {
  it("a client-supplied paymasterContext never reaches the provider", async () => {
    const op = validUserOp()
    const reply = await rpc("pm_getPaymasterStubData", [
      op,
      ENTRY_POINT,
      CHAIN_ID_HEX,
      { sponsorshipPolicyId: "client-chosen-policy", anything: "else" },
    ])
    expect(reply.error).toBeUndefined()
    const last = provider.calls.at(-1)!
    const context = (last.params as unknown[])[3] as Record<string, unknown>
    expect(context).toEqual({ sponsorshipPolicyId: POLICY_ID })
    expect(JSON.stringify(last.params)).not.toContain("client-chosen-policy")
  })
})

describe("policy refusals arrive as JSON-RPC errors, not 500s and not forwards", () => {
  it("a batch with one third-contract call refuses the whole operation", async () => {
    const before = provider.calls.length
    const reply = await sendOp(
      validUserOp({
        callData: batchCall([
          { target: CAP, value: 0n, data: midaCallData() },
          { target: THIRD_CONTRACT, value: 0n, data: midaCallData() },
        ]),
      }),
    )
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/only pays for calls to the Mida contracts/)
    expect(provider.calls.length).toBe(before)
  })

  it("a valid selector with a garbage body refuses — a JSON-RPC error, not a 500", async () => {
    const reply = await sendOp(validUserOp({ callData: `0xb61d27f6${"ff".repeat(100)}` }))
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/does not decode/)
  })

  it("a chain-id-0 authorization is refused", async () => {
    const reply = await sendOp(validUserOp({ eip7702Auth: validAuth({ chainId: "0x0" }) }))
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/every chain/)
  })

  it("an over-ceiling gas field is refused, naming the field", async () => {
    const reply = await sendOp(validUserOp({ callGasLimit: "0x5b8d81" }))
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/callGasLimit/)
  })

  it("without an authorization the sender's on-chain delegation is consulted", async () => {
    const sender = randomAddress()
    const op = validUserOp({ sender, eip7702Auth: undefined })
    // Not delegated → refused.
    let reply = await sendOp(op)
    expect(reply.error?.code).toBe(-32000)
    // Delegated to the allowed implementation → forwarded.
    delegatedCode.set(sender.toLowerCase(), `0xef0100${IMPL.slice(2)}`)
    reply = await sendOp(op)
    expect(reply.error).toBeUndefined()
    delegatedCode.delete(sender.toLowerCase())
  })
})

describe("daily budgets, atomically in D1", () => {
  it("a sender at exactly 30 today pays; at 31 refuses", async () => {
    const sender = randomAddress()
    await db
      .prepare("INSERT INTO sponsor_sender_ops (day, sender, count) VALUES (?, ?, ?)")
      .bind(today(), sender.toLowerCase(), 29)
      .run()
    expect((await sendOp(validUserOp({ sender }))).error).toBeUndefined() // the 30th
    const reply = await sendOp(validUserOp({ sender }))
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/30 sponsored operations/)
  })

  it("the global budget refuses the 2,001st operation of the day", async () => {
    await db.prepare("INSERT OR REPLACE INTO sponsor_global_ops (day, count) VALUES (?, ?)").bind(today(), 1999).run()
    expect((await sendOp(validUserOp())).error).toBeUndefined() // the 2,000th
    const reply = await sendOp(validUserOp())
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/daily budget/)
    // Restore headroom for any later tests.
    await db.prepare("UPDATE sponsor_global_ops SET count = 1 WHERE day = ?").bind(today()).run()
  })

  it("refused operations still tick the sender counter — honest accounting of attempts", async () => {
    const sender = randomAddress()
    await db
      .prepare("INSERT INTO sponsor_sender_ops (day, sender, count) VALUES (?, ?, ?)")
      .bind(today(), sender.toLowerCase(), 30)
      .run()
    await sendOp(validUserOp({ sender }))
    const row = await db
      .prepare("SELECT count FROM sponsor_sender_ops WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(row?.count).toBe(31)
  })
})

describe("provider failures never leak", () => {
  it("a provider error body that echoes secrets is scrubbed before the client sees it", async () => {
    provider.failNext({
      code: -32099,
      message: `upstream rejected: key ${provider.url} policy ${POLICY_ID} rpc ${chain.url} invalid`,
    })
    const reply = await sendOp(validUserOp())
    expect(reply.error?.code).toBe(-32099)
    expect(reply.error?.message).not.toContain(POLICY_ID)
    expect(reply.error?.message).not.toContain(PROVIDER_KEY_HINT)
    expect(reply.error?.message).not.toContain(chain.url)
    expect(reply.error?.message).toContain("[redacted]")
  })

  it("a provider that is unreachable produces a JSON-RPC error, not a crash", async () => {
    await provider.close()
    const reply = await sendOp(validUserOp())
    expect(reply.error).toBeDefined()
    expect(reply.error!.code).toBeLessThanOrEqual(-32000)
    provider = await startFakeProvider()
  })
})
