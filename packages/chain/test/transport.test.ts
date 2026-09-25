import { afterEach, describe, expect, it, vi } from "vitest"
import { createPublicClient } from "viem"
import { foundry } from "viem/chains"
import { rpcTransport, rpcTransportProbe } from "@mida/chain"

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
