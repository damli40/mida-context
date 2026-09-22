import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEventLogs, zeroHash } from "viem"
import type { LocalAccount } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  LINEAGE_POLICY,
  OWNER_AUTHOR_ID,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  RECORD_TYPE,
  contextId as deriveContextId,
  evidenceCommitment,
  namespaceId,
} from "@mida/protocol"
import type { ContextPayload, Hex } from "@mida/protocol"
import { bytesOf, deriveEpochKeyPair, hexOf, openContextObject } from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  contextRegistryAbi,
  createWriteContext,
  deployLocal,
  fundLocal,
  latestTimestamp,
  revertName,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, provisionAgent } from "@mida/fake-vault"
import type { ProvisionedAgent } from "@mida/fake-vault"
import { ContextApiClient, RegistryReader, createContextApi } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { MidaAgent } from "@mida/sdk"
import type { ReplayInput } from "@mida/sdk"

const CAREER = namespaceId("goals.career")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`

type ApiApp = ReturnType<typeof createContextApi>["app"]

describe("MidaAgent replay + caller-supplied randomness (migrate B1)", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let reader: RegistryReader
  let app: ApiApp
  let ownerApi: ContextApiClient
  let vault: FakeVaultAuthority
  let agent: ProvisionedAgent
  let sdk: MidaAgent
  let evidenceId: Hex
  let replayInput: ReplayInput

  const clientFor = (account: LocalAccount, target: ApiApp) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => target.request(url, init),
    })

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    reader = new RegistryReader(owner)
    app = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-replay-")) }).app
    ownerApi = clientFor(owner.account, app)
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api: ownerApi })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    const operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!) })
    agent = await provisionAgent({
      operator,
      name: "Replayer",
      purposeId: "career_coaching",
      declarations: [
        { namespace: "goals.career", permissions: ["CREATE", "SUPERSEDE_OWN"], provenancePolicies: ["ALLOW_INFERENCE", "ALLOW_IMPORTED"] },
      ],
      callbackOrigin: "https://replayer.example",
    })
    await fundLocal(node.rpcUrl, agent.signer.address)
    sdk = new MidaAgent({
      agentId: agent.agentId,
      callbackOrigin: agent.callbackOrigin,
      encryptionPrivateKey: agent.encryptionPrivateKey,
      chain: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }),
      api: clientFor(agent.signer, app),
    })
    const scopes = [
      {
        namespace: "goals.career",
        permissions: PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN,
        provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE | PROVENANCE_POLICY.ALLOW_IMPORTED,
      },
    ]
    const request = await sdk.createAccessRequest({ purposeId: "career_coaching", scopes })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    const { response } = await vault.approveGrant({
      accessRequest: request,
      manifest: agent.manifest,
      selection: { kind: "custom", scopes: request.scopes, expiresAt },
    })
    await sdk.completeAccessRequest(request, response)
  }, 300_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("an owner write with a prepared nonce and EVIDENCE type lands on the predicted id and emits EvidenceRegistered", async () => {
    const objectNonce = hexOf(randomBytes(32))
    const expected = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: vault.owner,
      authorId: OWNER_AUTHOR_ID,
      namespaceId: CAREER,
      objectNonce,
    })
    const written = await vault.createOwnerContext({
      namespace: "goals.career",
      payload: { v: 1, value: "CV source document", kind: "NONE", provenance: { source: "NONE" } },
      objectNonce,
      recordType: "EVIDENCE",
    })
    expect(written.contextId).toBe(expected)
    evidenceId = written.contextId
    const receipt = await owner.publicClient.getTransactionReceipt({ hash: written.transactionHash })
    const emitted = parseEventLogs({ abi: contextRegistryAbi, eventName: "EvidenceRegistered", logs: receipt.logs })
    expect(emitted.map((log) => log.args.contextId)).toContain(expected)
    expect(await reader.getRecord(expected)).toMatchObject({ recordType: RECORD_TYPE.EVIDENCE })
  })

  it("replay seals the payload exactly: predicted id, matching commitments, and an owner decrypt deep-equal to the input", async () => {
    const references = [{ relation: "supports" as const, recordId: evidenceId }]
    const payload: ContextPayload = {
      v: 1,
      value: {
        text: "imported from the CV",
        migration: { version: 1, originalRecordId: `0x${"ab".repeat(32)}`, originalContract: `0x${"cd".repeat(20)}` },
      },
      kind: "FACT",
      provenance: {
        source: "IMPORTED",
        sourceHash: `0x${"9f".repeat(32)}`,
        sourceUri: "file:///home/dami/cv.pdf",
        retrievedAt: 1_758_000_000,
        note: "carried by migrate",
        extractionConfidence: 0.92,
        references,
      },
      tags: ["cv", "migrated"],
    }
    const objectNonce = hexOf(randomBytes(32))
    replayInput = {
      namespaceId: CAREER,
      payload,
      recordType: "CONTEXT",
      kind: "FACT",
      lineagePolicy: "STANDARD",
      expiresAt: 0n,
      expectedParentId: zeroHash,
      objectNonce,
    }
    const predicted = sdk.predictContextId(vault.owner, CAREER, objectNonce)
    const replayed = await sdk.replay(vault.owner, replayInput)
    expect(replayed.contextId).toBe(predicted)
    expect(replayed.payload).toEqual(payload)
    const record = await reader.getRecord(predicted)
    expect(record).toMatchObject({
      author: agent.agentId,
      recordType: RECORD_TYPE.CONTEXT,
      lineagePolicy: LINEAGE_POLICY.STANDARD,
      evidenceCommitment: evidenceCommitment(references),
      provenanceSource: PROVENANCE_SOURCE.IMPORTED,
    })
    // Owner-side decrypt, the spike-2 path: owner-signed listObjects, the on-chain record re-check,
    // then a key derived from the namespace secret — no agent wrap involved.
    const { objects, partial } = await ownerApi.listObjects({ owner: vault.owner, namespaceId: CAREER })
    expect(partial).toBe(false)
    const stored = objects.find((o) => o.contextId === predicted)
    expect(stored).toBeDefined()
    const namespaceSecret = await vault.deriveNamespaceSecret(CAREER)
    const epochKeys = deriveEpochKeyPair(namespaceSecret, record!.readEpoch)
    const opened = openContextObject({
      manifest: stored!.manifest,
      expectedManifestHash: record!.manifestHash,
      ciphertext: bytesOf(stored!.ciphertext, stored!.manifest.ciphertextSize),
      epochPrivateKey: epochKeys.privateKey,
      binding: {
        chainId: deployment.chainId,
        contextRegistry: deployment.contextRegistry,
        contextId: predicted,
        namespaceId: CAREER,
        readEpoch: record!.readEpoch,
      },
    })
    expect(opened).toEqual(payload)
  })

  it("a second replay with the same nonce cannot land twice — refused by the store, and by the chain on a fresh one", async () => {
    // Same store: the contextId row already holds a different manifestHash, so the upload is refused
    // before any transaction is sent.
    await expect(sdk.replay(vault.owner, replayInput)).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" })
    // A fresh store, which is what a crash-resumed migration's staging home looks like: the upload
    // lands, and the chain itself refuses — the id already exists — so no duplicate can anchor.
    const fresh = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-replay-fresh-")) }).app
    const second = new MidaAgent({
      agentId: agent.agentId,
      callbackOrigin: agent.callbackOrigin,
      encryptionPrivateKey: agent.encryptionPrivateKey,
      chain: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }),
      api: clientFor(agent.signer, fresh),
      grants: sdk.grants,
    })
    const failure = await second.replay(vault.owner, replayInput).then(() => null, (error: unknown) => error)
    expect(revertName(failure)).toBe("DuplicateContext")
  })
})
