import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  contextId as deriveContextId,
  namespaceId,
} from "@mida/protocol"
import type { ContextPayload, Hex } from "@mida/protocol"
import { bytesOf, hexOf, openContextObject, sealContextObject, unwrapEpochPrivateKey } from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  contextRegistryAbi,
  createWriteContext,
  deployLocal,
  fundLocal,
  increaseLocalTime,
  latestTimestamp,
  sendContract,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, provisionAgent } from "@mida/fake-vault"
import type { AgentDeclaration, GrantSelection, ProvisionedAgent } from "@mida/fake-vault"
import { randomBytes } from "@noble/hashes/utils.js"
import { ContextApiClient, RegistryReader, createContextApi } from "@mida/api"
import type { ApiStore, ObjectUploadBody } from "@mida/api"

const CAREER = namespaceId("goals.career")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`
const GOAL: ContextPayload = { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } }
const READ_CAREER = [{ namespace: "goals.career", permissions: PERMISSION.READ }]

describe("Context API routes (plan Task 24)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let reader: RegistryReader
  let store: ApiStore
  let app: ReturnType<typeof createContextApi>["app"]
  let vault: FakeVaultAuthority
  let aliceContextId: Hex
  const agents: Record<string, ProvisionedAgent> = {}
  const clients: Record<string, ContextApiClient> = {}
  const capabilities: Record<string, Hex> = {}

  const clientFor = (account: LocalAccount) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => app.request(url, init),
    })

  async function provision(label: string, index: number, declarations: AgentDeclaration[]) {
    const operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[index]!) })
    const agent = await provisionAgent({ operator, name: label, purposeId: "career_coaching", declarations, callbackOrigin: `https://${label.toLowerCase()}.example` })
    await fundLocal(node.rpcUrl, agent.signer.address)
    agents[label] = agent
    clients[label] = clientFor(agent.signer)
  }

  async function grant(label: string, scopes: Array<{ namespace: string; permissions: number; provenancePolicy?: number }>, selection: GrantSelection = { kind: "recommended" }) {
    const accessRequest = await buildSignedAccessRequest({ chain: owner, agent: agents[label]!, scopes })
    const approval = await vault.approveGrant({ accessRequest, manifest: agents[label]!.manifest, selection })
    capabilities[label] = approval.response.capabilities[0]!.capabilityId
  }

  /** An agent-authored root object under the current epoch, sealed with only the public epoch key. */
  async function agentObject(label: string, overrides: Partial<ObjectUploadBody> = {}) {
    const agent = agents[label]!
    const readEpoch = await reader.requiredReadEpoch(vault.owner, CAREER)
    const epochPublicKey = (await reader.epochPublicKey(vault.owner, CAREER, readEpoch))!
    const objectNonce = hexOf(randomBytes(32))
    const contextId = deriveContextId({ chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, owner: vault.owner, authorId: agent.agentId, namespaceId: CAREER, objectNonce })
    const payload: ContextPayload = { v: 1, value: `${label} inference`, kind: "INFERENCE", provenance: { source: "AGENT_INFERRED" } }
    const sealed = sealContextObject({
      payload,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId, namespaceId: CAREER, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    const upload: ObjectUploadBody = {
      owner: vault.owner,
      namespaceId: CAREER,
      objectNonce,
      expectedParentId: zeroHash,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
      ...(capabilities[label] === undefined ? {} : { capabilityId: capabilities[label] }),
      ...overrides,
    }
    const register = () =>
      sendContract(createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }), {
        address: deployment.contextRegistry,
        abi: contextRegistryAbi,
        functionName: "register",
        args: [
          vault.owner,
          [
            {
              contextId, objectNonce, namespaceId: CAREER, expectedParentId: zeroHash, manifestHash: sealed.manifestHash,
              ciphertextCommitment: sealed.ciphertextCommitment, evidenceCommitment: zeroHash, readEpoch, expiresAt: 0n,
              recordType: RECORD_TYPE.CONTEXT, lineagePolicy: LINEAGE_POLICY.STANDARD, kind: CONTEXT_KIND.INFERENCE,
              provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
            },
          ],
        ],
      }, "context.register")
    return { upload, contextId, register }
  }

  const wrapFor = (label: string, readEpoch: bigint, agentKeyVersion = 1) =>
    clients[label]!.getEpochWrap({
      owner: vault.owner,
      namespaceId: CAREER,
      readEpoch,
      agentId: agents[label]!.agentId,
      agentKeyVersion,
      capabilityId: capabilities[label] ?? hexOf(randomBytes(32)),
    })

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    reader = new RegistryReader(owner)
    const api = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-routes-")) })
    app = api.app
    store = api.store
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api: clientFor(owner.account) })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await provision("R", 2, [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("W", 3, [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }])
    await provision("X", 4, [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("T", 5, [{ namespace: "goals.career", permissions: ["READ"] }])
    await provision("S", 6, [{ namespace: "goals.career", permissions: ["READ"] }])
    await grant("R", READ_CAREER)
    await grant("W", [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }])
    await grant("T", READ_CAREER)
    aliceContextId = (await vault.createOwnerContext({ namespace: "goals.career", payload: GOAL })).contextId
  }, 300_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("stores signed agent manifests by body hash and fails closed on a missing, stale or mismatched envelope", async () => {
    const publicClient = clients.R!
    expect(await publicClient.putAgentManifest(agents.R!.manifest)).toMatchObject({ bodyHash: agents.R!.manifestHash })
    expect(await publicClient.getAgentManifest(agents.R!.manifestHash)).toEqual(agents.R!.manifest)
    await expect(publicClient.getAgentManifest(hexOf(randomBytes(32)))).rejects.toMatchObject({ code: "MANIFEST_NOT_FOUND" })

    // A body mutated after signing can never verify against R's AgentRecord, so the PUT itself fails closed.
    const mutated = { ...agents.R!.manifest, manifest: { ...agents.R!.manifest.manifest, name: "Renamed" } }
    await expect(publicClient.putAgentManifest(mutated)).rejects.toMatchObject({ code: "MANIFEST_HASH_MISMATCH" })

    // The body-hash index pointing at another agent's envelope bytes is detected; a genuine re-PUT repairs it.
    const other = await publicClient.putAgentManifest(agents.W!.manifest)
    store.setManifestIndex(agents.R!.manifestHash, other.envelopeHash)
    await expect(publicClient.getAgentManifest(agents.R!.manifestHash)).rejects.toMatchObject({ code: "MANIFEST_HASH_MISMATCH" })
    expect(await publicClient.putAgentManifest(agents.R!.manifest)).toMatchObject({ bodyHash: agents.R!.manifestHash })
    expect(await publicClient.getAgentManifest(agents.R!.manifestHash)).toEqual(agents.R!.manifest)
  })

  it("never lets a forged or premature manifest write repoint the body-hash index", async () => {
    // R's body under W's operator signature: identical bodyHash, but it can never verify for a registered agent.
    const forged = { manifest: agents.R!.manifest.manifest, operatorSignature: agents.W!.manifest.operatorSignature }
    await expect(clients.R!.putAgentManifest(forged)).rejects.toMatchObject({ code: "MANIFEST_SIGNATURE_INVALID" })
    expect(await clients.R!.getAgentManifest(agents.R!.manifestHash)).toEqual(agents.R!.manifest)

    // While the agent is unresolvable on Monad the index is first-write-wins: a second write keeps its bytes in the
    // blob store but cannot displace the existing entry.
    const prematureBody = { ...agents.R!.manifest.manifest, agentId: hexOf(randomBytes(32)) }
    const first = await clients.R!.putAgentManifest({ manifest: prematureBody, operatorSignature: agents.R!.manifest.operatorSignature })
    const second = await clients.R!.putAgentManifest({ manifest: prematureBody, operatorSignature: agents.W!.manifest.operatorSignature })
    expect(second.envelopeHash).not.toBe(first.envelopeHash)
    expect(store.getManifestIndex(first.bodyHash)).toBe(first.envelopeHash)
  })

  it("serves anchored owner context to an authorized reader, who decrypts it with its own epoch wrap", async () => {
    const objects = await clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.R! })
    const object = objects.find((candidate) => candidate.contextId === aliceContextId)!
    expect(object.authorId).toBe(zeroHash)
    const wrap = await wrapFor("R", 1n)
    const epochPrivateKey = unwrapEpochPrivateKey({
      wrap,
      agentEncryptionPrivateKey: agents.R!.encryptionPrivateKey,
      binding: { chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, owner: vault.owner, namespaceId: CAREER, readEpoch: 1n, agentId: agents.R!.agentId, agentKeyVersion: 1 },
    })
    const record = (await reader.getRecord(aliceContextId))!
    const payload = openContextObject({
      manifest: object.manifest,
      expectedManifestHash: record.manifestHash,
      ciphertext: bytesOf(object.ciphertext, object.manifest.ciphertextSize),
      epochPrivateKey,
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: aliceContextId, namespaceId: CAREER, readEpoch: 1n },
    })
    expect(payload.value).toBe("Prioritize systems engineering")
    expect((await clientFor(owner.account).listObjects({ owner: vault.owner, namespaceId: CAREER })).map((o) => o.contextId)).toContain(aliceContextId)
  })

  it("denies an agent with no capability, a forged capability id, and a CREATE-only agent's reads and wraps", async () => {
    await expect(clients.X!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.W! })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(clients.W!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.W! })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(wrapFor("W", 1n)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(wrapFor("X", 1n)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("keeps an upload pending, and out of every read, until Monad holds its commitments", async () => {
    const written = await agentObject("W")
    expect(await clients.W!.putObject(written.upload)).toMatchObject({ contextId: written.contextId, state: "pending" })
    const ids = async () => (await clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.R! })).map((o) => o.contextId)
    expect(await ids()).not.toContain(written.contextId)
    await expect(clients.R!.getManifest(written.contextId, capabilities.R!)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await written.register()
    expect(await ids()).toContain(written.contextId)
    expect((await clients.R!.getManifest(written.contextId, capabilities.R!)).manifest.contextId).toBe(written.contextId)
  })

  it("rejects mutated ciphertext, a contextId not derived from the uploader, and an agent without CREATE", async () => {
    const written = await agentObject("W")
    const flipped = `${written.upload.ciphertext.slice(0, -2)}${written.upload.ciphertext.endsWith("00") ? "01" : "00"}` as Hex
    await expect(clients.W!.putObject({ ...written.upload, ciphertext: flipped })).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" })
    await expect(clients.W!.putObject({ ...written.upload, objectNonce: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
    // W's object uploaded by R's signer derives a different contextId (author R), so it cannot be passed off as W's.
    await expect(clients.R!.putObject({ ...written.upload, capabilityId: capabilities.R! })).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
    const byX = await agentObject("X", { capabilityId: hexOf(randomBytes(32)) })
    await expect(clients.X!.putObject(byX.upload)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("accepts a wrap only from the owner, for a registered epoch, the current key version and live READ", async () => {
    const genuine = await wrapFor("R", 1n)
    const ownerClient = clientFor(owner.account)
    await expect(clients.R!.publishEpochWrap(genuine)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, agentId: agents.X!.agentId })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, agentKeyVersion: 2 })).rejects.toMatchObject({ code: "WRAP_KEY_VERSION_MISMATCH" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, readEpoch: "3" })).rejects.toMatchObject({ code: "EPOCH_STALE" })
    await expect(ownerClient.publishEpochWrap({ ...genuine, wrappedEpochPrivateKey: `0x${"00".repeat(47)}` })).rejects.toMatchObject({ code: "INVALID_WIRE" })
    expect(await ownerClient.publishEpochWrap(genuine)).toEqual({ stored: true })
  })

  it("denies a reader another agent's wrap even with a live READ capability", async () => {
    // §12.4: the signer's authorized agentId must equal the requested agentId. Removing that check would serve
    // T's published wrap to R, so this test fails if the line is deleted.
    await expect(
      clients.R!.getEpochWrap({
        owner: vault.owner,
        namespaceId: CAREER,
        readEpoch: 1n,
        agentId: agents.T!.agentId,
        agentKeyVersion: 1,
        capabilityId: capabilities.R!,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("after revoking T: old-epoch uploads are stale, T is revoked, and remaining reader R waits for its epoch-2 wrap", async () => {
    const staleUpload = await agentObject("W")
    await vault.approveRevocation({ kind: "capability", capabilityId: capabilities.T! })
    expect(await reader.requiredReadEpoch(vault.owner, CAREER)).toBe(2n)
    await expect(clients.W!.putObject(staleUpload.upload)).rejects.toMatchObject({ code: "EPOCH_STALE" })
    await expect(wrapFor("T", 1n)).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" })

    await expect(wrapFor("R", 2n)).rejects.toMatchObject({ code: "NO_EPOCH_WRAP" })
    expect(await vault.publishReaderWraps({ agentId: agents.R!.agentId, namespaceId: CAREER })).toEqual([1n, 2n])
    expect((await wrapFor("R", 2n)).readEpoch).toBe("2")

    const fresh = await agentObject("W")
    expect(await clients.W!.putObject(fresh.upload)).toMatchObject({ state: "pending" })
    await fresh.register()
  })

  it("an expired write deadline closes new writes, leaves a valid reader's history readable, and rotation resumes writes", async () => {
    await grant("S", READ_CAREER, {
      kind: "custom",
      scopes: [{ namespaceId: CAREER, permissions: PERMISSION.READ, provenancePolicy: 0 }],
      expiresAt: (await latestTimestamp(owner)) + 120n,
    })
    await increaseLocalTime(node.rpcUrl, 200n)
    const blocked = await agentObject("W")
    await expect(clients.W!.putObject(blocked.upload)).rejects.toMatchObject({ code: "EPOCH_ROTATION_REQUIRED" })
    const history = await clients.R!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: capabilities.R! })
    expect(history.map((object) => object.contextId)).toContain(aliceContextId)
    expect((await wrapFor("R", 1n)).readEpoch).toBe("1")
    await expect(wrapFor("S", 2n)).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" })

    // §7.3 expiry: the owner publishes the next epoch key and writes resume under it.
    expect(await vault.rotateExpiredEpoch(CAREER)).toMatchObject({ readEpoch: 3n })
    const resumed = await agentObject("W")
    expect(resumed.upload.manifest.readEpoch).toBe("3")
    expect(await clients.W!.putObject(resumed.upload)).toMatchObject({ state: "pending" })
    await resumed.register()
  })
})
