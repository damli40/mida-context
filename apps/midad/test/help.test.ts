// SPEC-06: `mida --help` printed only the USAGE line — the command names and
// nothing about what Mida is. The help branch now prints ABOUT, a blank line,
// then USAGE; every other USAGE print stays as it was.

import { describe, expect, it } from "vitest"
import { ABOUT, USAGE, helpLines } from "@mida/midad"

describe("mida --help", () => {
  it("prints what Mida is, a blank line, then the command list", () => {
    expect(helpLines()).toEqual([...ABOUT, "", USAGE])
    expect(ABOUT).toHaveLength(3)
  })
  it("opens by saying what Mida is", () => {
    expect(ABOUT[0]!.startsWith("Mida keeps your context in an encrypted store you own")).toBe(true)
  })
  it("stays plain: no em dash, no line over 160 characters", () => {
    for (const line of ABOUT) {
      expect(line).not.toContain("—")
      expect(line.length).toBeLessThanOrEqual(160)
    }
  })
  it("names only commands that USAGE actually lists", () => {
    for (const command of ["init", "install", "request", "approve"]) {
      expect(USAGE, command).toContain(command)
    }
  })
})
