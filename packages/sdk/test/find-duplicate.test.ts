// in-12 N-6 — the save path's duplicate check must not re-verify every earlier row on chain.
// Deciding "is this eventId already saved" needs the row's decrypted payload, and opening a row
// is local work, so the check spends chain reads only on a row whose payload actually claims the
// match. The fixture is real crypto — genuinely sealed objects and signed batch saves — over a
// fake chain that counts every readContract call, so the request count is measured, not assumed.
import { describe, expect, it } from "vitest"
import { CONTEXT_KIND, PERMISSION, PROVENANCE_SOURCE, RECORD_TYPE, batchContextId, namespaceId } from "@mida/protocol"
import type { Address, BatchSaveMessage, ContextPayload, Hex, ObjectManifest } from "@mida/protocol"
import { hexOf, sealContextObject, wrapEpochPrivateKeyToAgent, x25519PublicKey } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { ContractFunctionRevertedError, encodeErrorResult, zeroHash } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { contextRegistryAbi } from "@mida/chain"
import { MidaAgent, signBatchSave } from "@mida/sdk"
import type { BatchedReadItem } from "@mida/sdk"

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY = `0x${"11".repeat(20)}` as Address
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as Address
const BATCH_ANCHOR = `0x${"66".repeat(20)}` as Address
const OWNER = `0x${"33".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const NAMESPACE = "goals.career"
const NAMESPACE_ID = namespaceId(NAMESPACE)
const AGENT_PRIVATE = randomBytes(32)
const EPOCH_PRIVATE = randomBytes(32)
const AGENT_SIGNER = privateKeyToAccount(generatePrivateKey())

const DEPLOYMENT = {
  chainId: CHAIN_ID,
  capabilityRegistry: CAPABILITY_REGISTRY,
  contextRegistry: CONTEXT_REGISTRY,
  batchAnchor: BATCH_ANCHOR,
  policyHashV1: `0x${"12".repeat(32)}` as Hex,
  vaultRpId: "mida.test",
  vaultRpIdHash: `0x${"13".repeat(32)}` as Hex,
  deploymentBlock: 0n,
}

const EPOCH = 1n

/** The contract's real answer for a contextId it never anchored. */
const contextNotFound = (contextId: string) =>
  encodeErrorResult({ abi: contextRegistryAbi, errorName: "ContextNotFound", args: [contextId as Hex] })

function sealValue(value: string, contextId: Hex) {
  const payload: ContextPayload = { v: 1, value, kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } }
  return sealContextObject({
    payload,
    binding: { chainId: CHAIN_ID, contextRegistry: CONTEXT_REGISTRY, contextId, namespaceId: NAMESPACE_ID, readEpoch: EPOCH },
    epochPublicKey: x25519PublicKey(EPOCH_PRIVATE),
  })
}

function directObject(value: string) {
  const contextId = hexOf(randomBytes(32))
  const sealed = sealValue(value, contextId)
  return {
    contextId,
    owner: OWNER,
    namespaceId: NAMESPACE_ID,
    authorId: AGENT_ID,
    manifest: sealed.manifest,
    manifestHash: sealed.manifestHash,
    ciphertext: hexOf(sealed.ciphertext),
    sealed,
  }
}

async function batchedItem(value: string, state: BatchedReadItem["state"] = "QUEUED"): Promise<BatchedReadItem> {
  const objectNonce = hexOf(randomBytes(32))
  const contextId = batchContextId({
    chainId: CHAIN_ID,
    batchAnchor: BATCH_ANCHOR,
    owner: OWNER,
    agentId: AGENT_ID,
    namespaceId: NAMESPACE_ID,
    parentId: zeroHash,
    objectNonce,
  })
  const sealed = sealValue(value, contextId)
  const message: BatchSaveMessage = {
    owner: OWNER,
    namespaceId: NAMESPACE_ID,
    objectNonce,
    lineageId: zeroHash,
    parentId: zeroHash,
    parentVersion: 0,
    rootAuthor: zeroHash,
    manifestHash: sealed.manifestHash,
    ciphertextCommitment: sealed.ciphertextCommitment,
    readEpoch: EPOCH,
    expiresAt: 0n,
    kind: CONTEXT_KIND.EPISODE,
    provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
  }
  const signature = await signBatchSave({ account: AGENT_SIGNER, chainId: CHAIN_ID, batchAnchor: BATCH_ANCHOR, message })
  return {
    state,
    save: { message: { ...message, readEpoch: String(EPOCH), expiresAt: "0" }, signature, manifest: sealed.manifest, ciphertext: hexOf(sealed.ciphertext) },
    contextId,
    receivedAt: Date.now(),
  }
}

interface Fixture {
  agent: MidaAgent
  /** functionName → count: every chain read this run paid for. */
  calls: Map<string, number>
  /** Every record the fake chain holds, contextId → chain-shaped row (empty = nothing anchored). */
  records: Map<string, Record<string, unknown>>
  setDirect(objects: ReturnType<typeof directObject>[]): void
  setBatched(items: BatchedReadItem[]): void
}

function fixture(): Fixture {
  const fx: Fixture = {
    agent: undefined as unknown as MidaAgent,
    calls: new Map(),
    records: new Map(),
    setDirect: () => {},
    setBatched: () => {},
  }
  let objects: ReturnType<typeof directObject>[] = []
  let items: BatchedReadItem[] = []
  fx.setDirect = (next) => {
    objects = next
    fx.records.clear()
    for (const object of next) {
      fx.records.set(object.contextId, {
        contextId: object.contextId,
        owner: OWNER,
        author: AGENT_ID,
        namespaceId: NAMESPACE_ID,
        lineageId: object.contextId,
        parentId: zeroHash,
        manifestHash: object.sealed.manifestHash,
        ciphertextCommitment: object.sealed.ciphertextCommitment,
        evidenceCommitment: zeroHash,
        readEpoch: EPOCH,
        createdAt: 1_700_000_000n,
        expiresAt: 0n,
        version: 1,
        recordType: RECORD_TYPE.CONTEXT,
        lineagePolicy: 0,
        kind: 0,
        provenanceSource: 0,
      })
    }
  }
  fx.setBatched = (next) => {
    items = next
  }
  const count = (name: string) => fx.calls.set(name, (fx.calls.get(name) ?? 0) + 1)
  const publicClient = {
    readContract: async (params: { address: Address; functionName: string; args: readonly unknown[] }) => {
      count(params.functionName)
      if (params.functionName === "getAgent") {
        return {
          operator: `0x${"44".repeat(20)}`,
          signer: AGENT_SIGNER.address,
          encryptionPublicKey: hexOf(x25519PublicKey(AGENT_PRIVATE)),
          encryptionKeyVersion: 1,
          callbackOriginHash: zeroHash,
          capabilityManifestHash: zeroHash,
          capabilityManifestVersion: 1n,
          active: true,
        }
      }
      if (params.functionName === "getRecord") {
        const contextId = params.args[0] as string
        const record = fx.records.get(contextId)
        if (record === undefined) {
          throw new ContractFunctionRevertedError({ abi: contextRegistryAbi, functionName: "getRecord", data: contextNotFound(contextId) } as never)
        }
        return record
      }
      if (params.functionName === "agentIdOfSigner") {
        return (params.args[0] as string).toLowerCase() === AGENT_SIGNER.address.toLowerCase() ? AGENT_ID : zeroHash
      }
      if (params.functionName === "hasAuthority") return true
      if (params.functionName === "batchOf") return [zeroHash, 0n]
      throw new Error(`unexpected readContract ${params.functionName}`)
    },
  }
  const api = {
    account: { address: AGENT_SIGNER.address },
    listObjects: async () => ({ objects, partial: false }),
    listBatchSaves: async () => ({ items, partial: false }),
    getEpochWrap: async () =>
      wrapEpochPrivateKeyToAgent({
        epochPrivateKey: EPOCH_PRIVATE,
        agentEncryptionPublicKey: x25519PublicKey(AGENT_PRIVATE),
        binding: {
          chainId: CHAIN_ID,
          capabilityRegistry: CAPABILITY_REGISTRY,
          owner: OWNER,
          namespaceId: NAMESPACE_ID,
          readEpoch: EPOCH,
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
    chain: { deployment: DEPLOYMENT, account: AGENT_SIGNER, publicClient } as never,
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

const chainCalls = (fx: Fixture) => [...fx.calls.values()].reduce((a, b) => a + b, 0)

describe("MidaAgent.findDuplicate (in-12 N-6)", () => {
  it("the duplicate check never verifies a row whose payload does not match — 20 batched rows cost one chain read, not sixty", async () => {
    const fx = fixture()
    fx.setBatched(await Promise.all([...Array(20)].map((_, i) => batchedItem(`old checkpoint ${i}`))))
    fx.setDirect([...Array(20)].map((_, i) => directObject(`old direct ${i}`)))
    const found = await fx.agent.findDuplicate(OWNER, NAMESPACE, () => false, { batched: true })
    expect(found).toBeUndefined()
    // the only chain call is the agent record the shared epoch-key resolver needs once
    expect(chainCalls(fx)).toBe(1)
    expect(fx.calls.get("agentIdOfSigner")).toBeUndefined()
    expect(fx.calls.get("batchOf")).toBeUndefined()
    expect(fx.calls.get("headCommitOf")).toBeUndefined()
    expect(fx.calls.get("hasAuthority")).toBeUndefined()
    expect(fx.calls.get("getRecord")).toBeUndefined()
  })

  it("a pending batched row carrying the same eventId is verified, then answered as the duplicate", async () => {
    const fx = fixture()
    const dupe = await batchedItem("the same checkpoint")
    fx.setBatched([await batchedItem("other"), dupe, await batchedItem("other2")])
    const found = await fx.agent.findDuplicate(OWNER, NAMESPACE, (value) => value === "the same checkpoint", { batched: true })
    expect(found).toBe(dupe.contextId)
    // signature recovery + authority: only the candidate's reads ran
    expect(fx.calls.get("agentIdOfSigner")).toBe(1)
    expect(fx.calls.get("hasAuthority")).toBe(1)
  })

  it("a matching payload the chain never anchored is not a duplicate — the check keeps looking", async () => {
    const fx = fixture()
    // real sealed bytes whose contextId has no on-chain record — the store replaying a pending
    // save's bytes cannot suppress this save
    const unanchored = directObject("the same checkpoint")
    fx.setDirect([unanchored])
    fx.records.delete(unanchored.contextId)
    const found = await fx.agent.findDuplicate(OWNER, NAMESPACE, () => true, { batched: false })
    expect(found).toBeUndefined()
  })

  it("an anchored direct object carrying the same eventId answers with its contextId", async () => {
    const fx = fixture()
    const dupe = directObject("the same checkpoint")
    fx.setDirect([directObject("other"), dupe])
    const found = await fx.agent.findDuplicate(OWNER, NAMESPACE, (value) => value === "the same checkpoint", { batched: false })
    expect(found).toBe(dupe.contextId)
    expect(fx.calls.get("getRecord")).toBeGreaterThan(0)
  })

  it("a batched row that will not open is skipped without a single chain read for it", async () => {
    const fx = fixture()
    const broken = await batchedItem("unreadable")
    broken.save = { ...broken.save, ciphertext: `0x${"ff".repeat(32)}` as Hex }
    fx.setBatched([broken])
    const found = await fx.agent.findDuplicate(OWNER, NAMESPACE, () => true, { batched: true })
    expect(found).toBeUndefined()
    expect(chainCalls(fx)).toBe(1) // still just the shared agent record
  })

  it("a candidate whose signature does not verify is a store lie, not a duplicate", async () => {
    const fx = fixture()
    const liar = await batchedItem("the same checkpoint")
    liar.save = { ...liar.save, signature: `0x${"00".repeat(65)}` as Hex }
    fx.setBatched([liar])
    const found = await fx.agent.findDuplicate(OWNER, NAMESPACE, (value) => value === "the same checkpoint", { batched: true })
    expect(found).toBeUndefined()
  })
})
