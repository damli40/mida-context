import { describe, expect, it } from "vitest"
import { BLOCK_TIME_CACHE_MAX, blockTimeCache } from "../src/placements.js"

/** A getBlock fake that records every block it was asked about and fails the ones in `fail`. */
const counting = (fail: ReadonlySet<bigint> = new Set()) => {
  const asked: bigint[] = []
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      asked.push(blockNumber)
      if (fail.has(blockNumber)) throw new Error("rpc down")
      return { number: blockNumber, timestamp: 1_000n + blockNumber }
    },
  } as unknown as Parameters<typeof blockTimeCache>[0]
  return { asked, client }
}

describe("blockTimeCache — CHAIN-04 (Oct 5): a block's time is asked for once, ever", () => {
  it("one call asks once per distinct block, even when many rows share it", async () => {
    const { asked, client } = counting()
    const time = blockTimeCache(client)
    expect(await Promise.all([time(5n), time(5n), time(6n)])).toEqual([1_005n, 1_005n, 1_006n])
    expect(asked).toEqual([5n, 6n])
  })

  it("a second call that shares the known map asks the chain nothing", async () => {
    const { asked, client } = counting()
    const known = new Map<bigint, bigint>()
    expect(await blockTimeCache(client, known)(7n)).toBe(1_007n)
    expect(await blockTimeCache(client, known)(7n)).toBe(1_007n)
    expect(asked).toEqual([7n])
    expect(known.get(7n)).toBe(1_007n)
  })

  it("a failed fetch is never kept, so the next call asks again", async () => {
    const { asked, client } = counting(new Set([9n]))
    const known = new Map<bigint, bigint>()
    await expect(blockTimeCache(client, known)(9n)).rejects.toThrow("rpc down")
    expect(known.has(9n)).toBe(false)
    await expect(blockTimeCache(client, known)(9n)).rejects.toThrow("rpc down")
    expect(asked).toEqual([9n, 9n])
  })

  it("the known map keeps at most BLOCK_TIME_CACHE_MAX blocks, oldest out first", async () => {
    const { client } = counting()
    const known = new Map<bigint, bigint>()
    for (let i = 0; i < BLOCK_TIME_CACHE_MAX; i += 1) known.set(BigInt(i), 1n)
    const next = BigInt(BLOCK_TIME_CACHE_MAX)
    expect(await blockTimeCache(client, known)(next)).toBe(1_000n + next)
    expect(known.size).toBe(BLOCK_TIME_CACHE_MAX)
    expect(known.has(0n)).toBe(false)
    expect(known.get(next)).toBe(1_000n + next)
  })

  it("never keeps a zero timestamp (MIN-3)", async () => {
    const client = { getBlock: async () => ({ number: 3n, timestamp: 0n }) } as unknown as Parameters<typeof blockTimeCache>[0]
    const known = new Map<bigint, bigint>()
    expect(await blockTimeCache(client, known)(3n)).toBe(0n)
    expect(known.has(3n)).toBe(false)
  })
})
