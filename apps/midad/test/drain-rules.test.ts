import { describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { CompileInput, compileCheckpoint } from "@mida/compiler"
import type { Checkpoint } from "@mida/checkpoint"
import { MidaHome, drainOnce, drainerEnv, drainUntilSettled, enqueue, listJobs, tailOf } from "@mida/midad"
import type { Runtime, saveCheckpoint } from "@mida/midad"
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
    if (flags.compileReason !== undefined) return { ok: false, reason: flags.compileReason, detail: "stub", attempts: 1 }
    return {
      ok: true,
      checkpoint: flags.checkpoint ?? sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
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
  const job = (over: Record<string, unknown> = {}, at = T0) =>
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath, cwd, error: null, ...over }, () => new Date(at))
  const drain = (over: Record<string, unknown> = {}) =>
    drainOnce({ home, open, compile, save, homeDir, isApproved: async () => true, now: () => new Date(T0 + 120_000), ...over })
  const drainLog = () => readFileSync(home.path("logs/drain.jsonl"), "utf8")
  return { dir, home, homeDir, transcriptPath, cwd, compileCalls, saveCalls, flags, compile, save, open, job, drain, drainLog }
}

describe("the drainer re-checks transcript paths before trusting them", () => {
  it("a queued job naming a non-transcript file goes to queue/bad with bad-transcript-path", async () => {
    const { home, homeDir, cwd, compile, open } = setup()
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/etc/hosts", cwd, error: null })
    await drainOnce({ home, open, compile, homeDir })
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("a transcript swapped for a symlink after enqueue is rejected at drain time", async () => {
    const { home, homeDir, cwd, transcriptPath, compile, open } = setup()
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath, cwd, error: null })
    unlinkSync(transcriptPath)
    symlinkSync("/etc/hosts", transcriptPath)
    await drainOnce({ home, open, compile, homeDir })
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("a transcript in an unknown format is never sent to the model", async () => {
    const { home, homeDir, cwd, compileCalls, compile, open } = setup()
    const weird = join(homeDir, ".claude", "projects", "proj", "weird.jsonl")
    writeFileSync(weird, "this is not a jsonl transcript\nneither is this\n")
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: weird, cwd, error: null })
    await drainOnce({ home, open, compile, homeDir })
    expect(compileCalls).toHaveLength(0)
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("unknown-transcript-format")
  })
})

describe("one drainer at a time", () => {
  it("a live drain.lock makes a second drainer return at once, without compiling", async () => {
    const { home, job, drain, compileCalls } = setup()
    job()
    // the lock file is written in the drainer's own clock so the age check is exact
    home.writeSecretJson("queue/drain.lock", { pid: process.pid, startedAt: new Date(T0 + 120_000).toISOString() })
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(compileCalls).toHaveLength(0)
    expect(listJobs(home)).toHaveLength(1) // the job waits for the live drainer, nothing lost
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

  it("a checkpoint the compiler calls invalid is removed with invalid-checkpoint", async () => {
    const { home, job, drain, flags, drainLog } = setup()
    flags.compileReason = "invalid"
    job({ event: "Stop" }, T0)
    const result = await drain({ now: () => new Date(T0 + 120_000) })
    expect(result).toMatchObject({ saved: 0, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
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

describe("drainUntilSettled waits out the gap instead of stranding the job", () => {
  it("sleeps until the held-back job is due, then saves it — all under one lock", async () => {
    const { home, job, compile, save, open, homeDir, compileCalls, saveCalls } = setup()
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
      home, open, compile, save, homeDir, isApproved: async () => true, now: () => new Date(clock), sleep,
    })
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(50_000)   // about 55 s remained of the 60 s gap
    expect(sleeps[0]).toBeLessThanOrEqual(65_000)
    expect(result.saved).toBe(1)
    expect(compileCalls).toHaveLength(1)
    expect(saveCalls).toHaveLength(1)
    expect(listJobs(home)).toHaveLength(0)
    expect(home.has("queue/drain.lock")).toBe(false)
  })

  it("gives up after three waits so a doomed queue cannot loop forever", async () => {
    const { home, job, compile, save, open, homeDir } = setup()
    job({ event: "PostToolUse" }, T0)
    const sleeps: number[] = []
    // the clock never moves — the job stays too soon forever
    const result = await drainUntilSettled({
      home, open, compile, save, homeDir, isApproved: async () => true,
      now: () => new Date(T0 + 5_000), sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(sleeps.length).toBeLessThanOrEqual(3)
    expect(result.saved).toBe(0)
    expect(listJobs(home)).toHaveLength(1)      // the job survives for the next drainer
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
  it("drops the Anthropic credentials from the spawned environment", () => {
    const env = drainerEnv({ ...process.env, ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "tok" })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH)
  })
})
