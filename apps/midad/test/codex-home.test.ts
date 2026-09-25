import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, clearCodexHome, recordCodexHome, recordedCodexHome, resolveCodexHome, trustedCodexHome } from "@mida/midad"

describe("codex home", () => {
  it("prefers an absolute CODEX_HOME, else ~/.codex", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/x/codex" }, "/u")).toBe("/x/codex")
    expect(resolveCodexHome({ CODEX_HOME: "rel" }, "/u")).toBe("/u/.codex")
    expect(resolveCodexHome({}, "/u")).toBe("/u/.codex")
  })

  it("records and reads back the codex home, ignoring junk", () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "h-")))
    expect(recordedCodexHome(home)).toBeUndefined()
    recordCodexHome(home, "/x/codex")
    expect(recordedCodexHome(home)).toBe("/x/codex")
    writeFileSync(home.path("codex-home"), "relative/path\n")
    expect(recordedCodexHome(home)).toBeUndefined()
  })

  it("the trusted home is the recorded one, whatever the shell's CODEX_HOME says now (F8)", () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "h-")))
    recordCodexHome(home, "/x/recorded")
    // a CODEX_HOME exported after install does not redirect the trust root
    expect(trustedCodexHome(home, { CODEX_HOME: "/x/elsewhere" }, "/u")).toBe("/x/recorded")
    // and a junk record cannot smuggle a relative path into it either
    writeFileSync(home.path("codex-home"), "relative/path\n")
    expect(trustedCodexHome(home, { CODEX_HOME: "/x/elsewhere" }, "/u")).toBe("/x/elsewhere")
    // with nothing recorded at all the environment (or the default) speaks
    clearCodexHome(home)
    expect(trustedCodexHome(home, { CODEX_HOME: "/x/elsewhere" }, "/u")).toBe("/x/elsewhere")
    expect(trustedCodexHome(home, {}, "/u")).toBe("/u/.codex")
  })

  it("clearing the record removes it (F8)", () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "h-")))
    recordCodexHome(home, "/x/codex")
    clearCodexHome(home)
    expect(recordedCodexHome(home)).toBeUndefined()
    expect(home.has("codex-home")).toBe(false)
    // a missing record is cleared quietly
    clearCodexHome(home)
  })
})
