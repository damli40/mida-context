import { describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { CompileInput, compileCheckpoint } from "@mida/compiler"
import type { Checkpoint } from "@mida/checkpoint"
import { MidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { MidaHome, buildHandoff, drainOnce, drainerEnv, drainUntilSettled, enqueue, listJobs, markRevoked, projectIdFor, tailOf } from "@mida/midad"
import type { DrainDeps, Runtime, saveCheckpoint } from "@mida/midad"
import { CONTENT_FIELDS, mergeCheckpoints } from "@mida/checkpoint"
import { sampleCheckpoint } from "./helpers.js"

const T0 = Date.parse("2026-09-21T10:00:00.000Z")

/**
 * Drain-rule tests that never reach the chain: `open` returns a stub runtime and `save` records
 * what it is given. `homeDir` stands in for the user's real home; transcripts live under its
 * `.claude/projects/` exactly as Claude Code writes them.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mida-drainrules-"))
  const home = new MidaHome(join(dir, "mida"))
  const homeDir = join(dir, "user-home")
  mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
  const transcriptPath = join(homeDir, ".claude", "projects", "proj", "t.jsonl")
  writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
  const cwd = join(dir, "work")
  mkdirSync(join(cwd, ".mida"), { recursive: true })
  writeFileSync(join(cwd, ".mida", "project.json"), JSON.stringify({ projectId: "p-1" }))
  const compileCalls: CompileInput[] = []
  const saveCalls: unknown[] = []
  const flags: { saveFailures: number; checkpoint?: Checkpoint; compileReason?: "model-failed" | "no-json" | "invalid" } = { saveFailures: 0 }
  const compile: typeof compileCheckpoint = async (input) => {
    compileCalls.push(input)
    if (flags.compileReason !== undefined) return { ok: false, reason: flags.compileReason, detail: "stub", attempts: 1, retried: 0 }
    return {
      ok: true,
      checkpoint: flags.checkpoint ?? sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      retried: 0,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    }
  }
  const save: typeof saveCheckpoint = async (_runtime, _name, input) => {
    saveCalls.push(input)
    if (flags.saveFailures > 0) {
      flags.saveFailures -= 1
      throw new Error("rpc unreachable")
    }
    return { contextId: `0x${"ab".repeat(32)}`, transactionHash: null, milliseconds: 1, duplicate: false }
  }
  const open = async (): Promise<Runtime> => ({ close: async () => {} }) as unknown as Runtime
  // the owner-signed list is exercised for real in projects.test.ts / the e2e files; here the stub
  // keeps these tests on the drain rules: a marked folder is approved, an unmarked one is not
  const checkProject: NonNullable<DrainDeps["checkProject"]> = async (input) => {
    const projectId = projectIdFor(input.cwd)
    return projectId === null
      ? { ok: false, reason: "not-a-project" }
      : { ok: true, approval: { agent: input.agent, projectId, root: input.cwd, approvedAt: "2026-09-21T00:00:00.000Z" } }
  }
  const job = (over: Record<string, unknown> = {}, at = T0) =>
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath, cwd, error: null, ...over }, () => new Date(at))
  const drain = (over: Record<string, unknown> = {}) =>
    drainOnce({ home, open, compile, save, homeDir, checkProject, isApproved: async () => true, now: () => new Date(T0 + 120_000), ...over })
  const drainLog = () => readFileSync(home.path("logs/drain.jsonl"), "utf8")
  return { dir, home, homeDir, transcriptPath, cwd, compileCalls, saveCalls, flags, compile, save, open, checkProject, job, drain, drainLog }
}

describe("the drainer re-checks transcript paths before trusting them", () => {
  it("a queued job naming a non-transcript file goes to queue/bad with bad-transcript-path", async () => {
    const { home, homeDir, cwd, compile, open, checkProject } = setup()
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/etc/hosts", cwd, error: null })
    await drainOnce({ home, open, compile, homeDir, checkProject })
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("a transcript swapped for a symlink after enqueue is rejected at drain time", async () => {
    const { home, homeDir, cwd, transcriptPath, compile, open, checkProject } = setup()
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath, cwd, error: null })
    unlinkSync(transcriptPath)
    symlinkSync("/etc/hosts", transcriptPath)
    await drainOnce({ home, open, compile, homeDir, checkProject })
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("a transcript in an unknown format is never sent to the model", async () => {
    const { home, homeDir, cwd, compileCalls, compile, open, checkProject } = setup()
    const weird = join(homeDir, ".claude", "projects", "proj", "weird.jsonl")
    writeFileSync(weird, "this is not a jsonl transcript\nneither is this\n")
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: weird, cwd, error: null })
    await drainOnce({ home, open, compile, homeDir, checkProject })
    expect(compileCalls).toHaveLength(0)
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("unknown-transcript-format")
  })
})

describe("the transcript's own record of where it ran must agree with the project", () => {
  it("lines that record a different marked project's folder refuse with transcript-project-mismatch", async () => {
    const { dir, home, transcriptPath, cwd, job, drain, compileCalls, saveCalls, drainLog } = setup()
    // a second marked folder belonging to a different project than the job's cwd (p-1)
    const other = join(dir, "other-work")
    mkdirSync(join(other, ".mida"), { recursive: true })
    writeFileSync(join(other, ".mida", "project.json"), JSON.stringify({ projectId: "p-2" }))
    // the job claims the session ran in p-1's folder; the transcript itself says it ran in p-2's
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", cwd: other, message: { content: "work on the other project" } }) + "\n" +
        JSON.stringify({ type: "assistant", cwd: other, message: { content: [{ type: "text", text: "done" }] } }) + "\n",
    )
    const queued = job({ event: "Stop" }, T0)
    const result = await drain()
    expect(result.saved).toBe(0)
    expect(compileCalls).toHaveLength(0)
    expect(saveCalls).toHaveLength(0)
    expect(home.has(`queue/bad/${queued.id}.json`)).toBe(true)
    expect(listJobs(home)).toHaveLength(0)
    expect(drainLog()).toContain('"reason":"transcript-project-mismatch"')
  })

  it("lines recording folders inside the same project still save", async () => {
    const { transcriptPath, cwd, job, drain, saveCalls } = setup()
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", cwd, message: { content: "work on this" } }) + "\n" +
        JSON.stringify({ type: "assistant", cwd: join(cwd, "sub"), message: { content: [{ type: "text", text: "done" }] } }) + "\n",
    )
    job({ event: "Stop" }, T0)
    expect((await drain()).saved).toBe(1)
    expect(saveCalls).toHaveLength(1)
  })

  it("a recorded folder with no project marker above it does not refuse the save", async () => {
    const { dir, transcriptPath, job, drain, saveCalls } = setup()
    const nowhere = join(dir, "unmarked")
    mkdirSync(nowhere)
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", cwd: nowhere, message: { content: "hi" } }) + "\n")
    job({ event: "Stop" }, T0)
    expect((await drain()).saved).toBe(1)
    expect(saveCalls).toHaveLength(1)
  })
})

describe("one drainer at a time", () => {
  it("a live drain.lock makes a second drainer return at once, without compiling — and it says so (C4)", async () => {
    const { home, job, drain, compileCalls, drainLog } = setup()
    job()
    // the lock file is written in the drainer's own clock so the age check is exact
    home.writeSecretJson("queue/drain.lock", { pid: process.pid, startedAt: new Date(T0 + 120_000).toISOString() })
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(result.lockHeld).toBe(true)
    // a held lock is logged as lock-held — not as a "pass" that read the queue and found nothing
    expect(drainLog()).toContain('"outcome":"lock-held"')
    expect(drainLog()).not.toContain('"outcome":"pass"')
    expect(compileCalls).toHaveLength(0)
    expect(listJobs(home)).toHaveLength(1) // the job waits for the live drainer, nothing lost
    home.remove("queue/drain.lock")
  })

  it("drainUntilSettled reports a held lock the same way", async () => {
    const { home, job, compile, open, homeDir, drainLog, checkProject } = setup()
    job({ event: "Stop" }, T0)
    home.writeSecretJson("queue/drain.lock", { pid: process.pid, startedAt: new Date(T0 + 120_000).toISOString() })
    const result = await drainUntilSettled({
      home, open, compile, homeDir, checkProject, isApproved: async () => true, now: () => new Date(T0 + 120_000), sleep: async () => {},
    })
    expect(result.lockHeld).toBe(true)
    expect(drainLog()).toContain('"outcome":"lock-held"')
    home.remove("queue/drain.lock")
  })

  it("a drain.lock held by a dead process is taken over", async () => {
    const { home, job, drain, compileCalls } = setup()
    job()
    const dead = spawnSync(process.execPath, ["-e", "0"])
    home.writeSecretJson("queue/drain.lock", { pid: dead.pid, startedAt: new Date(T0 + 120_000).toISOString() })
    const result = await drain()
    expect(result.saved).toBe(1)
    expect(compileCalls).toHaveLength(1)
    expect(home.has("queue/drain.lock")).toBe(false) // released on the way out
  })

  it("a drain.lock older than ten minutes is stale even while its pid lives", async () => {
    const { home, job, drain, compileCalls } = setup()
    job()
    home.writeSecretJson("queue/drain.lock", { pid: process.pid, startedAt: new Date(T0 + 120_000 - 11 * 60_000).toISOString() })
    const result = await drain()
    expect(result.saved).toBe(1)
    expect(compileCalls).toHaveLength(1)
    expect(home.has("queue/drain.lock")).toBe(false)
  })

  it("a save written by the fallback model logs who wrote it and why (R5-8)", async () => {
    const { job, drain, drainLog } = setup()
    job()
    const compile: typeof compileCheckpoint = async (input) => ({
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "claude-haiku",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      retried: 0,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
      fellBack: { from: "kimi-k2.7-code-highspeed", to: "claude-haiku", reason: "exit 1 — kimi http 429" },
    })
    expect((await drain({ compile })).saved).toBe(1)
    const savedLine = drainLog().split("\n").find((line) => line.includes('"outcome":"saved"'))
    expect(savedLine).toBeDefined()
    expect(savedLine).toContain("kimi http 429")
    expect(savedLine).toContain("claude-haiku")
  })
})

describe("a first save waits one gap after the session's first event", () => {
  it("three PostToolUse jobs with no state are too soon five seconds in", async () => {
    const { home, job, drain, compileCalls } = setup()
    job({ event: "PostToolUse" }, T0)
    job({ event: "PostToolUse" }, T0 + 1_000)
    job({ event: "PostToolUse" }, T0 + 2_000)
    const result = await drain({ now: () => new Date(T0 + 5_000) })
    expect(compileCalls).toHaveLength(0)
    expect(result).toMatchObject({ saved: 0, skippedTooSoon: 1, failed: 0 })
    expect(listJobs(home)).toHaveLength(1)
  })

  it("the same jobs save once the gap has passed", async () => {
    const { home, job, drain, compileCalls, saveCalls } = setup()
    job({ event: "PostToolUse" }, T0)
    job({ event: "PostToolUse" }, T0 + 1_000)
    job({ event: "PostToolUse" }, T0 + 2_000)
    const result = await drain({ now: () => new Date(T0 + 61_000) })
    expect(compileCalls).toHaveLength(1)
    expect(result).toMatchObject({ saved: 1, skippedTooSoon: 0, failed: 0 })
    expect(saveCalls).toHaveLength(1)
    expect(listJobs(home)).toHaveLength(0)
  })

  it("a flush event still saves at once with no prior state", async () => {
    const { job, drain, compileCalls } = setup()
    job({ event: "Stop" }, T0)
    const result = await drain({ now: () => new Date(T0 + 5_000) })
    expect(compileCalls).toHaveLength(1)
    expect(result.saved).toBe(1)
  })
})

describe("the first save lands about ten seconds in, later saves keep the minute gap (R5-2)", () => {
  it("a session with no savedAt is due at +10 s, and the earliest-due report says so", async () => {
    const { job, drain, compileCalls, saveCalls } = setup()
    job({ event: "PostToolUse" }, T0)
    const tooSoon = await drain({ now: () => new Date(T0 + 9_000) })
    expect(tooSoon).toMatchObject({ saved: 0, skippedTooSoon: 1 })
    expect(tooSoon.earliestDueMs).toBe(T0 + 10_000)
    expect(compileCalls).toHaveLength(0)
    const due = await drain({ now: () => new Date(T0 + 11_000) })
    expect(due.saved).toBe(1)
    expect(compileCalls).toHaveLength(1)
    expect(saveCalls).toHaveLength(1)
  })

  it("the settle pass sleeps the short gap, so the first save is attempted inside 12 s (fake clock)", async () => {
    const { home, job, compile, save, open, homeDir, compileCalls, saveCalls, checkProject } = setup()
    job({ event: "PostToolUse" }, T0)
    let clock = T0 + 5_000
    const sleeps: number[] = []
    const result = await drainUntilSettled({
      home, open, compile, save, homeDir, checkProject, isApproved: async () => true,
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[0]).toBeLessThanOrEqual(10_000)
    expect(result.saved).toBe(1)
    // the save was attempted inside 12 s of the first event — the 15 s daemon tick never hid the gap
    expect(clock).toBeLessThanOrEqual(T0 + 12_000)
    expect(compileCalls).toHaveLength(1)
    expect(saveCalls).toHaveLength(1)
  })

  it("the second save still waits the full 60 s after the first", async () => {
    const { transcriptPath, job, drain, compileCalls, saveCalls } = setup()
    job({ event: "PostToolUse" }, T0)
    expect((await drain({ now: () => new Date(T0 + 11_000) })).saved).toBe(1)
    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "more" }] } }) + "\n")
    job({ event: "PostToolUse" }, T0 + 20_000)
    const tooSoon = await drain({ now: () => new Date(T0 + 21_000) })
    expect(tooSoon.skippedTooSoon).toBe(1)
    // savedAt was written at T0+11 s — the next save is due at +60 s from there, not +10 s
    expect(tooSoon.earliestDueMs).toBe(T0 + 71_000)
    const due = await drain({ now: () => new Date(T0 + 72_000) })
    expect(due.saved).toBe(1)
    expect(compileCalls).toHaveLength(2)
    expect(saveCalls).toHaveLength(2)
  })

  it("a failed first save follows the existing backoff, not the short gap", async () => {
    const { job, drain, flags, saveCalls } = setup()
    job({ event: "PostToolUse" }, T0)
    flags.saveFailures = 1
    const failed = await drain({ now: () => new Date(T0 + 11_000) })
    expect(failed).toMatchObject({ saved: 0, failed: 1 })
    expect(saveCalls).toHaveLength(1)
    // 19 s after the failure the 10 s gap is long past — only the 120 s backoff still holds it
    const held = await drain({ now: () => new Date(T0 + 30_000) })
    expect(held).toMatchObject({ saved: 0, failed: 0, skippedTooSoon: 1 })
    expect(saveCalls).toHaveLength(1)
    const retried = await drain({ now: () => new Date(T0 + 132_000) })
    expect(retried.saved).toBe(1)
    expect(saveCalls).toHaveLength(2)
  })
})

describe("a failed save does not buy a new model call", () => {
  it("the retry after the backoff reuses the compiled envelope — the compile stub runs once", async () => {
    const { home, job, drain, compileCalls, saveCalls, flags } = setup()
    job({ event: "Stop" }, T0)
    flags.saveFailures = 1
    const failed = await drain({ now: () => new Date(T0 + 120_000) })
    expect(failed).toMatchObject({ saved: 0, failed: 1 })
    expect(compileCalls).toHaveLength(1)
    expect(saveCalls).toHaveLength(1)
    // inside the backoff window the session waits — no compile, no save
    const held = await drain({ now: () => new Date(T0 + 120_000 + 60_000) })
    expect(held).toMatchObject({ saved: 0, failed: 0, skippedTooSoon: 1 })
    expect(compileCalls).toHaveLength(1)
    expect(saveCalls).toHaveLength(1)
    expect(listJobs(home)).toHaveLength(1)
    // past the backoff (attempt 1 → 120 s) the save runs again on the cached envelope
    const retried = await drain({ now: () => new Date(T0 + 120_000 + 121_000) })
    expect(retried).toMatchObject({ saved: 1, failed: 0 })
    expect(compileCalls).toHaveLength(1)   // the model was not called again
    expect(saveCalls).toHaveLength(2)
    expect(listJobs(home)).toHaveLength(0)
  })

  it("eight failed attempts give up: the job goes to queue/bad with gave-up", async () => {
    const { home, job, drain, compileCalls, saveCalls, flags, drainLog } = setup()
    job({ event: "Stop" }, T0)
    flags.saveFailures = 100
    for (let i = 0; i < 8; i += 1) {
      // each drain runs far past any backoff so the retry always fires
      await drain({ now: () => new Date(T0 + 120_000 + i * 7_200_000) })
    }
    expect(saveCalls).toHaveLength(8)
    expect(compileCalls).toHaveLength(1)   // one compile, eight save attempts
    expect(listJobs(home)).toHaveLength(0)
    expect(drainLog()).toContain("gave-up")
  })

  it("a permanently-too-large envelope removes the job with too-large and is never recompiled", async () => {
    const { home, job, drain, compileCalls, flags, drainLog } = setup()
    flags.checkpoint = sampleCheckpoint({
      eventId: "cp-fat0000",
      originalRequest: "r".repeat(6000),
      remainingPlan: Array.from({ length: 50 }, () => "p".repeat(2000)),
    })
    job({ event: "Stop" }, T0)
    const result = await drain({ now: () => new Date(T0 + 120_000) })
    expect(result).toMatchObject({ saved: 0, failed: 0 })
    expect(compileCalls).toHaveLength(1)
    expect(listJobs(home)).toHaveLength(0)
    expect(drainLog()).toContain("too-large")
    // a new job over the same transcript state is skipped as unchanged — compile never runs again
    job({ event: "Stop" }, T0 + 200_000)
    const again = await drain({ now: () => new Date(T0 + 300_000) })
    expect(again).toMatchObject({ saved: 0, failed: 0 })
    expect(compileCalls).toHaveLength(1)
  })

  it("a save refused by the gas ceiling is transient: job stays, backoff applies, reason logged (R3-1)", async () => {
    const { home, job, drain, drainLog, compileCalls } = setup()
    let calls = 0
    const save: typeof saveCheckpoint = async () => {
      calls += 1
      if (calls === 1) throw new MidaError("GAS_CEILING_EXCEEDED", "context.register: estimate 700000 exceeds ceiling 650000")
      return { contextId: `0x${"cd".repeat(32)}`, transactionHash: null, milliseconds: 1, duplicate: false }
    }
    job({ event: "Stop" }, T0)
    const failed = await drain({ save, now: () => new Date(T0 + 120_000) })
    expect(failed).toMatchObject({ saved: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(1)
    expect(drainLog()).toContain('"reason":"gas-ceiling"')
    // inside the backoff window the job waits untouched
    const held = await drain({ save, now: () => new Date(T0 + 120_000 + 60_000) })
    expect(held).toMatchObject({ skippedTooSoon: 1, failed: 0 })
    // past the backoff the retry saves on the cached envelope — no second compile
    const retried = await drain({ save, now: () => new Date(T0 + 120_000 + 121_000) })
    expect(retried).toMatchObject({ saved: 1, failed: 0 })
    expect(compileCalls).toHaveLength(1)
    expect(calls).toBe(2)
  })

  it("a save refused CAPABILITY_REVOKED removes the job with reason revoked — permanent, distinct from not-approved (R4-3)", async () => {
    const { home, job, drain, drainLog, compileCalls } = setup()
    const save: typeof saveCheckpoint = async () => {
      throw new MidaError("CAPABILITY_REVOKED", "capability is revoked")
    }
    job({ event: "Stop" }, T0)
    const result = await drain({ save, now: () => new Date(T0 + 120_000) })
    expect(result).toMatchObject({ saved: 0, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
    expect(compileCalls).toHaveLength(1)
    expect(drainLog()).toContain('"reason":"revoked"')
    expect(drainLog()).not.toContain('"reason":"not-approved"')
  })

  it("a checkpoint the compiler calls invalid is retried, not dropped on the spot (C3)", async () => {
    const { home, job, drain, flags, drainLog } = setup()
    flags.compileReason = "invalid"
    job({ event: "Stop" }, T0)
    const result = await drain({ now: () => new Date(T0 + 120_000) })
    expect(result).toMatchObject({ saved: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(1)
    expect(drainLog()).toContain("invalid-checkpoint")
  })

  it("a compile that fails transiently keeps the job under the same backoff rule", async () => {
    const { home, job, drain, flags, drainLog } = setup()
    flags.compileReason = "model-failed"
    job({ event: "Stop" }, T0)
    const result = await drain({ now: () => new Date(T0 + 120_000) })
    expect(result).toMatchObject({ saved: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(1)
    expect(drainLog()).toContain("model-failed")
    // inside the backoff the job waits untouched
    const held = await drain({ now: () => new Date(T0 + 120_000 + 30_000) })
    expect(held).toMatchObject({ skippedTooSoon: 1, failed: 0 })
  })
})

describe("the owner-signed project list gates every save", () => {
  for (const reason of ["not-approved", "list-tampered", "list-unreadable", "check-failed", "folder-mismatch"] as const) {
    it(`a job refused with ${reason} is removed before any compile and never retried`, async () => {
      const { home, job, drain, compileCalls, saveCalls, drainLog } = setup()
      job({ event: "Stop" }, T0)
      const result = await drain({ checkProject: async () => ({ ok: false as const, reason }) })
      expect(result.failed).toBe(0)
      expect(compileCalls).toHaveLength(0)   // the model is never asked
      expect(saveCalls).toHaveLength(0)
      expect(listJobs(home)).toHaveLength(0) // permanent: the job is gone, not kept
      expect(drainLog()).toContain(`"reason":"${reason}"`)
    })
  }

  it("a job refused not-approved for a revoked agent logs revoked — the marker says why (R4-3)", async () => {
    const { home, job, drain, compileCalls, saveCalls, drainLog } = setup()
    markRevoked(home, "claude-code")
    job({ event: "Stop" }, T0)
    const result = await drain({ checkProject: async () => ({ ok: false as const, reason: "not-approved" as const }) })
    expect(result.failed).toBe(0)
    expect(compileCalls).toHaveLength(0)
    expect(saveCalls).toHaveLength(0)
    expect(listJobs(home)).toHaveLength(0)
    expect(drainLog()).toContain('"reason":"revoked"')
    expect(drainLog()).not.toContain('"reason":"not-approved"')
  })

  it("a chain-level refusal for a revoked agent also logs revoked, not not-approved (R4-3)", async () => {
    const { home, job, drain, drainLog } = setup()
    markRevoked(home, "claude-code")
    job({ event: "Stop" }, T0)
    await drain({ isApproved: async () => false })
    expect(drainLog()).toContain('"reason":"revoked"')
    expect(drainLog()).not.toContain('"reason":"not-approved"')
  })

  it("the default check answers not-a-project for a marker-less folder without opening a runtime", async () => {
    const { home, homeDir, open, compile } = setup()
    const nowhere = join(homeDir, "somewhere")
    mkdirSync(nowhere)
    enqueue(home, {
      agent: "claude-code", event: "Stop", sessionId: "s1",
      transcriptPath: join(homeDir, ".claude", "projects", "proj", "t.jsonl"), cwd: nowhere, error: null,
    })
    let opened = 0
    const result = await drainOnce({
      home, homeDir, compile,
      open: async () => { opened += 1; return open() },
    })
    expect(result).toMatchObject({ saved: 0, failed: 0 })
    expect(opened).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("not-a-project")
  })
})

describe("the saved-ids index lives outside the queue and survives every pass (CAP-25)", () => {
  it("three passes record three eventIds, and re-running the first event makes zero chain reads", async () => {
    const { home, homeDir, transcriptPath, cwd, compile, checkProject } = setup()
    // a stub "chain" that counts its reads: the index must answer the duplicate before any read
    let reads = 0
    let creates = 0
    const runtime = {
      home,
      owner: `0x${"11".repeat(20)}`,
      agent: () => ({
        read: async () => {
          reads += 1
          return []
        },
        create: async () => {
          creates += 1
          return { contextId: `0x${"cc".repeat(32)}` as Hex, transactionHash: null }
        },
      }),
      close: async () => {},
    } as unknown as Runtime
    // the real saveCheckpoint runs: the stub runtime's agent is what "the chain" means here
    const pass = () =>
      drainOnce({ home, runtime, compile, homeDir, checkProject, isApproved: async () => true, now: () => new Date(T0 + 120_000) })
    for (const sessionId of ["s1", "s2", "s3"]) {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId, transcriptPath, cwd, error: null })
      expect((await pass()).saved).toBe(1)
    }
    const index = home.readJson<Record<string, string>>("state/saved-ids.json") ?? {}
    expect(Object.keys(index)).toHaveLength(3)
    // the first session's job re-queued with no saved state compiles to the same eventId — a
    // post-crash retry — and the index must answer it without a chain read
    home.remove("queue/state/s1.json")
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath, cwd, error: null })
    const readsBefore = reads
    expect((await pass()).saved).toBe(1)
    expect(reads).toBe(readsBefore)
    expect(creates).toBe(3)
  })
})

describe("nothing is saved for an agent the owner has not approved", () => {
  it("an unapproved agent's jobs across sessions are removed before any compile", async () => {
    const { home, job, drain, compileCalls, saveCalls, drainLog } = setup()
    job({ event: "Stop" }, T0)
    job({ sessionId: "s2", event: "Stop" }, T0 + 1_000)
    const result = await drain({ isApproved: async () => false })
    expect(compileCalls).toHaveLength(0)
    expect(saveCalls).toHaveLength(0)
    expect(listJobs(home)).toHaveLength(0)
    expect(result.failed).toBe(0)
    expect(drainLog()).toContain("not-approved")
  })
})

describe("a handoff served to a new session becomes its continuesSession link", () => {
  it("save session A, serve a handoff to session B, save B — the merge reads A's original request", async () => {
    const { home, cwd, job, drain, saveCalls } = setup()

    // session A works and saves; nothing was served to it, so there is nothing to continue
    job({ sessionId: "sess-a", event: "Stop" }, T0)
    expect((await drain()).saved).toBe(1)
    expect((saveCalls[0] as { continuesSession: string | null }).continuesSession).toBeNull()

    // session B's start hook is served the handoff — the daemon records the chain head it merged
    const storedA = {
      checkpoint: sampleCheckpoint({ eventId: "cp-a1", originalRequest: "Port the billing engine" }),
      projectId: "p-1", sessionId: "sess-a", continuesSession: null, compiledBy: "test",
      contextId: `0x${"a1".repeat(32)}`, authorId: `0x${"aa".repeat(32)}`, namespaceId: `0x${"c1".repeat(32)}`,
    }
    const runtime = { home, close: async () => {} } as unknown as Runtime
    const handoff = await buildHandoff(runtime, { agent: "claude-code", cwd, sessionId: "sess-b", authorNames: {} }, {
      checkProject: async () => ({ ok: true, approval: { agent: "claude-code", projectId: "p-1", root: cwd, approvedAt: "2026-09-21T00:00:00.000Z" } }),
      capability: async () => "live",
      read: async () => ({ checkpoints: [storedA], skipped: 0, milliseconds: 1, partial: false }),
      readFacts: async () => [],
    })
    expect(handoff.kind).toBe("handoff")
    expect(home.readJson("state/continues/sess-b.json")).toEqual({ continues: "sess-a", projectId: "p-1" })

    // B's own saves carry the link: the drainer reads the record the handoff wrote
    job({ sessionId: "sess-b", event: "Stop" }, T0 + 1_000)
    expect((await drain({ now: () => new Date(T0 + 240_000) })).saved).toBe(1)
    const savedB = saveCalls[1] as { continuesSession: string | null; checkpoint: Checkpoint; projectId: string; sessionId: string; compiledBy: string }
    expect(savedB.continuesSession).toBe("sess-a")

    // merged, the chain leads with A's words — a tool switch never turns the request into "Continue."
    const storedB = { ...savedB, contextId: `0x${"b1".repeat(32)}`, authorId: `0x${"bb".repeat(32)}`, namespaceId: `0x${"c1".repeat(32)}` }
    expect(mergeCheckpoints([storedA, storedB])?.originalRequest).toBe("Port the billing engine")
  })

  it("a missing, unreadable or wrong-project record means null — never a guess", async () => {
    const { home, job, drain, saveCalls } = setup()
    // no record at all
    job({ sessionId: "sess-x", event: "Stop" }, T0)
    await drain()
    expect((saveCalls.at(-1) as { continuesSession: string | null }).continuesSession).toBeNull()
    // a record written for another project does not chain this session into it
    home.writeSecretJson("state/continues/sess-y.json", { continues: "sess-a", projectId: "p-other" })
    job({ sessionId: "sess-y", event: "Stop" }, T0 + 1_000)
    await drain()
    expect((saveCalls.at(-1) as { continuesSession: string | null }).continuesSession).toBeNull()
    // a corrupt record reads as missing, not as a link
    mkdirSync(home.path("state/continues"), { recursive: true })
    fs.writeFileSync(home.path("state/continues/sess-z.json"), "not json{")
    job({ sessionId: "sess-z", event: "Stop" }, T0 + 2_000)
    await drain()
    expect((saveCalls.at(-1) as { continuesSession: string | null }).continuesSession).toBeNull()
  })
})

describe("drainUntilSettled waits out the gap instead of stranding the job", () => {
  it("sleeps until the held-back job is due, then saves it — all under one lock", async () => {
    const { home, job, compile, save, open, homeDir, compileCalls, saveCalls, checkProject } = setup()
    job({ event: "PostToolUse" }, T0)
    let clock = T0 + 5_000
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
      clock += ms
      // while the lock is held a second drainer must see it: the file exists the whole time
      expect(home.has("queue/drain.lock")).toBe(true)
    }
    const result = await drainUntilSettled({
      home, open, compile, save, homeDir, checkProject, isApproved: async () => true, now: () => new Date(clock), sleep,
    })
    expect(sleeps).toHaveLength(1)
    // the first save owes only the 10 s first gap — about 5 s remained of it (R5-2)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[0]).toBeLessThanOrEqual(10_000)
    expect(result.saved).toBe(1)
    expect(compileCalls).toHaveLength(1)
    expect(saveCalls).toHaveLength(1)
    expect(listJobs(home)).toHaveLength(0)
    expect(home.has("queue/drain.lock")).toBe(false)
  })

  it("gives up after three waits so a doomed queue cannot loop forever", async () => {
    const { home, job, compile, save, open, homeDir, checkProject } = setup()
    job({ event: "PostToolUse" }, T0)
    const sleeps: number[] = []
    // the clock never moves — the job stays too soon forever
    const result = await drainUntilSettled({
      home, open, compile, save, homeDir, checkProject, isApproved: async () => true,
      now: () => new Date(T0 + 5_000), sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(sleeps.length).toBeLessThanOrEqual(3)
    expect(result.saved).toBe(0)
    expect(listJobs(home)).toHaveLength(1)      // the job survives for the next drainer
  })

  it("a job that lands mid-pass is not stranded: the settle run re-lists and saves it", async () => {
    const { home, job, save, open, homeDir, transcriptPath, compileCalls, saveCalls, checkProject } = setup()
    job({ event: "Stop" }, T0)
    // while the first compile runs the session grows and its Stop job lands — the pass already
    // listed the queue, so without a re-list this job sits until some later drain
    const compile: typeof compileCheckpoint = async (input) => {
      compileCalls.push(input)
      if (compileCalls.length === 1) {
        appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "more" }] } }) + "\n")
        job({ event: "Stop" }, T0 + 1_000)
      }
      return {
        ok: true, checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
        compiledBy: "stub", droppedKeys: [], trimmed: [], attempts: 1, retried: 0,
        format: "claude-jsonl", messagesKept: 1, messagesTotal: 1, charsSent: 0, modelMs: 0,
      }
    }
    const result = await drainUntilSettled({
      home, open, compile, save, homeDir, checkProject, isApproved: async () => true,
      now: () => new Date(T0 + 120_000), sleep: async () => {},
    })
    expect(result.saved).toBe(2)
    expect(compileCalls).toHaveLength(2)
    expect(saveCalls).toHaveLength(2)
    expect(listJobs(home)).toHaveLength(0)
  })

  it("an injected runtime is used for the save and is never closed by the drain", async () => {
    const { home, job, compile, save, homeDir, saveCalls, checkProject } = setup()
    job({ event: "Stop" }, T0)
    let closed = 0
    let opens = 0
    const runtime = { close: async () => { closed += 1 } } as unknown as Runtime
    const result = await drainUntilSettled({
      home, runtime, compile, save, homeDir, checkProject, isApproved: async () => true,
      open: async () => { opens += 1; return runtime },
      now: () => new Date(T0 + 120_000), sleep: async () => {},
    })
    expect(result.saved).toBe(1)
    expect(saveCalls).toHaveLength(1)
    expect(opens).toBe(0)
    expect(closed).toBe(0)
  })
})

describe("the transcript tail is read with one file descriptor and a bounded window", () => {
  it("a 20 MB transcript costs at most one 64 KB positioned read for its tail", async () => {
    const { homeDir, job, drain, compileCalls } = setup()
    // a claude-code transcript must live under homeDir/.claude/projects — make the big file there
    const transcript = join(homeDir, ".claude", "projects", "proj", "big.jsonl")
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "start" } }) + "\n")
    appendFileSync(transcript, " ".repeat(20 * 1024 * 1024))
    appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n")
    job({ transcriptPath: transcript, event: "Stop" }, T0)

    let bytesRead = 0
    const countingRead = (fd: number, buffer: Buffer, offset: number, length: number, position: number): number => {
      bytesRead += length
      return fs.readSync(fd, buffer, offset, length, position)
    }
    const tail = tailOf(transcript, countingRead)
    expect(tail.bytes).toBeGreaterThan(20 * 1024 * 1024)
    expect(tail.lastLine).toContain('"done"')
    expect(bytesRead).toBeLessThanOrEqual(131_072)

    const result = await drain()
    expect(result.saved).toBe(1)
    expect(compileCalls).toHaveLength(1)
  })
})

describe("each drain prunes dead weight", () => {
  it("drops week-old bad and compiled entries, hour-old temp files, and overgrown logs", async () => {
    const { home, drain } = setup()
    const drainNow = T0 + 120_000
    const stamp = (path: string, ageMs: number) => {
      const at = new Date(drainNow - ageMs)
      fs.utimesSync(home.path(path), at, at)
    }
    home.writeSecretJson("queue/bad/old.json", { note: "old" })
    home.writeSecretJson("queue/bad/fresh.json", { note: "fresh" })
    home.writeSecretJson("queue/compiled/cp-stale01.json", { note: "old" })
    home.writeSecretJson("queue/loose.tmp", { note: "old" })
    home.writeSecretJson("queue/recent.tmp", { note: "recent" })
    mkdirSync(home.path("logs"), { recursive: true })
    writeFileSync(home.path("logs/drain.jsonl"), `${"x".repeat(6 * 1024 * 1024)}\nlast\n`)
    stamp("queue/bad/old.json", 8 * 24 * 3600_000)
    stamp("queue/bad/fresh.json", 24 * 3600_000)
    stamp("queue/compiled/cp-stale01.json", 8 * 24 * 3600_000)
    stamp("queue/loose.tmp", 2 * 3600_000)
    stamp("queue/recent.tmp", 30 * 60_000)

    await drain()

    expect(home.has("queue/bad/old.json")).toBe(false)
    expect(home.has("queue/bad/fresh.json")).toBe(true)
    expect(home.has("queue/compiled/cp-stale01.json")).toBe(false)
    expect(home.has("queue/loose.tmp")).toBe(false)
    expect(home.has("queue/recent.tmp")).toBe(true)
    expect(fs.statSync(home.path("logs/drain.jsonl")).size).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe("the saved log line carries the compile and save facts (C4)", () => {
  const savedLines = (drainLog: () => string) =>
    drainLog().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.outcome === "saved")

  it("a fresh save logs compileMs, saveMs, attempts, reusedCompiled, trimmed and droppedKeys", async () => {
    const { job, drain, drainLog } = setup()
    job({ event: "Stop" }, T0)
    await drain({ now: () => new Date(T0 + 120_000) })
    const saved = savedLines(drainLog).at(-1)!
    expect(typeof saved.compileMs).toBe("number")
    expect(typeof saved.saveMs).toBe("number")
    expect(typeof saved.attempts).toBe("number")
    expect(saved.reusedCompiled).toBe(false)
    expect(Array.isArray(saved.trimmed)).toBe(true)
    expect(Array.isArray(saved.droppedKeys)).toBe(true)
  })

  it("a compile that reports provider cache numbers logs cacheHit/cacheMiss (M3-H)", async () => {
    const { job, drain, drainLog } = setup()
    const compile: typeof compileCheckpoint = async (input) => ({
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "deepseek-flash",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
      retried: 0,
      cacheHitTokens: 900,
      cacheMissTokens: 100,
    })
    job({ event: "Stop" }, T0)
    await drain({ compile })
    const saved = savedLines(drainLog).at(-1)!
    expect(saved.cacheHit).toBe(900)
    expect(saved.cacheMiss).toBe(100)
  })

  it("a saved line carries the model, its token usage and the save's gas facts (telemetry)", async () => {
    const { job, drain, drainLog } = setup()
    const compile: typeof compileCheckpoint = async (input) => ({
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "deepseek-flash",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
      retried: 0,
      inputTokens: 4000,
      outputTokens: 320,
    })
    const transactionHash = `0x${"ef".repeat(32)}` as Hex
    const save: typeof saveCheckpoint = async () => ({
      contextId: `0x${"ab".repeat(32)}` as Hex,
      transactionHash,
      milliseconds: 1,
      duplicate: false,
      receipt: { gasUsed: "81000", gasLimit: "120000", effectiveGasPrice: "50000000000", sponsored: true },
    })
    job({ event: "Stop" }, T0)
    await drain({ compile, save })
    const saved = savedLines(drainLog).at(-1)!
    expect(saved.model).toBe("deepseek-flash")
    expect(saved.inputTokens).toBe(4000)
    expect(saved.outputTokens).toBe(320)
    expect(saved.transactionHash).toBe(transactionHash)
    // gas values are wei as decimal STRINGS — a bigint must never reach JSON.stringify
    expect(saved.gasUsed).toBe("81000")
    expect(saved.gasLimit).toBe("120000")
    expect(saved.effectiveGasPrice).toBe("50000000000")
    expect(saved.sponsored).toBe(true)
  })

  it("a slow receipt read-back lands on receiptMs — saveMs stays the save's own time (telemetry)", async () => {
    const { job, drain, drainLog } = setup()
    // the fake clock stands still except where the stub moves it: 5 ms for the save itself,
    // then 250 ms inside its receipt read-back — the old wall-clock saveMs would report 255
    let clock = T0 + 120_000
    const save: typeof saveCheckpoint = async () => {
      clock += 5
      const milliseconds = clock - (T0 + 120_000)
      clock += 250
      return {
        contextId: `0x${"ab".repeat(32)}` as Hex,
        transactionHash: `0x${"ef".repeat(32)}` as Hex,
        milliseconds,
        duplicate: false,
        receiptMs: 250,
      }
    }
    job({ event: "Stop" }, T0)
    expect((await drain({ save, now: () => new Date(clock) })).saved).toBe(1)
    const saved = savedLines(drainLog).at(-1)!
    expect(saved.saveMs).toBe(5)
    expect(saved.receiptMs).toBe(250)
  })

  it("a duplicate save leaves every gas key off the record — no transaction was sent", async () => {
    const { job, drain, drainLog } = setup()
    const save: typeof saveCheckpoint = async () => ({
      contextId: `0x${"ab".repeat(32)}` as Hex,
      transactionHash: null,
      milliseconds: 1,
      duplicate: true,
    })
    job({ event: "Stop" }, T0)
    await drain({ save })
    const saved = savedLines(drainLog).at(-1)!
    expect(saved.transactionHash).toBeUndefined()
    expect(saved.gasUsed).toBeUndefined()
    expect(saved.gasLimit).toBeUndefined()
    expect(saved.effectiveGasPrice).toBeUndefined()
    expect(saved.sponsored).toBeUndefined()
    // no transaction means no read-back was attempted, so there is no receiptMs either
    expect(saved.receiptMs).toBeUndefined()
  })

  it("the saved line never carries checkpoint content — numbers and names only", async () => {
    const { job, drain, drainLog } = setup()
    const compile: typeof compileCheckpoint = async (input) => ({
      ok: true,
      checkpoint: sampleCheckpoint({
        eventId: input.eventId,
        agent: input.agent,
        objective: "MARKED-OBJECTIVE-7f3a must not be logged",
        nextAction: "MARKED-NEXT-9b2c must not be logged",
      }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
      retried: 0,
    })
    job({ event: "Stop" }, T0)
    await drain({ compile })
    const log = drainLog()
    const saved = savedLines(drainLog).at(-1)!
    expect(log).not.toContain("MARKED-OBJECTIVE-7f3a")
    expect(log).not.toContain("MARKED-NEXT-9b2c")
    expect(saved.checkpoint).toBeUndefined()
    expect(saved.objective).toBeUndefined()
    expect(saved.nextAction).toBeUndefined()
  })

  it("a compile that spent its same-provider shape retry logs retried (M3-H)", async () => {
    const { job, drain, drainLog } = setup()
    const compile: typeof compileCheckpoint = async (input) => ({
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "deepseek-flash",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      retried: 1,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    })
    job({ event: "Stop" }, T0)
    await drain({ compile })
    expect(savedLines(drainLog).at(-1)!.retried).toBe(1)
  })

  it("a compile that reports no cache numbers leaves the fields off the record", async () => {
    const { job, drain, drainLog } = setup()
    job({ event: "Stop" }, T0)
    await drain({ now: () => new Date(T0 + 120_000) })
    const saved = savedLines(drainLog).at(-1)!
    expect(saved.cacheHit).toBeUndefined()
    expect(saved.cacheMiss).toBeUndefined()
  })

  it("a save retried from the compiled cache logs reusedCompiled and the stored metrics", async () => {
    const { job, drain, flags, drainLog } = setup()
    job({ event: "Stop" }, T0)
    flags.saveFailures = 1
    await drain({ now: () => new Date(T0 + 120_000) })
    await drain({ now: () => new Date(T0 + 400_000) })
    const saved = savedLines(drainLog).at(-1)!
    expect(saved.reusedCompiled).toBe(true)
    expect(typeof saved.compileMs).toBe("number")
    expect(saved.attempts).toBe(1)
    expect(saved.trimmed).toEqual([])
    expect(saved.droppedKeys).toEqual([])
  })
})

describe("an invalid checkpoint is transient twice, then permanent (C3)", () => {
  it("two invalid compiles keep the job, the third drain saves, and the log names fields — never values", async () => {
    const { home, job, drain, drainLog } = setup()
    let n = 0
    const compile: typeof compileCheckpoint = async (input) => {
      n += 1
      if (n <= 2) {
        return {
          ok: false,
          reason: "invalid",
          detail: "decisions[3].rationale: expected string, got number; evidence: expected array",
          attempts: 1,
          retried: 0,
          fields: ["decisions[3].rationale", "evidence"],
        }
      }
      return {
        ok: true,
        checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
        compiledBy: "stub",
        droppedKeys: [],
        trimmed: [],
        attempts: 1,
        retried: 0,
        format: "claude-jsonl",
        messagesKept: 1,
        messagesTotal: 1,
        charsSent: 0,
        modelMs: 0,
      }
    }
    job({ event: "Stop" }, T0)
    const first = await drain({ compile, now: () => new Date(T0 + 120_000) })
    expect(first).toMatchObject({ saved: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(1)
    const second = await drain({ compile, now: () => new Date(T0 + 300_000) })
    expect(second).toMatchObject({ saved: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(1)
    const third = await drain({ compile, now: () => new Date(T0 + 800_000) })
    expect(third).toMatchObject({ saved: 1, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
    const log = drainLog()
    expect(log).toContain('"fields":["decisions[3].rationale","evidence"]')
    expect(log).not.toContain("expected string")   // field names, never validator messages
    expect(log).not.toContain("got number")        // and never values
  })

  it("a third invalid compile in a row is permanent: the job leaves with invalid-checkpoint", async () => {
    const { home, job, drain, drainLog } = setup()
    const compile: typeof compileCheckpoint = async () => ({
      ok: false, reason: "invalid", detail: "objective: must be non-empty", attempts: 1, retried: 0, fields: ["objective"],
    })
    job({ event: "Stop" }, T0)
    await drain({ compile, now: () => new Date(T0 + 120_000) })
    await drain({ compile, now: () => new Date(T0 + 300_000) })
    const third = await drain({ compile, now: () => new Date(T0 + 800_000) })
    // the third failure still counts as a failure — permanence is in the outcome, not the counter
    expect(third).toMatchObject({ saved: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(0)
    const log = drainLog()
    expect(log).toContain('"outcome":"bad"')
    expect(log).toContain("invalid-checkpoint")
    expect(log).toContain('"fields":["objective"]')
  })
})

describe("the drainer hands the session's previous checkpoint to the compiler (C2)", () => {
  it("a second drain of a grown transcript compiles with the first save's content fields as previous", async () => {
    const { home, transcriptPath, job, drain, compileCalls, flags } = setup()
    flags.checkpoint = sampleCheckpoint({ objective: "the first save's objective" })
    job({ event: "Stop" }, T0)
    await drain({ now: () => new Date(T0 + 120_000) })
    expect(compileCalls).toHaveLength(1)
    expect(compileCalls[0]!.previous).toBeUndefined()
    expect(home.has("queue/state/s1.last.json")).toBe(true)

    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "step 2" }] } }) + "\n")
    job({ event: "Stop" }, T0 + 200_000)
    await drain({ now: () => new Date(T0 + 300_000) })
    expect(compileCalls).toHaveLength(2)
    const previous = compileCalls[1]!.previous
    expect(previous).toBeDefined()
    // the file holds the ten content fields of the checkpoint that was actually saved —
    // never its ids, timestamps or the user's verbatim request
    const saved = flags.checkpoint
    for (const field of CONTENT_FIELDS) expect(previous![field]).toEqual(saved[field])
    expect(previous!.originalRequest).toBeNull()
  })

  it("a corrupt .last.json is ignored with a previous-unreadable log line, and the save still happens", async () => {
    const { home, job, drain, compileCalls, drainLog } = setup()
    home.writeSecretJson("queue/state/s1.last.json", { decisions: "not-an-array" })
    job({ event: "Stop" }, T0)
    const result = await drain({ now: () => new Date(T0 + 120_000) })
    expect(result.saved).toBe(1)
    expect(compileCalls[0]!.previous).toBeUndefined()
    expect(drainLog()).toContain("previous-unreadable")
  })
})

describe("a held midad.lock", () => {
  it("is a transient lock-timeout: the job stays queued for the retry", async () => {
    const { home, job, drain } = setup()
    job({ event: "Stop" }, T0)
    const result = await drain({
      open: async () => { throw new Error("another Mida process (pid 9) already holds this home") },
    })
    expect(result.failed).toBe(1)
    expect(listJobs(home)).toHaveLength(1)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("lock-timeout")
    expect(home.list("queue/bad")).toHaveLength(0)
  })
})

describe("the detached drainer never inherits agent-CLI secrets", () => {
  it("drops every ANTHROPIC_* variable from the spawned environment", () => {
    // Values are built by concatenation so no secret-shaped literal sits in the repo.
    const env = drainerEnv({
      ...process.env,
      ANTHROPIC_API_KEY: "sk-" + "ant-" + "x",
      ANTHROPIC_AUTH_TOKEN: "to" + "ken",
      ANTHROPIC_BASE_URL: "https" + "://" + "collector.invalid",
      ANTHROPIC_CUSTOM_HEADERS: "x-" + "forward",
      ANTHROPIC_FOO: "un" + "listed",
    })
    expect(Object.keys(env).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([])
    expect(env.PATH).toBe(process.env.PATH)
  })
})
