import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, callDaemon, enqueue, listJobs, removeJob, socketPathFor, startDaemon } from "@mida/midad"
import type { DrainDeps, DrainResult, Runtime } from "@mida/midad"
import type { DaemonDeps } from "@mida/midad"

const DRAIN_OK: DrainResult = { saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0, earliestDueMs: null }

/**
 * Chain-free daemon tests: `openRuntime` stands in for `Runtime.open` (it writes the lock file so
 * cleanup assertions stay honest), `drain` is a spy that clears the queue, and `log` collects what
 * would land in logs/daemon.jsonl.
 */
function setup() {
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-daemon-")))
  const drainCalls: DrainDeps[] = []
  const logs: object[] = []
  const stubRuntime = { close: async () => home.remove("midad.lock") } as unknown as Runtime
  const deps: DaemonDeps = {
    home,
    network: { rpcUrl: "http://127.0.0.1:1", deployment: {} as never, fund: async () => {} },
    compile: async () => { throw new Error("no compile in unit tests") },
    now: () => Date.now(),
    log: (entry) => logs.push(entry),
    openRuntime: async () => {
      home.writeSecretJson("midad.lock", { pid: process.pid })
      return stubRuntime
    },
    drain: async (d) => {
      drainCalls.push(d)
      for (const job of listJobs(home)) removeJob(home, job.id)
      return { ...DRAIN_OK, saved: drainCalls.length }
    },
    runCli: async (argv, _runtime, print) => {
      print(`cli ${argv.join(" ")}`)
      return 0
    },
  }
  return { home, deps, drainCalls, logs, stubRuntime }
}

const poll = async (check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("poll timed out")
}

describe("startDaemon", () => {
  it("answers /health with its own pid and queue depth, and a second startDaemon reports already-running", async () => {
    const { home, deps } = setup()
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    const daemon = await startDaemon(deps)
    try {
      const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({ ok: true, pid: process.pid, queueDepth: 1 })

      const second = await startDaemon(deps)
      expect(second.alreadyRunning).toBe(true)
      // the first daemon is untouched and still serving
      const again = await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })
      expect(again.status).toBe(200)
      await second.close()
    } finally {
      await daemon.close()
    }
  })

  it("replaces a stale socket file that has no listener behind it", async () => {
    const { home, deps } = setup()
    writeFileSync(socketPathFor(home), "") // a dead daemon's leftover socket
    const daemon = await startDaemon(deps)
    try {
      expect(daemon.alreadyRunning).toBe(false)
      const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })
      expect(reply.status).toBe(200)
    } finally {
      await daemon.close()
    }
  })

  it("five ticks on an empty queue run zero passes and write zero drain-log lines", async () => {
    const { home, deps, drainCalls } = setup()
    let ticks = 0
    let daemon: { close(): Promise<void> } | undefined
    const handle = await startDaemon({
      ...deps,
      sleep: async () => {
        ticks += 1
        if (ticks === 5) queueMicrotask(() => void daemon?.close())
      },
    })
    daemon = handle
    await poll(() => ticks >= 5)
    await handle.close()
    expect(drainCalls).toHaveLength(0)
    expect(home.has("logs/drain.jsonl")).toBe(false)
  })

  it("/kick runs a drain pass over the queued job without waiting for a tick", async () => {
    const { home, deps, drainCalls } = setup()
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    const daemon = await startDaemon({ ...deps, tickMs: 60_000 })
    try {
      const reply = await callDaemon(home, "/kick", {}, { timeoutMs: 1_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toEqual({ ok: true })
      await poll(() => drainCalls.length > 0)
      expect(listJobs(home)).toHaveLength(0)
    } finally {
      await daemon.close()
    }
  })

  it("a flush job that lands mid-pass is drained again at once, with no second kick", async () => {
    const { home, deps } = setup()
    let calls = 0
    const drain = async (d: DrainDeps): Promise<DrainResult> => {
      calls += 1
      for (const job of listJobs(home)) removeJob(home, job.id)
      if (calls === 1) {
        enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s2", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      }
      return { ...DRAIN_OK, saved: 1 }
    }
    enqueue(home, { agent: "claude-code", event: "PostToolUse", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    const daemon = await startDaemon({ ...deps, drain, tickMs: 60_000 })
    try {
      await callDaemon(home, "/kick", {}, { timeoutMs: 1_000 })
      await poll(() => calls >= 2)
      expect(listJobs(home)).toHaveLength(0)
    } finally {
      await daemon.close()
    }
  })

  it("/cli refuses non-data argv and a missing array with code 2 and the usage line", async () => {
    const { home, deps } = setup()
    const daemon = await startDaemon(deps)
    try {
      for (const body of [{ argv: ["; rm -rf ~"] }, { argv: "init" }, { argv: Array(9).fill("read") }, "junk"]) {
        const reply = await callDaemon(home, "/cli", body, { timeoutMs: 1_000 })
        expect(reply.status).toBe(200)
        const result = reply.body as { code: number; lines: string[] }
        expect(result.code).toBe(2)
        expect(result.lines).toHaveLength(1)
        expect(result.lines[0]).toContain("usage: mida")
      }
      const ok = await callDaemon(home, "/cli", { argv: ["read", "codex", "p1"] }, { timeoutMs: 1_000 })
      expect(ok.body).toEqual({ code: 0, lines: ["cli read codex p1"] })
    } finally {
      await daemon.close()
    }
  })

  it("a request body over 64 KiB gets a 413 and the connection closes", async () => {
    const { home, deps } = setup()
    const daemon = await startDaemon(deps)
    try {
      const reply = await callDaemon(home, "/cli", { argv: ["read"], pad: "x".repeat(70 * 1024) }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(413)
    } finally {
      await daemon.close()
    }
  })

  it("close() removes the socket and the lock, and a new daemon can start on the same home", async () => {
    const { home, deps } = setup()
    const socket = socketPathFor(home)
    const daemon = await startDaemon(deps)
    await daemon.close()
    expect(existsSync(socket)).toBe(false)
    expect(home.has("midad.lock")).toBe(false)
    expect(home.has("midad.sock.path")).toBe(false)
    const again = await startDaemon(deps)
    try {
      expect(again.alreadyRunning).toBe(false)
      expect((await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })).status).toBe(200)
    } finally {
      await again.close()
    }
  })

  it("POST /handoff answers a refusal for an unapproved folder and logs one stable line", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    // a real marked project folder, but no approved-projects.json in the home — checkProject
    // runs against the stub runtime's home and answers not-approved
    const work = mkdtempSync(join(tmpdir(), "mida-handoff-work-"))
    mkdirSync(join(work, ".mida"))
    writeFileSync(join(work, ".mida", "project.json"), JSON.stringify({ projectId: "proj-x" }))
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
    })
    try {
      const reply = await callDaemon(home, "/handoff", { agent: "codex", cwd: work }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toEqual({
        kind: "refused",
        reason: "not-approved",
        text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
      })
      const entries = logs.filter((e) => (e as { event?: string }).event === "handoff")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ agent: "codex", kind: "refused", reason: "not-approved", checkpoints: 0, facts: 0 })
      expect(JSON.stringify(entries[0])).not.toContain("not approved for this project")
    } finally {
      await daemon.close()
    }
  })

  it("POST /handoff refuses an unsafe agent name and logs null for it, never the name", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
    })
    try {
      const reply = await callDaemon(home, "/handoff", { agent: "../agents", cwd: "/tmp" }, { timeoutMs: 2_000 })
      expect(reply.body).toEqual({
        kind: "refused",
        reason: "bad-agent",
        text: "Mida: no context available right now (bad-agent).",
      })
      const entry = logs.find((e) => (e as { event?: string }).event === "handoff")!
      expect(entry).toMatchObject({ agent: null, kind: "refused", reason: "bad-agent" })
      expect(JSON.stringify(entry)).not.toContain("..")
    } finally {
      await daemon.close()
    }
  })

  it("a home path too long for a socket lands in tmpdir and is recorded in midad.sock.path (0600)", async () => {
    const deep = join(tmpdir(), "mida-deep-" + "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    const deps = { ...setup().deps, home }
    const socket = socketPathFor(home)
    expect(socket).not.toBe(home.path("midad.sock"))
    const daemon = await startDaemon(deps)
    try {
      expect(existsSync(socket)).toBe(true)
      expect(readFileSync(home.path("midad.sock.path"), "utf8").trim()).toBe(socket)
      expect(statSync(home.path("midad.sock.path")).mode & 0o777).toBe(0o600)
      expect((await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })).status).toBe(200)
    } finally {
      await daemon.close()
    }
    expect(existsSync(socket)).toBe(false)
    expect(home.has("midad.sock.path")).toBe(false)
  })
})
