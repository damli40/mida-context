import { describe, expect, it } from "vitest"
import { PERMISSION, RECORD_TYPE, namespaceId } from "@mida/protocol"
import type { Address, Hex, ObjectManifest } from "@mida/protocol"
import { hexOf, sealContextObject, wrapEpochPrivateKeyToAgent, x25519PublicKey } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { zeroHash } from "viem"
import { MidaAgent } from "@mida/sdk"

/**
 * R4-2 — `read` overlaps its per-object work with a bounded concurrency of 6: the output order
 * and every verification are identical to the sequential loop. The fixture is a fake Context
 * API and a fake chain over REAL crypto: real sealed objects, real reader wraps, a real
 * RegistryReader-shaped client, so the concurrent path runs the same checks it always did.
 * Since in-35 R-1 the records arrive in ONE getRecords multicall up front — the concurrency the
 * worker pool still bounds is the per-object open-and-verify work, measured here through the
 * one remaining per-object fetch, the epoch wrap.
 */

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY = `0x${"11".repeat(20)}` as Address
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as Address
const OWNER = `0x${"33".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const NAMESPACE = "goals.career"
const NAMESPACE_ID = namespaceId(NAMESPACE)
const AGENT_PRIVATE = randomBytes(32)
const EPOCH_PRIVATE: Record<number, Uint8Array> = {}
const epochPrivate = (n: number): Uint8Array => (EPOCH_PRIVATE[n] ??= randomBytes(32))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Fixture {
  agent: MidaAgent
  objects: { contextId: Hex; value: string }[]
  /** in-flight overlap on the per-object work that is still per-object after in-35 R-1: the epoch-key fetch */
  wrapInFlight: { max: number }
  wrapCalls: bigint[]
  /** CHAIN-04 tests: the next N wrap fetches fail */
  failWraps: number
  tamper?: (record: Record<string, unknown>, contextId: Hex) => Record<string, unknown>
}

function fixture(count = 12, delayMs = 12, epochs = 2, epochKeyCache?: Map<string, Promise<Uint8Array>>): Fixture {
  const deployment = {
    chainId: CHAIN_ID,
    capabilityRegistry: CAPABILITY_REGISTRY,
    contextRegistry: CONTEXT_REGISTRY,
    deploymentBlock: 0n,
  }
  const fx: Fixture = {
    agent: undefined as unknown as MidaAgent,
    objects: [],
    wrapInFlight: { max: 0 },
    wrapCalls: [],
    failWraps: 0,
  }
  const records = new Map<string, Record<string, unknown>>()
  // The wire shape (AnchoredObject): the manifest is the parsed object and the ciphertext is
  // lowercase 0x hex — the same helpers agent.test.ts uses, sealed.manifest + hexOf(ciphertext).
  const objects: { contextId: Hex; owner: Address; namespaceId: Hex; authorId: Hex; manifest: ObjectManifest; manifestHash: Hex; ciphertext: Hex }[] = []
  for (let i = 0; i < count; i += 1) {
    const readEpoch = BigInt((i % epochs) + 1)
    const contextId = hexOf(randomBytes(32))
    const value = `object ${i}`
    const sealed = sealContextObject({
      payload: { v: 1, value, kind: "GOAL", provenance: { source: "AGENT_INFERRED" } },
      binding: { chainId: CHAIN_ID, contextRegistry: CONTEXT_REGISTRY, contextId, namespaceId: NAMESPACE_ID, readEpoch },
      epochPublicKey: x25519PublicKey(epochPrivate(Number(readEpoch))),
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
  // One record lookup both chain doors share: the batched multicall answers listed records and
  // a lone readContract.getRecord serves anything else — the tamper hook sees either.
  const serveRecord = (contextId: string) => {
    const record = records.get(contextId)
    if (record === undefined) throw new Error("not found")
    return fx.tamper === undefined ? record : fx.tamper(record, contextId as Hex)
  }
  const publicClient = {
    // Multicall3 present (nonempty bytecode): getRecords takes its single-eth_call path.
    getCode: async () => "0x6000",
    multicall: async (params: { contracts: { args: readonly unknown[] }[] }) =>
      params.contracts.map((contract) => {
        try {
          return { status: "success" as const, result: serveRecord((contract.args[0] as string).toLowerCase()) }
        } catch (error) {
          return { status: "failure" as const, error }
        }
      }),
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
      if (params.functionName === "getRecord") return serveRecord((params.args[0] as string).toLowerCase())
      throw new Error(`unexpected readContract ${params.functionName}`)
    },
  }
  let wrapInFlight = 0
  const api = {
    account: { address: `0x${"55".repeat(20)}` as Address },
    listObjects: async () => ({ objects, partial: false }),
    getEpochWrap: async (params: { readEpoch: bigint }) => {
      fx.wrapCalls.push(params.readEpoch)
      if (fx.failWraps > 0) {
        fx.failWraps -= 1
        throw new Error("store unreachable")
      }
      wrapInFlight += 1
      fx.wrapInFlight.max = Math.max(fx.wrapInFlight.max, wrapInFlight)
      try {
        await sleep(delayMs)
        return wrapEpochPrivateKeyToAgent({
          epochPrivateKey: epochPrivate(Number(params.readEpoch)),
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
      } finally {
        wrapInFlight -= 1
      }
    },
  }
  fx.agent = new MidaAgent({
    agentId: AGENT_ID,
    callbackOrigin: "https://agent.example",
    encryptionPrivateKey: AGENT_PRIVATE,
    chain: { deployment, account: { address: `0x${"55".repeat(20)}` }, publicClient } as never,
    api: api as never,
    ...(epochKeyCache === undefined ? {} : { epochKeyCache }),
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

  it("at most 6 objects' work is in flight, and the work really does overlap", async () => {
    // 12 objects on 12 distinct epochs: each worker's first act is the epoch-key fetch, so the
    // wrap in-flight count tracks the worker pool's concurrency exactly.
    const fx = fixture(12, 12, 12)
    await fx.agent.read(OWNER, NAMESPACE)
    expect(fx.wrapInFlight.max).toBeGreaterThan(1)
    expect(fx.wrapInFlight.max).toBeLessThanOrEqual(6)
  })

  it("fetches each distinct epoch key exactly once — two calls for two epochs", async () => {
    const fx = fixture(12)
    await fx.agent.read(OWNER, NAMESPACE)
    expect(fx.wrapCalls.sort()).toEqual([1n, 2n])
  })

  // CHAIN-04 (Oct 1): on testnet the two key fetches cost ~2 s of a ~5 s read, every read, for
  // keys that never change for a past epoch — they are kept beyond one read
  it("a second read on the same agent fetches no epoch key again (CHAIN-04)", async () => {
    const fx = fixture(12)
    await fx.agent.read(OWNER, NAMESPACE)
    await fx.agent.read(OWNER, NAMESPACE)
    expect(fx.wrapCalls.sort()).toEqual([1n, 2n])
  })

  it("a shared epoch-key cache carries keys across agent instances, as the daemon rebuilds agents per read (CHAIN-04)", async () => {
    const shared = new Map<string, Promise<Uint8Array>>()
    const first = fixture(12, 12, 2, shared)
    await first.agent.read(OWNER, NAMESPACE)
    const second = fixture(12, 12, 2, shared)
    const results = await second.agent.read(OWNER, NAMESPACE)
    expect(second.wrapCalls).toEqual([])
    expect(results.map((o) => o.payload.value)).toEqual(second.objects.map((o) => o.value))
  })

  it("a failed epoch-key fetch is never remembered — the next read tries again (CHAIN-04)", async () => {
    const fx = fixture(4, 1, 1)
    fx.failWraps = 1
    await expect(fx.agent.read(OWNER, NAMESPACE)).rejects.toThrow()
    const results = await fx.agent.read(OWNER, NAMESPACE)
    expect(results).toHaveLength(4)
  })

  it("one object failing verification still fails the whole read", async () => {
    const fx = fixture(12)
    const target = fx.objects[4]!.contextId
    fx.tamper = (record, contextId) => (contextId === target ? { ...record, manifestHash: `0x${"ee".repeat(32)}` } : record)
    await expect(fx.agent.read(OWNER, NAMESPACE)).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
  })
})
