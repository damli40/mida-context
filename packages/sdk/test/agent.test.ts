import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recoverTypedDataAddress, zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  CONTEXT_KIND,
  LINEAGE_POLICY,
  OWNER_AUTHOR_ID,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  accessRequestTypedData,
  contextId as deriveContextId,
  evidenceCommitment,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type { AccessGrantResponse, Hex } from "@mida/protocol"
import { bytesOf, hexOf, sealContextObject } from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  contextRegistryAbi,
  createWriteContext,
  deployLocal,
  fundLocal,
  latestTimestamp,
  sendContract,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, provisionAgent } from "@mida/fake-vault"
import type { AgentDeclaration, ProvisionedAgent } from "@mida/fake-vault"
import { ContextApiClient, RegistryReader, createContextApi } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { MidaAgent } from "@mida/sdk"

const CAREER = namespaceId("goals.career")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`

describe("MidaAgent (plan Task 25)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let reader: RegistryReader
  let app: ReturnType<typeof createContextApi>["app"]
  let vault: FakeVaultAuthority
  let aliceContextId: Hex
  const provisioned: Record<string, ProvisionedAgent> = {}
  const sdk: Record<string, MidaAgent> = {}
  const apis: Record<string, ContextApiClient> = {}

  const clientFor = (account: LocalAccount) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => app.request(url, init),
    })

  async function agent(label: string, index: number, declarations: AgentDeclaration[]) {
    const operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[index]!) })
    const agent = await provisionAgent({ operator, name: label, purposeId: "career_coaching", declarations, callbackOrigin: `https://${label.toLowerCase()}.example` })
    await fundLocal(node.rpcUrl, agent.signer.address)
    provisioned[label] = agent
    apis[label] = clientFor(agent.signer)
    sdk[label] = new MidaAgent({
      agentId: agent.agentId,
      callbackOrigin: agent.callbackOrigin,
      encryptionPrivateKey: agent.encryptionPrivateKey,
      chain: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }),
      api: apis[label]!,
    })
  }

  /** §11.7 evidence record: owner-authored (authorId 0), kind NONE, no lineage — sealed to the current epoch and anchored. */
  async function ownerEvidence(value: string): Promise<Hex> {
    const readEpoch = await reader.requiredReadEpoch(vault.owner, CAREER)
    const epochPublicKey = (await reader.epochPublicKey(vault.owner, CAREER, readEpoch))!
    const objectNonce = hexOf(randomBytes(32))
    const evidenceId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: vault.owner,
      authorId: OWNER_AUTHOR_ID,
      namespaceId: CAREER,
      objectNonce,
    })
    const sealed = sealContextObject({
      payload: { v: 1, value, kind: "NONE", provenance: { source: "NONE" } },
      binding: { chainId: deployment.chainId, contextRegistry: deployment.contextRegistry, contextId: evidenceId, namespaceId: CAREER, readEpoch },
      epochPublicKey: bytesOf(epochPublicKey, 32),
    })
    await clientFor(owner.account).putObject({
      owner: vault.owner,
      namespaceId: CAREER,
      objectNonce,
      expectedParentId: zeroHash,
      manifest: sealed.manifest,
      ciphertext: hexOf(sealed.ciphertext),
    })
    await sendContract(owner, {
      address: deployment.contextRegistry,
      abi: contextRegistryAbi,
      functionName: "register",
      args: [
        vault.owner,
        [
          {
            contextId: evidenceId,
            objectNonce,
            namespaceId: CAREER,
            expectedParentId: zeroHash,
            manifestHash: sealed.manifestHash,
            ciphertextCommitment: sealed.ciphertextCommitment,
            evidenceCommitment: zeroHash,
            readEpoch,
            expiresAt: 0n,
            recordType: RECORD_TYPE.EVIDENCE,
            lineagePolicy: LINEAGE_POLICY.STANDARD,
            kind: CONTEXT_KIND.NONE,
            provenanceSource: PROVENANCE_SOURCE.NONE,
          },
        ],
      ],
    })
    return evidenceId
  }

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    reader = new RegistryReader(owner)
    app = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-sdk-")) }).app
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api: clientFor(owner.account) })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    await vault.initializeNamespace("goals.learning")
    await agent("A", 2, [
      { namespace: "goals.career", permissions: ["READ"] },
      { namespace: "financial", permissions: ["READ"] },
    ])
    await agent("C", 3, [{ namespace: "goals.career", permissions: ["CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE", "ALLOW_IMPORTED"] }])
    await agent("D", 4, [{ namespace: "goals.career", permissions: ["READ"] }])
    await agent("N", 5, [{ namespace: "goals.career", permissions: ["READ"] }])
    aliceContextId = (
      await vault.createOwnerContext({ namespace: "goals.career", payload: { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } } })
    ).contextId
  }, 300_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("createAccessRequest canonicalizes, expands parents, sorts, signs with the registered signer and lasts 300 seconds", async () => {
    const request = await sdk.A!.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [
        { namespace: " Goals.Career ", permissions: PERMISSION.READ },
        { namespace: "financial", permissions: PERMISSION.READ },
      ],
    })
    const expected = sortScopes(
      ["goals.career", "financial", "financial.preferences"].map((name) => ({ namespaceId: namespaceId(name), permissions: PERMISSION.READ, provenancePolicy: 0 })),
    )
    expect(request.scopes).toEqual(expected)
    expect(BigInt(request.requestExpiresAt) - BigInt(request.issuedAt)).toBe(300n)
    expect(request.manifestHash).toBe(provisioned.A!.manifestHash)
    const { agentSignature, ...unsigned } = request
    const typedData = accessRequestTypedData(unsigned)
    expect(await recoverTypedDataAddress({ ...typedData, signature: agentSignature } as never)).toBe(provisioned.A!.signer.address)
  })

  it("completes the Vault's recommended grant only after proving it on Monad, and never twice", async () => {
    const request = await sdk.A!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }, { namespace: "financial", permissions: PERMISSION.READ }] })
    const approval = await vault.approveGrant({ accessRequest: request, manifest: provisioned.A!.manifest, selection: { kind: "recommended" } })
    const grant = await sdk.A!.completeAccessRequest(request, approval.response)
    expect(grant.capabilities.map((c) => [c.namespaceId, c.permissions])).toEqual([[CAREER, PERMISSION.READ]])
    await expect(sdk.A!.completeAccessRequest(request, approval.response)).rejects.toMatchObject({ code: "REQUEST_CONSUMED" })
  })

  it("rejects a broadened response, a capability or transaction Monad does not hold, and a different request, without consuming", async () => {
    const request = await sdk.D!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.D!.manifest, selection: { kind: "recommended" } })
    const first = response.capabilities[0]!
    const withCapability = (patch: Partial<typeof first>): AccessGrantResponse => ({ ...response, capabilities: [{ ...first, ...patch }] })
    await expect(sdk.D!.completeAccessRequest(request, withCapability({ permissions: PERMISSION.READ | PERMISSION.CREATE }))).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest(request, withCapability({ capabilityId: hexOf(randomBytes(32)) }))).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest(request, withCapability({ transactionHash: hexOf(randomBytes(32)) }))).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest({ ...request, capabilityExpiresAt: "1" }, response)).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    await expect(sdk.D!.completeAccessRequest(request, { ...response, requestId: hexOf(randomBytes(32)) })).rejects.toMatchObject({ code: "RESPONSE_MISMATCH" })
    expect((await sdk.D!.completeAccessRequest(request, response)).capabilities).toHaveLength(1)
  })

  it("completes a request at most once even when two completions race", async () => {
    const request = await sdk.D!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.career", permissions: PERMISSION.READ }] })
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.D!.manifest, selection: { kind: "recommended" } })
    const results = await Promise.allSettled([sdk.D!.completeAccessRequest(request, response), sdk.D!.completeAccessRequest(request, response)])
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    const rejected = results.find((result) => result.status === "rejected")!
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "REQUEST_CONSUMED" })
  })

  it("reads owner context by verifying Monad commitments and unwrapping its own epoch key; an ungranted agent is denied", async () => {
    const objects = await sdk.A!.read(vault.owner, "goals.career")
    expect(objects.find((o) => o.contextId === aliceContextId)?.payload.value).toBe("Prioritize systems engineering")
    await expect(sdk.N!.read(vault.owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  let created: Hex

  it("a CREATE-only agent writes with the public epoch key alone and cannot read anything back", async () => {
    const scopes = [{ namespace: "goals.career", permissions: PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE | PROVENANCE_POLICY.ALLOW_IMPORTED }]
    const request = await sdk.C!.createAccessRequest({ purposeId: "career_coaching", scopes })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.C!.manifest, selection: { kind: "custom", scopes: request.scopes, expiresAt } })
    await sdk.C!.completeAccessRequest(request, response)

    const object = await sdk.C!.create(vault.owner, "goals.career", { value: "Systems engineering is the focus", kind: "GOAL", source: "AGENT_INFERRED" })
    created = object.contextId
    expect(object).toMatchObject({ authorId: provisioned.C!.agentId, version: 1, lineageId: object.contextId, readEpoch: 1n })
    const seen = (await sdk.A!.read(vault.owner, "goals.career")).find((o) => o.contextId === created)!
    expect(seen.payload.provenance.source).toBe("AGENT_INFERRED")
    await expect(sdk.C!.read(vault.owner, "goals.career")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
    await expect(apis.C!.listObjects({ owner: vault.owner, namespaceId: CAREER, capabilityId: response.capabilities[0]!.capabilityId })).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })

  it("propose always writes AGENT_INFERRED; user provenance and reference-less imports are refused before any upload", async () => {
    const proposed = await sdk.C!.propose(vault.owner, "goals.career", { value: "Consider staff engineer roles" })
    expect(proposed.payload.provenance.source).toBe("AGENT_INFERRED")
    expect(proposed.payload.kind).toBe("INFERENCE")
    const uploads = vi.spyOn(apis.C!, "putObject")
    for (const source of ["USER_ASSERTED", "USER_CONFIRMED"]) {
      await expect(sdk.C!.create(vault.owner, "goals.career", { value: "x", kind: "GOAL", source: source as never })).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    }
    await expect(sdk.C!.create(vault.owner, "goals.career", { value: "x", kind: "FACT", source: "IMPORTED" })).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    expect(uploads).not.toHaveBeenCalled()
    uploads.mockRestore()
  })

  it("supersedes its own lineage, then loses to the stale-parent rule when reusing the old parent", async () => {
    const next = await sdk.C!.supersede(vault.owner, created, { value: "Systems engineering, v2", kind: "GOAL", source: "AGENT_INFERRED" })
    expect(next).toMatchObject({ version: 2, parentId: created, lineageId: created })
    await expect(sdk.C!.supersede(vault.owner, created, { value: "late", kind: "GOAL", source: "AGENT_INFERRED" })).rejects.toMatchObject({ code: "STALE_PARENT" })
  })

  it("verifies evidence references on read: a real evidence reference passes, a reference to a record that does not exist fails", async () => {
    const evidence = await ownerEvidence("CV source document")
    await sdk.C!.create(vault.owner, "goals.career", { value: "Imported from CV", kind: "FACT", source: "IMPORTED", references: [{ relation: "derived_from", recordId: evidence }] })
    expect((await sdk.A!.read(vault.owner, "goals.career")).some((o) => o.payload.value === "Imported from CV")).toBe(true)
    await sdk.C!.create(vault.owner, "goals.career", { value: "Dangling", kind: "FACT", source: "IMPORTED", references: [{ relation: "supports", recordId: hexOf(randomBytes(32)) }] })
    await expect(sdk.A!.read(vault.owner, "goals.career")).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
  })

  it("reads a USER_CONFIRMED record whose confirmed_from names the CONTEXT proposal it confirms, alongside other records", async () => {
    const request = await sdk.A!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "goals.learning", permissions: PERMISSION.READ }] })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.A!.manifest, selection: { kind: "custom", scopes: request.scopes, expiresAt } })
    await sdk.A!.completeAccessRequest(request, response)
    // §11.8: confirmed_from acknowledges an agent proposal, which is itself a CONTEXT record — not evidence.
    const confirmed = await vault.createOwnerContext({
      namespace: "goals.learning",
      payload: { v: 1, value: "confirmed from a context record", kind: "FACT", provenance: { source: "USER_CONFIRMED", references: [{ relation: "confirmed_from", recordId: aliceContextId }] } },
      evidenceCommitment: evidenceCommitment([{ relation: "confirmed_from", recordId: aliceContextId }]),
    })
    const other = await vault.createOwnerContext({
      namespace: "goals.learning",
      payload: { v: 1, value: "Finish the solidity course", kind: "GOAL", provenance: { source: "USER_ASSERTED" } },
    })
    const objects = await sdk.A!.read(vault.owner, "goals.learning")
    expect(objects.find((o) => o.contextId === confirmed.contextId)?.payload.provenance.source).toBe("USER_CONFIRMED")
    expect(objects.some((o) => o.contextId === other.contextId)).toBe(true)
  })

  it("still accepts a confirmed_from reference that names an evidence record", async () => {
    const evidence = await ownerEvidence("accredited course certificate")
    const confirmed = await vault.createOwnerContext({
      namespace: "goals.learning",
      payload: { v: 1, value: "confirmed against evidence", kind: "CREDENTIAL", provenance: { source: "USER_CONFIRMED", references: [{ relation: "confirmed_from", recordId: evidence }] } },
      evidenceCommitment: evidenceCommitment([{ relation: "confirmed_from", recordId: evidence }]),
    })
    expect((await sdk.A!.read(vault.owner, "goals.learning")).some((o) => o.contextId === confirmed.contextId)).toBe(true)
  })

  it("rejects a USER_CONFIRMED record that carries no confirmed_from reference", async () => {
    // §11.8 requires at least one confirmed_from; supports→EVIDENCE alone does not satisfy it.
    const evidence = await ownerEvidence("supporting document")
    await vault.createOwnerContext({
      namespace: "goals.learning",
      payload: { v: 1, value: "unconfirmed claim", kind: "FACT", provenance: { source: "USER_CONFIRMED", references: [{ relation: "supports", recordId: evidence }] } },
      evidenceCommitment: evidenceCommitment([{ relation: "supports", recordId: evidence }]),
    })
    const reading = sdk.A!.read(vault.owner, "goals.learning")
    await expect(reading).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    await expect(reading).rejects.toThrowError(/confirmed_from/)
  })

  it("rejects imported provenance whose evidence references name a context record", async () => {
    await vault.initializeNamespace("financial.preferences")
    const request = await sdk.A!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "financial.preferences", permissions: PERMISSION.READ }] })
    // The financial domain is HIGH sensitivity, so the grant needs a finite expiry within 24 hours.
    const expiresAt = (await latestTimestamp(owner)) + 3600n
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.A!.manifest, selection: { kind: "custom", scopes: request.scopes, expiresAt } })
    await sdk.A!.completeAccessRequest(request, response)
    // §11.8: IMPORTED must reveal at least one registered evidence-record ID; supports can only name evidence.
    await vault.createOwnerContext({
      namespace: "financial.preferences",
      payload: { v: 1, value: "imported claim", kind: "FACT", provenance: { source: "IMPORTED", references: [{ relation: "supports", recordId: aliceContextId }] } },
      evidenceCommitment: evidenceCommitment([{ relation: "supports", recordId: aliceContextId }]),
    })
    const reading = sdk.A!.read(vault.owner, "financial.preferences")
    await expect(reading).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    await expect(reading).rejects.toThrowError(/not an evidence record/)
  })

  it("rejects an EXTERNAL_ATTESTATION whose references name a context record", async () => {
    await agent("E", 6, [{ namespace: "decisions.career", permissions: ["READ"] }])
    await vault.initializeNamespace("decisions.career")
    const request = await sdk.E!.createAccessRequest({ purposeId: "career_coaching", scopes: [{ namespace: "decisions.career", permissions: PERMISSION.READ }] })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    const { response } = await vault.approveGrant({ accessRequest: request, manifest: provisioned.E!.manifest, selection: { kind: "custom", scopes: request.scopes, expiresAt } })
    await sdk.E!.completeAccessRequest(request, response)
    await vault.createOwnerContext({
      namespace: "decisions.career",
      payload: { v: 1, value: "attested claim", kind: "CREDENTIAL", provenance: { source: "EXTERNAL_ATTESTATION", references: [{ relation: "derived_from", recordId: aliceContextId }] } },
      evidenceCommitment: evidenceCommitment([{ relation: "derived_from", recordId: aliceContextId }]),
    })
    const reading = sdk.E!.read(vault.owner, "decisions.career")
    await expect(reading).rejects.toMatchObject({ code: "PROVENANCE_FORBIDDEN" })
    await expect(reading).rejects.toThrowError(/not an evidence record/)
  })
})
