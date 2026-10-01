// SPEC-06: `mida --help` printed only the USAGE line — the command names and
// nothing about what Mida is. The help branch now prints ABOUT, a blank line,
// then USAGE; every other USAGE print stays as it was.

import { describe, expect, it } from "vitest"
import { ABOUT, BANNER, BANNER_PLAIN, USAGE, bannerLines, helpLines } from "@mida/midad"

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
    for (const command of ["init", "install", "request", "approve", "summarizer"]) {
      expect(USAGE, command).toContain(command)
    }
  })
})

describe("the mark (UF-P2c)", () => {
  it("with stdout not a TTY nothing is prepended — the help output is exactly what it is today", () => {
    expect(bannerLines({ LANG: "en_US.UTF-8" }, false)).toEqual([])
    expect(helpLines()).toEqual([...ABOUT, "", USAGE])
  })
  it("a UTF-8 terminal gets the mark", () => {
    expect(bannerLines({ LANG: "en_US.UTF-8" }, true)).toEqual(BANNER)
    expect(BANNER).toHaveLength(4)
  })
  it("a non-UTF-8 terminal gets the plain line", () => {
    expect(bannerLines({ LANG: "C" }, true)).toEqual(BANNER_PLAIN)
    expect(BANNER_PLAIN).toHaveLength(2)
  })
  it("locale precedence is LC_ALL, then LC_CTYPE, then LANG — the first non-empty wins", () => {
    expect(bannerLines({ LC_ALL: "C", LC_CTYPE: "en_US.UTF-8", LANG: "en_US.UTF-8" }, true)).toEqual(BANNER_PLAIN)
    expect(bannerLines({ LC_ALL: "", LC_CTYPE: "en_US.utf8", LANG: "C" }, true)).toEqual(BANNER)
    expect(bannerLines({}, true)).toEqual(BANNER_PLAIN)
  })
})
