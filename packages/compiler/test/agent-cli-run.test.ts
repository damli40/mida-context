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
import { compileCheckpoint, limitHit, type CompileInput, type ModelCommand } from "../src/index.js"

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent-cli.mjs")
const echoFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-echo-cli.mjs")

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

describe("the echoed prompt is never the tool's own words (UF-P1R)", () => {
  function echoCli(mode: string, over: Partial<ModelCommand> = {}): ModelCommand {
    process.env.FAKE_CLI_COUNTER = counterPath
    return { argv: [process.execPath, echoFixture, mode], label: `echo-${mode}`, agentCli: true, ...over }
  }
  /** A transcript whose single user line is exactly `line` — that line lands in the prompt the fixture echoes. */
  const withUserLine = (line: string): CompileInput => {
    const transcriptPath = path.join(dir, "echo-transcript.jsonl")
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { role: "user", content: line } }) + "\n")
    return { ...base, transcriptPath }
  }
  const strayTempDirs = (): string[] =>
    fs.readdirSync(fs.realpathSync(os.tmpdir())).filter((n) => n.startsWith("mida-sum-"))

  it("a prompt that mentions a weekly limit is echoed back — and the plain failure stays model-failed", async () => {
    const input = withUserLine("we hit the weekly limit on the API and added a rate limiter")
    const r = await compileCheckpoint({ ...input, model: echoCli("fail"), attempts: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("model-failed")
    expect(r.detail).not.toContain("(usage limit)")
  })

  it("the same echo followed by the tool's OWN limit line is a limit", async () => {
    const input = withUserLine("we hit the weekly limit on the API and added a rate limiter")
    const r = await compileCheckpoint({ ...input, model: echoCli("limit"), attempts: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("summarizer-limit")
  })

  it("a limit line after a 6,000-character echo is still seen — the kept stderr is the tail", async () => {
    const r = await compileCheckpoint({ ...base, model: echoCli("echo-limit"), attempts: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("summarizer-limit")
  })

  it("a limit line pushed out of the last 4,096 kept characters is honestly missed", async () => {
    // mode that prints the limit FIRST then a long tail — only the tail is kept
    const r = await compileCheckpoint({ ...base, model: echoCli("limit-first"), attempts: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("model-failed")
  })

  it("a two-command chain can reach summarizer-limit on a LATER attempt", async () => {
    // attempt 1: claude plain failure, then codex's limit; attempt 2 re-runs claude → limit.
    // Every command's most recent failure was a limit → the compile ends at once.
    const r = await compileCheckpoint({
      ...base,
      model: echoCli("fail+limit"),
      fallbackModels: [echoCli("limit")],
      attempts: 3,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("summarizer-limit")
    expect(r.attempts).toBe(2)
    expect(runs()).toBe(3)
  })

  it("a limit on claude and a plain failure on codex, every attempt, stays model-failed", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: echoCli("limit"),
      fallbackModels: [echoCli("fail")],
      attempts: 3,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("model-failed")
    expect(r.attempts).toBe(3)
    expect(runs()).toBe(4) // attempt1: claude+codex; later attempts re-run only the primary
  })

  it("a failure to create the empty folder reports the error code, never a path", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: echoCli("fail"),
      attempts: 1,
      makeTempDir: () => {
        throw Object.assign(new Error("mkdir /no/such/parent/mida-sum-x"), { code: "ENOENT" })
      },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toBe("echo-fail: temp folder: ENOENT")
    expect(r.detail).not.toMatch(/[\\/]/)
  })

  it("the working folder is removed after a non-zero exit", async () => {
    const before = strayTempDirs()
    const r = await compileCheckpoint({ ...base, model: echoCli("fail"), attempts: 1 })
    expect(r.ok).toBe(false)
    expect(strayTempDirs()).toEqual(before)
  })

  it("the working folder is removed after a timeout", async () => {
    const before = strayTempDirs()
    const r = await compileCheckpoint({ ...base, model: echoCli("hang", { timeoutMs: 200 }), attempts: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toContain("timeout")
    expect(strayTempDirs()).toEqual(before)
  })

  it("the working folder is removed after a spawn error", async () => {
    const before = strayTempDirs()
    const r = await compileCheckpoint({
      ...base,
      model: { argv: ["/no/such/binary"], label: "ghost", agentCli: true },
      attempts: 1,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toContain("spawn")
    expect(strayTempDirs()).toEqual(before)
  })

  it("an ANTHROPIC_* name inside the command's env never reaches the child", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: echoCli("env", { env: { ANTHROPIC_API_KEY: "smuggled", ANTHROPIC_BASE_URL: "http://evil" } }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.checkpoint.progress).toContain("anthropic:absent")
  })
})

describe("limitHit", () => {
  it("true for the tools' own limit lines", () => {
    expect(limitHit("", "", "You've hit your session limit · resets 3:45pm")).toBe(true)
    expect(limitHit("", "5-hour limit reached", "")).toBe(true)
    expect(limitHit("", "", "insufficient_quota")).toBe(true)
    expect(limitHit("", "Credit balance is too low", "")).toBe(true)
  })

  it("false for rate-limit words, disk quota, a limiter mention and empty output", () => {
    expect(limitHit("", "", "exceed your organization's rate limit")).toBe(false)
    // a passing API rate-limit error — retryable in seconds, NOT a plan limit
    expect(limitHit("", "", "http 429: rate limit exceeded, retry in 2s")).toBe(false)
    expect(limitHit("", "", "disk quota exceeded")).toBe(false)
    expect(limitHit("", "", "added a rate limiter")).toBe(false)
    expect(limitHit("", "", "")).toBe(false)
  })

  it("a limit line the session itself ended on is still recognised on stdout (UF-QD)", () => {
    // the transcript — and so the prompt — carries the very sentence the tool repeats
    const prompt = "Summarise this.\nClaude AI usage limit reached|1759363200"
    expect(limitHit(prompt, "Claude AI usage limit reached|1759363200", "")).toBe(true)
  })

  it("only what the tool printed AFTER its echo counts on stderr (UF-QD)", () => {
    const prompt = "Summarise this.\nwe hit the weekly limit on the API\nEND"
    expect(limitHit(prompt, "", `${prompt}\nYou've hit your usage limit.`)).toBe(true)
    // when the whole prompt echoes and the rest is an unrelated error, nothing counts
    expect(limitHit(prompt, "", `${prompt}\nError: not logged in`)).toBe(false)
  })

  it("the wording 'hit your limit' counts even without a limit noun (UF-QD)", () => {
    expect(limitHit("", "", "You've hit your limit · resets 3pm")).toBe(true)
  })

  it("a line that is just the echoed prompt does not count", () => {
    const prompt = "Summarise this.\nwe hit the weekly limit on the API"
    expect(limitHit(prompt, "", `Summarise this.\nwe hit the weekly limit on the API`)).toBe(false)
    // but the same words when NOT in the prompt still count
    expect(limitHit(prompt, "", "we hit the weekly limit elsewhere")).toBe(true)
  })

  it("a line that is only a half-echoed prompt line ends the echo now (UF-QF)", () => {
    // the stderr tail is capped at 4,096 characters, so an echoed prompt line can arrive cut
    // in half — UF-QF: a long enough suffix of the prompt's last line IS the echo's end, so
    // it and everything before it is the echo and a non-matching line after it is examined
    // alone. (UF-QD expected the half-echo to count as tool output; that was the defect —
    // it cannot be told apart from the echo's cut tail.)
    const prompt = "Summarise this.\nfirst half: we hit the weekly limit on the API"
    expect(limitHit(prompt, "", "we hit the weekly limit on the API")).toBe(false)
    // a non-matching line still answers false either way
    expect(limitHit(prompt, "", "API")).toBe(false)
  })

  it("a prompt's last line longer than the kept tail never matches whole — its cut half still ends the echo (UF-QF)", () => {
    // the previous checkpoint is one JSON line; at 4,996 characters it is longer than the
    // 4,096 of stderr that survive, so the prompt's last line is never found whole. The half
    // of it that IS in the tail still ends the echo, so only what the tool printed after it
    // is examined — a checkpoint that mentions a limit must not turn a plain failure into
    // summarizer-limit.
    const jsonLine = `{"note":"${"x".repeat(4960)} we hit the usage limit"}`
    const prompt = `Summarise this.\n${jsonLine}`
    const tail = prompt.slice(-4096)
    expect(limitHit(prompt, "", `${tail}\nERROR: stream disconnected`)).toBe(false)
    // …but the tool's own limit line, after the same echo, still counts
    expect(limitHit(prompt, "", `${tail}\nYou've hit your usage limit.`)).toBe(true)
  })

  it("the tool repeating the very sentence the session ended on is a limit, not the echo (UF-QF)", () => {
    // the prompt ends on the limit sentence, and the tool prints it as its own error too —
    // two copies is the tool's words, one would have been just the echo
    const prompt = "Summarise this.\nYou've hit your usage limit."
    const stderr = `Summarise this.\nYou've hit your usage limit.\nYou've hit your usage limit.`
    expect(limitHit(prompt, "", stderr)).toBe(true)
  })
})
