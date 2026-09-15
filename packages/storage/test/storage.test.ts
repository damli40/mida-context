import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { isMidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { FsStorage, MemoryStorage, contentHash } from "@mida/storage"
import type { ContextStorage } from "@mida/storage"

const rejectsWith = async (code: Parameters<typeof isMidaError>[1], promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const blob = new TextEncoder().encode("ciphertext bytes")
const hashOf = (bytes: Uint8Array) => `0x${bytesToHex(sha256(bytes))}` as Hex

function contract(name: string, make: () => Promise<ContextStorage>) {
  describe(`${name} satisfies ContextStorage (§9.2)`, () => {
    it("put returns a hint whose locator is the SHA-256 content hash", async () => {
      const storage = await make()
      const refs = await storage.put(blob)
      expect(refs).toHaveLength(1)
      expect(refs[0]!.locator).toBe(hashOf(blob))
      expect(contentHash(blob)).toBe(hashOf(blob))
    })

    it("get returns the same bytes", async () => {
      const storage = await make()
      await storage.put(blob)
      expect(await storage.get(hashOf(blob))).toEqual(blob)
    })

    it("put is idempotent for identical content", async () => {
      const storage = await make()
      await storage.put(blob)
      await storage.put(blob.slice())
      expect(await storage.get(hashOf(blob))).toEqual(blob)
    })

    it("missing content fails NOT_FOUND", async () => {
      const storage = await make()
      expect(await rejectsWith("NOT_FOUND", storage.get(hashOf(new Uint8Array([1]))))).toBe(true)
    })

    it("rejects a malformed hash", async () => {
      const storage = await make()
      expect(await rejectsWith("INVALID_WIRE", storage.get("0x1234" as Hex))).toBe(true)
    })
  })
}

contract("MemoryStorage", async () => new MemoryStorage())

let directory = ""
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mida-storage-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

contract("FsStorage", async () => new FsStorage(directory))

describe("providers returning the wrong bytes (§15 Storage)", () => {
  it("MemoryStorage fails CONTENT_HASH_MISMATCH before returning", async () => {
    const shared = new Map<Hex, Uint8Array>()
    const storage = new MemoryStorage(shared)
    await storage.put(blob)
    shared.set(hashOf(blob), new TextEncoder().encode("tampered"))
    expect(await rejectsWith("CONTENT_HASH_MISMATCH", storage.get(hashOf(blob)))).toBe(true)
  })

  it("FsStorage fails CONTENT_HASH_MISMATCH when the file on disk changes", async () => {
    const storage = new FsStorage(directory)
    await storage.put(blob)
    await writeFile(storage.pathFor(hashOf(blob)), "tampered")
    expect(await rejectsWith("CONTENT_HASH_MISMATCH", storage.get(hashOf(blob)))).toBe(true)
  })

  it("FsStorage leaves no temporary files after put", async () => {
    const storage = new FsStorage(directory)
    await storage.put(blob)
    expect(await readdir(directory)).toEqual([hashOf(blob).slice(2)])
  })
})
