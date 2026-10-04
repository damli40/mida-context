// W1: a simulated Windows, the same refusal the Oct 2 probe hit: fsync on a FOLDER handle
// throws EPERM. Every folder fsync in midad routes through fsyncFolder, which skips on win32;
// file fsyncs (the marker itself, the temp file) must still run.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const { MidaHome } = await import("../src/home.js")
const { FileAccessRequestStore } = await import("../src/request-store.js")

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

const realPlatform = process.platform
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value, configurable: true })
afterEach(() => setPlatform(realPlatform))

const REQUEST_ID = `0x${"ab".repeat(32)}` as Hex
const request = { requestId: REQUEST_ID, purposeId: "project_assistance" } as unknown as AccessRequest

// The request file written directly, so the test isolates markConsumed and not save()'s write.
const writeRequest = (home: InstanceType<typeof MidaHome>, agent: string): void => {
  const dir = join(home.root, "requests", agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${REQUEST_ID}.json`), JSON.stringify(request))
}

describe("markConsumed — the request folder fsync is skipped only on Windows", () => {
  it("on win32 the .consumed marker is created and markConsumed resolves", async () => {
    const home = new MidaHome(tempDir("wf-home-"))
    const store = new FileAccessRequestStore(home, "assistant", "win32")
    writeRequest(home, "assistant")
    await store.markConsumed(REQUEST_ID)
    expect(home.has(`requests/assistant/${REQUEST_ID}.json.consumed`)).toBe(true)
  })

  it("control: on darwin the folder fsync still runs, so an EPERM there reaches the caller", async () => {
    const home = new MidaHome(tempDir("wf-home-"))
    const store = new FileAccessRequestStore(home, "assistant", "darwin")
    writeRequest(home, "assistant")
    await expect(store.markConsumed(REQUEST_ID)).rejects.toThrow(/EPERM: operation not permitted, fsync/)
  })

  it("the whole init grant path — home write, save, then consume — completes on Windows", async () => {
    setPlatform("win32")
    const home = new MidaHome(tempDir("wf-home-"))
    // writeSecretJson's own folder flush goes through the same helper and must skip too.
    expect(() => home.writeSecretJson("owner-address.json", { address: `0x${"1".repeat(40)}` })).not.toThrow()
    const store = new FileAccessRequestStore(home, "assistant")
    await store.save(request)
    await expect(store.markConsumed(REQUEST_ID)).resolves.toBeUndefined()
  })
})
