import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MidaHome, listJobs, runHook, socketPathFor } from "@mida/midad"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const HOOK_MAIN = fileURLToPath(new URL("../src/hook-main.ts", import.meta.url))

/**
 * `dir` plays the user's real home folder (injected as `homeDir`): the transcript must sit under
 * its `.claude/projects/` for a `claude-code` hook, exactly where Claude Code keeps sessions.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mida-hook-"))
  const home = new MidaHome(join(dir, "home"))
  mkdirSync(join(dir, ".claude", "projects", "proj"), { recursive: true })
  const transcriptPath = join(dir, ".claude", "projects", "proj", "transcript.jsonl")
  writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
  const cwd = join(dir, "work")
  const stdinFor = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcriptPath, cwd, ...over })
  return { dir, home, transcriptPath, cwd, stdinFor }
}

const hook = (input: { dir: string; home: MidaHome; stdin: string; agent?: string; spawned?: () => void }) =>
  runHook({
    agent: input.agent ?? "claude-code",
    stdin: input.stdin,
    home: input.home,
    homeDir: input.dir,
    env: {},
    spawnDrainer: input.spawned ?? (() => {}),
  })

describe("runHook", () => {
  it("a valid Stop event enqueues exactly one job and spawns the drainer once", async () => {
    const { dir, home, transcriptPath, cwd, stdinFor } = setup()
    let spawned = 0
    await hook({ dir, home, stdin: stdinFor(), spawned: () => { spawned += 1 } })
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
    const { dir, home, stdinFor } = setup()
    let spawned = 0
    await runHook({
      agent: "claude-code",
      stdin: stdinFor(),
      home,
      homeDir: dir,
      env: { MIDA_INNER: "1" },
      spawnDrainer: () => { spawned += 1 },
    })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    expect(home.has("logs/hook.jsonl")).toBe(false)
  })

  it("unreadable stdin logs one line, enqueues nothing, and never throws", async () => {
    const { dir, home } = setup()
    let spawned = 0
    await hook({ dir, home, stdin: "this is not json{", spawned: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    const lines = readFileSync(home.path("logs/hook.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  it("a StopFailure event carries the CLI's error into the job", async () => {
    const { dir, home, stdinFor } = setup()
    await hook({ dir, home, stdin: stdinFor({ hook_event_name: "StopFailure", error: "rate_limit" }) })
    expect(listJobs(home)[0]).toMatchObject({ event: "StopFailure", error: "rate_limit" })
  })

  it("an event name the capture does not handle enqueues nothing", async () => {
    const { dir, home, stdinFor } = setup()
    let spawned = 0
    await hook({ dir, home, stdin: stdinFor({ hook_event_name: "UserPromptSubmit" }), spawned: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
  })

  it("a missing transcript_path enqueues nothing", async () => {
    const { dir, home, stdinFor } = setup()
    let spawned = 0
    await hook({ dir, home, stdin: stdinFor({ transcript_path: undefined }), spawned: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
  })

  it("rejects a session_id that would write state outside queue/state and leaves agent files untouched", async () => {
    const { dir, home, stdinFor } = setup()
    home.writeSecretJson("agents/claude-code/identity.json", { agentId: "0xabc", keep: "byte-identical" })
    const before = readFileSync(home.path("agents/claude-code/identity.json"))
    let spawned = 0
    await hook({ dir, home, stdin: stdinFor({ session_id: "../../agents/claude-code/identity" }), spawned: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("agents/claude-code/identity.json"))).toEqual(before)
    const lines = readFileSync(home.path("logs/hook.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("bad-session-id")
  })

  it("rejects a missing session_id instead of merging strangers under the empty id", async () => {
    const { dir, home, stdinFor } = setup()
    await hook({ dir, home, stdin: stdinFor({ session_id: undefined }) })
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/hook.jsonl"), "utf8")).toContain("bad-session-id")
  })

  it("rejects session ids that are dots or carry slashes", async () => {
    const { dir, home, stdinFor } = setup()
    for (const bad of [".", "..", "a/b", "", "a b"]) {
      await hook({ dir, home, stdin: stdinFor({ session_id: bad }) })
    }
    expect(listJobs(home)).toHaveLength(0)
    const log = readFileSync(home.path("logs/hook.jsonl"), "utf8")
    expect(log.match(/bad-session-id/g)).toHaveLength(5)
  })

  it("rejects an agent name that could walk the home folder", async () => {
    const { dir, home, stdinFor } = setup()
    let spawned = 0
    await hook({ dir, home, stdin: stdinFor(), agent: "../agents", spawned: () => { spawned += 1 } })
    await hook({ dir, home, stdin: stdinFor(), agent: "..", spawned: () => { spawned += 1 } })
    expect(spawned).toBe(0)
    expect(listJobs(home)).toHaveLength(0)
    const lines = readFileSync(home.path("logs/hook.jsonl"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("bad-agent")
  })

  it("rejects a transcript path that is not a Claude Code transcript under the user home", async () => {
    const { dir, home, stdinFor } = setup()
    for (const bad of ["/etc/hosts", "/etc/passwd", "relative/path.jsonl", `${dir}/notjson.txt`]) {
      await hook({ dir, home, stdin: stdinFor({ transcript_path: bad }) })
    }
    const elsewhere = join(dir, "elsewhere.jsonl")
    writeFileSync(elsewhere, "{}\n")
    await hook({ dir, home, stdin: stdinFor({ transcript_path: elsewhere }) })
    expect(listJobs(home)).toHaveLength(0)
    const log = readFileSync(home.path("logs/hook.jsonl"), "utf8")
    expect(log.match(/bad-transcript-path/g)).toHaveLength(5)
  })

  it("rejects a symlink inside the transcript folder that points outside it", async () => {
    const { dir, home, stdinFor } = setup()
    const target = join(dir, "real-transcript.jsonl")
    writeFileSync(target, "{}\n")
    const link = join(dir, ".claude", "projects", "proj", "linked.jsonl")
    symlinkSync(target, link)
    await hook({ dir, home, stdin: stdinFor({ transcript_path: link }) })
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/hook.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("rejects a transcript path that slips out through a symlinked parent folder", async () => {
    const { dir, home, stdinFor } = setup()
    const outside = mkdtempSync(join(tmpdir(), "mida-outside-"))
    const target = join(outside, "t.jsonl")
    writeFileSync(target, "{}\n")
    const sneak = join(dir, ".claude", "projects", "sneak")
    symlinkSync(outside, sneak)
    await hook({ dir, home, stdin: stdinFor({ transcript_path: join(sneak, "t.jsonl") }) })
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/hook.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("an agent with no configured transcript folder is refused — never handed the whole home", async () => {
    const { dir, home, stdinFor } = setup()
    // a perfectly valid .jsonl inside the home folder but outside every transcript dir:
    // a missing TRANSCRIPT_DIRS entry must mean refusal, not "anywhere under home goes"
    const loose = join(dir, "anywhere.jsonl")
    writeFileSync(loose, "{}\n")
    for (const agent of ["cursor", "windsurf"]) {
      await hook({ dir, home, stdin: stdinFor({ transcript_path: loose }), agent })
    }
    expect(listJobs(home)).toHaveLength(0)
    const log = readFileSync(home.path("logs/hook.jsonl"), "utf8")
    expect(log.match(/bad-transcript-path/g)).toHaveLength(2)
  })

  it("a codex rollout under .codex/sessions is accepted; the same agent in another folder is refused", async () => {
    const { dir, home, transcriptPath, stdinFor } = setup()
    // codex-cli writes session rollouts at <CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
    const sessions = join(dir, ".codex", "sessions", "2026", "09", "21")
    mkdirSync(sessions, { recursive: true })
    const rollout = join(sessions, "rollout-2026-09-21T10-00-00-abc.jsonl")
    writeFileSync(rollout, "{}\n")
    await hook({ dir, home, stdin: stdinFor({ transcript_path: rollout }), agent: "codex" })
    const jobs = listJobs(home)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ agent: "codex", transcriptPath: rollout })
    // the folders are per-agent: codex naming a claude-code transcript is refused
    await hook({ dir, home, stdin: stdinFor({ transcript_path: transcriptPath }), agent: "codex" })
    expect(listJobs(home)).toHaveLength(1)
  })
})

/** A socket server the test controls: `onRequest` decides what a connection gets back. */
function fakeDaemon(socketPath: string, onRequest: (socket: Socket, data: Buffer) => void): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("data", (data) => onRequest(socket, data))
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve(server))
  })
}

const closeServer = (server: Server) => new Promise<void>((done) => server.close(() => done()))

describe("runHook kicks the daemon instead of spawning a drainer", () => {
  it("a reachable daemon means zero spawns", async () => {
    const { dir, home, stdinFor } = setup()
    const server = await fakeDaemon(socketPathFor(home), (socket) => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{"ok":true}')
    })
    try {
      let daemonSpawns = 0
      let drainerSpawns = 0
      await runHook({
        agent: "claude-code",
        stdin: stdinFor(),
        home,
        homeDir: dir,
        env: {},
        spawnDaemon: () => { daemonSpawns += 1 },
        spawnDrainer: () => { drainerSpawns += 1 },
      })
      expect(daemonSpawns).toBe(0)
      expect(drainerSpawns).toBe(0)
      expect(listJobs(home)).toHaveLength(1)
    } finally {
      await closeServer(server)
    }
  })

  it("a daemon that accepts but never answers still returns inside 300 ms and spawns once", async () => {
    const { dir, home, stdinFor } = setup()
    const server = await fakeDaemon(socketPathFor(home), () => {}) // silent forever
    try {
      let daemonSpawns = 0
      let drainerSpawns = 0
      const started = Date.now()
      await runHook({
        agent: "claude-code",
        stdin: stdinFor(),
        home,
        homeDir: dir,
        env: {},
        spawnDaemon: () => { daemonSpawns += 1 },
        spawnDrainer: () => { drainerSpawns += 1 },
      })
      expect(Date.now() - started).toBeLessThan(300)
      expect(daemonSpawns).toBe(1)
      expect(drainerSpawns).toBe(0)
      expect(listJobs(home)).toHaveLength(1)
    } finally {
      await closeServer(server)
    }
  })

  it("a daemon spawn that throws falls back to the old detached drainer", async () => {
    const { dir, home, stdinFor } = setup()
    let daemonSpawns = 0
    let drainerSpawns = 0
    await runHook({
      agent: "claude-code",
      stdin: stdinFor(),
      home,
      homeDir: dir,
      env: {},
      spawnDaemon: () => { daemonSpawns += 1; throw new Error("spawn refused") },
      spawnDrainer: () => { drainerSpawns += 1 },
    })
    expect(daemonSpawns).toBe(1)
    expect(drainerSpawns).toBe(1)
    expect(listJobs(home)).toHaveLength(1)
  })
})

describe("hook-main process", () => {
  it("exits 0 fast with empty stdout on a valid Stop event", () => {
    const { dir, stdinFor } = setup()
    const homeDir = join(dir, "hook-home")
    const started = Date.now()
    const res = spawnSync(process.execPath, ["--import", "tsx", HOOK_MAIN, "claude-code"], {
      input: stdinFor(),
      env: { ...process.env, MIDA_HOME: homeDir, HOME: dir },
      encoding: "utf8",
      timeout: 20_000,
      cwd: REPO_ROOT,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe("")
    expect(Date.now() - started).toBeLessThan(1500)
  }, 30_000)

  it("a payload over 1 MB with the fields up front still enqueues the job", () => {
    const { dir, stdinFor } = setup()
    const homeDir = join(dir, "hook-home")
    const res = spawnSync(process.execPath, ["--import", "tsx", HOOK_MAIN, "claude-code"], {
      input: stdinFor({ padding: "x".repeat(2 * 1024 * 1024) }),
      env: { ...process.env, MIDA_HOME: homeDir, HOME: dir },
      encoding: "utf8",
      timeout: 20_000,
      cwd: REPO_ROOT,
    })
    expect(res.status).toBe(0)
    const jobs = listJobs(new MidaHome(homeDir))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ agent: "claude-code", sessionId: "s1", event: "Stop" })
  }, 30_000)

  it("a hook during a migration enqueues the job but starts nothing (migrate B6)", () => {
    const { dir, stdinFor } = setup()
    const homeDir = join(dir, "hook-home")
    const home = new MidaHome(homeDir)
    home.writeSecretJson("migrate/in-progress", { at: "2026-09-23T12:00:00.000Z", target: "0xabc" })
    const res = spawnSync(process.execPath, ["--import", "tsx", HOOK_MAIN, "claude-code"], {
      input: stdinFor(),
      env: { ...process.env, MIDA_HOME: homeDir, HOME: dir },
      encoding: "utf8",
      timeout: 20_000,
      cwd: REPO_ROOT,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe("")
    const jobs = listJobs(new MidaHome(homeDir))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ agent: "claude-code", sessionId: "s1", event: "Stop" })
    const log = readFileSync(new MidaHome(homeDir).path("logs/hook.jsonl"), "utf8")
    expect(log).toContain("migration-in-progress")
  }, 30_000)

  it("a payload over 1 MB of junk logs input-too-large, never unreadable-input", () => {
    const { dir } = setup()
    const homeDir = join(dir, "hook-home")
    const res = spawnSync(process.execPath, ["--import", "tsx", HOOK_MAIN, "claude-code"], {
      input: "z".repeat(2 * 1024 * 1024),
      env: { ...process.env, MIDA_HOME: homeDir, HOME: dir },
      encoding: "utf8",
      timeout: 20_000,
      cwd: REPO_ROOT,
    })
    expect(res.status).toBe(0)
    const jobs = listJobs(new MidaHome(homeDir))
    expect(jobs).toHaveLength(0)
    const log = readFileSync(new MidaHome(homeDir).path("logs/hook.jsonl"), "utf8")
    expect(log).toContain("input-too-large")
    expect(log).not.toContain("unreadable-input")
  }, 30_000)
})
