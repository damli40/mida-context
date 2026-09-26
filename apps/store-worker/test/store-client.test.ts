// In-13 M-2: the store's read client must carry a chain, or viem's `batch: { multicall: true }`
// silently degrades to one eth_call per read — the Sep 25 RPC-limit incident's root cause. These
// tests build the real `storePublicClient` the worker and the batch coordinator share, and count
// the requests a recording fetch sees. On Monad testnet's chain id two concurrent contract reads
// must leave as ONE eth_call aimed at Multicall3; on any other chain they stay two plain calls.

import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem"
import type { Hex } from "viem"
import { MULTICALL3_ADDRESS } from "@mida/chain"
import { storePublicClient } from "../src/public-client.js"

const MULTICALL3 = MULTICALL3_ADDRESS.toLowerCase()
const aggregate3 = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
])[0]!
const answerAbi = parseAbi(["function answer() view returns (uint256)"])

const TARGET = "0x00000000000000000000000000000000000000b2"

/**
 * A fetch stand-in that speaks eth_call: a call aimed at Multicall3 is decoded, each inner call
 * answered 42 and the aggregate result re-encoded — any other target answers 42 directly.
 * Records the `to` of every request it sees.
 */
function recordingFetch(seen: { targets: string[]; requests: number }) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    seen.requests += 1
    const body = JSON.parse(String(init?.body))
    const call = (body.params as [{ to?: string; data?: Hex }])[0]
    let result: Hex
    if (call.to?.toLowerCase() === MULTICALL3) {
      seen.targets.push(MULTICALL3)
      const decoded = decodeFunctionData({ abi: [aggregate3], data: call.data! })
      const calls = decoded.args[0] as readonly { target: string; callData: Hex }[]
      result = encodeFunctionResult({
        abi: [aggregate3],
        functionName: "aggregate3",
        result: calls.map(() => ({
          success: true,
          returnData: encodeFunctionResult({ abi: answerAbi, functionName: "answer", result: 42n }) as Hex,
        })),
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

const twoReads = async (chainId: bigint) => {
  const seen = { targets: [] as string[], requests: 0 }
  vi.stubGlobal("fetch", recordingFetch(seen))
  const client = storePublicClient("http://store-rpc.test", chainId)
  const answers = await Promise.all([
    client.readContract({ address: TARGET, abi: answerAbi, functionName: "answer" }),
    client.readContract({ address: TARGET, abi: answerAbi, functionName: "answer" }),
  ])
  return { seen, answers }
}

describe("storePublicClient — the worker's read client batches through Multicall3 (in-13 M-2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("chain 10143: two concurrent reads leave as ONE eth_call to the Multicall3 address", async () => {
    const { seen, answers } = await twoReads(10143n)
    expect(answers).toEqual([42n, 42n])
    expect(seen.requests).toBe(1)
    expect(seen.targets).toEqual([MULTICALL3])
  })

  it("a local chain id (31337): no Multicall3 is declared — reads stay two plain eth_calls", async () => {
    const { seen, answers } = await twoReads(31337n)
    expect(answers).toEqual([42n, 42n])
    expect(seen.requests).toBe(2)
    expect(seen.targets.every((t) => t !== MULTICALL3)).toBe(true)
  })

  it("an unknown chain id still works — no Multicall3 declared, plain calls, no throw", async () => {
    const { seen, answers } = await twoReads(999999n)
    expect(answers).toEqual([42n, 42n])
    expect(seen.requests).toBe(2)
    expect(seen.targets.every((t) => t !== MULTICALL3)).toBe(true)
  })
})
