import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"
import { FsStorage } from "@mida/storage"
import { writeJsonAtomic } from "./secure-fs.js"

/** A ciphertext upload's immutable metadata. Served as context only after Monad holds matching commitments (§12.2). */
export interface StoredObject {
  contextId: Hex
  owner: Address
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

/**
 * Context API persistence: content-addressed blobs in FsStorage (ciphertext and signed manifest envelopes), plus
 * JSON files for object metadata, reader wraps and the manifest body-hash index. Every path segment is validated hex.
 */
export class ApiStore {
  readonly blobs: FsStorage
  readonly #dir: string

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.blobs = new FsStorage(join(dataDir, "blobs"))
  }

  putObject(object: StoredObject): void {
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

  getObject(contextId: Hex): StoredObject | undefined {
    return readJson<StoredObject>(join(this.#dir, "objects", `${contextId}.json`))
  }

  listObjects(owner: Address, namespaceId: Hex): StoredObject[] {
    let names: string[]
    try {
      names = readdirSync(join(this.#dir, "objects")).filter((name) => name.endsWith(".json"))
    } catch {
      return []
    }
    return names
      .map((name) => readJson<StoredObject>(join(this.#dir, "objects", name)))
      .filter((object): object is StoredObject => object !== undefined && object.owner === owner && object.namespaceId === namespaceId)
      .sort((a, b) => (a.uploadedAt === b.uploadedAt ? (a.contextId < b.contextId ? -1 : 1) : a.uploadedAt < b.uploadedAt ? -1 : 1))
  }

  #wrapPath(key: { owner: Address; namespaceId: Hex; readEpoch: string; agentId: Hex; agentKeyVersion: number }): string {
    return join(this.#dir, "wraps", key.owner, key.namespaceId, key.readEpoch, `${key.agentId}-${key.agentKeyVersion}.json`)
  }

  putWrap(wrap: ReaderEpochWrap): void {
    writeJsonAtomic(this.#dir, this.#wrapPath(wrap), wrap)
  }

  getWrap(key: { owner: Address; namespaceId: Hex; readEpoch: string; agentId: Hex; agentKeyVersion: number }): ReaderEpochWrap | undefined {
    return readJson<ReaderEpochWrap>(this.#wrapPath(key))
  }

  setManifestIndex(bodyHash: Hex, envelopeHash: Hex): void {
    writeJsonAtomic(this.#dir, join(this.#dir, "agent-manifests", `${bodyHash}.json`), { envelopeHash })
  }

  getManifestIndex(bodyHash: Hex): Hex | undefined {
    return readJson<{ envelopeHash: Hex }>(join(this.#dir, "agent-manifests", `${bodyHash}.json`))?.envelopeHash
  }
}
