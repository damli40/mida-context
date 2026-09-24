import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, recordCodexHome, recordedCodexHome, resolveCodexHome } from "@mida/midad"

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
})
