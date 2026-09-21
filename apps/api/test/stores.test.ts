// M3-A item 1: the Context API's persistence is injectable — the same app runs
// on the file-backed stores (the default) or on the D1 stores the hosted
// worker builds. These tests pin the store contract on the file side; the
// shared contract suite runs the same list against D1.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { MidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, createContextApi, fileStores, sweepStores } from "@mida/api"
import type { NonceStore, RegistryReader, StoredObject } from "@mida/api"

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
const NAMESPACE = hexOf(randomBytes(32))

const dir = () => mkdtempSync(join(tmpdir(), "mida-stores-"))

function fakeObject(uploader: Address = OWNER): StoredObject {
  const contextId = hexOf(randomBytes(32))
  return {
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
      ciphertextHash: hexOf(randomBytes(32)),
      ciphertextSize: 4,
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
  }
}

describe("injected stores", () => {
  it("the app authenticates through the injected NonceStore, not a file", async () => {
    const calls: string[] = []
    const nonces: NonceStore = {
      consume: async (signer, nonce) => {
        calls.push(`${signer}:${nonce}`)
        throw new MidaError("REPLAY", "injected store denies everything")
      },
      sweep: async () => 0,
    }
    const { app } = createContextApi({
      reader: {} as RegistryReader,
      deployment,
      stores: { ...fileStores(dir()), nonces },
      clock: () => NOW,
    })
    const account = privateKeyToAccount(generatePrivateKey())
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      clock: () => NOW,
      fetch: async (url, init) => app.request(url, init),
    })
    // A correctly signed request would normally reach the handler and fail INVALID_WIRE; the injected
    // nonce store turning it into REPLAY proves the app ran authentication through it.
    await expect(client.request("POST", "/revocations", { body: {} })).rejects.toMatchObject({ code: "REPLAY" })
    expect(calls).toHaveLength(1)
  })

  it("requires either stores or a data directory", () => {
    expect(() => createContextApi({ reader: {} as RegistryReader, deployment })).toThrow(/stores|dataDir/)
  })
})

describe("the file-backed store implementations", () => {
  it("a second consume of one nonce is REPLAY; two racing consumes admit exactly one", async () => {
    const stores = fileStores(dir())
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
  })

  it("recordPut counts puts per signer per UTC day", async () => {
    const dataDir = dir()
    const stores = fileStores(dataDir)
    expect(await stores.objects.recordPut(OWNER, "2026-09-21")).toBe(1)
    expect(await stores.objects.recordPut(OWNER, "2026-09-21")).toBe(2)
    expect(await stores.objects.recordPut(OWNER, "2026-09-22")).toBe(1)
    expect(await stores.objects.recordPut(`0x${"2".repeat(40)}` as Address, "2026-09-21")).toBe(1)
    // A second store instance on the same directory sees the same counts.
    expect(await fileStores(dataDir).objects.recordPut(OWNER, "2026-09-21")).toBe(3)
  })

  it("objectsByUploader returns only that signer's uploads, and stores the signer on the object", async () => {
    const stores = fileStores(dir())
    const mine = fakeObject(OWNER)
    const other = fakeObject(`0x${"2".repeat(40)}` as Address)
    await stores.objects.putObject(mine)
    await stores.objects.putObject(other)
    expect((await stores.objects.objectsByUploader(OWNER)).map((object) => object.contextId)).toEqual([mine.contextId])
    expect((await stores.objects.getObject(mine.contextId))?.uploader).toBe(OWNER)
  })

  it("sweep removes stale pending objects and expired nonces, and never an anchored object", async () => {
    const stores = fileStores(dir())
    const now = new Date("2026-09-21T12:00:00.000Z")
    const young = fakeObject()
    young.uploadedAt = new Date(now.getTime() - (23 * 60 + 59) * 60_000).toISOString()
    const old = fakeObject()
    old.uploadedAt = new Date(now.getTime() - (24 * 60 + 1) * 60_000).toISOString()
    const anchoredOld = fakeObject()
    anchoredOld.uploadedAt = old.uploadedAt
    for (const object of [young, old, anchoredOld]) await stores.objects.putObject(object)

    const nowSeconds = BigInt(Math.floor(now.getTime() / 1000))
    const staleNonce = hexOf(randomBytes(32))
    const liveNonce = hexOf(randomBytes(32))
    await stores.nonces.consume(OWNER, staleNonce, nowSeconds - 61n, nowSeconds)
    await stores.nonces.consume(OWNER, liveNonce, nowSeconds, nowSeconds)

    const result = await sweepStores({
      stores,
      now,
      isAnchored: async (object) => object.contextId === anchoredOld.contextId,
    })
    expect(result).toEqual({ objectsRemoved: 1, manifestsRemoved: 0, noncesRemoved: 1 })
    expect(await stores.objects.getObject(old.contextId)).toBeUndefined()
    expect(await stores.objects.getObject(young.contextId)).toBeDefined()
    expect(await stores.objects.getObject(anchoredOld.contextId)).toBeDefined()

    // The swept nonce can be recorded again; the fresh one still replays.
    await stores.nonces.consume(OWNER, staleNonce, nowSeconds - 61n, nowSeconds)
    await expect(stores.nonces.consume(OWNER, liveNonce, nowSeconds, nowSeconds)).rejects.toMatchObject({ code: "REPLAY" })
  })
})
