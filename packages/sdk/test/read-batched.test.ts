import { afterEach, describe, expect, it, vi } from "vitest"
import { MidaError, PERMISSION, RECORD_TYPE, evidenceCommitment, namespaceId } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, RecordReference } from "@mida/protocol"
import { hexOf, sealContextObject, wrapEpochPrivateKeyToAgent, x25519PublicKey } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { ContractFunctionRevertedError, encodeErrorResult, zeroHash } from "viem"
import { contextRegistryAbi } from "@mida/chain"
import { RegistryReader } from "@mida/api"
import { MidaAgent } from "@mida/sdk"

/**
 * in-35 R-1 — a busy project's read must not pay one chain round trip per listed record.
 * `readWithStatus` asks `getRecords` ONCE for every listed object up front, then reuses that
 * batch for each object's commitment check and for reference targets that are themselves in
 * the list; only a reference to a record outside the list costs a lone `getRecord`. The spies
 * sit on RegistryReader itself so the real multicall path (and its ContextNotFound → null
 * mapping) is what runs underneath — every commitment check stays exactly as it was.
 */

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY = `0x${"11".repeat(20)}` as Address
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as Address
const OWNER = `0x${"33".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const NAMESPACE = "projects.current"
const NAMESPACE_ID = namespaceId(NAMESPACE)
const AGENT_PRIVATE = randomBytes(32)
const EPOCH_PRIVATE = randomBytes(32)

/** The revert ContextRegistry answers for an id with no record — batched, it comes back null. */
const contextNotFound = (contextId: unknown) =>
  new ContractFunctionRevertedError({
    abi: contextRegistryAbi,
    functionName: "getRecord",
    data: encodeErrorResult({ abi: contextRegistryAbi, errorName: "ContextNotFound", args: [contextId as Hex] }),
  })

interface RefSpec {
  /** the listed object whose payload carries this reference */
  index: number
  relation: RecordReference["relation"]
  /** another listed object's index — its contextId is resolved inside the list */
  targetIndex?: number
  /** an id outside the list — the one case that still needs a lone getRecord */
  targetId?: Hex
}

/** A registry row as the contract returns it; `over` carries the per-object or test-specific fields. */
const recordView = (contextId: Hex, over: Record<string, unknown> = {}) => ({
  contextId,
  owner: OWNER,
  author: AGENT_ID,
  namespaceId: NAMESPACE_ID,
  lineageId: contextId,
  parentId: zeroHash,
  manifestHash: zeroHash,
  ciphertextCommitment: zeroHash,
  evidenceCommitment: zeroHash,
  readEpoch: 1n,
  createdAt: 1_700_000_000n,
  expiresAt: 0n,
  version: 1,
  recordType: RECORD_TYPE.CONTEXT,
  lineagePolicy: 0,
  kind: 0,
  provenanceSource: 0,
  ...over,
})

interface Fixture {
  agent: MidaAgent
  objects: { contextId: Hex; value: string }[]
  records: Map<string, Record<string, unknown>>
  getRecords: ReturnType<typeof vi.spyOn>
  getRecord: ReturnType<typeof vi.spyOn>
}

function fixture(count = 3, refs: RefSpec[] = [], extra: Record<string, unknown>[] = []): Fixture {
  const deployment = {
    chainId: CHAIN_ID,
    capabilityRegistry: CAPABILITY_REGISTRY,
    contextRegistry: CONTEXT_REGISTRY,
    deploymentBlock: 0n,
  }
  const contextIds = Array.from({ length: count }, () => hexOf(randomBytes(32)))
  const records = new Map<string, Record<string, unknown>>()
  const objects: { contextId: Hex; owner: Address; namespaceId: Hex; authorId: Hex; manifest: ObjectManifest; manifestHash: Hex; ciphertext: Hex }[] = []
  for (let i = 0; i < count; i += 1) {
    const contextId = contextIds[i]!
    const references: RecordReference[] = refs
      .filter((r) => r.index === i)
      .map((r) => ({ relation: r.relation, recordId: r.targetId ?? contextIds[r.targetIndex!]! }))
    const sealed = sealContextObject({
      payload: {
        v: 1,
        value: `object ${i}`,
        kind: "GOAL",
        provenance: { source: "AGENT_INFERRED", ...(references.length === 0 ? {} : { references }) },
      },
      binding: { chainId: CHAIN_ID, contextRegistry: CONTEXT_REGISTRY, contextId, namespaceId: NAMESPACE_ID, readEpoch: 1n },
      epochPublicKey: x25519PublicKey(EPOCH_PRIVATE),
    })
    objects.push({ contextId, owner: OWNER, namespaceId: NAMESPACE_ID, authorId: AGENT_ID, manifest: sealed.manifest, manifestHash: sealed.manifestHash, ciphertext: hexOf(sealed.ciphertext) })
    records.set(
      contextId,
      recordView(contextId, {
        manifestHash: sealed.manifestHash,
        ciphertextCommitment: sealed.ciphertextCommitment,
        evidenceCommitment: references.length === 0 ? zeroHash : evidenceCommitment(references),
        // a distinct second per object keeps the placement scan out of these tests entirely
        createdAt: 1_700_000_000n + BigInt(i),
      }),
    )
  }
  for (const record of extra) records.set(String(record.contextId).toLowerCase(), record)

  // A chain with Multicall3: getCode answers bytecode, multicall serves the records map, and a
  // lone getRecord serves ids outside the batch — the same ContextNotFound the contract reverts.
  const publicClient = {
    getCode: async () => "0x6000",
    multicall: async (params: { contracts: { args: readonly unknown[] }[] }) =>
      params.contracts.map((contract) => {
        const record = records.get((contract.args[0] as string).toLowerCase())
        return record === undefined
          ? { status: "failure" as const, error: contextNotFound(contract.args[0]) }
          : { status: "success" as const, result: record }
      }),
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
        const record = records.get((params.args[0] as string).toLowerCase())
        if (record === undefined) throw contextNotFound(params.args[0])
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
  const getRecords = vi.spyOn(RegistryReader.prototype, "getRecords")
  const getRecord = vi.spyOn(RegistryReader.prototype, "getRecord")
  const agent = new MidaAgent({
    agentId: AGENT_ID,
    callbackOrigin: "https://agent.example",
    encryptionPrivateKey: AGENT_PRIVATE,
    chain: { deployment, account: { address: `0x${"55".repeat(20)}` }, publicClient } as never,
    api: api as never,
    grants: [
      {
        owner: OWNER,
        agentId: AGENT_ID,
        requestId: `0x${"99".repeat(32)}` as Hex,
        capabilities: [
          {
            capabilityId: `0x${"77".repeat(32)}` as Hex,
            namespaceId: NAMESPACE_ID,
            permissions: PERMISSION.READ,
            provenancePolicy: 0,
            expiresAt: "0",
            transactionHash: `0x${"88".repeat(32)}` as Hex,
          },
        ],
      },
    ],
  })
  return {
    agent,
    objects: objects.map(({ contextId }, i) => ({ contextId, value: `object ${i}` })),
    records,
    getRecords,
    getRecord,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("MidaAgent.read record batching (in-35 R-1)", () => {
  it("an 83-checkpoint read makes exactly ONE getRecords call and zero getRecord calls", async () => {
    const fx = fixture(83)
    const objects = await fx.agent.read(OWNER, NAMESPACE)
    expect(objects.map((o) => o.contextId)).toEqual(fx.objects.map((o) => o.contextId))
    expect(fx.getRecords).toHaveBeenCalledTimes(1)
    expect(fx.getRecords.mock.calls[0]![0]).toHaveLength(83)
    expect(fx.getRecord).not.toHaveBeenCalled()
  })

  it("a reference to another listed record is answered from the batch — no extra chain read", async () => {
    const fx = fixture(3, [{ index: 0, relation: "confirmed_from", targetIndex: 1 }])
    const objects = await fx.agent.read(OWNER, NAMESPACE)
    expect(objects[0]!.payload.provenance.references).toEqual([
      { relation: "confirmed_from", recordId: fx.objects[1]!.contextId },
    ])
    expect(fx.getRecords).toHaveBeenCalledTimes(1)
    expect(fx.getRecord).not.toHaveBeenCalled()
  })

  it("a reference to a record outside the list costs exactly one getRecord", async () => {
    const external = hexOf(randomBytes(32))
    const fx = fixture(
      2,
      [{ index: 0, relation: "supports", targetId: external }],
      [recordView(external, { recordType: RECORD_TYPE.EVIDENCE })],
    )
    const objects = await fx.agent.read(OWNER, NAMESPACE)
    expect(objects).toHaveLength(2)
    expect(fx.getRecords).toHaveBeenCalledTimes(1)
    expect(fx.getRecord).toHaveBeenCalledTimes(1)
    expect(fx.getRecord.mock.calls[0]![0]).toBe(external)
  })

  it("a listed object whose batched record is null still throws today's COMMITMENT_MISMATCH", async () => {
    const fx = fixture(4)
    const target = fx.objects[2]!.contextId
    fx.records.delete(target)
    const error = await fx.agent.read(OWNER, NAMESPACE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MidaError)
    expect(error).toMatchObject({ code: "COMMITMENT_MISMATCH" })
    expect((error as MidaError).message).toBe(`COMMITMENT_MISMATCH: object ${target} does not match its Monad commitments`)
  })

  it("a listed object whose manifest hash moved still throws today's COMMITMENT_MISMATCH", async () => {
    const fx = fixture(4)
    const target = fx.objects[1]!.contextId
    fx.records.get(target)!.manifestHash = `0x${"ee".repeat(32)}`
    const error = await fx.agent.read(OWNER, NAMESPACE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MidaError)
    expect(error).toMatchObject({ code: "COMMITMENT_MISMATCH" })
    expect((error as MidaError).message).toBe(`COMMITMENT_MISMATCH: object ${target} does not match its Monad commitments`)
  })

  it("a getRecords failure fails the read the way a failing getRecord did — thrown, not retried", async () => {
    const fx = fixture(4)
    const boom = new Error("rpc down")
    fx.getRecords.mockRejectedValue(boom)
    await expect(fx.agent.read(OWNER, NAMESPACE)).rejects.toBe(boom)
    expect(fx.getRecords).toHaveBeenCalledTimes(1)
  })

  it("a reference to a record that exists nowhere still names it COMMITMENT_MISMATCH", async () => {
    const missing = hexOf(randomBytes(32))
    const fx = fixture(2, [{ index: 0, relation: "supports", targetId: missing }])
    const error = await fx.agent.read(OWNER, NAMESPACE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MidaError)
    expect(error).toMatchObject({ code: "COMMITMENT_MISMATCH" })
    expect((error as MidaError).message).toBe(`COMMITMENT_MISMATCH: referenced record ${missing} does not exist for this owner`)
    // the lone getRecord ran — the chain's "not found" is what the provenance check reports
    expect(fx.getRecord).toHaveBeenCalledTimes(1)
  })
})
