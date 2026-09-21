import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MidaHome, socketPathFor } from "@mida/midad"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const INJECT_MAIN = fileURLToPath(new URL("../src/inject-main.ts", import.meta.url))

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-inject-")))

/**
 * Spawns inject-main as a real child, the way the agent CLI runs the hook. Async, not spawnSync:
 * a synchronous spawn would freeze this process's event loop and the fake daemon below could
 * never answer the child's socket calls.
 */
const run = (args: string[], input: string, homeDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", INJECT_MAIN, ...args], {
      env: { ...process.env, MIDA_HOME: homeDir },
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
      expect(out.systemMessage).toBe("Mida: codex has no access to this project (revoked by the owner)")
      expect(out.hookSpecificOutput.additionalContext).toBe("REFUSED-TEXT")
    } finally {
      await close(revoked.server)
    }
    const pending = await liveDaemon({ kind: "refused", reason: "not-approved", text: "REFUSED-TEXT" })
    try {
      const res = await run(["claude-code"], sessionStart(), pending.dir.root)
      const out = envelope(res.stdout)
      expect(out.systemMessage).toBe("Mida: claude-code has no access to this project (not approved yet — run: mida request claude-code)")
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
})
