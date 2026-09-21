import { describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODEX_BLOCK_V1, CODEX_TRUST_SENTENCE, MidaHome, installClaudeCode, installCodex, loadOrCreateOwnerSecrets, runDoctor, runDoctorLive, socketPathFor } from "@mida/midad"

const dir = () => mkdtempSync(join(tmpdir(), "mida-doctor-"))

/** A stub listener on the home's control socket that answers every request with `status` + JSON `body`. */
async function stubDaemon(home: MidaHome, status: number, body: unknown): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("data", () => {
      const payload = JSON.stringify(body)
      socket.end(
        `HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPathFor(home), () => resolve())
  })
  return server
}

const closeServer = (server: Server) => new Promise<void>((done) => server.close(() => done()))

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

  it("reports which compile model is active — haiku without a key, kimi with one plus the Moonshot note (R5-8)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const haikuLines: string[] = []
    await runDoctor({ home, print: (line) => haikuLines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(haikuLines).toContain("ok: compile model is claude-haiku")
    expect(haikuLines.some((line) => line.toLowerCase().includes("moonshot"))).toBe(false)

    const kimiLines: string[] = []
    await runDoctor({ home, print: (line) => kimiLines.push(line), settings: {}, env: { KIMI_API_KEY: "test-key" }, daemonProbeMs: 50 })
    expect(kimiLines).toContain("ok: compile model is kimi-k2.7-code-highspeed")
    // the owner must be told where the session text goes — scrubbed, but still sent off-machine
    const note = kimiLines.find((line) => line.startsWith("note:") && line.includes("moonshot"))
    expect(note).toBeDefined()
    expect(note).toContain("scrub")
    // the key itself never reaches a doctor line
    expect(kimiLines.join("\n")).not.toContain("test-key")
    // with the endpoint unset there is nothing to warn about
    expect(kimiLines.some((line) => line.includes("not Moonshot"))).toBe(false)
  })

  it("an overridden KIMI_BASE_URL is a PROBLEM that names the host only — never the full URL (R5-5b-3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const env = { KIMI_API_KEY: "test-key", KIMI_BASE_URL: "http://example.com/secret/path?token=abc" }
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env, daemonProbeMs: 50 })
    const warn = lines.find((line) => line.includes("not Moonshot"))
    expect(warn).toBeDefined()
    expect(warn).toContain("PROBLEM:")
    expect(warn).toContain("compile text is being sent to example.com, not Moonshot")
    // host only: the path and query that followed the host are never echoed — they may be secret
    expect(warn).not.toContain("/secret/path")
    expect(warn).not.toContain("token=abc")

    // even an https override is not Moonshot — the problem names its host too
    const httpsLines: string[] = []
    await runDoctor({
      home,
      print: (line) => httpsLines.push(line),
      settings: {},
      env: { KIMI_API_KEY: "test-key", KIMI_BASE_URL: "https://evil.example" },
      daemonProbeMs: 50,
    })
    expect(httpsLines.some((line) => line.includes("compile text is being sent to evil.example, not Moonshot"))).toBe(true)
  })

  it("more than three whats-new timeouts in the last hour is a PROBLEM — fewer stays visible, none is ok", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const record = (at: string) => `${JSON.stringify({ at, event: "whatsnew-timeout", agent: "codex", sessionId: "s1" })}`
    mkdirSync(home.path("logs"), { recursive: true })
    // four give-ups inside the hour, plus one from two hours ago that must NOT count
    const recent = new Date(Date.now() - 10 * 60_000).toISOString()
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    writeFileSync(
      home.path("logs/hook.jsonl"),
      [record(recent), record(recent), record(recent), record(recent), record(old), ""].join("\n"),
    )
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    const line = lines.find((l) => l.includes("timing out"))
    expect(line).toBeDefined()
    expect(line).toContain("PROBLEM:")
    expect(line).toContain("the daemon may be unreachable")

    // three or fewer is a note with the count — silence is visible, but it is not a problem
    writeFileSync(home.path("logs/hook.jsonl"), [record(recent), record(recent), record(old), ""].join("\n"))
    const fewer: string[] = []
    await runDoctor({ home, print: (line) => fewer.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    const noteLine = fewer.find((l) => l.includes("timeout"))
    expect(noteLine).toBeDefined()
    expect(noteLine).not.toContain("PROBLEM:")
    expect(noteLine).toContain("2")
  })

  it("a listener that answers 404 is a PROBLEM naming the status — never 'ok: midad answers'", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 404, { error: "not-found" })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 500 })
      expect(lines).not.toContain("ok: midad answers")
      const daemonLine = lines.find((l) => l.includes("midad"))
      expect(daemonLine).toBeDefined()
      expect(daemonLine).toContain("PROBLEM:")
      expect(daemonLine).toContain("404")
    } finally {
      await closeServer(server)
    }
  })

  it("a 200 whose body does not say ok:true is still a PROBLEM naming the status", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: false })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 500 })
      expect(lines).not.toContain("ok: midad answers")
      const daemonLine = lines.find((l) => l.includes("midad"))
      expect(daemonLine).toContain("PROBLEM:")
      expect(daemonLine).toContain("200")
    } finally {
      await closeServer(server)
    }
  })

  it("a 200 with ok:true reports ok: midad answers", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true, pid: 1 })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 500 })
      expect(lines).toContain("ok: midad answers")
    } finally {
      await closeServer(server)
    }
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

  it("the Codex trust reminder prints whenever a managed block exists — installed, outdated or edited", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const config = join(dir(), "config.toml")
    installCodex(config)
    const note = `note: ${CODEX_TRUST_SENTENCE}`
    for (const variant of ["installed", "outdated", "edited"] as const) {
      if (variant === "outdated") writeFileSync(config, `${CODEX_BLOCK_V1}\n`)
      if (variant === "edited") {
        writeFileSync(
          config,
          `${CODEX_BLOCK_V1}\n`.replace('command = "mida-hook codex"', 'command = "mida-hook codex --extra"'),
        )
      }
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: { codex: config }, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(note)
      expect(lines.filter((l) => l === note)).toHaveLength(1)
    }
  })

  it("no managed block means nothing was written — the reminder stays away", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const config = join(dir(), "config.toml")
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: { codex: config }, env: {}, daemonProbeMs: 50 })
    expect(lines.some((line) => line.includes("Codex will ignore these hooks"))).toBe(false)
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

  it("a PATH without mida-hook and mida-inject is a PROBLEM naming the repo's bin folder (R4-6)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const emptyPath = join(dir(), "empty-path")
    mkdirSync(emptyPath)
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: { PATH: emptyPath }, daemonProbeMs: 50 })
    const hook = lines.find((line) => line.includes("mida-hook"))
    const inject = lines.find((line) => line.includes("mida-inject"))
    expect(hook).toBeDefined()
    expect(inject).toBeDefined()
    expect(hook).toContain("PROBLEM:")
    expect(inject).toContain("PROBLEM:")
    // the fix names a bin/ folder the owner can add to their PATH — the repo's own, until npm exists
    for (const line of [hook, inject]) {
      expect(line).toContain("add")
      expect(line).toContain("PATH")
      expect(line).toMatch(/bin\/?\s+to your PATH/)
    }
    expect(lines).not.toContain("ok: mida-hook is on the PATH")
  })

  it("a PATH carrying both commands reports ok for each (R4-6)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const binDir = join(dir(), "fake-bin")
    mkdirSync(binDir)
    for (const command of ["mida-hook", "mida-inject"]) {
      writeFileSync(join(binDir, command), "#!/bin/sh\nexit 0\n")
      chmodSync(join(binDir, command), 0o755)
    }
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: { PATH: binDir }, daemonProbeMs: 50 })
    expect(lines).toContain("ok: mida-hook is on the PATH")
    expect(lines).toContain("ok: mida-inject is on the PATH")
  })

  it("MIDA_CLAUDE_SETTINGS and MIDA_CODEX_CONFIG point the hooks check at throwaway settings files (R4-6)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const config = join(dir(), "config.toml")
    installClaudeCode(settings)
    installCodex(config)
    const lines: string[] = []
    // no `settings` dep at all — the env vars name the files, as a throwaway-settings run does
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      env: { MIDA_CLAUDE_SETTINGS: settings, MIDA_CODEX_CONFIG: config },
      daemonProbeMs: 50,
    })
    expect(lines).toContain("ok: claude-code hooks installed")
    expect(lines).toContain("ok: codex hooks installed")
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
