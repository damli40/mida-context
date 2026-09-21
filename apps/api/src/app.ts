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
  manifestBindingFor,
  manifestBodyHash,
  manifestEnvelopeBytes,
  manifestEnvelopeHash,
  parseManifestEnvelopeBytes,
  recoverTypedDataSigner,
  validateManifestBody,
  verifySignedManifest,
} from "@mida/grant-advisor"
import { Hono } from "hono"
import type { Context } from "hono"
import { createMiddleware } from "hono/factory"
import { isAddressEqual, zeroHash } from "viem"
import { AUTH_HEADERS, assertAuthHeaderShape, authenticateRequest } from "./auth.js"
import { authorizeAgent } from "./authorize.js"
import type { ContextRecordView, RegistryReader } from "./chain-views.js"
import { DenyOverlay } from "./deny-overlay.js"
import type { RevocationTarget } from "./deny-overlay.js"
import { toErrorBody } from "./errors.js"
import { fileStores } from "./file-stores.js"
import type { StoredObject } from "./store.js"
import { DEFAULT_STORE_LIMITS } from "./stores.js"
import type { ContextStores, StoreLimits } from "./stores.js"
import { verifyVaultAssertion } from "./verify-assertion.js"
import type { WebAuthnAssertionInput } from "./verify-assertion.js"
import { address, hex, parseObjectUpload, parseReaderWrap } from "./wire.js"
import type { AnchoredObject } from "./wire.js"

export const CANCELLATION_MAX_LIFETIME_SECONDS = 300n

/** Manifest GET responses are allowed this stale before the envelope is re-verified against Monad. */
export const MANIFEST_VERIFY_CACHE_SECONDS = 60n

/** The pending-bytes quota re-checks unmarked uploads in batches of 8, at most this many chain reads per PUT. */
export const PENDING_CHECK_BATCH = 8
export const PENDING_CHECK_MAX_READS = 40

/**
 * Per-IP request limiting, injected by the deployment. The hosted Worker's [[ratelimits]] bindings adapt
 * to it; a self-hosted Node server may pass its own (or none — the README says a reverse proxy is needed
 * then). `signed` tells the limiter which bucket the request counts against.
 */
export interface RequestLimiter {
  check(input: { ip: string; signed: boolean }): Promise<boolean>
}

export interface ContextApiOptions {
  reader: RegistryReader
  deployment: Deployment
  /** The file-backed stores' directory; used only when `stores` is not given. */
  dataDir?: string
  /** Injected persistence — the hosted worker passes its D1 stores here. */
  stores?: ContextStores
  /** Upload-abuse limits; any field overrides the shared defaults in DEFAULT_STORE_LIMITS. */
  limits?: Partial<StoreLimits>
  /** Per-IP request-rate limiting; default none (a self-hoster limits at their reverse proxy). */
  limiter?: RequestLimiter
  /** Wall-clock seconds for request freshness. Chain time decides capability expiry. */
  clock?: () => bigint
}

type Env = { Variables: { signer: Address; body: Uint8Array } }

/** §12.3: an object is served only once Monad holds matching commitments for it. */
export function isAnchored(stored: StoredObject, record: ContextRecordView | null): boolean {
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
  // The stores are injectable: the file-backed defaults when a dataDir is given, D1 in the hosted worker.
  const stores = options.stores ?? (options.dataDir === undefined ? undefined : fileStores(options.dataDir))
  if (stores === undefined) throw new Error("createContextApi needs either `stores` or `dataDir`")
  const overlay = new DenyOverlay(stores.denies)
  const store = stores.objects
  const replay = stores.nonces
  const limits: StoreLimits = { ...DEFAULT_STORE_LIMITS, ...options.limits }
  const app = new Hono<Env>()

  // The cheapest gate of all: a per-IP request budget, checked before a byte of the body is read. The
  // hosted worker binds Cloudflare's ratelimits; a self-hosted app can inject any implementation.
  const limiter = options.limiter
  if (limiter !== undefined) {
    app.use(async (c, next) => {
      const ip = c.req.header("cf-connecting-ip") ?? "unknown"
      const signed = c.req.header(AUTH_HEADERS.signature) !== undefined
      if (await limiter.check({ ip, signed })) {
        await next()
        return
      }
      return c.json({ error: { code: "RATE_LIMITED", message: "too many requests from this address — try again in a minute" } }, 429, { "retry-after": "60" })
    })
  }

  /**
   * Reads a request body under a byte cap: an honest content-length is refused before a byte is read, and the
   * count of bytes actually read decides — a header that lies low never gets an oversized body through.
   */
  const readBodyWithin = async (c: Context<Env>, max: number): Promise<Uint8Array> => {
    const declared = c.req.header("content-length")
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > max) {
      throw new MidaError("PAYLOAD_TOO_LARGE", `request body is over the ${max} byte limit`)
    }
    const body = new Uint8Array(await c.req.arrayBuffer())
    if (body.length > max) throw new MidaError("PAYLOAD_TOO_LARGE", `request body is over the ${max} byte limit`)
    return body
  }

  /** A quota refusal: HTTP 429 with a plain message naming the exceeded limit. */
  const quotaExceeded = (c: Context<Env>, limit: string, detail: string) =>
    c.json({ error: { code: "QUOTA_EXCEEDED", message: `quota exceeded: ${limit} (${detail})` } }, 429)

  app.onError((error, c) => {
    const { status, body } = toErrorBody(error)
    return c.json(body, status as 400)
  })

  const json = <T>(body: Uint8Array): T => {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T
    } catch {
      throw new MidaError("INVALID_WIRE", "request body must be UTF-8 JSON")
    }
  }

  /**
   * The §12.1 gate for signed routes, ordered cheapest-first so a malformed request costs nothing: header
   * presence and format, then the body byte cap, then JSON shape — all before a signature is verified,
   * a replay nonce is recorded or Monad is read. `maxBodyBytes` is per-route: the manifest PUT is capped
   * at 16 KB while object uploads may carry up to 1 MB of ciphertext.
   */
  const authenticated = (maxBodyBytes: number) =>
    createMiddleware<Env>(async (c, next) => {
      assertAuthHeaderShape(c.req.raw.headers)
      const body = await readBodyWithin(c, maxBodyBytes)
      if (body.length > 0) json(body)
      c.set(
        "signer",
        await authenticateRequest({
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

  const optionalCapability = (value: string | undefined): Hex | undefined =>
    value === undefined ? undefined : hex(value, 32, "capabilityId")

  // ---------- §12.2 object upload ----------
  app.put("/objects", authenticated(limits.maxRequestBodyBytes), async (c) => {
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

    // 2–3. canonical manifest hash, ciphertext hash and size — capped before the bytes are even decoded
    if ((upload.ciphertext.length - 2) / 2 > limits.maxCiphertextBytes) {
      throw new MidaError("PAYLOAD_TOO_LARGE", `ciphertext is over the ${limits.maxCiphertextBytes} byte limit`)
    }
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

    // 7. quotas: a signer may not use the store as free hosting. Only rows never marked anchored count
    // against the byte cap — an uploader's anchored history is skipped entirely. Each unmarked row is
    // re-checked against Monad oldest-first, 8 at a time and at most 40 reads per request; a confirmed
    // anchor marks the row once, permanently, and frees its bytes. Rows left unchecked still count as
    // pending, so a flood of unconfirmed uploads cannot hide behind the read budget.
    const alreadyStored = (await store.getObject(manifest.contextId))?.manifestHash === committedManifestHash
    const unmarked = await store.pendingByUploader(signer)
    let pendingBytes =
      (alreadyStored ? 0 : ciphertext.length) +
      unmarked.reduce((total, other) => (other.contextId === manifest.contextId ? total : total + other.manifest.ciphertextSize), 0)
    const anchoredNow = new Date(Number(clock()) * 1000).toISOString()
    let scanned = 0
    while (scanned < unmarked.length && pendingBytes > limits.maxPendingBytesPerSigner && scanned < PENDING_CHECK_MAX_READS) {
      const batch = unmarked.slice(scanned, scanned + PENDING_CHECK_BATCH)
      const freed = await Promise.all(
        batch.map(async (other) => {
          if (!isAnchored(other, await reader.getRecord(other.contextId))) return 0
          await store.markAnchored(other.contextId, anchoredNow)
          return other.contextId === manifest.contextId ? 0 : other.manifest.ciphertextSize
        }),
      )
      scanned += batch.length
      pendingBytes -= freed.reduce((total, size) => total + size, 0)
    }
    if (pendingBytes > limits.maxPendingBytesPerSigner) {
      const detail =
        scanned < unmarked.length
          ? "too many uploads waiting to be confirmed on chain"
          : `unanchored ciphertext would reach ${pendingBytes} bytes`
      return quotaExceeded(c, "maxPendingBytesPerSigner", detail)
    }
    const day = new Date().toISOString().slice(0, 10)
    const putCount = await store.recordPut(signer, day)
    if (putCount > limits.maxPutsPerSignerPerDay) {
      return quotaExceeded(c, "maxPutsPerSignerPerDay", `${putCount - 1} puts already accepted on ${day}`)
    }

    // 8. store as pending; §12.3 serves it only once Monad holds matching commitments. The conditional
    // insert re-runs the pending-byte sum inside the same statement, so two instances racing the cap
    // cannot both be admitted — the loser sees "over-cap" here even though its own scan passed. The row
    // lands before its blob: a failed blob write leaves a pending row the 24 h sweep reclaims, rather
    // than an orphaned blob nobody references.
    const admission = await store.putObjectWithinPending(
      {
        contextId: manifest.contextId,
        owner: upload.owner,
        uploader: signer,
        namespaceId: upload.namespaceId,
        authorId,
        objectNonce: upload.objectNonce,
        expectedParentId: upload.expectedParentId,
        manifest,
        manifestHash: committedManifestHash,
        uploadedAt: new Date().toISOString(),
        anchoredAt: null,
      },
      limits.maxPendingBytesPerSigner,
    )
    if (admission === "over-cap") {
      return quotaExceeded(c, "maxPendingBytesPerSigner", "unanchored ciphertext reached the cap while this PUT was in flight")
    }
    await store.blobs.put(ciphertext)
    return c.json({ contextId: manifest.contextId, manifestHash: committedManifestHash, state: "pending" })
  })

  // ---------- §12.3 object read ----------
  app.get("/objects", authenticated(limits.maxRequestBodyBytes), async (c) => {
    const signer = c.get("signer")
    const owner = address(c.req.query("owner"), "owner")
    const namespaceId = hex(c.req.query("namespaceId"), 32, "namespaceId")
    namespaceById(namespaceId)
    if (signer !== owner) {
      await authorizeAgent({ reader, overlay, signer, owner, capabilityId: optionalCapability(c.req.query("capabilityId")), namespaceId, permission: PERMISSION.READ })
    }
    const objects: AnchoredObject[] = []
    const anchoredNow = new Date(Number(clock()) * 1000).toISOString()
    for (const stored of await store.listObjects(owner, namespaceId)) {
      // anchored_at records the first verified match; a Monad record cannot be un-registered, so only
      // an unmarked row asks the chain — and the first match is marked once, permanently. Every check
      // that decides who may read (capability, epoch, deny overlay) still runs per request above.
      if (stored.anchoredAt === null) {
        if (!isAnchored(stored, await reader.getRecord(stored.contextId))) continue
        await store.markAnchored(stored.contextId, anchoredNow)
      }
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

  app.get("/manifests/:contextId", authenticated(limits.maxRequestBodyBytes), async (c) => {
    const signer = c.get("signer")
    const contextId = hex(c.req.param("contextId"), 32, "contextId")
    const stored = await store.getObject(contextId)
    if (stored === undefined) throw new MidaError("NOT_FOUND", "no anchored object")
    if (stored.anchoredAt === null) {
      if (!isAnchored(stored, await reader.getRecord(contextId))) throw new MidaError("NOT_FOUND", "no anchored object")
      await store.markAnchored(contextId, new Date(Number(clock()) * 1000).toISOString())
    }
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
  app.put("/agent-manifests", authenticated(limits.maxManifestBodyBytes), async (c) => {
    const signer = c.get("signer")
    const envelope = json<SignedAgentCapabilityManifest>(c.get("body"))
    if (envelope === null || typeof envelope !== "object" || typeof envelope.manifest !== "object" || typeof envelope.operatorSignature !== "string" || !/^0x[0-9a-f]{130}$/.test(envelope.operatorSignature)) {
      throw new MidaError("INVALID_WIRE", "envelope needs a manifest and a lowercase 65-byte operatorSignature")
    }
    // Structural rules are local work: issuedAt is informational chronology, so the wall clock is the check
    // here — a body the chain later commits to is re-validated against chain time inside verifySignedManifest.
    validateManifestBody(envelope.manifest, clock())
    const envelopeHash = manifestEnvelopeHash(envelope)
    const bodyHash = manifestBodyHash(envelope.manifest)

    const existing = await store.getManifestIndex(bodyHash)
    // The manifest names no key field; the only identity it carries is the operator that signed the body,
    // recoverable from operatorSignature locally — no chain read needed to learn who may stage it.
    const operator = recoverTypedDataSigner(
      manifestBindingFor({ chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, body: envelope.manifest }),
      envelope.operatorSignature,
    )

    // A repeat of identical bytes is a no-op — but only for the manifest's own operator key (or a manifest
    // whose signature names no one). The same bytes carried by any other key are someone else's upload and
    // are decided below: denied while the agent is unregistered, accepted only once the chain can verify.
    if (existing?.envelopeHash === envelopeHash && (operator === null || isAddressEqual(operator, signer))) {
      return c.json({ bodyHash, envelopeHash })
    }

    // The request signature buys a per-signer quota and replay protection, not authority: any key may
    // carry a manifest, but only up to the daily cap.
    const day = new Date(Number(clock()) * 1000).toISOString().slice(0, 10)
    const manifestPuts = await store.recordManifestPut(signer, day)
    if (manifestPuts > limits.maxManifestPutsPerSignerPerDay) {
      return quotaExceeded(c, "maxManifestPutsPerSignerPerDay", `${manifestPuts - 1} puts already accepted on ${day}`)
    }

    const agentRecord = await reader.getAgent(envelope.manifest.agentId)
    if (agentRecord !== null) {
      // Fail-closed indexing: once the agent is registered, an envelope that cannot verify can never be
      // served, so the write is rejected rather than repointing the index. The envelope is fully
      // self-authenticating here — body hash and operator signature both check against the chain record —
      // so any signer may carry it: the bytes are identical to what the operator published.
      verifySignedManifest({ envelope, agentRecord, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, now: await reader.now() })
      await store.setManifestIndex(bodyHash, envelopeHash, { verifiedAt: new Date(Number(clock()) * 1000).toISOString() })
    } else {
      // While the agent has no chain record, only the operator that signed the manifest may stage these
      // bytes — the same manifest uploaded by anyone else is denied. An operatorSignature that does not
      // recover names no one: the daily quota alone bounds it, and the row still cannot serve until a
      // registered agent record verifies it.
      if (operator !== null && !isAddressEqual(operator, signer)) {
        throw new MidaError("CAPABILITY_DENIED", "only the operator that signed this manifest may store it before the agent registers")
      }
      // For agents not yet on Monad the bytes are kept for later serving, but an existing index entry is
      // never displaced by an unverifiable write (first-write-wins).
      if (existing === undefined) await store.setManifestIndex(bodyHash, envelopeHash)
    }
    // Content-addressed: writing the same envelope again changes nothing and costs nothing.
    await store.blobs.put(manifestEnvelopeBytes(envelope))
    return c.json({ bodyHash, envelopeHash })
  })

  app.get("/agent-manifests/:bodyHash", async (c) => {
    const bodyHash = hex(c.req.param("bodyHash"), 32, "bodyHash")
    const entry = await store.getManifestIndex(bodyHash)
    if (entry === undefined) throw new MidaError("MANIFEST_NOT_FOUND", "no envelope indexed for this body hash")
    let bytes: Uint8Array
    try {
      bytes = await store.blobs.get(entry.envelopeHash)
    } catch (error) {
      if (isMidaError(error)) throw error
      throw new MidaError("MANIFEST_NOT_FOUND", "indexed envelope bytes are missing")
    }
    const envelope = parseManifestEnvelopeBytes({ bytes, expectedEnvelopeHash: entry.envelopeHash, expectedBodyHash: bodyHash })
    // A row marked verified inside the cache window is served without a chain read; older or never-verified
    // rows re-verify against Monad and refresh the mark. Negatives are never cached: a missing or failing
    // record is checked again on the next request, so a newly registered agent appears immediately and a
    // removed one disappears within MANIFEST_VERIFY_CACHE_SECONDS of its last verification.
    const nowMs = Number(clock()) * 1000
    const verifiedAgeMs = entry.verifiedAt === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(entry.verifiedAt)
    if (verifiedAgeMs < Number(MANIFEST_VERIFY_CACHE_SECONDS) * 1000) return c.json(envelope)
    const agentRecord = await reader.getAgent(envelope.manifest.agentId)
    if (agentRecord === null) throw new MidaError("AGENT_ID_MISMATCH", "manifest agent is not registered")
    verifySignedManifest({ envelope, agentRecord, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry, now: await reader.now() })
    await store.setManifestIndex(bodyHash, entry.envelopeHash, { verifiedAt: new Date(nowMs).toISOString() })
    return c.json(envelope)
  })

  // ---------- §12.4 reader-epoch wraps ----------
  app.post("/epoch-wraps", authenticated(limits.maxRequestBodyBytes), async (c) => {
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
    await store.putWrap(wrap)
    return c.json({ stored: true })
  })

  app.get("/epoch-wraps", authenticated(limits.maxRequestBodyBytes), async (c) => {
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
    const wrap = await store.getWrap({ owner, namespaceId, readEpoch: encodeUint64(readEpoch), agentId, agentKeyVersion: Number(versionText) })
    if (wrap === undefined) throw new MidaError("NO_EPOCH_WRAP", "no reader wrap is published yet for this agent key and epoch")
    return c.json(wrap)
  })

  // ---------- §12.5 fast revocation deny overlay ----------
  app.post("/revocations", authenticated(limits.maxRequestBodyBytes), async (c) => {
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
    const intent = await overlay.create(owner, target, agentEpochAtIntent)
    return c.json({ intentId: intent.id, state: intent.state, cancellationNonce: intent.cancellationNonce })
  })

  app.post("/revocations/:id/cancel", authenticated(limits.maxRequestBodyBytes), async (c) => {
    const owner = c.get("signer")
    const id = hex(c.req.param("id"), 32, "id")
    const request = json<{ expiresAt?: string; assertion?: WebAuthnAssertionInput }>(c.get("body"))
    const intent = await overlay.get(id)
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
    const cancelled = await overlay.cancel(intent.id, owner, nonce)
    return c.json({ intentId: cancelled.id, state: cancelled.state })
  })

  return { app, overlay, store, limits }
}
