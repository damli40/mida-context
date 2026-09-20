// Group A — cost. The budgets come from docs/issue-register.md §3:
//   A1 hook wall time p50/p95 over 200 events, p95 < 100 ms
//   A2 model calls per active session-minute <= 1.2, and <= 1 in the first 60 s
//   A3 hostile/oversized hook inputs: expected jobs, empty stdout, exit 0
// No chain is needed for A — the hook's cost is its own code path, and A2's
// batching is a drain rule exercised with a stub compile and a stub save.

import { spawn } from "node:child_process"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import type { CompileInput } from "../../packages/compiler/src/index.js"
import {
  drainOnce, enqueue, listJobs, projectIdFor, runHook,
} from "../../apps/midad/src/index.js"
import type { DrainDeps } from "../../apps/midad/src/index.js"
import type { ProjectCheck } from "../../apps/midad/src/index.js"
import {
  REPO_ROOT, appendTranscript, assistantText, benchDir, benchHome, mark,
  stubCompile, userLine, writeTranscript,
} from "../lib/env.js"
import { runGroup } from "../lib/checks.js"

const HOOK_MAIN = fileURLToPath(new URL("../../apps/midad/src/hook-main.ts", import.meta.url))
const T0 = Date.parse("2026-09-21T10:00:00.000Z")

/** One child run of the real hook-main — what the agent CLI actually invokes. */
function spawnHookMain(homePath: string, homeDir: string, stdin: string): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, MIDA_HOME: homePath, HOME: homeDir }
  for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_")) delete env[key]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", HOOK_MAIN, "claude-code"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    })
    let stdout = ""
    child.stdout!.on("data", (chunk) => (stdout += chunk))
    child.on("close", (code) => resolve({ code, stdout }))
    child.stdin!.end(stdin)
  })
}

// A1 — red if the hook's own work (parse, validate, enqueue, kick) ever drifts
// over the agent CLI's budget. The 150 ms kick timeout is the likely culprit:
// a connect that stops failing fast would push p95 over the line.
async function a1() {
  const dir = benchDir("a1")
  const home = benchHome("a1")
  const homeDir = join(dir, "user-home")
  const transcript = writeTranscript(homeDir, "proj", "t.jsonl", [userLine("hi")])
  const cwd = join(dir, "work")
  mark(cwd, "p-a1")
  const stdin = (session: string) =>
    JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: session,
      transcript_path: transcript,
      cwd,
    })
  const times: number[] = []
  for (let i = 0; i < 200; i += 1) {
    const started = performance.now()
    await runHook({
      agent: "claude-code",
      stdin: stdin(`s-${i % 10}`),
      home,
      env: {},
      spawnDrainer: () => {},
      spawnDaemon: () => {},
      homeDir,
    })
    times.push(performance.now() - started)
  }
  const sorted = [...times].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  return { pass: p95 < 100, value: Math.round(p95 * 10) / 10, limit: 100, unit: "ms", detail: { p50: Math.round(p50 * 10) / 10, p95: Math.round(p95 * 10) / 10, events: 200 } }
}

// A2 — red if the drainer stops batching per session: a busy session must cost
// at most ~1 model call per minute of activity, and a burst in the first
// minute must still produce a single call.
async function a2() {
  const dir = benchDir("a2")
  const home = benchHome("a2")
  const homeDir = join(dir, "user-home")
  const cwd = join(dir, "work")
  mark(cwd, "p-a2")
  const compileCalls: CompileInput[] = []
  const saves: unknown[] = []
  const compile = stubCompile(compileCalls)
  const save: DrainDeps["save"] = async (_r, _a, input) => {
    saves.push(input)
    return { contextId: `0x${"ab".repeat(32)}`, transactionHash: null, milliseconds: 1, duplicate: false }
  }
  const open: DrainDeps["open"] = async () => ({ close: async () => {} }) as never
  const checkProject: NonNullable<DrainDeps["checkProject"]> = async (input): Promise<ProjectCheck> => {
    const projectId = projectIdFor(input.cwd)
    return projectId === null
      ? { ok: false, reason: "not-a-project" }
      : { ok: true, approval: { agent: input.agent, projectId, root: input.cwd, approvedAt: "2026-09-21T00:00:00.000Z" } }
  }
  const drainAt = (at: number) =>
    drainOnce({ home, open, compile, save, homeDir, checkProject, isApproved: async () => true, now: () => new Date(at) })

  // One session busy for five minutes: a PostToolUse every minute on a growing transcript.
  const steady = writeTranscript(homeDir, "proj", "steady.jsonl", [userLine("steady request")])
  enqueue(home, { agent: "claude-code", event: "PostToolUse", sessionId: "steady", transcriptPath: steady, cwd, error: null }, () => new Date(T0))
  for (let m = 1; m <= 5; m += 1) {
    appendTranscript(steady, assistantText(`step ${m}`))
    enqueue(home, { agent: "claude-code", event: "PostToolUse", sessionId: "steady", transcriptPath: steady, cwd, error: null }, () => new Date(T0 + m * 60_000))
    await drainAt(T0 + m * 60_000)
  }
  const steadyCalls = compileCalls.length

  // A second session fires six events inside its first minute — at most one call may result.
  // A held-back group collapses to its newest job, so the gap runs from the last event.
  const burst = writeTranscript(homeDir, "proj", "burst.jsonl", [userLine("burst request")])
  for (let s = 0; s <= 50; s += 10) {
    enqueue(home, { agent: "claude-code", event: "PostToolUse", sessionId: "burst", transcriptPath: burst, cwd, error: null }, () => new Date(T0 + 600_000 + s * 1_000))
  }
  await drainAt(T0 + 600_000 + 59_000) // inside the first minute: still too soon, nothing compiled
  appendTranscript(burst, assistantText("done"))
  await drainAt(T0 + 600_000 + 111_000) // 60 s past the burst's last event: the batch flushes as one save
  const burstCalls = compileCalls.length - steadyCalls

  const activeMinutes = 5
  const perMinute = steadyCalls / activeMinutes
  return {
    pass: perMinute <= 1.2 && burstCalls <= 1,
    value: perMinute,
    limit: 1.2,
    unit: "calls/active-min",
    detail: { steadyCalls, burstCalls, first60sLimit: 1 },
  }
}

// A3 — red if a hostile or oversized stdin can crash the hook, leak output onto
// stdout, or enqueue work the fields don't justify. Runs the real hook-main as
// a child process, exactly as the agent CLI does.
async function a3() {
  const dir = benchDir("a3")
  const home = benchHome("a3")
  const homeDir = join(dir, "user-home")
  const transcript = writeTranscript(homeDir, "proj", "t.jsonl", [userLine("hi")])
  const cwd = join(dir, "work")
  mark(cwd, "p-a3")
  const pad = "x".repeat(1_200_000)

  const results: { name: string; code: number | null; stdout: string }[] = []
  // oversized payload whose fields sit in the first 64 KB — salvaged into one real job
  results.push({ name: "oversized-salvage", ...(await spawnHookMain(home.root, homeDir, JSON.stringify({ hook_event_name: "PostToolUse", session_id: "a3big", transcript_path: transcript, cwd, pad }))) })
  // oversized junk with no salvageable fields — ignored
  results.push({ name: "oversized-junk", ...(await spawnHookMain(home.root, homeDir, pad)) })
  // path traversal in session_id — rejected, no job
  results.push({ name: "traversal-session", ...(await spawnHookMain(home.root, homeDir, JSON.stringify({ hook_event_name: "PostToolUse", session_id: "../../agents/claude-code/identity", transcript_path: transcript, cwd }))) })
  // transcript path outside the agent folder — rejected, no job
  results.push({ name: "outside-transcript", ...(await spawnHookMain(home.root, homeDir, JSON.stringify({ hook_event_name: "Stop", session_id: "a3out", transcript_path: "/etc/hosts", cwd }))) })

  const cleanExits = results.every((r) => r.code === 0)
  const cleanStdout = results.every((r) => r.stdout === "")
  const jobs = listJobs(home)
  // exactly the salvaged oversized job may exist — nothing else
  const expectedJobs = jobs.length === 1 && jobs[0]!.sessionId === "a3big"
  return {
    pass: cleanExits && cleanStdout && expectedJobs,
    value: { jobs: jobs.length, cleanExits, cleanStdout },
    limit: null,
    detail: { expectedJobs: 1, spawned: results.length },
  }
}

await runGroup([
  { id: "A1", run: a1 },
  { id: "A2", run: a2 },
  { id: "A3", run: a3 },
])
