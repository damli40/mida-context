import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, isAbsolute } from "node:path"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { SOCKET_FILE, callDaemon, ensureFallbackSocketDir, fallbackSocketDir, socketPathFor } from "./control.js"
import { drainUntilSettled } from "./drain.js"
import type { DrainDeps, DrainResult } from "./drain.js"
import { buildHandoff } from "./handoff.js"
import type { HandoffDeps } from "./handoff.js"
import { FLUSH_EVENTS } from "./hook.js"
import type { MidaHome } from "./home.js"
import { isSafeName, listJobs } from "./queue.js"
import { authorNamesFor } from "./skeleton.js"
import { ServiceRuntime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { OWNER_COMMANDS, USAGE, ownerOnlyLine, runCliWithRuntime, validCliArgv } from "./cli.js"

/** Request bodies over this size are refused with 413 and the connection is closed. */
const BODY_CAP_BYTES = 64 * 1024
/** The save loop's period: with jobs waiting, one pass runs per tick at most. */
const TICK_MS = 15_000
/** How long a stale-socket probe waits for an answer before the file is declared dead. */
const STALE_CHECK_MS = 500
/** Shutdown waits for a pass in flight at most this long, then closes anyway. */
const PASS_WAIT_CAP_MS = 60_000

export interface DaemonDeps {
  home: MidaHome
  network: Network
  compile: DrainDeps["compile"]
  now(): number
  log(entry: object): void
  /** Extra fields forwarded into every drain call — tests inject homeDir/save/isApproved here. */
  drainDeps?: Partial<DrainDeps>
  /** The drain itself; defaults to drainUntilSettled. Tests substitute a queue-clearing spy. */
  drain?: (deps: DrainDeps) => Promise<DrainResult>
  /** Runtime acquisition; defaults to ServiceRuntime.open — the daemon's runtime cannot sign as the owner. */
  openRuntime?: () => Promise<ServiceRuntime>
  /** The /cli dispatch; defaults to runCliWithRuntime. `cwd` is the folder the client ran in. */
  runCli?: (argv: string[], runtime: ServiceRuntime, print: (line: string) => void, context?: { cwd?: string }) => Promise<number>
  /** Save-loop period; default 15 s. */
  tickMs?: number
  /** Loop pacing; default a real sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Shutdown wait cap for a pass in flight; default 60 s. */
  passWaitCapMs?: number
  /** Stale-socket health probe timeout; default 500 ms. */
  staleCheckMs?: number
  /** /handoff's read budget; default 7.5 s so the answer beats the hook's 8 s client timeout. */
  handoffLimitMs?: number
  /** Gate overrides for /handoff — tests inject fakes here; production leaves it unset. */
  handoffDeps?: Partial<HandoffDeps>
  /** The fallback socket folder's parent (default tmpdir()); tests inject a private temp dir. */
  socketBase?: string
}

export interface DaemonHandle {
  /** True when another live daemon already answered /health — this handle owns nothing. */
  alreadyRunning: boolean
  close(): Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads the request body, capped at 64 KiB: resolves "overflow" past the cap, "failed" on a dead
 * connection. An
 * oversized body is still drained to its end — answering 413 before the client finishes uploading
 * would race the response against a reset.
 */
function readBody(req: IncomingMessage): Promise<Buffer | "overflow" | "failed"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (body: Buffer | "overflow" | "failed") => {
      if (done) return
      done = true
      resolve(body)
    }
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= BODY_CAP_BYTES) chunks.push(chunk)
    })
    req.on("end", () => finish(size > BODY_CAP_BYTES ? "overflow" : Buffer.concat(chunks)))
    req.on("error", () => finish("failed"))
    req.on("close", () => finish("failed"))
  })
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), connection: "close" })
  res.end(payload)
}

/**
 * The one long-running owner of a Mida home: it takes `midad.lock` through ServiceRuntime.open, serves the
 * private control socket, and runs the save loop the detached drainer used to be. A second call on
 * the same home resolves to `alreadyRunning` when a live daemon answers /health on the socket; a
 * socket file with no listener behind it is stale and is replaced.
 *
 * The loop is driven by a flag, not a lock file: at most one pass is in flight, a `/kick` during a
 * pass asks for one more look when it ends, and after every pass the queue is listed again — a
 * waiting flush event (`FLUSH_EVENTS`) triggers the next pass immediately, anything else waits for
 * the tick. An empty queue costs nothing: no pass runs and no log line is written.
 */
export async function startDaemon(deps: DaemonDeps): Promise<DaemonHandle> {
  const home = deps.home
  const socketBase = deps.socketBase ?? tmpdir()
  const socketPath = socketPathFor(home, socketBase)
  const pointerFile = `${SOCKET_FILE}.path`
  const tickMs = deps.tickMs ?? TICK_MS
  const sleep = deps.sleep ?? realSleep
  const staleCheckMs = deps.staleCheckMs ?? STALE_CHECK_MS
  const passWaitCapMs = deps.passWaitCapMs ?? PASS_WAIT_CAP_MS
  const drain = deps.drain ?? drainUntilSettled
  const runCli = deps.runCli ?? runCliWithRuntime

  // a socket outside the home lands in the per-user fallback folder — the daemon itself makes it
  // private; an existing folder that is not a real 0700 directory owned by this user refuses the
  // start rather than place the control socket where someone else could reach it
  if (dirname(socketPath) === fallbackSocketDir(socketBase)) {
    ensureFallbackSocketDir(socketBase)
  }

  if (existsSync(socketPath)) {
    const alive = await callDaemon(home, "/health", undefined, { timeoutMs: staleCheckMs })
    if (alive.status !== 0) return { alreadyRunning: true, close: async () => {} }
    rmSync(socketPath, { force: true })
  }

  const runtime = await (deps.openRuntime ?? (() => ServiceRuntime.open(home, deps.network)))()

  const startedAt = new Date(deps.now()).toISOString()
  let stopped = false
  let inFlight: Promise<void> | null = null
  let again = false
  let closePromise: Promise<void> | null = null

  const runPasses = async (): Promise<void> => {
    for (;;) {
      if (stopped || listJobs(home).length === 0) return
      try {
        const result = await drain({
          home,
          runtime,
          compile: deps.compile,
          now: () => new Date(deps.now()),
          sleep,
          ...deps.drainDeps,
        })
        deps.log({
          event: "pass",
          saved: result.saved,
          failed: result.failed,
          skippedUnchanged: result.skippedUnchanged,
          skippedTooSoon: result.skippedTooSoon,
          lockHeld: result.lockHeld === true,
        })
      } catch (error) {
        deps.log({ event: "pass-failed", reason: error instanceof Error ? error.name : "error" })
        return
      }
      if (stopped) return
      const waiting = listJobs(home)
      if (waiting.length === 0 || !waiting.some((job) => FLUSH_EVENTS.has(job.event))) return
      // a flush job arrived too late for the pass that just ran — it goes again at once
    }
  }

  const schedule = (): void => {
    if (stopped) return
    if (inFlight !== null) {
      again = true
      return
    }
    inFlight = runPasses()
      .catch(() => {})
      .finally(() => {
        inFlight = null
        if (again) {
          again = false
          schedule()
        }
      })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "GET" && req.url === "/health") {
      respond(res, 200, { ok: true, pid: process.pid, startedAt, queueDepth: listJobs(home).length })
      return
    }
    if (req.method !== "POST") {
      respond(res, 404, { error: "not-found" })
      return
    }
    const body = await readBody(req)
    if (body === "failed") {
      req.socket.destroy()
      return
    }
    if (body === "overflow") {
      // no connection:close header — an abortive teardown races the still-arriving upload and the
      // client sees EPIPE instead of the 413; a graceful socket.end flushes the reply first
      const payload = JSON.stringify({ error: "too-large" })
      res.writeHead(413, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
      res.end(payload, () => req.socket.end())
      return
    }
    if (req.url === "/kick") {
      schedule()
      respond(res, 200, { ok: true })
      return
    }
    if (req.url === "/cli") {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const argv = (parsed as { argv?: unknown } | null)?.argv
      if (!validCliArgv(argv)) {
        respond(res, 200, { code: 2, lines: [USAGE] })
        return
      }
      // owner commands are refused before dispatch — no socket client may change who has access,
      // and the service runtime could not sign for them anyway
      if (OWNER_COMMANDS.includes(argv[0]!)) {
        respond(res, 200, { code: 2, lines: [ownerOnlyLine(argv[0]!)] })
        return
      }
      // the client tells the daemon where it ran — `approve` signs that folder's project in;
      // a relative or oversized value is ignored rather than resolved against the daemon's cwd
      const cwdRaw = (parsed as { cwd?: unknown } | null)?.cwd
      const cwd = typeof cwdRaw === "string" && isAbsolute(cwdRaw) && cwdRaw.length <= 4096 ? cwdRaw : undefined
      const lines: string[] = []
      const code = await runCli(argv, runtime, (line) => lines.push(line), { cwd }).catch(() => 1)
      respond(res, 200, { code, lines })
      return
    }
    if (req.url === "/handoff") {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
      const agent = typeof record.agent === "string" ? record.agent : ""
      const cwd = typeof record.cwd === "string" ? record.cwd : ""
      // the new session's own id — the hook sends it so a served handoff binds the session to the chain
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined
      const started = deps.now()
      const result = await buildHandoff(
        runtime,
        { agent, cwd, authorNames: authorNamesFor(runtime), sessionId },
        { ...deps.handoffDeps, limitMs: deps.handoffLimitMs ?? deps.handoffDeps?.limitMs },
      )
      // one stable line per call: codes, names, counts and timings — never request or handoff text
      deps.log({
        event: "handoff",
        agent: isSafeName(agent) ? agent : null,
        kind: result.kind,
        reason: result.kind === "refused" ? result.reason : null,
        checkpoints: result.kind === "handoff" ? result.checkpoints : 0,
        facts: result.kind === "refused" ? 0 : result.facts,
        factsFailed: result.kind === "refused" ? null : result.factsFailed,
        readMs: result.kind === "refused" ? null : result.readMs,
        ms: deps.now() - started,
      })
      respond(res, 200, result)
      return
    }
    respond(res, 404, { error: "not-found" })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        respond(res, 500, { error: "internal" })
      } catch {
        // the connection is already gone
      }
    })
  })

  // umask 0o177 for the listen itself: the socket file lands 0600, never connectable by another
  // user even for the instant before the chmod — then the caller's umask is restored
  const previousUmask = process.umask(0o177)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, () => resolve())
    })
  } catch (error) {
    await runtime.close()
    throw error
  } finally {
    process.umask(previousUmask)
  }
  // only this user may talk to the socket
  chmodSync(socketPath, 0o600)
  if (socketPath !== home.path(SOCKET_FILE)) writeFileSync(home.path(pointerFile), socketPath, { mode: 0o600 })

  deps.log({ event: "started", pid: process.pid })

  const loop = (async () => {
    while (!stopped) {
      await sleep(tickMs)
      if (!stopped) schedule()
    }
  })()
  loop.catch(() => {})

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      stopped = true
      if (inFlight !== null) {
        await Promise.race([inFlight, realSleep(passWaitCapMs)])
      }
      await new Promise<void>((done) => server.close(() => done()))
      try {
        rmSync(socketPath, { force: true })
      } catch {
        // a socket that will not unlink must not stop the lock release
      }
      home.remove(pointerFile)
      await runtime.close()
      deps.log({ event: "stopped" })
    })()
    return closePromise
  }

  return { alreadyRunning: false, close }
}
