// The summariser chain (UF-P1a/P1b): the exact argv each agent CLI gets, the
// labels that become compiledBy, install detection on PATH, the --safe-mode
// probe, and resolveSummarizer's order of decision — saved key, saved agents,
// environment, agents-unchosen.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  binaryOnPath,
  claudeSummaryCommand,
  claudeSupportsSafeMode,
  codexSummaryCommand,
  resetClaudeSafeModeCache,
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
      "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-m", "gpt-6-luna", "-",
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

describe("claudeSupportsSafeMode", () => {
  beforeEach(() => resetClaudeSafeModeCache())
  afterEach(() => resetClaudeSafeModeCache())

  it("true when --help lists --safe-mode and --tools", () => {
    const answer = claudeSupportsSafeMode(() => ({ status: 0, stdout: "--safe-mode  --tools" }))
    expect(answer).toBe(true)
  })

  it("false on a non-zero status, and false when --tools is missing", () => {
    expect(claudeSupportsSafeMode(() => ({ status: 1, stdout: "--safe-mode --tools" }))).toBe(false)
    resetClaudeSafeModeCache()
    expect(claudeSupportsSafeMode(() => ({ status: 0, stdout: "--safe-mode only" }))).toBe(false)
  })

  it("the answer is remembered — no second probe until the cache is reset", () => {
    let calls = 0
    const probe = () => {
      calls += 1
      return { status: 0, stdout: "--safe-mode --tools" }
    }
    expect(claudeSupportsSafeMode(probe)).toBe(true)
    expect(claudeSupportsSafeMode(probe)).toBe(true)
    expect(calls).toBe(1)
    resetClaudeSafeModeCache()
    expect(claudeSupportsSafeMode(probe)).toBe(true)
    expect(calls).toBe(2)
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

  it("a saved custom endpoint sets base/model; an empty key sets no MIDA_COMPILE_API_KEY", () => {
    const r = resolve({
      saved: { use: "key", provider: "custom", apiKey: "", baseUrl: "http://localhost:8080/v1", model: "m-local" },
    })
    const e = r.entries[0]!
    expect(e.display).toBe("your endpoint (m-local)")
    expect(e.host).toBe("localhost:8080")
    expect(e.command.env).toMatchObject({ MIDA_COMPILE_BASE_URL: "http://localhost:8080/v1", MIDA_COMPILE_MODEL_ID: "m-local" })
    expect(e.command.env).not.toHaveProperty("MIDA_COMPILE_API_KEY")
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
