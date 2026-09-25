import { afterEach, describe, expect, it, vi } from "vitest"
import { createPublicClient, decodeFunctionData, encodeFunctionResult, parseAbi } from "viem"
import type { Hex } from "viem"
import { foundry, monadTestnet } from "viem/chains"
import { createWriteContext, rpcTransport, rpcTransportProbe } from "@mida/chain"
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
