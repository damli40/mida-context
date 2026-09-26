import { describe, expect, it } from "vitest"
import { PERMISSION, RECORD_TYPE, namespaceId } from "@mida/protocol"
import type { Address, Hex, ObjectManifest } from "@mida/protocol"
import { hexOf, sealContextObject, wrapEpochPrivateKeyToAgent, x25519PublicKey } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { zeroHash } from "viem"
import { MidaAgent } from "@mida/sdk"

/**
 * in-9 R-1 — a read must never scan the chain's whole history for record placements. Ordering
 * runs on the record's own chain-stored createdAt; only when two returned records share the same
 * SECOND does the read need the event log's (block, index) — and then it asks with a bounded
 * ±64-block window around the block that second implies, never from deploymentBlock.
 *
 * Same fake-API / fake-chain style as read-concurrency.test.ts: real sealed objects and wraps
 * over a recording publicClient, so every chain call the read makes is counted and inspectable.
 */

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY = `0x${"11".repeat(20)}` as Address
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as Address
const OWNER = `0x${"33".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const NAMESPACE = "goals.career"
const NAMESPACE_ID = namespaceId(NAMESPACE)
const AGENT_PRIVATE = randomBytes(32)
const EPOCH_PRIVATE = randomBytes(32)

/** The chain head the fake client reports: block 2000, stamped at HEAD_TS. */
const HEAD_BLOCK = 2_000n
const HEAD_TS = 1_700_010_000n

interface LogCall {
  fromBlock: bigint
  toBlock: bigint
  contextIds?: string[]
}

interface Fixture {
  agent: MidaAgent
  objects: { contextId: Hex; value: string }[]
  logCalls: LogCall[]
  /** contextId → the ContextRegistered event's real (block, logIndex), served by the fake getLogs. */
  placements: Map<string, { block: bigint; index: number }>
}

/** `createdAts[i]` is the registry row's stored second for object i. */
function fixture(createdAts: bigint[]): Fixture {
  const deployment = {
    chainId: CHAIN_ID,
    capabilityRegistry: CAPABILITY_REGISTRY,
    contextRegistry: CONTEXT_REGISTRY,
    deploymentBlock: 5n,
  }
  const fx: Fixture = { agent: undefined as unknown as MidaAgent, objects: [], logCalls: [], placements: new Map() }
  const records = new Map<string, Record<string, unknown>>()
  const objects: { contextId: Hex; owner: Address; namespaceId: Hex; authorId: Hex; manifest: ObjectManifest; manifestHash: Hex; ciphertext: Hex }[] = []
  for (let i = 0; i < createdAts.length; i += 1) {
    const contextId = hexOf(randomBytes(32))
    const value = `object ${i}`
    const sealed = sealContextObject({
      payload: { v: 1, value, kind: "GOAL", provenance: { source: "AGENT_INFERRED" } },
      binding: { chainId: CHAIN_ID, contextRegistry: CONTEXT_REGISTRY, contextId, namespaceId: NAMESPACE_ID, readEpoch: 1n },
      epochPublicKey: x25519PublicKey(EPOCH_PRIVATE),
    })
    objects.push({ contextId, owner: OWNER, namespaceId: NAMESPACE_ID, authorId: AGENT_ID, manifest: sealed.manifest, manifestHash: sealed.manifestHash, ciphertext: hexOf(sealed.ciphertext) })
    records.set(contextId, {
      contextId,
      owner: OWNER,
      author: AGENT_ID,
      namespaceId: NAMESPACE_ID,
      lineageId: contextId,
      parentId: zeroHash,
      manifestHash: sealed.manifestHash,
      ciphertextCommitment: sealed.ciphertextCommitment,
      evidenceCommitment: zeroHash,
      readEpoch: 1n,
      createdAt: createdAts[i],
      expiresAt: 0n,
      version: 1,
      recordType: RECORD_TYPE.CONTEXT,
      lineagePolicy: 0,
      kind: 0,
      provenanceSource: 0,
    })
    // the "real" placement: a block whose timestamp is the record's createdAt — on this fake
    // chain one second is one block, and the saves are recent, so HEAD - (HEAD_TS - createdAt)
    const block = HEAD_BLOCK - (HEAD_TS - createdAts[i]!)
    fx.placements.set(contextId, { block, index: i * 3 + 1 })
    fx.objects.push({ contextId, value })
  }
  const publicClient = {
    getBlock: async (params?: { blockTag?: string }) => {
      return { number: HEAD_BLOCK, timestamp: HEAD_TS }
    },
    getBlockNumber: async () => HEAD_BLOCK,
    getLogs: async (params: { fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> }) => {
      const wanted = params.args?.contextId
      const ids = Array.isArray(wanted) ? wanted.map((c) => String(c).toLowerCase()) : undefined
      fx.logCalls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock, ...(ids === undefined ? {} : { contextIds: ids }) })
      return [...fx.placements.entries()]
        .filter(([contextId, p]) => ids?.includes(contextId) && p.block >= params.fromBlock && p.block <= params.toBlock)
        .map(([contextId, p]) => ({
          args: { contextId, owner: OWNER, namespaceId: NAMESPACE_ID },
          blockNumber: p.block,
          logIndex: p.index,
          transactionHash: `0x${"ab".repeat(32)}`,
        }))
    },
    readContract: async (params: { functionName: string; args: readonly unknown[] }) => {
      if (params.functionName === "getAgent") {
        return {
          operator: `0x${"44".repeat(20)}`,
          signer: `0x${"55".repeat(20)}`,
          encryptionPublicKey: hexOf(x25519PublicKey(AGENT_PRIVATE)),
          encryptionKeyVersion: 1,
          callbackOriginHash: zeroHash,
          capabilityManifestHash: zeroHash,
          capabilityManifestVersion: 1n,
          active: true,
        }
      }
      if (params.functionName === "getRecord") {
        const record = records.get(params.args[0] as string)
        if (record === undefined) throw new Error("not found")
        return record
      }
      throw new Error(`unexpected readContract ${params.functionName}`)
    },
  }
  const api = {
    account: { address: `0x${"55".repeat(20)}` as Address },
    listObjects: async () => ({ objects, partial: false }),
    getEpochWrap: async () =>
      wrapEpochPrivateKeyToAgent({
        epochPrivateKey: EPOCH_PRIVATE,
        agentEncryptionPublicKey: x25519PublicKey(AGENT_PRIVATE),
        binding: {
          chainId: CHAIN_ID,
          capabilityRegistry: CAPABILITY_REGISTRY,
          owner: OWNER,
          namespaceId: NAMESPACE_ID,
          readEpoch: 1n,
          agentId: AGENT_ID,
          agentKeyVersion: 1,
        },
        createdAt: 0n,
      }),
  }
  fx.agent = new MidaAgent({
    agentId: AGENT_ID,
    callbackOrigin: "https://agent.example",
    encryptionPrivateKey: AGENT_PRIVATE,
    chain: { deployment, account: { address: `0x${"55".repeat(20)}` }, publicClient } as never,
    api: api as never,
    grants: [
      {
        owner: OWNER,
        agentId: AGENT_ID,
        requestId: `0x${"99".repeat(32)}`,
        capabilities: [
          {
            capabilityId: `0x${"77".repeat(32)}`,
            namespaceId: NAMESPACE_ID,
            permissions: PERMISSION.READ,
            provenancePolicy: 0,
            expiresAt: "0",
            transactionHash: `0x${"88".repeat(32)}`,
          },
        ],
      },
    ],
  })
  return fx
}

describe("read placements (in-9 R-1)", () => {
  it("a read with no same-second tie asks the event log ZERO times — no history scan", async () => {
    const fx = fixture([HEAD_TS - 3n, HEAD_TS - 2n, HEAD_TS - 1n])
    const objects = await fx.agent.read(OWNER, NAMESPACE)
    expect(objects.map((o) => o.contextId)).toEqual(fx.objects.map((o) => o.contextId))
    // the stamps still come off the records themselves — chain truth, not the writer's claim
    expect(objects.map((o) => o.chain?.at)).toEqual([HEAD_TS - 3n, HEAD_TS - 2n, HEAD_TS - 1n])
    expect(fx.logCalls).toEqual([])
  })

  it("a same-second tie scans ONE bounded window around the implied block — never from deploymentBlock", async () => {
    // two records share HEAD_TS - 5; the third stands alone
    const fx = fixture([HEAD_TS - 5n, HEAD_TS - 5n, HEAD_TS - 1n])
    const objects = await fx.agent.read(OWNER, NAMESPACE)
    expect(fx.logCalls.length).toBeLessThanOrEqual(3)
    expect(fx.logCalls.length).toBeGreaterThan(0)
    for (const call of fx.logCalls) {
      // bounded: a ±64-block window, not a scan that opens at deploymentBlock (5)
      expect(call.fromBlock).toBeGreaterThan(1_000n)
      expect(call.toBlock - call.fromBlock).toBeLessThanOrEqual(200n)
      expect(call.toBlock).toBeLessThanOrEqual(HEAD_BLOCK)
    }
    // the tied two carry the placement the log recorded — block AND index
    const tied = objects.filter((o) => o.chain?.at === HEAD_TS - 5n)
    for (const object of tied) {
      const real = fx.placements.get(object.contextId)!
      expect(object.chain?.block).toBe(real.block)
      expect(object.chain?.index).toBe(real.index)
    }
  })

  it("a tie older than the estimate window misses quietly — the same-second records simply carry no placement", async () => {
    // placements "really" sit far below the estimate window: createdAt claims recent, the fake
    // getLogs finds nothing in the window — the read still resolves, placement-less
    const fx = fixture([HEAD_TS - 5n, HEAD_TS - 5n])
    fx.placements.clear()
    fx.placements.set(fx.objects[0]!.contextId, { block: 10n, index: 0 })
    fx.placements.set(fx.objects[1]!.contextId, { block: 10n, index: 1 })
    const objects = await fx.agent.read(OWNER, NAMESPACE)
    expect(objects.every((o) => o.chain?.at === HEAD_TS - 5n)).toBe(true)
    expect(objects.every((o) => o.chain?.block === undefined)).toBe(true)
    expect(fx.logCalls.length).toBeLessThanOrEqual(3)
  })

  it("placements: false skips the event log entirely even with a same-second tie (the save duplicate-check read)", async () => {
    const fx = fixture([HEAD_TS - 5n, HEAD_TS - 5n])
    await fx.agent.read(OWNER, NAMESPACE, { placements: false })
    expect(fx.logCalls).toEqual([])
  })
})
