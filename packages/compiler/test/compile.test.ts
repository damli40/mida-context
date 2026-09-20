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
  delete process.env.FAKE_MODEL_MODE
  delete process.env.FAKE_MODEL_COUNTER
  delete process.env.FAKE_MODEL_STDIN_LOG
  delete process.env.FAKE_MODEL_ENV_LOG
  delete process.env.FAKE_MODEL_PID_LOG
})

describe("compileCheckpoint", () => {
  it("stores the user's request by code and drops the model's own originalRequest", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("extra") })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checkpoint.originalRequest).toBe("Build a rate limiter in 3 steps")
      expect([...r.droppedKeys].sort()).toEqual(["confidence", "notes", "originalRequest"])
      expect(r.checkpoint.source).toBe("hook-compiler")
      expect(r.compiledBy).toBe("fake")
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
  it("does not retry output that parsed but failed validation", async () => {
    const r = await compileCheckpoint({ ...base, model: fake("badshape"), sleep: async () => {} })
    expect(r).toMatchObject({ ok: false, reason: "invalid", attempts: 1 })
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
  it("never passes ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to the model, and sets MIDA_INNER=1", async () => {
    process.env.ANTHROPIC_API_KEY = "test-value-a"; process.env.ANTHROPIC_AUTH_TOKEN = "test-value-b"
    process.env.FAKE_MODEL_ENV_LOG = envLogPath
    await compileCheckpoint({ ...base, model: fake("good") })
    const names = fs.readFileSync(envLogPath, "utf8").split("\n")
    expect(names).not.toContain("ANTHROPIC_API_KEY")
    expect(names).not.toContain("ANTHROPIC_AUTH_TOKEN")
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
