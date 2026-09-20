import { afterAll, describe, expect, it } from "vitest"
import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, SOCKET_FILE, callDaemon, ensureDaemon, socketPathFor } from "@mida/midad"

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

  it("falls back to a short tmpdir name when the home path would exceed the socket limit", () => {
    // deep enough that <root>/midad.sock is longer than 100 bytes
    const deep = join(tmpdir(), "mida-deep-" + "d".repeat(60), "e".repeat(60), "home")
    const home = new MidaHome(deep)
    expect(Buffer.byteLength(home.path(SOCKET_FILE))).toBeGreaterThan(100)
    const resolved = socketPathFor(home)
    expect(resolved.startsWith(tmpdir())).toBe(true)
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

describe("callDaemon", () => {
  it("resolves status 0 fast when no socket exists", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctl-")))
    const started = Date.now()
    const reply = await callDaemon(home, "/health", undefined, { timeoutMs: 5_000 })
    expect(reply).toEqual({ status: 0, body: null })
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
      expect(reply).toEqual({ status: 0, body: null })
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
      expect(reply).toEqual({ status: 0, body: null })
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
})
