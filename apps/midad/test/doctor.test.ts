import { describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import type { AddressInfo, Server } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODEX_BLOCK_V1, CODEX_TRUST_SENTENCE, MidaHome, installClaudeCode, installCodex, loadOrCreateOwnerSecrets, runDoctor, runDoctorLive, saveOwnerAddress, saveOwnerMode, socketPathFor } from "@mida/midad"

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

  it("names the compile model and where the session text goes — per provider, from the real chain (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const run = async (env: NodeJS.ProcessEnv) => {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env, daemonProbeMs: 50 })
      return lines
    }

    // no keys: haiku through the claude CLI, no fallback
    const haiku = await run({})
    expect(haiku).toContain("ok: compile model is claude-haiku")
    const haikuNote = haiku.filter((line) => line.startsWith("note:") && line.includes("transcript text"))
    expect(haikuNote).toHaveLength(1)
    expect(haikuNote[0]).toContain("api.anthropic.com")
    expect(haikuNote[0]).toContain("no fallback")

    // deepseek key alone: the default, falling back to haiku
    const deepseek = await run({ DEEPSEEK_API_KEY: "test-key" })
    expect(deepseek).toContain("ok: compile model is deepseek-flash")
    expect(deepseek).toContain(
      "note: deepseek sends the session's transcript text to api.deepseek.com (secrets are scrubbed first); a failed call falls back to claude-haiku",
    )
    expect(deepseek.join("\n")).not.toContain("test-key")

    // both keys: the note names the full real chain
    const both = await run({ DEEPSEEK_API_KEY: "d", KIMI_API_KEY: "k" })
    expect(both).toContain(
      "note: deepseek sends the session's transcript text to api.deepseek.com (secrets are scrubbed first); a failed call falls back to kimi, then claude-haiku",
    )

    // kimi alone: Moonshot is where the text goes
    const kimi = await run({ KIMI_API_KEY: "test-key" })
    expect(kimi).toContain("ok: compile model is kimi-k2.7-code-highspeed")
    expect(kimi).toContain(
      "note: kimi sends the session's transcript text to api.moonshot.ai (secrets are scrubbed first); a failed call falls back to claude-haiku",
    )
    expect(kimi.join("\n")).not.toContain("test-key")
    expect(kimi.some((line) => line.includes("not Moonshot"))).toBe(false)
  })

  it("a pinned custom is the owner's own endpoint — no vendor, no fallback, unless MIDA_COMPILE_FALLBACK=1 (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const custom = {
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "http://127.0.0.1:11434/v1",
      MIDA_COMPILE_MODEL_ID: "qwen-local",
      DEEPSEEK_API_KEY: "d",
      KIMI_API_KEY: "k",
    }
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: custom, daemonProbeMs: 50 })
    expect(lines).toContain("ok: compile model is qwen-local")
    expect(lines).toContain("note: compile text is sent to 127.0.0.1:11434 (your own endpoint); no fallback")
    // the custom base URL is itself — never a 'not Moonshot'-style problem
    expect(lines.some((line) => line.startsWith("PROBLEM:") && line.includes("compile text"))).toBe(false)

    // opted-in fallback names the vendors the text could reach
    const withFallback: string[] = []
    await runDoctor({
      home,
      print: (line) => withFallback.push(line),
      settings: {},
      env: { ...custom, MIDA_COMPILE_FALLBACK: "1" },
      daemonProbeMs: 50,
    })
    expect(withFallback).toContain(
      "note: compile text is sent to 127.0.0.1:11434 (your own endpoint); a failed call falls back to deepseek, then kimi, then claude-haiku",
    )

    // a pinned custom missing its required vars is a PROBLEM — every compile would fail
    const missing: string[] = []
    await runDoctor({
      home,
      print: (line) => missing.push(line),
      settings: {},
      env: { MIDA_COMPILE_MODEL: "custom" },
      daemonProbeMs: 50,
    })
    const missingLine = missing.find((line) => line.startsWith("PROBLEM:") && line.includes("custom"))
    expect(missingLine).toBeDefined()
    expect(missingLine).toContain("MIDA_COMPILE_BASE_URL")
    expect(missingLine).toContain("MIDA_COMPILE_MODEL_ID")
  })

  it("an overridden provider base URL is a PROBLEM naming the host only — provider-aware, never the full URL (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const run = async (env: NodeJS.ProcessEnv) => {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env, daemonProbeMs: 50 })
      return lines
    }

    // kimi override while kimi is in the chain — the old "not Moonshot" problem, provider-aware
    const kimi = await run({ KIMI_API_KEY: "test-key", KIMI_BASE_URL: "http://example.com/secret/path?token=abc" })
    const kimiWarn = kimi.find((line) => line.includes("not Moonshot"))
    expect(kimiWarn).toBeDefined()
    expect(kimiWarn).toContain("PROBLEM:")
    expect(kimiWarn).toContain("compile text is being sent to example.com, not Moonshot")
    expect(kimiWarn).not.toContain("/secret/path")
    expect(kimiWarn).not.toContain("token=abc")

    // deepseek override — the same problem names DeepSeek
    const deepseek = await run({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "https://evil.example" })
    expect(deepseek.some((line) => line.includes("compile text is being sent to evil.example, not DeepSeek"))).toBe(true)
    // and the note tells the truth about where it actually goes
    expect(deepseek.some((line) => line.startsWith("note:") && line.includes("evil.example"))).toBe(true)

    // a kimi override with NO kimi in the chain is dormant, not a problem
    const dormant = await run({ DEEPSEEK_API_KEY: "d", KIMI_BASE_URL: "https://evil.example" })
    expect(dormant.some((line) => line.includes("not Moonshot"))).toBe(false)

    // a custom endpoint is the user's own — never a problem, no matter the host
    const custom = await run({
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "https://anything.example.com/v1",
      MIDA_COMPILE_MODEL_ID: "m",
    })
    expect(custom.some((line) => line.startsWith("PROBLEM:") && line.includes("compile text"))).toBe(false)
    expect(custom.some((line) => line.includes("anything.example.com"))).toBe(true)
  })

  it("the environment check lists every compile-provider variable — set or unset, never a value (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: { DEEPSEEK_API_KEY: "deepseek-secret-value", MIDA_COMPILE_MODEL: "deepseek" },
      daemonProbeMs: 50,
    })
    const set = lines.find((line) => line.includes("environment — set:"))
    const unset = lines.find((line) => line.includes("environment — unset:"))
    expect(set).toBeDefined()
    expect(unset).toBeDefined()
    expect(set).toContain("DEEPSEEK_API_KEY")
    expect(set).toContain("MIDA_COMPILE_MODEL")
    for (const name of ["DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_TIMEOUT_MS", "KIMI_API_KEY", "MIDA_COMPILE_API_KEY", "MIDA_COMPILE_BASE_URL", "MIDA_COMPILE_MODEL_ID", "MIDA_COMPILE_TIMEOUT_MS", "MIDA_COMPILE_FALLBACK"]) {
      expect(unset).toContain(name)
    }
    // values never reach a doctor line
    expect(lines.join("\n")).not.toContain("deepseek-secret-value")
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

describe("mida doctor on a passkey home", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as `0x${string}`
  const QX = `0x${"ab".repeat(32)}` as `0x${string}`
  const QY = `0x${"cd".repeat(32)}` as `0x${string}`

  /** A stub JSON-RPC that scripts one answer: the point `ownerP256Key`'s eth_call returns. */
  async function stubRpc(point: { qx: bigint; qy: bigint } | null): Promise<{ url: string; close(): Promise<void> }> {
    const pointAnswer =
      point === null
        ? `0x${"00".repeat(64)}`
        : `0x${point.qx.toString(16).padStart(64, "0")}${point.qy.toString(16).padStart(64, "0")}`
    const server = createHttpServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string }
        const reply = (result: unknown) => {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
        }
        if (call.method === "eth_call") return reply(pointAnswer)
        if (call.method === "eth_getBalance") return reply("0x0")
        if (call.method === "eth_chainId") return reply("0x7a69")
        if (call.method === "eth_blockNumber") return reply("0x64")
        return reply("0x")
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const port = (server.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
  }

  const DEPLOYMENT = {
    chainId: "31337",
    capabilityRegistry: "0x2222222222222222222222222222222222222222",
    contextRegistry: "0x3333333333333333333333333333333333333333",
    deploymentBlock: "0",
    vaultRpId: "vault.mida.xyz",
    vaultRpIdHash: `0x${"55".repeat(32)}`,
    policyHashV1: `0x${"44".repeat(32)}`,
  }

  function passkeyHome(rpcUrl: string, withPublicKey: boolean): MidaHome {
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "passkey")
    saveOwnerAddress(home, OWNER, withPublicKey ? { x: QX, y: QY } : undefined)
    home.writeSecretJson("network.json", { rpcUrl, deployment: DEPLOYMENT })
    return home
  }

  function doctorLines(home: MidaHome, lines: string[]): Promise<number> {
    return runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
  }

  /** The lines the "owner" check printed — from its first line to the next check's output. */
  function ownerLines(lines: string[]): string[] {
    const start = lines.findIndex((line) => line.includes("owner is a passkey") || line.includes("passkey home has no owner"))
    if (start === -1) return []
    return lines.slice(start, start + 3)
  }

  it("reports the passkey owner, the matching on-chain key, and the remember note", async () => {
    const rpc = await stubRpc({ qx: BigInt(QX), qy: BigInt(QY) })
    const home = passkeyHome(rpc.url, true)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(ownerLines(lines)).toEqual([
        `ok: owner is a passkey (address ${OWNER}); no owner key on this machine`,
        "ok: owner passkey registered on chain (P-256 key matches)",
        "note: remember is not available with a passkey owner yet",
      ])
      expect(lines).toContain("ok: no wallets on this machine — only the passkey page signs owner sends")
      // doctor must never create or expect a software key
      expect(() => readFileSync(home.path("owner/secrets.json"), "utf8")).toThrow()
    } finally {
      await rpc.close()
    }
  })

  it("a registered key with no recorded point still reads ok — just without the match claim", async () => {
    const rpc = await stubRpc({ qx: BigInt(QX), qy: BigInt(QY) })
    const home = passkeyHome(rpc.url, false)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(ownerLines(lines)[1]).toBe("ok: owner passkey registered on chain")
    } finally {
      await rpc.close()
    }
  })

  it("no passkey on chain is a PROBLEM pointing at init --passkey", async () => {
    const rpc = await stubRpc(null)
    const home = passkeyHome(rpc.url, true)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(lines).toContain("PROBLEM: the chain holds no passkey for this owner — run `mida init --passkey`")
    } finally {
      await rpc.close()
    }
  })

  it("a different point on chain is a PROBLEM, not an ok", async () => {
    const rpc = await stubRpc({ qx: BigInt(`0x${"99".repeat(32)}`), qy: BigInt(QY) })
    const home = passkeyHome(rpc.url, true)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(lines.some((line) => line.startsWith("PROBLEM: the passkey on chain is not the key this home registered"))).toBe(true)
      expect(lines.every((line) => !line.includes("P-256 key matches"))).toBe(true)
    } finally {
      await rpc.close()
    }
  })

  it("a passkey home with no owner address says so and points at init --passkey", async () => {
    const rpc = await stubRpc(null)
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "passkey")
    home.writeSecretJson("network.json", { rpcUrl: rpc.url, deployment: DEPLOYMENT })
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(lines).toContain("PROBLEM: this passkey home has no owner yet — run `mida init --passkey`")
    } finally {
      await rpc.close()
    }
  })
})
