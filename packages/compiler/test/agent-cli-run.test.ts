// Agent-CLI model commands (UF-P1a). A ModelCommand marked agentCli runs in a
// fresh empty folder that is removed when the run settles, keeps its own env
// additions, pipes stderr only to spot a usage limit — never into the detail —
// and a chain whose every failure was a limit ends the compile at once as
// "summarizer-limit".

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compileCheckpoint, type CompileInput, type ModelCommand } from "../src/index.js"

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent-cli.mjs")

let dir: string
let base: CompileInput
let counterPath: string

function cli(mode: string, over: Partial<ModelCommand> = {}): ModelCommand {
  process.env.FAKE_CLI_COUNTER = counterPath
  return { argv: [process.execPath, fixturePath, mode], label: `cli-${mode}`, ...over }
}

const runs = (): number => (fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8").length : 0)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mida-agentcli-"))
  counterPath = path.join(dir, "counter.log")
  const transcriptPath = path.join(dir, "transcript.jsonl")
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Build a rate limiter in 3 steps" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
    ].join("\n") + "\n",
  )
  base = {
    transcriptPath,
    agent: "claude-code",
    eventId: "evt-00000001",
    cwd: dir,
    homeDir: os.homedir(),
    sleep: async () => {},
  }
})

afterEach(() => {
  delete process.env.FAKE_CLI_MODE
  delete process.env.FAKE_CLI_COUNTER
  delete process.env.ANTHROPIC_API_KEY
})

describe("agentCli model commands", () => {
  it("an agentCli command runs in a fresh empty folder that is removed afterwards", async () => {
    const r = await compileCheckpoint({ ...base, model: cli("report", { agentCli: true }) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const cwd = r.checkpoint.artifacts[0]!
    // /tmp is a symlink on macOS — the child reports its cwd fully resolved
    const tmpReal = fs.realpathSync(os.tmpdir())
    expect(fs.realpathSync(path.dirname(cwd))).toBe(tmpReal)
    expect(path.basename(cwd).startsWith("mida-sum-")).toBe(true)
    expect(r.checkpoint.progress.find((p) => p.startsWith("files:"))).toBe("files:")
    // the working folder is gone once the run settled
    expect(fs.existsSync(cwd)).toBe(false)
  })

  it("a command without agentCli still runs in os.tmpdir()", async () => {
    const r = await compileCheckpoint({ ...base, model: cli("report") })
    expect(r.ok && fs.realpathSync(r.checkpoint.artifacts[0]!)).toBe(fs.realpathSync(os.tmpdir()))
  })

  it("the command's env additions reach the child — but never an ANTHROPIC_ name", async () => {
    process.env.ANTHROPIC_API_KEY = "env-secret"
    const r = await compileCheckpoint({
      ...base,
      model: cli("report", {
        agentCli: true,
        env: { MIDA_TEST_EXTRA: "x", ANTHROPIC_API_KEY: "y" },
      }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.checkpoint.progress).toContain("extra:x")
    // ANTHROPIC_API_KEY is stripped from the child's env, and the command's own
    // env cannot smuggle it back — "y" must never be what the child saw
    expect(r.checkpoint.progress).toContain("anthropic:absent")
  })

  it("a usage limit on every chain command ends the compile at once as summarizer-limit", async () => {
    const r = await compileCheckpoint({ ...base, model: cli("limit", { agentCli: true }) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("summarizer-limit")
    expect(r.attempts).toBe(1)
    expect(runs()).toBe(1)
    expect(r.detail).toContain("(usage limit)")
    // the fixture's own text — stdout OR stderr — never reaches the detail
    expect(r.detail).not.toContain("session limit")
    expect(r.detail).not.toContain("resets")
  })

  it("a non-limit failure still costs every attempt and stays model-failed", async () => {
    const r = await compileCheckpoint({ ...base, model: cli("fail", { agentCli: true }) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("model-failed")
    expect(r.attempts).toBe(3)
    expect(runs()).toBe(3)
    expect(r.detail).not.toContain("(usage limit)")
  })

  it("a limit on the first command walks to the fallback, and the reason names the limit", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: cli("limit", { agentCli: true }),
      fallbackModels: [cli("good", { agentCli: true })],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.compiledBy).toBe("cli-good")
    expect(r.fellBack?.reason).toContain("(usage limit)")
  })

  it("a limit on the first command and a plain failure on the fallback stays model-failed", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: cli("limit", { agentCli: true }),
      fallbackModels: [cli("fail", { agentCli: true })],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("model-failed")
    expect(r.attempts).toBe(3)
  })

  it("the limit text on stderr with an empty stdout is still a limit", async () => {
    const r = await compileCheckpoint({ ...base, model: cli("limit-stderr", { agentCli: true }) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("summarizer-limit")
    expect(r.detail).toContain("(usage limit)")
    expect(r.detail).not.toContain("session limit")
  })
})
