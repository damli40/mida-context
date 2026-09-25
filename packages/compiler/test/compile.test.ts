// compileCheckpoint — Task 4. The eight cases below the harness are the
// plan's code verbatim; the secrets case is a port of spike/test/
// capture.test.mjs's "stores a hook-compiler checkpoint with secrets
// scrubbed" — same inputs, same expectations — using FAKE_MODEL_STDIN_LOG.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Checkpoint } from "@mida/checkpoint"
import { compileCheckpoint, type CompileInput, type ModelCommand } from "../src/index.js"

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-model.mjs")

// Same 8 secret shapes as the spike's capture test. Placeholder values —
// only the shapes matter, nothing real is ever used.
const SECRETS = {
  openai: "sk-test-abc123def456ghi789",
  github: "ghp_test1234567890abcdef",
  hexkey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  barehex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  envassign: "API_KEY=hunter2",
  envquoted: "hunter2-real-secret",
  jsonKv: "plainApiKeyValue42",
  bearer: "tok-live-bearer-abc123",
}

let dir: string
let base: CompileInput
let stdinLogPath: string
let envLogPath: string

// fake(mode) returns the model command for the fixture and points
// FAKE_MODEL_MODE at that mode in process.env for this test — compile passes
// its environment through to the child, so this is how the mode arrives.
function fake(mode: string): ModelCommand {
  process.env.FAKE_MODEL_MODE = mode
  process.env.FAKE_MODEL_COUNTER = path.join(dir, `counter-${mode}.log`)
  return { argv: [process.execPath, fixturePath], label: "fake" }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mida-compiler-"))
  const transcriptPath = path.join(dir, "transcript.jsonl")
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Build a rate limiter in 3 steps" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On it — doing step 1 first." }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "step 1 ok" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Step 1 done, on to step 2." }] } }),
    ].join("\n"),
  )
  stdinLogPath = path.join(dir, "model-stdin.log")
  envLogPath = path.join(dir, "model-env.log")
  base = {
    transcriptPath,
    agent: "claude-code",
    eventId: "evt-00000001",
    cwd: dir,
    homeDir: os.homedir(),
  }
})

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.ANTHROPIC_FOO
  delete process.env.FAKE_MODEL_MODE
  delete process.env.FAKE_MODEL_COUNTER
  delete process.env.FAKE_MODEL_STDIN_LOG
  delete process.env.FAKE_MODEL_ENV_LOG
  delete process.env.FAKE_MODEL_PID_LOG
})

describe("compileCheckpoint", () => {
  it("keeps the previous checkpoint's originalRequest when this transcript yields none (F3)", async () => {
    // a resumed session can open on a bare tool_result — no user line carries a
    // request, so the pick is empty and the earlier request must survive
    const resumed = path.join(dir, "resumed.jsonl")
    fs.writeFileSync(
      resumed,
      [
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "resumed output" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "continuing" }] } }),
      ].join("\n"),
    )
    const previous: Checkpoint = {
      eventId: "evt-earlier",
      agent: "claude-code",
      source: "hook-compiler",
      createdAt: new Date().toISOString(),
      objective: "earlier work",
      originalRequest: "the earlier real request",
      progress: [],
      decisions: [],
      rejected: [],
      constraints: [],
      artifacts: [],
      unresolvedIssue: null,
      nextAction: "next",
      remainingPlan: [],
      evidence: [],
    }
    const r = await compileCheckpoint({ ...base, transcriptPath: resumed, model: fake("good"), previous })
    expect(r.ok && r.checkpoint.originalRequest).toBe("the earlier real request")
  })

  it("a fresh first user message wins over the previous checkpoint's originalRequest (F3)", async () => {
    const previous: Checkpoint = {
      eventId: "evt-earlier",
      agent: "claude-code",
      source: "hook-compiler",
      createdAt: new Date().toISOString(),
      objective: "earlier work",
      originalRequest: "the earlier real request",
      progress: [],
      decisions: [],
      rejected: [],
      constraints: [],
      artifacts: [],
      unresolvedIssue: null,
      nextAction: "next",
      remainingPlan: [],
      evidence: [],
    }
    const r = await compileCheckpoint({ ...base, model: fake("good"), previous })
    expect(r.ok && r.checkpoint.originalRequest).toBe("Build a rate limiter in 3 steps")
  })

  it("an agent with no transcript reader is refused, never parsed through another format (F9)", async () => {
    // "gemini" has no reader — before this fix the code fell back to the Claude reader,
    // so a transcript in an unknown format was silently read as Claude Code's
    await expect(compileCheckpoint({ ...base, agent: "gemini", model: fake("good") })).rejects.toThrow(
      /no transcript reader/,
    )
  })

  it("stores the user's request by code and drops the model's own originalRequest", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("extra") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.originalRequest).toBe("Build a rate limiter in 3 steps")
      expect([...r.droppedKeys].sort()).toEqual(["confidence", "notes", "originalRequest"])
      expect(r.checkpoint.source).toBe("hook-compiler")
      expect(r.compiledBy).toBe("fake")
      expect(r.retried).toBe(0) // a clean first answer never spends the retry
    }
  })
  it("retries a failing model and succeeds on the third try, waiting between tries", async () => {
    const waits: number[] = []
    const r = await compileCheckpoint({ ...base, model: fake("flaky"), sleep: async (ms) => { waits.push(ms) } })
    expect(r.ok && r.attempts).toBe(3)
    expect(waits).toEqual([2000, 8000])
  })
  it("gives up after three tries and says why", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("fail"), sleep: async () => {} })
    expect(r).toMatchObject({ ok: false, reason: "model-failed", attempts: 3 })
  })
  it("retries output with no JSON in it", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("garbage"), sleep: async () => {} })
    expect(r).toMatchObject({ ok: false, reason: "no-json", attempts: 3 })
  })
  it("a no-json failure carries a scrubbed, 200-char-bounded sample of the provider's last answer (F4)", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("prose-secret"), attempts: 1, sleep: async () => {} })
    expect(r).toMatchObject({ ok: false, reason: "no-json" })
    if (!r.ok) {
      expect(r.sample).toBeDefined()
      expect(r.sample!.length).toBeLessThanOrEqual(200)
      expect(r.sample).not.toContain("sk-live-abcdefgh12345678")
      expect(r.sample).toContain("[REDACTED]")
    }
  })
  it("an invalid failure carries the same sample; a transport failure carries none", async () => {
    const invalid = await compileCheckpoint({ ...base, model: fake("badshape"), attempts: 1, sleep: async () => {} })
    expect(invalid).toMatchObject({ ok: false, reason: "invalid", sample: '{"objective":5}' })
    const transport = await compileCheckpoint({ ...base, model: fake("fail"), attempts: 1, sleep: async () => {} })
    expect(transport).toMatchObject({ ok: false, reason: "model-failed" })
    if (!transport.ok) expect(transport.sample).toBeUndefined()
  })
  it("an invalid shape gets one same-provider retry, then stays terminal — the outer attempts never re-run (M3-H)", async () => {
    // badshape-count answers invalid on every call and counts them: call 1 fails, the one
    // retry fails the same way, and with no fallback the compile reports invalid at once —
    // attempts is still 1 because the retry happens INSIDE the attempt, in place
    const counter = path.join(dir, "primary-ran.log")
    process.env.FAKE_MODEL_COUNTER = counter
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "badshape-count"], label: "fake" },
      sleep: async () => {},
    })
    expect(r).toMatchObject({ ok: false, reason: "invalid", attempts: 1, retried: 1 })
    if (!r.ok) expect(r.fields).toContain("objective")
    expect(fs.readFileSync(counter, "utf8")).toBe("2")
  })
  it("kills a hanging model at the timeout", async () => {
    const started = Date.now()
    const r = await compileCheckpoint({ ...base, model: { ...fake("hang"), timeoutMs: 300 }, attempts: 1 })
    expect(r).toMatchObject({ ok: false, reason: "model-failed" })
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it("kills the model's whole process group when a grandchild holds stdout (A5)", async () => {
    const pidLog = path.join(dir, "grandchild.pid")
    process.env.FAKE_MODEL_PID_LOG = pidLog
    const started = Date.now()
    const r = await compileCheckpoint({ ...base, model: { ...fake("grandchild"), timeoutMs: 500 }, attempts: 1 })
    expect(r).toMatchObject({ ok: false, reason: "model-failed" })
    expect(Date.now() - started).toBeLessThan(3000)
    const pid = Number(fs.readFileSync(pidLog, "utf8"))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(() => process.kill(pid, 0)).toThrow()
  })
  it("never passes any ANTHROPIC_* variable to the model, and sets MIDA_INNER=1", async () => {
    // Values are built by concatenation so no secret-shaped literal sits in the repo.
    process.env.ANTHROPIC_API_KEY = "sk-" + "ant-" + "a"
    process.env.ANTHROPIC_AUTH_TOKEN = "to" + "ken"
    process.env.ANTHROPIC_BASE_URL = "https" + "://" + "collector.invalid"
    process.env.ANTHROPIC_CUSTOM_HEADERS = "x-" + "forward"
    process.env.ANTHROPIC_FOO = "un" + "listed"
    process.env.FAKE_MODEL_ENV_LOG = envLogPath
    await compileCheckpoint({ ...base, model: fake("good") })
    const names = fs.readFileSync(envLogPath, "utf8").split("\n")
    expect(names.filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([])
    expect(names).toContain("MIDA_INNER")
    expect(names).toContain("PATH")
  })
  it("rewrites absolute paths under cwd to relative and under home to ~", async () => {
    // fake "good" output lists artifacts ["/Users/x/proj/src/a.ts", "/Users/x/notes.md"]
    const r = await compileCheckpoint({ ...base, cwd: "/Users/x/proj", homeDir: "/Users/x", model: fake("good") })
    expect(r.ok && r.checkpoint.artifacts).toEqual(["src/a.ts", "~/notes.md"])
  })
  it("scrubs a secret the model itself returns before storing (A7)", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("leaky") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.stringify(r.checkpoint)).not.toContain("sk-live-abcdefgh12345678")
      expect(r.checkpoint.progress[0]).toContain("[REDACTED]")
    }
  })
  it("cuts an over-long string field to the limit and names it in trimmed (A8)", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("longitem") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.progress[0]).toHaveLength(2000)
      expect(r.checkpoint.progress[0]!.endsWith("…")).toBe(true)
      expect(r.trimmed).toContain("progress[0]")
    }
  })
  it("keeps the first 50 of an over-long array and names it in trimmed (A8)", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("wide") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.decisions).toHaveLength(50)
      expect(r.checkpoint.decisions[0]!.decision).toBe("d0")
      expect(r.trimmed).toContain("decisions")
    }
  })
  it("treats a reasoning-only object as no-json and retries (A8)", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("reasoning"), sleep: async () => {} })
    expect(r).toMatchObject({ ok: false, reason: "no-json", attempts: 3 })
  })
  it("a failed primary falls back once inside the same attempt — compiledBy says who wrote it (R5-8)", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "fail"], label: "kimi-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "good"], label: "haiku-y" }],
      sleep: async () => {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiledBy).toBe("haiku-y")
      expect(r.attempts).toBe(1) // the fallback ran INSIDE attempt 1, not as a retry
      expect(r.fellBack).toEqual({ from: "kimi-x", to: "haiku-y", reason: expect.stringContaining("exit 3") })
    }
  })

  it("a fallback that also fails ends the attempt — and the fallback is spent, never run again (R5-8)", async () => {
    // the fallback's "flaky" mode counts its runs in FAKE_MODEL_COUNTER; three attempts with a
    // dead primary must still call it exactly once
    const counter = path.join(dir, "fallback-ran.log")
    process.env.FAKE_MODEL_COUNTER = counter
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "fail"], label: "kimi-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "flaky"], label: "haiku-y" }],
      sleep: async () => {},
    })
    expect(r).toMatchObject({ ok: false, reason: "model-failed", attempts: 3 })
    expect(fs.readFileSync(counter, "utf8")).toBe("1")
    // the failure still records that the fallback ran and lost — the primary's reason that triggered it
    if (!r.ok) expect(r.fellBack).toEqual({ from: "kimi-x", to: "haiku-y", reason: expect.stringContaining("exit 3") })
  })

  it("a dead primary walks the whole chain — each provider tried at most once, compiledBy names the writer (M3-D5)", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "fail"], label: "deepseek-x" },
      fallbackModels: [
        { argv: [process.execPath, fixturePath, "fail"], label: "kimi-y" },
        { argv: [process.execPath, fixturePath, "good"], label: "haiku-z" },
      ],
      sleep: async () => {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // the drain logs compiledBy + fellBack — both must name the real writer, not the primary
      expect(r.compiledBy).toBe("haiku-z")
      expect(r.attempts).toBe(1) // the whole chain ran INSIDE attempt 1
      expect(r.fellBack).toEqual({ from: "deepseek-x", to: "haiku-z", reason: expect.stringContaining("exit 3") })
    }
  })

  it("a whole chain that fails tries each provider once and reports every hop in the reason (M3-D5)", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "fail"], label: "deepseek-x" },
      fallbackModels: [
        { argv: [process.execPath, fixturePath, "stderr-fail"], label: "kimi-y", stderrDetail: true },
        { argv: [process.execPath, fixturePath, "fail"], label: "haiku-z" },
      ],
      attempts: 2,
      sleep: async () => {},
    })
    expect(r).toMatchObject({ ok: false, reason: "model-failed", attempts: 2 })
    if (!r.ok) {
      expect(r.fellBack).toEqual({ from: "deepseek-x", to: "haiku-z", reason: expect.stringContaining("exit 3") })
      expect(r.fellBack!.reason).toContain("kimi http 429") // the middle hop's controlled stderr made it in
      expect(r.detail).toContain("exit 3")
    }
  })

  it("a primary that answers with no JSON walks the chain too — an unreliable provider is a fallback trigger (M3-D5)", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "garbage"], label: "deepseek-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "good"], label: "kimi-y" }],
      attempts: 1,
      sleep: async () => {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiledBy).toBe("kimi-y")
      expect(r.retried).toBe(1) // M3-H: the no-json primary was re-asked once before the walk
      expect(r.fellBack).toEqual({ from: "deepseek-x", to: "kimi-y", reason: expect.stringContaining("no JSON") })
    }
  })

  it("a bad-shape answer earns the primary one same-provider retry — retried:1, no fallback (M3-H)", async () => {
    // shape-flaky is invalid on its first call and good on its second: the retry is a
    // cache-hit rerun of the identical prompt, so the primary itself writes the checkpoint
    const counter = path.join(dir, "primary-ran.log")
    process.env.FAKE_MODEL_COUNTER = counter
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "shape-flaky"], label: "deepseek-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "good"], label: "kimi-y" }],
      sleep: async () => {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiledBy).toBe("deepseek-x")
      expect(r.retried).toBe(1)
      expect(r.attempts).toBe(1)
      expect(r.fellBack).toBeUndefined()
    }
    expect(fs.readFileSync(counter, "utf8")).toBe("2") // the fallback never ran
  })

  it("a bad shape twice in a row walks the chain — retried:1, fellBack keeps the original reason (M3-H)", async () => {
    const counter = path.join(dir, "primary-ran.log")
    process.env.FAKE_MODEL_COUNTER = counter
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "badshape-count"], label: "deepseek-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "good"], label: "kimi-y" }],
      sleep: async () => {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiledBy).toBe("kimi-y")
      expect(r.retried).toBe(1)
      expect(r.attempts).toBe(1)
      expect(r.fellBack).toEqual({ from: "deepseek-x", to: "kimi-y", reason: expect.stringContaining("objective") })
    }
    expect(fs.readFileSync(counter, "utf8")).toBe("2") // original call + one retry, then the walk
  })

  it("a transport failure never earns the retry — model-failed walks at once (M3-H)", async () => {
    // flaky exits 3 on its first run — the shape a provider's "http 429" lands as: one call,
    // no re-ask, straight to the fallback
    const counter = path.join(dir, "primary-ran.log")
    process.env.FAKE_MODEL_COUNTER = counter
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "flaky"], label: "deepseek-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "good"], label: "kimi-y" }],
      sleep: async () => {},
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.compiledBy).toBe("kimi-y")
      expect(r.retried).toBe(0)
    }
    expect(fs.readFileSync(counter, "utf8")).toBe("1")
  })

  it("the retry belongs to the primary alone — a fallback's bad shape is never re-asked (M3-H)", async () => {
    // badshape-count answers invalid on every call and counts them: as a fallback it must run
    // exactly once — the worst case a compile can add is the primary's single retry
    const counter = path.join(dir, "fallback-ran.log")
    process.env.FAKE_MODEL_COUNTER = counter
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "fail"], label: "deepseek-x" },
      fallbackModels: [{ argv: [process.execPath, fixturePath, "badshape-count"], label: "kimi-y" }],
      attempts: 1,
      sleep: async () => {},
    })
    expect(r).toMatchObject({ ok: false, reason: "invalid", attempts: 1, retried: 0 })
    expect(fs.readFileSync(counter, "utf8")).toBe("1")
  })

  it("reads the provider's cache-usage line off a controlled stderr into the result (M3-H)", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "cache-stats"], label: "deepseek-x", stderrDetail: true },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cacheHitTokens).toBe(11)
      expect(r.cacheMissTokens).toBe(22)
    }
  })

  it("without stderrDetail the same command's stderr is never read — no cache fields", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "cache-stats"], label: "deepseek-x" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cacheHitTokens).toBeUndefined()
      expect(r.cacheMissTokens).toBeUndefined()
    }
  })

  it("a malformed cache line is ignored and the compile still succeeds", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "cache-stats-bad"], label: "deepseek-x", stderrDetail: true },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cacheHitTokens).toBeUndefined()
      expect(r.cacheMissTokens).toBeUndefined()
    }
  })

  it("a full provider usage object lands all four numbers on the result (telemetry)", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "usage-stats"], label: "deepseek-x", stderrDetail: true },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cacheHitTokens).toBe(11)
      expect(r.cacheMissTokens).toBe(22)
      expect(r.inputTokens).toBe(50)
      expect(r.outputTokens).toBe(12)
    }
  })

  it("token usage travels on its own — a provider with no cache pair still reports in/out", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "token-stats"], label: "kimi-x", stderrDetail: true },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.inputTokens).toBe(50)
      expect(r.outputTokens).toBe(12)
      expect(r.cacheHitTokens).toBeUndefined()
      expect(r.cacheMissTokens).toBeUndefined()
    }
  })

  it("a provider that reports no usage leaves every token field absent — never zero", async () => {
    const r = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "good"], label: "haiku-y", stderrDetail: true },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.inputTokens).toBeUndefined()
      expect(r.outputTokens).toBeUndefined()
      expect(r.cacheHitTokens).toBeUndefined()
      expect(r.cacheMissTokens).toBeUndefined()
    }
  })

  it("stderrDetail lets a model command's safe stderr line into the failure detail (R5-8)", async () => {
    const withFlag = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "stderr-fail"], label: "kimi-x", stderrDetail: true },
      attempts: 1,
    })
    expect(withFlag).toMatchObject({ ok: false, reason: "model-failed" })
    if (!withFlag.ok) expect(withFlag.detail).toContain("kimi http 429")
    // without the flag the same command's stderr stays out of the log — never model output
    const without = await compileCheckpoint({
      ...base,
      model: { argv: [process.execPath, fixturePath, "stderr-fail"], label: "kimi-x" },
      attempts: 1,
    })
    if (!without.ok) expect(without.detail).not.toContain("kimi http 429")
  })

  it("hands the session's previous checkpoint to the model to update (C1)", async () => {
    const previous: Checkpoint = {
      eventId: "evt-prev0001",
      agent: "claude-code",
      source: "hook-compiler",
      createdAt: "2026-09-21T09:00:00.000Z",
      objective: "Implement the rate limiter",
      originalRequest: "Build a rate limiter in 3 steps",
      progress: ["skeleton written"],
      decisions: [{ decision: "lazy refill on each call", rationale: "timers are banned" }],
      rejected: [{ approach: "background interval refill", why: "no-timers constraint" }],
      constraints: ["no dependencies"],
      artifacts: ["src/a.ts"],
      unresolvedIssue: null,
      nextAction: "add tests",
      remainingPlan: ["2. add tests", "3. write README"],
      evidence: [],
    }
    // the fixture parses the PREVIOUS CHECKPOINT block out of its stdin and
    // echoes it with one extra progress item — the returned checkpoint proves
    // the block reached the model intact and parseable
    const r = await compileCheckpoint({ ...base, previous, model: fake("echo-previous") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.progress).toEqual(["skeleton written", "echo-previous saw the block"])
      expect(r.checkpoint.decisions).toEqual(previous.decisions)
      expect(r.checkpoint.remainingPlan).toEqual(previous.remainingPlan)
      // the fields the model may not write still come from the caller
      expect(r.checkpoint.eventId).toBe("evt-00000001")
      expect(r.checkpoint.originalRequest).toBe("Build a rate limiter in 3 steps")
      expect(r.droppedKeys).toEqual([])
    }
  })

  // Ports of the remaining three capture-worker cases from
  // spike/test/original-request.test.mjs (H1), now end to end through
  // compileCheckpoint: the stored originalRequest comes from the transcript.
  it("a secret in the first user message is redacted before storing (A9)", async () => {
    const transcriptPath = path.join(dir, "first-secret.jsonl")
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: `build the limiter; my key is ${SECRETS.openai} in case you need it` },
      }),
    )
    const r = await compileCheckpoint({ ...base, transcriptPath, model: fake("good") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.originalRequest).toContain("[REDACTED]")
      expect(r.checkpoint.originalRequest).not.toContain(SECRETS.openai)
    }
  })
  it("a 9,000-char first message stores 6,000 chars ending in … (A9)", async () => {
    const transcriptPath = path.join(dir, "long-first.jsonl")
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", message: { role: "user", content: "z".repeat(9_000) } }),
    )
    const r = await compileCheckpoint({ ...base, transcriptPath, model: fake("good") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.originalRequest).toHaveLength(6_000)
      expect(r.checkpoint.originalRequest!.endsWith("…")).toBe(true)
    }
  })
  it("an unknown-tail transcript stores originalRequest null (A9)", async () => {
    const transcriptPath = path.join(dir, "tail.jsonl")
    fs.writeFileSync(transcriptPath, "not json at all\nstill not json\n")
    const r = await compileCheckpoint({ ...base, transcriptPath, model: fake("good") })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.checkpoint.originalRequest).toBeNull()
  })

  // Port of the spike's secrets case: the transcript is a JSONL file whose
  // lines carry secrets inside JSON strings (plus one cut mid-line head), the
  // same fixtureTranscript the spike used. The scrubbed text must be what the
  // model sees — FAKE_MODEL_STDIN_LOG captures the exact bytes sent on stdin.
  it("the 8 secret shapes never reach the extractor's stdin", async () => {
    const transcriptPath = path.join(dir, "secrets.jsonl")
    fs.writeFileSync(
      transcriptPath,
      [
        `cut mid-line: API_KEY=\\"${SECRETS.envquoted}\\" && run`,
        JSON.stringify({ role: "assistant", content: "I will implement the TokenBucket now." }),
        JSON.stringify({ role: "assistant", content: `export API_KEY="${SECRETS.envquoted}" && run` }),
        JSON.stringify({ role: "assistant", content: `using key ${SECRETS.openai} for the call` }),
        JSON.stringify({ role: "assistant", content: `github token ${SECRETS.github}` }),
        JSON.stringify({ role: "assistant", content: `env says ${SECRETS.envassign}` }),
        JSON.stringify({ role: "assistant", content: `wallet key ${SECRETS.hexkey}` }),
        JSON.stringify({ role: "assistant", content: `bare hex ${SECRETS.barehex} seen` }),
        JSON.stringify({ role: "tool", content: `Authorization: Bearer ${SECRETS.bearer}` }),
        JSON.stringify({ cfg: { privateKey: SECRETS.barehex, apiKey: SECRETS.jsonKv } }),
        JSON.stringify({ role: "assistant", content: "the key idea is simple" }),
        JSON.stringify({ role: "assistant", content: 'key: "user:42" survives' }),
        JSON.stringify({ role: "assistant", content: "step 1 done, tests pass." }),
      ].join("\n"),
    )
    process.env.FAKE_MODEL_STDIN_LOG = stdinLogPath
    const r = await compileCheckpoint({ ...base, transcriptPath, model: fake("good") })
    expect(r.ok).toBe(true)

    const stdin = fs.readFileSync(stdinLogPath, "utf8")
    expect(stdin).toContain("[REDACTED]")
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(stdin.includes(secret), `${name} secret leaked into extractor stdin`).toBe(false)
    }
    // "hunter2" is a substring of both env-secret values — belt and braces
    expect(stdin.includes("hunter2"), "env-assignment secret leaked").toBe(false)
    expect(stdin).toContain("API_KEY=[REDACTED]")
    // non-secret sentences must pass through unscathed
    expect(stdin).toContain("the key idea is simple")
    expect(stdin).toContain("user:42")
  })
})
