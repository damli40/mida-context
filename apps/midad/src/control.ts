import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { codeIdentity } from "./code-identity.js"
import type { CodeIdentity } from "./code-identity.js"
import type { MidaHome } from "./home.js"

export const SOCKET_FILE = "midad.sock"

/** Unix socket paths cap at ~104 bytes on macOS; keep a margin for platform differences. */
const SOCKET_PATH_LIMIT = 100

/**
 * The per-user folder fallback sockets live in: `<base>/mida-<uid>` — one folder per user, never
 * loose in the shared temp folder where another user could plant a socket of the same name.
 */
export function fallbackSocketDir(base: string = tmpdir()): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  return join(base, `mida-${uid}`)
}

/**
 * The daemon's own fallback socket folder, created private (0700) if missing — the daemon makes it
 * itself rather than trusting whatever the shared temp folder happens to hold. A folder that
 * already exists is used only when it is a real directory owned by this user with mode exactly
 * 0700; a symlink, a plain file, another user's folder, or looser permissions refuse the start
 * rather than place a control socket where someone else could reach it.
 */
export function ensureFallbackSocketDir(base: string = tmpdir()): string {
  const dir = fallbackSocketDir(base)
  try {
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700) // a created dir still wears the umask — pin the mode we require
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error
  }
  const stat = lstatSync(dir)
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`refusing to use the fallback socket folder ${dir}: it must be a directory owned by this user with mode 0700`)
  }
  return dir
}

/**
 * Where this home's control socket lives. Normally `<home>/midad.sock`; when that path would be too
 * long for a Unix socket, a deterministic name inside the per-user fallback folder —
 * `<base>/mida-<uid>/mida-<16 hex of sha256(home)>.sock` — which the daemon also records in
 * `<home>/midad.sock.path` so the real path is discoverable. A present, non-empty pointer file wins
 * either way. `base` is the fallback folder's parent; tests inject a private temp dir.
 */
export function socketPathFor(home: MidaHome, base: string = tmpdir()): string {
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
  return join(fallbackSocketDir(base), `mida-${bytesToHex(sha256(utf8ToBytes(home.root))).slice(0, 16)}.sock`)
}

export interface ControlReply {
  status: number
  body: unknown
  /**
   * Why a status-0 reply failed (in-35 R-2) — set only when status is 0: "timeout" means the
   * call's own timer fired (a peer held the connection but never answered), "unreachable" means
   * no peer could be reached at all (missing socket, refused connection, request error), and
   * "bad-reply" means the peer answered with bytes that are not JSON or its stream errored. A
   * timeout is a connected daemon that is slow, not a missing one — callers that only check
   * status keep working unchanged.
   */
  failure?: "timeout" | "unreachable" | "bad-reply"
}

/**
 * One JSON call to the daemon over the private socket. Never throws and never hangs: any failure —
 * no socket, refused connection, timeout, a reply that is not JSON — resolves to status 0 with
 * `failure` naming which kind. A body of `undefined` sends GET; anything else is POSTed as JSON.
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
    const fail = (failure: NonNullable<ControlReply["failure"]>) => finish({ status: 0, body: null, failure })
    const timer = setTimeout(() => {
      // the verdict is recorded before teardown — a destroy can surface a late request error
      // on some Node versions, and a held-but-silent socket is a timeout, never "unreachable"
      fail("timeout")
      try {
        req?.destroy()
      } catch {
        // already gone
      }
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
              fail("bad-reply")
            }
          })
          res.on("error", () => fail("bad-reply"))
        },
      )
      req.on("error", () => fail("unreachable"))
      req.end(payload ?? undefined)
    } catch {
      fail("unreachable")
    }
  })
}

/** The refusal every entry point shares while `migrate/in-progress` exists. */
export const MIGRATION_REFUSAL =
  "a migration is in progress — run `mida migrate` to finish it or `mida migrate --undo`"

/** The marker is a plain file under `migrate/` — `home.path` resolves it even before `migrate/` exists. */
function migrationInProgress(home: MidaHome): boolean {
  try {
    return existsSync(home.path("migrate/in-progress"))
  } catch {
    return false
  }
}

/**
 * The shortest probe whose "timeout" may count toward "slow" (in-38 V-2). A probe given only a
 * few milliseconds cannot tell "the peer held the socket and never answered" from "there is no
 * socket at all" — its own timer can fire before the missing socket's refusal arrives.
 */
const MIN_SLOW_PROBE_MS = 100

/**
 * Polls `GET /health` every 100 ms until the daemon answers or `waitMs` passes. The first failed
 * check fires `spawn()` — once per call, never more — so callers that arrive while a spawned daemon
 * is still opening its runtime just keep polling. A migration marker short-circuits everything:
 * no service may start or be considered up while `migrate/in-progress` exists.
 *
 * The verdict is a tri-state (in-35 R-2): "up" when /health answered; "slow" when the deadline
 * passed with at least one probe lost to its own timer — something held the socket but never
 * replied, a connected daemon that is slow, not absent; "down" otherwise (refused, missing
 * socket, unreadable replies). No probe starts once the budget is spent, and a probe given less
 * than MIN_SLOW_PROBE_MS cannot tell slow from down, so its timeout never scores "slow".
 */
export async function ensureDaemonState(
  home: MidaHome,
  spawn: () => void,
  options: { waitMs: number },
): Promise<"up" | "slow" | "down"> {
  if (migrationInProgress(home)) return "down"
  const deadline = Date.now() + options.waitMs
  let spawned = false
  let sawTimeout = false
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return sawTimeout ? "slow" : "down"
    const timeoutMs = Math.min(500, remaining)
    const reply = await callDaemon(home, "/health", undefined, { timeoutMs })
    if (reply.status !== 0) return "up"
    if (reply.failure === "timeout" && timeoutMs >= MIN_SLOW_PROBE_MS) sawTimeout = true
    if (!spawned) {
      spawned = true
      try {
        spawn()
      } catch {
        // a spawn that fails synchronously still leaves the poll to run out the clock
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
}

/** The boolean form of `ensureDaemonState` — every existing caller keeps "up or not". */
export async function ensureDaemon(home: MidaHome, spawn: () => void, options: { waitMs: number }): Promise<boolean> {
  return (await ensureDaemonState(home, spawn, options)) === "up"
}

/** What ensureCurrentDaemon settled: the service is up (or not), who it replaced, or why it refused. */
export interface EnsureResult {
  up: boolean
  /** The service that was shut down to make room for this command's code. */
  replaced?: {
    codeRoot: string
    codeCommit: string
    pid: number
  }
  refusal?: string
}

/** How long the old service is given to leave after POST /shutdown before the refusal names it. */
const SHUTDOWN_WAIT_MS = 10_000

/**
 * ensureDaemon plus the Sep-22 check: an answering service must be running THIS code, not just any
 * code. The decision table:
 *
 * - /health down → exactly what ensureDaemon does (spawn once, poll until waitMs).
 * - /health up with no codeRoot (a service from before code reporting), a different codeRoot, or a
 *   different codeCommit → POST /shutdown, then poll /health every 100 ms until it stops answering,
 *   at most shutdownWaitMs (default 10 s); then spawn and wait as ensureDaemon does.
 * - "unknown" counts as equal only when BOTH sides are "unknown" — a service that cannot name its
 *   commit next to a command that can is a difference, and the service is replaced.
 * - a service that still answers after the shutdown wait earns a refusal naming its pid, both
 *   identities and the kill that ends it — the command never races two services on one socket.
 */
export async function ensureCurrentDaemon(
  home: MidaHome,
  spawn: () => void,
  options: { waitMs: number; shutdownWaitMs?: number; self?: CodeIdentity },
): Promise<EnsureResult> {
  if (migrationInProgress(home)) return { up: false, refusal: MIGRATION_REFUSAL }
  const self = options.self ?? codeIdentity()
  const probe = await callDaemon(home, "/health", undefined, { timeoutMs: Math.min(500, Math.max(1, options.waitMs)) })
  if (probe.status === 0) {
    return { up: await ensureDaemon(home, spawn, { waitMs: options.waitMs }) }
  }
  const body = probe.body as { codeRoot?: unknown; codeCommit?: unknown; pid?: unknown } | null
  const codeRoot = typeof body?.codeRoot === "string" ? body.codeRoot : undefined
  const codeCommit = typeof body?.codeCommit === "string" ? body.codeCommit : undefined
  const pid = typeof body?.pid === "number" ? body.pid : -1
  const pidText = typeof body?.pid === "number" ? String(body.pid) : "?"
  if (codeRoot === self.codeRoot && codeCommit === self.codeCommit) return { up: true }

  const replaced = { codeRoot: codeRoot ?? "unknown", codeCommit: codeCommit ?? "unknown", pid }
  await callDaemon(home, "/shutdown", {}, { timeoutMs: 2_000 })
  const shutdownWaitMs = options.shutdownWaitMs ?? SHUTDOWN_WAIT_MS
  const deadline = Date.now() + shutdownWaitMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const reply = await callDaemon(home, "/health", undefined, { timeoutMs: Math.min(500, remaining) })
    if (reply.status === 0) {
      const up = await ensureDaemon(home, spawn, { waitMs: options.waitMs })
      return { up, replaced }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, remaining))))
  }
  const secs = shutdownWaitMs % 1000 === 0 ? String(shutdownWaitMs / 1000) : (shutdownWaitMs / 1000).toFixed(1)
  return {
    up: false,
    refusal: `the Mida service (pid ${pidText}) runs code from ${replaced.codeRoot} @ ${replaced.codeCommit.slice(0, 7)}; this command runs ${self.codeRoot} @ ${self.codeCommit.slice(0, 7)}. It did not stop within ${secs} s — stop it with: kill ${pidText}`,
  }
}
