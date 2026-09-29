import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseEventLogs, recoverTypedDataAddress, zeroHash } from "viem"
import type { LocalAccount, PublicClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  BATCH_REJECT,
  CONTEXT_KIND,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  batchContextId,
  batchSaveTypedData,
  merkleProof,
  namespaceId,
} from "@mida/protocol"
import type { Address, BatchSaveMessage, ContextPayload, Hex } from "@mida/protocol"
import { bytesOf, generateX25519KeyPair, hexOf, sealContextObject } from "@mida/crypto"
import {
  ANVIL_PRIVATE_KEYS,
  MULTICALL3_ADDRESS,
  batchAnchorAbi,
  capabilityRegistryAbi,
  createWriteContext,
  deployLocal,
  fundLocal,
  latestTimestamp,
  sendContract,
  startAnvil,
} from "@mida/chain"
import type { Deployment, LocalNode, LocalWriteContext } from "@mida/chain"
import { FakeVaultAuthority, buildSignedAccessRequest, provisionAgent } from "@mida/fake-vault"
import type { ProvisionedAgent } from "@mida/fake-vault"
import { ContextApiClient, RegistryReader, createContextApi, evictMulticall3Probe } from "@mida/api"
import type { BatchedReadItem, BatchedSaveWire } from "@mida/api"
import { randomBytes } from "@noble/hashes/utils.js"
import { MidaAgent, prefetchBatchedLookups, signBatchSave, verifyBatchedItem, verifyPendingItem } from "@mida/sdk"

const CAREER = namespaceId("goals.career")
const SEED = new Uint8Array(32).fill(0x42)
const P256_KEY: Hex = `0x${"4d".repeat(32)}`

type ApiApp = ReturnType<typeof createContextApi>["app"]

interface SealedSave {
  wire: BatchedSaveWire
  message: BatchSaveMessage
  contextId: Hex
}

/** Changes the last byte of a hex blob, keeping length and charset — a "one byte flipped" tamper. */
const flip = (hex: Hex): Hex => (hex.endsWith("00") ? `${hex.slice(0, -2)}01` : `${hex.slice(0, -2)}00`) as Hex

describe("BatchAnchor Task 4 — SDK sign + verify", () => {
  let node: LocalNode
  let deployment: Deployment
  let owner: LocalWriteContext
  let funder: LocalWriteContext
  let reader: RegistryReader
  let app: ApiApp
  let ownerApi: ContextApiClient
  let vault: FakeVaultAuthority
  let agent: ProvisionedAgent
  let agent2: ProvisionedAgent
  let agent3: ProvisionedAgent
  let agent2CapabilityId: Hex
  let sdk: MidaAgent
  let operator: LocalWriteContext
  const posted: BatchedSaveWire[] = []
  let batchItems: BatchedReadItem[] = []
  let batchPartial = false
  let lastListBatchInput: { owner: Address; namespaceId: Hex; capabilityId?: Hex } | undefined

  const clientFor = (account: LocalAccount, target: ApiApp) =>
    new ContextApiClient({
      baseUrl: "http://mida.test",
      account,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => target.request(url, init),
    })

  const batchAnchor = () => {
    const address = deployment.batchAnchor
    if (address === undefined) throw new Error("deployLocal did not deploy a BatchAnchor")
    return address
  }

  /**
   * Seals and signs one save the way BatchAnchor wants it — parent fields carry a replacement.
   * `owner`/`namespaceId` file the save under a different scope; `sealKey` seals it under an
   * epoch public key other than the namespace's, so the ciphertext will not open for readers.
   */
  const makeSave = async (
    author: ProvisionedAgent,
    input: {
      value?: string
      owner?: Address
      namespaceId?: Hex
      sealKey?: Uint8Array
      /** Binds/signs a readEpoch other than the live one — the wrap lookup for it fails at read time. */
      readEpoch?: bigint
      /** `lineageId` names the ROOT of the line; it defaults to the immediate parent, correct for v2. */
      parent?: { contextId: Hex; version: number; rootAuthor: Hex; lineageId?: Hex }
    } = {},
  ): Promise<SealedSave> => {
    const saveOwner = input.owner ?? vault.owner
    const saveNamespaceId = input.namespaceId ?? CAREER
    const liveEpoch = await reader.requiredReadEpoch(vault.owner, CAREER)
    const readEpoch = input.readEpoch ?? liveEpoch
    // The seal always uses the live epoch key; a save may still *claim* another epoch in its binding.
    const epochPublicKey = await reader.epochPublicKey(vault.owner, CAREER, liveEpoch)
    if (epochPublicKey === null) throw new Error("no epoch public key for the test namespace")
    const objectNonce = hexOf(randomBytes(32))
    const parent = input.parent
    const contextId = batchContextId({
      chainId: deployment.chainId,
      batchAnchor: batchAnchor(),
      owner: saveOwner,
      agentId: author.agentId,
      namespaceId: saveNamespaceId,
      parentId: parent?.contextId ?? zeroHash,
      objectNonce,
    })
    const payload: ContextPayload = {
      v: 1,
      value: input.value ?? "checkpoint body",
      kind: "EPISODE",
      provenance: { source: "AGENT_INFERRED" },
    }
    const sealed = sealContextObject({
      payload,
      binding: {
        chainId: deployment.chainId,
        contextRegistry: deployment.contextRegistry,
        contextId,
        namespaceId: saveNamespaceId,
        readEpoch,
      },
      epochPublicKey: input.sealKey ?? bytesOf(epochPublicKey, 32),
    })
    const message: BatchSaveMessage = {
      owner: saveOwner,
      namespaceId: saveNamespaceId,
      objectNonce,
      lineageId: parent?.lineageId ?? parent?.contextId ?? zeroHash,
      parentId: parent?.contextId ?? zeroHash,
      parentVersion: parent?.version ?? 0,
      rootAuthor: parent?.rootAuthor ?? zeroHash,
      manifestHash: sealed.manifestHash,
      ciphertextCommitment: sealed.ciphertextCommitment,
      readEpoch,
      expiresAt: 0n,
      kind: CONTEXT_KIND.EPISODE,
      provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
    }
    const signature = await signBatchSave({
      account: author.signer,
      chainId: deployment.chainId,
      batchAnchor: batchAnchor(),
      message,
    })
    return {
      wire: {
        message: { ...message, readEpoch: message.readEpoch.toString(10), expiresAt: message.expiresAt.toString(10) },
        signature,
        manifest: sealed.manifest,
        ciphertext: hexOf(sealed.ciphertext),
      },
      message,
      contextId,
    }
  }

  /**
   * Submits wires to BatchAnchor directly from the funded test wallet — this is Task 4, so no
   * store/batcher is involved — and builds the ANCHORED read items an honest store would return:
   * contract-emitted lineageId/version plus a Merkle proof over the accepted leaves, in order.
   */
  const submitBatch = async (saves: SealedSave[]) => {
    const batchId = hexOf(randomBytes(32))
    const { request } = await funder.publicClient.simulateContract({
      account: funder.account,
      address: batchAnchor(),
      abi: batchAnchorAbi,
      functionName: "submitBatch",
      args: [
        batchId,
        saves.map((save) => ({
          ...save.message,
          signature: save.wire.signature,
        })),
      ],
    })
    const hash = await funder.walletClient.writeContract(request)
    const receipt = await funder.publicClient.waitForTransactionReceipt({ hash })
    const anchored = parseEventLogs({ abi: batchAnchorAbi, eventName: "SaveAnchored", logs: receipt.logs }).sort(
      (a, b) => a.args.position - b.args.position,
    )
    const leaves = anchored.map((log) => log.args.leafHash)
    const wires = new Map(saves.map((save) => [save.contextId, save.wire]))
    const items = new Map<Hex, BatchedReadItem>()
    for (const log of anchored) {
      items.set(log.args.contextId, {
        state: "ANCHORED",
        save: wires.get(log.args.contextId)!,
        contextId: log.args.contextId,
        receivedAt: Date.now(),
        batchId,
        position: log.args.position,
        lineageId: log.args.lineageId,
        version: log.args.version,
        proof: merkleProof(leaves, log.args.position),
      })
    }
    const rejected = parseEventLogs({ abi: batchAnchorAbi, eventName: "SaveRejected", logs: receipt.logs }).map((log) => ({
      index: log.args.index,
      reason: log.args.reason,
    }))
    return { batchId, items, rejected }
  }

  const verify = (item: BatchedReadItem, requireLatest = true) =>
    verifyBatchedItem({ item, chainId: deployment.chainId, deployment, client: owner.publicClient, requireLatest })

  const verifyPending = (item: BatchedReadItem) =>
    verifyPendingItem({ item, chainId: deployment.chainId, deployment, client: owner.publicClient })

  const queuedItem = (save: SealedSave): BatchedReadItem => ({
    state: "QUEUED",
    save: save.wire,
    contextId: save.contextId,
    receivedAt: Date.now(),
  })

  /** The owner grants `target` one capability on goals.career — the on-chain flip a verifier sees. */
  const grantPermissions = async (target: ProvisionedAgent, permissions: number) => {
    const request = await buildSignedAccessRequest({
      chain: owner,
      agent: target,
      scopes: [{ namespace: "goals.career", permissions, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    await vault.approveGrant({
      accessRequest: request,
      manifest: target.manifest,
      selection: { kind: "custom", scopes: request.scopes, expiresAt },
    })
  }

  // Shared anchored item, produced by the first two tests and reused read-only by later ones.
  let honestSave: SealedSave
  let anchoredItem: BatchedReadItem

  beforeAll(async () => {
    node = await startAnvil()
    deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    if (deployment.batchAnchor === undefined) throw new Error("deployLocal did not deploy a BatchAnchor")
    owner = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!) })
    // The local environment's funder submits batches directly — no store in the loop.
    funder = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]!) })
    reader = new RegistryReader(owner)
    app = createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-batched-")) }).app
    ownerApi = clientFor(owner.account, app)
    vault = new FakeVaultAuthority({ seed: SEED, p256PrivateKey: P256_KEY, chain: owner, api: ownerApi })
    await vault.registerOwnerKey()
    await vault.initializeNamespace("goals.career")
    operator = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: privateKeyToAccount(ANVIL_PRIVATE_KEYS[2]!) })
    agent = await provisionAgent({
      operator,
      name: "Batcher",
      purposeId: "career_coaching",
      declarations: [
        { namespace: "goals.career", permissions: ["CREATE", "SUPERSEDE_OWN", "READ"], provenancePolicies: ["ALLOW_INFERENCE"] },
      ],
      callbackOrigin: "https://batcher.example",
    })
    await fundLocal(node.rpcUrl, agent.signer.address)
    const agentApi = clientFor(agent.signer, app)
    // Task 4 ships no server routes — the batch surface on this client is stubbed; every other
    // method (epoch wraps, manifests, lists) still hits the real in-process app.
    agentApi.postBatchSave = async (body) => {
      posted.push(body)
      return {
        state: "QUEUED",
        receipt: {
          contextId: batchContextId({
            chainId: deployment.chainId,
            batchAnchor: batchAnchor(),
            owner: body.message.owner,
            agentId: agent.agentId,
            namespaceId: body.message.namespaceId,
            parentId: body.message.parentId,
            objectNonce: body.message.objectNonce,
          }),
          receivedAt: Date.now(),
          sequence: String(posted.length),
          signature: `0x${"00".repeat(65)}` as Hex,
        },
      }
    }
    agentApi.listBatchSaves = async (input) => {
      lastListBatchInput = input
      return { items: batchItems, partial: batchPartial }
    }
    sdk = new MidaAgent({
      agentId: agent.agentId,
      callbackOrigin: agent.callbackOrigin,
      encryptionPrivateKey: agent.encryptionPrivateKey,
      chain: createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer }),
      api: agentApi,
    })
    const request = await sdk.createAccessRequest({
      purposeId: "career_coaching",
      scopes: [
        {
          namespace: "goals.career",
          permissions: PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN | PERMISSION.READ,
          provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE,
        },
      ],
    })
    const expiresAt = (await latestTimestamp(owner)) + 7n * 86_400n
    const { response } = await vault.approveGrant({
      accessRequest: request,
      manifest: agent.manifest,
      selection: { kind: "custom", scopes: request.scopes, expiresAt },
    })
    await sdk.completeAccessRequest(request, response)
    // agent2: granted CREATE — the revoke test revokes it mid-suite. agent3: registered but never
    // granted, so its save is rejected NO_AUTHORITY at submit time.
    agent2 = await provisionAgent({
      operator,
      name: "Revocable",
      purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }],
      callbackOrigin: "https://revocable.example",
    })
    const request2 = await buildSignedAccessRequest({
      chain: owner,
      agent: agent2,
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    })
    const approved2 = await vault.approveGrant({
      accessRequest: request2,
      manifest: agent2.manifest,
      selection: { kind: "custom", scopes: request2.scopes, expiresAt },
    })
    agent2CapabilityId = approved2.response.capabilities[0]!.capabilityId
    agent3 = await provisionAgent({
      operator,
      name: "Ungranted",
      purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }],
      callbackOrigin: "https://ungranted.example",
    })
  }, 300_000)

  afterAll(async () => {
    await node?.stop()
  })

  it("createBatched posts a signed QUEUED save and sends no transaction", async () => {
    const nonceBefore = await owner.publicClient.getTransactionCount({ address: agent.signer.address })
    const created = await sdk.createBatched(vault.owner, "goals.career", {
      value: "checkpoint one",
      kind: "EPISODE",
      source: "AGENT_INFERRED",
    })
    expect(created.state).toBe("QUEUED")
    expect(created.receipt.contextId).toBe(created.contextId)
    expect(created.receipt.sequence).toBe("1")
    expect(posted).toHaveLength(1)
    const wire = posted[0]!
    expect(wire.message.parentId).toBe(zeroHash)
    expect(wire.message.lineageId).toBe(zeroHash)
    expect(wire.message.rootAuthor).toBe(zeroHash)
    expect(wire.message.parentVersion).toBe(0)
    expect(wire.message.kind).toBe(CONTEXT_KIND.EPISODE)
    expect(wire.message.provenanceSource).toBe(PROVENANCE_SOURCE.AGENT_INFERRED)
    expect(typeof wire.message.readEpoch).toBe("string")
    // The signature must recover to the agent's signer under the BatchAnchor domain — the same
    // digest the contract will check.
    const message: BatchSaveMessage = {
      ...wire.message,
      readEpoch: BigInt(wire.message.readEpoch),
      expiresAt: BigInt(wire.message.expiresAt),
    }
    const recovered = await recoverTypedDataAddress({
      ...batchSaveTypedData({ chainId: deployment.chainId, batchAnchor: batchAnchor(), message }),
      signature: wire.signature,
    } as never)
    expect(recovered).toBe(agent.signer.address)
    honestSave = { wire, message, contextId: created.contextId }
    // No transaction left the agent: the signer nonce never moved.
    const nonceAfter = await owner.publicClient.getTransactionCount({ address: agent.signer.address })
    expect(nonceAfter).toBe(nonceBefore)
  })

  it("an honest anchored save verifies ok — contextId and leaf are the contract's own derivations", async () => {
    const { items } = await submitBatch([honestSave])
    const item = items.get(honestSave.contextId)
    expect(item).toBeDefined()
    anchoredItem = item!
    expect(anchoredItem.lineageId).toBe(honestSave.contextId)
    expect(anchoredItem.version).toBe(1)
    const verdict = await verify(anchoredItem)
    expect(verdict).toMatchObject({ ok: true, agentId: agent.agentId })
    // the anchor block came back inside the verdict — the same batchOf answer that proved the root
    expect(verdict.ok && verdict.anchorBlock > 0n).toBe(true)
  })

  it("one ciphertext byte flipped fails at the ciphertext check", async () => {
    const tampered: BatchedReadItem = {
      ...anchoredItem,
      save: { ...anchoredItem.save, ciphertext: flip(anchoredItem.save.ciphertext) },
    }
    expect(await verify(tampered)).toEqual({ ok: false, reason: "ciphertext" })
  })

  it("a manifest that does not match the signed manifestHash fails manifest", async () => {
    const tampered: BatchedReadItem = {
      ...anchoredItem,
      save: { ...anchoredItem.save, manifest: { ...anchoredItem.save.manifest, ciphertextSize: anchoredItem.save.manifest.ciphertextSize + 1 } },
    }
    expect(await verify(tampered)).toEqual({ ok: false, reason: "manifest" })
  })

  it("a signature by a key that is not a registered agent fails signature", async () => {
    const signature = await signBatchSave({
      account: privateKeyToAccount(generatePrivateKey()),
      chainId: deployment.chainId,
      batchAnchor: batchAnchor(),
      message: honestSave.message,
    })
    const tampered: BatchedReadItem = { ...anchoredItem, save: { ...anchoredItem.save, signature } }
    expect(await verify(tampered)).toEqual({ ok: false, reason: "signature" })
  })

  it("a contextId the recovered author did not produce fails author", async () => {
    const tampered: BatchedReadItem = { ...anchoredItem, contextId: hexOf(randomBytes(32)) }
    expect(await verify(tampered)).toEqual({ ok: false, reason: "author" })
  })

  it("a QUEUED item can never pass verifyBatchedItem — it is not-anchored", async () => {
    const save = await makeSave(agent)
    expect(await verify(queuedItem(save))).toEqual({ ok: false, reason: "not-anchored" })
  })

  it("a pending save dressed as ANCHORED with no batch fails unknown-batch", async () => {
    const save = await makeSave(agent)
    const fake: BatchedReadItem = { ...queuedItem(save), state: "ANCHORED" }
    expect(await verify(fake)).toEqual({ ok: false, reason: "unknown-batch" })
    const fakeWithId: BatchedReadItem = { ...fake, batchId: hexOf(randomBytes(32)) }
    expect(await verify(fakeWithId)).toEqual({ ok: false, reason: "unknown-batch" })
  })

  it("an anchored item under a batch the contract never saw fails unknown-batch", async () => {
    const tampered: BatchedReadItem = { ...anchoredItem, batchId: hexOf(randomBytes(32)) }
    expect(await verify(tampered)).toEqual({ ok: false, reason: "unknown-batch" })
  })

  it("a proof that does not reach the on-chain root fails proof", async () => {
    const first = await makeSave(agent)
    const second = await makeSave(agent)
    const { items } = await submitBatch([first, second])
    const item = items.get(first.contextId)!
    const tampered: BatchedReadItem = { ...item, proof: [hexOf(randomBytes(32))] }
    expect(await verify(tampered)).toEqual({ ok: false, reason: "proof" })
  })

  it("a save the contract rejected, presented anchored with a neighbour's proof, fails proof", async () => {
    const bad = await makeSave(agent3) // registered, but holds no CREATE grant
    const good = await makeSave(agent)
    const { items, rejected } = await submitBatch([bad, good])
    expect(rejected).toEqual([{ index: 0, reason: BATCH_REJECT.NO_AUTHORITY }])
    const goodItem = items.get(good.contextId)!
    const fake: BatchedReadItem = {
      state: "ANCHORED",
      save: bad.wire,
      contextId: bad.contextId,
      receivedAt: Date.now(),
      batchId: goodItem.batchId,
      position: 0,
      lineageId: bad.contextId,
      version: 1,
      proof: goodItem.proof,
    }
    expect(await verify(fake)).toEqual({ ok: false, reason: "proof" })
  })

  it("after a replacement lands, requireLatest flags the old head stale but a plain read still verifies", async () => {
    const v1 = await makeSave(agent, { value: "head v1" })
    const first = await submitBatch([v1])
    const v1Item = first.items.get(v1.contextId)!
    const v2 = await makeSave(agent, {
      value: "head v2",
      parent: { contextId: v1.contextId, version: 1, rootAuthor: agent.agentId },
    })
    const second = await submitBatch([v2])
    const v2Item = second.items.get(v2.contextId)!
    expect(v2Item.version).toBe(2)
    expect(await verify(v1Item, true)).toEqual({ ok: false, reason: "stale" })
    expect(await verify(v1Item, false)).toMatchObject({ ok: true, agentId: agent.agentId })
    expect(await verify(v2Item, true)).toMatchObject({ ok: true, agentId: agent.agentId })
  })

  it("an honest pending save verifies — QUEUED and SUBMITTED both count", async () => {
    const save = await makeSave(agent)
    expect(await verifyPending(queuedItem(save))).toEqual({ ok: true, agentId: agent.agentId })
    const submittedItem: BatchedReadItem = { ...queuedItem(save), state: "SUBMITTED", batchId: hexOf(randomBytes(32)) }
    expect(await verifyPending(submittedItem)).toEqual({ ok: true, agentId: agent.agentId })
  })

  it("a pending save with a flipped ciphertext fails ciphertext", async () => {
    const save = await makeSave(agent)
    const tampered = queuedItem(save)
    tampered.save = { ...save.wire, ciphertext: flip(save.wire.ciphertext) }
    expect(await verifyPending(tampered)).toEqual({ ok: false, reason: "ciphertext" })
  })

  it("an ANCHORED item presented to verifyPendingItem fails not-pending", async () => {
    expect(await verifyPending(anchoredItem)).toEqual({ ok: false, reason: "not-pending" })
  })

  it("a pending save whose agent lost CREATE between queueing and reading fails no-authority", async () => {
    const save = await makeSave(agent2)
    const item = queuedItem(save)
    // The grant is still live here — the same save passes while it holds.
    expect(await verifyPending(item)).toEqual({ ok: true, agentId: agent2.agentId })
    await sendContract(
      owner,
      {
        address: deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName: "revoke",
        args: [agent2CapabilityId],
      },
      "revoke.capability",
    )
    expect(await verifyPending(item)).toEqual({ ok: false, reason: "no-authority" })
  })

  it("readBatchedWithStatus decrypts verified anchored and pending items and reports skipped reasons", async () => {
    const anchoredSave = await makeSave(agent, { value: "anchored body" })
    const { items } = await submitBatch([anchoredSave])
    const pendingSave = await makeSave(agent, { value: "pending body" })
    const badSave = await makeSave(agent, { value: "tampered body" })
    batchItems = [
      items.get(anchoredSave.contextId)!,
      queuedItem(pendingSave),
      { ...queuedItem(badSave), save: { ...badSave.wire, ciphertext: flip(badSave.wire.ciphertext) } },
    ]
    batchPartial = true
    const result = await sdk.readBatchedWithStatus(vault.owner, "goals.career")
    batchPartial = false
    batchItems = []
    expect(result.partial).toBe(true)
    expect(result.anchored).toHaveLength(1)
    expect(result.anchored[0]!.contextId).toBe(anchoredSave.contextId)
    expect(result.anchored[0]!.payload.value).toBe("anchored body")
    expect(result.anchored[0]!.authorId).toBe(agent.agentId)
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]).toMatchObject({
      contextId: pendingSave.contextId,
      anchor: "PENDING_ANCHOR",
      authorAgentId: agent.agentId,
      version: 1,
      lineageId: pendingSave.contextId,
    })
    expect(result.pending[0]!.payload.value).toBe("pending body")
    expect(result.skipped).toEqual([{ contextId: badSave.contextId, reason: "ciphertext" }])
  })

  it("readBatchedWithStatus names its capability when listing — the store denies a bare agent without one", async () => {
    await sdk.readBatchedWithStatus(vault.owner, "goals.career")
    expect(lastListBatchInput).toEqual({
      owner: vault.owner.toLowerCase(),
      namespaceId: CAREER,
      capabilityId: sdk.grants[0]!.capabilities[0]!.capabilityId,
    })
  })

  it("the five client methods hit the routes Task 5 will serve", async () => {
    const calls: { method: string; pathname: string; capabilityId?: string; body?: string }[] = []
    const client = new ContextApiClient({
      baseUrl: "http://mida.test",
      account: agent.signer,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      fetch: async (url, init) => {
        const parsed = new URL(url)
        calls.push({
          method: init?.method ?? "GET",
          pathname: parsed.pathname,
          capabilityId: parsed.searchParams.get("capabilityId") ?? undefined,
          body: init?.body === undefined ? undefined : new TextDecoder().decode(init.body as Uint8Array),
        })
        const body =
          parsed.pathname === "/batch/status"
            ? { enabled: true, batchAnchor: batchAnchor() }
            : parsed.pathname === "/batch/flush"
              ? { flushed: false, reason: "empty" }
              : parsed.pathname === "/batch/saves" && init?.method === "POST"
                ? { state: "QUEUED", receipt: { contextId: zeroHash, receivedAt: 1, sequence: "1", signature: `0x${"00".repeat(65)}` } }
                : parsed.pathname === "/batch/saves"
                  ? { items: [] }
                  : { state: "REJECTED", reason: "NO_AUTHORITY" }
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    expect(await client.batchStatus()).toEqual({ enabled: true, batchAnchor: batchAnchor() })
    const save = await makeSave(agent)
    const postedSave = await client.postBatchSave(save.wire)
    expect(postedSave.state).toBe("QUEUED")
    const saved = await client.getBatchSave(honestSave.contextId, `0x${"dd".repeat(32)}` as Hex)
    expect(saved.state).toBe("REJECTED")
    expect(saved.reason).toBe("NO_AUTHORITY")
    expect(await client.listBatchSaves({ owner: vault.owner, namespaceId: CAREER, capabilityId: `0x${"cc".repeat(32)}` as Hex })).toEqual({ items: [], partial: false })
    expect(await client.flushBatch()).toEqual({ flushed: false, reason: "empty" })
    expect(calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
      "GET /batch/status",
      "POST /batch/saves",
      `GET /batch/saves/${honestSave.contextId}`,
      "GET /batch/saves",
      "POST /batch/flush",
    ])
    // An agent caller names its capability in the query — both batch reads authorize like GET /objects.
    expect(calls[2]!.capabilityId).toBe(`0x${"dd".repeat(32)}`)
    expect(calls[3]!.capabilityId).toBe(`0x${"cc".repeat(32)}`)
    // The wire body keeps the uint64 fields as decimal strings — what the store validates against.
    const sentBody = JSON.parse(calls[1]!.body!) as BatchedSaveWire
    expect(sentBody.message.readEpoch).toBe(save.wire.message.readEpoch)
    expect(typeof sentBody.message.readEpoch).toBe("string")
    expect(sentBody.signature).toBe(save.wire.signature)
  })

  it("a queued save filed under another owner is skipped wrong-scope and the good item still reads", async () => {
    const foreign = await makeSave(agent, { owner: privateKeyToAccount(ANVIL_PRIVATE_KEYS[3]!).address })
    const good = await makeSave(agent, { value: "in scope" })
    batchItems = [queuedItem(foreign), queuedItem(good)]
    const result = await sdk.readBatchedWithStatus(vault.owner, "goals.career")
    batchItems = []
    expect(result.skipped).toEqual([{ contextId: foreign.contextId, reason: "wrong-scope" }])
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]!.contextId).toBe(good.contextId)
    expect(result.pending[0]!.payload.value).toBe("in scope")
  })

  it("a queued save filed under another namespace of the same owner is skipped wrong-scope", async () => {
    const foreign = await makeSave(agent, { namespaceId: namespaceId("goals.health") })
    const good = await makeSave(agent)
    batchItems = [queuedItem(foreign), queuedItem(good)]
    const result = await sdk.readBatchedWithStatus(vault.owner, "goals.career")
    batchItems = []
    expect(result.skipped).toEqual([{ contextId: foreign.contextId, reason: "wrong-scope" }])
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]!.contextId).toBe(good.contextId)
  })

  it("a queued save sealed under a different epoch key is skipped decrypt and the good item still reads", async () => {
    const wrongKey = await makeSave(agent, { sealKey: generateX25519KeyPair().publicKey })
    const good = await makeSave(agent, { value: "opens fine" })
    batchItems = [queuedItem(wrongKey), queuedItem(good)]
    const result = await sdk.readBatchedWithStatus(vault.owner, "goals.career")
    batchItems = []
    expect(result.skipped).toEqual([{ contextId: wrongKey.contextId, reason: "decrypt" }])
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]!.contextId).toBe(good.contextId)
    expect(result.pending[0]!.payload.value).toBe("opens fine")
  })

  it("a queued save bound to an epoch with no published wrap is skipped decrypt — the lookup throw is per-item", async () => {
    // The store served a save claiming readEpoch 99; the namespace never published that epoch key, so
    // getEpochWrap (inside epochKeyFor) throws EPOCH_STALE. Before the fix that throw aborted the
    // whole read; now it skips the row like any other undecryptable one.
    const staleEpoch = await makeSave(agent, { value: "unwrappable epoch", readEpoch: 99n })
    const good = await makeSave(agent, { value: "opens fine" })
    batchItems = [queuedItem(staleEpoch), queuedItem(good)]
    const result = await sdk.readBatchedWithStatus(vault.owner, "goals.career")
    batchItems = []
    expect(result.skipped).toEqual([{ contextId: staleEpoch.contextId, reason: "decrypt" }])
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]!.contextId).toBe(good.contextId)
    expect(result.pending[0]!.payload.value).toBe("opens fine")
  })

  it("a pending replacement by the root author needs SUPERSEDE_OWN — CREATE alone fails no-authority", async () => {
    const author = await provisionAgent({
      operator,
      name: "CreateOnly",
      purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }],
      callbackOrigin: "https://create-only.example",
    })
    await grantPermissions(author, PERMISSION.CREATE)
    // The parent need not exist on-chain — a pending replacement only names it and its root author.
    const save = await makeSave(author, {
      parent: { contextId: hexOf(randomBytes(32)), version: 1, rootAuthor: author.agentId },
    })
    const item = queuedItem(save)
    expect(await verifyPending(item)).toEqual({ ok: false, reason: "no-authority" })
    await grantPermissions(author, PERMISSION.SUPERSEDE_OWN)
    expect(await verifyPending(item)).toEqual({ ok: true, agentId: author.agentId })
  })

  it("a pending replacement of another agent's lineage needs SUPERSEDE_ANY — SUPERSEDE_OWN fails no-authority", async () => {
    // agent holds CREATE|SUPERSEDE_OWN|READ — never ANY — and the named root author is someone else.
    const ownOnly = await makeSave(agent, {
      parent: { contextId: hexOf(randomBytes(32)), version: 2, rootAuthor: agent2.agentId },
    })
    expect(await verifyPending(queuedItem(ownOnly))).toEqual({ ok: false, reason: "no-authority" })
    const replacer = await provisionAgent({
      operator,
      name: "Superseder",
      purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["SUPERSEDE_ANY"], provenancePolicies: ["ALLOW_INFERENCE"] }],
      callbackOrigin: "https://superseder.example",
    })
    await grantPermissions(replacer, PERMISSION.SUPERSEDE_ANY)
    const save = await makeSave(replacer, {
      parent: { contextId: hexOf(randomBytes(32)), version: 5, rootAuthor: agent.agentId },
    })
    expect(await verifyPending(queuedItem(save))).toEqual({ ok: true, agentId: replacer.agentId })
  })

  // in-38 V-4: the batched lane asked batchOf + headCommitOf + agentIdOfSigner per row — up to
  // three chain requests each. The tests below count every readContract on the agent's client.
  // This node starts WITHOUT Multicall3: the first test proves the per-row fallback, the second
  // installs the real runtime (the fixture is the verified Monad-testnet bytes, shared with
  // apps/midad/test) and measures the prefetch. Order matters.
  interface ChainCounts {
    /** readContract calls by functionName — the per-row checks the prefetch replaces. */
    reads: Map<string, number>
    /** aggregate multicall calls — the prefetch's own reads. */
    multicalls: number
    /** getCode probes — the "is Multicall3 here" question itself. */
    probes: number
  }

  /**
   * A MidaAgent on the same signer and grants as `sdk`, but whose publicClient counts the calls
   * V-4 cares about. `hideMulticall3` answers the getCode probe with no code, forcing the
   * per-row path on a node where the aggregate contract really exists.
   */
  const countedAgent = (counts: ChainCounts, hideMulticall3 = false): MidaAgent => {
    const chain = createWriteContext({ rpcUrl: node.rpcUrl, deployment, account: agent.signer })
    const real = chain.publicClient
    const counted = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === "readContract") {
          return (args: { functionName: string }) => {
            counts.reads.set(args.functionName, (counts.reads.get(args.functionName) ?? 0) + 1)
            return value.call(target, args)
          }
        }
        if (prop === "multicall") {
          return (args: unknown) => {
            counts.multicalls += 1
            return value.call(target, args)
          }
        }
        if (prop === "getCode") {
          return (args: { address: Address }) => {
            counts.probes += 1
            return hideMulticall3 && args.address.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()
              ? Promise.resolve("0x")
              : value.call(target, args)
          }
        }
        return value
      },
    })
    const api = clientFor(agent.signer, app)
    api.listBatchSaves = async () => ({ items: batchItems, partial: batchPartial })
    return new MidaAgent({
      agentId: agent.agentId,
      callbackOrigin: agent.callbackOrigin,
      encryptionPrivateKey: agent.encryptionPrivateKey,
      chain: { ...chain, publicClient: counted },
      api,
      grants: sdk.grants,
    })
  }

  it("readBatchedWithStatus falls back to per-row reads where the chain has no Multicall3 (in-38 V-4)", async () => {
    const anchored = await submitBatch([await makeSave(agent, { value: "fallback row" })])
    const pendingSave = await makeSave(agent, { value: "fallback pending" })
    batchItems = [...anchored.items.values(), queuedItem(pendingSave)]
    const counts: ChainCounts = { reads: new Map(), multicalls: 0, probes: 0 }
    try {
      const result = await countedAgent(counts).readBatchedWithStatus(vault.owner, "goals.career")
      expect(result.anchored).toHaveLength(1)
      expect(result.pending).toHaveLength(1)
    } finally {
      batchItems = []
    }
    expect(counts.multicalls).toBe(0)
    // Today's per-row path: each row asks the chain for itself.
    expect(counts.reads.get("batchOf")).toBe(1)
    expect(counts.reads.get("headCommitOf")).toBe(1)
    expect(counts.reads.get("agentIdOfSigner")).toBe(2)
    expect(counts.reads.get("hasAuthority")).toBe(1)
  })

  it("83 rows in 3 batches and 5 lineages verify with one aggregate call, no per-row lookups (in-38 V-4)", async () => {
    // The verified Monad-testnet Multicall3 runtime, installed once for the rest of this file —
    // after this, getCode sees code and the read prefetches through aggregate3.
    const code = readFileSync(
      fileURLToPath(new URL("../../../apps/midad/test/fixtures/multicall3-runtime.hex", import.meta.url)),
      "utf8",
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join("")
    const setCode = await fetch(node.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setCode", params: [MULTICALL3_ADDRESS, code] }),
    })
    expect((await setCode.json() as { error?: unknown }).error).toBeUndefined()

    // Five lineages, each a version chain, spread over three batches — 17+17+17+16+16 = 83 rows.
    // Only the five heads survive requireLatest; the other 78 rows still cost lookups, which is
    // what this measures.
    const sizes = [17, 17, 17, 16, 16]
    const perLineage: SealedSave[][] = []
    for (let lineage = 0; lineage < sizes.length; lineage++) {
      const chain: SealedSave[] = [await makeSave(agent, { value: `lineage ${lineage} v1` })]
      for (let version = 2; version <= sizes[lineage]!; version++) {
        chain.push(
          await makeSave(agent, {
            value: `lineage ${lineage} v${version}`,
            parent: {
              contextId: chain[version - 2]!.contextId,
              version: version - 1,
              rootAuthor: agent.agentId,
              lineageId: chain[0]!.contextId, // the lineage keeps its root's id at every version
            },
          }),
        )
      }
      perLineage.push(chain)
    }
    const flat: SealedSave[] = []
    for (let version = 0; version < sizes[0]!; version++) {
      for (const chain of perLineage) {
        const save = chain[version]
        if (save !== undefined) flat.push(save)
      }
    }
    const all: BatchedReadItem[] = []
    for (const part of [flat.slice(0, 28), flat.slice(28, 56), flat.slice(56)]) {
      const { items } = await submitBatch(part)
      all.push(...items.values())
    }
    expect(all).toHaveLength(83)
    batchItems = all
    try {
      // The "before" measure on the same rows: hide the Multicall3 code from the probe and the
      // read pays per row — 83 x (agentIdOfSigner + batchOf + headCommitOf).
      const before: ChainCounts = { reads: new Map(), multicalls: 0, probes: 0 }
      await countedAgent(before, true).readBatchedWithStatus(vault.owner, "goals.career")
      expect(before.multicalls).toBe(0)
      expect(before.reads.get("agentIdOfSigner")).toBe(83)
      expect(before.reads.get("batchOf")).toBe(83)
      expect(before.reads.get("headCommitOf")).toBe(83)

      // Every read above ran before anvil_setCode — and since in-39 nit 3 the "no Multicall3"
      // probe answer is cached process-wide, so the measured read would still believe it is not
      // here. Evict the stale answer; the next read asks the chain and sees the installed code.
      evictMulticall3Probe(deployment.chainId)

      const after: ChainCounts = { reads: new Map(), multicalls: 0, probes: 0 }
      const result = await countedAgent(after).readBatchedWithStatus(vault.owner, "goals.career")
      expect(result.anchored).toHaveLength(5) // the five lineage heads
      expect(result.skipped).toHaveLength(78)
      expect(result.skipped.every((row) => row.reason === "stale")).toBe(true)
      // 3 batches + 5 lineages + 1 signer = 9 distinct lookups → one aggregate call.
      expect(after.multicalls).toBe(1)
      expect(after.reads.get("batchOf") ?? 0).toBe(0)
      expect(after.reads.get("headCommitOf") ?? 0).toBe(0)
      expect(after.reads.get("agentIdOfSigner") ?? 0).toBe(0)
    } finally {
      batchItems = []
    }
  })

  it("lookup-verified rows keep their skip reasons: proof, stale and no-authority (in-38 V-4)", async () => {
    // Multicall3 is installed by the test above — this read goes through the lookup maps and must
    // land on exactly the same reasons the per-row path produced.
    const badProofSave = await makeSave(agent, { value: "bad proof" })
    const { items: proofItems } = await submitBatch([badProofSave])
    const badProof = { ...proofItems.get(badProofSave.contextId)!, proof: [hexOf(randomBytes(32))] }

    const v1 = await makeSave(agent, { value: "stale head v1" })
    const first = await submitBatch([v1])
    const stale = first.items.get(v1.contextId)!
    const v2 = await makeSave(agent, {
      value: "stale head v2",
      parent: { contextId: v1.contextId, version: 1, rootAuthor: agent.agentId },
    })
    await submitBatch([v2])

    // A save queued while its author held CREATE, read after the grant is revoked — self-contained
    // so the test does not depend on a revocation an earlier test performed.
    const transient = await provisionAgent({
      operator,
      name: "Transient",
      purposeId: "career_coaching",
      declarations: [{ namespace: "goals.career", permissions: ["CREATE"], provenancePolicies: ["ALLOW_INFERENCE"] }],
      callbackOrigin: "https://transient.example",
    })
    const transientRequest = await buildSignedAccessRequest({
      chain: owner,
      agent: transient,
      scopes: [{ namespace: "goals.career", permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    })
    const transientGrant = await vault.approveGrant({
      accessRequest: transientRequest,
      manifest: transient.manifest,
      selection: {
        kind: "custom",
        scopes: transientRequest.scopes,
        expiresAt: (await latestTimestamp(owner)) + 7n * 86_400n,
      },
    })
    const revoked = queuedItem(await makeSave(transient, { value: "queued before revocation" }))
    await sendContract(
      owner,
      {
        address: deployment.capabilityRegistry,
        abi: capabilityRegistryAbi,
        functionName: "revoke",
        args: [transientGrant.response.capabilities[0]!.capabilityId],
      },
      "revoke.capability",
    )

    batchItems = [badProof, stale, revoked]
    const counts: ChainCounts = { reads: new Map(), multicalls: 0, probes: 0 }
    try {
      const result = await countedAgent(counts).readBatchedWithStatus(vault.owner, "goals.career")
      expect(result.skipped).toEqual([
        { contextId: badProof.contextId, reason: "proof" },
        { contextId: stale.contextId, reason: "stale" },
        { contextId: revoked.contextId, reason: "no-authority" },
      ])
      expect(result.anchored).toHaveLength(0)
      expect(result.pending).toHaveLength(0)
    } finally {
      batchItems = []
    }
    expect(counts.multicalls).toBe(1) // 2 batches + 2 lineages + 2 signers = 6 lookups
    expect(counts.reads.get("batchOf") ?? 0).toBe(0)
    expect(counts.reads.get("headCommitOf") ?? 0).toBe(0)
    expect(counts.reads.get("agentIdOfSigner") ?? 0).toBe(0)
    // the pending row's authority check stays live and per-row — that is the point of it
    expect(counts.reads.get("hasAuthority")).toBe(1)
  })
})

// in-39 B-9 nit 3: prefetchBatchedLookups asked the chain's `getCode` for itself on every read —
// the process-wide probe cache in-38 added for RegistryReader (`apps/api/src/chain-views.ts`)
// already knows the answer after the first ask, so two reads must cost one probe in total.
describe("the Multicall3 probe is shared process-wide", () => {
  it("two batched reads cost the chain one getCode probe", async () => {
    let probes = 0
    let multicalls = 0
    // A stand-in client: getCode answers "Multicall3 is deployed", and multicall returns one
    // zero result per asked-for call — the prefetch never looks deeper than the array shape.
    const client = {
      getCode: async () => {
        probes += 1
        return `0x${"60".repeat(4)}`
      },
      multicall: async ({ contracts }: { contracts: readonly unknown[] }) => {
        multicalls += 1
        return contracts.map(() => zeroHash)
      },
    } as unknown as PublicClient
    // A chain id nothing else in this process probes — the shared cache is keyed by it, so this
    // deployment starts cold no matter which tests ran first.
    const deployment: Deployment = {
      chainId: 4_242_424_242n,
      capabilityRegistry: `0x${"22".repeat(20)}`,
      contextRegistry: `0x${"33".repeat(20)}`,
      deploymentBlock: 0n,
      policyHashV1: `0x${"55".repeat(32)}`,
      vaultRpId: "probe-cache.test",
      vaultRpIdHash: `0x${"66".repeat(32)}`,
      batchAnchor: `0x${"11".repeat(20)}`,
      batchAnchorBlock: 0n,
    }
    const owner = `0x${"77".repeat(20)}` as Address
    const namespace = `0x${"88".repeat(32)}` as Hex
    // One really-signed QUEUED item, so each read walks the whole prefetch path — recover the
    // signer, then its agentIdOfSigner lookup inside one aggregate call.
    const message: BatchSaveMessage = {
      owner,
      namespaceId: namespace,
      objectNonce: `0x${"01".repeat(32)}`,
      lineageId: zeroHash,
      parentId: zeroHash,
      parentVersion: 0,
      rootAuthor: zeroHash,
      manifestHash: `0x${"aa".repeat(32)}`,
      ciphertextCommitment: `0x${"bb".repeat(32)}`,
      readEpoch: 1n,
      expiresAt: 0n,
      kind: CONTEXT_KIND.EPISODE,
      provenanceSource: PROVENANCE_SOURCE.AGENT_INFERRED,
    }
    const signature = await signBatchSave({
      account: privateKeyToAccount(generatePrivateKey()),
      chainId: deployment.chainId,
      batchAnchor: deployment.batchAnchor!,
      message,
    })
    const item: BatchedReadItem = {
      state: "QUEUED",
      save: {
        message: { ...message, readEpoch: "1", expiresAt: "0" },
        signature,
        // The prefetch never opens these — a verifier does — so any well-shaped values stand in.
        manifest: {
          v: 1,
          contextId: `0x${"99".repeat(32)}`,
          ciphertextHash: `0x${"bb".repeat(32)}`,
          ciphertextSize: 1,
          payloadNonce: `0x${"cc".repeat(32)}`,
          cryptoVersion: "mida-crypto-v1",
          readEpoch: "1",
          epochDekWrap: {
            v: 1,
            contextId: `0x${"99".repeat(32)}`,
            namespaceId: namespace,
            readEpoch: "1",
            ephemeralPublicKey: `0x${"dd".repeat(32)}`,
            nonce: `0x${"ee".repeat(12)}`,
            wrappedDek: `0x${"ff".repeat(32)}`,
          },
        },
        ciphertext: "0x00",
      },
      contextId: `0x${"99".repeat(32)}`,
      receivedAt: 1,
    }
    const input = { items: [item], owner, namespaceId: namespace, chainId: deployment.chainId, deployment, client }
    const first = await prefetchBatchedLookups(input)
    const second = await prefetchBatchedLookups(input)
    expect(first?.signers?.size).toBe(1)
    expect(second?.signers?.size).toBe(1)
    // Each read still runs its own aggregate lookups — only the probe is shared.
    expect(multicalls).toBe(2)
    expect(probes).toBe(1)
  })
})
