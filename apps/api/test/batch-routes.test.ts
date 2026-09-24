// BatchAnchor Task 5: the /batch/* surface end to end through the real app — real Hono app, real
// x-mida request signing, real file stores; only the chain reader and the batcher are faked. The
// rules under test: an admitted save is QUEUED with a signed receipt; signature, agent registration,
// shape and commitments are all checked before admission; reads reuse GET /objects' authorization;
// REJECTED rows answer status but never list; flush is agent/owner-only, empty-skipped, and
// rate-limited to once per 10 s per signer (Amendment B.4).

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeAbiParameters, keccak256, recoverMessageAddress, zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { CONTEXT_KIND, PERMISSION, PROVENANCE_SOURCE, batchContextId, batchSaveTypedData, namespaceId } from "@mida/protocol"
import type { Address, AgentRecord, BatchSaveMessage, ContextPayload, Hex } from "@mida/protocol"
import { hexOf, sealContextObject } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, FsBatchStore, createContextApi } from "@mida/api"
import type { BatchSaveRow, BatchedSaveWire, BatchStore, CapabilityView, RegistryReader } from "@mida/api"

const NOW_SECONDS = 1_800_000_000n
const T0 = 1_800_000_000_000 // ms
const BATCH_ANCHOR = "0x1111111111111111111111111111111111111aa5" as Address
const NAMESPACE = namespaceId("goals.career")

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  batchAnchor: BATCH_ANCHOR,
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}

const ownerAccount = privateKeyToAccount(generatePrivateKey())
const OWNER = ownerAccount.address.toLowerCase() as Address
const agentAccount = privateKeyToAccount(generatePrivateKey())
const readerAccount = privateKeyToAccount(generatePrivateKey())
const strangerAccount = privateKeyToAccount(generatePrivateKey())
const receiptAccount = privateKeyToAccount(generatePrivateKey())
const AGENT_ID = hexOf(randomBytes(32))
const READER_ID = hexOf(randomBytes(32))
const READ_CAP = hexOf(randomBytes(32))

const agentRecord = (agentId: Hex, signer: Address): AgentRecord => ({
  agentId,
  operator: OWNER,
  signer,
  encryptionPublicKey: hexOf(randomBytes(32)),
  encryptionKeyVersion: 1,
  callbackOriginHash: hexOf(randomBytes(32)),
  capabilityManifestHash: hexOf(randomBytes(32)),
  capabilityManifestVersion: 1,
  active: true,
})

const readCapability: CapabilityView = {
  owner: OWNER,
  agentId: READER_ID,
  namespaceId: NAMESPACE,
  permissions: PERMISSION.READ,
  provenancePolicy: 0,
  issuedAt: 0n,
  expiresAt: 0n,
  agentEpoch: 0n,
  grantedAtReadEpoch: 0n,
  revoked: false,
}

/** The reader Monad would be: agent/reader signers are registered agents; the owner has a P256 key. */
const reader = {
  agentIdOfSigner: async (signer: Address) => {
    const s = signer.toLowerCase()
    if (s === agentAccount.address.toLowerCase()) return AGENT_ID
    if (s === readerAccount.address.toLowerCase()) return READER_ID
    return null
  },
  getAgent: async (id: Hex) =>
    id === AGENT_ID ? agentRecord(AGENT_ID, agentAccount.address) : id === READER_ID ? agentRecord(READER_ID, readerAccount.address) : null,
  getCapability: async (id: Hex) => (id === READ_CAP ? readCapability : null),
  agentEpoch: async () => 0n,
  now: async () => NOW_SECONDS,
  hasAuthority: async () => true,
  ownerP256Key: async (owner: Address) => (owner.toLowerCase() === OWNER ? { qx: 1n, qy: 2n } : null),
} as unknown as RegistryReader

interface ApiFixture {
  app: ReturnType<typeof createContextApi>["app"]
  objectStore: ReturnType<typeof createContextApi>["store"]
  store: BatchStore
  counts: { notified: number; flushed: number }
  nowMs: () => number
  advance: (ms: number) => void
}

const makeApi = (input: {
  enabled?: boolean
  hasAuthority?: (owner: Address, agentId: Hex, namespace: Hex, permission: number, policy: number) => boolean
  ownerAllowlist?: readonly Address[]
} = {}): ApiFixture => {
  const dataDir = mkdtempSync(join(tmpdir(), "mida-batch-routes-"))
  const store = new FsBatchStore(dataDir)
  let nowMs = T0
  const counts = { notified: 0, flushed: 0 }
  const testReader =
    input.hasAuthority === undefined
      ? reader
      : ({ ...reader, hasAuthority: async (owner: Address, agentId: Hex, namespace: Hex, permission: number, policy: number) => input.hasAuthority!(owner, agentId, namespace, permission, policy) } as unknown as RegistryReader)
  const { app, store: objectStore } = createContextApi({
    reader: testReader,
    deployment,
    dataDir,
    clock: () => NOW_SECONDS,
    batching: {
      enabled: input.enabled ?? true,
      batchAnchor: BATCH_ANCHOR,
      store,
      receiptAccount,
      ...(input.ownerAllowlist === undefined ? {} : { ownerAllowlist: input.ownerAllowlist }),
      notify: () => {
        counts.notified++
      },
      flush: async () => {
        counts.flushed++
      },
      now: () => nowMs,
    },
  })
  return { app, objectStore, store, counts, nowMs: () => nowMs, advance: (ms) => (nowMs += ms) }
}

const clientFor = (app: ApiFixture["app"], account: LocalAccount) =>
  new ContextApiClient({
    baseUrl: "http://mida.test",
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    clock: () => NOW_SECONDS,
    fetch: async (url, init) => app.request(url, init),
  })

/** A client that records the raw response of its last request — non-MidaError codes (BATCHING_DISABLED etc.) don't survive the client's error mapping. */
const watchingClient = (app: ApiFixture["app"], account: LocalAccount) => {
  const seen: { status: number; body: unknown }[] = []
  const client = new ContextApiClient({
    baseUrl: "http://mida.test",
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    clock: () => NOW_SECONDS,
    fetch: async (url, init) => {
      const response = await app.request(url, init)
      const text = await response.clone().text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // a non-JSON error body (e.g. Hono's plain 404) is still worth recording
      }
      seen.push({ status: response.status, body })
      return response
    },
  })
  return { client, seen }
}

/** Seals and signs one valid batched save; `message` overrides mutate the signed fields. */
const makeSave = async (
  signer: LocalAccount,
  agentId: Hex,
  overrides: Partial<BatchSaveMessage> = {},
): Promise<{ wire: BatchedSaveWire; contextId: Hex; message: BatchSaveMessage }> => {
  const message: BatchSaveMessage = {
    owner: OWNER,
    namespaceId: NAMESPACE,
    objectNonce: hexOf(randomBytes(32)),
    lineageId: zeroHash,
    parentId: zeroHash,
    parentVersion: 0,
    rootAuthor: zeroHash,
    manifestHash: zeroHash,
    ciphertextCommitment: zeroHash,
    readEpoch: 1n,
    expiresAt: 0n,
    kind: CONTEXT_KIND.EPISODE,
    provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
    ...overrides,
  }
  const contextId = batchContextId({
    chainId: deployment.chainId,
    batchAnchor: BATCH_ANCHOR,
    owner: message.owner,
    agentId,
    namespaceId: message.namespaceId,
    parentId: message.parentId,
    objectNonce: message.objectNonce,
  })
  const payload: ContextPayload = { v: 1, value: "checkpoint body", kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } }
  const sealed = sealContextObject({
    payload,
    binding: {
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      contextId,
      namespaceId: message.namespaceId,
      readEpoch: message.readEpoch,
    },
    epochPublicKey: randomBytes(32),
  })
  message.manifestHash = sealed.manifestHash
  message.ciphertextCommitment = sealed.ciphertextCommitment
  const signature = await signer.signTypedData(batchSaveTypedData({ chainId: deployment.chainId, batchAnchor: BATCH_ANCHOR, message }) as never)
  return {
    wire: {
      message: { ...message, readEpoch: message.readEpoch.toString(10), expiresAt: message.expiresAt.toString(10) },
      signature,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
    },
    contextId,
    message,
  }
}

const receiptDigest = (contextId: Hex, receivedAt: number, sequence: bigint) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      ["MIDA_BATCH_RECEIPT_V1", contextId, BigInt(receivedAt), sequence],
    ),
  )

describe("the /batch/* surface", () => {
  it("with no batching option at all there is no batch surface — status 404s", async () => {
    const { app } = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-nobatch-")), clock: () => NOW_SECONDS })
    const { client, seen } = watchingClient(app, ownerAccount)
    await expect(client.batchStatus()).rejects.toThrowError()
    expect(seen.at(-1)!.status).toBe(404)
  })

  it("POST /batch/saves admits a signed save: 201 QUEUED, a receipt signed by the receipt key, one notify", async () => {
    const fixture = makeApi()
    const client = clientFor(fixture.app, agentAccount)
    const save = await makeSave(agentAccount, AGENT_ID)

    const posted = await client.postBatchSave(save.wire)
    expect(posted.state).toBe("QUEUED")
    expect(posted.receipt).toMatchObject({ contextId: save.contextId, receivedAt: T0, sequence: "1" })
    const digest = receiptDigest(save.contextId, T0, 1n)
    expect(await recoverMessageAddress({ message: { raw: digest }, signature: posted.receipt.signature })).toBe(receiptAccount.address)
    expect(fixture.counts.notified).toBe(1)

    // The row carries everything — ciphertext included (Amendment A.4) — and never touches `objects`.
    const row = await fixture.store.get(save.contextId)
    expect(row).toMatchObject({ contextId: save.contextId, owner: OWNER, signer: agentAccount.address.toLowerCase(), state: "QUEUED" })
    expect(row!.save.ciphertext).toBe(save.wire.ciphertext)
    expect(await fixture.objectStore.getObject(save.contextId)).toBeUndefined()
  })

  it("a repeat POST of the same save is 409 ALREADY_QUEUED and does not notify again", async () => {
    const fixture = makeApi()
    const { client, seen } = watchingClient(fixture.app, agentAccount)
    const save = await makeSave(agentAccount, AGENT_ID)
    await client.postBatchSave(save.wire)
    await expect(client.postBatchSave(save.wire)).rejects.toThrowError()
    expect(seen.at(-1)).toMatchObject({ status: 409, body: { error: { code: "ALREADY_QUEUED" } } })
    expect(fixture.counts.notified).toBe(1)
  })

  it("rejects with the right codes: SIGNER_MISMATCH, NOT_AN_AGENT, COMMITMENT_MISMATCH, BAD_SHAPE, TOO_LARGE, INVALID_WIRE", async () => {
    const fixture = makeApi()
    const agent = watchingClient(fixture.app, agentAccount)
    const reader = watchingClient(fixture.app, readerAccount)
    const stranger = watchingClient(fixture.app, strangerAccount)

    // Signed by the agent, submitted under the reader's request signature.
    const mismatched = await makeSave(agentAccount, AGENT_ID)
    await expect(reader.client.postBatchSave(mismatched.wire)).rejects.toThrowError()
    expect(reader.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "SIGNER_MISMATCH" } } })

    // Signed by a key the registry does not know.
    const unregistered = await makeSave(strangerAccount, hexOf(randomBytes(32)))
    await expect(stranger.client.postBatchSave(unregistered.wire)).rejects.toThrowError()
    expect(stranger.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "NOT_AN_AGENT" } } })

    // Bytes that don't match the signed ciphertextCommitment (the signature still verifies — it
    // covers the commitment, not the bytes).
    const tampered = await makeSave(agentAccount, AGENT_ID)
    tampered.wire.ciphertext = (tampered.wire.ciphertext.endsWith("00")
      ? `${tampered.wire.ciphertext.slice(0, -2)}01`
      : `${tampered.wire.ciphertext.slice(0, -2)}00`) as Hex
    await expect(agent.client.postBatchSave(tampered.wire)).rejects.toThrowError()
    expect(agent.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "COMMITMENT_MISMATCH" } } })

    // kind 0 is never a checkpoint save.
    const badShape = await makeSave(agentAccount, AGENT_ID, { kind: 0 })
    await expect(agent.client.postBatchSave(badShape.wire)).rejects.toThrowError()
    expect(agent.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "BAD_SHAPE" } } })

    // A manifest committing to a different contextId than the signed save derives.
    const wrongId = await makeSave(agentAccount, AGENT_ID)
    wrongId.wire.manifest.contextId = hexOf(randomBytes(32))
    await expect(agent.client.postBatchSave(wrongId.wire)).rejects.toThrowError()
    expect(agent.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "COMMITMENT_MISMATCH" } } })

    // Over the shared ciphertext cap.
    const tooLarge = await makeSave(agentAccount, AGENT_ID)
    tooLarge.wire.ciphertext = `0x${"aa".repeat(262_145)}`
    await expect(agent.client.postBatchSave(tooLarge.wire)).rejects.toThrowError()
    expect(agent.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "TOO_LARGE" } } })

    // A malformed body never reaches signature checks.
    const malformed = await makeSave(agentAccount, AGENT_ID)
    const broken = { ...malformed.wire, message: { ...malformed.wire.message, kind: "one" } }
    await expect(agent.client.postBatchSave(broken as unknown as BatchedSaveWire)).rejects.toThrowError()
    expect(agent.seen.at(-1)).toMatchObject({ status: 400, body: { error: { code: "INVALID_WIRE" } } })
    expect(fixture.counts.notified).toBe(0)
  })

  it("an agent whose live grant is gone is refused CAPABILITY_DENIED before anything queues — the check mirrors the contract's choice", async () => {
    // Task 6: anyone can register an agent, so admission re-checks the signer's authority the same
    // way submitBatch will — a save that could only be rejected on chain never occupies the queue.
    const calls: number[] = []
    const fixture = makeApi({
      hasAuthority: (_owner, _agentId, _namespace, permission) => {
        calls.push(permission)
        return false
      },
    })
    const { client, seen } = watchingClient(fixture.app, agentAccount)

    // A fresh lineage asks for CREATE exactly once — the contract's first check.
    const fresh = await makeSave(agentAccount, AGENT_ID)
    await expect(client.postBatchSave(fresh.wire)).rejects.toThrowError()
    expect(seen.at(-1)).toMatchObject({ status: 403, body: { error: { code: "CAPABILITY_DENIED" } } })
    expect(calls).toEqual([PERMISSION.CREATE])
    expect(await fixture.store.get(fresh.contextId)).toBeNull()

    // A replacement by an agent that did not author the root asks for SUPERSEDE_ANY.
    calls.length = 0
    const replacement = await makeSave(agentAccount, AGENT_ID, { lineageId: hexOf(randomBytes(32)), parentId: hexOf(randomBytes(32)), parentVersion: 1, rootAuthor: hexOf(randomBytes(32)) })
    await expect(client.postBatchSave(replacement.wire)).rejects.toThrowError()
    expect(calls).toEqual([PERMISSION.SUPERSEDE_ANY])
    expect(await fixture.store.get(replacement.contextId)).toBeNull()
    expect(fixture.counts.notified).toBe(0)
  })

  it("an owner allowlist admits only listed owners — unlisted get a plain 403 and nothing queues", async () => {
    const fixture = makeApi({ ownerAllowlist: [OWNER] })
    const { client, seen } = watchingClient(fixture.app, agentAccount)

    // A save for the listed owner flows through exactly as before.
    const admitted = await makeSave(agentAccount, AGENT_ID)
    expect((await client.postBatchSave(admitted.wire)).state).toBe("QUEUED")

    // A save naming any other owner refuses before crypto, chain reads or a row — with the plain line.
    const other = await makeSave(agentAccount, AGENT_ID, { owner: `0x${"77".repeat(20)}` as Address })
    await expect(client.postBatchSave(other.wire)).rejects.toThrowError()
    expect(seen.at(-1)).toMatchObject({ status: 403, body: { error: { code: "OWNER_NOT_ALLOWED" } } })
    expect(JSON.stringify(seen.at(-1)!.body)).toContain("not open to owner")
    expect(await fixture.store.get(other.contextId)).toBeNull()
    expect(fixture.counts.notified).toBe(1) // only the admitted save ever woke the batcher
  })

  it("the allowlist matches case-insensitively, and an empty list is no gate at all", async () => {
    // A checksummed-cased entry still matches the wire's lowercase owner field.
    const mixed = makeApi({ ownerAllowlist: [`0x${"AA".repeat(20)}` as Address] })
    const mixedClient = clientFor(mixed.app, agentAccount)
    const lowerOwner = await makeSave(agentAccount, AGENT_ID, { owner: `0x${"aa".repeat(20)}` as Address })
    expect((await mixedClient.postBatchSave(lowerOwner.wire)).state).toBe("QUEUED")

    const open = makeApi({ ownerAllowlist: [] })
    const openClient = clientFor(open.app, agentAccount)
    const anyone = await makeSave(agentAccount, AGENT_ID, { owner: `0x${"78".repeat(20)}` as Address })
    expect((await openClient.postBatchSave(anyone.wire)).state).toBe("QUEUED")
  })

  it("POSTs answer 503 BATCHING_DISABLED while the kill switch is off, and status says so", async () => {
    const fixture = makeApi({ enabled: false })
    const { client, seen } = watchingClient(fixture.app, agentAccount)
    expect(await client.batchStatus()).toEqual({ enabled: false, batchAnchor: BATCH_ANCHOR })
    const save = await makeSave(agentAccount, AGENT_ID)
    await expect(client.postBatchSave(save.wire)).rejects.toThrowError()
    expect(seen.at(-1)).toMatchObject({ status: 503, body: { error: { code: "BATCHING_DISABLED" } } })
    await expect(client.flushBatch()).rejects.toThrowError()
    expect(seen.at(-1)).toMatchObject({ status: 503, body: { error: { code: "BATCHING_DISABLED" } } })
    expect(fixture.counts.flushed).toBe(0)
  })

  it("GET /batch/saves lists QUEUED, SUBMITTED and ANCHORED rows — never REJECTED — under objects' auth", async () => {
    const fixture = makeApi()
    const agent = clientFor(fixture.app, agentAccount)
    const owner = clientFor(fixture.app, ownerAccount)
    const batchId = hexOf(randomBytes(32))

    const first = await makeSave(agentAccount, AGENT_ID)
    const second = await makeSave(agentAccount, AGENT_ID)
    const third = await makeSave(agentAccount, AGENT_ID)
    const fourth = await makeSave(agentAccount, AGENT_ID)
    // A millisecond between posts gives each row a distinct receivedAt → deterministic FIFO order.
    await agent.postBatchSave(first.wire)
    fixture.advance(1)
    await agent.postBatchSave(second.wire)
    fixture.advance(1)
    await agent.postBatchSave(third.wire)
    fixture.advance(1)
    await agent.postBatchSave(fourth.wire)

    await fixture.store.markAnchored(first.contextId, {
      batchId,
      position: 0,
      lineageId: first.contextId,
      version: 1,
      proof: [hexOf(randomBytes(32))],
      anchoredAt: T0 + 5_000,
    })
    const taken = await fixture.store.takeQueued(2, hexOf(randomBytes(32)))
    expect(taken.map((row) => row.contextId)).toEqual([second.contextId, third.contextId])
    await fixture.store.markRejected(third.contextId, "STALE_PARENT")

    const { items, partial } = await owner.listBatchSaves({ owner: OWNER, namespaceId: NAMESPACE })
    expect(partial).toBe(false)
    expect(items.map((item) => item.contextId)).toEqual([first.contextId, second.contextId, fourth.contextId])
    expect(items[0]).toMatchObject({
      state: "ANCHORED",
      batchId,
      position: 0,
      lineageId: first.contextId,
      version: 1,
      receivedAt: T0,
    })
    expect(items[0]!.proof).toHaveLength(1)
    expect(items[1]).toMatchObject({ state: "SUBMITTED" })
    expect(items[2]).toMatchObject({ state: "QUEUED" })

    // A stranger cannot list; an agent holding READ on the area can.
    const stranger = watchingClient(fixture.app, strangerAccount)
    await expect(stranger.client.listBatchSaves({ owner: OWNER, namespaceId: NAMESPACE })).rejects.toThrowError()
    expect(stranger.seen.at(-1)).toMatchObject({ status: 403, body: { error: { code: "CAPABILITY_DENIED" } } })
    const authorized = clientFor(fixture.app, readerAccount)
    const listed = await authorized.request<{ items: { contextId: Hex }[] }>(
      "GET",
      `/batch/saves?owner=${OWNER}&namespaceId=${NAMESPACE}&capabilityId=${READ_CAP}`,
    )
    expect(listed.items).toHaveLength(3)
  })

  it("GET /batch/saves/:contextId serves state+item to owner and uploader, and the REJECTED reason; strangers get 403", async () => {
    const fixture = makeApi()
    const agent = clientFor(fixture.app, agentAccount)
    const owner = clientFor(fixture.app, ownerAccount)
    const stranger = watchingClient(fixture.app, strangerAccount)
    const save = await makeSave(agentAccount, AGENT_ID)
    const dead = await makeSave(agentAccount, AGENT_ID)
    await agent.postBatchSave(save.wire)
    await agent.postBatchSave(dead.wire)

    // Uploader (no READ grant needed) and owner both read the pending row.
    for (const who of [agent, owner]) {
      const got = await who.getBatchSave(save.contextId)
      expect(got.state).toBe("QUEUED")
      expect(got.reason).toBeNull()
      expect(got.item).toMatchObject({ state: "QUEUED", contextId: save.contextId, receivedAt: T0 })
      expect(got.item!.save).toEqual(save.wire)
    }

    await fixture.store.markRejected(dead.contextId, "BAD_EPOCH")
    const rejected = await owner.getBatchSave(dead.contextId)
    expect(rejected).toMatchObject({ state: "REJECTED", reason: "BAD_EPOCH" })
    expect(rejected.item).toBeUndefined()

    await expect(stranger.client.getBatchSave(save.contextId)).rejects.toThrowError()
    expect(stranger.seen.at(-1)).toMatchObject({ status: 403, body: { error: { code: "CAPABILITY_DENIED" } } })
    await expect(owner.getBatchSave(hexOf(randomBytes(32)))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("POST /batch/flush: empty skips, a queued save flushes once, a second call inside 10 s is rate-limited", async () => {
    const fixture = makeApi()
    const agent = clientFor(fixture.app, agentAccount)
    const owner = clientFor(fixture.app, ownerAccount)
    const stranger = watchingClient(fixture.app, strangerAccount)

    // Empty queue: authenticated agent is told plainly, the batcher is not woken.
    expect(await agent.flushBatch()).toEqual({ flushed: false, reason: "empty" })
    expect(fixture.counts.flushed).toBe(0)

    const save = await makeSave(agentAccount, AGENT_ID)
    await agent.postBatchSave(save.wire)

    // A stranger may not flush even with work queued — the queue depth is not theirs to learn.
    await expect(stranger.client.flushBatch()).rejects.toThrowError()
    expect(stranger.seen.at(-1)).toMatchObject({ status: 403, body: { error: { code: "CAPABILITY_DENIED" } } })

    expect(await agent.flushBatch()).toEqual({ flushed: true })
    expect(fixture.counts.flushed).toBe(1)
    // Inside the window the same signer is refused; another signer (the owner key) is not limited by it.
    expect(await agent.flushBatch()).toEqual({ flushed: false, reason: "rate-limited" })
    expect(await owner.flushBatch()).toEqual({ flushed: true })
    expect(fixture.counts.flushed).toBe(2)
    // The spy batcher never drains; once the queue is empty the answer is "empty" even past the window.
    fixture.advance(10_000)
    await fixture.store.takeQueued(10, hexOf(randomBytes(32)))
    expect(await agent.flushBatch()).toEqual({ flushed: false, reason: "empty" })
    // And past the window with real work queued, the same signer flushes again.
    const later = await makeSave(agentAccount, AGENT_ID)
    await agent.postBatchSave(later.wire)
    expect(await agent.flushBatch()).toEqual({ flushed: true })
    expect(fixture.counts.flushed).toBe(3)
  })
})
