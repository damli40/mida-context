import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEventLogs, zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { P256_N, PERMISSION, PROVENANCE_POLICY, accessRequestHash, namespaceId, p256RotationDigest } from "@mida/protocol"
import type { Address, Hex, ReaderEpochWrap } from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, hexOf, openContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import { capabilityRegistryAbi, sendContract } from "@mida/chain"
import type { TxKind } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, completeVaultAssertion, p256PublicKey, provisionAgent, vaultSignPayload } from "@mida/fake-vault"
import type { AgentDeclaration, ProvisionedAgent } from "@mida/fake-vault"
import { isScopeSubset } from "@mida/grant-advisor"
import { ContextApiClient, RegistryReader } from "@mida/api"
import type { AnchoredObject } from "@mida/api"
import { MidaAgent } from "@mida/sdk"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js"
import { GAS_NOTE, PRECOMPILE_TRUE, evidencePath, gasFacts, localEnvironment, monadTestnetEnvironment, probeP256Precompile, writeEvidence } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"

const CAREER = namespaceId("goals.career")
const FINANCIAL = namespaceId("financial")
const GOAL_TEXT = "Prioritize systems engineering for the next six months"
const EPOCH_TWO_TEXT = "Epoch two: interviewing with infrastructure teams"
const ON_TESTNET = process.env.MIDA_E2E_MONAD_TESTNET === "1"
const STEP_TIMEOUT = ON_TESTNET ? 300_000 : 60_000

type Label = "A" | "B" | "C" | "D"
interface Actor {
  provisioned: ProvisionedAgent
  sdk: MidaAgent
  api: ContextApiClient
}

const targets = [
  { name: "local Anvil", create: () => localEnvironment() },
  ...(ON_TESTNET ? [{ name: "Monad testnet", create: () => monadTestnetEnvironment() }] : []),
]

describe.each(targets)("§16 end-to-end scenario on $name (plan Tasks 26 and 27)", ({ create }) => {
  let env: ScenarioEnvironment
  let reader: RegistryReader
  let vault: FakeVaultAuthority
  let owner: Address
  let ownerApi: ContextApiClient
  const actors = {} as Record<Label, Actor>
  const transactions: Record<string, Hex> = {}
  const grantBatchGasUsed: Record<string, string> = {}
  let aliceContextId: Hex
  let capabilityA: Hex
  let capabilityC: Hex
  let epoch1WrapForA: ReaderEpochWrap
  let epochTwoContextId: Hex

  const step = (name: string, fn: () => Promise<void>) => it(name, fn, STEP_TIMEOUT)
  const apiFor = (account: LocalAccount) =>
    new ContextApiClient({ baseUrl: env.apiBaseUrl, account, chainId: env.deployment.chainId, capabilityRegistry: env.deployment.capabilityRegistry })
  const agentId = (label: Label) => actors[label].provisioned.agentId
  const readerBinding = (label: Label, readEpoch: bigint) => ({
    chainId: env.deployment.chainId,
    capabilityRegistry: env.deployment.capabilityRegistry,
    owner,
    namespaceId: CAREER,
    readEpoch,
    agentId: agentId(label),
    agentKeyVersion: 1,
  })
  const objectBinding = (contextId: Hex, readEpoch: bigint) => ({
    chainId: env.deployment.chainId,
    contextRegistry: env.deployment.contextRegistry,
    contextId,
    namespaceId: CAREER,
    readEpoch,
  })
  const open = (object: AnchoredObject, epochPrivateKey: Uint8Array, readEpoch: bigint) =>
    openContextObject({
      manifest: object.manifest,
      expectedManifestHash: object.manifestHash,
      ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
      epochPrivateKey,
      binding: objectBinding(object.contextId, readEpoch),
    })
  const ownerObject = async (contextId: Hex) => (await ownerApi.listObjects({ owner, namespaceId: CAREER })).objects.find((o) => o.contextId === contextId)!

  async function provision(label: Label, declarations: AgentDeclaration[]) {
    const operatorAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(operatorAccount.address)
    const provisioned = await provisionAgent({
      operator: env.writeContext(operatorAccount),
      name: `Agent${label}`,
      purposeId: "career_coaching",
      declarations,
      callbackOrigin: `https://agent-${label.toLowerCase()}.example`,
    })
    await env.fund(provisioned.signer.address)
    const api = apiFor(provisioned.signer)
    const sdk = new MidaAgent({
      agentId: provisioned.agentId,
      callbackOrigin: provisioned.callbackOrigin,
      encryptionPrivateKey: provisioned.encryptionPrivateKey,
      chain: env.writeContext(provisioned.signer),
      api,
    })
    actors[label] = { provisioned, sdk, api }
  }

  beforeAll(async () => {
    env = await create()
    const aliceAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(aliceAccount.address)
    const alice = env.writeContext(aliceAccount)
    reader = new RegistryReader(alice)
    ownerApi = apiFor(aliceAccount)
    vault = new FakeVaultAuthority({ seed: randomBytes(32), p256PrivateKey: hexOf(p256.utils.randomSecretKey()), chain: alice, api: ownerApi })
    owner = vault.owner
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await env?.stop()
  })

  step("1. Alice registers her owner P256 key and the goals.career epoch-1 public key", async () => {
    transactions.registerP256Key = await vault.registerOwnerKey()
    transactions.initializeReadEpoch = await vault.initializeNamespace("goals.career")
    expect(await reader.ownerP256Key(owner)).toEqual(vault.p256PublicKey)
    const derived = deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 1n)
    expect(await reader.epochPublicKey(owner, CAREER, 1n)).toBe(hexOf(derived.publicKey))
  })

  step("2. Agents A, B, C and D register signed capability manifests committed in their AgentRecords", async () => {
    await provision("A", [{ namespace: "goals.career", permissions: ["READ"] }, { namespace: "financial", permissions: ["READ"] }])
    await provision("B", [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("C", [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }])
    await provision("D", [{ namespace: "goals.career", permissions: ["READ"] }])
    for (const label of ["A", "B", "C", "D"] as const) {
      const { provisioned } = actors[label]
      expect(await reader.getAgent(provisioned.agentId)).toMatchObject({
        capabilityManifestHash: provisioned.manifestHash,
        capabilityManifestVersion: 1,
        encryptionPublicKey: provisioned.encryptionPublicKey,
        encryptionKeyVersion: 1,
        active: true,
      })
      expect((await ownerApi.putAgentManifest(provisioned.manifest)).bodyHash).toBe(provisioned.manifestHash)
      expect(await ownerApi.getAgentManifest(provisioned.manifestHash)).toEqual(provisioned.manifest)
    }
  })

  step("3. Alice creates encrypted goals.career context under epoch 1, and no plaintext reaches Monad", async () => {
    const created = await vault.createOwnerContext({ namespace: "goals.career", payload: { v: 1, value: GOAL_TEXT, kind: "GOAL", provenance: { source: "USER_ASSERTED" } } })
    aliceContextId = created.contextId
    transactions.aliceContext = created.transactionHash
    expect(await reader.getRecord(created.contextId)).toMatchObject({ owner, author: zeroHash, readEpoch: 1n, version: 1 })
    const transaction = await reader.context.publicClient.getTransaction({ hash: created.transactionHash })
    expect(transaction.input.includes(Buffer.from(GOAL_TEXT, "utf8").toString("hex"))).toBe(false)
  })

  step("4–7. Agent A asks for READ goals.career plus unnecessary READ financial; the Advisor narrows; the passkey binds; the Vault wraps epoch 1 to A", async () => {
    const request = await actors.A.sdk.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }, { namespace: "financial", permissions: PERMISSION.READ }],
    })
    const nonce = () =>
      reader.context.publicClient.readContract({ address: env.deployment.capabilityRegistry, abi: capabilityRegistryAbi, functionName: "grantNonce", args: [owner] })
    const nonceBefore = await nonce()
    const approval = await vault.approveGrant({ accessRequest: request, manifest: actors.A.provisioned.manifest, selection: { kind: "recommended" } })

    // 5. deterministic narrowing with HIGH and suspicious warnings, provably inside the request
    expect(approval.advice.recommended).toEqual([{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }])
    expect(approval.advice.warnings.filter((w) => w.namespaceId === FINANCIAL).map((w) => w.code)).toEqual(expect.arrayContaining(["HIGH_SENSITIVITY", "SCOPE_SUSPICIOUS"]))
    expect(approval.advice.risk).toBe("high")
    expect(isScopeSubset(approval.advice.recommended, request.scopes)).toBe(true)

    // 6. the P256 approval consumed Alice's nonce and bound this exact request
    const { agentSignature: _signature, ...unsigned } = request
    expect(approval.response.requestHash).toBe(accessRequestHash(unsigned))
    expect(await nonce()).toBe(nonceBefore + 1n)
    const grant = await actors.A.sdk.completeAccessRequest(request, approval.response)
    expect(grant.capabilities.map((c) => [c.namespaceId, c.permissions])).toEqual([[CAREER, PERMISSION.READ]])
    expect(await reader.hasAuthority(owner, agentId("A"), FINANCIAL, PERMISSION.READ, 0)).toBe(false)
    capabilityA = grant.capabilities[0]!.capabilityId
    transactions.grantA = approval.response.capabilities[0]!.transactionHash
    grantBatchGasUsed.grantA = approval.gasUsed.toString()

    // 7. exactly one wrap, to A's registered key version
    epoch1WrapForA = await actors.A.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 1n, agentId: agentId("A"), agentKeyVersion: 1, capabilityId: capabilityA })
    expect(epoch1WrapForA).toMatchObject({ agentId: agentId("A"), agentKeyVersion: 1, readEpoch: "1", owner })
  })

  step("8. Agent A verifies the Monad commitments, unwraps its epoch key and decrypts", async () => {
    const objects = await actors.A.sdk.read(owner, "goals.career")
    expect(objects.map((object) => [object.contextId, object.payload.value])).toEqual([[aliceContextId, GOAL_TEXT]])
  })

  step("8b. Agent D, who will remain a reader after A is revoked, is granted READ goals.career", async () => {
    const request = await actors.D.sdk.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    const approval = await vault.approveGrant({ accessRequest: request, manifest: actors.D.provisioned.manifest, selection: { kind: "recommended" } })
    transactions.grantD = approval.response.capabilities[0]!.transactionHash
    await actors.D.sdk.completeAccessRequest(request, approval.response)
    expect((await actors.D.sdk.read(owner, "goals.career")).map((o) => o.payload.value)).toEqual([GOAL_TEXT])
  })

  step("9. Agent B has no grant: denied by the SDK, the API and Monad, and cannot open A's wrap", async () => {
    await expect(actors.B.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(actors.B.api.listObjects({ owner, namespaceId: CAREER, capabilityId: capabilityA })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(
      actors.B.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 1n, agentId: agentId("B"), agentKeyVersion: 1, capabilityId: capabilityA }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    expect(await reader.hasAuthority(owner, agentId("B"), CAREER, PERMISSION.READ, 0)).toBe(false)
    expect(() => unwrapEpochPrivateKey({ wrap: epoch1WrapForA, agentEncryptionPrivateKey: actors.B.provisioned.encryptionPrivateKey, binding: readerBinding("A", 1n) })).toThrow(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    )
  })

  step("10. Agent C receives an advised exact CREATE goals.career grant without READ", async () => {
    const request = await actors.C.sdk.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    })
    const approval = await vault.approveGrant({ accessRequest: request, manifest: actors.C.provisioned.manifest, selection: { kind: "recommended" } })
    expect(approval.advice.recommended).toEqual([{ namespaceId: CAREER, permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }])
    const grant = await actors.C.sdk.completeAccessRequest(request, approval.response)
    capabilityC = grant.capabilities[0]!.capabilityId
    grantBatchGasUsed.grantC = approval.gasUsed.toString()
    transactions.grantC = grant.capabilities[0]!.transactionHash
    expect(await reader.hasAuthority(owner, agentId("C"), CAREER, PERMISSION.CREATE, PROVENANCE_POLICY.ALLOW_INFERENCE)).toBe(true)
    expect(await reader.hasAuthority(owner, agentId("C"), CAREER, PERMISSION.READ, 0)).toBe(false)
  })

  step("11. Agent C creates a new encrypted lineage using only the public epoch key", async () => {
    const object = await actors.C.sdk.create(owner, "goals.career", { value: "Systems engineering fits the last two projects", kind: "INFERENCE", source: "AGENT_INFERRED" })
    expect(object).toMatchObject({ authorId: agentId("C"), version: 1, lineageId: object.contextId, readEpoch: 1n })
    transactions.agentCEpoch1 = object.transactionHash!
  })

  step("12. Agent C can neither fetch a reader wrap nor read or decrypt Alice's existing object", async () => {
    await expect(
      actors.C.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 1n, agentId: agentId("C"), agentKeyVersion: 1, capabilityId: capabilityC }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(actors.C.api.listObjects({ owner, namespaceId: CAREER, capabilityId: capabilityC })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(actors.C.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    const aliceObject = await ownerObject(aliceContextId)
    const publicEpochKey = bytesOf((await reader.epochPublicKey(owner, CAREER, 1n))!, 32)
    expect(() => open(aliceObject, publicEpochKey, 1n)).toThrow(expect.objectContaining({ code: "DECRYPT_FAILED" }))
    expect(() => unwrapEpochPrivateKey({ wrap: epoch1WrapForA, agentEncryptionPrivateKey: actors.C.provisioned.encryptionPrivateKey, binding: readerBinding("A", 1n) })).toThrow(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    )
  })

  step("13. Alice posts an owner-signed revocation intent; the API denies Agent A before any chain transaction", async () => {
    const intent = await ownerApi.requestRevocationDeny({ capabilityId: capabilityA })
    expect(intent.state).toBe("active")
    expect(await reader.hasAuthority(owner, agentId("A"), CAREER, PERMISSION.READ, 0)).toBe(true)
    await expect(actors.A.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
  })

  step("14. Alice revokes Agent A and advances goals.career to epoch 2 in one Monad transaction", async () => {
    const approval = await vault.approveRevocation({ kind: "capability", capabilityId: capabilityA })
    transactions.revokeAndRotate = approval.transactionHash
    expect(approval.rotated).toEqual([{ namespaceId: CAREER, readEpoch: 2n }])
    expect(await reader.requiredReadEpoch(owner, CAREER)).toBe(2n)
    expect(await reader.epochPublicKey(owner, CAREER, 2n)).toBe(hexOf(deriveEpochKeyPair(await vault.deriveNamespaceSecret(CAREER), 2n).publicKey))
    const receipt = await reader.context.publicClient.getTransactionReceipt({ hash: approval.transactionHash })
    const events = parseEventLogs({ abi: capabilityRegistryAbi, logs: receipt.logs }).map((log) => log.eventName)
    expect(events).toEqual(expect.arrayContaining(["CapabilityRevoked", "ReadEpochRequired", "NamespaceEpochKeySet"]))
  })

  step("15. Agent C writes a new object under epoch 2", async () => {
    const object = await actors.C.sdk.create(owner, "goals.career", { value: EPOCH_TWO_TEXT, kind: "INFERENCE", source: "AGENT_INFERRED" })
    expect(object.readEpoch).toBe(2n)
    epochTwoContextId = object.contextId
    transactions.agentCEpoch2 = object.transactionHash!
  })

  step("16. Monad denies Agent A, and A's epoch-1 key cannot decrypt the epoch-2 object (but still opens epoch 1: forward-only)", async () => {
    expect(await reader.hasAuthority(owner, agentId("A"), CAREER, PERMISSION.READ, 0)).toBe(false)
    await expect(actors.A.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })
    const epochOneKey = unwrapEpochPrivateKey({ wrap: epoch1WrapForA, agentEncryptionPrivateKey: actors.A.provisioned.encryptionPrivateKey, binding: readerBinding("A", 1n) })
    const epochTwoObject = await ownerObject(epochTwoContextId)
    const epochOneObject = await ownerObject(aliceContextId)
    expect(() => open(epochTwoObject, epochOneKey, 2n)).toThrow(expect.objectContaining({ code: "DECRYPT_FAILED" }))
    expect(open(epochOneObject, epochOneKey, 1n).value).toBe(GOAL_TEXT)
  })

  step("17. Remaining reader D gets NO_EPOCH_WRAP, not a denial, until its epoch-2 wrap is published; then it reads everything", async () => {
    expect(await reader.hasAuthority(owner, agentId("D"), CAREER, PERMISSION.READ, 0)).toBe(true)
    await expect(actors.D.sdk.read(owner, "goals.career")).rejects.toMatchObject({ code: "NO_EPOCH_WRAP" })
    expect(await vault.publishReaderWraps({ agentId: agentId("D"), namespaceId: CAREER })).toEqual([1n, 2n])
    expect((await actors.D.sdk.read(owner, "goals.career")).map((o) => o.payload.value)).toEqual(expect.arrayContaining([GOAL_TEXT, EPOCH_TWO_TEXT]))
  })

  step("§15: a wrap addressed to D's stale key version is rejected", async () => {
    const capabilityD = actors.D.sdk.grants[0]!.capabilities[0]!.capabilityId
    const genuine = await actors.D.api.getEpochWrap({ owner, namespaceId: CAREER, readEpoch: 2n, agentId: agentId("D"), agentKeyVersion: 1, capabilityId: capabilityD })
    await expect(ownerApi.publishEpochWrap({ ...genuine, agentKeyVersion: 2 })).rejects.toMatchObject({ code: "WRAP_KEY_VERSION_MISMATCH" })
  })

  step("records the run's evidence, including a direct probe of the P256 verifier at 0x0100", async () => {
    const probe = await probeP256Precompile(reader.context.publicClient)
    expect(probe).toEqual({ valid: PRECOMPILE_TRUE, tampered: "0x" })
    writeEvidence(evidencePath(env.name), {
      network: env.name,
      generatedAt: new Date().toISOString(),
      chainId: env.deployment.chainId.toString(),
      capabilityRegistry: env.deployment.capabilityRegistry,
      contextRegistry: env.deployment.contextRegistry,
      deploymentBlock: env.deployment.deploymentBlock.toString(),
      p256PrecompileProbe: probe,
      grantBatchGasUsed,
      gasNote: GAS_NOTE,
      gas: await gasFacts(reader.context.publicClient, transactions),
      transactions,
    })
  })
})

describe("owner passkey verification path inside grantBatch (plan Task 26)", () => {
  const P256_KEY: Hex = `0x${"4d".repeat(32)}`

  /**
   * Signs a MIDA_ROTATE_P256_V1 challenge, then forces the raw signature to high-s. webauthn-sol must reject the raw
   * struct, and the same signature through the shared adapter must rotate the owner key on-chain.
   */
  async function rotateWithForcedHighS(env: ScenarioEnvironment) {
    const ownerAccount = privateKeyToAccount(generatePrivateKey())
    await env.fund(ownerAccount.address)
    const owner = env.writeContext(ownerAccount)
    const registry = env.deployment.capabilityRegistry
    const KIND: Record<string, TxKind> = { registerP256Key: "owner.key", rotateP256Key: "owner.keyRotate" }
    const send = (functionName: string, args: readonly unknown[]) =>
      sendContract(owner, { address: registry, abi: capabilityRegistryAbi, functionName, args }, KIND[functionName]!)
    const oldKey = hexOf(p256.utils.randomSecretKey())
    const oldPublic = p256PublicKey(oldKey)
    const newPublic = p256PublicKey(hexOf(p256.utils.randomSecretKey()))
    await send("registerP256Key", [oldPublic.qx, oldPublic.qy])

    const challenge = p256RotationDigest({
      chainId: env.deployment.chainId,
      capabilityRegistry: registry,
      owner: ownerAccount.address,
      newQx: newPublic.qx,
      newQy: newPublic.qy,
      nonce: 0n,
    })
    const rpId = env.deployment.vaultRpId
    const origin = `https://${rpId}`
    const { metadata, digest } = vaultSignPayload({ challenge, rpId, origin })
    const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(oldKey.slice(2)), { prehash: false })
    const r = BigInt(`0x${bytesToHex(raw.slice(0, 32))}`)
    const highS = P256_N - BigInt(`0x${bytesToHex(raw.slice(32))}`)
    const rawHighS = {
      authenticatorData: metadata.authenticatorData,
      clientDataJSON: metadata.clientDataJSON,
      challengeIndex: BigInt(metadata.challengeIndex!),
      typeIndex: BigInt(metadata.typeIndex!),
      r,
      s: highS,
    }
    const rawRejected = await send("rotateP256Key", [newPublic.qx, newPublic.qy, rawHighS]).then(
      () => false,
      (error: unknown) => (error as { code?: string }).code === "AUTH_INVALID",
    )
    const normalized = completeVaultAssertion({ challenge, metadata, r, s: highS, publicKey: oldPublic, rpId, origin })
    await send("rotateP256Key", [newPublic.qx, newPublic.qy, normalized])
    const [qx, qy] = (await owner.publicClient.readContract({
      address: registry,
      abi: capabilityRegistryAbi,
      functionName: "ownerP256Key",
      args: [ownerAccount.address],
    })) as readonly [bigint, bigint]
    return { rawHighSWasHigh: highS > P256_N / 2n, rawRejected, normalizedS: normalized.s, rotated: qx === newPublic.qx && qy === newPublic.qy }
  }

  async function grantOnce(hardfork: string) {
    const env = await localEnvironment({ hardfork })
    try {
      const aliceAccount = privateKeyToAccount(generatePrivateKey())
      await env.fund(aliceAccount.address)
      const alice = env.writeContext(aliceAccount)
      const vault = new FakeVaultAuthority({
        seed: new Uint8Array(32).fill(0x42),
        p256PrivateKey: P256_KEY,
        chain: alice,
        api: {
          putObject: async () => undefined,
          publishEpochWrap: async () => undefined,
          requestRevocationDeny: async () => ({ intentId: zeroHash, cancellationNonce: "1" }),
          cancelRevocation: async () => ({}),
        },
      })
      await vault.registerOwnerKey()
      await vault.initializeNamespace("goals.career")
      const operatorAccount = privateKeyToAccount(generatePrivateKey())
      await env.fund(operatorAccount.address)
      const agent = await provisionAgent({
        operator: env.writeContext(operatorAccount),
        name: "PathProbe",
        purposeId: "career_coaching",
        declarations: [{ namespace: "goals.career", permissions: ["READ"] }],
        callbackOrigin: "https://path-probe.example",
      })
      const accessRequest = await buildSignedAccessRequest({ chain: alice, agent, scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
      const approval = await vault.approveGrant({ accessRequest, manifest: agent.manifest, selection: { kind: "recommended" } })
      const gas = (await gasFacts(alice.publicClient, { grant: approval.response.capabilities[0]!.transactionHash })).grant!
      return { gasUsed: approval.gasUsed, gas, probe: await probeP256Precompile(alice.publicClient), highS: await rotateWithForcedHighS(env) }
    } finally {
      await env.stop()
    }
  }

  it("verifies through the native precompile on Osaka Anvil and through FreshCryptoLib on prague Anvil, the gas shows which, and a forced high-s assertion is normalized and accepted on both", async () => {
    const native = await grantOnce("default")
    const fallback = await grantOnce("prague")
    expect(native.probe).toEqual({ valid: PRECOMPILE_TRUE, tampered: "0x" })
    expect(fallback.probe).toEqual({ valid: "0x", tampered: "0x" })
    expect(fallback.gasUsed - native.gasUsed).toBeGreaterThan(150_000n)
    for (const path of [native, fallback]) {
      expect(path.highS.rawHighSWasHigh).toBe(true)
      expect(path.highS.rawRejected).toBe(true)
      expect(path.highS.normalizedS <= P256_N / 2n).toBe(true)
      expect(path.highS.rotated).toBe(true)
    }
    writeEvidence(evidencePath("local-p256-paths"), {
      network: "local-p256-paths",
      generatedAt: new Date().toISOString(),
      chainId: "31337",
      capabilityRegistry: zeroHash,
      contextRegistry: zeroHash,
      deploymentBlock: "0",
      p256PrecompileProbe: native.probe,
      grantBatchGasUsed: { nativeOsaka: native.gasUsed.toString(), fallbackPrague: fallback.gasUsed.toString() },
      gasNote: GAS_NOTE,
      gas: { nativeOsaka: native.gas, fallbackPrague: fallback.gas },
      transactions: {},
    })
  }, 300_000)
})
