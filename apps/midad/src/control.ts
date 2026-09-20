import { existsSync, readFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import type { MidaHome } from "./home.js"

export const SOCKET_FILE = "midad.sock"

/** Unix socket paths cap at ~104 bytes on macOS; keep a margin for platform differences. */
const SOCKET_PATH_LIMIT = 100

/**
 * Where this home's control socket lives. Normally `<home>/midad.sock`; when that path would be too
 * long for a Unix socket, a deterministic name in the system temp folder instead — `mida-<16 hex of
 * sha256(home)>.sock` — which the daemon also records in `<home>/midad.sock.path` so the real path
 * is discoverable. A present, non-empty pointer file wins either way.
 */
export function socketPathFor(home: MidaHome): string {
  try {
    const pointer = home.path(`${SOCKET_FILE}.path`)
    if (existsSync(pointer)) {
      const text = readFileSync(pointer, "utf8").trim()
      if (text !== "") return text
    }
  } catch {
    // a pointer that will not read is ignored — the computed fallback still agrees with the daemon
  }
  const direct = home.path(SOCKET_FILE)
  if (Buffer.byteLength(direct) <= SOCKET_PATH_LIMIT) return direct
  return join(tmpdir(), `mida-${bytesToHex(sha256(utf8ToBytes(home.root))).slice(0, 16)}.sock`)
}

export interface ControlReply {
  status: number
  body: unknown
}

/**
 * One JSON call to the daemon over the private socket. Never throws and never hangs: any failure —
 * no socket, refused connection, timeout, a reply that is not JSON — resolves to status 0. A body
 * of `undefined` sends GET; anything else is POSTed as JSON.
 */
export function callDaemon(home: MidaHome, path: string, body: unknown, options: { timeoutMs: number }): Promise<ControlReply> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (reply: ControlReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(reply)
    }
    const fail = () => finish({ status: 0, body: null })
    const timer = setTimeout(() => {
      try {
        req?.destroy()
      } catch {
        // already gone
      }
      fail()
    }, options.timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    let req: ReturnType<typeof request> | undefined
    try {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8")
      req = request(
        {
          socketPath: socketPathFor(home),
          path,
          method: payload === null ? "GET" : "POST",
          headers:
            payload === null
              ? {}
              : { "content-type": "application/json", "content-length": payload.length },
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size <= 1024 * 1024) chunks.push(chunk)
          })
          res.on("end", () => {
            try {
              finish({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
            } catch {
              fail()
            }
          })
          res.on("error", fail)
        },
      )
      req.on("error", fail)
      req.end(payload ?? undefined)
    } catch {
      fail()
    }
  })
}

/**
 * Polls `GET /health` every 100 ms until the daemon answers or `waitMs` passes. The first failed
 * check fires `spawn()` — once per call, never more — so callers that arrive while a spawned daemon
 * is still opening its runtime just keep polling.
 */
export async function ensureDaemon(home: MidaHome, spawn: () => void, options: { waitMs: number }): Promise<boolean> {
  const deadline = Date.now() + options.waitMs
  let spawned = false
  for (;;) {
    const remaining = deadline - Date.now()
    const reply = await callDaemon(home, "/health", undefined, { timeoutMs: Math.min(500, Math.max(1, remaining)) })
    if (reply.status !== 0) return true
    if (!spawned) {
      spawned = true
      try {
        spawn()
      } catch {
        // a spawn that fails synchronously still leaves the poll to run out the clock
      }
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
}
