import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { MidaError, P256_N, PERMISSION, cancelFastRevokeDigest, namespaceId, sortScopes } from "@mida/protocol"
import type { Hex, ReaderEpochWrap } from "@mida/protocol"
import { deriveEpochKeyPair, hexOf, unwrapEpochPrivateKey } from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  SponsorPending,
  capabilityRegistryAbi,
  createWriteContext,
  deployLocal,
  increaseLocalTime,
  latestTimestamp,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, WriteContext } from "@mida/chain"
import { randomBytes } from "@noble/hashes/utils.js"
import { P256, WebAuthnP256 } from "ox"
import { FakeVaultAuthority, buildSignedAccessRequest, provisionAgent } from "@mida/fake-vault"
import type { ProvisionedAgent, VaultContextApi } from "@mida/fake-vault"

const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`
const CAREER = namespaceId("goals.career")
const SKILLS = namespaceId("profile.skills")
const PROJECTS = namespaceId("projects.current")

describe("FakeVaultAuthority revocation paths (plan Task 22 review)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: WriteContext
  let vault: FakeVaultAuthority
  let agentC: ProvisionedAgent
  let agentD: ProvisionedAgent
  let agentE: ProvisionedAgent
  const wraps: ReaderEpochWrap[] = []
  const denies: Array<{ target: unknown; stillValid?: boolean; stillActive?: number }> = []

  const read = <T>(functionName: string, args: readonly unknown[]) =>
    owner.publicClient.readContract({ address: deployment.capabilityRegistry, abi: capabilityRegistryAbi, functionName, args } as never) as Promise<T>

  const api: VaultContextApi = {
    putObject: async () => {},
    publishEpochWrap: async (wrap) => void wraps.push(wrap),
    // The deny is posted before the chain write, so the record proves the pre-revocation state.
    requestRevocationDeny: async (target) => {
      if ("capabilityId" in target) {
        denies.push({ target, stillValid: await read<boolean>("isCapabilityValid", [target.capabilityId]) })
      } else {
        const ids = await read<readonly Hex[]>("activeCapabilityIds", [target.owner, target.agentId])
        denies.push({ target, stillActive: ids.length })
      }
      return { intentId: hexOf(randomBytes(32)), cancellationNonce: "1" }
    },
    cancelRevocation: async () => ({}),
  }

  const signedRequest = (
    agent: ProvisionedAgent,
    scopes: Array<{ namespace: string; permissions: number; provenancePolicy?: number }>,
  ) => buildSignedAccessRequest({ chain: owner, agent, scopes })

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await vault.initializeNamespace("profile.skills")
    await vault.initializeNamespace("projects.current")
    const operatorC = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!) })
    const operatorD = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[3]!) })
    const operatorE = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[4]!) })
    agentC = await provisionAgent({
      operator: operatorC,
      name: "MultiScope",
      purposeId: "career_coaching",
      declarations: [
        { namespace: "goals.career", permissions: ["READ"] },
        { namespace: "profile.skills", permissions: ["READ"] },
        { namespace: "projects.current", permissions: ["CREATE"] },
      ],
      callbackOrigin: "https://multi.example",
    })
    agentD = await provisionAgent({
      operator: operatorD,
      name: "NarrowAgent",
      purposeId: "career_coaching",
      declarations: [
        { namespace: "projects.current", permissions: ["CREATE"] },
        { namespace: "profile.skills", permissions: ["READ"] },
      ],
      callbackOrigin: "https://narrow.example",
    })
    agentE = await provisionAgent({
      operator: operatorE,
      name: "Regrant",
      purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["READ"] }],
      callbackOrigin: "https://regrant.example",
    })
  }, 600_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("revokes an agent across its live READ namespaces and leaves CREATE-only authority unrotated", async () => {
    const now = await latestTimestamp(owner)
    const request = await signedRequest(agentC, [
      { namespace: "goals.career", permissions: PERMISSION.READ },
      { namespace: "profile.skills", permissions: PERMISSION.READ },
      { namespace: "projects.current", permissions: PERMISSION.CREATE },
    ])
    await vault.approveGrant({
      accessRequest: request,
      manifest: agentC.manifest,
      selection: {
        kind: "custom",
        scopes: sortScopes([
          { namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 },
          { namespaceId: SKILLS, permissions: PERMISSION.READ, provenancePolicy: 0 },
          { namespaceId: PROJECTS, permissions: PERMISSION.CREATE, provenancePolicy: 0 },
        ]),
        expiresAt: now + 3_600n,
      },
    })
    expect(await read<bigint>("agentEpoch", [vault.owner, agentC.agentId])).toBe(0n)
    expect(await read<readonly Hex[]>("activeCapabilityIds", [vault.owner, agentC.agentId])).toHaveLength(3)

    const approval = await vault.approveRevocation({ kind: "agent", agentId: agentC.agentId })
    expect(approval.rotated).toHaveLength(2)
    expect(approval.rotated).toEqual(
      expect.arrayContaining([
        { namespaceId: CAREER, readEpoch: 2n },
        { namespaceId: SKILLS, readEpoch: 2n },
      ]),
    )
    expect(denies.at(-1)).toEqual({ target: { owner: vault.owner, agentId: agentC.agentId }, stillActive: 3 })
    expect(await read<bigint>("agentEpoch", [vault.owner, agentC.agentId])).toBe(1n)
    expect(await read<readonly Hex[]>("activeCapabilityIds", [vault.owner, agentC.agentId])).toHaveLength(0)
    for (const [ns, permission] of [
      [CAREER, PERMISSION.READ],
      [SKILLS, PERMISSION.READ],
      [PROJECTS, PERMISSION.CREATE],
    ] as const) {
      expect(await read<boolean>("isAuthorized", [vault.owner, agentC.agentId, ns, permission])).toBe(false)
    }
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, CAREER])).toBe(2n)
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, SKILLS])).toBe(2n)
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, PROJECTS])).toBe(1n)
    for (const ns of [CAREER, SKILLS]) {
      const epoch2 = deriveEpochKeyPair(await vault.deriveNamespaceSecret(ns), 2n)
      expect(await read<Hex>("epochPublicKey", [vault.owner, ns, 2n])).toBe(hexOf(epoch2.publicKey))
    }
    expect(await read<Hex>("epochPublicKey", [vault.owner, PROJECTS, 2n])).toBe(zeroHash)
  })

  it("revokes a CREATE-only capability without rotating its read epoch", async () => {
    const now = await latestTimestamp(owner)
    const request = await signedRequest(agentD, [{ namespace: "projects.current", permissions: PERMISSION.CREATE }])
    const approval = await vault.approveGrant({
      accessRequest: request,
      manifest: agentD.manifest,
      selection: {
        kind: "custom",
        scopes: [{ namespaceId: PROJECTS, permissions: PERMISSION.CREATE, provenancePolicy: 0 }],
        expiresAt: now + 3_600n,
      },
    })
    const capabilityId = approval.response.capabilities[0]!.capabilityId
    expect(await read<boolean>("isAuthorized", [vault.owner, agentD.agentId, PROJECTS, PERMISSION.CREATE])).toBe(true)
    expect(wraps.filter((wrap) => wrap.agentId === agentD.agentId)).toHaveLength(0)

    const revoke = await vault.approveRevocation({ kind: "capability", capabilityId })
    expect(revoke.rotated).toEqual([])
    expect(denies.at(-1)).toEqual({ target: { capabilityId }, stillValid: true })
    expect(await read<boolean>("isAuthorized", [vault.owner, agentD.agentId, PROJECTS, PERMISSION.CREATE])).toBe(false)
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, PROJECTS])).toBe(1n)
    expect(await read<Hex>("epochPublicKey", [vault.owner, PROJECTS, 2n])).toBe(zeroHash)
  })

  it("revokes an expired READ capability without rotating its read epoch", async () => {
    const now = await latestTimestamp(owner)
    const request = await signedRequest(agentD, [{ namespace: "profile.skills", permissions: PERMISSION.READ }])
    const approval = await vault.approveGrant({
      accessRequest: request,
      manifest: agentD.manifest,
      selection: {
        kind: "custom",
        scopes: [{ namespaceId: SKILLS, permissions: PERMISSION.READ, provenancePolicy: 0 }],
        expiresAt: now + 60n,
      },
    })
    const capabilityId = approval.response.capabilities[0]!.capabilityId
    // Wraps for both registered epochs were published while the READ capability was live.
    const skillsWraps = wraps.filter((wrap) => wrap.agentId === agentD.agentId && wrap.namespaceId === SKILLS)
    expect(skillsWraps.map((wrap) => wrap.readEpoch).sort()).toEqual(["1", "2"])
    await increaseLocalTime(node.rpcUrl, 120n)
    expect(await read<boolean>("isCapabilityValid", [capabilityId])).toBe(false)

    const revoke = await vault.approveRevocation({ kind: "capability", capabilityId })
    expect(revoke.rotated).toEqual([])
    expect(denies.at(-1)).toEqual({ target: { capabilityId }, stillValid: false })
    expect(await read<boolean>("isAuthorized", [vault.owner, agentD.agentId, SKILLS, PERMISSION.READ])).toBe(false)
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, SKILLS])).toBe(2n)
  })

  it("returns a verifiable wire assertion for deny cancellation", async () => {
    const revocationIntentId = hexOf(randomBytes(32))
    const apiCancellationNonce = 7n
    const expiresAt = (await latestTimestamp(owner)) + 300n
    const wire = vault.approveDenyCancellation({ revocationIntentId, apiCancellationNonce, expiresAt })
    expect(wire.r).toMatch(/^0x[0-9a-f]{64}$/)
    expect(wire.s).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(wire.s) <= P256_N / 2n).toBe(true)
    expect(wire.challengeIndex).toMatch(/^(0|[1-9][0-9]*)$/)
    expect(wire.typeIndex).toMatch(/^(0|[1-9][0-9]*)$/)
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner: vault.owner,
      revocationIntentId,
      apiCancellationNonce,
      expiresAt,
    })
    const verified = WebAuthnP256.verify({
      challenge,
      metadata: {
        authenticatorData: wire.authenticatorData,
        clientDataJSON: wire.clientDataJSON,
        challengeIndex: Number(wire.challengeIndex),
        typeIndex: Number(wire.typeIndex),
        userVerificationRequired: true,
      },
      publicKey: P256.getPublicKey({ privateKey: P256_KEY }),
      rpId: "vault.mida.xyz",
      origin: "https://vault.mida.xyz",
      signature: { r: wire.r, s: wire.s, yParity: 0 },
    })
    expect(verified).toBe(true)
  })

  it("publishes a wrap for every registered epoch when READ is re-granted after a rotation", async () => {
    const first = await signedRequest(agentE, [{ namespace: "goals.career", permissions: PERMISSION.READ }])
    const grant1 = await vault.approveGrant({ accessRequest: first, manifest: agentE.manifest, selection: { kind: "recommended" } })
    const firstWraps = wraps.filter((wrap) => wrap.agentId === agentE.agentId && wrap.namespaceId === CAREER)
    expect(firstWraps.map((wrap) => wrap.readEpoch).sort()).toEqual(["1", "2"])

    const revoke = await vault.approveRevocation({ kind: "capability", capabilityId: grant1.response.capabilities[0]!.capabilityId })
    expect(revoke.rotated).toEqual([{ namespaceId: CAREER, readEpoch: 3n }])
    expect(await read<bigint>("requiredReadEpoch", [vault.owner, CAREER])).toBe(3n)

    const second = await signedRequest(agentE, [{ namespace: "goals.career", permissions: PERMISSION.READ }])
    await vault.approveGrant({ accessRequest: second, manifest: agentE.manifest, selection: { kind: "recommended" } })
    const allWraps = wraps.filter((wrap) => wrap.agentId === agentE.agentId && wrap.namespaceId === CAREER)
    expect(allWraps.map((wrap) => wrap.readEpoch).sort()).toEqual(["1", "1", "2", "2", "3"])

    const secret = await vault.deriveNamespaceSecret(CAREER)
    for (const wrap of allWraps) {
      const epoch = BigInt(wrap.readEpoch)
      const unwrapped = unwrapEpochPrivateKey({
        wrap,
        agentEncryptionPrivateKey: agentE.encryptionPrivateKey,
        binding: {
          chainId: deployment.chainId,
          capabilityRegistry: deployment.capabilityRegistry,
          owner: vault.owner,
          namespaceId: CAREER,
          readEpoch: epoch,
          agentId: agentE.agentId,
          agentKeyVersion: 1,
        },
      })
      expect(unwrapped).toEqual(deriveEpochKeyPair(secret, epoch).privateKey)
    }
  })

  // --- M3-D4 item 1: a deny whose send never happened must not survive ---

  /** The store's half of the handshake, faithfully: a fresh nonce per intent, and a cancel that verifies exactly like app.ts does. */
  const denyStore = () => {
    const intents = new Map<string, { nonce: bigint; cancelled: boolean }>()
    const cancels: { intentId: Hex; expiresAt: bigint }[] = []
    const storeApi: VaultContextApi = {
      putObject: async () => {},
      publishEpochWrap: async () => {},
      requestRevocationDeny: async () => {
        const intentId = hexOf(randomBytes(32))
        const nonce = BigInt(hexOf(randomBytes(32)))
        intents.set(intentId, { nonce, cancelled: false })
        return { intentId, cancellationNonce: nonce.toString(10) }
      },
      cancelRevocation: async (intentId, { expiresAt, assertion }) => {
        cancels.push({ intentId, expiresAt })
        const intent = intents.get(intentId)
        if (intent === undefined || intent.cancelled) throw new MidaError("REPLAY", "revocation intent is not cancellable")
        const verified = WebAuthnP256.verify({
          challenge: cancelFastRevokeDigest({
            chainId: deployment.chainId,
            capabilityRegistry: deployment.capabilityRegistry,
            owner: vault.owner,
            revocationIntentId: intentId,
            apiCancellationNonce: intent.nonce,
            expiresAt,
          }),
          metadata: {
            authenticatorData: assertion.authenticatorData,
            clientDataJSON: assertion.clientDataJSON,
            challengeIndex: Number(assertion.challengeIndex),
            typeIndex: Number(assertion.typeIndex),
            userVerificationRequired: true,
          },
          publicKey: P256.getPublicKey({ privateKey: P256_KEY }),
          rpId: "vault.mida.xyz",
          origin: "https://vault.mida.xyz",
          signature: { r: assertion.r, s: assertion.s, yParity: 0 },
        })
        if (!verified) throw new MidaError("AUTH_INVALID", "cancellation assertion does not verify")
        intent.cancelled = true
        return { intentId, state: "cancelled" }
      },
    }
    return { api: storeApi, intents, cancels }
  }

  /** A write context whose send is refused inside `beforeSend` — provably before any broadcast. */
  const deadSend = () => {
    const context = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    context.beforeSend = async () => {
      throw new MidaError("OWNER_WALLET_LOW", "test: refused before the send")
    }
    return context
  }

  it("undoes its own deny when the send never happened — capability branch", async () => {
    const store = denyStore()
    const broken = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: deadSend(), api: store.api })
    // a CREATE capability: the skills epoch closed with agentD's expired READ, so a READ grant
    // would need a rotation first — CREATE grants fine and exercises the same undo path
    const request = await signedRequest(agentD, [{ namespace: "projects.current", permissions: PERMISSION.CREATE }])
    const grant = await vault.approveGrant({
      accessRequest: request,
      manifest: agentD.manifest,
      selection: { kind: "custom", scopes: [{ namespaceId: PROJECTS, permissions: PERMISSION.CREATE, provenancePolicy: 0 }], expiresAt: (await latestTimestamp(owner)) + 3_600n },
    })
    const capabilityId = grant.response.capabilities[0]!.capabilityId

    const before = BigInt(Math.floor(Date.now() / 1000))
    const error = await broken.approveRevocation({ kind: "capability", capabilityId }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MidaError)
    expect((error as MidaError).code).toBe("OWNER_WALLET_LOW")
    expect(store.cancels).toHaveLength(1)
    // the fake cancelled only after the assertion verified — the signature the vault produced is the real one
    expect(store.intents.get(store.cancels[0]!.intentId)?.cancelled).toBe(true)
    expect(store.cancels[0]!.expiresAt).toBeGreaterThanOrEqual(before + 119n)
    expect(store.cancels[0]!.expiresAt).toBeLessThanOrEqual(before + 121n)
    // and the capability is still live — had the deny survived, it would have been a lie
    expect(await read<boolean>("isCapabilityValid", [capabilityId])).toBe(true)
  })

  it("undoes its own deny when the send never happened — agent branch", async () => {
    const store = denyStore()
    const broken = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: deadSend(), api: store.api })
    // agentE still holds the live goals.career READ the re-grant test above gave it
    const error = await broken.approveRevocation({ kind: "agent", agentId: agentE.agentId }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MidaError)
    expect((error as MidaError).code).toBe("OWNER_WALLET_LOW")
    expect(store.cancels).toHaveLength(1)
    expect(store.intents.get(store.cancels[0]!.intentId)?.cancelled).toBe(true)
    expect(await read<bigint>("agentEpoch", [vault.owner, agentE.agentId])).toBe(0n)
  })

  it("keeps the deny when a sponsored operation was accepted but never confirmed (SponsorPending)", async () => {
    const store = denyStore()
    const pending = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    pending.sponsor = {
      send: async () => {
        throw new SponsorPending(zeroHash)
      },
    }
    const pendingVault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: pending, api: store.api })
    const request = await signedRequest(agentD, [{ namespace: "projects.current", permissions: PERMISSION.CREATE }])
    const grant = await vault.approveGrant({
      accessRequest: request,
      manifest: agentD.manifest,
      selection: { kind: "custom", scopes: [{ namespaceId: PROJECTS, permissions: PERMISSION.CREATE, provenancePolicy: 0 }], expiresAt: (await latestTimestamp(owner)) + 3_600n },
    })
    const capabilityId = grant.response.capabilities[0]!.capabilityId
    const error = await pendingVault.approveRevocation({ kind: "capability", capabilityId }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MidaError)
    expect((error as MidaError).code).toBe("SPONSOR_PENDING")
    // the operation may still land — the deny must stay, so nothing was cancelled
    expect(store.cancels).toHaveLength(0)
    expect([...store.intents.values()].every((intent) => !intent.cancelled)).toBe(true)
  })

  it("surfaces the original send error plus the stale-deny note when the cancel itself fails", async () => {
    const refusing: VaultContextApi = {
      putObject: async () => {},
      publishEpochWrap: async () => {},
      requestRevocationDeny: async () => ({ intentId: hexOf(randomBytes(32)), cancellationNonce: "1" }),
      cancelRevocation: async () => {
        throw new MidaError("AUTH_INVALID", "the store refused the cancel")
      },
    }
    const broken = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: deadSend(), api: refusing })
    const error = await broken
      .approveRevocation({ kind: "agent", agentId: agentD.agentId, name: "codex" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MidaError)
    expect((error as MidaError).code).toBe("OWNER_WALLET_LOW")
    expect((error as Error).message).toContain("the store may still list codex as denied — run `mida approve codex` to clear it")
  })
})
