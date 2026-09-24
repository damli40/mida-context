import { readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"
import { FsStorage, verifyContent } from "@mida/storage"
import { writeJsonAtomic } from "./secure-fs.js"
import { SWEEP_MAX_OBJECTS_PER_RUN } from "./stores.js"
import type { ManifestIndexEntry, ObjectStore, WrapKey } from "./stores.js"

/** A ciphertext upload's immutable metadata. Served as context only after Monad holds matching commitments (§12.2). */
export interface StoredObject {
  contextId: Hex
  owner: Address
  /** The authenticated signer that uploaded it; feeds the per-signer quotas. Absent in pre-M3 files → read as owner. */
  uploader: Address
  namespaceId: Hex
  authorId: Hex
  objectNonce: Hex
  expectedParentId: Hex
  manifest: ObjectManifest
  manifestHash: Hex
  uploadedAt: string
  /**
   * ISO-8601 UTC of the first verified isAnchored match, or null while pending. Set once, never cleared:
   * a Monad record cannot be un-registered, so a row that matched once matches forever. Absent in
   * pre-M3-A2 files → read as null (pending), which is always safe — it only costs a re-check.
   */
  anchoredAt: string | null
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

function normalize(object: StoredObject): StoredObject {
  return { ...object, uploader: object.uploader ?? object.owner, anchoredAt: object.anchoredAt ?? null }
}

/**
 * The file-backed ObjectStore, the default when `createContextApi` is given a data directory: content-addressed
 * blobs in FsStorage (ciphertext and signed manifest envelopes), plus JSON files for object metadata, reader wraps,
 * the manifest body-hash index and the per-signer PUT counts. Every path segment is validated hex. Being a
 * single-writer file store, its check-and-record operations are trivially atomic.
 */
export class ApiStore implements ObjectStore {
  readonly blobs: FsStorage
  readonly #dir: string
  #puts: Map<string, number> | undefined

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.blobs = new FsStorage(join(dataDir, "blobs"))
  }

  async putObject(object: StoredObject): Promise<void> {
    const path = join(this.#dir, "objects", `${object.contextId}.json`)
    const existing = readJson<StoredObject>(path)
    if (existing !== undefined) {
      if (existing.manifestHash !== object.manifestHash) {
        throw new MidaError("COMMITMENT_MISMATCH", "a different manifest is already stored for this contextId")
      }
      return
    }
    writeJsonAtomic(this.#dir, path, normalize(object))
  }

  async getObject(contextId: Hex): Promise<StoredObject | undefined> {
    const object = readJson<StoredObject>(join(this.#dir, "objects", `${contextId}.json`))
    return object === undefined ? undefined : normalize(object)
  }

  async listObjects(owner: Address, namespaceId: Hex): Promise<StoredObject[]> {
    return (await this.#allObjects())
      .filter((object) => object.owner === owner && object.namespaceId === namespaceId)
      .sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.contextId < b.contextId ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1))
  }

  async putObjectWithinPending(object: StoredObject, maxPendingBytes: number, blob: Uint8Array, pendingSince?: Date): Promise<"stored" | "repeat" | "over-cap"> {
    verifyContent(object.manifest.ciphertextHash, blob)
    const path = join(this.#dir, "objects", `${object.contextId}.json`)
    const existing = readJson<StoredObject>(path)
    if (existing !== undefined) {
      if (existing.manifestHash !== object.manifestHash) {
        throw new MidaError("COMMITMENT_MISMATCH", "a different manifest is already stored for this contextId")
      }
      // A repeat still (re)writes the blob — healing a row whose first upload crashed between writes.
      await this.blobs.put(blob)
      return "repeat"
    }
    // The check runs fully synchronously — no await between the directory read and the write — so a
    // single Node process cannot interleave two admissions. Across processes it is not atomic, which
    // is why the README documents one process per data directory.
    let pending = object.manifest.ciphertextSize
    const uploader = object.uploader.toLowerCase()
    const pendingSinceMs = pendingSince?.getTime()
    for (const other of this.#allObjectsSync()) {
      if (
        other.uploader.toLowerCase() === uploader &&
        other.anchoredAt === null &&
        (pendingSinceMs === undefined || Date.parse(other.uploadedAt) >= pendingSinceMs)
      ) {
        pending += other.manifest.ciphertextSize
      }
    }
    if (pending > maxPendingBytes) return "over-cap"
    // The row lands before the blob here: this process's sweeps re-check references at delete time,
    // so the written row already protects the hash, and a crash leaves a pending row the 24 h sweep
    // reclaims — never an orphan blob file nothing counts.
    writeJsonAtomic(this.#dir, path, normalize(object))
    await this.blobs.put(blob)
    return "stored"
  }

  async pendingByUploader(uploader: Address): Promise<StoredObject[]> {
    const key = uploader.toLowerCase()
    return (await this.#allObjects())
      .filter((object) => object.uploader.toLowerCase() === key && object.anchoredAt === null)
      .sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.contextId < b.contextId ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1))
  }

  async markAnchored(contextId: Hex, anchoredAt: string): Promise<void> {
    const path = join(this.#dir, "objects", `${contextId}.json`)
    const object = readJson<StoredObject>(path)
    if (object === undefined || (object.anchoredAt ?? null) !== null) return
    writeJsonAtomic(this.#dir, path, { ...normalize(object), anchoredAt })
  }

  async #allObjects(): Promise<StoredObject[]> {
    return this.#allObjectsSync()
  }

  /** The synchronous core — `putObjectWithinPending` uses it so its check-and-write never yields. */
  #allObjectsSync(): StoredObject[] {
    let names: string[]
    try {
      names = readdirSync(join(this.#dir, "objects")).filter((name) => name.endsWith(".json"))
    } catch {
      return []
    }
    return names
      .map((name) => readJson<StoredObject>(join(this.#dir, "objects", name)))
      .filter((object): object is StoredObject => object !== undefined)
      .map(normalize)
  }

  #wrapPath(key: WrapKey): string {
    return join(this.#dir, "wraps", key.owner, key.namespaceId, key.readEpoch, `${key.agentId}-${key.agentKeyVersion}.json`)
  }

  async putWrap(wrap: ReaderEpochWrap): Promise<void> {
    writeJsonAtomic(this.#dir, this.#wrapPath(wrap), wrap)
  }

  async getWrap(key: WrapKey): Promise<ReaderEpochWrap | undefined> {
    return readJson<ReaderEpochWrap>(this.#wrapPath(key))
  }

  #manifestIndexPath(bodyHash: Hex): string {
    return join(this.#dir, "agent-manifests", `${bodyHash}.json`)
  }

  #readManifestIndex(bodyHash: Hex): ManifestIndexEntry | undefined {
    const entry = readJson<Partial<ManifestIndexEntry> & { envelopeHash?: Hex }>(this.#manifestIndexPath(bodyHash))
    if (entry === undefined || typeof entry.envelopeHash !== "string") return undefined
    // Pre-M3-A2 rows carry only the envelope hash: no store time means the 24 h window has long expired,
    // so they read as ancient unverified rows and the sweep reclaims them.
    return { envelopeHash: entry.envelopeHash, storedAt: entry.storedAt ?? new Date(0).toISOString(), verifiedAt: entry.verifiedAt ?? null }
  }

  async setManifestIndex(bodyHash: Hex, envelopeHash: Hex, opts?: { storedAt?: string; verifiedAt?: string | null }): Promise<void> {
    const existing = this.#readManifestIndex(bodyHash)
    const entry: ManifestIndexEntry = {
      envelopeHash,
      storedAt: opts?.storedAt ?? existing?.storedAt ?? new Date().toISOString(),
      verifiedAt: opts?.verifiedAt ?? null,
    }
    writeJsonAtomic(this.#dir, this.#manifestIndexPath(bodyHash), entry)
  }

  async getManifestIndex(bodyHash: Hex): Promise<ManifestIndexEntry | undefined> {
    return this.#readManifestIndex(bodyHash)
  }

  async recordPut(signer: Address, day: string): Promise<number> {
    return this.#recordPut(`${signer.toLowerCase()}:${day}`)
  }

  async recordManifestPut(signer: Address, day: string): Promise<number> {
    return this.#recordPut(`manifest:${signer.toLowerCase()}:${day}`)
  }

  #recordPut(key: string): number {
    const puts = this.#loadPuts()
    const count = (puts.get(key) ?? 0) + 1
    puts.set(key, count)
    writeJsonAtomic(this.#dir, join(this.#dir, "puts.json"), Object.fromEntries(puts))
    return count
  }

  #loadPuts(): Map<string, number> {
    if (this.#puts === undefined) {
      const stored = readJson<Record<string, number>>(join(this.#dir, "puts.json")) ?? {}
      this.#puts = new Map(Object.entries(stored))
    }
    return this.#puts
  }

  /** Every blob hash a surviving row can still serve: object ciphertexts and indexed manifest envelopes. */
  #referencedBlobHashes(): Set<string> {
    const referenced = new Set<string>()
    for (const object of this.#allObjectsSync()) referenced.add(object.manifest.ciphertextHash.toLowerCase())
    let names: string[]
    try {
      names = readdirSync(join(this.#dir, "agent-manifests")).filter((name) => name.endsWith(".json"))
    } catch {
      names = []
    }
    for (const name of names) {
      const entry = this.#readManifestIndex(name.slice(0, -5) as Hex)
      if (entry !== undefined) referenced.add(entry.envelopeHash.toLowerCase())
    }
    return referenced
  }

  /** A blob file may be deleted when it is older than the grace cutoff (or no grace was asked for). */
  #blobReclaimable(hash: Hex, cutoffMs: number): boolean {
    try {
      return statSync(this.blobs.pathFor(hash)).mtimeMs < cutoffMs
    } catch {
      // Missing or unreadable: nothing young to spare — let the delete run (rmSync force no-ops).
      return true
    }
  }

  async sweepPending(olderThan: Date, stillPending: (object: StoredObject) => Promise<boolean>, blobGraceCutoff?: Date): Promise<number> {
    const cutoff = olderThan.getTime()
    const graceMs = blobGraceCutoff?.getTime() ?? Number.POSITIVE_INFINITY
    const markedAt = new Date().toISOString()
    let removed = 0
    // Candidates are the oldest unmarked rows past the window, capped at SWEEP_MAX_OBJECTS_PER_RUN:
    // each stillPending ask is a chain read, and one run must fit the platform subrequest ceiling.
    const candidates = (await this.#allObjects())
      .filter((object) => object.anchoredAt === null && !Number.isNaN(Date.parse(object.uploadedAt)) && Date.parse(object.uploadedAt) < cutoff)
      .sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.contextId < b.contextId ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1))
      .slice(0, SWEEP_MAX_OBJECTS_PER_RUN)
    for (const object of candidates) {
      let pending: boolean
      try {
        pending = await stillPending(object)
      } catch {
        // A failed chain read leaves the row for the next run — never deleted, never marked.
        continue
      }
      if (pending) {
        const path = join(this.#dir, "objects", `${object.contextId}.json`)
        // Re-read before deleting — the file-backed race guard matching D1's AND anchored_at IS NULL:
        // a mark that landed while the chain was asked (stillPending itself can mark) wins; the row stays.
        const fresh = readJson<StoredObject>(path)
        if (fresh === undefined || (fresh.anchoredAt ?? null) !== null) continue
        rmSync(path)
        removed += 1
        // The row's ciphertext blob dies with it only when no surviving row references the hash —
        // another object's ciphertext, or a manifest index row's envelope (identical bytes, one hash)
        // — and only when it is past the grace window: a younger blob belongs to a row still landing.
        if (!this.#referencedBlobHashes().has(object.manifest.ciphertextHash.toLowerCase()) && this.#blobReclaimable(object.manifest.ciphertextHash, graceMs)) {
          rmSync(this.blobs.pathFor(object.manifest.ciphertextHash), { force: true })
        }
      } else {
        // stillPending reported an anchored record: mark the first verified match and keep the row.
        await this.markAnchored(object.contextId, markedAt)
      }
    }
    return removed
  }

  async sweepManifests(olderThan: Date, blobGraceCutoff?: Date): Promise<number> {
    const cutoff = olderThan.getTime()
    const graceMs = blobGraceCutoff?.getTime() ?? Number.POSITIVE_INFINITY
    const folder = join(this.#dir, "agent-manifests")
    let names: string[]
    try {
      names = readdirSync(folder).filter((name) => name.endsWith(".json"))
    } catch {
      return 0
    }
    const expired = new Set<Hex>()
    let removed = 0
    for (const name of names) {
      const entry = this.#readManifestIndex(name.slice(0, -5) as Hex)
      if (entry === undefined || entry.verifiedAt !== null) continue
      const storedAt = Date.parse(entry.storedAt)
      if (Number.isNaN(storedAt) || storedAt >= cutoff) continue
      rmSync(join(folder, name))
      expired.add(entry.envelopeHash)
      removed += 1
    }
    if (removed === 0) return 0
    // A blob dies only when nothing references its hash: surviving index rows and every object's
    // ciphertext — and only past the grace window, same as the object sweep above.
    const referenced = this.#referencedBlobHashes()
    for (const hash of expired) {
      if (!referenced.has(hash.toLowerCase()) && this.#blobReclaimable(hash, graceMs)) rmSync(this.blobs.pathFor(hash), { force: true })
    }
    return removed
  }
}
