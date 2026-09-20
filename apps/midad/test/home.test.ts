import { describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome } from "@mida/midad"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))

describe("MidaHome", () => {
  it("returns undefined for a file that does not exist", () => {
    expect(freshHome().readJson("owner/secrets.json")).toBeUndefined()
  })

  it("round-trips JSON through nested folders", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/identity.json", { a: 1, nested: { b: "two" } })
    expect(home.readJson("agents/codex/identity.json")).toEqual({ a: 1, nested: { b: "two" } })
    expect(home.has("agents/codex/identity.json")).toBe(true)
  })

  it("writes files only the user can read, in folders only the user can enter", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { k: "v" })
    expect(statSync(home.path("owner/secrets.json")).mode & 0o777).toBe(0o600)
    expect(statSync(home.path("owner")).mode & 0o777).toBe(0o700)
  })

  it("leaves no temp file behind and replaces, not appends", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { v: 1 })
    home.writeSecretJson("owner/secrets.json", { v: 2 })
    expect(home.readJson("owner/secrets.json")).toEqual({ v: 2 })
    expect(readdirSync(home.path("owner"))).toEqual(["secrets.json"])
  })

  it("throws on a corrupt file instead of pretending it is missing", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { v: 1 })
    writeFileSync(home.path("owner/secrets.json"), "{not json")
    expect(() => home.readJson("owner/secrets.json")).toThrow()
  })

  it("refuses a path that climbs out of the home folder", () => {
    expect(() => freshHome().path("../outside.json")).toThrow()
  })

  it("removes the temp file when the final rename fails, so no secret is left behind", () => {
    const home = freshHome()
    mkdirSync(home.path("owner/secrets.json"), { recursive: true })
    expect(() => home.writeSecretJson("owner/secrets.json", { k: "v" })).toThrow()
    expect(readdirSync(home.path("owner"))).toEqual(["secrets.json"])
  })

  it("tightens a home folder that already exists with wider permissions", () => {
    const folder = mkdtempSync(join(tmpdir(), "mida-home-"))
    chmodSync(folder, 0o755)
    new MidaHome(folder)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
  })

  it("refuses to write or read through a symlink that points outside the home", () => {
    const outside = mkdtempSync(join(tmpdir(), "mida-outside-"))
    const home = freshHome()
    mkdirSync(home.path("agents"), { recursive: true })
    symlinkSync(outside, home.path("agents/evil"))
    expect(() => home.writeSecretJson("agents/evil/identity.json", { k: "v" })).toThrow()
    expect(readdirSync(outside)).toEqual([])
    expect(() => home.readJson("agents/evil/identity.json")).toThrow()
  })

  it("creates exclusively: the second caller loses and the first file is untouched", () => {
    const home = freshHome()
    expect(home.createSecretJsonExclusive("owner/secrets.json", { v: 1 })).toBe(true)
    expect(home.createSecretJsonExclusive("owner/secrets.json", { v: 2 })).toBe(false)
    expect(home.readJson("owner/secrets.json")).toEqual({ v: 1 })
    expect(readdirSync(home.path("owner"))).toEqual(["secrets.json"])
  })

  it("removes a file, ignores one that is already gone, and still refuses an escape", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/pending-request.json", { v: 1 })
    home.remove("agents/codex/pending-request.json")
    expect(home.has("agents/codex/pending-request.json")).toBe(false)
    expect(() => home.remove("agents/codex/pending-request.json")).not.toThrow()
    expect(() => home.remove("../outside.json")).toThrow()
  })

  it("lists the entries of a folder, and an empty list for a missing one", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/identity.json", {})
    home.writeSecretJson("agents/claude-code/identity.json", {})
    expect(home.list("agents").sort()).toEqual(["claude-code", "codex"])
    expect(home.list("nothing-here")).toEqual([])
  })
})
