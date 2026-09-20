import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MidaHome, listJobs, runHook } from "@mida/midad"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const HOOK_MAIN = fileURLToPath(new URL("../src/hook-main.ts", import.meta.url))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mida-hook-"))
  const home = new MidaHome(join(dir, "home"))
  const transcriptPath = join(dir, "transcript.jsonl")
  writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
  const cwd = join(dir, "work")
  const stdinFor = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcriptPath, cwd, ...over })
  return { dir, home, transcriptPath, cwd, stdinFor }
}

describe("runHook", () => {
  it("a valid Stop event enqueues exactly one job and spawns the drainer once", async () => {
    const { home, transcriptPath, cwd, stdinFor } = setup()
    let spawned = 0
    await runHook({ agent: "claude-code", stdin: stdinFor(), home, env: {}, spawnDrainer: () => { spawned += 1 } })
    expect(spawned).toBe(1)
    const jobs = listJobs(home)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      agent: "claude-code",
      event: "Stop",
      sessionId: "s1",
      transcriptPath,
      cwd,
      error: null,
    })
  })

  it("does nothing at all inside the compiler's own run (MIDA_INNER=1)", async () => {
    const { home, stdinFor } = setup()
    let spawned = 0
    await runHook({ agent: "claude-code", stdin: stdinFor(), home, env: { MIDA_INNER: "1" }, spawnDrainer: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    expect(home.has("logs/hook.jsonl")).toBe(false)
  })

  it("unreadable stdin logs one line, enqueues nothing, and never throws", async () => {
    const { home } = setup()
    let spawned = 0
    await runHook({ agent: "claude-code", stdin: "this is not json{", home, env: {}, spawnDrainer: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    const lines = readFileSync(home.path("logs/hook.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  it("a StopFailure event carries the CLI's error into the job", async () => {
    const { home, stdinFor } = setup()
    await runHook({
      agent: "claude-code",
      stdin: stdinFor({ hook_event_name: "StopFailure", error: "rate_limit" }),
      home,
      env: {},
      spawnDrainer: () => {},
    })
    expect(listJobs(home)[0]).toMatchObject({ event: "StopFailure", error: "rate_limit" })
  })

  it("an event name the capture does not handle enqueues nothing", async () => {
    const { home, stdinFor } = setup()
    let spawned = 0
    await runHook({ agent: "claude-code", stdin: stdinFor({ hook_event_name: "UserPromptSubmit" }), home, env: {}, spawnDrainer: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
  })

  it("a missing transcript_path enqueues nothing", async () => {
    const { home, stdinFor } = setup()
    let spawned = 0
    await runHook({ agent: "claude-code", stdin: stdinFor({ transcript_path: undefined }), home, env: {}, spawnDrainer: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
  })
})

describe("hook-main process", () => {
  it("exits 0 fast with empty stdout on a valid Stop event", () => {
    const { dir, stdinFor } = setup()
    const homeDir = join(dir, "hook-home")
    const started = Date.now()
    const res = spawnSync(process.execPath, ["--import", "tsx", HOOK_MAIN, "claude-code"], {
      input: stdinFor(),
      env: { ...process.env, MIDA_HOME: homeDir },
      encoding: "utf8",
      timeout: 20_000,
      cwd: REPO_ROOT,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe("")
    expect(Date.now() - started).toBeLessThan(1500)
  }, 30_000)
})
