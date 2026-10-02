import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { codeIdentity, codeVersionFor } from "../src/code-identity.js"

// the repository root — the folder git calls this worktree's top
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

describe("codeVersionFor", () => {
  it("reads the version field of the package.json one level above the module's folder", () => {
    // a fake installed package: <pkg>/package.json + <pkg>/dist/module.js
    const pkg = mkdtempSync(join(tmpdir(), "mida-id-"))
    mkdirSync(join(pkg, "dist"))
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fake-pkg", version: "9.8.7" }))
    expect(codeVersionFor(join(pkg, "dist", "module.js"))).toBe("9.8.7")
  })

  it("a missing or unreadable package.json is 'unknown'", () => {
    const pkg = mkdtempSync(join(tmpdir(), "mida-id-"))
    mkdirSync(join(pkg, "dist"))
    expect(codeVersionFor(join(pkg, "dist", "module.js"))).toBe("unknown")
    writeFileSync(join(pkg, "package.json"), "{not json")
    expect(codeVersionFor(join(pkg, "dist", "module.js"))).toBe("unknown")
  })

  it("a package.json whose version is not a string is 'unknown'", () => {
    const pkg = mkdtempSync(join(tmpdir(), "mida-id-"))
    mkdirSync(join(pkg, "dist"))
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fake-pkg" }))
    expect(codeVersionFor(join(pkg, "dist", "module.js"))).toBe("unknown")
  })
})

describe("codeIdentity", () => {
  it("carries this package's own version — apps/midad/package.json in development", () => {
    const version = (JSON.parse(readFileSync(join(repo, "apps/midad/package.json"), "utf8")) as { version: string }).version
    expect(codeIdentity().codeVersion).toBe(version)
    // the root-parameter path is "as if the code ran from here" — the version stays this build's
    expect(codeIdentity(join(repo, "apps/midad")).codeVersion).toBe(version)
  })

  it("is read once per process: two calls return the same cached record", () => {
    expect(codeIdentity()).toBe(codeIdentity())
  })

  it("a folder inside a git checkout but not its top has codeCommit 'unknown'", () => {
    // apps/midad lives inside this repository's worktree, but the worktree's top is the repo
    // root — so no commit may be claimed for it (a parent checkout like Homebrew's /opt/homebrew
    // must never supply an unrelated commit)
    const inside = codeIdentity(join(repo, "apps/midad"))
    expect(inside.codeCommit).toBe("unknown")
  })

  it("the worktree's own top does carry its HEAD", () => {
    const top = codeIdentity(repo)
    expect(top.codeCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("an injected git runner: toplevel equal to the root passes HEAD through", () => {
    const root = mkdtempSync(join(tmpdir(), "mida-id-"))
    const git = (args: string[]) => (args.includes("--show-toplevel") ? root : "0123456789abcdef0123456789abcdef01234567")
    expect(codeIdentity(root, git).codeCommit).toBe("0123456789abcdef0123456789abcdef01234567")
  })

  it("an injected git runner: a toplevel above the root means no commit at all", () => {
    const root = mkdtempSync(join(tmpdir(), "mida-id-"))
    const parent = dirname(root)
    const git = (args: string[]) => (args.includes("--show-toplevel") ? parent : "0123456789abcdef0123456789abcdef01234567")
    expect(codeIdentity(root, git).codeCommit).toBe("unknown")
  })

  it("a git that cannot answer leaves codeCommit 'unknown'", () => {
    const root = mkdtempSync(join(tmpdir(), "mida-id-"))
    const git = (): string => {
      throw new Error("no git here")
    }
    expect(codeIdentity(root, git).codeCommit).toBe("unknown")
  })
})
