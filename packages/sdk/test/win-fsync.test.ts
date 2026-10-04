// W1: the same simulated Windows as midad's win-fsync test: fsync on a FOLDER handle throws
// EPERM. The SDK cannot import apps/midad, so its own fsyncFolder in durability.ts carries the
// platform check; the two folder fsyncs in connect.ts route through it.
import { afterAll, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessRequest, Hex } from "@mida/protocol"

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  const fsyncSync = (fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) {
      const error = new Error("EPERM: operation not permitted, fsync") as NodeJS.ErrnoException
      error.code = "EPERM"
      throw error
    }
    return fs.fsyncSync(fd)
  }
  return { ...fs, fsyncSync, default: { ...fs, fsyncSync } }
})

const { FileAccessRequestStore } = await import("../src/connect.js")
const { writeSecretJson } = await import("../src/durability.js")

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

const REQUEST_ID = `0x${"11".repeat(32)}` as Hex
const request = { requestId: REQUEST_ID, purposeId: "project_assistance" } as unknown as AccessRequest

describe("FileAccessRequestStore.markConsumed — the grant-completion folder fsync", () => {
  it("on win32 consumes the request despite folders refusing fsync", async () => {
    const dir = join(tempDir("wf-req-"), "requests", "codex")
    mkdirSync(dir, { recursive: true })
    const store = new FileAccessRequestStore(dir, "win32")
    await store.save(request)
    await store.markConsumed(REQUEST_ID)
    expect(existsSync(join(dir, `${REQUEST_ID}.json.consumed`))).toBe(true)
  })

  it("control: on darwin the folder fsync still runs, so an EPERM there reaches the caller", async () => {
    const dir = join(tempDir("wf-req-"), "requests", "codex")
    mkdirSync(dir, { recursive: true })
    const store = new FileAccessRequestStore(dir, "darwin")
    await store.save(request)
    await expect(store.markConsumed(REQUEST_ID)).rejects.toThrow(/EPERM: operation not permitted, fsync/)
  })
})

describe("writeSecretJson — the pending-request write requestAccess makes", () => {
  it("on win32 writes the file despite folders refusing fsync", () => {
    const file = join(tempDir("wf-sec-"), "agents", "codex", "pending-request.json")
    writeSecretJson(file, { request: { requestId: REQUEST_ID } }, "win32")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ request: { requestId: REQUEST_ID } })
  })

  it("control: on darwin the folder fsync still runs, so an EPERM there reaches the caller", () => {
    const file = join(tempDir("wf-sec-"), "pending-request.json")
    expect(() => writeSecretJson(file, { a: 1 }, "darwin")).toThrow(/EPERM: operation not permitted, fsync/)
  })
})
