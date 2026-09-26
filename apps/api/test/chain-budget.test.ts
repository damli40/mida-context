// M3-A3 item 2: one request must never need more outgoing calls than the platform allows.
// Every chain read is one Cloudflare subrequest; MAX_CHAIN_READS_PER_REQUEST = 30 is enforced by a
// per-request counting wrapper whose exhaustion is a typed error mapped to 503 + Retry-After —
// never the platform's 500. GET /objects examines unmarked rows only inside the budget left after
// authorization and reports x-mida-partial when rows were left; the client retries and tells the
// caller when the list stayed incomplete.

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, zeroHash } from "viem"
import type { PublicClient } from "viem"
import { OWNER_AUTHOR_ID, PERMISSION, contextId as deriveContextId, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf, manifestHash } from "@mida/crypto"
import { contentHash } from "@mida/storage"
import { randomBytes } from "@noble/hashes/utils.js"
import { contextRegistryAbi } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { BudgetedReader, ChainReadBudgetExceeded, ContextApiClient, MAX_CHAIN_READS_PER_REQUEST, RegistryReader, createContextApi } from "@mida/api"
import type { AnchoredObject, ContextRecordView, ObjectUploadBody, StoreLimits, StoredObject } from "@mida/api"

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
    // Rows are stamped on the app's injected clock, not the wall clock: the pending quota only
    // counts uploads inside its 24 h window, and a wall-clock row is months stale next to NOW.
    uploadedAt: new Date(Number(NOW) * 1000).toISOString(),
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
    // the wire answer is CHAIN_UNAVAILABLE now (in-6 R4) — still 503 with Retry-After on the wire
    await expect(client.putObject(body)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" })
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

  it("a batch-capable reader checks 189 unmarked rows in one read: orphans cannot make lists partial forever", async () => {
    const records = new Map<Hex, ContextRecordView>()
    const base = stubReader(records)
    const batchCalls: Hex[][] = []
    // A stand-in implementing getRecords: the app must check a whole batch per read instead of
    // one row per read.
    const reader = {
      ...base,
      getRecords: async (ids: Hex[]) => {
        batchCalls.push(ids)
        return ids.map((id) => records.get(id.toLowerCase() as Hex) ?? null)
      },
    } as RegistryReader
    const { app, store } = apiFor(reader)

    // The failing home's shape: 12 real anchored objects and 177 uploads whose anchor transaction
    // never landed — every row unmarked. Per-row, the 30-read budget could never reach the end of
    // the orphans, so the list stayed partial on every read.
    for (let i = 0; i < 12; i++) {
      const ciphertext = randomBytes(4)
      const body = upload(ciphertext)
      await store.putObject(storedObject(body))
      await store.blobs.put(ciphertext)
      records.set(body.manifest.contextId, anchoredRecord(body))
    }
    for (let i = 0; i < 177; i++) {
      await store.putObject(storedObject(upload(randomBytes(4))))
    }

    const responses: Response[] = []
    const client = clientFor(app, async (url, init) => {
      const response = await app.request(url, init)
      responses.push(response)
      return response
    })
    const listed = await client.request<{ objects: AnchoredObject[] }>("GET", `/objects?owner=${owner}&namespaceId=${NAMESPACE}`)
    expect(listed.objects).toHaveLength(12)
    expect(responses[0]!.headers.get("x-mida-partial")).toBeNull()
    // 189 unmarked rows answered inside ONE batch read — never more than one call per 200 rows.
    expect(batchCalls.length).toBeLessThanOrEqual(Math.ceil(189 / 200))
    expect(batchCalls[0]).toHaveLength(189)
  })

  it("a reader without batch support keeps the per-row behaviour: partial while the budget is short", async () => {
    const records = new Map<Hex, ContextRecordView>()
    const recordCalls: Hex[] = []
    const { app, store } = apiFor(stubReader(records, recordCalls))
    // Same data — 12 anchored + 177 orphans — but the orphans sort first, so the whole 30-read
    // budget is spent on rows that will never anchor: the fallback path must behave as before.
    const stale = new Date((Number(NOW) - 1_000) * 1000).toISOString()
    for (let i = 0; i < 177; i++) {
      const orphan = storedObject(upload(randomBytes(4)))
      orphan.uploadedAt = stale
      await store.putObject(orphan)
    }
    for (let i = 0; i < 12; i++) {
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
    const listed = await client.request<{ objects: AnchoredObject[] }>("GET", `/objects?owner=${owner}&namespaceId=${NAMESPACE}`)
    expect(responses[0]!.headers.get("x-mida-partial")).toBe("true")
    expect(listed.objects).toHaveLength(0)
    expect(recordCalls).toHaveLength(MAX_CHAIN_READS_PER_REQUEST)
  })

  it("serves an old never-read anchored object: the read path ignores upload age", async () => {
    const records = new Map<Hex, ContextRecordView>()
    const base = stubReader(records)
    const reader = {
      ...base,
      getRecords: async (ids: Hex[]) => ids.map((id) => records.get(id.toLowerCase() as Hex) ?? null),
    } as RegistryReader
    const { app, store } = apiFor(reader)
    // Uploaded three days before the app's clock and never read since. Age is a quota concern,
    // never a read concern: an unmarked row can still hold a real record, so it is checked and
    // served like any other.
    const ciphertext = randomBytes(4)
    const body = upload(ciphertext)
    const old = storedObject(body)
    old.uploadedAt = new Date((Number(NOW) - 3 * 86_400) * 1000).toISOString()
    await store.putObject(old)
    await store.blobs.put(ciphertext)
    records.set(body.manifest.contextId, anchoredRecord(body))

    const client = clientFor(app)
    const listed = await client.request<{ objects: AnchoredObject[] }>("GET", `/objects?owner=${owner}&namespaceId=${NAMESPACE}`)
    expect(listed.objects.map((object) => object.contextId)).toEqual([body.manifest.contextId])
  })
})

describe("a batched getRecords anchor check", () => {
  /** A reader whose chain reports Multicall3 (batch size 200) and answers each batch with canned entries. */
  function multicallReader(entries: unknown[]): RegistryReader {
    const publicClient = {
      getCode: async () => "0x6001",
      multicall: async () => entries,
    } as unknown as PublicClient
    return new RegistryReader({ deployment, publicClient })
  }

  /** The error chain viem stores on a failed multicall entry: execution error wrapping the revert. */
  function revertEntry(data: Hex, contextId: Hex) {
    return {
      status: "failure",
      error: new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: contextRegistryAbi, data, functionName: "getRecord" }),
        { abi: contextRegistryAbi, args: [contextId], contractAddress: deployment.contextRegistry, functionName: "getRecord" },
      ),
    }
  }

  const notFoundRevert = (contextId: Hex) =>
    encodeErrorResult({ abi: contextRegistryAbi, errorName: "ContextNotFound", args: [contextId] })

  it("maps a success to its record and a ContextNotFound revert to null — the one failure that means absent", async () => {
    const record = anchoredRecord(upload(randomBytes(4)))
    const missing = `0x${"33".repeat(32)}` as Hex
    const reader = multicallReader([
      { status: "success", result: record },
      revertEntry(notFoundRevert(missing), missing),
    ])
    const [hit, absent] = await reader.getRecords([record.contextId, missing])
    expect(hit).toMatchObject({ contextId: record.contextId, owner })
    expect(absent).toBeNull()
  })

  it("throws on any other failed entry — a different known revert, an unknown selector, an empty out-of-gas", async () => {
    const contextId = `0x${"44".repeat(32)}` as Hex
    // A revert the registry knows but which does NOT mean "not anchored" maps to its own code.
    const stale = multicallReader([
      revertEntry(encodeErrorResult({ abi: contextRegistryAbi, errorName: "EpochStale", args: [NAMESPACE, 1n, 2n] }), contextId),
    ])
    await expect(stale.getRecords([contextId])).rejects.toMatchObject({ code: "EPOCH_STALE" })
    // An undecodable selector and a bare empty revert (the out-of-gas shape) surface the raw error.
    for (const data of ["0xdeadbeef", "0x"] as Hex[]) {
      const reader = multicallReader([revertEntry(data, contextId)])
      await expect(reader.getRecords([contextId])).rejects.toBeInstanceOf(ContractFunctionExecutionError)
    }
  })

  it("GET /objects errors instead of answering 200 with a list that silently dropped real records", async () => {
    const reader = multicallReader([revertEntry("0x", `0x${"55".repeat(32)}` as Hex)])
    const { app, store } = apiFor(reader)
    const ciphertext = randomBytes(4)
    const body = upload(ciphertext)
    await store.putObject(storedObject(body))
    await store.blobs.put(ciphertext)

    let last: Response | undefined
    const client = clientFor(app, async (url, init) => (last = await app.request(url, init)))
    // in-6 R4: an unanswered chain read is 503 CHAIN_UNAVAILABLE — still an error, never data,
    // but no longer wearing an authorization code (a busy RPC is not a denial). in-11 R-8
    // narrows that mapping: a bare revert is the chain ANSWERING — an honest 500 INTERNAL_ERROR,
    // not an availability problem.
    await expect(
      client.request("GET", `/objects?owner=${owner}&namespaceId=${NAMESPACE}`),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" })
    expect(last!.status).toBe(500)
  })
})

describe("in-9 R-5 + in-12 N-10: the operation-scoped read memo shared over the wire", () => {
  const agentAccount = privateKeyToAccount(generatePrivateKey())
  const agentId = hexOf(randomBytes(32))
  const capabilityId = hexOf(randomBytes(32))

  /**
   * Every chain read authorizeAgent needs, answered and counted by name: identity, agent record,
   * capability, agent epoch, chain time, hasAuthority. An empty store then costs the route itself
   * nothing — six reads per request, all of them identical between two requests of one operation.
   */
  function authReader(calls: string[]): RegistryReader {
    return {
      now: async () => {
        calls.push("now")
        return NOW
      },
      agentIdOfSigner: async (signer: Address) => {
        calls.push("agentIdOfSigner")
        return signer === agentAccount.address.toLowerCase() ? agentId : null
      },
      getAgent: async (id: Hex) => {
        calls.push("getAgent")
        return id === agentId
          ? {
              agentId,
              operator: owner,
              signer: agentAccount.address.toLowerCase() as Address,
              encryptionPublicKey: hexOf(randomBytes(32)),
              encryptionKeyVersion: 1,
              callbackOriginHash: hexOf(randomBytes(32)),
              capabilityManifestHash: hexOf(randomBytes(32)),
              capabilityManifestVersion: 1,
              active: true,
            }
          : null
      },
      getCapability: async (id: Hex) => {
        calls.push("getCapability")
        return id === capabilityId
          ? {
              owner,
              agentId,
              namespaceId: NAMESPACE,
              permissions: PERMISSION.READ,
              provenancePolicy: 0,
              issuedAt: 1n,
              expiresAt: 0n,
              agentEpoch: 1n,
              grantedAtReadEpoch: 1n,
              revoked: false,
            }
          : null
      },
      agentEpoch: async () => {
        calls.push("agentEpoch")
        return 1n
      },
      hasAuthority: async () => {
        calls.push("hasAuthority")
        return true
      },
      getRecords: async () => [],
      getRecord: async () => null,
      recordBatchSize: async () => 1,
    } as unknown as RegistryReader
  }

  /**
   * A scoped client whose token pouch is the `tokens` map — signer → the last token the server
   * issued it, exactly as the daemon's per-operation ReadScope hands out.
   */
  function scopedClient(app: ReturnType<typeof createContextApi>["app"], tokens?: Map<string, string>, account = agentAccount) {
    return new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => NOW,
      fetch: async (url, init) => app.request(url, init),
      ...(tokens === undefined ? {} : { readScope: tokens }),
    })
  }

  it("a scoped operation shares content reads across its requests, but authorization is re-asked on every one", async () => {
    const calls: string[] = []
    const counted = authReader(calls)
    const reader = {
      ...counted,
      getRecords: async (ids: Hex[]) => {
        calls.push("getRecords")
        return ids.map(() => null)
      },
      recordBatchSize: async () => {
        calls.push("recordBatchSize")
        return 1
      },
    } as unknown as RegistryReader
    const { app, store } = apiFor(reader)
    // One never-anchored upload: every list checks it against Monad and it stays unmarked, so the
    // content read is observable on every request.
    await store.putObject(storedObject(upload(randomBytes(4))))
    const list = { owner, namespaceId: NAMESPACE, capabilityId }
    const count = (name: string) => calls.filter((c) => c === name).length

    // The first request of an operation carries no token — the server has issued none yet — and
    // the response's minted token is what the client adopts for the requests after it.
    const tokens = new Map<string, string>()
    const scoped = scopedClient(app, tokens)
    await scoped.listObjects(list)
    expect(tokens.size).toBe(1)
    expect(count("getRecords")).toBe(1)

    // The second request opens the bucket and pays for its own content reads; the third is the
    // sibling that benefits.
    await scoped.listObjects(list)
    expect(count("getRecords")).toBe(2)
    await scoped.listObjects(list)
    expect(count("getRecords")).toBe(2)
    expect(count("recordBatchSize")).toBe(2)

    // Authorization is not shareable: identity, capability, epoch, time and authority went back
    // to the chain on EVERY request — a revoked agent cannot inherit a pre-revoke "allowed".
    for (const name of ["agentIdOfSigner", "getAgent", "getCapability", "agentEpoch", "now", "hasAuthority"]) {
      expect(count(name)).toBe(3)
    }

    // A request with no scope at all pays for everything, always.
    await scopedClient(app).listObjects(list)
    expect(count("getRecords")).toBe(3)
  })

  it("a token the server never signed opens nothing — junk cannot occupy the scope map", async () => {
    const calls: string[] = []
    const counted = authReader(calls)
    const reader = {
      ...counted,
      getRecords: async (ids: Hex[]) => {
        calls.push("getRecords")
        return ids.map(() => null)
      },
      recordBatchSize: async () => 1,
    } as unknown as RegistryReader
    const { app, store } = apiFor(reader)
    await store.putObject(storedObject(upload(randomBytes(4))))
    const list = { owner, namespaceId: NAMESPACE, capabilityId }

    // A well-formed but forged token: right shape, wrong HMAC. The request is simply unscoped —
    // no error, no bucket, no shared answers.
    const forged = `0x${"ab".repeat(32)}.${(Date.now() + 5_000).toString(36)}.${"00".repeat(64)}`
    const scope = new Map([[agentAccount.address.toLowerCase(), forged]])
    const scoped = scopedClient(app, scope)
    await scoped.listObjects(list)
    await scoped.listObjects(list)
    const count = (name: string) => calls.filter((c) => c === name).length
    expect(count("getRecords")).toBe(2) // both requests paid for the content check themselves

    // And a forged token cannot poison the pouch for a real one: the next operation scoped
    // normally still shares its content reads.
    const realScope = new Map<string, string>()
    const real = scopedClient(app, realScope)
    await real.listObjects(list)
    await real.listObjects(list)
    await real.listObjects(list)
    expect(count("getRecords")).toBe(4) // +2 — the third scoped request hit the bucket
  })

  it("a token minted for one signer opens no bucket for another", async () => {
    const calls: string[] = []
    const counted = authReader(calls)
    const otherAccount = privateKeyToAccount(generatePrivateKey())
    const otherAgentId = hexOf(randomBytes(32))
    const otherCapabilityId = hexOf(randomBytes(32))
    const reader = {
      ...counted,
      agentIdOfSigner: async (signer: Address) => {
        calls.push("agentIdOfSigner")
        const lower = signer.toLowerCase()
        return lower === agentAccount.address.toLowerCase() ? agentId : lower === otherAccount.address.toLowerCase() ? otherAgentId : null
      },
      getAgent: async (id: Hex) => {
        calls.push("getAgent")
        return id === otherAgentId
          ? {
              agentId: otherAgentId,
              operator: owner,
              signer: otherAccount.address.toLowerCase() as Address,
              encryptionPublicKey: hexOf(randomBytes(32)),
              encryptionKeyVersion: 1,
              callbackOriginHash: hexOf(randomBytes(32)),
              capabilityManifestHash: hexOf(randomBytes(32)),
              capabilityManifestVersion: 1,
              active: true,
            }
          : id === agentId
            ? counted.getAgent(id)
            : null
      },
      getCapability: async (id: Hex) => {
        calls.push("getCapability")
        if (id === otherCapabilityId) {
          return {
            owner,
            agentId: otherAgentId,
            namespaceId: NAMESPACE,
            permissions: PERMISSION.READ,
            provenancePolicy: 0,
            issuedAt: 1n,
            expiresAt: 0n,
            agentEpoch: 1n,
            grantedAtReadEpoch: 1n,
            revoked: false,
          }
        }
        return counted.getCapability(id)
      },
      getRecords: async (ids: Hex[]) => {
        calls.push("getRecords")
        return ids.map(() => null)
      },
      recordBatchSize: async () => 1,
    } as unknown as RegistryReader
    const { app, store } = apiFor(reader)
    await store.putObject(storedObject(upload(randomBytes(4))))
    const count = (name: string) => calls.filter((c) => c === name).length

    // Agent A warms its bucket across two requests.
    const aScope = new Map<string, string>()
    const aClient = scopedClient(app, aScope)
    const aList = { owner, namespaceId: NAMESPACE, capabilityId }
    await aClient.listObjects(aList)
    await aClient.listObjects(aList)
    const before = count("getRecords")

    // Agent B stamps A's token — the HMAC was computed over A's signer, so B's request is
    // unscoped: the bucket's shared answers are closed to it.
    const stolen = aScope.get(agentAccount.address.toLowerCase())!
    const bScope = new Map([[otherAccount.address.toLowerCase(), stolen]])
    const bClient = scopedClient(app, bScope, otherAccount)
    await bClient.listObjects({ owner, namespaceId: NAMESPACE, capabilityId: otherCapabilityId })
    expect(count("getRecords")).toBe(before + 1)
  })

  it("an expired token opens no bucket — the client re-mints from the next response", async () => {
    const calls: string[] = []
    const counted = authReader(calls)
    const reader = {
      ...counted,
      getRecords: async (ids: Hex[]) => {
        calls.push("getRecords")
        return ids.map(() => null)
      },
      recordBatchSize: async () => 1,
    } as unknown as RegistryReader
    const { app, store } = apiFor(reader)
    await store.putObject(storedObject(upload(randomBytes(4))))
    const list = { owner, namespaceId: NAMESPACE, capabilityId }
    const count = (name: string) => calls.filter((c) => c === name).length

    const t0 = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0)
    try {
      const tokens = new Map<string, string>()
      const scoped = scopedClient(app, tokens)
      await scoped.listObjects(list)
      await scoped.listObjects(list)
      await scoped.listObjects(list)
      expect(count("getRecords")).toBe(2) // the third request hit the live bucket

      // Past the token's life the same bytes name a dead bucket — the request runs unscoped and
      // the client adopts the freshly minted token the response carries.
      clock.mockReturnValue(t0 + 9_000)
      await scoped.listObjects(list)
      expect(count("getRecords")).toBe(3)
      await scoped.listObjects(list)
      expect(count("getRecords")).toBe(4) // new token, new bucket — first scoped read pays again
      await scoped.listObjects(list)
      expect(count("getRecords")).toBe(4) // then shares it
    } finally {
      clock.mockRestore()
    }
  })
})
