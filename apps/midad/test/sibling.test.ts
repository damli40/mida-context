import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isBundled, siblingEntryArgs } from "@mida/midad"
import { detachedSpawnOptions } from "../src/sibling.js"

// Under vitest import.meta.url ends in .ts, so the source-mode branch is the one exercised
// here; the bundled branch is covered end-to-end by scripts/clean-install-check.mjs, which
// runs the packed mida/midad/mida-hook bins with plain node.
describe("siblingEntryArgs in source mode", () => {
  it("is not bundled", () => {
    expect(isBundled()).toBe(false)
  })

  it("spawns the daemon entry through the repo's tsx loader, both by absolute path", () => {
    const args = siblingEntryArgs("midad")
    expect(args[0]).toBe("--import")
    expect(args[1]).toMatch(/node_modules\/tsx\/dist\/loader\.mjs$/)
    expect(args[2]).toMatch(/apps\/midad\/src\/daemon-main\.ts$/)
    // absolute paths: the child's working directory is the Mida home, not the repo root
    expect(args[1]!.startsWith("/")).toBe(true)
    expect(args[2]!.startsWith("/")).toBe(true)
    expect(existsSync(args[1]!)).toBe(true)
    expect(existsSync(args[2]!)).toBe(true)
  })

  it("maps every shipped bin name to its source entry", () => {
    expect(siblingEntryArgs("mida")[2]).toMatch(/cli\.ts$/)
    expect(siblingEntryArgs("mida-drain")[2]).toMatch(/drain-main\.ts$/)
    expect(siblingEntryArgs("mida-hook")[2]).toMatch(/hook-main\.ts$/)
    expect(siblingEntryArgs("mida-inject")[2]).toMatch(/inject-main\.ts$/)
    expect(siblingEntryArgs("mida-mcp")[2]).toMatch(/mcp-main\.ts$/)
  })
})

describe("detachedSpawnOptions", () => {
  it("starts a detached, silent child with no console window on Windows", () => {
    const options = detachedSpawnOptions("/home/x/.mida", { PATH: "/bin" })
    expect(options).toEqual({ detached: true, stdio: "ignore", cwd: "/home/x/.mida", env: { PATH: "/bin" }, windowsHide: true })
  })

  it("every detached Mida spawn uses it (no hand-written detached option left)", () => {
    for (const file of ["cli.ts", "hook-main.ts", "inject-main.ts", "mcp-main.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8")
      expect(text, file).not.toMatch(/detached:\s*true/)
      expect(text, file).toMatch(/detachedSpawnOptions\(/)
    }
  })
})
