import {
  MidaError,
  OWNER_AUTHOR_ID,
  PERMISSION,
  cancelFastRevokeDigest,
  contextId as deriveContextId,
  decodeUint64,
  encodeUint64,
  isMidaError,
  namespaceById,
} from "@mida/protocol"
import type { Address, Hex, SignedAgentCapabilityManifest } from "@mida/protocol"
import { bytesOf, hexOf, manifestHash, verifyObjectManifest } from "@mida/crypto"
import type { Deployment } from "@mida/chain"
import {
  manifestBodyHash,
  manifestEnvelopeBytes,
  manifestEnvelopeHash,
  parseManifestEnvelopeBytes,
  validateManifestBody,
  verifySignedManifest,
} from "@mida/grant-advisor"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { zeroHash } from "viem"
import { ReplayGuard, authenticateRequest } from "./auth.js"
import { authorizeAgent } from "./authorize.js"
import type { ContextRecordView, RegistryReader } from "./chain-views.js"
import { DenyOverlay } from "./deny-overlay.js"
import type { RevocationTarget } from "./deny-overlay.js"
import { toErrorBody } from "./errors.js"
import { repairModes } from "./secure-fs.js"
import { ApiStore } from "./store.js"
import type { StoredObject } from "./store.js"
import { verifyVaultAssertion } from "./verify-assertion.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"
import { address, hex, parseObjectUpload, parseReaderWrap } from "./wire.js"
import type { AnchoredObject } from "./wire.js"

export const CANCELLATION_MAX_LIFETIME_SECONDS = 300n

export interface ContextApiOptions {
  reader: RegistryReader
  deployment: Deployment
  dataDir: string
  /** Wall-clock seconds for request freshness. Chain time decides capability expiry. */
  clock?: () => bigint
}

type Env = { Variables: { signer: Address; body: Uint8Array } }

function isAnchored(stored: StoredObject, record: ContextRecordView | null): boolean {
  return (
    record !== null &&
    record.owner === stored.owner &&
    record.namespaceId === stored.namespaceId &&
    record.manifestHash === stored.manifestHash &&
    record.ciphertextCommitment === stored.manifest.ciphertextHash
  )
}

/**
 * Minimal Context API (§12). A thin storage and authorization service, never a decryptor: it holds ciphertext,
 * immutable manifests and reader wraps, and every agent operation passes the §12.1 ordered checks against Monad.
 */
export function createContextApi(options: ContextApiOptions) {
  const { reader, deployment } = options
  const clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  // A tree that predates the mode rules — or was chmodded by hand — is repaired at startup:
  // every directory 0700, every file 0600, before anything reads or writes it.
  repairModes(options.dataDir)
  const overlay = new DenyOverlay(`${options.dataDir}/revocations.json`)
  const store = new ApiStore(options.dataDir)
  const replay = new ReplayGuard(`${options.dataDir}/replay-nonces.json`)
  const app = new Hono<Env>()

  app.onError((error, c) => {
    const { status, body } = toErrorBody(error)
    return c.json(body, status as 400)
  })

  const authenticated = createMiddleware<Env>(async (c, next) => {
    const body = new Uint8Array(await c.req.arrayBuffer())
    c.set(
      "signer",
      authenticateRequest({
        method: c.req.method,
        url: new URL(c.req.url),
        headers: c.req.raw.headers,
        body,
        chainId: deployment.chainId,
        capabilityRegistry: deployment.capabilityRegistry,
        now: clock(),
        replay,
      }),
    )
    c.set("body", body)
    await next()
  })

  const json = <T>(body: Uint8Array): T => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T
    } catch {
      throw new MidaError("INVALID_WIRE", "request body must be UTF-8 JSON")
    }
  }

  const optionalCapability = (value: string | undefined): Hex | undefined =>
    value === undefined ? undefined : hex(value, 32, "capabilityId")

  // ---------- §12.2 object upload ----------
  app.put("/objects", authenticated, async (c) => {
    const signer = c.get("signer")
    const upload = parseObjectUpload(json(c.get("body")))
    namespaceById(upload.namespaceId)
    const { manifest } = upload

    // 1. owner or agent identity
    const isOwner = signer === upload.owner
    let authorId: Hex = OWNER_AUTHOR_ID
    if (!isOwner) {
      const agentId = await reader.agentIdOfSigner(signer)
      if (agentId === null) throw new MidaError("CAPABILITY_DENIED", "signer is neither the owner nor a registered agent")
      authorId = agentId
    }

    // 2–3. canonical manifest hash, ciphertext hash and size
    const ciphertext = bytesOf(upload.ciphertext, (upload.ciphertext.length - 2) / 2)
    const committedManifestHash = manifestHash(manifest)
    if (ciphertext.length !== manifest.ciphertextSize) throw new MidaError("CONTENT_HASH_MISMATCH", "ciphertext size differs from the manifest")
    verifyObjectManifest({ manifest, expectedManifestHash: committedManifestHash, ciphertext })

    // 4. contextId, namespace and read-epoch correspondence
    const expectedContextId = deriveContextId({
      chainId: deployment.chainId,
      contextRegistry: deployment.contextRegistry,
      owner: upload.owner,
      authorId,
      namespaceId: upload.namespaceId,
      objectNonce: upload.objectNonce,
    })
    if (manifest.contextId !== expectedContextId) {
      throw new MidaError("COMMITMENT_MISMATCH", "manifest contextId is not derived from this owner, author, namespace and nonce")
    }
    if (
      manifest.epochDekWrap.contextId !== manifest.contextId ||
      manifest.epochDekWrap.namespaceId !== upload.namespaceId ||
      manifest.epochDekWrap.readEpoch !== manifest.readEpoch
    ) {
      throw new MidaError("MANIFEST_MISMATCH", "object DEK wrap does not correspond to this object, namespace and epoch")
    }

    // 5. the submitted epoch is current and writable
    const readEpoch = decodeUint64(manifest.readEpoch)
    const required = await reader.requiredReadEpoch(upload.owner, upload.namespaceId)
    if (readEpoch !== required) throw new MidaError("EPOCH_STALE", `object uses epoch ${readEpoch}; epoch ${required} is required`)
    if (!(await reader.isWriteEpochValid(upload.owner, upload.namespaceId, required))) {
      throw new MidaError("EPOCH_ROTATION_REQUIRED", "the current epoch no longer accepts writes")
    }

    // 6. agent CREATE, or applicable supersession authority
    if (!isOwner) {
      const base = { reader, overlay, signer, owner: upload.owner, capabilityId: upload.capabilityId, namespaceId: upload.namespaceId }
      if (upload.expectedParentId === zeroHash) {
        await authorizeAgent({ ...base, permission: PERMISSION.CREATE })
      } else {
        const parent = await reader.getRecord(upload.expectedParentId)
        if (parent === null || parent.owner !== upload.owner || parent.namespaceId !== upload.namespaceId) {
          throw new MidaError("NOT_FOUND", "expected parent is not a record of this owner and namespace")
        }
        const ownLineage = (await reader.getRecord(parent.lineageId))?.author === authorId
        try {
          await authorizeAgent({ ...base, permission: PERMISSION.SUPERSEDE_ANY })
        } catch (error) {
          if (!ownLineage || !isMidaError(error, "CAPABILITY_DENIED")) throw error
          await authorizeAgent({ ...base, permission: PERMISSION.SUPERSEDE_OWN })
        }
      }
    }

    // 7. store as pending; §12.3 serves it only once Monad holds matching commitments
    await store.blobs.put(ciphertext)
    store.putObject({
      contextId: manifest.contextId,
      owner: upload.owner,
      namespaceId: upload.namespaceId,
      authorId,
      objectNonce: upload.objectNonce,
      expectedParentId: upload.expectedParentId,
      manifest,
      manifestHash: committedManifestHash,
      uploadedAt: new Date().toISOString(),
    })
    return c.json({ contextId: manifest.contextId, manifestHash: committedManifestHash, state: "pending" })
  })

  // ---------- §12.3 object read ----------
  app.get("/objects", authenticated, async (c) => {
    const signer = c.get("signer")
    const owner = address(c.req.query("owner"), "owner")
    const namespaceId = hex(c.req.query("namespaceId"), 32, "namespaceId")
    namespaceById(namespaceId)
    if (signer !== owner) {
      await authorizeAgent({ reader, overlay, signer, owner, capabilityId: optionalCapability(c.req.query("capabilityId")), namespaceId, permission: PERMISSION.READ })
    }
    const objects: AnchoredObject[] = []
    for (const stored of store.listObjects(owner, namespaceId)) {
      if (!isAnchored(stored, await reader.getRecord(stored.contextId))) continue
      objects.push({
        contextId: stored.contextId,
        owner: stored.owner,
        namespaceId: stored.namespaceId,
        authorId: stored.authorId,
        manifest: stored.manifest,
        manifestHash: stored.manifestHash,
        ciphertext: hexOf(await store.blobs.get(stored.manifest.ciphertextHash)),
      })
    }
    return c.json({ objects })
  })

  app.get("/manifests/:contextId", authenticated, async (c) => {
    const signer = c.get("signer")
    const contextId = hex(c.req.param("contextId"), 32, "contextId")
    const stored = store.getObject(contextId)
    if (stored === undefined || !isAnchored(stored, await reader.getRecord(contextId))) throw new MidaError("NOT_FOUND", "no anchored object")
    if (signer !== stored.owner) {
      await authorizeAgent({
        reader,
        overlay,
        signer,
        owner: stored.owner,
        capabilityId: optionalCapability(c.req.query("capabilityId")),
        namespaceId: stored.namespaceId,
        permission: PERMISSION.READ,
      })
    }
    return c.json({ manifest: stored.manifest, manifestHash: stored.manifestHash })
  })

  // ---------- §14.1 agent capability manifests (public metadata) ----------
  app.put("/agent-manifests", async (c) => {
    const envelope = json<SignedAgentCapabilityManifest>(new Uint8Array(await c.req.arrayBuffer()))
    if (envelope === null || typeof envelope !== "object" || typeof envelope.operatorSignature !== "string" || !/^0x[0-9a-f]{130}$/.test(envelope.operatorSignature)) {
      throw new MidaError("INVALID_WIRE", "envelope needs a manifest and a lowercase 65-byte operatorSignature")
    }
    const now = await reader.now()
    validateManifestBody(envelope.manifest, now)
    const envelopeHash = manifestEnvelopeHash(envelope)
    const bodyHash = manifestBodyHash(envelope.manifest)
    // Fail-closed indexing: once the agent is registered, an envelope that cannot verify can never be served, so the
    // write is rejected rather than repointing the index. For agents not yet on Monad the bytes are kept for later
    // serving, but an existing index entry is never displaced by an unverifiable write (first-write-wins).
    const agentRecord = await reader.getAgent(envelope.manifest.agentId)
    if (agentRecord !== null) {
      verifySignedManifest({ envelope, agentRecord, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, now })
      store.setManifestIndex(bodyHash, envelopeHash)
    } else if (store.getManifestIndex(bodyHash) === undefined) {
      store.setManifestIndex(bodyHash, envelopeHash)
    }
    await store.blobs.put(manifestEnvelopeBytes(envelope))
    return c.json({ bodyHash, envelopeHash })
  })

  app.get("/agent-manifests/:bodyHash", async (c) => {
    const bodyHash = hex(c.req.param("bodyHash"), 32, "bodyHash")
    const envelopeHash = store.getManifestIndex(bodyHash)
    if (envelopeHash === undefined) throw new MidaError("MANIFEST_NOT_FOUND", "no envelope indexed for this body hash")
    let bytes: Uint8Array
    try {
      bytes = await store.blobs.get(envelopeHash)
    } catch (error) {
      if (isMidaError(error)) throw error
      throw new MidaError("MANIFEST_NOT_FOUND", "indexed envelope bytes are missing")
    }
    const envelope = parseManifestEnvelopeBytes({ bytes, expectedEnvelopeHash: envelopeHash, expectedBodyHash: bodyHash })
    const agentRecord = await reader.getAgent(envelope.manifest.agentId)
    if (agentRecord === null) throw new MidaError("AGENT_ID_MISMATCH", "manifest agent is not registered")
    verifySignedManifest({ envelope, agentRecord, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, now: await reader.now() })
    return c.json(envelope)
  })

  // ---------- §12.4 reader-epoch wraps ----------
  app.post("/epoch-wraps", authenticated, async (c) => {
    const signer = c.get("signer")
    const wrap = parseReaderWrap(json(c.get("body")))
    // 1. owner authentication alone is necessary but never sufficient
    if (signer !== wrap.owner) throw new MidaError("CAPABILITY_DENIED", "only the owner may publish reader wraps")
    // 2 and 5. namespace and epoch exist: current, or historical with a registered key
    namespaceById(wrap.namespaceId)
    const epoch = decodeUint64(wrap.readEpoch)
    const required = await reader.requiredReadEpoch(wrap.owner, wrap.namespaceId)
    if (epoch > required || (await reader.epochPublicKey(wrap.owner, wrap.namespaceId, epoch)) === null) {
      throw new MidaError("EPOCH_STALE", "read epoch is not a registered current or historical epoch")
    }
    // 3. recipient agent and exact key version
    const agent = await reader.getAgent(wrap.agentId)
    if (agent === null) throw new MidaError("CAPABILITY_DENIED", "recipient is not an active agent")
    if (agent.encryptionKeyVersion !== wrap.agentKeyVersion) throw new MidaError("WRAP_KEY_VERSION_MISMATCH", "wrap targets a stale agent key version")
    // 4. recipient holds active exact READ, and no local deny covers the relationship
    await overlay.reconcile(reader)
    if (
      (await overlay.deniesRelationship(reader, { owner: wrap.owner, agentId: wrap.agentId, namespaceId: wrap.namespaceId })) ||
      !(await reader.hasAuthority(wrap.owner, wrap.agentId, wrap.namespaceId, PERMISSION.READ, 0))
    ) {
      throw new MidaError("CAPABILITY_DENIED", "recipient has no active exact READ authority")
    }
    store.putWrap(wrap)
    return c.json({ stored: true })
  })

  app.get("/epoch-wraps", authenticated, async (c) => {
    const signer = c.get("signer")
    const owner = address(c.req.query("owner"), "owner")
    const namespaceId = hex(c.req.query("namespaceId"), 32, "namespaceId")
    const agentId = hex(c.req.query("agentId"), 32, "agentId")
    const readEpoch = decodeUint64(c.req.query("readEpoch") ?? "")
    const versionText = c.req.query("agentKeyVersion") ?? ""
    if (!/^[1-9][0-9]{0,9}$/.test(versionText)) throw new MidaError("INVALID_WIRE", "agentKeyVersion must be a positive integer")
    const authorization = await authorizeAgent({
      reader,
      overlay,
      signer,
      owner,
      capabilityId: optionalCapability(c.req.query("capabilityId")),
      namespaceId,
      permission: PERMISSION.READ,
      agentKeyVersion: Number(versionText),
    })
    if (authorization.agentId !== agentId) throw new MidaError("CAPABILITY_DENIED", "an agent may fetch only its own wraps")
    if ((await reader.epochPublicKey(owner, namespaceId, readEpoch)) === null) {
      throw new MidaError("EPOCH_STALE", "read epoch is not a registered current or historical epoch")
    }
    const wrap = store.getWrap({ owner, namespaceId, readEpoch: encodeUint64(readEpoch), agentId, agentKeyVersion: Number(versionText) })
    if (wrap === undefined) throw new MidaError("NO_EPOCH_WRAP", "no reader wrap is published yet for this agent key and epoch")
    return c.json(wrap)
  })

  // ---------- §12.5 fast revocation deny overlay ----------
  app.post("/revocations", authenticated, async (c) => {
    const owner = c.get("signer")
    const request = json<{ capabilityId?: unknown; agentId?: unknown }>(c.get("body"))
    let target: RevocationTarget
    let agentEpochAtIntent: bigint | null = null
    if (request.capabilityId !== undefined) {
      const capabilityId = hex(request.capabilityId, 32, "capabilityId")
      const capability = await reader.getCapability(capabilityId)
      if (capability === null || capability.owner !== owner) throw new MidaError("CAPABILITY_DENIED", "capability is not the signer's")
      target = { kind: "capability", capabilityId }
    } else if (request.agentId !== undefined) {
      const agentId = hex(request.agentId, 32, "agentId")
      if ((await reader.getAgent(agentId)) === null) throw new MidaError("NOT_FOUND", "agent not found")
      // Same ownership rule as the capability path: a relationship must exist (a grant ever recorded, or a prior
      // revocation bumping the owner-agent epoch) before a stranger may pin a deny onto someone else's agent.
      agentEpochAtIntent = await reader.agentEpoch(owner, agentId)
      if ((await reader.activeCapabilityIds(owner, agentId)).length === 0 && agentEpochAtIntent === 0n) {
        throw new MidaError("CAPABILITY_DENIED", "signer has no capability relationship with this agent")
      }
      target = { kind: "agent", agentId }
    } else {
      throw new MidaError("INVALID_WIRE", "revocation needs capabilityId or agentId")
    }
    const intent = overlay.create(owner, target, agentEpochAtIntent)
    return c.json({ intentId: intent.id, state: intent.state, cancellationNonce: intent.cancellationNonce })
  })

  app.post("/revocations/:id/cancel", authenticated, async (c) => {
    const owner = c.get("signer")
    const id = hex(c.req.param("id"), 32, "id")
    const request = json<{ expiresAt?: string; assertion?: WebAuthnAssertionInput }>(c.get("body"))
    const intent = overlay.get(id)
    if (intent === undefined || intent.owner !== owner) throw new MidaError("NOT_FOUND", "revocation intent not found")
    if (intent.state !== "active" || intent.cancellationNonce === null) throw new MidaError("REPLAY", "revocation intent is not cancellable")
    if (request.assertion === undefined || typeof request.expiresAt !== "string" || !/^(0|[1-9][0-9]*)$/.test(request.expiresAt)) {
      throw new MidaError("AUTH_INVALID", "cancellation requires a fresh passkey assertion and expiresAt")
    }
    const expiresAt = BigInt(request.expiresAt)
    const now = clock()
    if (now >= expiresAt || expiresAt - now > CANCELLATION_MAX_LIFETIME_SECONDS) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is expired or valid for more than five minutes")
    }
    const key = await reader.ownerP256Key(owner)
    const nonce = BigInt(intent.cancellationNonce)
    const challenge = cancelFastRevokeDigest({
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
      owner,
      revocationIntentId: intent.id,
      apiCancellationNonce: nonce,
      expiresAt,
    })
    if (key === null || !verifyVaultAssertion({ challenge, assertion: request.assertion, qx: key.qx, qy: key.qy, rpIdHash: deployment.vaultRpIdHash })) {
      throw new MidaError("AUTH_INVALID", "cancellation assertion is not a valid owner passkey assertion")
    }
    const cancelled = overlay.cancel(intent.id, owner, nonce)
    return c.json({ intentId: cancelled.id, state: cancelled.state })
  })

  return { app, overlay, store }
}
