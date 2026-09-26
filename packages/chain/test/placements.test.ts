// in-12 N-5 — the same-second tie scan: the estimate is corrected by the chain's own observed
// block rate (≤3 getBlock calls per tied second), every getLogs request spans at most 100 blocks
// (the public RPC's cap), and a tie group that is only PARTLY found keeps no placements at all —
// a found record may never order before an unfound one on the same stamp.
import { describe, expect, it } from "vitest"
import { MONAD_TESTNET_CHAIN_ID, SAFE_LOG_BLOCK_RANGE, recordPlacementsNear } from "@mida/chain"
import type { Deployment } from "@mida/chain"

const OWNER = `0x${"33".repeat(20)}` as `0x${string}`
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as `0x${string}`
const BATCH_ANCHOR = `0x${"44".repeat(20)}` as `0x${string}`
const DEPLOYMENT: Deployment = {
  chainId: MONAD_TESTNET_CHAIN_ID, // the chain whose static blockTime is 400 ms
  capabilityRegistry: `0x${"11".repeat(20)}` as `0x${string}`,
  contextRegistry: CONTEXT_REGISTRY,
  policyHashV1: `0x${"12".repeat(32)}` as `0x${string}`,
  vaultRpId: "mida.test",
  vaultRpIdHash: `0x${"13".repeat(32)}` as `0x${string}`,
  deploymentBlock: 10n,
}
/** The same deployment with a BatchAnchor — the scan reads SaveAnchored from it (in-13 M-5). */
const DEPLOYMENT_BATCHED: Deployment = { ...DEPLOYMENT, batchAnchor: BATCH_ANCHOR, batchAnchorBlock: 10n }

const id = (fill: string) => `0x${fill.repeat(32)}` as `0x${string}`
const ID_A = id("aa")
const ID_B = id("bb")
const ID_C = id("cc")

interface FakeChain {
  client: {
    getBlock(parameters?: { blockTag?: string; blockNumber?: bigint }): Promise<{ number: bigint | null; timestamp: bigint } | null>
    getLogs(parameters: { fromBlock: bigint; toBlock: bigint }): Promise<readonly unknown[]>
  }
  logCalls: { fromBlock: bigint; toBlock: bigint }[]
  blockProbes: bigint[]
}

/**
 * A chain whose TRUE block time differs from the declared 400 ms: `tsOf` is the timestamp
 * function (block number → seconds), `placements` maps contextId → the real block its
 * ContextRegistered event sits in. Every getBlock probe and getLogs window is recorded.
 * `batchedPlacements` is the second lane: contextId → the block, position inside the batch
 * and anchoring transaction's index a SaveAnchored log on `batchAnchor` would report.
 */
function fakeChain(input: {
  head: bigint
  headTs: bigint
  tsOf: (n: bigint) => bigint
  placements: Map<string, { block: bigint; index: number; transaction?: number }>
  batchedPlacements?: Map<string, { block: bigint; position: number; transaction?: number }>
}): FakeChain {
  const logCalls: { fromBlock: bigint; toBlock: bigint }[] = []
  const blockProbes: bigint[] = []
  const client = {
    getBlock: async (parameters?: { blockTag?: string; blockNumber?: bigint }) => {
      if (parameters?.blockNumber !== undefined) {
        blockProbes.push(parameters.blockNumber)
        const n = parameters.blockNumber
        if (n < DEPLOYMENT.deploymentBlock || n > input.head) return null
        return { number: n, timestamp: input.tsOf(n) }
      }
      return { number: input.head, timestamp: input.headTs }
    },
    getLogs: async (parameters: { fromBlock: bigint; toBlock: bigint; address?: string; args?: { contextId?: string[] } }) => {
      logCalls.push({ fromBlock: parameters.fromBlock, toBlock: parameters.toBlock })
      const wanted = parameters.args?.contextId?.map((c) => c.toLowerCase())
      if (parameters.address === BATCH_ANCHOR) {
        return [...(input.batchedPlacements ?? new Map()).entries()]
          .filter(([cid, p]) => (wanted === undefined || wanted.includes(cid)) && p.block >= parameters.fromBlock && p.block <= parameters.toBlock)
          .map(([cid, p]) => ({
            args: { contextId: cid, position: p.position },
            blockNumber: p.block,
            logIndex: p.position,
            ...(p.transaction === undefined ? {} : { transactionIndex: p.transaction }),
          }))
      }
      return [...input.placements.entries()]
        .filter(([cid, p]) => (wanted === undefined || wanted.includes(cid)) && p.block >= parameters.fromBlock && p.block <= parameters.toBlock)
        .map(([cid, p]) => ({
          args: { contextId: cid },
          blockNumber: p.block,
          logIndex: p.index,
          ...(p.transaction === undefined ? {} : { transactionIndex: p.transaction }),
        }))
    },
    getBlockNumber: async () => input.head,
  }
  return { client, logCalls, blockProbes }
}

const tied = (second: bigint, ids: `0x${string}`[]) => new Map([[second, ids] as const])

describe("recordPlacementsNear — the corrected estimate and bounded window (in-12 N-5)", () => {
  const HEAD = 70_000_000n
  const HEAD_TS = 1_800_000_000n

  for (const realMs of [400, 450, 500, 1_000] as const) {
    for (const ageSec of [600n, 7_200n] as const) {
      it(`real ${realMs} ms/block, tie ${Number(ageSec) / 60} min old → the window lands and never exceeds 100 blocks`, async () => {
        // the chain's true history: realMs per block, so `second` sits at head − age·1000/realMs
        const realBlock = HEAD - (ageSec * 1_000n) / BigInt(realMs)
        const second = HEAD_TS - ageSec
        const tsOf = (n: bigint) => HEAD_TS - ((HEAD - n) * BigInt(realMs)) / 1_000n
        const chain = fakeChain({
          head: HEAD,
          headTs: HEAD_TS,
          tsOf,
          placements: new Map([
            [ID_A, { block: realBlock, index: 0 }],
            [ID_B, { block: realBlock, index: 1 }],
          ]),
        })
        const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
        expect(chain.logCalls.length).toBeGreaterThan(0)
        for (const call of chain.logCalls) {
          expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(SAFE_LOG_BLOCK_RANGE)
        }
        // at most 3 getBlock calls per tied second (head + two probes)
        expect(chain.blockProbes.length).toBeLessThanOrEqual(2)
        expect(map.get(ID_A)).toEqual({ block: realBlock, index: 0 })
        expect(map.get(ID_B)).toEqual({ block: realBlock, index: 1 })
      })
    }
  }

  it("a stalled chain (real blocks share one timestamp) degrades to no placements — never a wide scan", async () => {
    // anvil_mine-style stall: 20,000 blocks all stamped within 20 seconds of head
    const second = HEAD_TS - 86_400n // a day old
    const realBlock = HEAD - 20_000n
    const tsOf = (n: bigint) => (n > HEAD - 20_000n ? HEAD_TS - (HEAD - n) / 1_000n : HEAD_TS - 20n - (HEAD - 20_000n - n) / 1_000n)
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([[ID_A, { block: realBlock, index: 0 }], [ID_B, { block: realBlock, index: 1 }]]),
    })
    const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    for (const call of chain.logCalls) {
      expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(SAFE_LOG_BLOCK_RANGE)
    }
    // whether the bounded scan happens to hit or miss, it never widens — and a miss means
    // the caller orders the whole tie by contextId, deterministically
    for (const call of chain.logCalls) {
      expect(call.fromBlock).toBeGreaterThanOrEqual(DEPLOYMENT.deploymentBlock)
      expect(call.toBlock).toBeLessThanOrEqual(HEAD)
    }
    expect(map.size === 0 || map.size === 2).toBe(true)
    void realBlock
  })

  it("a group only PARTLY found keeps no placements — the found record never beats the missing one", async () => {
    const realBlock = HEAD - 100n
    const second = HEAD_TS - (100n * 400n) / 1_000n // right where the 400 ms guess lands anyway
    const tsOf = (n: bigint) => HEAD_TS - ((HEAD - n) * 400n) / 1_000n
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      // only A's event exists in the log — B's is absent (a pruned/uncovered range would look the same)
      placements: new Map([[ID_A, { block: realBlock, index: 0 }]]),
    })
    const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    // not {A: placement} — the whole tie group drops so contextId orders both together
    expect(map.size).toBe(0)
  })

  it("two tied seconds with different outcomes: the complete group keeps placements, the partial one drops", async () => {
    const realBlock1 = HEAD - 100n
    const realBlock2 = HEAD - 40n
    const tsOf = (n: bigint) => HEAD_TS - ((HEAD - n) * 400n) / 1_000n
    const second1 = HEAD_TS - 40n // 100 blocks back at 400 ms
    const second2 = HEAD_TS - 16n // 40 blocks back
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([
        [ID_A, { block: realBlock1, index: 0 }],
        [ID_B, { block: realBlock1, index: 1 }], // second1 complete
        [ID_C, { block: realBlock2, index: 2 }], // second2: only this one exists; its partner is absent
      ]),
    })
    const map = await recordPlacementsNear({
      client: chain.client as never,
      deployment: DEPLOYMENT,
      owner: OWNER,
      tied: new Map([[second1, [ID_A, ID_B]], [second2, [ID_C, `0x${"dd".repeat(32)}`]]] as const),
    })
    expect(map.get(ID_A)).toEqual({ block: realBlock1, index: 0 })
    expect(map.get(ID_B)).toEqual({ block: realBlock1, index: 1 })
    expect(map.has(ID_C)).toBe(false)
  })

  it("the estimate's probes never exceed two per tied second — head plus two, total", async () => {
    const second = HEAD_TS - 3_600n
    const tsOf = (n: bigint) => HEAD_TS - ((HEAD - n) * 450n) / 1_000n
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([[ID_A, { block: HEAD - 8_000n, index: 0 }], [ID_B, { block: HEAD - 8_000n, index: 1 }]]),
    })
    await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    expect(chain.blockProbes.length).toBeLessThanOrEqual(2)
    for (const call of chain.logCalls) {
      expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(SAFE_LOG_BLOCK_RANGE)
    }
  })
})

describe("recordPlacementsNear — a tie spanning both lanes (in-13 M-5)", () => {
  const HEAD = 70_000_000n
  const HEAD_TS = 1_800_000_000n
  // linear 400 ms blocks so the static estimate lands inside the window without correction
  const tsOf = (n: bigint) => HEAD_TS - ((HEAD - n) * 400n) / 1_000n
  const second = HEAD_TS - 40n // 100 blocks back at 400 ms
  const realBlock = HEAD - 100n

  it("places each lane's record from its own event: ContextRegistered's log index and SaveAnchored's batch position, each carrying its anchoring transaction's index", async () => {
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([[ID_A, { block: realBlock, index: 41, transaction: 2 }]]),
      batchedPlacements: new Map([[ID_B, { block: realBlock, position: 0, transaction: 7 }]]),
    })
    const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT_BATCHED, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    expect(map.get(ID_A)).toEqual({ block: realBlock, index: 41, transaction: 2 })
    expect(map.get(ID_B)).toEqual({ block: realBlock, index: 0, transaction: 7 })
  })

  it("a batched member found in a different block than the direct one keeps its own block", async () => {
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([[ID_A, { block: realBlock, index: 3, transaction: 0 }]]),
      batchedPlacements: new Map([[ID_B, { block: realBlock + 40n, position: 6, transaction: 1 }]]),
    })
    const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT_BATCHED, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    expect(map.get(ID_B)).toEqual({ block: realBlock + 40n, index: 6, transaction: 1 })
  })

  it("a mixed group whose batched member is absent keeps NO placements — the whole second falls to contextId together", async () => {
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([[ID_A, { block: realBlock, index: 3, transaction: 0 }]]),
      batchedPlacements: new Map(), // B's SaveAnchored is nowhere in the window
    })
    const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT_BATCHED, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    expect(map.size).toBe(0)
  })

  it("a deployment with no batchAnchor still scans only ContextRegistered", async () => {
    const chain = fakeChain({
      head: HEAD,
      headTs: HEAD_TS,
      tsOf,
      placements: new Map([[ID_A, { block: realBlock, index: 3, transaction: 0 }], [ID_B, { block: realBlock, index: 4, transaction: 0 }]]),
    })
    const map = await recordPlacementsNear({ client: chain.client as never, deployment: DEPLOYMENT, owner: OWNER, tied: tied(second, [ID_A, ID_B]) })
    expect(map.get(ID_A)).toEqual({ block: realBlock, index: 3, transaction: 0 })
    expect(map.get(ID_B)).toEqual({ block: realBlock, index: 4, transaction: 0 })
  })
})
