import { describe, expect, it } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CheckpointCopies, MidaHome, callDaemon, enqueue, fallbackSocketDir, listJobs, ownerOnlyLine, removeJob, socketPathFor, startDaemon, writeSeen } from "@mida/midad"
import type { DrainDeps, DrainResult, Runtime, ServiceRuntime } from "@mida/midad"
import type { DaemonDeps } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const DRAIN_OK: DrainResult = { saved: 0, skippedUnchanged: 0, skippedTooSoon: 0, failed: 0, earliestDueMs: null }

/**
 * Chain-free daemon tests: `openRuntime` stands in for `Runtime.open` (it writes the lock file so
 * cleanup assertions stay honest), `drain` is a spy that clears the queue, and `log` collects what
 * would land in logs/daemon.jsonl.
 */
function setup() {
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-daemon-")))
  // the handoff/whats-new routes refuse a missing identity before anything else — the agents
  // these tests drive need real identity files so the gate passes through to what each test
  // actually exercises
  for (const agent of ["codex", "claude-code"]) {
    home.writeSecretJson(`agents/${agent}/identity.json`, {
      name: agent,
      agentId: `0x${"aa".repeat(32)}`,
      signerPrivateKey: `0x${"bb".repeat(32)}`,
      encryptionPrivateKey: `0x${"11".repeat(32)}`,
      encryptionPublicKey: `0x${"22".repeat(32)}`,
      callbackOrigin: `https://${agent}.mida.example`,
      purposeId: "project_assistance",
      manifest: { v: 1 },
      manifestHash: `0x${"33".repeat(32)}`,
    })
  }
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

  it("a briefly busy old service keeps its socket — the new start backs off instead of orphaning it (in-29 S-1)", async () => {
    // Sep 29, item 14: the old service answered /health slower than the 500 ms startup probe, the
    // new start deleted the socket it listens on, then the lock refused the start — the old
    // service kept running behind a deleted file and nothing could reach it again. The lock's
    // pid is the truth: a live holder keeps its socket, whatever the health probe said.
    const { home, deps } = setup()
    const socketPath = socketPathFor(home)
    const old = createHttpServer((req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ ok: true, marker: "old" }))
      }, 200)
    })
    await new Promise<void>((resolve, reject) => {
      old.once("error", reject)
      old.listen(socketPath, () => resolve())
    })
    // the lock the live holder wrote — a spawned child whose command line is the bundled
    // daemon's `node …/dist/midad.js` stands in for the old service's process. The vitest pid
    // is no longer accepted here: a live pid is proof only when it is Mida (in-39 B-1).
    const holderDir = mkdtempSync(join(tmpdir(), "mida-holder-"))
    const holderScript = join(holderDir, "dist/midad.js")
    mkdirSync(dirname(holderScript), { recursive: true })
    writeFileSync(holderScript, "setInterval(() => {}, 1000)\n")
    const holder = spawn(process.execPath, [holderScript], { stdio: "ignore" })
    home.writeSecretJson("midad.lock", { pid: holder.pid })
    let second: { alreadyRunning: boolean; close(): Promise<void> } | undefined
    try {
      second = await startDaemon({ ...deps, staleCheckMs: 50 })
      expect(second.alreadyRunning).toBe(true)
      // the socket file must still be the old listener's — and a patient caller still reaches it
      expect(existsSync(socketPath)).toBe(true)
      const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 5_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({ marker: "old" })
    } finally {
      holder.kill()
      await second?.close()
      await new Promise<void>((done) => old.close(() => done()))
    }
  })

  it("a lock naming a live non-Mida process is stale — the start proceeds and replaces it (in-39 B-1)", async () => {
    // the recycled pid: Mida's number went to an unrelated program, so the lock it sits in
    // holds nothing — the new service takes over as if the pid were dead
    const { home, deps } = setup()
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      home.writeSecretJson("midad.lock", { pid: holder.pid })
      writeFileSync(socketPathFor(home), "")
      const daemon = await startDaemon({ ...deps, staleCheckMs: 50 })
      try {
        expect(daemon.alreadyRunning).toBe(false)
        // the stale lock was replaced by this service's own entry
        expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(process.pid)
        const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })
        expect(reply.status).toBe(200)
      } finally {
        await daemon.close()
      }
    } finally {
      holder.kill()
    }
  })

  it("a holder whose lock proves it by start time keeps its socket — the command line is not asked (in-40 L-1)", async () => {
    // The Sep 29 orphaning bug, fixed for good: the child is a bare `node -e` — no Mida-shaped
    // command line at all — but the lock carries the exact `ps -o lstart=` answer for its pid, so
    // it IS the process that took the lock. startDaemon must keep the socket file and back off.
    const { home, deps } = setup()
    const socketPath = socketPathFor(home)
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      const started = spawnSync("ps", ["-o", "lstart=", "-p", String(holder.pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      }).stdout.trim()
      home.writeSecretJson("midad.lock", { pid: holder.pid, started, role: "service" })
      writeFileSync(socketPath, "")
      const daemon = await startDaemon({ ...deps, staleCheckMs: 50 })
      try {
        expect(daemon.alreadyRunning).toBe(true)
        expect(existsSync(socketPath)).toBe(true) // the live holder's file was never removed
      } finally {
        await daemon.close()
      }
    } finally {
      holder.kill()
    }
  })

  it("a lock whose start time was recycled onto another program lets the start proceed (in-40 L-1)", async () => {
    // Same shape, one byte off: the pid lives but belongs to a process started at a different
    // instant, so the lock is stale and the new service takes over — the socket file goes with it.
    const { home, deps } = setup()
    const socketPath = socketPathFor(home)
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      home.writeSecretJson("midad.lock", { pid: holder.pid, started: "Thu Jan  1 00:00:00 1970", role: "service" })
      writeFileSync(socketPath, "")
      const daemon = await startDaemon({ ...deps, staleCheckMs: 50 })
      try {
        expect(daemon.alreadyRunning).toBe(false)
        const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })
        expect(reply.status).toBe(200)
      } finally {
        await daemon.close()
      }
    } finally {
      holder.kill()
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

  it("a flush job the drain cannot touch (lock held) gets exactly one pass, not a spin", async () => {
    const { home, deps, logs } = setup()
    let calls = 0
    const drain = async (): Promise<DrainResult> => {
      // the lock is held elsewhere: the pass cannot touch the queued flush job and leaves it
      calls += 1
      return { ...DRAIN_OK, lockHeld: true }
    }
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    const daemon = await startDaemon({ ...deps, drain, tickMs: 60_000 })
    try {
      await callDaemon(home, "/kick", {}, { timeoutMs: 1_000 })
      await poll(() => calls >= 1)
      // the stuck job must NOT re-pass at once — give a broken loop room to betray itself
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(1)
      expect(logs.filter((e) => (e as { event?: string }).event === "pass")).toHaveLength(1)
    } finally {
      await daemon.close()
    }
  })

  it("a flush job inside its retry backoff gets one pass, then waits for the tick", async () => {
    const { home, deps } = setup()
    let calls = 0
    const drain = async (): Promise<DrainResult> => {
      // the job is not due yet: the pass reports backoff and leaves it queued
      calls += 1
      return { ...DRAIN_OK, earliestDueMs: 30_000 }
    }
    enqueue(home, { agent: "claude-code", event: "SessionEnd", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    const daemon = await startDaemon({ ...deps, drain, tickMs: 60_000 })
    try {
      await callDaemon(home, "/kick", {}, { timeoutMs: 1_000 })
      await poll(() => calls >= 1)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(calls).toBe(1)
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

  it("/cli refuses every owner command with the terminal line, code 2 — and the dispatcher never sees it", async () => {
    const { home, deps } = setup()
    const cliCalls: string[][] = []
    const daemon = await startDaemon({
      ...deps,
      runCli: async (argv, _runtime, print) => {
        cliCalls.push(argv)
        print(`cli ${argv.join(" ")}`)
        return 0
      },
    })
    try {
      for (const argv of [["init"], ["approve", "codex"], ["revoke", "claude-code"], ["remember", "i like tests"]]) {
        const reply = await callDaemon(home, "/cli", { argv, cwd: "/tmp" }, { timeoutMs: 1_000 })
        expect(reply.status).toBe(200)
        expect(reply.body).toEqual({ code: 2, lines: [ownerOnlyLine(argv[0]!)] })
      }
      // nothing was dispatched — the spy records every call it gets, and it got none
      expect(cliCalls).toHaveLength(0)
      // a service command still reaches the dispatcher
      const ok = await callDaemon(home, "/cli", { argv: ["read", "codex", "p1"] }, { timeoutMs: 1_000 })
      expect(ok.body).toEqual({ code: 0, lines: ["cli read codex p1"] })
    } finally {
      await daemon.close()
    }
  })

  it("runCliWithRuntime itself refuses an owner command — the refusal does not depend on the route", async () => {
    const { runCliWithRuntime } = await import("@mida/midad")
    const lines: string[] = []
    const runtime = { close: async () => {} } as unknown as ServiceRuntime
    for (const argv of [["init"], ["approve", "codex"], ["revoke", "codex"], ["remember", "x"]]) {
      expect(await runCliWithRuntime(argv, runtime, (line) => lines.push(line))).toBe(2)
      expect(lines[lines.length - 1]).toBe(ownerOnlyLine(argv[0]!))
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

  it("POST /handoff logs a stable facts-failed code when the owner-fact read fails but the handoff still answers", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
      handoffDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "live",
        read: async () => ({ checkpoints: [], skipped: 0, milliseconds: 1, partial: false }),
        readFacts: async () => {
          throw new Error("server went away")
        },
      },
    })
    try {
      const reply = await callDaemon(home, "/handoff", { agent: "codex", cwd: "/tmp/work" }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      // a failed fact read is a degraded handoff, never a refusal
      expect(reply.body).toMatchObject({ kind: "empty", facts: 0, factsFailed: "facts-read-failed" })
      const entry = logs.find((e) => (e as { event?: string }).event === "handoff")!
      expect(entry).toMatchObject({ agent: "codex", kind: "empty", facts: 0, factsFailed: "facts-read-failed" })
      expect(JSON.stringify(entry)).not.toContain("server went away")
    } finally {
      await daemon.close()
    }
  })

  it("POST /handoff on a partial read logs partial: true and does NOT seed the whats-new copy (M3-D)", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    const foreign = {
      checkpoint: sampleCheckpoint({ eventId: "cp-partial", agent: "codex", createdAt: "2026-09-21T11:30:00.000Z" }),
      projectId: "p1", sessionId: "other-session", continuesSession: null, compiledBy: "test",
      contextId: `0x${"a1".repeat(32)}`, authorId: `0x${"b2".repeat(32)}`, namespaceId: `0x${"c3".repeat(32)}`,
    }
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
      handoffDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "live",
        read: async () => ({ checkpoints: [foreign], skipped: 0, milliseconds: 1, partial: true }),
        readFacts: async () => [],
      },
      whatsnewDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "live",
        // a read that never resolves: if the partial handoff DID seed the copy, /whatsnew answers
        // "updates" from memory without ever calling this — the "none" answer is the proof no
        // incomplete list was cached.
        read: () => new Promise(() => {}),
      },
    })
    try {
      const reply = await callDaemon(home, "/handoff", { agent: "codex", cwd: "/tmp/work" }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({ kind: "handoff", partial: true })
      expect((reply.body as { text: string }).text.startsWith("Some saved context could not be loaded yet; what follows may be incomplete.")).toBe(true)
      const entry = logs.find((e) => (e as { event?: string }).event === "handoff")!
      expect(entry).toMatchObject({ agent: "codex", kind: "handoff", partial: true })

      // the partial list must not have become the warm copy: a prompt right after answers "none"
      // (and quietly starts a real refresh), not "updates" from a list the store called incomplete
      const prompt = await callDaemon(home, "/whatsnew", { agent: "codex", cwd: "/tmp/work", sessionId: "s-9" }, { timeoutMs: 2_000 })
      expect(prompt.body).toEqual({ kind: "none" })
    } finally {
      await daemon.close()
    }
  })

  it("POST /handoff logs the delivered size and limit, and says when the text was cut (R5-4)", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    const progress = Array.from({ length: 400 }, (_, i) => `progress entry number ${i} ${"x".repeat(60)}`)
    const big = {
      checkpoint: sampleCheckpoint({ eventId: "cp-big", agent: "codex", progress }),
      projectId: "p1", sessionId: "s1", continuesSession: null, compiledBy: "test",
      contextId: `0x${"a1".repeat(32)}`, authorId: `0x${"b2".repeat(32)}`, namespaceId: `0x${"c3".repeat(32)}`,
    }
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
      handoffDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "live",
        read: async () => ({ checkpoints: [big], skipped: 0, milliseconds: 1, partial: false }),
        readFacts: async () => [],
      },
    })
    try {
      const reply = await callDaemon(home, "/handoff", { agent: "codex", cwd: "/tmp/work" }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({ kind: "handoff", cut: true, limitChars: 8000, oversized: false })
      const entry = logs.find((e) => (e as { event?: string }).event === "handoff")! as Record<string, unknown>
      expect(entry).toMatchObject({ kind: "handoff", cut: true, limitChars: 8000, oversized: false })
      expect(entry.chars).toBe((reply.body as { text: string }).text.length)
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

  it("POST /whatsnew answers updates for foreign checkpoints and logs one stable line (R5-5)", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    writeSeen(home, "s-1", ["0xprior-delivery"])
    const foreign = {
      checkpoint: sampleCheckpoint({ eventId: "cp-1", agent: "codex", createdAt: "2026-09-21T11:30:00.000Z", progress: ["shipped it"], nextAction: "rest" }),
      projectId: "p1", sessionId: "other-session", continuesSession: null, compiledBy: "test",
      contextId: `0x${"a1".repeat(32)}`, authorId: `0x${"b2".repeat(32)}`, namespaceId: `0x${"c3".repeat(32)}`,
    }
    // the daemon's copy is already warm — the request is answered from memory, no read at all
    const copies = new CheckpointCopies(() => Date.parse("2026-09-21T12:00:00.000Z"))
    copies.seed("claude-code", "p1", [foreign])
    let reads = 0
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
      whatsnewDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "claude-code", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "live",
        read: async () => {
          reads += 1
          return { checkpoints: [], skipped: 0, milliseconds: 1, partial: false }
        },
        authorNames: { [`0x${"b2".repeat(32)}`]: "codex" },
        now: () => Date.parse("2026-09-21T12:00:00.000Z"),
        copies,
      },
    })
    try {
      const reply = await callDaemon(home, "/whatsnew", { agent: "claude-code", cwd: "/tmp/work", sessionId: "s-1" }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      const body = reply.body as { kind: string; note: string; updates: { agent: string }[]; seen: string[] }
      expect(body.kind).toBe("updates")
      expect(body.note).toContain("Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):")
      expect(body.note).toContain("codex")
      expect(body.updates).toEqual([{ agent: "codex", savedAt: "2026-09-21T11:30:00.000Z" }])
      // the proposed set keeps what was already delivered and adds the reported checkpoint's id
      expect(body.seen).toEqual(["0xprior-delivery", `0x${"a1".repeat(32)}`])
      // the warm copy answered — the checkpoint read never ran
      expect(reads).toBe(0)
      const entry = logs.find((e) => (e as { event?: string }).event === "whatsnew")! as Record<string, unknown>
      expect(entry).toMatchObject({ agent: "claude-code", kind: "updates", updates: 1, reason: null })
      expect(JSON.stringify(entry)).not.toContain("shipped it")
    } finally {
      await daemon.close()
    }
  })

  it("a checkpoint the drain saved is visible to another session's /whatsnew without a new read", async () => {
    const { home, deps, stubRuntime } = setup()
    const fakeNow = Date.parse("2026-09-21T12:00:00.000Z")
    const savedCheckpoint = sampleCheckpoint({
      eventId: "cp-drain",
      agent: "claude-code",
      createdAt: "2026-09-21T11:59:00.000Z",
      progress: ["the drain just saved this"],
      nextAction: "continue",
    })
    let drainRan = false
    let whatsnewReads = 0
    const daemon = await startDaemon({
      ...deps,
      now: () => fakeNow,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
      drain: async (d) => {
        // a real drain pass ends in saveCheckpoint — calling the injected save exercises the
        // daemon's wrapper, which is what seeds the whats-new copy; a saved job leaves the
        // queue, so the spy removes it too
        drainRan = true
        await d.save!(stubRuntime as unknown as ServiceRuntime, "claude-code", {
          projectId: "p1",
          sessionId: "session-a",
          continuesSession: null,
          compiledBy: "test",
          checkpoint: savedCheckpoint,
        })
        for (const job of listJobs(home)) removeJob(home, job.id)
        return { ...DRAIN_OK, saved: 1 }
      },
      drainDeps: {
        save: async () => ({ contextId: `0x${"d1".repeat(32)}` as `0x${string}`, transactionHash: null, milliseconds: 1, duplicate: false }),
      },
      whatsnewDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "claude-code", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "live",
        read: async () => {
          whatsnewReads += 1
          return { checkpoints: [], skipped: 0, milliseconds: 1, partial: false }
        },
        authorNames: { "claude-code": "claude-code" },
        now: () => fakeNow,
      },
    })
    try {
      enqueue(home, {
        agent: "claude-code",
        event: "Stop",
        sessionId: "session-a",
        transcriptPath: "/tmp/transcript.jsonl",
        cwd: "/tmp",
        error: null,
      })
      await callDaemon(home, "/kick", {}, { timeoutMs: 1_000 })
      await poll(() => drainRan, 5_000)
      const reply = await callDaemon(home, "/whatsnew", { agent: "claude-code", cwd: "/tmp/work", sessionId: "session-b" }, { timeoutMs: 2_000 })
      expect(reply.status).toBe(200)
      const body = reply.body as { kind: string; note?: string }
      expect(body.kind).toBe("updates")
      expect(body.note).toContain("the drain just saved this")
      // the seeded copy answered — no checkpoint read ran at all
      expect(whatsnewReads).toBe(0)
    } finally {
      await daemon.close()
    }
  })

  it("POST /whatsnew answers refused for a revoked agent and the refusal lands in the log", async () => {
    const { home, deps, stubRuntime, logs } = setup()
    const daemon = await startDaemon({
      ...deps,
      openRuntime: async () => ({ ...stubRuntime, home }) as Runtime,
      whatsnewDeps: {
        checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" } }),
        capability: async () => "revoked",
      },
    })
    try {
      const reply = await callDaemon(home, "/whatsnew", { agent: "codex", cwd: "/tmp/work", sessionId: "s-1" }, { timeoutMs: 2_000 })
      expect(reply.body).toEqual({ kind: "refused", reason: "revoked" })
      const entry = logs.find((e) => (e as { event?: string }).event === "whatsnew")!
      expect(entry).toMatchObject({ agent: "codex", kind: "refused", reason: "revoked" })
    } finally {
      await daemon.close()
    }
  })

  it("a home path too long for a socket lands in the private fallback folder and is recorded in midad.sock.path (0600)", async () => {
    const deep = join(tmpdir(), "mida-deep-" + "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    const deps = { ...setup().deps, home }
    const socket = socketPathFor(home)
    expect(socket).not.toBe(home.path("midad.sock"))
    expect(dirname(socket)).toBe(fallbackSocketDir())
    const daemon = await startDaemon(deps)
    try {
      expect(existsSync(socket)).toBe(true)
      expect(readFileSync(home.path("midad.sock.path"), "utf8").trim()).toBe(socket)
      expect(statSync(home.path("midad.sock.path")).mode & 0o777).toBe(0o600)
      expect(statSync(socket).mode & 0o777).toBe(0o600)
      expect((await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })).status).toBe(200)
    } finally {
      await daemon.close()
    }
    expect(existsSync(socket)).toBe(false)
    expect(home.has("midad.sock.path")).toBe(false)
  })

  it("the daemon itself creates the fallback folder as a private 0700 directory, and restores the umask after listen", async () => {
    // a short private base keeps this test's fallback folder away from the real <tmp>/mida-<uid>
    // AND keeps the socket path under the ~104-byte Unix limit (macOS tmpdir alone is ~50 chars)
    const base = mkdtempSync(join("/tmp", "mida-sockbase-"))
    const deep = join(base, "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    const deps = { ...setup().deps, home, socketBase: base }
    expect(existsSync(fallbackSocketDir(base))).toBe(false)
    const umaskBefore = process.umask()
    const daemon = await startDaemon(deps)
    try {
      const dirStat = lstatSync(fallbackSocketDir(base))
      expect(dirStat.isDirectory()).toBe(true)
      expect(dirStat.mode & 0o777).toBe(0o700)
      expect(dirStat.uid).toBe(process.getuid!())
      const socket = socketPathFor(home, base)
      expect(statSync(socket).mode & 0o777).toBe(0o600)
      expect(process.umask()).toBe(umaskBefore)
      expect((await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })).status).toBe(200)
    } finally {
      await daemon.close()
    }
  })

  it("a pre-existing fallback folder with mode 0777 refuses the start with a plain message", async () => {
    const base = mkdtempSync(join("/tmp", "mida-sockbase-"))
    const deep = join(base, "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    const deps = { ...setup().deps, home, socketBase: base }
    mkdirSync(fallbackSocketDir(base))
    chmodSync(fallbackSocketDir(base), 0o777)
    await expect(startDaemon(deps)).rejects.toThrow(/mode 0700/)
    expect(home.has("midad.lock")).toBe(false) // refused before the runtime opened
  })

  it("a symlink standing in for the fallback folder refuses the start", async () => {
    const base = mkdtempSync(join("/tmp", "mida-sockbase-"))
    const deep = join(base, "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    const deps = { ...setup().deps, home, socketBase: base }
    symlinkSync(mkdtempSync(join(tmpdir(), "mida-real-")), fallbackSocketDir(base))
    await expect(startDaemon(deps)).rejects.toThrow(/mode 0700/)
    expect(home.has("midad.lock")).toBe(false)
  })
})
