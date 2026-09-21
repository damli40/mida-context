import { describe, expect, it } from "vitest"
import { PERMISSION, RECORD_TYPE, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf, sealContextObject, wrapEpochPrivateKeyToAgent, x25519PublicKey } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { zeroHash } from "viem"
import { MidaAgent } from "@mida/sdk"

/**
 * R4-2 — `read` overlaps its per-object work with a bounded concurrency of 6: the output order
 * and every verification are identical to the sequential loop. The fixture is a fake Context
 * API and a fake chain over REAL crypto: real sealed objects, real reader wraps, a real
 * RegistryReader-shaped client, so the concurrent path runs the same checks it always did.
 */

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY = `0x${"11".repeat(20)}` as Address
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as Address
const OWNER = `0x${"33".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const NAMESPACE = "goals.career"
const NAMESPACE_ID = namespaceId(NAMESPACE)
const AGENT_PRIVATE = randomBytes(32)
const EPOCH_PRIVATE: Record<number, Uint8Array> = { 1: randomBytes(32), 2: randomBytes(32) }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Fixture {
  agent: MidaAgent
  objects: { contextId: Hex; value: string }[]
  getRecordCalls: { maxInFlight: number }
  wrapCalls: bigint[]
  tamper?: (record: Record<string, unknown>, contextId: Hex) => Record<string, unknown>
}

function fixture(count = 12, delayMs = 12): Fixture {
  const deployment = {
    chainId: CHAIN_ID,
    capabilityRegistry: CAPABILITY_REGISTRY,
    contextRegistry: CONTEXT_REGISTRY,
    deploymentBlock: 0n,
  }
  const fx: Fixture = {
    agent: undefined as unknown as MidaAgent,
    objects: [],
    getRecordCalls: { maxInFlight: 0 },
    wrapCalls: [],
  }
  const records = new Map<string, Record<string, unknown>>()
  const objects: { contextId: Hex; owner: Address; namespaceId: Hex; authorId: Hex; manifest: unknown; manifestHash: Hex; ciphertext: Uint8Array }[] = []
  for (let i = 0; i < count; i += 1) {
    const readEpoch = BigInt((i % 2) + 1) // two epochs, interleaved
    const contextId = hexOf(randomBytes(32))
    const value = `object ${i}`
    const sealed = sealContextObject({
      payload: { v: 1, value, kind: "GOAL", provenance: { source: "AGENT_INFERRED" } },
      binding: { chainId: CHAIN_ID, contextRegistry: CONTEXT_REGISTRY, contextId, namespaceId: NAMESPACE_ID, readEpoch },
      epochPublicKey: x25519PublicKey(EPOCH_PRIVATE[Number(readEpoch)]!),
    })
    objects.push({ contextId, owner: OWNER, namespaceId: NAMESPACE_ID, authorId: AGENT_ID, manifest: sealed.manifest, manifestHash: sealed.manifestHash, ciphertext: sealed.ciphertext })
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
      readEpoch,
      createdAt: 1_700_000_000n,
      expiresAt: 0n,
      version: 1,
      recordType: RECORD_TYPE.CONTEXT,
      lineagePolicy: 0,
      kind: 0,
      provenanceSource: 0,
    })
    fx.objects.push({ contextId, value })
  }
  let inFlight = 0
  const publicClient = {
    readContract: async (params: { address: Address; functionName: string; args: readonly unknown[] }) => {
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
        inFlight += 1
        fx.getRecordCalls.maxInFlight = Math.max(fx.getRecordCalls.maxInFlight, inFlight)
        try {
          await sleep(delayMs)
          const record = records.get(params.args[0] as string)
          if (record === undefined) throw new Error("not found")
          return fx.tamper === undefined ? record : fx.tamper(record, params.args[0] as Hex)
        } finally {
          inFlight -= 1
        }
      }
      throw new Error(`unexpected readContract ${params.functionName}`)
    },
  }
  const api = {
    account: { address: `0x${"55".repeat(20)}` as Address },
    listObjects: async () => objects,
    getEpochWrap: async (params: { readEpoch: bigint }) => {
      fx.wrapCalls.push(params.readEpoch)
      return wrapEpochPrivateKeyToAgent({
        epochPrivateKey: EPOCH_PRIVATE[Number(params.readEpoch)]!,
        agentEncryptionPublicKey: x25519PublicKey(AGENT_PRIVATE),
        binding: {
          chainId: CHAIN_ID,
          capabilityRegistry: CAPABILITY_REGISTRY,
          owner: OWNER,
          namespaceId: NAMESPACE_ID,
          readEpoch: params.readEpoch,
          agentId: AGENT_ID,
          agentKeyVersion: 1,
        },
        createdAt: 0n,
      })
    },
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

describe("MidaAgent.read bounded concurrency (R4-2)", () => {
  it("returns the same objects in the same order as the sequential loop — 12 objects over 2 epochs", async () => {
    const fx = fixture(12)
    const results = await fx.agent.read(OWNER, NAMESPACE)
    expect(results.map((o) => o.contextId)).toEqual(fx.objects.map((o) => o.contextId))
    expect(results.map((o) => o.payload.value)).toEqual(fx.objects.map((o) => o.value))
  })

  it("at most 6 object verifications are in flight, and the work really does overlap", async () => {
    const fx = fixture(12)
    await fx.agent.read(OWNER, NAMESPACE)
    expect(fx.getRecordCalls.maxInFlight).toBeGreaterThan(1)
    expect(fx.getRecordCalls.maxInFlight).toBeLessThanOrEqual(6)
  })

  it("fetches each distinct epoch key exactly once — two calls for two epochs", async () => {
    const fx = fixture(12)
    await fx.agent.read(OWNER, NAMESPACE)
    expect(fx.wrapCalls.sort()).toEqual([1n, 2n])
  })

  it("one object failing verification still fails the whole read", async () => {
    const fx = fixture(12)
    const target = fx.objects[4]!.contextId
    fx.tamper = (record, contextId) => (contextId === target ? { ...record, manifestHash: `0x${"ee".repeat(32)}` } : record)
    await expect(fx.agent.read(OWNER, NAMESPACE)).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
  })
})
