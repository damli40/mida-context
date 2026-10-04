import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fsyncFolder, isWindows, newPipeName } from "../src/platform.js"

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe("platform helpers", () => {
  it("isWindows is true only for win32", () => {
    expect(isWindows("win32")).toBe(true)
    expect(isWindows("darwin")).toBe(false)
    expect(isWindows("linux")).toBe(false)
  })

  it("fsyncFolder never opens the folder on Windows (the Oct 2 probe's EPERM)", () => {
    // a missing folder would throw ENOENT if the function tried to open it
    expect(() => fsyncFolder(join(tmpdir(), "mida-no-such-folder-7f3a"), "win32")).not.toThrow()
  })

  it("fsyncFolder opens and syncs the folder on Mac and Linux", () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-fsync-"))
    made.push(dir)
    expect(() => fsyncFolder(dir, "darwin")).not.toThrow()
    expect(() => fsyncFolder(join(dir, "missing"), "linux")).toThrow()
  })

  it("newPipeName is a pipe address with 32 random hex characters, new every call", () => {
    const a = newPipeName()
    expect(a).toMatch(/^\\\\\.\\pipe\\mida-[0-9a-f]{32}$/)
    expect(newPipeName()).not.toBe(a)
  })
})
