import { existsSync, readFileSync } from "node:fs"
import { request } from "node:http"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { MidaSdkError } from "./errors.js"

/**
 * The client half of midad's control socket — the same file layout `apps/midad/src/control.ts`
 * owns, kept deliberately small: the daemon decides everything; this side only reaches it.
 */

const SOCKET_FILE = "midad.sock"
/** Unix socket paths cap at ~104 bytes on macOS; keep the same margin the daemon keeps. */
const SOCKET_PATH_LIMIT = 100

/**
 * Where the Mida home lives for this SDK: the `home` option, then `$MIDA_HOME` (absolute, like
 * the CLI insists), then `~/.mida`. The SDK never creates the folder — a home that does not
 * exist simply means the service is not running.
 */
export function resolveMidaHome(home: string | undefined, env: Record<string, string | undefined> = process.env): string {
  const root = home ?? (env.MIDA_HOME !== undefined && env.MIDA_HOME !== "" ? env.MIDA_HOME : undefined) ?? join(homedir(), ".mida")
  if (root === "" || !isAbsolute(root)) {
    throw new MidaSdkError("invalid-option", "the Mida home must be an absolute path (or unset for the default ~/.mida)")
  }
  return resolve(root)
}

/**
 * The same socket path the daemon computes: `<home>/midad.sock`, a pointer file
 * (`midad.sock.path`) winning when present, and the per-user fallback folder
 * `<base>/mida-<uid>/mida-<16 hex of sha256(home)>.sock` when the direct path is too long.
 * Must stay byte-for-byte equivalent to control.ts's `socketPathFor` — the daemon writes the
 * pointer for exactly the cases the computed path would miss.
 */
export function socketPathFor(home: string, base: string = tmpdir()): string {
  try {
    const pointer = join(home, `${SOCKET_FILE}.path`)
    if (existsSync(pointer)) {
      const text = readFileSync(pointer, "utf8").trim()
      if (text !== "") return text
    }
  } catch {
    // a pointer that will not read is ignored — the computed fallback still agrees with the daemon
  }
  const direct = join(home, SOCKET_FILE)
  if (Buffer.byteLength(direct) <= SOCKET_PATH_LIMIT) return direct
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  return join(base, `mida-${uid}`, `mida-${bytesToHex(sha256(utf8ToBytes(home))).slice(0, 16)}.sock`)
}

export interface DaemonReply {
  /** 0 means no answer — no socket, refused connection, timeout, or a non-JSON body. */
  status: number
  body: unknown
}

/**
 * One JSON call to the daemon over the private socket. Never throws and never hangs: any failure
 * resolves to status 0, and the caller turns that into `service-unavailable`. A body of
 * `undefined` sends GET; anything else is POSTed as JSON.
 */
export function callDaemon(home: string, path: string, body: unknown, options: { timeoutMs: number }): Promise<DaemonReply> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (reply: DaemonReply) => {
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
          headers: payload === null ? {} : { "content-type": "application/json", "content-length": payload.length },
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
