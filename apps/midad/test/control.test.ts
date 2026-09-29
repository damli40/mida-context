import { afterAll, describe, expect, it } from "vitest"
import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { MidaHome, SOCKET_FILE, callDaemon, ensureDaemon, ensureFallbackSocketDir, fallbackSocketDir, socketPathFor } from "@mida/midad"
import { ensureCurrentDaemon, ensureDaemonState } from "../src/control.js"

/** A Unix-socket server the test controls by hand; `onRequest` decides what a connection gets. */
function fakeDaemon(socketPath: string, onRequest: (socket: Socket, data: Buffer) => void): Promise<Server> {
  const server = createServer((socket) => {
    const chunks: Buffer[] = []
    socket.on("data", (chunk) => {
      chunks.push(chunk)
      onRequest(socket, Buffer.concat(chunks))
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve(server))
  })
}

const replyJson = (socket: Socket, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  socket.end(
    `HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
  )
}

const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

describe("socketPathFor", () => {
  it("is <home>/midad.sock for a normal home", () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    expect(socketPathFor(home)).toBe(home.path(SOCKET_FILE))
  })

  it("falls back inside a private per-user tmpdir folder when the home path would exceed the socket limit", () => {
    // deep enough that <root>/midad.sock is longer than 100 bytes
    const deep = join(tmpdir(), "mida-deep-" + "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    expect(Buffer.byteLength(home.path(SOCKET_FILE))).toBeGreaterThan(100)
    const resolved = socketPathFor(home)
    // the socket never sits loose in the shared temp folder — it lives in <tmp>/mida-<uid>/
    expect(dirname(resolved)).toBe(fallbackSocketDir())
    expect(resolved).not.toBe(home.path(SOCKET_FILE))
    expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(100)
    // the same home resolves to the same fallback every time
    expect(socketPathFor(new MidaHome(deep))).toBe(resolved)
  })

  it("honours a midad.sock.path pointer file when present", () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const pointed = join(tmpdir(), "mida-pointed-test.sock")
    writeFileSync(home.path(`${SOCKET_FILE}.path`), pointed, { mode: 0o600 })
    expect(socketPathFor(home)).toBe(pointed)
  })
})

describe("ensureFallbackSocketDir", () => {
  it("creates a missing folder itself as a private 0700 directory owned by this user", () => {
    const base = mkdtempSync(join(tmpdir(), "mida-sockbase-"))
    const dir = ensureFallbackSocketDir(base)
    const stat = lstatSync(dir)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    expect(stat.uid).toBe(process.getuid!())
  })

  it("reuses the folder it made, but refuses one that exists with looser permissions", () => {
    const base = mkdtempSync(join(tmpdir(), "mida-sockbase-"))
    const dir = ensureFallbackSocketDir(base)
    expect(ensureFallbackSocketDir(base)).toBe(dir)
    chmodSync(dir, 0o777)
    expect(() => ensureFallbackSocketDir(base)).toThrow(/0700/)
    chmodSync(dir, 0o700)
    expect(() => ensureFallbackSocketDir(base)).not.toThrow()
  })

  it("refuses a symlink or a plain file standing in for the folder", () => {
    const base = mkdtempSync(join(tmpdir(), "mida-sockbase-"))
    symlinkSync(mkdtempSync(join(tmpdir(), "mida-real-")), fallbackSocketDir(base))
    expect(() => ensureFallbackSocketDir(base)).toThrow(/0700/)
    const base2 = mkdtempSync(join(tmpdir(), "mida-sockbase-"))
    writeFileSync(fallbackSocketDir(base2), "")
    expect(() => ensureFallbackSocketDir(base2)).toThrow(/0700/)
  })
})

describe("callDaemon", () => {
  it("resolves status 0 fast when no socket exists", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const started = Date.now()
    const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 5_000 })
    expect(reply).toEqual({ status: 0, body: null, failure: "unreachable" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("parses the JSON reply and status from a real socket server", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const server = await fakeDaemon(socketPathFor(home), (socket) => replyJson(socket, 200, { ok: true, pid: 4321 }))
    try {
      const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 1_000 })
      expect(reply.status).toBe(200)
      expect(reply.body).toEqual({ ok: true, pid: 4321 })
    } finally {
      await close(server)
    }
  })

  it("posts the body and resolves status 0 when the daemon never answers", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    // accepts the connection and stays silent — the timeout alone ends the call
    const server = await fakeDaemon(socketPathFor(home), () => {})
    try {
      const started = Date.now()
      const reply = await callDaemon(home, "/kick", {}, { timeoutMs: 150 })
      expect(reply).toEqual({ status: 0, body: null, failure: "timeout" })
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      await close(server)
    }
  })

  it("resolves status 0 on a reply that is not JSON", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const server = await fakeDaemon(socketPathFor(home), (socket) => {
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nabc")
    })
    try {
      const reply = await callDaemon(home, "/kick", {}, { timeoutMs: 1_000 })
      expect(reply).toEqual({ status: 0, body: null, failure: "bad-reply" })
    } finally {
      await close(server)
    }
  })
})

describe("ensureDaemon", () => {
  it("returns true without spawning when the daemon already answers", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const server = await fakeDaemon(socketPathFor(home), (socket) => replyJson(socket, 200, { ok: true }))
    try {
      let spawned = 0
      const up = await ensureDaemon(home, () => { spawned += 1 }, { waitMs: 2_000 })
      expect(up).toBe(true)
      expect(spawned).toBe(0)
    } finally {
      await close(server)
    }
  })

  it("spawns once after the first failed health check, then gives up after waitMs", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    let spawned = 0
    const started = Date.now()
    const up = await ensureDaemon(home, () => { spawned += 1 }, { waitMs: 350 })
    expect(up).toBe(false)
    expect(spawned).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("ensureDaemonState: a listening socket that never answers /health is slow, not down", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    // accepts the connection and stays silent — connected, just not answering
    const server = await fakeDaemon(socketPathFor(home), () => {})
    try {
      let spawned = 0
      const state = await ensureDaemonState(home, () => { spawned += 1 }, { waitMs: 800 })
      expect(state).toBe("slow")
      expect(spawned).toBe(1)
    } finally {
      await close(server)
    }
  })

  it("ensureDaemonState: no socket at all is down — unreachable, never a timeout", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    let spawned = 0
    const state = await ensureDaemonState(home, () => { spawned += 1 }, { waitMs: 300 })
    expect(state).toBe("down")
    expect(spawned).toBe(1)
  })

  it("ensureDaemonState: a missing socket stays 'down' through a truncated final probe — 200 runs (in-38 V-2)", async () => {
    // waitMs ~615 makes the loop's last probe start with ~1 ms left: that probe's timer can
    // fire before the missing socket's refusal arrives, which used to be scored "timeout" and
    // mislabel a plainly-absent daemon "slow" about one run in fourteen. The runs go together
    // on purpose — it is event-loop jitter that makes the 1 ms race lose, exactly as in
    // production when the machine is busy.
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const states = await Promise.all(Array.from({ length: 200 }, () => ensureDaemonState(home, () => {}, { waitMs: 615 })))
    expect(states.every((state) => state === "down")).toBe(true)
  })

  it("ensureDaemonState starts no probe once the wait budget is spent (in-38 V-2)", async () => {
    // waitMs 530 spends it on one 500 ms probe plus a ~30 ms sleep — the next loop turn has no
    // budget left. The old code still connected once more with a 1 ms timeout, and the silent
    // server counts that extra connection in its accept backlog however fast it closes.
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    let connections = 0
    const server = createServer((socket) => {
      connections += 1
      socket.resume() // read the probe's request so its FIN arrives — else server.close() waits on it
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPathFor(home), () => resolve())
    })
    try {
      const state = await ensureDaemonState(home, () => {}, { waitMs: 530 })
      expect(state).toBe("slow") // the one probe that fit the budget went the whole 500 ms unanswered
      expect(connections).toBe(1) // and nothing probed after the budget was gone
    } finally {
      await close(server)
    }
  })

  it("ensureDaemonState: a silent socket is still 'slow' when the last probe is truncated", async () => {
    // Same truncated tail as the missing-socket run, but here something holds the socket:
    // the first probe's full-length timeout already proved "slow" — the tail must not undo it.
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const server = await fakeDaemon(socketPathFor(home), () => {})
    try {
      const state = await ensureDaemonState(home, () => {}, { waitMs: 615 })
      expect(state).toBe("slow")
    } finally {
      await close(server)
    }
  })
})

/**
 * A fake daemon that speaks just enough HTTP for the identity check: `onRequest` gets the method
 * and path once the whole request has arrived (headers plus any content-length body). The socket
 * file is unlinked before binding so a replacement can take the same path.
 */
function fakeHttpDaemon(
  socketPath: string,
  onRequest: (req: { method: string; path: string }, socket: Socket) => void,
): Promise<Server> {
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0)
    let fired = false
    socket.on("data", (chunk) => {
      if (fired) return
      buf = Buffer.concat([buf, chunk])
      const headEnd = buf.indexOf("\r\n\r\n")
      if (headEnd === -1) return
      const length = /content-length:\s*(\d+)/i.exec(buf.toString("utf8", 0, headEnd))
      if (buf.length < headEnd + 4 + (length === null ? 0 : Number(length[1]))) return
      fired = true
      const [method = "", path = ""] = buf.toString("utf8", 0, buf.indexOf("\r\n")).split(" ")
      onRequest({ method, path }, socket)
    })
  })
  rmSync(socketPath, { force: true })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve(server))
  })
}

/** close() on an already-stopped server must not hang the test's cleanup. */
const closeQuiet = (server: Server | undefined) =>
  new Promise<void>((done) => {
    if (server === undefined) return done()
    try {
      server.close(() => done())
    } catch {
      done()
    }
  })

describe("ensureCurrentDaemon", () => {
  it("a daemon running the same code is used as-is — no shutdown, no spawn", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const posts: string[] = []
    const server = await fakeHttpDaemon(socketPathFor(home), (req, socket) => {
      if (req.method === "POST") posts.push(req.path)
      replyJson(socket, 200, { ok: true, pid: 1, codeRoot: "/code/here", codeCommit: "abc1234" })
    })
    try {
      let spawned = 0
      const result = await ensureCurrentDaemon(home, () => { spawned += 1 }, {
        waitMs: 2_000,
        self: { codeRoot: "/code/here", codeCommit: "abc1234" },
      })
      expect(result).toEqual({ up: true })
      expect(spawned).toBe(0)
      expect(posts).toEqual([])
    } finally {
      await closeQuiet(server)
    }
  })

  it("a daemon down is spawned and waited for, exactly like ensureDaemon", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    let spawned = 0
    let server: Server | undefined
    const result = await ensureCurrentDaemon(home, () => {
      spawned += 1
      void fakeHttpDaemon(socketPathFor(home), (req, socket) =>
        replyJson(socket, 200, { ok: true, pid: 2, codeRoot: "/code/here", codeCommit: "abc1234" }),
      ).then((s) => { server = s })
    }, { waitMs: 5_000, self: { codeRoot: "/code/here", codeCommit: "abc1234" } })
    try {
      expect(result).toEqual({ up: true })
      expect(spawned).toBe(1)
    } finally {
      await closeQuiet(server)
    }
  })

  it("a daemon reporting a different commit gets one /shutdown, then is replaced", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const posts: string[] = []
    const oldServer = await fakeHttpDaemon(socketPathFor(home), (req, socket) => {
      if (req.method === "POST") {
        posts.push(req.path)
        replyJson(socket, 200, { ok: true })
        if (req.path === "/shutdown") void closeQuiet(oldServer)
        return
      }
      replyJson(socket, 200, { ok: true, pid: 7, codeRoot: "/code/here", codeCommit: "old1234" })
    })
    let spawned = 0
    let replacement: Server | undefined
    const result = await ensureCurrentDaemon(home, () => {
      spawned += 1
      void fakeHttpDaemon(socketPathFor(home), (req, socket) =>
        replyJson(socket, 200, { ok: true, pid: 8, codeRoot: "/code/here", codeCommit: "new5678" }),
      ).then((s) => { replacement = s })
    }, { waitMs: 5_000, self: { codeRoot: "/code/here", codeCommit: "new5678" } })
    try {
      expect(result.up).toBe(true)
      expect(result.replaced).toEqual({ codeRoot: "/code/here", codeCommit: "old1234", pid: 7 })
      expect(posts).toEqual(["/shutdown"])
      expect(spawned).toBe(1)
    } finally {
      await closeQuiet(replacement)
      await closeQuiet(oldServer)
    }
  })

  it("a daemon that cannot name its code (no codeRoot in /health) is replaced too", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const oldServer = await fakeHttpDaemon(socketPathFor(home), (req, socket) => {
      if (req.method === "POST") {
        replyJson(socket, 200, { ok: true })
        if (req.path === "/shutdown") void closeQuiet(oldServer)
        return
      }
      // a /health body from before code reporting existed: ok and pid, nothing else
      replyJson(socket, 200, { ok: true, pid: 9 })
    })
    let replacement: Server | undefined
    const result = await ensureCurrentDaemon(home, () => {
      void fakeHttpDaemon(socketPathFor(home), (req, socket) =>
        replyJson(socket, 200, { ok: true, pid: 10, codeRoot: "/code/here", codeCommit: "abc1234" }),
      ).then((s) => { replacement = s })
    }, { waitMs: 5_000, self: { codeRoot: "/code/here", codeCommit: "abc1234" } })
    try {
      expect(result.up).toBe(true)
      expect(result.replaced).toMatchObject({ codeRoot: "unknown", codeCommit: "unknown", pid: 9 })
    } finally {
      await closeQuiet(replacement)
      await closeQuiet(oldServer)
    }
  })

  it('"unknown" counts as equal only when BOTH sides are unknown', async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    // both sides "unknown" — nothing to compare, so nothing is replaced
    const sameServer = await fakeHttpDaemon(socketPathFor(home), (req, socket) =>
      replyJson(socket, 200, { ok: true, pid: 1, codeRoot: "/code/here", codeCommit: "unknown" }),
    )
    try {
      const result = await ensureCurrentDaemon(home, () => { throw new Error("must not spawn") }, {
        waitMs: 2_000,
        self: { codeRoot: "/code/here", codeCommit: "unknown" },
      })
      expect(result).toEqual({ up: true })
    } finally {
      await closeQuiet(sameServer)
    }

    // one side real, one side "unknown" — that IS a difference and the service is replaced
    const home2 = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const oldServer = await fakeHttpDaemon(socketPathFor(home2), (req, socket) => {
      if (req.method === "POST") {
        replyJson(socket, 200, { ok: true })
        if (req.path === "/shutdown") void closeQuiet(oldServer)
        return
      }
      replyJson(socket, 200, { ok: true, pid: 3, codeRoot: "/code/here", codeCommit: "unknown" })
    })
    let replacement: Server | undefined
    const result = await ensureCurrentDaemon(home2, () => {
      void fakeHttpDaemon(socketPathFor(home2), (req, socket) =>
        replyJson(socket, 200, { ok: true, pid: 4, codeRoot: "/code/here", codeCommit: "abc1234" }),
      ).then((s) => { replacement = s })
    }, { waitMs: 5_000, self: { codeRoot: "/code/here", codeCommit: "abc1234" } })
    try {
      expect(result.up).toBe(true)
      expect(result.replaced).toMatchObject({ codeCommit: "unknown", pid: 3 })
    } finally {
      await closeQuiet(replacement)
      await closeQuiet(oldServer)
    }
  })

  it("a daemon that ignores /shutdown earns a refusal naming the pid, both roots and how to stop it", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    // answers /shutdown politely but never actually stops — the wait must give up, not hang
    const server = await fakeHttpDaemon(socketPathFor(home), (req, socket) => {
      if (req.method === "POST") {
        replyJson(socket, 200, { ok: true })
        return
      }
      replyJson(socket, 200, { ok: true, pid: 4242, codeRoot: "/old/root", codeCommit: "cafe1234567" })
    })
    try {
      let spawned = 0
      const started = Date.now()
      const result = await ensureCurrentDaemon(home, () => { spawned += 1 }, {
        waitMs: 5_000,
        shutdownWaitMs: 200,
        self: { codeRoot: "/new/root", codeCommit: "beef7654321" },
      })
      expect(result.up).toBe(false)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(result.refusal).toContain("the Mida service (pid 4242) runs code from /old/root @ cafe123")
      expect(result.refusal).toContain("this command runs /new/root @ beef765")
      expect(result.refusal).toContain("did not stop")
      expect(result.refusal).toContain("kill 4242")
      // nothing was spawned — the old service never made room
      expect(spawned).toBe(0)
    } finally {
      await closeQuiet(server)
    }
  })
})

describe("the migrate/in-progress marker (migrate B6)", () => {
  const marked = (): MidaHome => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    home.writeSecretJson("migrate/in-progress", { at: "2026-09-23T12:00:00.000Z", target: "0xabc" })
    return home
  }

  it("ensureDaemon returns false fast and never spawns while the marker exists", async () => {
    const home = marked()
    let spawned = 0
    const started = Date.now()
    const up = await ensureDaemon(home, () => { spawned += 1 }, { waitMs: 3_000 })
    expect(up).toBe(false)
    expect(spawned).toBe(0)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("ensureDaemon does not even probe — a socket answering behind the marker changes nothing", async () => {
    const home = marked()
    let probed = 0
    const server = await fakeDaemon(socketPathFor(home), (socket, _data) => {
      probed += 1
      replyJson(socket, 200, { ok: true, pid: 1 })
    })
    try {
      const up = await ensureDaemon(home, () => { throw new Error("must not spawn") }, { waitMs: 2_000 })
      expect(up).toBe(false)
      expect(probed).toBe(0)
    } finally {
      await close(server)
    }
  })

  it("ensureCurrentDaemon returns the migration refusal — no probe, no spawn, no shutdown", async () => {
    const home = marked()
    const posts: string[] = []
    let probed = 0
    const server = await fakeDaemon(socketPathFor(home), (socket, data) => {
      probed += 1
      if (data.toString("utf8").startsWith("POST")) posts.push(data.toString("utf8").split(" ")[1] ?? "")
      replyJson(socket, 200, { ok: true, pid: 1, codeRoot: "/code/here", codeCommit: "abc1234" })
    })
    try {
      let spawned = 0
      const result = await ensureCurrentDaemon(home, () => { spawned += 1 }, {
        waitMs: 3_000,
        self: { codeRoot: "/code/here", codeCommit: "abc1234" },
      })
      expect(result).toEqual({
        up: false,
        refusal: "a migration is in progress — run `mida migrate` to finish it or `mida migrate --undo`",
      })
      expect(spawned).toBe(0)
      expect(probed).toBe(0)
      expect(posts).toEqual([])
    } finally {
      await close(server)
    }
  })
})
