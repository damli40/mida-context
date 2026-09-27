import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { P256_N, PERMISSION, encodeUint64, isMidaError, namespaceId, sortScopes } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap, UnsignedAccessRequest } from "@mida/protocol"
import {
  bytesOf,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  hexOf,
  manifestHash,
  openContextObject,
  prfSalt,
  unwrapEpochPrivateKey,
} from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  capabilityRegistryAbi,
  contextRegistryAbi,
  createWriteContext,
  deployLocal,
  latestTimestamp,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, WriteContext } from "@mida/chain"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js"
import { p256 } from "@noble/curves/nist.js"
import { P256, WebAuthnP256 } from "ox"
import {
  FakeVaultAuthority,
  buildSignedAccessRequest,
  completeVaultAssertion,
  p256PublicKey,
  provisionAgent,
  signVaultAssertion,
  vaultSignPayload,
} from "@mida/fake-vault"
import type { ProvisionedAgent, VaultContextApi } from "@mida/fake-vault"

const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`
const CAREER = namespaceId("goals.career")
const FINANCIAL = namespaceId("financial")

interface Recorded {
  uploads: Array<{ manifest: ObjectManifest; ciphertext: Hex; owner: Address; namespaceId: Hex }>
  wraps: ReaderEpochWrap[]
  denies: Array<{ target: unknown; chainStillAuthorized: boolean }>
}

describe("FakeVaultAuthority (plan Task 22)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: WriteContext
  let vault: FakeVaultAuthority
  let agentA: ProvisionedAgent
  let agentB: ProvisionedAgent
  let capabilityA: Hex
  const recorded: Recorded = { uploads: [], wraps: [], denies: [] }
  const approvals: unknown[] = []

  const read = <T>(functionName: string, args: readonly unknown[]) =>
    owner.publicClient.readContract({ address: deployment.capabilityRegistry, abi: capabilityRegistryAbi, functionName, args } as never) as Promise<T>

  const api: VaultContextApi = {
    putObject: async (upload) => void recorded.uploads.push(upload),
    publishEpochWrap: async (wrap) => void recorded.wraps.push(wrap),
    requestRevocationDeny: async (target) => {
      const chainStillAuthorized = await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, CAREER, PERMISSION.READ])
      recorded.denies.push({ target, chainStillAuthorized })
      return { intentId: hexOf(randomBytes(32)), cancellationNonce: "1" }
    },
    cancelRevocation: async () => ({}),
  }

  const signedRequest = (
    agent: ProvisionedAgent,
    scopes: Array<{ namespace: string; permissions: number; provenancePolicy?: number }>,
    overrides: Partial<UnsignedAccessRequest> = {},
  ) => buildSignedAccessRequest({ chain: owner, agent, scopes, overrides })

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api })
    const operatorA = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!) })
    const operatorB = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[3]!) })
    const declarations = [
      { namespace: "goals.career", permissions: ["READ" as const] },
      { namespace: "financial", permissions: ["READ" as const] },
    ]
    agentA = await provisionAgent({ operator: operatorA, name: "CareerAI", purposeId: "career_coaching", declarations, callbackOrigin: "https://career.example" })
    agentB = await provisionAgent({ operator: operatorB, name: "Bystander", purposeId: "career_coaching", declarations, callbackOrigin: "https://bystander.example" })
  }, 180_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("derives one domain's PRF output from the seed and exposes no seed or global root", async () => {
    const expected = deriveNamespaceSecret(hmac(sha256, SEED, prfSalt("general")), CAREER)
    expect(await vault.deriveNamespaceSecret(CAREER)).toEqual(expected)
    const sameSeed = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api })
    expect(await sameSeed.deriveNamespaceSecret(CAREER)).toEqual(expected)
    const financialExpected = deriveNamespaceSecret(hmac(sha256, SEED, prfSalt("financial")), FINANCIAL)
    expect(await vault.deriveNamespaceSecret(FINANCIAL)).toEqual(financialExpected)
    const otherSeed = new FakeVaultAuthority({ seed: new Uint8Array(32).fill(0x43), p256PrivateKey: P256_KEY, chain: owner, api })
    expect(hexOf(await otherSeed.deriveNamespaceSecret(CAREER))).not.toBe(hexOf(expected))
    expect(Object.keys(vault)).toEqual(["owner"])
  })

  it("refuses a deployment whose POLICY_HASH_V1 differs from the TypeScript policy", () => {
    const wrongPolicy = { ...owner, deployment: { ...deployment, policyHashV1: zeroHash } }
    expect(() => new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: wrongPolicy, api })).toThrow(
      expect.objectContaining({ code: "POLICY_VERSION_UNSUPPORTED" }),
    )
  })

  it("registers the owner P256 key and publishes the derived epoch-1 public key", async () => {
    await vault.registerOwnerKey()
    await vault.initializeNamespace("Goals.Career")
    const [qx, qy] = await read<readonly [bigint, bigint]>("ownerP256Key", [vault.owner])
    expect({ qx, qy }).toEqual(p256PublicKey(P256_KEY))
    const derived = deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n)
    expect(await read<Hex>("epochPublicKey", [vault.owner, CAREER, 1n])).toBe(hexOf(derived.publicKey))
  })

  it("publishes no reader wrap before the chain holds a READ capability", async () => {
    await expect(vault.publishReaderWraps({ agentId: agentB.agentId, namespaceId: CAREER })).rejects.toSatisfy((error: unknown) =>
      isMidaError(error, "CAPABILITY_DENIED"),
    )
    expect(recorded.wraps).toHaveLength(0)
  })

  it("advises, binds the passkey assertion, grants only READ goals.career and wraps epoch 1 to Agent A", async () => {
    const request = await signedRequest(agentA, [
      { namespace: "goals.career", permissions: PERMISSION.READ },
      { namespace: "financial", permissions: PERMISSION.READ },
    ])
    const approval = await vault.approveGrant({ accessRequest: request, manifest: agentA.manifest, selection: { kind: "recommended" } })
    approvals.push(approval)
    expect(approval.advice.recommended).toEqual([{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }])
    const financialWarnings = approval.advice.warnings.filter((w) => w.namespaceId === FINANCIAL).map((w) => w.code)
    expect(financialWarnings).toEqual(expect.arrayContaining(["HIGH_SENSITIVITY", "SCOPE_SUSPICIOUS"]))
    expect(approval.response.capabilities).toHaveLength(1)
    expect(approval.response.capabilities[0]).toMatchObject({ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 })
    capabilityA = approval.response.capabilities[0]!.capabilityId

    expect(await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, CAREER, PERMISSION.READ])).toBe(true)
    expect(await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, FINANCIAL, PERMISSION.READ])).toBe(false)
    expect(await read<bigint>("grantNonce", [vault.owner])).toBe(1n)

    expect(recorded.wraps).toHaveLength(1)
    const wrap = recorded.wraps[0]!
    expect(wrap).toMatchObject({ agentId: agentA.agentId, readEpoch: "1", agentKeyVersion: 1, namespaceId: CAREER })
    const unwrapped = unwrapEpochPrivateKey({
      wrap,
      agentEncryptionPrivateKey: agentA.encryptionPrivateKey,
      binding: {
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        owner: vault.owner,
        namespaceId: CAREER,
        readEpoch: 1n,
        agentId: agentA.agentId,
        agentKeyVersion: 1,
      },
    })
    expect(unwrapped).toEqual(deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n).privateKey)
    expect(() =>
      unwrapEpochPrivateKey({
        wrap,
        agentEncryptionPrivateKey: agentB.encryptionPrivateKey,
        binding: {
          chainId: deployment.chainId,
          capabilityRegistry: deployment.capabilityRegistry,
          owner: vault.owner,
          namespaceId: CAREER,
          readEpoch: 1n,
          agentId: agentA.agentId,
          agentKeyVersion: 1,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "DECRYPT_FAILED" }))
  })

  it("refuses a request aimed at another chain before any chain write", async () => {
    const request = await signedRequest(agentA, [{ namespace: "goals.career", permissions: PERMISSION.READ }], { chainId: "10143" })
    await expect(vault.approveGrant({ accessRequest: request, manifest: agentA.manifest, selection: { kind: "recommended" } })).rejects.toSatisfy(
      (error: unknown) => isMidaError(error, "INVALID_WIRE"),
    )
    expect(await read<bigint>("grantNonce", [vault.owner])).toBe(1n)
  })

  it("rejects a custom selection broader than the signed request before any chain write", async () => {
    const request = await signedRequest(agentA, [{ namespace: "goals.career", permissions: PERMISSION.READ }])
    const broader = sortScopes([
      { namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 },
      { namespaceId: FINANCIAL, permissions: PERMISSION.READ, provenancePolicy: 0 },
    ])
    const expiresAt = (await latestTimestamp(owner)) + 3_600n
    await expect(
      vault.approveGrant({ accessRequest: request, manifest: agentA.manifest, selection: { kind: "custom", scopes: broader, expiresAt } }),
    ).rejects.toSatisfy((error: unknown) => isMidaError(error, "RESPONSE_MISMATCH"))
    expect(await read<bigint>("grantNonce", [vault.owner])).toBe(1n)
  })

  it("an expired request refuses BEFORE the revocation-history reads — zero scan calls (in-15 J-2)", async () => {
    // Sep 27 live: `approve --all` printed "checking devin's history on the chain (about 928
    // requests)…" and only then answered REQUEST_EXPIRED. The expiry window needs only the
    // request and the chain's clock — one getBlock — so every read past that is counted here.
    let logScans = 0
    let epochReads = 0
    const counting = new Proxy(owner.publicClient, {
      get(target, prop, receiver) {
        if (prop === "getLogs") {
          return async (...args: unknown[]) => {
            logScans += 1
            return (target.getLogs as (...a: never[]) => Promise<unknown>)(...(args as never[]))
          }
        }
        if (prop === "readContract") {
          return async (parameters: { functionName?: string }) => {
            if (parameters.functionName === "agentEpoch") epochReads += 1
            return target.readContract(parameters as never)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const countingVault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: { ...owner, publicClient: counting }, api })
    const expired = await signedRequest(agentB, [{ namespace: "goals.career", permissions: PERMISSION.READ }], {
      requestExpiresAt: encodeUint64((await latestTimestamp(owner)) - 60n),
    })
    await expect(
      countingVault.approveGrant({ accessRequest: expired, manifest: agentB.manifest, selection: { kind: "recommended" } }),
    ).rejects.toSatisfy((error: unknown) => isMidaError(error, "REQUEST_EXPIRED"))
    expect(logScans).toBe(0)
    expect(epochReads).toBe(0)
  })

  it("uploads owner ciphertext first, then anchors matching commitments that decrypt under epoch 1", async () => {
    const created = await vault.createOwnerContext({
      namespace: "goals.career",
      payload: { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } },
    })
    const upload = recorded.uploads.at(-1)!
    expect(upload.manifest.contextId).toBe(created.contextId)
    const record = (await owner.publicClient.readContract({
      address: deployment.contextRegistry,
      abi: contextRegistryAbi,
      functionName: "getRecord",
      args: [created.contextId],
    })) as { manifestHash: Hex; ciphertextCommitment: Hex; author: Hex; readEpoch: bigint }
    expect(record.manifestHash).toBe(manifestHash(upload.manifest))
    expect(record.ciphertextCommitment).toBe(upload.manifest.ciphertextHash)
    expect(record.author).toBe(zeroHash)
    const payload = openContextObject({
      manifest: upload.manifest,
      expectedManifestHash: record.manifestHash,
      ciphertext: bytesOf(upload.ciphertext, upload.manifest.ciphertextSize),
      epochPrivateKey: deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n).privateKey,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: created.contextId, namespaceId: CAREER, readEpoch: 1n },
    })
    expect(payload.value).toBe("Prioritize systems engineering")
  })

  it("posts the fast deny while the chain still authorizes, then revokes and rotates goals.career to epoch 2", async () => {
    const approval = await vault.approveRevocation({ kind: "capability", capabilityId: capabilityA })
    approvals.push(approval)
    expect(recorded.denies).toEqual([{ target: { capabilityId: capabilityA }, chainStillAuthorized: true }])
    expect(approval.rotated).toEqual([{ namespaceId: CAREER, readEpoch: 2n }])
    expect(await read<boolean>("isAuthorized", [vault.owner, agentA.agentId, CAREER, PERMISSION.READ])).toBe(false)
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, CAREER])).toBe(2n)
    const epoch2 = deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 2n)
    expect(await read<Hex>("epochPublicKey", [vault.owner, CAREER, 2n])).toBe(hexOf(epoch2.publicKey))
  })

  it("never places a namespace secret or epoch private key in an approval, wrap or upload", async () => {
    const secret = await vault.deriveNamespaceSecret(CAREER)
    const forbidden = [secret, deriveEpochKeyPair(secret, 1n).privateKey, deriveEpochKeyPair(secret, 2n).privateKey].map((bytes) =>
      hexOf(bytes).slice(2),
    )
    const serialized = JSON.stringify([approvals, recorded], (_key, value) => (typeof value === "bigint" ? value.toString() : value))
    for (const hex of forbidden) expect(serialized.includes(hex)).toBe(false)
  })
})

describe("FakeVault assertion construction (spec §8, §10.4)", () => {
  const KEY: Hex = `0x${"4d".repeat(32)}`
  const OTHER_KEY: Hex = `0x${"4e".repeat(32)}`
  const CHALLENGE: Hex = `0x${"ab".repeat(32)}`
  const RP_ID = "vault.mida.xyz"
  const ORIGIN = "https://vault.mida.xyz"
  const bytes32 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

  it("signs the ox signing digest with noble, emits low-s, and passes WebAuthnP256.verify", () => {
    const auth = signVaultAssertion({ challenge: CHALLENGE, privateKey: KEY, rpId: RP_ID, origin: ORIGIN })
    expect(auth.s <= P256_N / 2n).toBe(true)
    const { metadata } = WebAuthnP256.getSignPayload({ challenge: CHALLENGE, rpId: RP_ID, origin: ORIGIN, userVerification: "required" })
    expect(auth.authenticatorData).toBe(metadata.authenticatorData)
    expect(auth.clientDataJSON).toBe(metadata.clientDataJSON)
    const signature = { r: bytes32(auth.r), s: bytes32(auth.s), yParity: 0 }
    const publicKey = P256.getPublicKey({ privateKey: KEY })
    expect(WebAuthnP256.verify({ challenge: CHALLENGE, metadata, publicKey, rpId: RP_ID, origin: ORIGIN, signature })).toBe(true)
  })

  it("normalizes a forced high-s raw signature through the shared adapter", () => {
    const { metadata, digest } = vaultSignPayload({ challenge: CHALLENGE, rpId: RP_ID, origin: ORIGIN })
    const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(KEY.slice(2)), { prehash: false })
    const r = BigInt(`0x${bytesToHex(raw.slice(0, 32))}`)
    const lowS = BigInt(`0x${bytesToHex(raw.slice(32))}`)
    const highS = P256_N - lowS
    expect(highS > P256_N / 2n).toBe(true)
    const auth = completeVaultAssertion({ challenge: CHALLENGE, metadata, r, s: highS, publicKey: p256PublicKey(KEY), rpId: RP_ID, origin: ORIGIN })
    expect(auth.s).toBe(lowS)
    expect(auth.r).toBe(r)
  })

  it("refuses to return an assertion that WebAuthnP256.verify rejects", () => {
    const { metadata, digest } = vaultSignPayload({ challenge: CHALLENGE, rpId: RP_ID, origin: ORIGIN })
    const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(KEY.slice(2)), { prehash: false })
    const r = BigInt(`0x${bytesToHex(raw.slice(0, 32))}`)
    const s = BigInt(`0x${bytesToHex(raw.slice(32))}`)
    expect(() =>
      completeVaultAssertion({ challenge: CHALLENGE, metadata, r, s, publicKey: p256PublicKey(OTHER_KEY), rpId: RP_ID, origin: ORIGIN }),
    ).toThrow(expect.objectContaining({ code: "AUTH_INVALID" }))
    expect(() =>
      completeVaultAssertion({ challenge: `0x${"ac".repeat(32)}`, metadata, r, s, publicKey: p256PublicKey(KEY), rpId: RP_ID, origin: ORIGIN }),
    ).toThrow(expect.objectContaining({ code: "AUTH_INVALID" }))
  })
})
