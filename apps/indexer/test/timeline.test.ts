import { describe, expect, it } from "vitest"
import {
  CHAIN_ID,
  START_BLOCK,
  addr,
  bytes32,
  grantContext,
  item,
  newIndexer,
  run,
  txHash,
} from "./helpers.js"

const OWNER = addr(0x1001)
const AGENT = bytes32(0x4001)
const NAMESPACE = bytes32(0x5001)
const B = START_BLOCK + 300

const capabilityGranted = (capId: string, tx: number, block: number, logIndex: number) =>
  item(
    "CapabilityRegistry",
    "CapabilityGranted",
    {
      owner: OWNER,
      agentId: AGENT,
      namespaceId: NAMESPACE,
      capabilityId: capId,
      permissions: 1n,
      provenancePolicy: 0n,
      expiresAt: 1800000000n,
      context: grantContext(1),
    },
    { tx, block, logIndex },
  )

describe("TimelineEntry", () => {
  it("two events in one block order newest-first by (block, logIndex)", async () => {
    const idx = newIndexer()
    await run(idx, [
      capabilityGranted(bytes32(0x6001), 1, B, 5),
      capabilityGranted(bytes32(0x6002), 1, B, 9),
    ])

    const entries = await idx.TimelineEntry.getAll()
    expect(entries).toHaveLength(2)

    // The data a GraphQL `order_by: [{block: desc}, {logIndex: desc}]` sorts on.
    const newestFirst = [...entries].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
    expect(newestFirst[0]?.id).toBe(`${txHash(1)}-9`)
    expect(newestFirst[1]?.id).toBe(`${txHash(1)}-5`)
    expect(newestFirst[0]?.capabilityId).toBe(bytes32(0x6002))
    expect(newestFirst[0]?.owner).toBe(OWNER)
    expect(newestFirst[0]?.txHash).toBe(txHash(1))
  })

  it("entries from different blocks still order by block first", async () => {
    const idx = newIndexer()
    await run(idx, [
      capabilityGranted(bytes32(0x6001), 1, B, 9),
      capabilityGranted(bytes32(0x6002), 2, B + 2, 0),
    ])
    const newestFirst = (await idx.TimelineEntry.getAll()).sort(
      (a, b) => b.block - a.block || b.logIndex - a.logIndex,
    )
    expect(newestFirst[0]?.id).toBe(`${txHash(2)}-0`)
  })
})
