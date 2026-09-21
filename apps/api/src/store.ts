import { readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"
import { FsStorage } from "@mida/storage"
import { writeJsonAtomic } from "./secure-fs.js"
import type { ObjectStore, WrapKey } from "./stores.js"

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
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

function normalize(object: StoredObject): StoredObject {
  return { ...object, uploader: object.uploader ?? object.owner }
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
    writeJsonAtomic(this.#dir, path, object)
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

  async objectsByUploader(uploader: Address): Promise<StoredObject[]> {
    const key = uploader.toLowerCase()
    return (await this.#allObjects()).filter((object) => object.uploader.toLowerCase() === key)
  }

  async #allObjects(): Promise<StoredObject[]> {
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

  async setManifestIndex(bodyHash: Hex, envelopeHash: Hex): Promise<void> {
    writeJsonAtomic(this.#dir, join(this.#dir, "agent-manifests", `${bodyHash}.json`), { envelopeHash })
  }

  async getManifestIndex(bodyHash: Hex): Promise<Hex | undefined> {
    return readJson<{ envelopeHash: Hex }>(join(this.#dir, "agent-manifests", `${bodyHash}.json`))?.envelopeHash
  }

  async recordPut(signer: Address, day: string): Promise<number> {
    const puts = this.#loadPuts()
    const key = `${signer.toLowerCase()}:${day}`
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

  async sweepPending(olderThan: Date, stillPending: (object: StoredObject) => Promise<boolean>): Promise<number> {
    const cutoff = olderThan.getTime()
    let removed = 0
    for (const object of await this.#allObjects()) {
      const uploadedAt = Date.parse(object.uploadedAt)
      if (Number.isNaN(uploadedAt) || uploadedAt >= cutoff || !(await stillPending(object))) continue
      rmSync(join(this.#dir, "objects", `${object.contextId}.json`))
      removed += 1
    }
    return removed
  }
}
