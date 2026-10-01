// The summariser chain (UF-P1a/P1b): the exact argv each agent CLI gets, the
// labels that become compiledBy, install detection on PATH, the --safe-mode
// probe, and resolveSummarizer's order of decision — saved key, saved agents,
// environment, agents-unchosen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  binaryOnPath,
  claudeSafeModeKnown,
  claudeSummaryCommand,
  codexSummaryCommand,
  probeClaudeSafeMode,
  resetClaudeSafeModeCache,
  resolveBinary,
  resolveSummarizer,
} from "../src/index.js"

describe("claudeSummaryCommand", () => {
  it("safe mode on: the exact argv, label, timeout and agentCli flag", () => {
    const cmd = claudeSummaryCommand({}, true)
    expect(cmd.argv).toEqual([
      "claude", "-p", "--model", "haiku", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    ])
    expect(cmd.label).toBe("claude-haiku")
    expect(cmd.timeoutMs).toBe(90_000)
    expect(cmd.agentCli).toBe(true)
  })

  it("safe mode off: the project-settings argv", () => {
    const cmd = claudeSummaryCommand({}, false)
    expect(cmd.argv).toEqual([
      "claude", "-p", "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config",
    ])
    expect(cmd.label).toBe("claude-haiku")
    expect(cmd.timeoutMs).toBe(90_000)
    expect(cmd.agentCli).toBe(true)
  })

  it("MIDA_CLAUDE_SUMMARY_MODEL overrides the model in argv and label", () => {
    const cmd = claudeSummaryCommand({ MIDA_CLAUDE_SUMMARY_MODEL: "sonnet" }, false)
    expect(cmd.argv).toContain("sonnet")
    expect(cmd.label).toBe("claude-sonnet")
  })
})

describe("codexSummaryCommand", () => {
  it("the exact argv, label, timeout and agentCli flag", () => {
    const cmd = codexSummaryCommand({})
    expect(cmd.argv).toEqual([
      "codex", "exec", "--ignore-user-config", "--ignore-rules", "--disable", "hooks",
      "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
      "-c", "features.shell_tool=false", "-c", 'web_search="disabled"',
      "-m", "gpt-6-luna", "-",
    ])
    expect(cmd.label).toBe("codex-luna")
    expect(cmd.timeoutMs).toBe(180_000)
    expect(cmd.agentCli).toBe(true)
  })

  it("MIDA_CODEX_SUMMARY_MODEL overrides the model; a non-gpt name labels as-is", () => {
    const cmd = codexSummaryCommand({ MIDA_CODEX_SUMMARY_MODEL: "o9" })
    expect(cmd.argv[cmd.argv.length - 2]).toBe("o9")
    expect(cmd.label).toBe("codex-o9")
  })
})

describe("binaryOnPath", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mida-path-"))
  })

  it("finds an executable regular file", () => {
    const bin = path.join(dir, "mida-tool")
    fs.writeFileSync(bin, "#!/bin/sh\n")
    fs.chmodSync(bin, 0o755)
    expect(binaryOnPath("mida-tool", dir)).toBe(true)
  })

  it("a non-executable file does not count", () => {
    fs.writeFileSync(path.join(dir, "mida-tool"), "x")
    expect(binaryOnPath("mida-tool", dir)).toBe(false)
  })

  it("a sub-folder of the same name does not count", () => {
    fs.mkdirSync(path.join(dir, "mida-tool"))
    expect(binaryOnPath("mida-tool", dir)).toBe(false)
  })

  it("an undefined or empty PATH is false", () => {
    expect(binaryOnPath("mida-tool", undefined)).toBe(false)
    expect(binaryOnPath("mida-tool", "")).toBe(false)
  })
})

describe("resolveBinary", () => {
  let dir: string
  let other: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mida-rb1-"))
    other = fs.mkdtempSync(path.join(os.tmpdir(), "mida-rb2-"))
  })
  const executable = (folder: string, name = "mida-tool"): string => {
    const bin = path.join(folder, name)
    fs.writeFileSync(bin, "#!/bin/sh\n")
    fs.chmodSync(bin, 0o755)
    return bin
  }

  it("returns the absolute path of the first executable on PATH — here the second folder", () => {
    const bin = executable(other)
    expect(resolveBinary("mida-tool", [dir, other].join(path.delimiter))).toBe(bin)
  })

  it("skips a relative PATH entry even when it holds the file", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mida-rb-rel-"))
    fs.mkdirSync(path.join(parent, "rel"))
    executable(path.join(parent, "rel"))
    const joined = ["rel", dir].join(path.delimiter)
    // cwd-independent: the relative entry must never count
    expect(resolveBinary("mida-tool", joined)).toBeUndefined()
    // sanity: with the folder absolute it is found
    expect(resolveBinary("mida-tool", path.join(parent, "rel"))).toBe(path.join(parent, "rel", "mida-tool"))
  })

  it("skips the empty PATH entry", () => {
    executable(dir)
    expect(resolveBinary("mida-tool", ["", dir].join(path.delimiter))).toBe(path.join(dir, "mida-tool"))
  })

  it("follows a symlink to an executable", () => {
    const real = executable(other)
    fs.symlinkSync(real, path.join(dir, "mida-link"))
    expect(resolveBinary("mida-link", dir)).toBe(path.join(dir, "mida-link"))
  })

  it("a folder of that name is not a binary", () => {
    fs.mkdirSync(path.join(dir, "mida-tool"))
    expect(resolveBinary("mida-tool", dir)).toBeUndefined()
  })
})

describe("probeClaudeSafeMode", () => {
  let dir: string
  let binary: string
  beforeEach(() => {
    resetClaudeSafeModeCache()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mida-probe-"))
    binary = path.join(dir, "claude")
    fs.writeFileSync(binary, "#!/bin/sh\n")
    fs.chmodSync(binary, 0o755)
  })
  afterEach(() => {
    resetClaudeSafeModeCache()
    vi.useRealTimers()
  })
  const yes = async () => ({ status: 0, stdout: "--safe-mode  --tools  --no-session-persistence" })

  it("true when --help lists --safe-mode, --tools and --no-session-persistence", async () => {
    expect(await probeClaudeSafeMode(binary, yes)).toBe(true)
  })

  it("false when --no-session-persistence is missing — the command passes all three (UF-QD)", async () => {
    expect(await probeClaudeSafeMode(binary, async () => ({ status: 0, stdout: "--safe-mode --tools" }))).toBe(false)
  })

  it("false on a non-zero status, and false when only one of the two words is present", async () => {
    expect(await probeClaudeSafeMode(binary, async () => ({ status: 1, stdout: "--safe-mode --tools" }))).toBe(false)
    resetClaudeSafeModeCache()
    expect(await probeClaudeSafeMode(binary, async () => ({ status: 0, stdout: "--safe-mode only" }))).toBe(false)
  })

  it("the answer is remembered per binary — one run for two calls, known synchronously after", async () => {
    let calls = 0
    const run = async () => (calls++, { status: 0, stdout: "--safe-mode --tools --no-session-persistence" })
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    expect(calls).toBe(1)
    expect(claudeSafeModeKnown(binary)).toBe(true)
  })

  it("expires after ten minutes — a new probe runs", async () => {
    vi.useFakeTimers()
    let calls = 0
    const run = async () => (calls++, { status: 0, stdout: "--safe-mode --tools --no-session-persistence" })
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1)
    expect(claudeSafeModeKnown(binary)).toBeUndefined()
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    expect(calls).toBe(2)
  })

  it("a good run's answer is still remembered at nine minutes (UF-P2R)", async () => {
    vi.useFakeTimers()
    let calls = 0
    const run = async () => (calls++, { status: 0, stdout: "--safe-mode --tools --no-session-persistence" })
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    vi.setSystemTime(Date.now() + 9 * 60 * 1000)
    expect(claudeSafeModeKnown(binary)).toBe(true)
    await probeClaudeSafeMode(binary, run)
    expect(calls).toBe(1)
  })

  it("a failed run's answer is remembered for only a minute (UF-P2R)", async () => {
    vi.useFakeTimers()
    let calls = 0
    const fail = async () => (calls++, { status: 1, stdout: "--safe-mode --tools" })
    expect(await probeClaudeSafeMode(binary, fail)).toBe(false)
    vi.setSystemTime(Date.now() + 59_000)
    // inside the minute the remembered false still answers — the probe does not re-run
    expect(claudeSafeModeKnown(binary)).toBe(false)
    expect(await probeClaudeSafeMode(binary, fail)).toBe(false)
    expect(calls).toBe(1)
    vi.setSystemTime(Date.now() + 2_000) // 61 s since the run finished
    expect(claudeSafeModeKnown(binary)).toBeUndefined()
    expect(await probeClaudeSafeMode(binary, fail)).toBe(false)
    expect(calls).toBe(2)
  })

  it("a different mtime is a different binary — it probes again", async () => {
    let calls = 0
    const run = async () => (calls++, { status: 0, stdout: "--safe-mode --tools --no-session-persistence" })
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    const day = 24 * 60 * 60 * 1000
    fs.utimesSync(binary, new Date(), new Date(Date.now() + day))
    expect(await probeClaudeSafeMode(binary, run)).toBe(true)
    expect(calls).toBe(2)
  })

  it("two calls while one is in flight share the same run", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const run = async () => (calls++, await gate, { status: 0, stdout: "--safe-mode --tools --no-session-persistence" })
    const a = probeClaudeSafeMode(binary, run)
    const b = probeClaudeSafeMode(binary, run)
    release()
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(calls).toBe(1)
  })
})

describe("claudeSafeModeKnown", () => {
  let binary: string
  beforeEach(() => {
    resetClaudeSafeModeCache()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mida-known-"))
    binary = path.join(dir, "claude")
    fs.writeFileSync(binary, "#!/bin/sh\n")
    fs.chmodSync(binary, 0o755)
  })
  afterEach(() => resetClaudeSafeModeCache())

  it("is undefined before any probe, and never runs anything itself", async () => {
    let calls = 0
    const run = async () => (calls++, { status: 0, stdout: "--safe-mode --tools --no-session-persistence" })
    expect(claudeSafeModeKnown(binary)).toBeUndefined()
    await probeClaudeSafeMode(binary, run)
    expect(claudeSafeModeKnown(binary)).toBe(true)
    expect(claudeSafeModeKnown(binary)).toBe(true)
    expect(calls).toBe(1)
  })
})

describe("resolveSummarizer", () => {
  const onPath = (...names: string[]) => (bin: string) => names.includes(bin)
  const resolve = (over: Partial<Parameters<typeof resolveSummarizer>[0]> = {}) =>
    resolveSummarizer({ saved: undefined, env: {}, onPath: onPath(), claudeSafeMode: false, ...over })

  it("nothing saved, nothing set: the two agents, chosen false (rule 4)", () => {
    const r = resolve()
    expect(r.mode).toBe("agents")
    expect(r.chosen).toBe(false)
    expect(r.entries.map((e) => e.id)).toEqual(["claude", "codex"])
    expect(r.chain).toEqual([])
  })

  it("a saved agents choice is chosen:true with both agent entries (rule 2)", () => {
    const r = resolve({ saved: { use: "agents" }, onPath: onPath("claude", "codex") })
    expect(r.mode).toBe("agents")
    expect(r.chosen).toBe(true)
    expect(r.entries.map((e) => e.id)).toEqual(["claude", "codex"])
    expect(r.chain.map((e) => e.id)).toEqual(["claude", "codex"])
    expect(r.entries[0]!.display).toBe("Claude Code (haiku)")
    expect(r.entries[0]!.host).toBe("api.anthropic.com")
    expect(r.entries[1]!.display).toBe("Codex (luna)")
    expect(r.entries[1]!.host).toBe("api.openai.com")
  })

  it("only what is on PATH can run — one side, both, or neither", () => {
    expect(resolve({ saved: { use: "agents" }, onPath: onPath("claude") }).chain.map((e) => e.id)).toEqual(["claude"])
    expect(resolve({ saved: { use: "agents" }, onPath: onPath("codex") }).chain.map((e) => e.id)).toEqual(["codex"])
    const none = resolve({ saved: { use: "agents" }, onPath: onPath() })
    expect(none.chain).toEqual([])
    expect(none.entries).toHaveLength(2)
  })

  it("a saved deepseek key is one entry, the key on command.env, never in argv/label/display (rule 1)", () => {
    const r = resolve({
      saved: { use: "key", provider: "deepseek", apiKey: "sk-deep", model: "deepseek-x" },
      env: { DEEPSEEK_API_KEY: "other" }, // a saved choice wins over the environment
    })
    expect(r.mode).toBe("key")
    expect(r.chosen).toBe(true)
    expect(r.entries).toHaveLength(1)
    const e = r.entries[0]!
    expect(e.id).toBe("deepseek")
    expect(e.display).toBe("DeepSeek (deepseek-x)")
    expect(e.label).toBe("deepseek-x")
    expect(e.host).toBe("api.deepseek.com")
    expect(e.installed).toBe(true)
    expect(e.command.env).toMatchObject({ DEEPSEEK_API_KEY: "sk-deep", DEEPSEEK_MODEL: "deepseek-x" })
    expect(e.command.argv.join(" ")).not.toContain("sk-deep")
    // the key lives only on command.env — never in what the user or the log reads
    expect(e.label).not.toContain("sk-deep")
    expect(e.display).not.toContain("sk-deep")
  })

  it("a saved kimi key builds the kimi env and the Moonshot display", () => {
    const r = resolve({ saved: { use: "key", provider: "kimi", apiKey: "kk", model: "kimi-y" } })
    const e = r.entries[0]!
    expect(e.display).toBe("Moonshot (kimi-y)")
    expect(e.host).toBe("api.moonshot.ai")
    expect(e.command.env).toMatchObject({ KIMI_API_KEY: "kk", KIMI_MODEL: "kimi-y" })
  })

  it("a saved custom endpoint sets base/model; an empty key still pins MIDA_COMPILE_API_KEY to the empty string", () => {
    const r = resolve({
      saved: { use: "key", provider: "custom", apiKey: "", baseUrl: "http://localhost:8080/v1", model: "m-local" },
      env: { MIDA_COMPILE_API_KEY: "env-key" }, // a stray env key must never reach a saved endpoint
    })
    const e = r.entries[0]!
    expect(e.display).toBe("your endpoint (m-local)")
    expect(e.host).toBe("localhost:8080")
    // the whole pinned env — the saved key ALWAYS wins, the empty string included
    expect(e.command.env).toEqual({
      MIDA_COMPILE_BASE_URL: "http://localhost:8080/v1",
      MIDA_COMPILE_MODEL_ID: "m-local",
      MIDA_COMPILE_API_KEY: "",
      MIDA_COMPILE_TIMEOUT_MS: "120000",
    })
  })

  it("a saved deepseek key pins the whole env — a stray DEEPSEEK_BASE_URL cannot redirect it", () => {
    const r = resolve({
      saved: { use: "key", provider: "deepseek", apiKey: "sk-deep" },
      env: { DEEPSEEK_BASE_URL: "https://evil.example", DEEPSEEK_MODEL: "env-model", DEEPSEEK_API_KEY: "env-key" },
    })
    const e = r.entries[0]!
    expect(e.command.env).toEqual({
      DEEPSEEK_API_KEY: "sk-deep",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-flash",
      DEEPSEEK_TIMEOUT_MS: "120000",
    })
    expect(e.host).toBe("api.deepseek.com")
    expect(e.label).toBe("deepseek-flash")
  })

  it("a saved kimi key pins the whole env the same way", () => {
    const r = resolve({
      saved: { use: "key", provider: "kimi", apiKey: "kk", model: "kimi-y" },
      env: { KIMI_BASE_URL: "https://evil.example", KIMI_API_KEY: "env-key" },
    })
    const e = r.entries[0]!
    expect(e.command.env).toEqual({
      KIMI_API_KEY: "kk",
      KIMI_BASE_URL: "https://api.moonshot.ai",
      KIMI_MODEL: "kimi-y",
      KIMI_TIMEOUT_MS: "120000",
    })
    expect(e.host).toBe("api.moonshot.ai")
  })

  it("a saved key choice pins the provider's timeout too — a stray outer variable cannot shorten it (UF-P2R)", () => {
    const deepseek = resolve({
      saved: { use: "key", provider: "deepseek", apiKey: "sk-deep" },
      env: { DEEPSEEK_TIMEOUT_MS: "1" },
    })
    expect(deepseek.entries[0]!.command.env).toMatchObject({ DEEPSEEK_TIMEOUT_MS: "120000" })
    expect(deepseek.entries[0]!.command.timeoutMs).toBe(120_000)

    const kimi = resolve({
      saved: { use: "key", provider: "kimi", apiKey: "kk" },
      env: { KIMI_TIMEOUT_MS: "1" },
    })
    expect(kimi.entries[0]!.command.env).toMatchObject({ KIMI_TIMEOUT_MS: "120000" })
    expect(kimi.entries[0]!.command.timeoutMs).toBe(120_000)

    const custom = resolve({
      saved: { use: "key", provider: "custom", apiKey: "k", baseUrl: "https://h/v1", model: "m" },
      env: { MIDA_COMPILE_TIMEOUT_MS: "1" },
    })
    expect(custom.entries[0]!.command.env).toMatchObject({ MIDA_COMPILE_TIMEOUT_MS: "120000" })
    expect(custom.entries[0]!.command.timeoutMs).toBe(120_000)
  })

  it("MIDA_COMPILE_MODEL=custom with MIDA_COMPILE_FALLBACK=1 still never grows a codex tail", () => {
    const r = resolve({
      env: {
        MIDA_COMPILE_MODEL: "custom",
        MIDA_COMPILE_FALLBACK: "1",
        MIDA_COMPILE_BASE_URL: "http://h:9/v1",
        MIDA_COMPILE_MODEL_ID: "m",
        DEEPSEEK_API_KEY: "k",
      },
      onPath: onPath("claude", "codex"),
    })
    expect(r.mode).toBe("environment")
    // the vendor order behind a pinned custom — and no Codex: a privacy pin must
    // not send the session text to an agent CLI's vendor either
    expect(r.entries.map((e) => e.id)).toEqual(["custom", "deepseek", "claude"])
  })

  it("DEEPSEEK_API_KEY alone: environment mode, deepseek then claude then codex (rule 3)", () => {
    const r = resolve({ env: { DEEPSEEK_API_KEY: "k" }, onPath: onPath("claude", "codex") })
    expect(r.mode).toBe("environment")
    expect(r.chosen).toBe(true)
    expect(r.entries.map((e) => e.id)).toEqual(["deepseek", "claude", "codex"])
    expect(r.chain.map((e) => e.id)).toEqual(["deepseek", "claude", "codex"])
  })

  it("codex drops out of the runnable chain when its binary is absent", () => {
    const r = resolve({ env: { DEEPSEEK_API_KEY: "k" }, onPath: onPath("claude") })
    expect(r.entries.map((e) => e.id)).toEqual(["deepseek", "claude", "codex"])
    expect(r.chain.map((e) => e.id)).toEqual(["deepseek", "claude"])
  })

  it("MIDA_COMPILE_MODEL=haiku gives the Claude entry only — no codex tail", () => {
    const r = resolve({ env: { MIDA_COMPILE_MODEL: "haiku" }, onPath: onPath("claude", "codex") })
    expect(r.mode).toBe("environment")
    expect(r.entries.map((e) => e.id)).toEqual(["claude"])
  })

  it("MIDA_COMPILE_MODEL=custom gives the custom entry only", () => {
    const r = resolve({
      env: { MIDA_COMPILE_MODEL: "custom", MIDA_COMPILE_BASE_URL: "http://h:9/v1", MIDA_COMPILE_MODEL_ID: "m" },
    })
    expect(r.mode).toBe("environment")
    expect(r.entries.map((e) => e.id)).toEqual(["custom"])
    expect(r.entries[0]!.display).toBe("your endpoint (m)")
    expect(r.entries[0]!.host).toBe("h:9")
  })

  it("claudeSafeMode picks between the two Claude argv forms", () => {
    const safe = resolve({ saved: { use: "agents" }, claudeSafeMode: true })
    const unsafe = resolve({ saved: { use: "agents" }, claudeSafeMode: false })
    expect(safe.entries[0]!.command.argv).toContain("--safe-mode")
    expect(unsafe.entries[0]!.command.argv).toContain("--setting-sources")
  })
})
