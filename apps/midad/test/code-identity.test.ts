import { describe, expect, it } from "vitest"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { codeIdentity } from "../src/code-identity.js"

const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."))

describe("codeIdentity", () => {
  it("inside this repo it names the repo root and the current 40-hex commit", () => {
    const identity = codeIdentity()
    expect(identity.codeRoot).toBe(REPO_ROOT)
    expect(identity.codeCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("is computed once per process — a second call returns the same record", () => {
    expect(codeIdentity()).toBe(codeIdentity())
  })

  it("a code root outside any git worktree reports commit unknown", () => {
    const outside = mkdtempSync(join(tmpdir(), "mida-nogit-"))
    const identity = codeIdentity(outside)
    expect(identity.codeRoot).toBe(realpathSync(outside))
    expect(identity.codeCommit).toBe("unknown")
  })
})
