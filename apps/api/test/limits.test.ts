// M3-A item 4: the shared app enforces the upload-abuse limits so a hosted instance cannot be used as free file
// hosting — and self-hosters get the same protection. Each limit is tested at its boundary: exactly at it passes,
// one byte or one request over fails, and a lying content-length header cannot bypass the actual byte count.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { zeroHash } from "viem"
import { OWNER_AUTHOR_ID, contextId as deriveContextId, namespaceId } from "@mida/protocol"
import type { Address, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { hexOf, manifestHash } from "@mida/crypto"
import { contentHash } from "@mida/storage"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Deployment } from "@mida/chain"
import { ContextApiClient, createContextApi, fileStores } from "@mida/api"
import type { ContextRecordView, ContextStores, ObjectUploadBody, RegistryReader, RequestLimiter, StoreLimits } from "@mida/api"
import { DEFAULT_STORE_LIMITS } from "@mida/api"

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

/** A chain stub that lets an owner-signed PUT reach storage: current epoch 1, writes open, nothing anchored. */
function stubReader(records: Map<Hex, ContextRecordView> = new Map()): RegistryReader {
  return {
    now: async () => NOW,
    requiredReadEpoch: async () => 1n,
    isWriteEpochValid: async () => true,
    getRecord: async (id: Hex) => records.get(id.toLowerCase() as Hex) ?? null,
    getAgent: async () => null,
  } as unknown as RegistryReader
}

function apiFor(reader: RegistryReader, limits?: Partial<StoreLimits>, limiter?: RequestLimiter) {
  return createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-limits-")), clock: () => NOW, limits, limiter })
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

/** A client whose last response status and body text are captured, so quota messages can be asserted verbatim. */
function watchingClient(app: ReturnType<typeof createContextApi>["app"]) {
  const seen = { status: 0, body: "" }
  const client = clientFor(app, async (url, init) => {
    const response = await app.request(url, init)
    seen.status = response.status
    seen.body = await response.clone().text()
    return response
  })
  return { client, seen }
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

/** A minimal structurally valid agent-manifest envelope for an agent Monad does not know yet. */
function envelope(): SignedAgentCapabilityManifest {
  return {
    manifest: {
      v: 1,
      agentId: hexOf(randomBytes(32)),
      manifestVersion: 1,
      name: "agent",
      purposes: [{ id: "career_coaching", description: "reads career context" }],
      scopeDeclarations: [],
      issuedAt: 0,
    },
    operatorSignature: `0x${"00".repeat(65)}` as Hex,
  }
}

describe("upload-abuse limits", () => {
  it("ships the required defaults", () => {
    expect(DEFAULT_STORE_LIMITS).toEqual({
      maxCiphertextBytes: 262_144,
      maxPutsPerSignerPerDay: 2_000,
      maxPendingBytesPerSigner: 20 * 1024 * 1024,
      maxManifestBodyBytes: 16_384,
      maxRequestBodyBytes: 1_048_576,
      maxManifestPutsPerSignerPerDay: 20,
    })
  })

  it("accepts ciphertext exactly at the cap and rejects one byte over with 413", async () => {
    const { app } = apiFor(stubReader())
    const client = clientFor(app)
    await expect(client.putObject(upload(new Uint8Array(262_144).fill(0xab)))).resolves.toMatchObject({ state: "pending" })
    await expect(client.putObject(upload(new Uint8Array(262_145).fill(0xab)))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" })
  })

  it("a lying content-length cannot smuggle an over-cap body through", async () => {
    const { app } = apiFor(stubReader())
    // The header claims one byte; the real body is over the 1 MB request cap. The signature is honest —
    // only the declared length lies — and the byte count actually read decides.
    const client = clientFor(app, async (url, init) => {
      const headers = new Headers(init.headers)
      headers.set("content-length", "1")
      return app.request(url, { ...init, headers })
    })
    await expect(client.request("PUT", "/objects", { body: { pad: "x".repeat(1_048_577) } })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" })

    // Cheap checks run before anything expensive: a request with no auth headers at all is refused on
    // header shape alone (401) — the body cap is never reached because the body is never even sized up.
    const response = await app.request("http://mida.test/objects", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "1048577" },
      body: "{}",
    })
    expect(response.status).toBe(401)
  })

  it("enforces the per-signer PUT count with a 429 that names the limit", async () => {
    const { app } = apiFor(stubReader(), { maxPutsPerSignerPerDay: 2 })
    const { client, seen } = watchingClient(app)
    await expect(client.putObject(upload(randomBytes(8)))).resolves.toMatchObject({ state: "pending" })
    await expect(client.putObject(upload(randomBytes(8)))).resolves.toMatchObject({ state: "pending" })
    await expect(client.putObject(upload(randomBytes(8)))).rejects.toThrowError(/429/)
    expect(seen.status).toBe(429)
    expect(seen.body).toContain("maxPutsPerSignerPerDay")
  })

  it("enforces pending ciphertext bytes per signer, and anchoring frees the budget", async () => {
    const records = new Map<Hex, ContextRecordView>()
    const { app } = apiFor(stubReader(records), { maxPendingBytesPerSigner: 100 })
    const { client, seen } = watchingClient(app)
    const first = upload(randomBytes(64))
    await expect(client.putObject(first)).resolves.toMatchObject({ state: "pending" })
    await expect(client.putObject(upload(randomBytes(64)))).rejects.toThrowError(/429/)
    expect(seen.status).toBe(429)
    expect(seen.body).toContain("maxPendingBytesPerSigner")

    // Once Monad anchors the first object it is no longer pending: the budget is freed and the second PUT passes.
    records.set(first.manifest.contextId, anchoredRecord(first))
    await expect(client.putObject(upload(randomBytes(64)))).resolves.toMatchObject({ state: "pending" })
  })

  it("caps the public agent-manifest body at 16 KB at the boundary", async () => {
    const { app } = apiFor(stubReader())
    const client = clientFor(app)
    // The manifest PUT is a signed route now: the client signs, and {"pad":"…"} serializes to exactly
    // repeat + 10 bytes. At the cap the body is read and rejected for its shape — INVALID_WIRE, not a
    // size refusal; one byte over is the 413.
    await expect(client.request("PUT", "/agent-manifests", { body: { pad: "x".repeat(16_374) } })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    await expect(client.request("PUT", "/agent-manifests", { body: { pad: "x".repeat(16_375) } })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" })
  })

  it("rejects an unsigned manifest PUT with 401 before any store work", async () => {
    const { app } = apiFor(stubReader())
    const response = await app.request("http://mida.test/agent-manifests", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope()),
    })
    expect(response.status).toBe(401)
  })

  it("enforces the manifest PUT count with a 429 that names the limit", async () => {
    const { app } = apiFor(stubReader(), { maxManifestPutsPerSignerPerDay: 2 })
    const { client, seen } = watchingClient(app)
    await expect(client.putAgentManifest(envelope())).resolves.toBeDefined()
    await expect(client.putAgentManifest(envelope())).resolves.toBeDefined()
    await expect(client.putAgentManifest(envelope())).rejects.toThrowError(/429/)
    expect(seen.status).toBe(429)
    expect(seen.body).toContain("maxManifestPutsPerSignerPerDay")
  })

  it("a repeated content-addressed manifest PUT is a no-op that does not count", async () => {
    const { app, store } = apiFor(stubReader(), { maxManifestPutsPerSignerPerDay: 1 })
    const client = clientFor(app)
    const env = envelope()
    const first = await client.putAgentManifest(env)
    // With the daily cap at one, a repeat that counted would already be refused — the no-op is free.
    const second = await client.putAgentManifest(env)
    expect(second).toEqual(first)
    expect(await store.getManifestIndex(first.bodyHash)).toMatchObject({ envelopeHash: first.envelopeHash })
  })

  it("the injected per-IP limiter gates every route with a 429 and Retry-After", async () => {
    const checked: Array<{ ip: string; signed: boolean }> = []
    let allow = true
    const { app } = apiFor(stubReader(), undefined, {
      check: async (input) => {
        checked.push(input)
        return allow
      },
    })
    const client = clientFor(app)
    // Signed requests count against the signed bucket, unsigned ones against the other; the key is
    // the CF-Connecting-IP the edge supplies, or "unknown" behind a plain server.
    await expect(client.putAgentManifest(envelope())).resolves.toBeDefined()
    await app.request(`http://mida.test/agent-manifests/${hexOf(randomBytes(32))}`, { headers: { "cf-connecting-ip": "203.0.113.7" } })
    expect(checked).toEqual([
      { ip: "unknown", signed: true },
      { ip: "203.0.113.7", signed: false },
    ])

    allow = false
    const denied = await app.request(`http://mida.test/agent-manifests/${hexOf(randomBytes(32))}`)
    expect(denied.status).toBe(429)
    expect(denied.headers.get("retry-after")).toBe("60")
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "RATE_LIMITED" } })
    await expect(client.putObject(upload(randomBytes(8)))).rejects.toThrowError(/429/)
  })

  it("a malformed request makes zero reader calls and zero store calls", async () => {
    const calls: string[] = []
    const spying = <T extends object>(target: T, prefix: string): T =>
      new Proxy(target, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver)
          return typeof value === "function"
            ? (...args: unknown[]) => {
                calls.push(`${prefix}.${String(property)}`)
                return (value as (...a: unknown[]) => unknown).apply(target, args)
              }
            : value
        },
      })
    const inner = fileStores(mkdtempSync(join(tmpdir(), "mida-cheap-")))
    const stores: ContextStores = {
      objects: spying(inner.objects, "objects"),
      nonces: spying(inner.nonces, "nonces"),
      denies: spying(inner.denies, "denies"),
    }
    const reader = spying(stubReader(), "reader") as RegistryReader
    const { app } = createContextApi({ reader, deployment, stores, clock: () => NOW })
    calls.length = 0 // construction-time reads (e.g. the deny overlay's file) are not under test

    // No auth headers at all.
    expect((await app.request("http://mida.test/objects", { method: "PUT", body: "{}" })).status).toBe(401)
    // Auth headers present but malformed.
    expect(
      (
        await app.request("http://mida.test/objects", {
          method: "PUT",
          headers: { "x-mida-signer": "not-an-address", "x-mida-timestamp": "1", "x-mida-nonce": "0x", "x-mida-signature": "0x" },
          body: "{}",
        })
      ).status,
    ).toBe(401)
    // Well-formed signed headers but a body that is not JSON: the parse is checked before the signature.
    const tampering = clientFor(app, async (url, init) => app.request(url, { ...init, body: "this is not json{" }))
    await expect(tampering.request("PUT", "/objects", { body: { pad: "x" } })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    // An honest over-cap declaration is refused at the byte cap, before signature recovery.
    expect(
      (
        await app.request("http://mida.test/objects", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "content-length": "1048577",
            "x-mida-signer": account.address,
            "x-mida-timestamp": NOW.toString(10),
            "x-mida-nonce": `0x${"0".repeat(64)}`,
            "x-mida-signature": `0x${"0".repeat(130)}`,
          },
          body: "{}",
        })
      ).status,
    ).toBe(413)
    // A garbage body hash on the anonymous manifest read.
    expect((await app.request("http://mida.test/agent-manifests/0xnothex")).status).toBe(400)

    expect(calls).toEqual([])
  })
})
