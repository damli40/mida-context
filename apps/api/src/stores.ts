import type { Address, Hex, ReaderEpochWrap } from "@mida/protocol"
import type { ContextStorage } from "@mida/storage"
import type { StoredObject } from "./store.js"
import type { RevocationIntent } from "./deny-overlay.js"

/** Key of a stored reader-epoch wrap (§12.4): one wrap per (owner, namespace, epoch, agent key version). */
export interface WrapKey {
  owner: Address
  namespaceId: Hex
  readEpoch: string
  agentId: Hex
  agentKeyVersion: number
}

/**
 * What the manifest index knows about one body hash: which envelope bytes it resolves to, when the row was
 * first stored, and — once the envelope verified against the agent's chain record — when it last did so.
 * `verifiedAt === null` means the agent has not registered on Monad yet (or the row was never re-checked):
 * such rows are the sweep's job, because unverifiable staging bytes must not live forever.
 */
export interface ManifestIndexEntry {
  envelopeHash: Hex
  /** ISO-8601 UTC; set once when the row is created and preserved on repointing writes. */
  storedAt: string
  /** ISO-8601 UTC of the last successful verifySignedManifest, or null while unverified. */
  verifiedAt: string | null
}

/**
 * Everything the Context API persists about objects, wraps and the manifest index, behind one async interface so the
 * same app can run on the file-backed `ApiStore` or on D1 in the hosted worker. `blobs` is the §9.2 content-addressed
 * byte store (`@mida/storage`); it still verifies content against its hash on every get.
 */
export interface ObjectStore {
  readonly blobs: ContextStorage
  putObject(object: StoredObject): Promise<void>
  getObject(contextId: Hex): Promise<StoredObject | undefined>
  listObjects(owner: Address, namespaceId: Hex): Promise<StoredObject[]>
  /**
   * This signer's objects that were never observed anchored on Monad (`anchoredAt` null), oldest
   * first — the bounded set the pending-bytes quota re-checks. Rows marked anchored are excluded:
   * anchoring cannot un-happen on this chain, so re-reading their records would be pure cost.
   */
  pendingByUploader(uploader: Address): Promise<StoredObject[]>
  /**
   * Records that this object was observed matching its Monad record at `anchoredAt`. First write
   * wins: the mark is set once — it records a verified match, not merely that a record exists —
   * and is never cleared, because a record cannot be un-registered on this chain design.
   */
  markAnchored(contextId: Hex, anchoredAt: string): Promise<void>
  putWrap(wrap: ReaderEpochWrap): Promise<void>
  getWrap(key: WrapKey): Promise<ReaderEpochWrap | undefined>
  /**
   * Records or repoints bodyHash → envelopeHash. `storedAt` defaults to now and is only ever set on a new row;
   * `verifiedAt` marks that the envelope just passed verifySignedManifest (omit for unverified staging bytes).
   */
  setManifestIndex(bodyHash: Hex, envelopeHash: Hex, opts?: { storedAt?: string; verifiedAt?: string | null }): Promise<void>
  getManifestIndex(bodyHash: Hex): Promise<ManifestIndexEntry | undefined>
  /** Atomically counts one accepted PUT for this signer on this UTC day (`YYYY-MM-DD`) and returns the day's total. */
  recordPut(signer: Address, day: string): Promise<number>
  /** Same atomic daily count as `recordPut`, on a separate counter for `PUT /agent-manifests`. */
  recordManifestPut(signer: Address, day: string): Promise<number>
  /**
   * Deletes every object uploaded before `olderThan` for which `stillPending` reports true — but only
   * unmarked rows are even asked. A row `stillPending` reports false for was observed anchored: the
   * implementation marks it once instead of deleting, so the next sweep skips it without a chain read.
   * Returns how many objects were removed.
   */
  sweepPending(olderThan: Date, stillPending: (object: StoredObject) => Promise<boolean>): Promise<number>
  /**
   * Deletes every manifest index row still unverified (`verifiedAt` null) whose `storedAt` is before
   * `olderThan` — the agent never registered, so the staged bytes can never serve. Each removed row's blob is
   * deleted only when no other row references that hash (another index row, or an object's ciphertextHash).
   */
  sweepManifests(olderThan: Date): Promise<number>
}

/**
 * The §12.1 replay record. `consume` is the check-and-record of a (signer, nonce) pair as ONE atomic operation:
 * an implementation backed by a single-writer file serializes it, a database-backed one uses a uniqueness
 * constraint — an in-memory Map is never acceptable because the hosted worker runs many copies at once.
 */
export interface NonceStore {
  consume(signer: Address, nonce: Hex, signedAt: bigint, now: bigint): Promise<void>
  /** Drops records whose signed timestamp is older than `now - REQUEST_WINDOW_SECONDS`. Returns how many went. */
  sweep(now: bigint): Promise<number>
}

/** What `deny-overlay.ts` persists: the revocation-intent rows the overlay's three transitions mutate. */
export interface DenyStore {
  list(): Promise<RevocationIntent[]>
  get(id: Hex): Promise<RevocationIntent | undefined>
  insert(intent: RevocationIntent): Promise<void>
  update(intent: RevocationIntent): Promise<void>
}

/** The three stores the app needs, bundled so `createContextApi` can take them in one option. */
export interface ContextStores {
  objects: ObjectStore
  nonces: NonceStore
  denies: DenyStore
}

/** Upload-abuse limits, applied by the shared app so self-hosters get them too. */
export interface StoreLimits {
  /** Decoded ciphertext bytes accepted per object (a checkpoint is a few KB). */
  maxCiphertextBytes: number
  /** Accepted PUT /objects per signer per UTC day. */
  maxPutsPerSignerPerDay: number
  /** Total ciphertext bytes a signer may hold in objects that are not anchored on chain yet. */
  maxPendingBytesPerSigner: number
  /** Raw body bytes for the agent-manifest PUT (a manifest is a few KB). */
  maxManifestBodyBytes: number
  /** Accepted PUT /agent-manifests per signer per UTC day — the quota a request signature buys. */
  maxManifestPutsPerSignerPerDay: number
  /** Raw body bytes for any authenticated route. */
  maxRequestBodyBytes: number
}

export const DEFAULT_STORE_LIMITS: StoreLimits = {
  maxCiphertextBytes: 262_144,
  maxPutsPerSignerPerDay: 2_000,
  maxPendingBytesPerSigner: 20 * 1024 * 1024,
  maxManifestBodyBytes: 16_384,
  maxManifestPutsPerSignerPerDay: 20,
  maxRequestBodyBytes: 1_048_576,
}

/** Pending uploads older than this are swept: they were never anchored, so they only cost storage. */
export const PENDING_OBJECT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The worker's scheduled job and any self-hoster's cron call: drop pending objects older than the window,
 * unverified manifests past the same window, and nonces outside the freshness window. `isAnchored` checks
 * Monad, so an anchored object is never swept.
 */
export async function sweepStores(input: {
  stores: ContextStores
  isAnchored: (object: StoredObject) => Promise<boolean>
  now?: Date
  pendingMaxAgeMs?: number
}): Promise<{ objectsRemoved: number; noncesRemoved: number; manifestsRemoved: number }> {
  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - (input.pendingMaxAgeMs ?? PENDING_OBJECT_MAX_AGE_MS))
  const objectsRemoved = await input.stores.objects.sweepPending(cutoff, async (object) => !(await input.isAnchored(object)))
  const manifestsRemoved = await input.stores.objects.sweepManifests(cutoff)
  const noncesRemoved = await input.stores.nonces.sweep(BigInt(Math.floor(now.getTime() / 1000)))
  return { objectsRemoved, noncesRemoved, manifestsRemoved }
}
