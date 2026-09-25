import { describe, expect, it } from "vitest"
import {
  START_BLOCK,
  addr,
  bytes32,
  item,
  newIndexer,
  run,
  txHash,
} from "./helpers.js"

const OWNER = addr(0x1001)
const OWNER2 = addr(0x1002)
const SUBMITTER = addr(0x9999)
const BATCH = bytes32(0x7001)
const B = START_BLOCK + 300

// One accepted save, as BatchAnchor emits it inside submitBatch.
const saveAnchored = (opts: {
  tx: number
  block: number
  logIndex?: number
  owner?: string
  batchId?: string
  contextId?: string
}) =>
  item(
    "BatchAnchor",
    "SaveAnchored",
    {
      owner: opts.owner ?? OWNER,
      contextId: opts.contextId ?? bytes32(0x5001),
      batchId: opts.batchId ?? BATCH,
      namespaceId: bytes32(0x5001),
      lineageId: bytes32(0x8001),
      version: 1n,
      author: bytes32(0x4001),
      position: 0n,
      leafHash: bytes32(0x9001),
    },
    { tx: opts.tx, block: opts.block, logIndex: opts.logIndex },
  )

const saveRejected = (opts: { tx: number; block: number; logIndex?: number; batchId?: string }) =>
  item(
    "BatchAnchor",
    "SaveRejected",
    { batchId: opts.batchId ?? BATCH, index: 1n, reason: 5n },
    { tx: opts.tx, block: opts.block, logIndex: opts.logIndex },
  )

const batchAnchored = (opts: {
  tx: number
  block: number
  logIndex?: number
  batchId?: string
  acceptedCount?: bigint
  rejectedCount?: bigint
}) =>
  item(
    "BatchAnchor",
    "BatchAnchored",
    {
      batchId: opts.batchId ?? BATCH,
      root: bytes32(0xa001),
      acceptedCount: opts.acceptedCount ?? 2n,
      rejectedCount: opts.rejectedCount ?? 1n,
      submitter: SUBMITTER,
    },
    { tx: opts.tx, block: opts.block, logIndex: opts.logIndex },
  )

describe("BatchAnchor counts", () => {
  it("one batch tx counts its saves and the batch itself", async () => {
    const idx = newIndexer()
    // submitBatch emits per-save events then BatchAnchored — same transaction,
    // consecutive log indices.
    await run(idx, [
      saveAnchored({ tx: 1, block: B, logIndex: 0 }),
      saveAnchored({ tx: 1, block: B, logIndex: 1, contextId: bytes32(0x5002) }),
      saveRejected({ tx: 1, block: B, logIndex: 2 }),
      batchAnchored({ tx: 1, block: B, logIndex: 3 }),
    ])

    const stats = await idx.BatchStats.get("global")
    expect(stats?.batches).toBe(1)
    expect(stats?.anchoredSaves).toBe(2)
    expect(stats?.rejectedSaves).toBe(1)

    // The owner-bearing SaveAnchored events create the Owner row and count
    // batched saves per owner; they are NOT ContextRegistry records.
    const owner = await idx.Owner.get(OWNER)
    expect(owner?.batchedSaves).toBe(2)
    expect(owner?.records).toBe(0)
    expect((await idx.GlobalStats.get("global"))?.owners).toBe(1)
    expect((await idx.GlobalStats.get("global"))?.contextRecords).toBe(0)
    expect((await idx.GlobalStats.get("global"))?.lastBlock).toBe(B)
  })

  it("batchedSaves counts per owner, and BatchAnchored alone does not move save counts", async () => {
    const idx = newIndexer()
    await run(idx, [
      saveAnchored({ tx: 1, block: B, logIndex: 0, owner: OWNER }),
      saveAnchored({ tx: 1, block: B, logIndex: 1, owner: OWNER2, contextId: bytes32(0x5002) }),
      batchAnchored({ tx: 1, block: B, logIndex: 2, acceptedCount: 2n, rejectedCount: 0n }),
      // A second batch whose per-save events are not in this slice still counts
      // the batch — the summary event never moves the save counters itself.
      batchAnchored({ tx: 2, block: B + 1, batchId: bytes32(0x7002), acceptedCount: 9n, rejectedCount: 4n }),
    ])

    const stats = await idx.BatchStats.get("global")
    expect(stats?.batches).toBe(2)
    expect(stats?.anchoredSaves).toBe(2)
    expect(stats?.rejectedSaves).toBe(0)

    expect((await idx.Owner.get(OWNER))?.batchedSaves).toBe(1)
    expect((await idx.Owner.get(OWNER2))?.batchedSaves).toBe(1)
    // The submitter is the store's batcher wallet, not a Mida owner.
    expect(await idx.Owner.get(SUBMITTER)).toBeUndefined()
  })

  it("a re-delivered SaveAnchored does not count twice", async () => {
    const idx = newIndexer()
    const save = saveAnchored({ tx: 1, block: B, logIndex: 0 })
    await run(idx, [save])
    // Same txHash + logIndex = same event identity, later block = reorg replay.
    await run(idx, [
      { ...save, block: { number: B + 7, timestamp: 1_700_000_000 + B + 7 } },
    ])

    const stats = await idx.BatchStats.get("global")
    expect(stats?.anchoredSaves).toBe(1)
    expect((await idx.Owner.get(OWNER))?.batchedSaves).toBe(1)
    expect((await idx.GlobalStats.get("global"))?.lastBlock).toBe(B)
  })

  it("mixed-case owner and ids are stored lowercase", async () => {
    const idx = newIndexer()
    const mixedOwner = `0x${"Ab".repeat(20)}`
    await run(idx, [
      saveAnchored({ tx: 1, block: B, owner: mixedOwner }),
    ])
    expect((await idx.Owner.get(mixedOwner.toLowerCase()))?.batchedSaves).toBe(1)
    expect(await idx.Owner.get(mixedOwner)).toBeUndefined()
  })
})
