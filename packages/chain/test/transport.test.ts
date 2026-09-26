import { afterEach, describe, expect, it, vi } from "vitest"
import { createPublicClient, decodeFunctionData, encodeFunctionResult, parseAbi } from "viem"
import type { Hex } from "viem"
import { foundry, monadTestnet } from "viem/chains"
import { ChainBusyError, createWriteContext, isChainBusy, rpcTransport, rpcTransportProbe } from "@mida/chain"
import type { Deployment } from "@mida/chain"

const ok = (body: { id?: number }) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x7a69" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

/** A fetch stand-in that answers eth_chainId; each call is one HTTP request. */
function stubFetch() {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body))
    return ok(Array.isArray(body) ? body[0]! : body)
  })
}

/** The largest number of wire sends that started inside any 1-second window. */
function peakPerSecond(sentAt: number[]): number {
  let peak = 0
  for (let i = 0; i < sentAt.length; i += 1) {
    const start = sentAt[i]!
    const inWindow = sentAt.slice(i).filter((t) => t - start < 1_000).length
    peak = Math.max(peak, inWindow)
  }
  return peak
}

describe("rpcTransport rate limit (in-6 R1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    rpcTransportProbe.reset()
  })

  it("30 concurrent reads never exceed 10 requests in any 1-second window, and all 30 resolve", async () => {
    vi.stubGlobal("fetch", stubFetch())
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://r1-a.test") })
    const results = await Promise.all(
      Array.from({ length: 30 }, () => client.request({ method: "eth_chainId" })),
    )
    expect(results).toHaveLength(30)
    expect(results.every((r) => r === "0x7a69")).toBe(true)
    expect(rpcTransportProbe.sentAt).toHaveLength(30)
    expect(peakPerSecond(rpcTransportProbe.sentAt)).toBeLessThanOrEqual(10)
  }, 30_000)

  it("honours MIDA_RPC_MAX_PER_SECOND", async () => {
    vi.stubEnv("MIDA_RPC_MAX_PER_SECOND", "5")
    vi.stubGlobal("fetch", stubFetch())
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://r1-b.test") })
    await Promise.all(Array.from({ length: 15 }, () => client.request({ method: "eth_chainId" })))
    expect(peakPerSecond(rpcTransportProbe.sentAt)).toBeLessThanOrEqual(5)
  }, 30_000)

  it("an invalid MIDA_RPC_MAX_PER_SECOND falls back to 10", async () => {
    vi.stubEnv("MIDA_RPC_MAX_PER_SECOND", "lots")
    vi.stubGlobal("fetch", stubFetch())
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://r1-c.test") })
    await Promise.all(Array.from({ length: 15 }, () => client.request({ method: "eth_chainId" })))
    expect(peakPerSecond(rpcTransportProbe.sentAt)).toBeLessThanOrEqual(10)
  }, 30_000)

  it("the bucket is keyed by origin — two transports to one host share one limit", async () => {
    vi.stubGlobal("fetch", stubFetch())
    const a = createPublicClient({ chain: foundry, transport: rpcTransport("http://r1-d.test/one") })
    const b = createPublicClient({ chain: foundry, transport: rpcTransport("http://r1-d.test/two") })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).request({ method: "eth_chainId" }),
      ),
    )
    expect(rpcTransportProbe.sentAt).toHaveLength(20)
    expect(peakPerSecond(rpcTransportProbe.sentAt)).toBeLessThanOrEqual(10)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// in-6 R2 — one multicall request instead of one request per read
// ---------------------------------------------------------------------------

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"
const aggregate3 = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
])[0]!
const answerAbi = parseAbi(["function answer() view returns (uint256)"])

const MONAD_DEPLOYMENT: Deployment = {
  chainId: 10143n,
  capabilityRegistry: "0x00000000000000000000000000000000000000a1",
  contextRegistry: "0x00000000000000000000000000000000000000b2",
  deploymentBlock: 1n,
  policyHashV1: `0x${"11".repeat(32)}`,
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: `0x${"22".repeat(32)}`,
}
const LOCAL_DEPLOYMENT: Deployment = { ...MONAD_DEPLOYMENT, chainId: 31337n }

/** The account slot createWriteContext wants; reads never sign, so the key is filler. */
const ACCOUNT = { address: "0x00000000000000000000000000000000000000cc", type: "json-rpc" } as never

/**
 * A fetch stand-in that speaks eth_call: a call aimed at Multicall3 is decoded, each inner call
 * answered 42 and the aggregate result re-encoded — any other target answers 42 directly.
 */
function multicallAwareFetch(seen: { targets: string[] }) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body))
    const params = body.params as [{ to?: string; data?: Hex }]
    const call = params[0]
    let result: Hex
    if (call.to?.toLowerCase() === MULTICALL3) {
      seen.targets.push(MULTICALL3)
      const decoded = decodeFunctionData({ abi: [aggregate3], data: call.data! })
      const calls = decoded.args[0] as readonly { target: string; callData: Hex }[]
      result = encodeFunctionResult({
        abi: [aggregate3],
        functionName: "aggregate3",
        result: calls.map(() => ({ success: true, returnData: encodeFunctionResult({ abi: answerAbi, functionName: "answer", result: 42n }) as Hex })),
      })
    } else {
      seen.targets.push(call.to ?? "")
      result = encodeFunctionResult({ abi: answerAbi, functionName: "answer", result: 42n }) as Hex
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
}

describe("multicall batching (in-6 R2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    rpcTransportProbe.reset()
  })

  const threeReads = async (deployment: Deployment) => {
    const ctx = createWriteContext({ rpcUrl: "http://r2.test", deployment, account: ACCOUNT })
    return Promise.all(
      Array.from({ length: 3 }, () =>
        ctx.publicClient.readContract({ address: deployment.contextRegistry, abi: answerAbi, functionName: "answer" }),
      ),
    )
  }

  it("a Monad-chain public client batches 3 reads into ONE HTTP request through Multicall3", async () => {
    const seen = { targets: [] as string[] }
    vi.stubGlobal("fetch", multicallAwareFetch(seen))
    const answers = await threeReads(MONAD_DEPLOYMENT)
    expect(answers).toEqual([42n, 42n, 42n])
    // one aggregate3 eth_call, aimed at the Monad testnet Multicall3 address — not 3 plain calls
    expect(rpcTransportProbe.sentAt).toHaveLength(1)
    expect(seen.targets).toEqual([MULTICALL3])
  }, 30_000)

  it("a chain with no Multicall3 (the local e2e chain) falls back to plain calls — same answers", async () => {
    const seen = { targets: [] as string[] }
    vi.stubGlobal("fetch", multicallAwareFetch(seen))
    const answers = await threeReads(LOCAL_DEPLOYMENT)
    expect(answers).toEqual([42n, 42n, 42n])
    expect(rpcTransportProbe.sentAt).toHaveLength(3)
    expect(seen.targets.every((t) => t !== MULTICALL3)).toBe(true)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// in-6 R3 — a rate-limited answer is retried, then named ChainBusyError
// ---------------------------------------------------------------------------

/** The Sep 25 live answer: a 200 holding a JSON-RPC rate-limit error. */
const limited = (body: { id?: number }) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32005, message: "requests limited to 15/sec" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )

// ---------------------------------------------------------------------------
// in-9 — a loopback RPC has no shared public quota; the limiter must not slow local Anvil
// ---------------------------------------------------------------------------

describe("loopback exemption (in-9)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    rpcTransportProbe.reset()
  })

  it("127.0.0.1 sends are admitted without waiting — 30 concurrent reads all leave at once", async () => {
    vi.stubGlobal("fetch", stubFetch())
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://127.0.0.1:8545") })
    const started = Date.now()
    const results = await Promise.all(
      Array.from({ length: 30 }, () => client.request({ method: "eth_chainId" })),
    )
    // under the limiter this takes ~3 s; a loopback RPC answers as fast as the calls arrive
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(results.every((r) => r === "0x7a69")).toBe(true)
    // every send is still recorded — request-count tests keep working on the local chain
    expect(rpcTransportProbe.sentAt).toHaveLength(30)
  }, 30_000)

  it("localhost and [::1] are exempt the same way", async () => {
    vi.stubGlobal("fetch", stubFetch())
    for (const url of ["http://localhost:8545", "http://[::1]:8545"]) {
      const client = createPublicClient({ chain: foundry, transport: rpcTransport(url) })
      const started = Date.now()
      await Promise.all(Array.from({ length: 15 }, () => client.request({ method: "eth_chainId" })))
      expect(Date.now() - started).toBeLessThan(1_000)
    }
    expect(rpcTransportProbe.sentAt).toHaveLength(30)
  }, 30_000)

  it("an explicit MIDA_RPC_MAX_PER_SECOND still limits a loopback origin", async () => {
    vi.stubEnv("MIDA_RPC_MAX_PER_SECOND", "5")
    vi.stubGlobal("fetch", stubFetch())
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://127.0.0.1:8545") })
    await Promise.all(Array.from({ length: 15 }, () => client.request({ method: "eth_chainId" })))
    expect(peakPerSecond(rpcTransportProbe.sentAt)).toBeLessThanOrEqual(5)
  }, 30_000)
})

describe("rate-limit retries (in-6 R3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    rpcTransportProbe.reset()
  })

  const call = () => {
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://r3.test") })
    return client.request({ method: "eth_chainId" })
  }

  it("two rate-limited answers then success → the call succeeds; each attempt is one HTTP request", async () => {
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      calls += 1
      const body = JSON.parse(String(init?.body))
      return calls <= 2 ? limited(body) : ok(body)
    }))
    await expect(call()).resolves.toBe("0x7a69")
    expect(calls).toBe(3)
    expect(rpcTransportProbe.sentAt).toHaveLength(3)
  }, 30_000)

  it("an HTTP 429 is retried the same way — then succeeds", async () => {
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      calls += 1
      if (calls === 1) return new Response("slow down", { status: 429 })
      const body = JSON.parse(String(init?.body))
      return ok(body)
    }))
    await expect(call()).resolves.toBe("0x7a69")
    expect(calls).toBe(2)
  }, 30_000)

  it("always rate-limited → ChainBusyError after exactly 3 retries, delays 250/500/1000 ms", async () => {
    const fetchAt: number[] = []
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      fetchAt.push(Date.now())
      const body = JSON.parse(String(init?.body))
      return limited(body)
    }))
    const error = await call().then(() => null, (e) => e as Error)
    // viem wraps the fetchFn failure in HttpRequestError — the typed error is down the cause chain
    expect(isChainBusy(error)).toBe(true)
    expect(error).not.toBeInstanceOf(ChainBusyError)
    expect(fetchAt).toHaveLength(4) // 1 try + 3 retries
    const gaps = fetchAt.slice(1).map((t, i) => t - fetchAt[i]!)
    expect(gaps[0]).toBeGreaterThanOrEqual(240)
    expect(gaps[1]).toBeGreaterThanOrEqual(490)
    expect(gaps[2]).toBeGreaterThanOrEqual(990)
  }, 30_000)

  it("a non-busy RPC error is NOT retried by this layer", async () => {
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      calls += 1
      const body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32602, message: "invalid params" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }))
    await expect(call()).rejects.toThrow()
    expect(calls).toBe(1)
    expect(isChainBusy(await call().then(() => null, (e) => e))).toBe(false)
    expect(calls).toBe(2)
  }, 30_000)
})
