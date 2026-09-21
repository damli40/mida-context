import { describe, expect, it } from "vitest"
import {
  CHAIN_ID,
  START_BLOCK,
  addr,
  bytes32,
  contextRecordTuple,
  grantContext,
  item,
  newIndexer,
  run,
  txHash,
} from "./helpers.js"

const OWNER = addr(0x1001)
const AGENT = bytes32(0x4001)
const NAMESPACE = bytes32(0x5001)
const CAP = bytes32(0x6001)
const B = START_BLOCK + 200

const capabilityGranted = (capId: string, tx: number, block: number, logIndex?: number) =>
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

describe("idempotent re-processing", () => {
  it("the same event delivered twice does not move any counter", async () => {
    const idx = newIndexer()
    const grant = capabilityGranted(CAP, 1, B, 0)
    await run(idx, [grant])

    const before = await idx.GlobalStats.get("global")
    expect(before?.grants).toBe(1)
    expect(before?.activeGrants).toBe(1)
    expect(before?.owners).toBe(1)
    expect(await idx.TimelineEntry.getAll()).toHaveLength(1)

    // Replay: the chain re-delivers the identical log (reorg restart / at-least-once
    // source). Same transaction hash and log index — same event identity — but it
    // lands in a later block this time, which is what a reorg can look like.
    const replay = {
      ...grant,
      block: { number: B + 5, timestamp: 1_700_000_000 + B + 5 },
    }
    await run(idx, [replay])

    const after = await idx.GlobalStats.get("global")
    expect(after?.grants).toBe(1)
    expect(after?.activeGrants).toBe(1)
    expect(after?.owners).toBe(1)
    // The skipped replay must not even bump lastBlock.
    expect(after?.lastBlock).toBe(before?.lastBlock)
    expect(await idx.TimelineEntry.getAll()).toHaveLength(1)
    expect((await idx.Owner.get(OWNER))?.grants).toBe(1)
  })

  it("a replayed AgentRevoked does not subtract activeGrants twice", async () => {
    const idx = newIndexer()
    const revoke = item(
      "CapabilityRegistry",
      "AgentRevoked",
      { owner: OWNER, agentId: AGENT, agentEpoch: 2n },
      { tx: 9, block: B + 1, logIndex: 3 },
    )
    await run(idx, [capabilityGranted(CAP, 1, B, 0), revoke])
    expect((await idx.GlobalStats.get("global"))?.activeGrants).toBe(0)

    // Same txHash + logIndex = same event identity; a later block number stands
    // in for a reorg/restart re-delivery.
    await run(idx, [
      { ...revoke, block: { number: B + 9, timestamp: 1_700_000_000 + B + 9 } },
    ])
    const stats = await idx.GlobalStats.get("global")
    expect(stats?.activeGrants).toBe(0)
    expect(stats?.agentRevocations).toBe(1)
  })

  it("a replayed ContextRegistered does not double-count records", async () => {
    const idx = newIndexer()
    const record = contextRecordTuple(1, 0n)
    const ctx = item(
      "ContextRegistry",
      "ContextRegistered",
      { owner: OWNER, namespaceId: NAMESPACE, contextId: record.contextId, record },
      { tx: 4, block: B, logIndex: 3 },
    )
    await run(idx, [ctx])
    await run(idx, [
      { ...ctx, block: { number: B + 7, timestamp: 1_700_000_000 + B + 7 } },
    ])
    const stats = await idx.GlobalStats.get("global")
    expect(stats?.contextRecords).toBe(1)
    expect((await idx.Owner.get(OWNER))?.records).toBe(1)
  })
})
