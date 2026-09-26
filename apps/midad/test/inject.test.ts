import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MidaHome, readSeen, socketPathFor, writeSeen } from "@mida/midad"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const INJECT_MAIN = fileURLToPath(new URL("../src/inject-main.ts", import.meta.url))

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-inject-")))

/**
 * Spawns inject-main as a real child, the way the agent CLI runs the hook. Async, not spawnSync:
 * a synchronous spawn would freeze this process's event loop and the fake daemon below could
 * never answer the child's socket calls.
 */
const run = (
  args: string[],
  input: string,
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MIDA_HOME: homeDir, ...extraEnv }
    // tests run under Devin inherit DEVIN_PROJECT_DIR — delete it so only the guard tests see it
    if (extraEnv.DEVIN_PROJECT_DIR === undefined) delete env.DEVIN_PROJECT_DIR
    const child = spawn(process.execPath, ["--import", "tsx", INJECT_MAIN, ...args], {
      env,
      cwd: REPO_ROOT,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
    })
    child.on("error", reject)
    child.stdin.on("error", () => {}) // the child may exit before finishing a 2 MB write — EPIPE is fine
    child.on("exit", (code) => resolve({ status: code, stdout, stderr }))
    child.stdin.end(input)
  })

const sessionStart = (cwd = "/tmp/work") => JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd })
const promptSubmit = (cwd = "/tmp/work", sessionId = "s1") =>
  JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd })

/** Every SessionStart answer is the JSON envelope the tools show the owner and feed the model. */
const envelope = (stdout: string) =>
  JSON.parse(stdout) as {
    systemMessage: string
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }

/** A socket server the test controls: /health answers ok, /handoff answers `handoffBody`. */
const fakeDaemon = (dir: MidaHome, handoffBody: unknown, silent = false): Promise<Server> =>
  new Promise((resolve, reject) => {
    const s = createServer((socket: Socket) => {
      socket.on("data", (data) => {
        const path = data.toString("utf8").split(" ")[1]
        if (path === "/handoff" && silent) return
        const payload = JSON.stringify(path === "/handoff" ? handoffBody : { ok: true, pid: 1 })
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`)
      })
    })
    s.once("error", reject)
    s.listen(socketPathFor(dir), () => resolve(s))
  })

const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

/**
 * A socket server answering only /whatsnew — the prompt hook goes straight to the socket, it
 * never asks /health and never boots a daemon. `delayMs` models a slow daemon; `silent` a dead
 * one. `stop()` drops open connections first so a delayed answer cannot hold the test open.
 */
const whatsnewDaemon = (dir: MidaHome, body: unknown, opts: { silent?: boolean; delayMs?: number } = {}) =>
  new Promise<{ server: Server; stop(): Promise<void> }>((resolve, reject) => {
    const sockets = new Set<Socket>()
    const s = createServer((socket: Socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {}) // the client may already be gone when a delayed answer lands
      socket.on("data", (data) => {
        const path = data.toString("utf8").split(" ")[1]
        if (path !== "/whatsnew" || opts.silent) return
        const payload = JSON.stringify(body)
        const answer = () => {
          try {
            socket.end(
              `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
            )
          } catch {
            // the client gave up — nothing to answer
          }
        }
        if (opts.delayMs === undefined) answer()
        else setTimeout(answer, opts.delayMs).unref()
      })
    })
    s.once("error", reject)
    s.listen(socketPathFor(dir), () =>
      resolve({
        server: s,
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            s.close(() => done())
          }),
      }),
    )
  })

/** An init'ed home with a live fake daemon answering /handoff with `body`. */
const liveDaemon = async (body: unknown, silent = false) => {
  const dir = home()
  // init's marker: with it the hook tries the socket instead of refusing daemon-down at once
  dir.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: {} })
  const server = await fakeDaemon(dir, body, silent)
  return { dir, server }
}

const handoffBody = (over: Record<string, unknown> = {}) => ({
  kind: "handoff",
  text: "CTX-BODY",
  checkpoints: 1,
  facts: 0,
  savedBy: "claude-code",
  savedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  ...over,
})

describe("inject-main process", () => {
  it("a missing agent name prints the degraded JSON envelope and still exits 0", async () => {
    const res = await run([], sessionStart(), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    const out = envelope(res.stdout)
    expect(out.systemMessage).toBe("Mida: could not load context (bad-agent) — working without it")
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(out.hookSpecificOutput.additionalContext).toBe("Mida: no context available right now (bad-agent).")
  }, 30_000)

  it("an unsafe agent name prints the degraded envelope and never reaches the daemon", async () => {
    for (const agent of ["../agents", "..", "a b"]) {
      const res = await run([agent], sessionStart(), home().root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: could not load context (bad-agent) — working without it")
      expect(out.hookSpecificOutput.additionalContext).toBe("Mida: no context available right now (bad-agent).")
    }
  }, 60_000)

  it("2 MB of junk stdin prints one bad-input envelope, exits 0, writes nothing to stderr", async () => {
    const res = await run(["claude-code"], "z".repeat(2 * 1024 * 1024), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    const out = envelope(res.stdout)
    expect(out.systemMessage).toBe("Mida: could not load context (bad-input) — working without it")
    expect(out.hookSpecificOutput.additionalContext).toBe("Mida: no context available right now (bad-input).")
  }, 30_000)

  it("stdin that is not JSON prints the bad-input envelope", async () => {
    const res = await run(["claude-code"], "this is not json{", home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    const out = envelope(res.stdout)
    expect(out.systemMessage).toBe("Mida: could not load context (bad-input) — working without it")
    expect(out.hookSpecificOutput.additionalContext).toBe("Mida: no context available right now (bad-input).")
  }, 30_000)

  it("valid JSON with no event name is not a SessionStart — stdout stays empty", async () => {
    const res = await run(["claude-code"], "{}", home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("")
  }, 30_000)

  it("a Stop event prints nothing and exits 0", async () => {
    const res = await run(["claude-code"], JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp/work" }), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("")
  }, 30_000)

  it("a SessionStart with no daemon prints the daemon-down envelope and exits 0", async () => {
    // a home with no network.json can never have a daemon — nothing is spawned
    const res = await run(["claude-code"], sessionStart(), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    const out = envelope(res.stdout)
    expect(out.systemMessage).toBe("Mida: could not load context (daemon-down) — working without it")
    expect(out.hookSpecificOutput.additionalContext).toBe("Mida: no context available right now (daemon-down).")
  }, 30_000)

  it("a SessionStart against a live daemon wraps the daemon's text in the envelope", async () => {
    const { dir, server } = await liveDaemon(handoffBody({ checkpoints: 2, facts: 1 }))
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: handoff loaded — 2 checkpoints, 1 fact (from claude-code, 3 min ago)")
      expect(out.hookSpecificOutput.additionalContext).toBe("CTX-BODY")
    } finally {
      await close(server)
    }
  }, 30_000)

  it("the empty outcome gets the connected line, still inside the envelope", async () => {
    const { dir, server } = await liveDaemon({ kind: "empty", text: "Mida: connected. Nothing has been saved for this project yet." })
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: connected — nothing saved for this project yet")
      expect(out.hookSpecificOutput.additionalContext).toBe("Mida: connected. Nothing has been saved for this project yet.")
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a revoked refusal names the agent and the owner; not-approved names the fix", async () => {
    const revoked = await liveDaemon({ kind: "refused", reason: "revoked", text: "REFUSED-TEXT" })
    try {
      const res = await run(["codex"], sessionStart(), revoked.dir.root)
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: codex has no access to this project (revoked by the owner). Revoking stops future reads; it cannot recall what this agent already read.")
      expect(out.hookSpecificOutput.additionalContext).toBe("REFUSED-TEXT")
    } finally {
      await close(revoked.server)
    }
    const pending = await liveDaemon({ kind: "refused", reason: "not-approved", text: "REFUSED-TEXT" })
    try {
      const res = await run(["claude-code"], sessionStart(), pending.dir.root)
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: claude-code has no access to this project (not approved yet — run: mida approve claude-code in this folder)")
    } finally {
      await close(pending.server)
    }
  }, 60_000)

  it("the systemMessage never carries a 40+ hex run even when the daemon sends one", async () => {
    const hex = `0x${"ab".repeat(32)}`
    const { dir, server } = await liveDaemon(handoffBody({ savedBy: hex }))
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      const out = envelope(res.stdout)
      expect(out.systemMessage).not.toContain(hex)
      expect(out.systemMessage).not.toMatch(/[0-9a-f]{40}/)
      expect(out.systemMessage).toContain("<hex>")
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a handoff text with quotes, newlines and </script> round-trips through the envelope intact", async () => {
    const text = 'he said "go"\nline two\n</script><script>x</script>\n=== END MIDA HANDOFF DATA ==='
    const { dir, server } = await liveDaemon(handoffBody({ text }))
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      const out = envelope(res.stdout)
      expect(out.hookSpecificOutput.additionalContext).toBe(text)
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a daemon that answers junk gets the bad-reply envelope, still exit 0", async () => {
    const { dir, server } = await liveDaemon({ kind: "handoff" })
    try {
      const res = await run(["claude-code"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: could not load context (bad-reply) — working without it")
      expect(out.hookSpecificOutput.additionalContext).toBe("Mida: no context available right now (bad-reply).")
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a daemon that accepts but never answers prints daemon-down inside the client timeout", async () => {
    const { dir, server } = await liveDaemon(null, true)
    try {
      const started = Date.now()
      const res = await run(["claude-code"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: could not load context (daemon-down) — working without it")
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a served handoff records the covered contextIds as the session's seen set", async () => {
    const { dir, server } = await liveDaemon(handoffBody({ seen: ["0xcovered-1", "0xcovered-2"] }))
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(readSeen(dir, "s1")).toEqual(new Set(["0xcovered-1", "0xcovered-2"]))
    } finally {
      await close(server)
    }
  }, 30_000)

  it("an empty handoff records the empty baseline so the first real save shows as new", async () => {
    const { dir, server } = await liveDaemon({ kind: "empty", text: "x", seen: [] })
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(readSeen(dir, "s1")).toEqual(new Set())
      // the baseline file exists — the session started and saw nothing
      expect(dir.has("state/lastseen/s1.json")).toBe(true)
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a refused handoff records nothing — the agent never had a baseline", async () => {
    const { dir, server } = await liveDaemon({ kind: "refused", reason: "revoked", text: "x" })
    try {
      const res = await run(["codex"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(dir.has("state/lastseen/s1.json")).toBe(false)
    } finally {
      await close(server)
    }
  }, 30_000)
})

/**
 * A socket server like fakeDaemon that also records the JSON body of each request — the devin
 * tests assert the folder Mida forwards came from DEVIN_PROJECT_DIR, not a payload `cwd`
 * (Devin's hook payload has none).
 */
const captureDaemon = (dir: MidaHome, handoffBody: unknown): Promise<{ server: Server; bodies: Record<string, unknown>[] }> =>
  new Promise((resolve, reject) => {
    const bodies: Record<string, unknown>[] = []
    const s = createServer((socket: Socket) => {
      socket.on("data", (data) => {
        const text = data.toString("utf8")
        const path = text.split(" ")[1]
        const bodyText = text.slice(text.indexOf("\r\n\r\n") + 4)
        if (bodyText) {
          try { bodies.push(JSON.parse(bodyText) as Record<string, unknown>) } catch { /* not JSON */ }
        }
        const payload = JSON.stringify(path === "/handoff" || path === "/whatsnew" ? handoffBody : { ok: true, pid: 1 })
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`)
      })
    })
    s.once("error", reject)
    s.listen(socketPathFor(dir), () => resolve({ server: s, bodies }))
  })

describe("inject-main process — devin payload", () => {
  // Devin's hook stdin is session_id + prompt_id + per-event fields: no cwd, no
  // transcript_path. The project folder arrives on the environment as DEVIN_PROJECT_DIR.
  const devinSessionStart = () => JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", prompt_id: "p9", source: "startup" })
  const devinPrompt = () => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p9", prompt: "go on" })

  it("a devin SessionStart answers the envelope and forwards DEVIN_PROJECT_DIR as the project cwd", async () => {
    const dir = home()
    dir.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: {} })
    const { server, bodies } = await captureDaemon(dir, { kind: "empty", text: "Mida: connected. Nothing has been saved for this project yet." })
    try {
      const res = await run(["devin"], devinSessionStart(), dir.root, { DEVIN_PROJECT_DIR: "/tmp/devin-work" })
      expect(res.status).toBe(0)
      const out = envelope(res.stdout)
      expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart")
      expect(out.hookSpecificOutput.additionalContext).toContain("Nothing has been saved")
      const handoff = bodies.find((b) => typeof b.agent === "string")
      expect(handoff).toMatchObject({ agent: "devin", cwd: "/tmp/devin-work", sessionId: "s1" })
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a devin UserPromptSubmit forwards DEVIN_PROJECT_DIR and prints the update envelope", async () => {
    const dir = home()
    const { server, bodies } = await captureDaemon(dir, {
      kind: "updates",
      note: "Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):\n- codex: did the thing",
      updates: [{ agent: "codex", savedAt: new Date().toISOString() }],
      seen: ["0xseen"],
    })
    try {
      const res = await run(["devin"], devinPrompt(), dir.root, { DEVIN_PROJECT_DIR: "/tmp/devin-work" })
      expect(res.status).toBe(0)
      const out = envelope(res.stdout)
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
      expect(out.hookSpecificOutput.additionalContext).toContain("did the thing")
      expect(bodies[0]).toMatchObject({ agent: "devin", cwd: "/tmp/devin-work", sessionId: "s1" })
    } finally {
      await close(server)
    }
  }, 30_000)

  it("an unknown or malformed devin payload prints nothing and never crashes", async () => {
    for (const input of [
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "exec" }),
      JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1" }),
      JSON.stringify({ event: "SessionStart" }), // no hook_event_name at all
      "not json{",
    ]) {
      const res = await run(["devin"], input, home().root, { DEVIN_PROJECT_DIR: "/tmp/devin-work" })
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      // a malformed payload may print the bad-input envelope; an unknown event prints nothing
      if (res.stdout !== "") {
        const out = envelope(res.stdout)
        expect(out.systemMessage).toContain("could not load context")
      }
    }
  }, 60_000)
})

describe("inject-main process — foreign-client guard", () => {
  // Devin runs the hooks it imported from other clients' config with DEVIN_PROJECT_DIR set on
  // the process. A mida-inject entry for any agent but devin firing there is a replay: no
  // socket call, no output, one log line.
  it("a SessionStart inside Devin prints nothing and never reaches the daemon", async () => {
    const { dir, server } = await liveDaemon(handoffBody())
    try {
      const res = await run(["claude-code"], sessionStart(), dir.root, { DEVIN_PROJECT_DIR: "/tmp/work" })
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("")
      const log = readFileSync(dir.path("logs/hook.jsonl"), "utf8")
      expect(log).toContain('"reason":"foreign-client"')
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a UserPromptSubmit inside Devin prints nothing and never reaches the daemon", async () => {
    const dir = home()
    let requests = 0
    const daemon = await whatsnewDaemon(dir, { kind: "updates", note: "N", updates: [], seen: [] })
    daemon.server.on("connection", () => { requests += 1 })
    try {
      const res = await run(["codex"], promptSubmit(), dir.root, { DEVIN_PROJECT_DIR: "/tmp/work" })
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("")
      expect(readFileSync(dir.path("logs/hook.jsonl"), "utf8")).toContain('"reason":"foreign-client"')
    } finally {
      await daemon.stop()
    }
  }, 30_000)

  it("a devin entry inside Devin's environment is NOT guarded — it runs normally", async () => {
    const { dir, server } = await liveDaemon({ kind: "empty", text: "Mida: connected. Nothing has been saved for this project yet." })
    try {
      const res = await run(["devin"], sessionStart(), dir.root, { DEVIN_PROJECT_DIR: "/tmp/work" })
      expect(res.status).toBe(0)
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: connected — nothing saved for this project yet")
    } finally {
      await close(server)
    }
  }, 30_000)
})

describe("inject-main process — UserPromptSubmit", () => {
  it("an update prints the envelope with the owner's line and the note, then marks the ids seen", async () => {
    const dir = home()
    writeSeen(dir, "s1", ["0xearlier"])
    const savedAt = new Date(Date.now() - 40_000).toISOString()
    const daemon = await whatsnewDaemon(dir, {
      kind: "updates",
      note: "Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):\n- codex: did the thing",
      updates: [{ agent: "codex", savedAt }],
      seen: ["0xearlier", "0xnew-delivered"],
    })
    try {
      const res = await run(["claude-code"], promptSubmit(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      const out = envelope(res.stdout)
      expect(out.systemMessage).toMatch(/^Mida: update from codex \(\d+ s ago\)$/)
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
      expect(out.hookSpecificOutput.additionalContext).toContain("did the thing")
      // the delivered ids are recorded — a second prompt sees nothing
      expect(readSeen(dir, "s1")).toEqual(new Set(["0xearlier", "0xnew-delivered"]))
    } finally {
      await daemon.stop()
    }
  }, 30_000)

  it("nothing new prints nothing at all — no JSON, no empty note — and the seen set is untouched", async () => {
    const dir = home()
    writeSeen(dir, "s1", ["0xkeep"])
    const daemon = await whatsnewDaemon(dir, { kind: "none" })
    try {
      const res = await run(["claude-code"], promptSubmit(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("")
      expect(readSeen(dir, "s1")).toEqual(new Set(["0xkeep"]))
    } finally {
      await daemon.stop()
    }
  }, 30_000)

  it("a refused agent prints nothing — the refusal is the daemon's to log, not the prompt's to show", async () => {
    const dir = home()
    const daemon = await whatsnewDaemon(dir, { kind: "refused", reason: "revoked" })
    try {
      const res = await run(["codex"], promptSubmit(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("")
    } finally {
      await daemon.stop()
    }
  }, 30_000)

  it("a daemon that answers late gets silence — the prompt never waits past 1.5 s, and the give-up is logged", async () => {
    const dir = home()
    const daemon = await whatsnewDaemon(dir, { kind: "updates", note: "N", updates: [], seen: [] }, { delayMs: 5_000 })
    try {
      const started = Date.now()
      const res = await run(["claude-code"], promptSubmit(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("")
      // the child gave up at its 1.5 s ceiling, far before the daemon's 5 s answer
      expect(Date.now() - started).toBeLessThan(4_000)
      // silence for the model, but the give-up is visible in the hook log for doctor to count
      const hookLog = readFileSync(dir.path("logs/hook.jsonl"), "utf8")
      const entries = hookLog.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { event?: string })
      expect(entries.some((e) => e.event === "whatsnew-timeout")).toBe(true)
    } finally {
      await daemon.stop()
    }
  }, 30_000)

  it("no daemon at all is just another silent prompt, exit 0", async () => {
    const res = await run(["claude-code"], promptSubmit(), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("")
  }, 30_000)

  it("a malformed whats-new answer prints nothing", async () => {
    const dir = home()
    const daemon = await whatsnewDaemon(dir, { kind: "updates" }) // note missing
    try {
      const res = await run(["claude-code"], promptSubmit(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stdout).toBe("")
    } finally {
      await daemon.stop()
    }
  }, 30_000)
})
