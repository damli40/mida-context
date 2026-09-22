// M3-B item 2, reworked by M3-B2 item 1: the Worker end to end. esbuild produces the bundle
// workerd actually runs, Miniflare dispatches real JSON-RPC requests into it, the budget tables
// are a real SQLite D1, and the only things stubbed are the two upstreams: a fake provider that
// records what it was sent, and a fake chain that answers eth_getCode. The flow the brief
// demands: the sponsorship budget is spent at SIGNING — pm_getPaymasterData returns a paymaster
// signature the contract honours on chain whatever happens next — so the counter ticks before
// that request is forwarded, is refunded when the provider never produced a signature, and
// eth_sendUserOperation is forwarded only for an operation this endpoint signed today.

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
import { operationIdentity } from "../src/policy.js"
import { resolveGasCeilings } from "../src/worker.js"
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
  failNext(error: { code: number; message: string; data?: unknown }): void
  /** Answer with the error nested inside `result` — the provider resolves instead of throwing. */
  failNextAsResult(error: { code: number; message: string; data?: unknown }): void
  close(): Promise<void>
}> {
  const calls: RecordedCall[] = []
  let failure: { code: number; message: string; data?: unknown; insideResult?: boolean } | null = null
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown }
      calls.push({ method, params })
      res.setHeader("content-type", "application/json")
      if (failure) {
        const { code, message, data, insideResult } = failure
        failure = null
        const error = { code, message, ...(data === undefined ? {} : { data }) }
        return res.end(
          insideResult
            ? JSON.stringify({ jsonrpc: "2.0", id, result: { error } })
            : JSON.stringify({ jsonrpc: "2.0", id, error }),
        )
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
    failNextAsResult(error) {
      failure = { ...error, insideResult: true }
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

/**
 * Everything the Worker prints, parsed back into objects. workerd console output does NOT go
 * through Miniflare's `log` option — it rides the runtime's stdout as {timestamp, level, message}
 * lines, which `handleStructuredLogs` hands back here. The stream is asynchronous, so tests poll
 * briefly for a record rather than expecting it the instant the response returns.
 */
const workerLog: { records: Record<string, unknown>[] } = { records: [] }

function captureWorkerLog(entry: { timestamp: number; level: string; message: string }): void {
  const brace = entry.message.indexOf("{")
  if (brace === -1) return
  try {
    workerLog.records.push(JSON.parse(entry.message.slice(brace)) as Record<string, unknown>)
  } catch {
    // workerd's own noise is not JSON — only the Worker's JSON.stringify lines matter here.
  }
}

/** Waits up to ~2 s for a matching log record — the stdout stream delivers it asynchronously. */
async function findWorkerRecord(match: (record: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
  for (let waited = 0; waited < 2000; waited += 25) {
    const record = workerLog.records.find(match)
    if (record !== undefined) return record
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return undefined
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
    handleStructuredLogs: captureWorkerLog,
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
      FREE_PER_SENDER_DAILY_LIMIT: "120",
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

function signOp(op: Record<string, unknown>): Promise<RpcReply> {
  return rpc("pm_getPaymasterData", [op, ENTRY_POINT, CHAIN_ID_HEX])
}

function stubOp(op: Record<string, unknown>): Promise<RpcReply> {
  return rpc("pm_getPaymasterStubData", [op, ENTRY_POINT, CHAIN_ID_HEX])
}

/** The path a real client takes: the endpoint signs, then the signed operation comes back to send. */
async function signAndSend(op: Record<string, unknown>): Promise<RpcReply> {
  const signed = await signOp(op)
  if (signed.error !== undefined) return signed
  return sendOp(op)
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
    expect((info.limits as Record<string, unknown>).signingsPerSenderPerDay).toBe(30)
    expect((info.methods as string[])).toContain("eth_sendUserOperation")
    const policy = info.policy as Record<string, unknown>
    expect(policy.budgets).toMatch(/pm_getPaymasterData/)
    expect(policy.factory).toMatch(/0x7702/)
    expect(policy.delegationClearing).toMatch(/^disabled/)
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
  it("signs then forwards a valid eth_sendUserOperation; the sender is the user's own address", async () => {
    const sender = randomAddress()
    const op = validUserOp({ sender })
    const reply = await signAndSend(op)
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
    const reply = await signAndSend(op)
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

  it("a delegation-clearing operation is refused — clearing is off by default", async () => {
    const sender = randomAddress()
    const before = provider.calls.length
    const reply = await signOp(
      validUserOp({
        sender,
        callData: executeCall(sender, 0n, "0x"),
        eip7702Auth: validAuth({ address: ZERO }),
        callGasLimit: "0xea60",
      }),
    )
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/clearing/)
    expect(provider.calls.length).toBe(before)
  })

  it("without an authorization the sender's on-chain delegation is consulted", async () => {
    const sender = randomAddress()
    const op = validUserOp({ sender, eip7702Auth: undefined })
    // Not delegated → refused.
    let reply = await sendOp(op)
    expect(reply.error?.code).toBe(-32000)
    // Delegated to the allowed implementation → signed and forwarded.
    delegatedCode.set(sender.toLowerCase(), `0xef0100${IMPL.slice(2)}`)
    reply = await signAndSend(op)
    expect(reply.error).toBeUndefined()
    delegatedCode.delete(sender.toLowerCase())
  })
})

describe("daily budgets are spent at signing, atomically in D1", () => {
  it("a signing consumes one tick of the sender budget and one of the global budget", async () => {
    const sender = randomAddress()
    const globalBefore =
      (await db.prepare("SELECT count FROM sponsor_global_signings WHERE day = ?").bind(today()).first<{ count: number }>())
        ?.count ?? 0
    const reply = await signOp(validUserOp({ sender }))
    expect(reply.error).toBeUndefined()
    const providerCall = provider.calls.at(-1)!
    expect(providerCall.method).toBe("pm_getPaymasterData")
    // The server's policy id was injected, the client's context dropped — same as the stub path.
    expect((providerCall.params as unknown[])[3]).toEqual({ sponsorshipPolicyId: POLICY_ID })
    const senderRow = await db
      .prepare("SELECT count FROM sponsor_sender_signings WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(senderRow?.count).toBe(1)
    const globalRow = await db
      .prepare("SELECT count FROM sponsor_global_signings WHERE day = ?")
      .bind(today())
      .first<{ count: number }>()
    expect(globalRow?.count).toBe(globalBefore + 1)
  })

  it("a provider error refunds both counters — a signature that was never produced never spent", async () => {
    const sender = randomAddress()
    const globalBefore =
      (await db.prepare("SELECT count FROM sponsor_global_signings WHERE day = ?").bind(today()).first<{ count: number }>())
        ?.count ?? 0
    provider.failNext({ code: -32001, message: "paymaster rejected the operation" })
    const reply = await signOp(validUserOp({ sender }))
    expect(reply.error?.code).toBe(-32001)
    const senderRow = await db
      .prepare("SELECT count FROM sponsor_sender_signings WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(senderRow?.count ?? 0).toBe(0)
    const globalRow = await db
      .prepare("SELECT count FROM sponsor_global_signings WHERE day = ?")
      .bind(today())
      .first<{ count: number }>()
    expect(globalRow?.count ?? 0).toBe(globalBefore)
  })

  it("an error inside the RESULT refunds too — a provider that resolves instead of throwing spent nothing", async () => {
    const sender = randomAddress()
    const globalBefore =
      (await db.prepare("SELECT count FROM sponsor_global_signings WHERE day = ?").bind(today()).first<{ count: number }>())
        ?.count ?? 0
    provider.failNextAsResult({
      code: -32077,
      message: `paymaster refused — upstream ${provider.url} policy ${POLICY_ID} invalid`,
    })
    const reply = await signOp(validUserOp({ sender }))
    // The client gets a safe error — never the provider's raw body.
    expect(reply.error?.code).toBe(-32077)
    expect(reply.error?.message).not.toContain(PROVIDER_KEY_HINT)
    expect(reply.error?.message).not.toContain(POLICY_ID)
    expect(reply.result).toBeUndefined()
    const senderRow = await db
      .prepare("SELECT count FROM sponsor_sender_signings WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(senderRow?.count ?? 0).toBe(0)
    const globalRow = await db
      .prepare("SELECT count FROM sponsor_global_signings WHERE day = ?")
      .bind(today())
      .first<{ count: number }>()
    expect(globalRow?.count ?? 0).toBe(globalBefore)
    // And nothing was recorded as issued — a later eth_sendUserOperation must not pass.
    const issued = await db
      .prepare("SELECT 1 AS found FROM sponsor_issued WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ found: number }>()
    expect(issued).toBeNull()
  })

  it("the 31st signing of the day refuses with the plain budget message and zero provider calls", async () => {
    const sender = randomAddress()
    await db
      .prepare("INSERT INTO sponsor_sender_signings (day, sender, count) VALUES (?, ?, ?)")
      .bind(today(), sender.toLowerCase(), 30)
      .run()
    const before = provider.calls.length
    const reply = await signOp(validUserOp({ sender }))
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/30 sponsored signings/)
    expect(provider.calls.length).toBe(before)
  })

  it("two concurrent signings at count 29 — exactly one is signed", async () => {
    const sender = randomAddress()
    await db
      .prepare("INSERT INTO sponsor_sender_signings (day, sender, count) VALUES (?, ?, ?)")
      .bind(today(), sender.toLowerCase(), 29)
      .run()
    const before = provider.calls.length
    const [a, b] = await Promise.all([signOp(validUserOp({ sender })), signOp(validUserOp({ sender }))])
    const succeeded = [a, b].filter((reply) => reply.error === undefined)
    expect(succeeded).toHaveLength(1)
    // The loser never reached the provider — the budget refused it first.
    expect(provider.calls.length).toBe(before + 1)
    const row = await db
      .prepare("SELECT count FROM sponsor_sender_signings WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(row?.count).toBe(31)
  })

  it("the global budget refuses the 2,001st signing of the day", async () => {
    await db.prepare("INSERT OR REPLACE INTO sponsor_global_signings (day, count) VALUES (?, ?)").bind(today(), 1999).run()
    expect((await signOp(validUserOp())).error).toBeUndefined() // the 2,000th
    const reply = await signOp(validUserOp())
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/daily budget/)
    // Restore headroom for any later tests.
    await db.prepare("UPDATE sponsor_global_signings SET count = 1 WHERE day = ?").bind(today()).run()
  })

  it("refused signings still tick the sender counter — honest accounting of attempts", async () => {
    const sender = randomAddress()
    await db
      .prepare("INSERT INTO sponsor_sender_signings (day, sender, count) VALUES (?, ?, ?)")
      .bind(today(), sender.toLowerCase(), 30)
      .run()
    await signOp(validUserOp({ sender }))
    const row = await db
      .prepare("SELECT count FROM sponsor_sender_signings WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(row?.count).toBe(31)
  })
})

describe("eth_sendUserOperation only sends what this endpoint signed today", () => {
  it("a send with no prior signing is refused before the provider is called", async () => {
    const before = provider.calls.length
    const reply = await sendOp(validUserOp())
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/did not sign|pm_getPaymasterData/)
    expect(provider.calls.length).toBe(before)
  })

  it("signing one operation does not unlock a different one — the tuple binds sender, nonce and callData", async () => {
    const sender = randomAddress()
    expect((await signOp(validUserOp({ sender }))).error).toBeUndefined()
    const other = validUserOp({ sender, callData: executeCall(CTX, 0n, midaCallData("register")) })
    const reply = await sendOp(other)
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/did not sign|pm_getPaymasterData/)
  })

  it("the same signed operation may be sent more than once — the record is not consumed", async () => {
    const op = validUserOp()
    expect((await signOp(op)).error).toBeUndefined()
    expect((await sendOp(op)).error).toBeUndefined()
    // A bundler that silently dropped the operation must not force a second signing.
    expect((await sendOp(op)).error).toBeUndefined()
  })

  it("a send signed at 23:59:59 UTC is still accepted at 00:00:01 — yesterday's record counts", async () => {
    const op = validUserOp()
    const identity = operationIdentity(op)
    // The signing is recorded under its own UTC day, so a signing that landed just before
    // midnight leaves its row under yesterday — the send that follows must still find it.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await db
      .prepare("INSERT OR IGNORE INTO sponsor_issued (day, sender, nonce, calldata_hash) VALUES (?, ?, ?, ?)")
      .bind(yesterday, identity.sender, identity.nonce, identity.callDataHash)
      .run()
    const reply = await sendOp(op)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toBe(`0x${"aa".repeat(32)}`)
  })

  it("a signing from the day before yesterday does NOT unlock a send — the window stays one day back", async () => {
    const op = validUserOp()
    const identity = operationIdentity(op)
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    await db
      .prepare("INSERT OR IGNORE INTO sponsor_issued (day, sender, nonce, calldata_hash) VALUES (?, ?, ?, ?)")
      .bind(twoDaysAgo, identity.sender, identity.nonce, identity.callDataHash)
      .run()
    const reply = await sendOp(op)
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/did not sign|pm_getPaymasterData/)
  })
})

describe("the stub and estimate methods are free of the signing budget but rate-limited", () => {
  it("pm_getPaymasterStubData and eth_estimateUserOperationGas never tick a signing counter", async () => {
    const sender = randomAddress()
    expect((await stubOp(validUserOp({ sender }))).error).toBeUndefined()
    expect((await rpc("eth_estimateUserOperationGas", [validUserOp({ sender }), ENTRY_POINT])).error).toBeUndefined()
    const row = await db
      .prepare("SELECT count FROM sponsor_sender_signings WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(row?.count ?? 0).toBe(0)
    const free = await db
      .prepare("SELECT count FROM sponsor_free_calls WHERE day = ? AND sender = ?")
      .bind(today(), sender.toLowerCase())
      .first<{ count: number }>()
    expect(free?.count).toBe(2)
  })

  it("the 121st free call of the day refuses before the provider is called", async () => {
    const sender = randomAddress()
    await db
      .prepare("INSERT INTO sponsor_free_calls (day, sender, count) VALUES (?, ?, ?)")
      .bind(today(), sender.toLowerCase(), 120)
      .run()
    const before = provider.calls.length
    const reply = await stubOp(validUserOp({ sender }))
    expect(reply.error?.code).toBe(-32000)
    expect(reply.error?.message).toMatch(/120 free calls/)
    const estimate = await rpc("eth_estimateUserOperationGas", [validUserOp({ sender }), ENTRY_POINT])
    expect(estimate.error?.code).toBe(-32000)
    expect(provider.calls.length).toBe(before)
  })
})

describe("provider failures never leak", () => {
  it("a provider error body that echoes secrets is scrubbed before the client sees it", async () => {
    const op = validUserOp()
    expect((await signOp(op)).error).toBeUndefined()
    provider.failNext({
      code: -32099,
      message: `upstream rejected: key ${provider.url} policy ${POLICY_ID} rpc ${chain.url} invalid`,
    })
    const reply = await sendOp(op)
    expect(reply.error?.code).toBe(-32099)
    expect(reply.error?.message).not.toContain(POLICY_ID)
    expect(reply.error?.message).not.toContain(PROVIDER_KEY_HINT)
    expect(reply.error?.message).not.toContain(chain.url)
    expect(reply.error?.message).toContain("[redacted]")
  })

  // M3-D3 item 5a: the Sep 22 `pm_getPaymasterData` refusal reached the owner as a request-body
  // dump and the Worker's own logs held nothing that could explain it. Now the provider's full
  // error object, the operation's gas fields, the sender prefix and the method land in the
  // Worker logs — while the client answer stays exactly as scrubbed as before.
  it("the provider's refusal is LOGGED with its full error and the op's gas fields — the client still gets only the scrubbed message", async () => {
    const op = validUserOp()
    provider.failNext({
      code: -32602,
      message: "Missing or invalid parameters.",
      data: { argument: "paymasterContext", detail: "field not accepted" },
    })
    const reply = await signOp(op)
    // Client side: the provider's `data` never leaves the Worker.
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toBe("Missing or invalid parameters.")
    expect(JSON.stringify(reply.error)).not.toContain("paymasterContext")

    // Worker side: the record that answers "what did the provider actually refuse?".
    const record = await findWorkerRecord(
      (r) =>
        "providerError" in r &&
        r.method === "pm_getPaymasterData" &&
        r.sender === (op.sender as string).slice(0, 10),
    )
    expect(record).toBeDefined()
    expect(record!.method).toBe("pm_getPaymasterData")
    expect(record!.sender).toBe((op.sender as string).slice(0, 10))
    expect(record!.providerError).toMatchObject({
      code: -32602,
      message: "Missing or invalid parameters.",
      data: { argument: "paymasterContext", detail: "field not accepted" },
    })
    expect(record!.gas).toMatchObject({
      callGasLimit: "0x30000",
      verificationGasLimit: "0x40000",
      preVerificationGas: "0x20000",
      maxFeePerGas: "0x1000",
      maxPriorityFeePerGas: "0x100",
    })
    // The log line passed through the same scrubber as the client answer — no secret reaches logs.
    const raw = JSON.stringify(record)
    expect(raw).not.toContain(POLICY_ID)
    expect(raw).not.toContain(PROVIDER_KEY_HINT)
  })

  it("a provider error smuggled inside `result` is diagnosed the same way", async () => {
    const op = validUserOp()
    provider.failNextAsResult({ code: -32077, message: "paymaster refused upstream", data: { upstream: "429 too many requests" } })
    const reply = await signOp(op)
    expect(reply.error?.code).toBe(-32077)
    const record = await findWorkerRecord(
      (r) =>
        "providerError" in r &&
        r.method === "pm_getPaymasterData" &&
        r.sender === (op.sender as string).slice(0, 10),
    )
    expect(record).toBeDefined()
    expect(record!.providerError).toMatchObject({ code: -32077, message: "paymaster refused upstream", data: { upstream: "429 too many requests" } })
    expect(record!.gas).toMatchObject({ callGasLimit: "0x30000" })
  })

  it("a provider that is unreachable produces a JSON-RPC error, not a crash", async () => {
    const op = validUserOp()
    expect((await signOp(op)).error).toBeUndefined()
    await provider.close()
    const reply = await sendOp(op)
    expect(reply.error).toBeDefined()
    expect(reply.error!.code).toBeLessThanOrEqual(-32000)
    provider = await startFakeProvider()
  })
})

describe("the fixed gas ceilings are env-overridable downward only", () => {
  it("unset envs give the built-ins", () => {
    const lines: string[] = []
    const ceilings = resolveGasCeilings({}, (line) => lines.push(line))
    expect(ceilings).toEqual({ verificationGas: 500_000n, preVerificationGas: 1_200_000n, paymasterGas: 300_000n, fee: 300_000_000_000n })
    expect(lines).toEqual([])
  })

  it("a lower env value applies", () => {
    const ceilings = resolveGasCeilings(
      { VERIFICATION_GAS_CEILING: "400000", PRE_VERIFICATION_GAS_CEILING: "0x61a80", PAYMASTER_GAS_CEILING: "250000", FEE_CEILING: "100000000000" },
      () => {},
    )
    expect(ceilings).toEqual({ verificationGas: 400_000n, preVerificationGas: 400_000n, paymasterGas: 250_000n, fee: 100_000_000_000n })
  })

  it("a higher env value is ignored and logged", () => {
    const lines: string[] = []
    const ceilings = resolveGasCeilings(
      { VERIFICATION_GAS_CEILING: "600000", PAYMASTER_GAS_CEILING: "300001", FEE_CEILING: "500000000000" },
      (line) => lines.push(line),
    )
    expect(ceilings).toEqual({ verificationGas: 500_000n, preVerificationGas: 1_200_000n, paymasterGas: 300_000n, fee: 300_000_000_000n })
    expect(lines).toHaveLength(3)
    expect(lines.join(" ")).toMatch(/VERIFICATION_GAS_CEILING/)
    expect(lines.join(" ")).toMatch(/PAYMASTER_GAS_CEILING/)
    expect(lines.join(" ")).toMatch(/FEE_CEILING/)
  })

  it("garbage and negative env values are ignored and logged", () => {
    const lines: string[] = []
    const ceilings = resolveGasCeilings(
      { VERIFICATION_GAS_CEILING: "not-a-number", PRE_VERIFICATION_GAS_CEILING: "-5" },
      (line) => lines.push(line),
    )
    expect(ceilings.verificationGas).toBe(500_000n)
    expect(ceilings.preVerificationGas).toBe(1_200_000n)
    expect(lines).toHaveLength(2)
  })
})
