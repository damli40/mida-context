// M3-A3 item 2: one request must never need more outgoing calls than the platform allows.
// Every chain read is one Cloudflare subrequest; MAX_CHAIN_READS_PER_REQUEST = 30 is enforced by a
// per-request counting wrapper whose exhaustion is a typed error mapped to 503 + Retry-After —
// never the platform's 500. GET /objects examines unmarked rows only inside the budget left after
// authorization and reports x-mida-partial when rows were left; the client retries and tells the
// caller when the list stayed incomplete.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { zeroHash } from "viem"
import { OWNER_AUTHOR_ID, contextId as deriveContextId, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf, manifestHash } from "@mida/crypto"
import { contentHash } from "@mida/storage"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Deployment } from "@mida/chain"
import { BudgetedReader, ChainReadBudgetExceeded, ContextApiClient, MAX_CHAIN_READS_PER_REQUEST, createContextApi } from "@mida/api"
import type { AnchoredObject, ContextRecordView, ObjectUploadBody, RegistryReader, StoreLimits, StoredObject } from "@mida/api"

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}
const NOW = 1_800_000_000n
const NAMESPACE = namespaceId("goals.career")
const account = privateKeyToAccount(generatePrivateKey())
const owner = account.address.toLowerCase() as Address

/** A chain stub that lets an owner-signed request reach storage; getRecord calls are counted. */
function stubReader(records: Map<Hex, ContextRecordView> = new Map(), calls?: Hex[]): RegistryReader {
  return {
    now: async () => NOW,
    requiredReadEpoch: async () => 1n,
    isWriteEpochValid: async () => true,
    getRecord: async (id: Hex) => {
      calls?.push(id)
      return records.get(id.toLowerCase() as Hex) ?? null
    },
    getAgent: async () => null,
  } as unknown as RegistryReader
}

function apiFor(reader: RegistryReader, limits?: Partial<StoreLimits>) {
  return createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-budget-")), clock: () => NOW, limits })
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function clientFor(app: ReturnType<typeof createContextApi>["app"], fetch?: FetchLike) {
  return new ContextApiClient({
    baseUrl: "http://mida.test",
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    clock: () => NOW,
    fetch: fetch ?? (async (url, init) => app.request(url, init)),
  })
}

function upload(ciphertext: Uint8Array): ObjectUploadBody {
  const objectNonce = hexOf(randomBytes(32))
  const contextId = deriveContextId({
    chainId: deployment.chainId,
    contextRegistry: deployment.contextRegistry,
    owner,
    authorId: OWNER_AUTHOR_ID,
    namespaceId: NAMESPACE,
    objectNonce,
  })
  return {
    owner,
    namespaceId: NAMESPACE,
    objectNonce,
    expectedParentId: zeroHash,
    manifest: {
      v: 1,
      contextId,
      ciphertextHash: contentHash(ciphertext),
      ciphertextSize: ciphertext.length,
      payloadNonce: hexOf(randomBytes(24)),
      cryptoVersion: "mida-crypto-v1",
      readEpoch: "1",
      epochDekWrap: {
        v: 1,
        contextId,
        namespaceId: NAMESPACE,
        readEpoch: "1",
        ephemeralPublicKey: hexOf(randomBytes(32)),
        nonce: hexOf(randomBytes(24)),
        wrappedDek: hexOf(randomBytes(48)),
      },
    },
    ciphertext: hexOf(ciphertext),
  }
}

function anchoredRecord(object: ObjectUploadBody): ContextRecordView {
  return {
    contextId: object.manifest.contextId,
    owner,
    author: OWNER_AUTHOR_ID,
    namespaceId: NAMESPACE,
    lineageId: object.manifest.contextId,
    parentId: zeroHash,
    manifestHash: manifestHash(object.manifest),
    ciphertextCommitment: object.manifest.ciphertextHash,
    evidenceCommitment: zeroHash,
    readEpoch: 1n,
    createdAt: 1n,
    expiresAt: 0n,
    version: 1,
    recordType: 1,
    lineagePolicy: 0,
    kind: 1,
    provenanceSource: 1,
  }
}

/** The stored metadata an accepted upload leaves behind — for seeding object rows directly. */
function storedObject(body: ObjectUploadBody): StoredObject {
  return {
    contextId: body.manifest.contextId,
    owner,
    uploader: owner,
    namespaceId: NAMESPACE,
    authorId: OWNER_AUTHOR_ID,
    objectNonce: body.objectNonce,
    expectedParentId: body.expectedParentId,
    manifest: body.manifest,
    manifestHash: manifestHash(body.manifest),
    uploadedAt: new Date().toISOString(),
    anchoredAt: null,
  }
}

describe("the per-request chain-read budget", () => {
  it("counts every read and throws a typed error on the read past the budget", async () => {
    const calls: Hex[] = []
    const reader = new BudgetedReader(stubReader(new Map(), calls))
    expect(reader.spent).toBe(0)
    expect(reader.remaining).toBe(MAX_CHAIN_READS_PER_REQUEST)
    for (let i = 0; i < MAX_CHAIN_READS_PER_REQUEST; i++) {
      await reader.getRecord(hexOf(randomBytes(32)))
    }
    expect(calls).toHaveLength(30)
    expect(reader.spent).toBe(30)
    expect(reader.remaining).toBe(0)
    // The 31st read never reaches the chain: it throws instead of running.
    await expect(reader.getRecord(hexOf(randomBytes(32)))).rejects.toBeInstanceOf(ChainReadBudgetExceeded)
    expect(calls).toHaveLength(30)
  })

  it("a PUT that would need 41 chain reads is refused 503 with Retry-After and zero partial writes", async () => {
    const calls: Hex[] = []
    const { app, store } = apiFor(stubReader(new Map(), calls), { maxPendingBytesPerSigner: 100 })
    // 41 unmarked uploads the chain has not anchored: fully re-checking them needs 41 reads —
    // beyond the request budget. The upload must be refused as retryable, never scanned unbounded.
    for (let i = 0; i < 41; i++) {
      await store.putObject(storedObject(upload(randomBytes(4))))
    }
    let last: Response | undefined
    const client = clientFor(app, async (url, init) => (last = await app.request(url, init)))
    const body = upload(randomBytes(4))
    await expect(client.putObject(body)).rejects.toThrowError(/503/)
    expect(last!.status).toBe(503)
    expect(last!.headers.get("retry-after")).toBe("5")
    // Zero partial writes: no object row, no ciphertext blob.
    expect(await store.getObject(body.manifest.contextId)).toBeUndefined()
    await expect(store.blobs.get(body.manifest.ciphertextHash)).rejects.toMatchObject({ code: "NOT_FOUND" })
    // The scan stopped at its cap — it did not run 41 reads.
    expect(calls.length).toBeLessThanOrEqual(MAX_CHAIN_READS_PER_REQUEST)
  })

  it("GET /objects examines unmarked rows only within the remaining budget and marks x-mida-partial", async () => {
    const records = new Map<Hex, ContextRecordView>()
    const { app, store } = apiFor(stubReader(records))
    // 60 stored rows, every one anchored on chain but unmarked locally: each costs one read.
    for (let i = 0; i < 60; i++) {
      const ciphertext = randomBytes(4)
      const body = upload(ciphertext)
      await store.putObject(storedObject(body))
      await store.blobs.put(ciphertext)
      records.set(body.manifest.contextId, anchoredRecord(body))
    }
    const responses: Response[] = []
    const client = clientFor(app, async (url, init) => {
      const response = await app.request(url, init)
      responses.push(response)
      return response
    })
    const path = `/objects?owner=${owner}&namespaceId=${NAMESPACE}`

    // Owner-signed: authorization costs nothing, so the whole 30-read budget goes to the scan —
    // 30 rows verified, 30 left unexamined, the response says so.
    const first = await client.request<{ objects: AnchoredObject[] }>("GET", path)
    expect(responses[0]!.headers.get("x-mida-partial")).toBe("true")
    expect(first.objects).toHaveLength(30)

    // The verified 30 were marked: the retry spends its budget on the remaining 30 and completes.
    const second = await client.request<{ objects: AnchoredObject[] }>("GET", path)
    expect(responses[1]!.headers.get("x-mida-partial")).toBeNull()
    expect(second.objects).toHaveLength(60)
  })

  it("listObjects retries while partial, accumulates without duplicates, and flags an incomplete list", async () => {
    const objects = (count: number): AnchoredObject[] =>
      Array.from({ length: count }, () => ({
        contextId: hexOf(randomBytes(32)),
        owner,
        namespaceId: NAMESPACE,
        authorId: OWNER_AUTHOR_ID,
        manifest: upload(randomBytes(4)).manifest,
        manifestHash: hexOf(randomBytes(32)),
        ciphertext: hexOf(randomBytes(4)),
      }))
    const all = objects(60)
    const calls: string[] = []
    // A fetch that pages the list: first call returns 30 objects marked partial, the second the
    // other 30 without the header.
    const pages: Array<{ objects: AnchoredObject[]; partial: boolean }> = [
      { objects: all.slice(0, 30), partial: true },
      { objects: all.slice(30), partial: false },
    ]
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url) => {
        const page = pages[Math.min(calls.length, pages.length - 1)]!
        calls.push(url)
        return new Response(JSON.stringify({ objects: page.objects }), {
          status: 200,
          headers: page.partial ? { "x-mida-partial": "true" } : {},
        })
      },
    })
    const listed = await client.listObjects({ owner, namespaceId: NAMESPACE })
    expect(calls).toHaveLength(2)
    expect(listed.objects).toHaveLength(60)
    expect(new Set(listed.objects.map((object) => object.contextId)).size).toBe(60)
    expect(listed.partial).toBe(false)

    // Still partial after the initial call plus three retries: the caller gets what accumulated
    // WITH the flag — an honest { objects, partial } shape, never an array that looks complete.
    const alwaysPartial = new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async () =>
        new Response(JSON.stringify({ objects: objects(5) }), {
          status: 200,
          headers: { "x-mida-partial": "true" },
        }),
    })
    const incomplete = await alwaysPartial.listObjects({ owner, namespaceId: NAMESPACE })
    expect(incomplete.partial).toBe(true)
    expect(incomplete.objects).toHaveLength(20) // 5 new objects per call × 4 calls
    // the flag is a first-class field — it cannot hide as a non-enumerable property anymore
    expect(JSON.parse(JSON.stringify(incomplete))).toEqual({ objects: expect.any(Array), partial: true })
  })
})
