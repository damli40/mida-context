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

describe("inject-main process", () => {
  it("a missing agent name prints the bad-agent line and still exits 0", async () => {
    const res = await run([], sessionStart(), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("Mida: no context available right now (bad-agent).\n")
  }, 30_000)

  it("an unsafe agent name prints the bad-agent line and never reaches the daemon", async () => {
    for (const agent of ["../agents", "..", "a b"]) {
      const res = await run([agent], sessionStart(), home().root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("Mida: no context available right now (bad-agent).\n")
    }
  }, 60_000)

  it("2 MB of junk stdin prints one bad-input line, exits 0, writes nothing to stderr", async () => {
    const res = await run(["claude-code"], "z".repeat(2 * 1024 * 1024), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("Mida: no context available right now (bad-input).\n")
  }, 30_000)

  it("stdin that is not JSON prints the bad-input line", async () => {
    const res = await run(["claude-code"], "this is not json{", home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("Mida: no context available right now (bad-input).\n")
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

  it("a SessionStart with no daemon prints the daemon-down line and exits 0", async () => {
    // a home with no network.json can never have a daemon — nothing is spawned
    const res = await run(["claude-code"], sessionStart(), home().root)
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
    expect(res.stdout).toBe("Mida: no context available right now (daemon-down).\n")
  }, 30_000)

  it("a SessionStart against a live daemon prints exactly the text the daemon answered", async () => {
    const dir = home()
    // init's marker: with it the hook tries the socket instead of refusing daemon-down at once
    dir.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: {} })
    const server = await fakeDaemon(dir, { kind: "handoff", text: "CTX-BODY" })
    try {
      const res = await run(["claude-code"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("CTX-BODY\n")
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a daemon that answers junk gets the bad-reply line, still exit 0", async () => {
    const dir = home()
    dir.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: {} })
    const server = await fakeDaemon(dir, { kind: "handoff" })
    try {
      const res = await run(["claude-code"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("Mida: no context available right now (bad-reply).\n")
    } finally {
      await close(server)
    }
  }, 30_000)

  it("a daemon that accepts but never answers prints daemon-down inside the client timeout", async () => {
    const dir = home()
    dir.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: {} })
    // /health answers (so no spawn storm) but /handoff stays silent — the 8 s client timeout applies
    const server = await fakeDaemon(dir, null, true)
    try {
      const started = Date.now()
      const res = await run(["claude-code"], sessionStart(), dir.root)
      expect(res.status).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toBe("Mida: no context available right now (daemon-down).\n")
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await close(server)
    }
  }, 30_000)
})
