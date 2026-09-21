// M3-A item 3: ONE behavioural contract for both store implementations. If a behaviour differs between the
// file-backed stores and D1, the hosted worker is not running the same service — that is the whole point of
// putting persistence behind the interface. The D1 half runs on a real SQLite D1 through Miniflare, not a fake.

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { contentHash } from "@mida/storage"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, createContextApi, fileStores, sweepStores } from "@mida/api"
import type { ContextRecordView, ContextStores, RegistryReader, StoredObject } from "@mida/api"
import { d1Stores } from "@mida/store-worker"
import type { D1Like } from "@mida/store-worker"

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
const OWNER = `0x${"1".repeat(40)}` as Address
const NAMESPACE = namespaceId("goals.career")

function fakeObject(uploader: Address = OWNER): { object: StoredObject; ciphertext: Uint8Array } {
  const contextId = hexOf(randomBytes(32))
  const ciphertext = randomBytes(64)
  return {
    ciphertext,
    object: {
      contextId,
      owner: OWNER,
      uploader,
      namespaceId: NAMESPACE,
      authorId: hexOf(randomBytes(32)),
      objectNonce: hexOf(randomBytes(32)),
      expectedParentId: `0x${"0".repeat(64)}` as Hex,
      manifest: {
        v: 1,
        contextId,
        ciphertextHash: contentHash(ciphertext),
        ciphertextSize: ciphertext.length,
        payloadNonce: hexOf(randomBytes(32)),
        cryptoVersion: "mida-crypto-v1",
        readEpoch: "1",
        epochDekWrap: {
          v: 1,
          contextId,
          namespaceId: NAMESPACE,
          readEpoch: "1",
          ephemeralPublicKey: hexOf(randomBytes(32)),
          nonce: hexOf(randomBytes(12)),
          wrappedDek: hexOf(randomBytes(48)),
        },
      },
      manifestHash: hexOf(randomBytes(32)),
      uploadedAt: new Date().toISOString(),
      anchoredAt: null,
    },
  }
}

function anchoredRecord(object: StoredObject): ContextRecordView {
  return {
    contextId: object.contextId,
    owner: object.owner,
    author: object.authorId,
    namespaceId: object.namespaceId,
    lineageId: object.contextId,
    parentId: object.expectedParentId,
    manifestHash: object.manifestHash,
    ciphertextCommitment: object.manifest.ciphertextHash,
    evidenceCommitment: `0x${"0".repeat(64)}` as Hex,
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

function contractSuite(name: string, make: () => Promise<{ stores: ContextStores; cleanup: () => Promise<void> }>): void {
  describe(name, () => {
    it("a second consume of one nonce is REPLAY; two racing consumes admit exactly one", async () => {
      const { stores, cleanup } = await make()
      try {
        const nonce = hexOf(randomBytes(32))
        await stores.nonces.consume(OWNER, nonce, 100n, 100n)
        await expect(stores.nonces.consume(OWNER, nonce, 100n, 100n)).rejects.toMatchObject({ code: "REPLAY" })

        const raced = hexOf(randomBytes(32))
        const results = await Promise.allSettled([
          stores.nonces.consume(OWNER, raced, 100n, 100n),
          stores.nonces.consume(OWNER, raced, 100n, 100n),
        ])
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      } finally {
        await cleanup()
      }
    })

    it("stores objects idempotently and rejects a different manifest for an existing contextId", async () => {
      const { stores, cleanup } = await make()
      try {
        const { object } = fakeObject()
        await stores.objects.putObject(object)
        await stores.objects.putObject(object) // same content: a free no-op
        expect(await stores.objects.getObject(object.contextId)).toMatchObject({ manifestHash: object.manifestHash })
        await expect(stores.objects.putObject({ ...object, manifestHash: hexOf(randomBytes(32)) })).rejects.toMatchObject({
          code: "COMMITMENT_MISMATCH",
        })
      } finally {
        await cleanup()
      }
    })

    it("never serves an object the chain has not anchored, then serves it once anchored", async () => {
      const { stores, cleanup } = await make()
      try {
        const { object, ciphertext } = fakeObject()
        const account = privateKeyToAccount(generatePrivateKey())
        const ownerAccount = account.address.toLowerCase() as Address
        // The object must be owned by the request signer so authorization needs no further chain reads.
        object.owner = ownerAccount
        object.uploader = ownerAccount
        await stores.objects.putObject(object)
        await stores.objects.blobs.put(ciphertext)

        const records = new Map<Hex, ContextRecordView>()
        const recordCalls: Hex[] = []
        const reader = {
          getRecord: async (id: Hex) => {
            recordCalls.push(id)
            return records.get(id.toLowerCase() as Hex) ?? null
          },
        } as unknown as RegistryReader
        const { app } = createContextApi({ reader, deployment, stores, clock: () => NOW })
        const client = new ContextApiClient({
          baseUrl: "http://mida.test",
          account,
          chainId: deployment.chainId,
          capabilityRegistry: deployment.capabilityRegistry,
          clock: () => NOW,
          fetch: async (url, init) => app.request(url, init),
        })

        const listPath = `/objects?owner=${ownerAccount}&namespaceId=${NAMESPACE}`
        expect(await client.request<{ objects: unknown[] }>("GET", listPath)).toEqual({ objects: [] })
        await expect(client.request("GET", `/manifests/${object.contextId}`)).rejects.toMatchObject({ code: "NOT_FOUND" })

        records.set(object.contextId, anchoredRecord(object))
        const listed = await client.request<{ objects: Array<{ contextId: string; ciphertext: string }> }>("GET", listPath)
        expect(listed.objects.map((stored) => stored.contextId)).toContain(object.contextId)
        expect(listed.objects[0]!.ciphertext).toBe(`0x${Buffer.from(ciphertext).toString("hex")}`)
        await expect(client.request("GET", `/manifests/${object.contextId}`)).resolves.toMatchObject({ manifestHash: object.manifestHash })

        // The first verified match was marked — every later read serves without asking Monad again.
        expect((await stores.objects.getObject(object.contextId))?.anchoredAt).not.toBeNull()
        recordCalls.length = 0
        await expect(client.request("GET", `/manifests/${object.contextId}`)).resolves.toMatchObject({ manifestHash: object.manifestHash })
        expect(recordCalls).toHaveLength(0)
      } finally {
        await cleanup()
      }
    })

    it("a chain record that does not match is not marked, and is refused again after a fix", async () => {
      const { stores, cleanup } = await make()
      try {
        const { object } = fakeObject()
        const account = privateKeyToAccount(generatePrivateKey())
        const ownerAccount = account.address.toLowerCase() as Address
        object.owner = ownerAccount
        object.uploader = ownerAccount
        await stores.objects.putObject(object)

        // A record exists but commits to a different manifest: not an anchor for these bytes.
        const records = new Map<Hex, ContextRecordView>()
        records.set(object.contextId, { ...anchoredRecord(object), manifestHash: hexOf(randomBytes(32)) })
        const reader = { getRecord: async (id: Hex) => records.get(id.toLowerCase() as Hex) ?? null } as unknown as RegistryReader
        const { app } = createContextApi({ reader, deployment, stores, clock: () => NOW })
        const client = new ContextApiClient({
          baseUrl: "http://mida.test",
          account,
          chainId: deployment.chainId,
          capabilityRegistry: deployment.capabilityRegistry,
          clock: () => NOW,
          fetch: async (url, init) => app.request(url, init),
        })

        await expect(client.request("GET", `/manifests/${object.contextId}`)).rejects.toMatchObject({ code: "NOT_FOUND" })
        // A mismatched record leaves no mark — the row stays pending for the next honest check.
        expect((await stores.objects.getObject(object.contextId))?.anchoredAt).toBeNull()

        records.set(object.contextId, anchoredRecord(object))
        await expect(client.request("GET", `/manifests/${object.contextId}`)).resolves.toMatchObject({ manifestHash: object.manifestHash })
        expect((await stores.objects.getObject(object.contextId))?.anchoredAt).not.toBeNull()
      } finally {
        await cleanup()
      }
    })

    it("counts PUTs per signer per UTC day and lists objects by uploader", async () => {
      const { stores, cleanup } = await make()
      try {
        const other = `0x${"2".repeat(40)}` as Address
        expect(await stores.objects.recordPut(OWNER, "2026-09-21")).toBe(1)
        expect(await stores.objects.recordPut(OWNER, "2026-09-21")).toBe(2)
        expect(await stores.objects.recordPut(OWNER, "2026-09-22")).toBe(1)
        expect(await stores.objects.recordPut(other, "2026-09-21")).toBe(1)

        // The manifest quota is its own counter — object PUTs and manifest PUTs never share a bucket.
        expect(await stores.objects.recordManifestPut(OWNER, "2026-09-21")).toBe(1)
        expect(await stores.objects.recordManifestPut(OWNER, "2026-09-21")).toBe(2)
        expect(await stores.objects.recordManifestPut(OWNER, "2026-09-22")).toBe(1)
        expect(await stores.objects.recordManifestPut(other, "2026-09-21")).toBe(1)

        const mine = fakeObject(OWNER).object
        const theirs = fakeObject(other).object
        const marked = fakeObject(OWNER).object
        marked.anchoredAt = "2026-09-20T00:00:00.000Z"
        await stores.objects.putObject(mine)
        await stores.objects.putObject(theirs)
        await stores.objects.putObject(marked)
        // Only unmarked rows belong to the uploader: the quota scan never touches marked history.
        expect((await stores.objects.pendingByUploader(OWNER)).map((object) => object.contextId)).toEqual([mine.contextId])
      } finally {
        await cleanup()
      }
    })

    it("marks anchored rows once, first-write-wins, and never clears the mark", async () => {
      const { stores, cleanup } = await make()
      try {
        const object = fakeObject(OWNER).object
        await stores.objects.putObject(object)
        expect((await stores.objects.getObject(object.contextId))?.anchoredAt).toBeNull()

        await stores.objects.markAnchored(object.contextId, "2026-09-21T00:00:00.000Z")
        expect((await stores.objects.getObject(object.contextId))?.anchoredAt).toBe("2026-09-21T00:00:00.000Z")
        expect(await stores.objects.pendingByUploader(OWNER)).toEqual([])

        // A second mark cannot overwrite or clear the first.
        await stores.objects.markAnchored(object.contextId, "2026-09-22T00:00:00.000Z")
        expect((await stores.objects.getObject(object.contextId))?.anchoredAt).toBe("2026-09-21T00:00:00.000Z")
        await stores.objects.markAnchored(hexOf(randomBytes(32)), "2026-09-21T00:00:00.000Z") // unknown id: no-op
      } finally {
        await cleanup()
      }
    })

    it("sweeps pending objects past 24 h and expired nonces, and never an anchored object", async () => {
      const { stores, cleanup } = await make()
      try {
        const now = new Date("2026-09-21T12:00:00.000Z")
        const young = fakeObject().object
        young.uploadedAt = new Date(now.getTime() - (23 * 60 + 59) * 60_000).toISOString()
        const old = fakeObject().object
        old.uploadedAt = new Date(now.getTime() - (24 * 60 + 1) * 60_000).toISOString()
        const anchoredOld = fakeObject().object
        anchoredOld.uploadedAt = old.uploadedAt
        for (const object of [young, old, anchoredOld]) await stores.objects.putObject(object)

        const nowSeconds = BigInt(Math.floor(now.getTime() / 1000))
        const staleNonce = hexOf(randomBytes(32))
        const liveNonce = hexOf(randomBytes(32))
        await stores.nonces.consume(OWNER, staleNonce, nowSeconds - 61n, nowSeconds)
        await stores.nonces.consume(OWNER, liveNonce, nowSeconds, nowSeconds)

        const checks: Hex[] = []
        const result = await sweepStores({
          stores,
          now,
          isAnchored: async (object) => {
            checks.push(object.contextId)
            return object.contextId === anchoredOld.contextId
          },
        })
        expect(result).toEqual({ objectsRemoved: 1, manifestsRemoved: 0, noncesRemoved: 1 })
        expect(await stores.objects.getObject(old.contextId)).toBeUndefined()
        expect(await stores.objects.getObject(young.contextId)).toBeDefined()
        // The anchored row survived AND was marked: a second sweep never asks the chain about it.
        expect((await stores.objects.getObject(anchoredOld.contextId))?.anchoredAt).not.toBeNull()
        const secondChecks: Hex[] = []
        await sweepStores({
          stores,
          now,
          isAnchored: async (object) => {
            secondChecks.push(object.contextId)
            return false
          },
        })
        expect(secondChecks).toHaveLength(0)

        await stores.nonces.consume(OWNER, staleNonce, nowSeconds - 61n, nowSeconds)
        await expect(stores.nonces.consume(OWNER, liveNonce, nowSeconds, nowSeconds)).rejects.toMatchObject({ code: "REPLAY" })
      } finally {
        await cleanup()
      }
    })

    it("round-trips wraps, manifest index entries and blobs; missing lookups miss cleanly", async () => {
      const { stores, cleanup } = await make()
      try {
        const wrap = {
          v: 1,
          owner: OWNER,
          namespaceId: NAMESPACE,
          readEpoch: "1",
          agentId: hexOf(randomBytes(32)),
          agentKeyVersion: 2,
          ephemeralPublicKey: hexOf(randomBytes(32)),
          nonce: hexOf(randomBytes(12)),
          wrappedEpochPrivateKey: hexOf(randomBytes(48)),
          createdAt: new Date().toISOString(),
        } as const
        await stores.objects.putWrap(wrap)
        expect(
          await stores.objects.getWrap({ owner: OWNER, namespaceId: NAMESPACE, readEpoch: "1", agentId: wrap.agentId, agentKeyVersion: 2 }),
        ).toEqual(wrap)
        expect(
          await stores.objects.getWrap({ owner: OWNER, namespaceId: NAMESPACE, readEpoch: "1", agentId: wrap.agentId, agentKeyVersion: 3 }),
        ).toBeUndefined()

        const bodyHash = hexOf(randomBytes(32))
        const envelopeHash = hexOf(randomBytes(32))
        const storedAt = "2026-09-20T00:00:00.000Z"
        const verifiedAt = "2026-09-20T01:00:00.000Z"
        await stores.objects.setManifestIndex(bodyHash, envelopeHash, { storedAt })
        expect(await stores.objects.getManifestIndex(bodyHash)).toMatchObject({ envelopeHash, storedAt, verifiedAt: null })
        expect(await stores.objects.getManifestIndex(hexOf(randomBytes(32)))).toBeUndefined()
        // Marking verified keeps the original store time; repointing keeps it too — a re-upload must
        // not be able to extend an unverified row's life.
        await stores.objects.setManifestIndex(bodyHash, envelopeHash, { verifiedAt })
        expect(await stores.objects.getManifestIndex(bodyHash)).toMatchObject({ envelopeHash, storedAt, verifiedAt })
        await stores.objects.setManifestIndex(bodyHash, hexOf(randomBytes(32)), { verifiedAt })
        expect(await stores.objects.getManifestIndex(bodyHash)).toMatchObject({ storedAt })

        const blob = randomBytes(48)
        await stores.objects.blobs.put(blob)
        expect(await stores.objects.blobs.get(contentHash(blob))).toEqual(blob)
        await expect(stores.objects.blobs.get(hexOf(randomBytes(32)))).rejects.toMatchObject({ code: "NOT_FOUND" })
      } finally {
        await cleanup()
      }
    })

    it("sweeps stale unverified manifest rows and their unreferenced blobs, never verified ones", async () => {
      const { stores, cleanup } = await make()
      try {
        const cutoff = new Date("2026-09-21T12:00:00.000Z")
        const at = (h: number) => new Date(cutoff.getTime() - h * 60 * 60_000).toISOString()
        const put = async (label: string) => {
          const bytes = new TextEncoder().encode(label)
          await stores.objects.blobs.put(bytes)
          return contentHash(bytes)
        }
        const staleRow = { bodyHash: hexOf(randomBytes(32)), envelopeHash: await put("stale") }
        const youngRow = { bodyHash: hexOf(randomBytes(32)), envelopeHash: await put("young") }
        const verifiedRow = { bodyHash: hexOf(randomBytes(32)), envelopeHash: await put("verified") }
        const sharedHash = await put("shared")
        const sharedRow = { bodyHash: hexOf(randomBytes(32)) }
        await stores.objects.setManifestIndex(staleRow.bodyHash, staleRow.envelopeHash, { storedAt: at(25) })
        await stores.objects.setManifestIndex(youngRow.bodyHash, youngRow.envelopeHash, { storedAt: at(23) })
        await stores.objects.setManifestIndex(verifiedRow.bodyHash, verifiedRow.envelopeHash, { storedAt: at(48), verifiedAt: at(47) })
        // A stale row points at a blob a fresh row also references — the row goes, the bytes stay.
        await stores.objects.setManifestIndex(sharedRow.bodyHash, sharedHash, { storedAt: at(25) })
        await stores.objects.setManifestIndex(hexOf(randomBytes(32)), sharedHash, { storedAt: at(1) })

        expect(await stores.objects.sweepManifests(new Date(cutoff.getTime() - 24 * 60 * 60_000))).toBe(2)
        expect(await stores.objects.getManifestIndex(staleRow.bodyHash)).toBeUndefined()
        expect(await stores.objects.getManifestIndex(sharedRow.bodyHash)).toBeUndefined()
        await expect(stores.objects.blobs.get(staleRow.envelopeHash)).rejects.toMatchObject({ code: "NOT_FOUND" })
        expect(await stores.objects.blobs.get(sharedHash)).toBeDefined()
        expect(await stores.objects.getManifestIndex(youngRow.bodyHash)).toMatchObject({ envelopeHash: youngRow.envelopeHash })
        expect(await stores.objects.getManifestIndex(verifiedRow.bodyHash)).toMatchObject({ envelopeHash: verifiedRow.envelopeHash })
      } finally {
        await cleanup()
      }
    })

    it("persists deny intents and fails update of a missing one", async () => {
      const { stores, cleanup } = await make()
      try {
        const intent = {
          id: hexOf(randomBytes(32)),
          owner: OWNER,
          target: { kind: "agent", agentId: hexOf(randomBytes(32)) },
          state: "active",
          agentEpochAtIntent: "4",
          cancellationNonce: "7",
        } as const
        await stores.denies.insert(intent)
        expect(await stores.denies.get(intent.id)).toEqual(intent)
        expect(await stores.denies.list()).toEqual([intent])
        await stores.denies.update({ ...intent, state: "anchored", cancellationNonce: null })
        expect((await stores.denies.get(intent.id))?.state).toBe("anchored")
        await expect(stores.denies.update({ ...intent, id: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "NOT_FOUND" })
      } finally {
        await cleanup()
      }
    })
  })
}

contractSuite("the file-backed stores", async () => ({
  stores: fileStores(mkdtempSync(join(tmpdir(), "mida-contract-"))),
  cleanup: async () => {},
}))

contractSuite("the D1 stores on a real SQLite D1", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('')}}",
    d1Databases: ["DB"],
  })
  const db = (await mf.getD1Database("DB")) as unknown as D1Like
  const statements = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
  await db.batch(statements.map((sql) => db.prepare(sql)))
  return { stores: d1Stores(db), cleanup: async () => void (await mf.dispose()) }
})
