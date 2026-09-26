import { afterEach, describe, expect, it, vi } from "vitest"
import { createPublicClient, encodeFunctionResult, parseAbi } from "viem"
import { foundry } from "viem/chains"
import { createReadScope, memoizedReads, rpcTransport } from "@mida/chain"

const ABI = parseAbi(["function getAgent(bytes32) view returns (bytes32)"])

describe("memoizedReads against a real viem public client", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("two identical readContracts issue one wire call", async () => {
    let sent = 0
    vi.stubGlobal("fetch", async () => {
      sent += 1
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: encodeFunctionResult({ abi: ABI, functionName: "getAgent", result: `0x${"ab".repeat(32)}` }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    const client = createPublicClient({ chain: foundry, transport: rpcTransport("http://memo-check.test") })
    const scoped = memoizedReads(client, createReadScope())
    const args = { address: "0x00000000000000000000000000000000000000aa" as const, abi: ABI, functionName: "getAgent" as const, args: [`0x${"1".repeat(64)}` as const] }
    const [a, b] = await Promise.all([scoped.readContract(args as never), scoped.readContract(args as never)])
    expect(a).toEqual(b)
    expect(sent).toBe(1)
  })
})
