import { describe, expect, it } from "vitest"
import type { PublicClient } from "viem"
import { ReadDeadlineError, createReadScope, isReadDeadlineError, memoizedReads } from "@mida/chain"

const ARGS = { address: "0x0000000000000000000000000000000000000001", abi: [], functionName: "getRecord", args: [42n] }

/** A counting stand-in for PublicClient — the wrapper only ever sees the four memoized methods. */
const fakeClient = () => {
  const calls: string[] = []
  const client = {
    calls,
    readContract: async (args: unknown) => {
      calls.push(`readContract:${JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`)
      return calls.length
    },
    getBlock: async () => {
      calls.push("getBlock")
      return { number: BigInt(calls.length), timestamp: 0n }
    },
    getBlockNumber: async () => {
      calls.push("getBlockNumber")
      return BigInt(calls.length)
    },
    getLogs: async () => {
      calls.push("getLogs")
      return []
    },
    getBalance: async () => {
      calls.push("getBalance")
      return BigInt(calls.length)
    },
  }
  return client as typeof client & PublicClient
}

describe("the per-operation read scope (in-9 R-5)", () => {
  it("identical reads share one wire call — settled and still in flight", async () => {
    const client = fakeClient()
    const scoped = memoizedReads(client, createReadScope())
    const [a, b] = await Promise.all([scoped.readContract(ARGS as never), scoped.readContract(ARGS as never)])
    const again = await scoped.readContract(ARGS as never)
    expect(client.calls).toHaveLength(1)
    expect(a).toBe(b)
    expect(again).toBe(a)
  })

  it("different args are different calls", async () => {
    const client = fakeClient()
    const scoped = memoizedReads(client, createReadScope())
    await scoped.readContract(ARGS as never)
    await scoped.readContract({ ...ARGS, args: [43n] } as never)
    expect(client.calls).toHaveLength(2)
  })

  it("getBlock, getBlockNumber and getLogs memoize — balance never does (money moves)", async () => {
    const client = fakeClient()
    const scoped = memoizedReads(client, createReadScope())
    await scoped.getBlock({ blockTag: "latest" } as never)
    await scoped.getBlock({ blockTag: "latest" } as never)
    await scoped.getBlockNumber()
    await scoped.getBlockNumber()
    await scoped.getLogs({} as never)
    await scoped.getLogs({} as never)
    await scoped.getBalance({ address: "0x0000000000000000000000000000000000000001" } as never)
    await scoped.getBalance({ address: "0x0000000000000000000000000000000000000001" } as never)
    expect(client.calls.filter((c) => c === "getBalance")).toHaveLength(2)
    expect(client.calls).toHaveLength(5)
  })

  it("a failed read is evicted — the next identical call tries again on its own request", async () => {
    const client = fakeClient()
    let fail = true
    const original = client.readContract
    client.readContract = (async (args: unknown) => {
      if (fail) throw new Error("transient")
      return original(args)
    }) as typeof client.readContract
    const scoped = memoizedReads(client, createReadScope())
    await expect(scoped.readContract(ARGS as never)).rejects.toThrow("transient")
    fail = false
    await expect(scoped.readContract(ARGS as never)).resolves.toBe(1)
    expect(client.calls).toHaveLength(1)
  })

  it("a new scope asks again — nothing leaks across operations, so a revocation between two reads is seen", async () => {
    const client = fakeClient()
    const first = memoizedReads(client, createReadScope())
    const second = memoizedReads(client, createReadScope())
    await first.readContract(ARGS as never)
    await second.readContract(ARGS as never)
    expect(client.calls).toHaveLength(2)
  })

  it("two clients sharing one scope share one wire call", async () => {
    const client = fakeClient()
    const scope = createReadScope()
    await memoizedReads(client, scope).readContract(ARGS as never)
    await memoizedReads(client, scope).readContract(ARGS as never)
    expect(client.calls).toHaveLength(1)
  })

  it("past its deadline the scope starts no new chain read", async () => {
    const client = fakeClient()
    const scoped = memoizedReads(client, createReadScope({ deadlineMs: 0 }))
    const failure = await scoped.readContract(ARGS as never).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ReadDeadlineError)
    expect(isReadDeadlineError(failure)).toBe(true)
    expect(isReadDeadlineError(new Error("wrap", { cause: failure }))).toBe(true)
    expect(client.calls).toHaveLength(0)
  })

  it("a call already on the wire when the deadline passes still finishes — only new reads stop", async () => {
    const client = fakeClient()
    const scope = createReadScope({ deadlineMs: 60_000 })
    const scoped = memoizedReads(client, scope)
    const pending = scoped.readContract(ARGS as never)
    ;(scope as { deadlineAt: number }).deadlineAt = Date.now() - 1
    await expect(pending).resolves.toBe(1)
    await expect(scoped.readContract({ ...ARGS, args: [7n] } as never)).rejects.toThrow(ReadDeadlineError)
    expect(client.calls).toHaveLength(1)
  })

  it("batch-anchor reads stay fresh — a flush landing mid-operation must be observable", async () => {
    const client = fakeClient()
    const scoped = memoizedReads(client, createReadScope())
    // batchOf(0 → anchored), headCommitOf (a lineage head moves) and hasBatchedSaves (the
    // table-exists flag) can all legitimately change inside one operation — the flush/re-poll
    // loop depends on seeing the change, so none of them may serve a memoized answer.
    for (const functionName of ["batchOf", "headCommitOf", "hasBatchedSaves"]) {
      await scoped.readContract({ ...ARGS, functionName } as never)
      await scoped.readContract({ ...ARGS, functionName } as never)
    }
    expect(client.calls).toHaveLength(6)
  })

  it("every scope carries a unique token — the server keys its memo by it", () => {
    expect(createReadScope().id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(createReadScope().id).not.toBe(createReadScope().id)
  })
})
