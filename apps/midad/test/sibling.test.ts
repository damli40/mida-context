import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { isBundled, siblingEntryArgs } from "@mida/midad"

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
  })
})
