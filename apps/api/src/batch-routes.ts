// BatchAnchor Task 5: the batching lane's HTTP surface. POST /batch/saves queues one agent-signed
// save after checking it the way the contract will (signature, registered agent, shape,
// commitments) and hands back a signed receipt — proof the store took responsibility, not proof the
// chain accepted anything. GETs serve rows under exactly the authorization GET /objects uses.
// POST /batch/flush pokes the injected batcher — authenticated, skipped when empty, once per 10 s
// per signer (Amendment B.4). The batcher itself is Task 6; here it is two injected callbacks.
//
// Codes like BATCHING_DISABLED / ALREADY_QUEUED / SIGNER_MISMATCH / NOT_AN_AGENT / BAD_SHAPE /
// TOO_LARGE are not MidaErrorCodes (the plan fixed their names); they go out as the same
// { error: { code, message } } body onError produces for MidaError.

import type { Context, Hono, MiddlewareHandler } from "hono"
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, zeroAddress, zeroHash } from "viem"
import type { LocalAccount } from "viem"
import {
  CONTEXT_KIND,
  MidaError,
  PERMISSION,
  PROVENANCE_POLICY,
  PROVENANCE_SOURCE,
  batchContextId,
  batchSaveTypedData,
  decodeUint64,
  namespaceById,
} from "@mida/protocol"
import type { Address, BatchSaveMessage, Hex } from "@mida/protocol"
import { bytesOf, ciphertextHash, manifestHash, verifyObjectManifest } from "@mida/crypto"
import type { Deployment } from "@mida/chain"
import { authorizeAgent } from "./authorize.js"
import type { BudgetedReader } from "./chain-budget.js"
import type { BatchedReadItem, BatchedSaveWire, BatchReceipt } from "./client.js"
import type { DenyOverlay } from "./deny-overlay.js"
import type { StoreLimits } from "./stores.js"
import { address, hex, parseObjectManifest } from "./wire.js"
import { batchReadItem } from "./batch-store.js"
import type { BatchSaveRow, BatchStore } from "./batch-store.js"

/** What app.ts mounts under when batching is configured; absent means no batch surface at all. */
export interface BatchingOptions {
  /** Kill switch — routes stay mounted but POSTs answer 503 BATCHING_DISABLED. */
  enabled: boolean
  batchAnchor: Address
  store: BatchStore
  /**
   * Signs admission receipts; a store key, unrelated to any chain identity. Only the enabled lane
   * ever signs — with `enabled: false` the field may be absent entirely (the worker keeps the
   * secret optional then so a missing one cannot take the whole store down).
   */
  receiptAccount?: LocalAccount
  /**
   * Proves batchAnchor is the contract this deployment expects — run lazily on the first batch
   * request and cached by the implementer. A throw refuses the batch surface with its message.
   */
  verifyAnchor?: () => Promise<void>
  /**
   * Trial gate: when present and non-empty, POST /batch/saves admits only saves whose signed
   * owner is on this list (compared case-insensitively — entries are matched against the
   * wire's lowercase address). Absent or empty leaves admission exactly as it was.
   */
  ownerAllowlist?: readonly Address[]
  /** Wake-up for the batcher, called exactly once per accepted save. */
  notify: () => void
  /** Runs one submission round; invoked by POST /batch/flush after its checks pass. */
  flush: () => Promise<void>
  /** Wall clock in ms — injectable so tests control receivedAt and the 10 s flush window. */
  now?: () => number
}

/** The request variables the app's middleware sets — kept structurally identical to app.ts's Env. */
export interface BatchRouteEnv {
  Variables: {
    signer: Address
    body: Uint8Array
    chain: BudgetedReader
  }
}

const FLUSH_WINDOW_MS = 10_000

const wire = (message: string): never => {
  throw new MidaError("INVALID_WIRE", message)
}

const reject = (c: Context<BatchRouteEnv>, status: 400 | 403 | 404 | 409 | 503, code: string, message: string) =>
  c.json({ error: { code, message } }, status)

function strictObject(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) wire(`${name} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of keys) if (!Object.hasOwn(record, key)) wire(`${name}.${key} is required`)
  for (const key of Object.keys(record)) if (!keys.includes(key)) wire(`${name}.${key} is not a known field`)
  return record
}

function uint64String(value: unknown, name: string): string {
  if (typeof value !== "string") return wire(`${name} must be a base-10 string`)
  decodeUint64(value) // throws INVALID_WIRE on non-canonical or out-of-range input
  return value
}

function smallUint(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    return wire(`${name} must be an integer between 0 and ${max}`)
  }
  return value
}

const optionalCapability = (value: string | undefined): Hex | undefined =>
  value === undefined ? undefined : hex(value, 32, "capabilityId")

/** Same posture as wire.ts's parseObjectUpload: strict keys, canonical encodings, INVALID_WIRE else. */
function parseBatchedSave(value: unknown): BatchedSaveWire {
  const body = strictObject(value, "save", ["message", "signature", "manifest", "ciphertext"])
  const message = strictObject(body.message, "save.message", [
    "owner",
    "namespaceId",
    "objectNonce",
    "lineageId",
    "parentId",
    "parentVersion",
    "rootAuthor",
    "manifestHash",
    "ciphertextCommitment",
    "readEpoch",
    "expiresAt",
    "kind",
    "provenanceSource",
  ])
  if (typeof body.signature !== "string" || !/^0x[0-9a-f]{130}$/.test(body.signature)) {
    wire("save.signature must be a lowercase 65-byte hex")
  }
  if (typeof body.ciphertext !== "string" || !/^0x[0-9a-f]{2}(?:[0-9a-f]{2})*$/.test(body.ciphertext)) {
    wire("save.ciphertext must be lowercase hex")
  }
  return {
    message: {
      owner: address(message.owner, "save.message.owner"),
      namespaceId: hex(message.namespaceId, 32, "save.message.namespaceId"),
      objectNonce: hex(message.objectNonce, 32, "save.message.objectNonce"),
      lineageId: hex(message.lineageId, 32, "save.message.lineageId"),
      parentId: hex(message.parentId, 32, "save.message.parentId"),
      parentVersion: smallUint(message.parentVersion, "save.message.parentVersion", 0xffffffff),
      rootAuthor: hex(message.rootAuthor, 32, "save.message.rootAuthor"),
      manifestHash: hex(message.manifestHash, 32, "save.message.manifestHash"),
      ciphertextCommitment: hex(message.ciphertextCommitment, 32, "save.message.ciphertextCommitment"),
      readEpoch: uint64String(message.readEpoch, "save.message.readEpoch"),
      expiresAt: uint64String(message.expiresAt, "save.message.expiresAt"),
      kind: smallUint(message.kind, "save.message.kind", 0xff),
      provenanceSource: smallUint(message.provenanceSource, "save.message.provenanceSource", 0xff),
    },
    signature: body.signature as Hex,
    manifest: parseObjectManifest(body.manifest),
    ciphertext: body.ciphertext as Hex,
  }
}

/**
 * The shape rules BatchAnchor.sol enforces under BAD_SHAPE: batched saves are CONTEXT records with
 * AGENT_INFERRED provenance (Amendment A.5), and a new lineage carries no lineage fields. The store
 * refuses what the contract could never accept — queue space is not for dead saves.
 */
function badShape(message: BatchedSaveWire["message"]): string | null {
  if (message.owner === zeroAddress) return "owner must not be the zero address"
  if (message.kind === 0 || message.kind > CONTEXT_KIND.OPEN_LOOP) return "kind must be 1..8"
  if (message.provenanceSource !== PROVENANCE_SOURCE.AGENT_INFERRED) return "provenanceSource must be AGENT_INFERRED"
  if (message.manifestHash === zeroHash) return "manifestHash must not be zero"
  if (message.ciphertextCommitment === zeroHash) return "ciphertextCommitment must not be zero"
  if (message.parentId === zeroHash) {
    if (message.lineageId !== zeroHash) return "a new lineage must not carry a lineageId"
    if (message.parentVersion !== 0) return "a new lineage has parentVersion 0"
    if (message.rootAuthor !== zeroHash) return "a new lineage has no rootAuthor"
  } else if (message.parentVersion === 0 || message.parentVersion === 0xffffffff) {
    return "parentVersion must be 1..0xfffffffe"
  }
  return null
}

export interface BatchRouteDeps {
  batching: BatchingOptions
  deployment: Deployment
  limits: StoreLimits
  overlay: DenyOverlay
  authenticated: (maxBodyBytes: number) => MiddlewareHandler<BatchRouteEnv>
  /** The app's strict JSON body parser — INVALID_WIRE on any malformed input. */
  json: <T>(body: Uint8Array) => T
}

export function mountBatchRoutes(app: Hono<BatchRouteEnv>, deps: BatchRouteDeps): void {
  const { batching, deployment, limits, overlay, authenticated, json } = deps
  const now = () => batching.now?.() ?? Date.now()

  // When the lane is on, every batch route first asks verifyAnchor — the once-only, cached check
  // that BATCH_ANCHOR really is the deployment's anchor contract. A failure (mismatch or an
  // unreadable chain) refuses the surface rather than trust state from the wrong contract.
  const anchorRefusal = async (c: Context<BatchRouteEnv>): Promise<Response | null> => {
    if (batching.verifyAnchor === undefined) return null
    try {
      await batching.verifyAnchor()
      return null
    } catch (error) {
      return reject(c, 503, "BATCH_ANCHOR_UNVERIFIED", error instanceof Error ? error.message : String(error))
    }
  }

  // Public: the only fact a would-be submitter needs is whether this store batches, and where.
  app.get("/batch/status", (c) => c.json({ enabled: batching.enabled, batchAnchor: batching.batchAnchor }))

  app.post("/batch/saves", authenticated(limits.maxRequestBodyBytes), async (c) => {
    if (!batching.enabled) return reject(c, 503, "BATCHING_DISABLED", "batched saves are not enabled on this store")
    const saveRefusal = await anchorRefusal(c)
    if (saveRefusal !== null) return saveRefusal
    const signer = c.get("signer")
    const reader = c.get("chain")
    const save = parseBatchedSave(json(c.get("body")))

    // The trial gate runs before any crypto or chain work: an owner the allowlist does not name
    // gets the plain refusal whatever else the save would have failed.
    if (
      batching.ownerAllowlist !== undefined &&
      batching.ownerAllowlist.length > 0 &&
      !batching.ownerAllowlist.some((listed) => listed.toLowerCase() === save.message.owner.toLowerCase())
    ) {
      return reject(c, 403, "OWNER_NOT_ALLOWED", `batched saves on this store are not open to owner ${save.message.owner}`)
    }

    const ciphertextBytes = bytesOf(save.ciphertext, (save.ciphertext.length - 2) / 2)
    if (ciphertextBytes.length > limits.maxCiphertextBytes) {
      return reject(c, 400, "TOO_LARGE", `ciphertext exceeds the ${limits.maxCiphertextBytes}-byte limit`)
    }
    const shapeProblem = badShape(save.message)
    if (shapeProblem !== null) return reject(c, 400, "BAD_SHAPE", shapeProblem)
    namespaceById(save.message.namespaceId) // unregistered area: INVALID_NAMESPACE, same as PUT /objects

    const message: BatchSaveMessage = {
      ...save.message,
      readEpoch: decodeUint64(save.message.readEpoch),
      expiresAt: decodeUint64(save.message.expiresAt),
    }
    const typed = batchSaveTypedData({ chainId: deployment.chainId, batchAnchor: batching.batchAnchor, message })
    let recovered: Address
    try {
      recovered = (await recoverTypedDataAddress({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
        signature: save.signature,
      })) as Address
    } catch {
      recovered = zeroAddress
    }
    if (recovered.toLowerCase() !== signer) {
      return reject(c, 400, "SIGNER_MISMATCH", "the save signature does not recover to the request signer")
    }
    const agentId = await reader.agentIdOfSigner(signer)
    if (agentId === null) return reject(c, 400, "NOT_AN_AGENT", "the request signer is not a registered agent")

    // The id the contract will compute: the recovered agentId inside, so a manifest claiming a
    // contextId the signed fields cannot produce fails here as a commitment mismatch.
    const contextId = batchContextId({
      chainId: deployment.chainId,
      batchAnchor: batching.batchAnchor,
      owner: save.message.owner,
      agentId,
      namespaceId: save.message.namespaceId,
      parentId: save.message.parentId,
      objectNonce: save.message.objectNonce,
    })
    if (save.manifest.contextId !== contextId) {
      return reject(c, 400, "COMMITMENT_MISMATCH", "the manifest commits to a contextId the signed save cannot produce")
    }
    // Both signed commitments are checked against what was sent: the manifest must hash to
    // message.manifestHash and the bytes to message.ciphertextCommitment — the two fields the
    // Merkle leaf stands behind. verifyObjectManifest then covers internal consistency (wrap
    // binding, size, the manifest's own ciphertextHash) with its own MANIFEST_MISMATCH /
    // CONTENT_HASH_MISMATCH codes.
    if (manifestHash(save.manifest) !== message.manifestHash) {
      return reject(c, 400, "COMMITMENT_MISMATCH", "the manifest does not hash to the signed manifestHash")
    }
    if (ciphertextHash(ciphertextBytes) !== message.ciphertextCommitment) {
      return reject(c, 400, "COMMITMENT_MISMATCH", "the ciphertext does not hash to the signed ciphertextCommitment")
    }
    verifyObjectManifest({ manifest: save.manifest, expectedManifestHash: message.manifestHash, ciphertext: ciphertextBytes })

    // Live authority, chosen the way BatchAnchor._checkAndApply chooses it: a new lineage needs
    // CREATE+ALLOW_INFERENCE; a replacement needs SUPERSEDE_OWN when the signer authored the lineage
    // root, and SUPERSEDE_ANY either way as the contract's fallback. Queueing a save that can only
    // be rejected on chain spends everyone's batch — refuse it before a row exists.
    const hasAuthority = (permission: number): Promise<boolean> =>
      reader.hasAuthority(save.message.owner, agentId, save.message.namespaceId, permission, PROVENANCE_POLICY.ALLOW_INFERENCE)
    const allowed =
      save.message.parentId === zeroHash
        ? await hasAuthority(PERMISSION.CREATE)
        : (save.message.rootAuthor.toLowerCase() === agentId.toLowerCase() && (await hasAuthority(PERMISSION.SUPERSEDE_OWN))) ||
          (await hasAuthority(PERMISSION.SUPERSEDE_ANY))
    if (!allowed) {
      return reject(c, 403, "CAPABILITY_DENIED", "the signer holds no live grant covering this save")
    }

    const receivedAt = now()
    const row: BatchSaveRow = {
      contextId,
      owner: save.message.owner,
      namespaceId: save.message.namespaceId,
      signer,
      save,
      state: "QUEUED",
      reason: null,
      batchId: null,
      position: null,
      lineageId: null,
      version: null,
      proof: null,
      receivedAt,
      anchoredAt: null,
    }
    if ((await batching.store.insert(row)) === "exists") {
      return reject(c, 409, "ALREADY_QUEUED", "a save with this contextId is already stored")
    }
    const sequence = await batching.store.nextSequence()
    const receiptDigest = keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        ["MIDA_BATCH_RECEIPT_V1", contextId, BigInt(receivedAt), sequence],
      ),
    )
    const receiptAccount = batching.receiptAccount
    if (receiptAccount === undefined) {
      // Enabled without a receipt key is a construction bug — the worker refuses that env at boot —
      // but a hand-rolled BatchingOptions can still reach here; refuse rather than sign nothing.
      throw new Error("batching is enabled but no receipt account was configured")
    }
    const signature = await receiptAccount.signMessage({ message: { raw: receiptDigest } })
    const receipt: BatchReceipt = { contextId, receivedAt, sequence: sequence.toString(10), signature }
    batching.notify() // once, after the row exists — a refused save never wakes the batcher
    return c.json({ state: "QUEUED" as const, receipt }, 201)
  })

  // Same authorization as GET /objects: the owner reads freely; anyone else needs a live READ grant
  // on the area. Anchored and pending rows list; REJECTED rows never do.
  app.get("/batch/saves", authenticated(limits.maxRequestBodyBytes), async (c) => {
    const listRefusal = await anchorRefusal(c)
    if (listRefusal !== null) return listRefusal
    const signer = c.get("signer")
    const reader = c.get("chain")
    const owner = address(c.req.query("owner"), "owner")
    const namespaceId = hex(c.req.query("namespaceId"), 32, "namespaceId")
    namespaceById(namespaceId)
    if (signer !== owner) {
      await authorizeAgent({ reader, overlay, signer, owner, capabilityId: optionalCapability(c.req.query("capabilityId")), namespaceId, permission: PERMISSION.READ })
    }
    const rows = await batching.store.listForReader(owner, namespaceId)
    return c.json({ items: rows.map(batchReadItem) satisfies BatchedReadItem[] })
  })

  app.get("/batch/saves/:contextId", authenticated(limits.maxRequestBodyBytes), async (c) => {
    const getRefusal = await anchorRefusal(c)
    if (getRefusal !== null) return getRefusal
    const signer = c.get("signer")
    const reader = c.get("chain")
    const contextId = hex(c.req.param("contextId"), 32, "contextId")
    const row = await batching.store.get(contextId)
    if (row === null) throw new MidaError("NOT_FOUND", `no batched save ${contextId}`)
    // Owner and the signer who uploaded it read unconditionally; anyone else faces GET /objects' rule.
    if (signer !== row.owner && signer !== row.signer) {
      await authorizeAgent({
        reader,
        overlay,
        signer,
        owner: row.owner,
        capabilityId: optionalCapability(c.req.query("capabilityId")),
        namespaceId: row.namespaceId,
        permission: PERMISSION.READ,
      })
    }
    if (row.state === "REJECTED") return c.json({ state: row.state, reason: row.reason })
    return c.json({ state: row.state, reason: row.reason, item: batchReadItem(row) })
  })

  // Amendment B.4: a reading agent triggers the flush on switch. Only a registered agent or an
  // owner key may ask — a stranger cannot even learn whether the queue holds anything.
  app.post("/batch/flush", authenticated(limits.maxRequestBodyBytes), async (c) => {
    if (!batching.enabled) return reject(c, 503, "BATCHING_DISABLED", "batched saves are not enabled on this store")
    const flushRefusal = await anchorRefusal(c)
    if (flushRefusal !== null) return flushRefusal
    const signer = c.get("signer")
    const reader = c.get("chain")
    const isAgent = (await reader.agentIdOfSigner(signer)) !== null
    const isOwner = isAgent || (await reader.ownerP256Key(signer)) !== null
    if (!isAgent && !isOwner) {
      return reject(c, 403, "CAPABILITY_DENIED", "only a registered agent or an owner key may flush the batch")
    }
    if ((await batching.store.countQueued()) === 0) return c.json({ flushed: false, reason: "empty" })
    const at = now()
    const last = await batching.store.lastFlush(signer)
    if (last !== null && at - last < FLUSH_WINDOW_MS) return c.json({ flushed: false, reason: "rate-limited" })
    await batching.store.setLastFlush(signer, at)
    await batching.flush()
    return c.json({ flushed: true })
  })
}
