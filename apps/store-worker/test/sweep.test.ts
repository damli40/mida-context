// M3-A item 5: the scheduled sweep, exercised on a real SQLite D1 with a fake clock. A pending upload at
// 23 h 59 m survives, at 24 h 1 m it is gone, and an anchored object is never swept however old it is —
// the chain, not the store, is the authority on whether an object exists.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { contentHash } from "@mida/storage"
import { randomBytes } from "@noble/hashes/utils.js"
import type { ContextRecordView, RegistryReader, StoredObject } from "@mida/api"
import { d1Stores, runSweep } from "@mida/store-worker"
import type { D1Like } from "@mida/store-worker"

const OWNER = `0x${"1".repeat(40)}` as Address
const NAMESPACE = namespaceId("goals.career")

function objectAt(uploadedAt: Date): StoredObject {
  const contextId = hexOf(randomBytes(32))
  const ciphertext = randomBytes(8)
  return {
    contextId,
    owner: OWNER,
    uploader: OWNER,
    namespaceId: NAMESPACE,
    authorId: hexOf(randomBytes(32)),
    objectNonce: hexOf(randomBytes(32)),
    expectedParentId: `0x${"0".repeat(64)}` as Hex,
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
    manifestHash: hexOf(randomBytes(32)),
    uploadedAt: uploadedAt.toISOString(),
  }
}

async function d1(): Promise<{ db: D1Like & { exec(sql: string): Promise<unknown> }; dispose(): Promise<void> }> {
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
  return { db: db as D1Like & { exec(sql: string): Promise<unknown> }, dispose: () => mf.dispose() }
}

describe("the scheduled sweep", () => {
  it("removes pending objects past 24 h and stale nonces, and never an anchored object", async () => {
    const { db, dispose } = await d1()
    try {
      const stores = d1Stores(db)
      const now = new Date("2026-09-21T12:00:00.000Z")
      const young = objectAt(new Date(now.getTime() - (23 * 60 + 59) * 60_000))
      const old = objectAt(new Date(now.getTime() - (24 * 60 + 1) * 60_000))
      const sharedBytes = new TextEncoder().encode("shared bytes")
      const sharedBlob = contentHash(sharedBytes)
      const anchoredAncient = objectAt(new Date(now.getTime() - 90 * 24 * 60 * 60_000))
      // The anchored object's ciphertext hash doubles as a swept manifest row's blob hash below —
      // deleting the index row must not delete bytes another row still references.
      anchoredAncient.manifest = { ...anchoredAncient.manifest, ciphertextHash: sharedBlob }
      for (const object of [young, old, anchoredAncient]) await stores.objects.putObject(object)

      const records = new Map<Hex, ContextRecordView>()
      records.set(anchoredAncient.contextId, {
        contextId: anchoredAncient.contextId,
        owner: OWNER,
        author: anchoredAncient.authorId,
        namespaceId: NAMESPACE,
        lineageId: anchoredAncient.contextId,
        parentId: anchoredAncient.expectedParentId,
        manifestHash: anchoredAncient.manifestHash,
        ciphertextCommitment: anchoredAncient.manifest.ciphertextHash,
        evidenceCommitment: `0x${"0".repeat(64)}` as Hex,
        readEpoch: 1n,
        createdAt: 1n,
        expiresAt: 0n,
        version: 1,
        recordType: 1,
        lineagePolicy: 0,
        kind: 1,
        provenanceSource: 1,
      })
      const reader = { getRecord: async (id: Hex) => records.get(id.toLowerCase() as Hex) ?? null } as unknown as RegistryReader

      const nowSeconds = BigInt(Math.floor(now.getTime() / 1000))
      await stores.nonces.consume(OWNER, hexOf(randomBytes(32)), nowSeconds - 61n, nowSeconds)
      await stores.nonces.consume(OWNER, hexOf(randomBytes(32)), nowSeconds, nowSeconds)

      // Staged agent manifests: the stale unverified row and its blob are reclaimed together, while
      // verified and still-fresh rows survive. The shared blob's index row is also stale — the bytes
      // stay anyway because the anchored object's manifest names the same hash as its ciphertext.
      const utf8 = new TextEncoder()
      const staleBytes = utf8.encode("stale manifest")
      const verifiedBytes = utf8.encode("verified manifest")
      const staleUnverified = { bodyHash: hexOf(randomBytes(32)), envelopeHash: contentHash(staleBytes) }
      const verifiedOld = { bodyHash: hexOf(randomBytes(32)), envelopeHash: contentHash(verifiedBytes) }
      const youngUnverified = { bodyHash: hexOf(randomBytes(32)), envelopeHash: hexOf(randomBytes(32)) }
      await stores.objects.blobs.put(staleBytes)
      await stores.objects.blobs.put(verifiedBytes)
      await stores.objects.blobs.put(sharedBytes)
      const hourAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000).toISOString()
      await stores.objects.setManifestIndex(staleUnverified.bodyHash, staleUnverified.envelopeHash, { storedAt: hourAgo(25) })
      await stores.objects.setManifestIndex(verifiedOld.bodyHash, verifiedOld.envelopeHash, { storedAt: hourAgo(90 * 24), verifiedAt: hourAgo(80 * 24) })
      await stores.objects.setManifestIndex(youngUnverified.bodyHash, youngUnverified.envelopeHash, { storedAt: hourAgo(23) })
      await stores.objects.setManifestIndex(hexOf(randomBytes(32)), sharedBlob, { storedAt: hourAgo(25) })

      const result = await runSweep({ stores, reader, now })
      expect(result).toEqual({ objectsRemoved: 1, manifestsRemoved: 2, noncesRemoved: 1 })
      expect(await stores.objects.getObject(old.contextId)).toBeUndefined()
      expect(await stores.objects.getObject(young.contextId)).toBeDefined()
      expect(await stores.objects.getObject(anchoredAncient.contextId)).toBeDefined()
      expect(await stores.objects.getManifestIndex(staleUnverified.bodyHash)).toBeUndefined()
      await expect(stores.objects.blobs.get(staleUnverified.envelopeHash)).rejects.toMatchObject({ code: "NOT_FOUND" })
      expect(await stores.objects.getManifestIndex(verifiedOld.bodyHash)).toMatchObject({ envelopeHash: verifiedOld.envelopeHash })
      expect(await stores.objects.getManifestIndex(youngUnverified.bodyHash)).toMatchObject({ envelopeHash: youngUnverified.envelopeHash })
      expect(await stores.objects.blobs.get(sharedBlob)).toEqual(utf8.encode("shared bytes"))

      // A second sweep at the same fake now removes nothing — the work is idempotent.
      expect(await runSweep({ stores, reader, now })).toEqual({ objectsRemoved: 0, manifestsRemoved: 0, noncesRemoved: 0 })
    } finally {
      await dispose()
    }
  })
})
