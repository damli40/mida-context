import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { MidaError, assertHex } from "@mida/protocol"
import type { Hex, StorageRef } from "@mida/protocol"

/** §9.2 */
export interface ContextStorage {
  put(blob: Uint8Array): Promise<StorageRef[]>
  get(hash: Hex, hints?: StorageRef[]): Promise<Uint8Array>
}

export function contentHash(blob: Uint8Array): Hex {
  return `0x${bytesToHex(sha256(blob))}` as Hex
}

/** Every get path calls this before returning bytes. */
export function verifyContent(hash: Hex, blob: Uint8Array): Uint8Array {
  if (contentHash(blob) !== hash) {
    throw new MidaError("CONTENT_HASH_MISMATCH", `bytes do not hash to ${hash}`)
  }
  return blob
}

export class MemoryStorage implements ContextStorage {
  readonly #blobs: Map<Hex, Uint8Array>

  /** Tests may pass a shared map to simulate a provider that returns the wrong bytes. */
  constructor(blobs: Map<Hex, Uint8Array> = new Map()) {
    this.#blobs = blobs
  }

  async put(blob: Uint8Array): Promise<StorageRef[]> {
    const hash = contentHash(blob)
    this.#blobs.set(hash, blob.slice())
    return [{ provider: "memory", locator: hash }]
  }

  async get(hash: Hex, _hints?: StorageRef[]): Promise<Uint8Array> {
    const blob = this.#blobs.get(assertHex(hash, 32))
    if (blob === undefined) {
      throw new MidaError("NOT_FOUND", `no blob ${hash}`)
    }
    return verifyContent(hash, blob.slice())
  }
}

export class FsStorage implements ContextStorage {
  readonly #directory: string

  constructor(directory: string) {
    this.#directory = directory
  }

  pathFor(hash: Hex): string {
    return join(this.#directory, assertHex(hash, 32).slice(2))
  }

  async put(blob: Uint8Array): Promise<StorageRef[]> {
    const hash = contentHash(blob)
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const target = this.pathFor(hash)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, blob, { mode: 0o600 })
    await rename(temporary, target)
    return [{ provider: "fs", locator: hash }]
  }

  async get(hash: Hex, _hints?: StorageRef[]): Promise<Uint8Array> {
    let blob: Uint8Array
    try {
      blob = new Uint8Array(await readFile(this.pathFor(hash)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MidaError("NOT_FOUND", `no blob ${hash}`)
      }
      throw error
    }
    return verifyContent(hash, blob)
  }
}
