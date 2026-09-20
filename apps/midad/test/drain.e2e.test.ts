import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  MidaHome, Runtime, approve, drainOnce, enqueue, init, listJobs, readCheckpoints, removeJob, requestAccess,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const PROJECT_ID = "proj-drain"
const T0 = Date.parse("2026-09-21T10:00:00.000Z")

/**
 * The drainer on local Anvil: every `it` runs in order and shares one owner, one home and one approved agent.
 * `compile` is a stub that returns a valid checkpoint carrying the `eventId` it was given (or fails when told
 * to), and `clock` is a hand-moved millisecond time so the save-gap cases are deterministic.
 */
describe("M1 drainOnce on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let homeDir: string
  let workDir: string
  let transcriptPath: string
  let clock = T0
  let compileCalls: CompileInput[] = []
  let compileFails = false

  const open = () => Runtime.open(home, network)

  const compile = async (input: CompileInput): Promise<CompileResult> => {
    compileCalls.push(input)
    if (compileFails) return { ok: false, reason: "model-failed", detail: "exit 3", attempts: 3 }
    return {
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
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

  const drain = () => drainOnce({ home, open, compile, now: () => new Date(clock), homeDir })

  const job = (over: Record<string, unknown> = {}) => enqueue(home, {
    agent: "claude-code",
    event: "Stop",
    sessionId: "s1",
    transcriptPath,
    cwd: workDir,
    error: null,
    ...over,
  } as Parameters<typeof enqueue>[1], () => new Date(clock))

  const readBack = async () => {
    const runtime = await open()
    try {
      return await readCheckpoints(runtime, "claude-code", PROJECT_ID)
    } finally {
      await runtime.close()
    }
  }

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-drain-")))
    const runtime = await open()
    try {
      await init(runtime, ["claude-code"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code")
    } finally {
      await runtime.close()
    }
    workDir = mkdtempSync(join(tmpdir(), "mida-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))
    // the transcript lives where the drainer expects a claude-code session file: the injected
    // "user home" folder's .claude/projects/, not the work folder
    homeDir = mkdtempSync(join(tmpdir(), "mida-userhome-"))
    mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
    transcriptPath = join(homeDir, ".claude", "projects", "proj", "transcript.jsonl")
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "Build a rate limiter" } }) + "\n")
  }, STEP_TIMEOUT * 2)

  afterAll(async () => {
    await env?.stop()
  })

  it("(a) init left network.json for the drainer, and one Stop job compiles and saves on chain", async () => {
    const storedNet = home.readJson<{ chainId: number; rpcUrl: string; deployment: { chainId: string } }>("network.json")
    expect(storedNet?.rpcUrl).toBe(network.rpcUrl)
    expect(storedNet?.chainId).toBe(Number(network.deployment.chainId))
    expect(BigInt(storedNet!.deployment.chainId)).toBe(network.deployment.chainId)

    job()
    const result = await drain()
    expect(result).toMatchObject({ saved: 1, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
    expect(compileCalls).toHaveLength(1)
    const { checkpoints } = await readBack()
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ sessionId: "s1", projectId: PROJECT_ID })
    expect(checkpoints[0]!.checkpoint.eventId).toBe(compileCalls[0]!.eventId)
    expect(checkpoints[0]!.checkpoint.eventId).toMatch(/^cp-[0-9a-f]{40}$/)
  }, STEP_TIMEOUT)

  it("(b) a new job over an unchanged transcript skips without touching the chain", async () => {
    job({ event: "PostToolUse" })
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 1, skippedTooSoon: 0, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
    expect((await readBack()).checkpoints).toHaveLength(1)
  }, STEP_TIMEOUT)

  it("(c) a grown transcript inside the save gap waits, and keeps the job", async () => {
    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "did step 1" }] } }) + "\n")
    job({ event: "PostToolUse" })
    clock += 5_000
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 1, failed: 0 })
    expect(listJobs(home)).toHaveLength(1)
  }, STEP_TIMEOUT)

  it("(d) a flush event ignores the gap and saves the grown transcript", async () => {
    job({ event: "Stop" })
    const result = await drain()
    expect(result).toMatchObject({ saved: 1, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
    expect((await readBack()).checkpoints).toHaveLength(2)
  }, STEP_TIMEOUT)

  it("(e) a compile failure keeps the job, counts it failed, and sends nothing", async () => {
    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "did step 2" }] } }) + "\n")
    job({ event: "Stop" })
    compileFails = true
    const result = await drain()
    compileFails = false
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 1 })
    expect(listJobs(home)).toHaveLength(1)
    expect((await readBack()).checkpoints).toHaveLength(2)
  }, STEP_TIMEOUT)

  it("(f) a job from a folder with no .mida/project.json is removed, nothing saved", async () => {
    for (const leftover of listJobs(home)) removeJob(home, leftover.id)
    const nowhere = mkdtempSync(join(tmpdir(), "mida-noproj-"))
    job({ sessionId: "s-noproj", cwd: nowhere })
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("not-a-project")
    expect((await readBack()).checkpoints).toHaveLength(2)
  }, STEP_TIMEOUT)

  it("(g) three jobs for one session are compiled once, the newest carrying the work", async () => {
    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "did step 3" }] } }) + "\n")
    for (let i = 0; i < 3; i += 1) {
      enqueue(home, {
        agent: "claude-code",
        event: i === 2 ? "Stop" : "PostToolUse",
        sessionId: "s2",
        transcriptPath,
        cwd: workDir,
        error: null,
      }, () => new Date(clock + i))
    }
    const before = compileCalls.length
    const result = await drain()
    expect(result).toMatchObject({ saved: 1, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(compileCalls.length - before).toBe(1)
    expect(compileCalls.at(-1)!.transcriptPath).toBe(transcriptPath)
    expect(listJobs(home)).toHaveLength(0)
    expect((await readBack()).checkpoints).toHaveLength(3)
  }, STEP_TIMEOUT)

  it("(h) a job whose transcript is gone moves to queue/bad without counting as a failure", async () => {
    const ghost = job({ sessionId: "s3", transcriptPath: join(workDir, "deleted.jsonl") })
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(home.has(`queue/bad/${ghost.id}.json`)).toBe(true)
    expect(listJobs(home)).toHaveLength(0)
  }, STEP_TIMEOUT)

  it("(i) an agent the owner never approved saves nothing — and approving does not retro-save", async () => {
    const runtime = await open()
    try {
      await init(runtime, ["codex"])   // registered, but the owner never approves it
    } finally {
      await runtime.close()
    }
    const before = compileCalls.length
    job({ agent: "codex", sessionId: "s-codex" })
    const result = await drain()
    expect(result.saved).toBe(0)
    expect(result.failed).toBe(0)
    expect(compileCalls.length).toBe(before)            // no model call for an unapproved agent
    expect(listJobs(home)).toHaveLength(0)              // the job is gone, not kept
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("not-approved")

    const runtime2 = await open()
    try {
      await requestAccess(runtime2, "codex")
      await approve(runtime2, "codex")
    } finally {
      await runtime2.close()
    }
    // the dropped job was not kept, so nothing from before approval is saved — a grown
    // transcript on a new job is what saves
    appendFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "codex step" }] } }) + "\n")
    job({ agent: "codex", sessionId: "s-codex" })
    const after = await drain()
    expect(after.saved).toBe(1)
    expect((await readBack()).checkpoints.some((c) => c.sessionId === "s-codex")).toBe(true)
  }, STEP_TIMEOUT * 2)

  it("a job older than a day is moved to queue/bad without work", async () => {
    const stale = enqueue(home, {
      agent: "claude-code",
      event: "Stop",
      sessionId: "s4",
      transcriptPath,
      cwd: workDir,
      error: null,
    }, () => new Date(clock - 25 * 60 * 60 * 1000))
    const before = compileCalls.length
    const result = await drain()
    expect(result).toMatchObject({ saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0 })
    expect(compileCalls.length).toBe(before)
    expect(home.has(`queue/bad/${stale.id}.json`)).toBe(true)
    expect(listJobs(home)).toHaveLength(0)
  }, STEP_TIMEOUT)
})
