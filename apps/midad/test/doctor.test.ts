import { describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, installClaudeCode, installCodex, loadOrCreateOwnerSecrets, runDoctor, runDoctorLive } from "@mida/midad"

const dir = () => mkdtempSync(join(tmpdir(), "mida-doctor-"))

describe("mida doctor without a chain", () => {
  it("a fresh home reports the daemon, network.json and every dependent check — and finishes", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const config = join(dir(), "config.toml")
    const lines: string[] = []
    const code = await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings, codex: config },
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines[0]).toBe("PROBLEM: midad is not answering — start the daemon")
    expect(lines).toContain("PROBLEM: network.json is missing or unreadable — run `mida init`")
    // every dependent check reports rather than hanging or staying silent
    expect(lines.some((line) => line.includes("owner"))).toBe(true)
    expect(lines.some((line) => line.includes("claude-code hooks"))).toBe(true)
    expect(lines.some((line) => line.includes("codex hooks"))).toBe(true)
    expect(code).toBeGreaterThan(0)
    expect(code).toBeLessThanOrEqual(9)
  })

  it("installed hooks report ok", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const config = join(dir(), "config.toml")
    installClaudeCode(settings)
    installCodex(config)
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings, codex: config },
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines).toContain("ok: claude-code hooks installed")
    expect(lines).toContain("ok: codex hooks installed")
  })

  it("an unreadable approved-projects file is a permissions problem — never a signature claim", async () => {
    const home = new MidaHome(join(dir(), "home"))
    // the check needs only the owner's address — the signature verify is local cryptography
    loadOrCreateOwnerSecrets(home)
    const list = home.path("approved-projects.json")
    writeFileSync(list, "{}")
    chmodSync(list, 0o000)
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      const line = lines.find((l) => l.includes("approved-projects"))
      expect(line).toBeDefined()
      expect(line).toContain("could not be read")
      expect(line).toContain("permissions")
      expect(line).not.toContain("signature")
    } finally {
      chmodSync(list, 0o600)
    }
  })

  it("a bad-signature approved-projects file still names the signature check", async () => {
    const home = new MidaHome(join(dir(), "home"))
    loadOrCreateOwnerSecrets(home)
    home.writeSecretJson("approved-projects.json", { entries: [], signature: `0x${"ab".repeat(65)}` })
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain("PROBLEM: the approved-projects list failed its signature check — re-run `mida approve <agent>` in each project folder")
  })

  it("names the API-key variables that are set — never their values", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: { ANTHROPIC_API_KEY: "sk-ant-secret-value", ANTHROPIC_AUTH_TOKEN: "tok-secret" },
      daemonProbeMs: 50,
    })
    const note = lines.find((line) => line.startsWith("note:"))
    expect(note).toBeDefined()
    expect(note).toContain("ANTHROPIC_API_KEY")
    expect(note).toContain("ANTHROPIC_AUTH_TOKEN")
    expect(note).not.toContain("sk-ant-secret-value")
    expect(note).not.toContain("tok-secret")
    // notes are not problems: the note line never counts toward the exit code
    expect(lines.every((line) => !line.startsWith("note:") || !line.startsWith("PROBLEM:"))).toBe(true)
  })
})

describe("mida doctor --live", () => {
  it("refuses in CI before anything runs", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runDoctorLive("codex", {
      home,
      print: (line) => lines.push(line),
      env: { CI: "true" },
      stdinIsTTY: true,
    })
    expect(code).toBe(2)
    expect(lines).toEqual(["refused: live checks do not run in CI"])
  })

  it("refuses when stdin is not a TTY", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runDoctorLive("claude-code", {
      home,
      print: (line) => lines.push(line),
      env: {},
      stdinIsTTY: false,
    })
    expect(code).toBe(2)
    expect(lines).toEqual(["refused: live checks need an interactive terminal"])
  })
})
