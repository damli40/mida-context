import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, isAbsolute } from "node:path"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { SOCKET_FILE, callDaemon, ensureFallbackSocketDir, fallbackSocketDir, socketPathFor } from "./control.js"
import { codeIdentity } from "./code-identity.js"
import type { CodeIdentity } from "./code-identity.js"
import { drainUntilSettled } from "./drain.js"
import type { DrainDeps, DrainResult } from "./drain.js"
import { buildHandoff } from "./handoff.js"
import type { HandoffDeps } from "./handoff.js"
import { CheckpointCopies, buildWhatsNew } from "./whatsnew.js"
import type { WhatsNewDeps } from "./whatsnew.js"
import { buildMcpSave } from "./mcp-save.js"
import type { McpSaveDeps } from "./mcp-save.js"
import { buildContextRead } from "./context-read.js"
import type { ContextReadDeps } from "./context-read.js"
import { buildRemember } from "./remember-save.js"
import type { RememberDeps } from "./remember-save.js"
import { pendingAnchors } from "./batching.js"
import { FLUSH_EVENTS } from "./hook.js"
import type { MidaHome } from "./home.js"
import { loadAgentIdentity } from "./keys.js"
import { isSafeName, listJobs } from "./queue.js"
import { NAMESPACE_ID, authorNamesFor, readCheckpoints, saveCheckpoint } from "./skeleton.js"
import { ServiceRuntime, liveLockHolderPid } from "./runtime.js"
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
  /** The /cli dispatch; defaults to runCliWithRuntime. `cwd` is the folder the client ran in; `debug` is its MIDA_DEBUG=1. */
  runCli?: (argv: string[], runtime: ServiceRuntime, print: (line: string) => void, context?: { cwd?: string; debug?: boolean }) => Promise<number>
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
  /** Gate and read overrides for /whatsnew — same role as handoffDeps for the prompt hook. */
  whatsnewDeps?: Partial<WhatsNewDeps>
  /** Gate and save overrides for /save (mida_save) — same role as handoffDeps. */
  mcpSaveDeps?: Partial<McpSaveDeps>
  /** Gate and read overrides for /context — same role as handoffDeps. */
  contextDeps?: Partial<ContextReadDeps>
  /** Gate and write overrides for /remember — same role as mcpSaveDeps. */
  rememberDeps?: Partial<RememberDeps>
  /** The code identity /health reports; default codeIdentity() — tests inject a foreign one. */
  identity?: CodeIdentity
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
 * waiting flush event (`FLUSH_EVENTS`) triggers the next pass immediately, but only when the pass
 * made progress or the flush set changed mid-pass; a flush job the pass could not touch waits for
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
  const identity = deps.identity ?? codeIdentity()

  // a socket outside the home lands in the per-user fallback folder — the daemon itself makes it
  // private; an existing folder that is not a real 0700 directory owned by this user refuses the
  // start rather than place the control socket where someone else could reach it
  if (dirname(socketPath) === fallbackSocketDir(socketBase)) {
    ensureFallbackSocketDir(socketBase)
  }

  if (existsSync(socketPath)) {
    const alive = await callDaemon(home, "/health", undefined, { timeoutMs: staleCheckMs })
    if (alive.status !== 0) return { alreadyRunning: true, close: async () => {} }
    // in-29 S-1 (Sep 29 item 14): a holder that is alive but answered slowly keeps its socket —
    // deleting the file under it leaves it running but unreachable, and the lock below refuses
    // the new start anyway. Only a dead or absent lock holder makes the socket stale.
    if (liveLockHolderPid(home) !== undefined) return { alreadyRunning: true, close: async () => {} }
    rmSync(socketPath, { force: true })
  }

  const runtime = await (deps.openRuntime ?? (() => ServiceRuntime.open(home, deps.network)))()

  // the memory-held checkpoint copies /whatsnew answers from — decrypted content never leaves
  // daemon memory. The handoff's read and every drain save seed it, so the first prompt of a
  // session is already warm; a stale or absent copy refreshes behind the prompt's back.
  const copies = new CheckpointCopies(() => deps.now())

  // POST /save's rate map: the last admitted save time per identity+project, for the life of this
  // daemon — a restart resets it, but the chain-side gates and the save id's dedup still apply
  const lastMcpSaves = new Map<string, number>()

  // POST /remember's rate window: the admitted-write timestamps per lane+agent — the limit is
  // service-side, so two SDK clients writing as one agent share the same minute
  const admittedRemembers = new Map<string, number[]>()

  const startedAt = new Date(deps.now()).toISOString()
  let stopped = false
  let inFlight: Promise<void> | null = null
  let again = false
  let closePromise: Promise<void> | null = null

  const runPasses = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      const queued = listJobs(home)
      if (queued.length === 0) return
      // the flush jobs waiting before this pass — compared against the set after it to tell "a
      // new flush job arrived mid-pass" from "the same job is still queued", which means the
      // pass could not touch it (the drain lock is held elsewhere, or it sits inside its retry
      // backoff): re-passing on it at once would spin a full core until the condition clears
      const flushBefore = new Set(queued.filter((job) => FLUSH_EVENTS.has(job.event)).map((job) => job.id))
      let saved = 0
      try {
        const result = await drain({
          home,
          runtime,
          compile: deps.compile,
          now: () => new Date(deps.now()),
          sleep,
          ...deps.drainDeps,
          // a successful save teaches the whats-new copy the new checkpoint at once — another
          // session's next prompt sees it without any new read
          save: async (rt, agent, input) => {
            const saved = await (deps.drainDeps?.save ?? saveCheckpoint)(rt, agent, input)
            copies.noteSaved(agent, {
              checkpoint: input.checkpoint,
              projectId: input.projectId,
              sessionId: input.sessionId,
              continuesSession: input.continuesSession,
              compiledBy: input.compiledBy,
              // the save's task rides into the memory copy too, or whats-new would misfile it
              ...(input.task === undefined ? {} : { task: input.task }),
              contextId: saved.contextId,
              // the on-chain author is the agent's identity; without one the name still tells who saved
              authorId: loadAgentIdentity(home, agent)?.agentId ?? agent,
              namespaceId: NAMESPACE_ID,
              // a just-queued batched save is not anchored — the copy must not call it final;
              // a duplicate answer is pending too when the original still sits in the ledger
              anchor:
                saved.lane === "batched" || pendingAnchors(home).some((entry) => entry.contextId === saved.contextId)
                  ? "PENDING_ANCHOR"
                  : "ANCHORED",
            })
            return saved
          },
        })
        saved = result.saved
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
      const flushNow = waiting.filter((job) => FLUSH_EVENTS.has(job.event))
      if (waiting.length === 0 || flushNow.length === 0) return
      // go again at once only when the pass made progress or a flush job genuinely arrived
      // mid-pass; an unchanged flush set is stuck, not late — the tick or the next kick
      // reschedules it
      const flushMoved =
        flushNow.length !== flushBefore.size || flushNow.some((job) => !flushBefore.has(job.id))
      if (saved === 0 && !flushMoved) return
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
      respond(res, 200, { ok: true, pid: process.pid, startedAt, queueDepth: listJobs(home).length, codeRoot: identity.codeRoot, codeCommit: identity.codeCommit })
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
    if (req.url === "/shutdown") {
      respond(res, 200, { ok: true })
      // exactly what SIGTERM gets from daemon-main: close() lets the pass in flight finish
      // first, then releases the socket, the lock and the runtime — queued jobs are on disk,
      // so nothing is lost. The catch keeps a failed close from becoming an unhandled rejection.
      void close().catch(() => {})
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
      // a relative or oversized value is ignored rather than resolved against the daemon's cwd.
      // `debug` is the client's MIDA_DEBUG=1 — only the boolean true counts.
      const cwdRaw = (parsed as { cwd?: unknown } | null)?.cwd
      const cwd = typeof cwdRaw === "string" && isAbsolute(cwdRaw) && cwdRaw.length <= 4096 ? cwdRaw : undefined
      const debug = (parsed as { debug?: unknown } | null)?.debug === true
      // tk-1: the client's own MIDA_TASK — the daemon's env knows nothing of the shell that ran `mida task`
      const taskRaw = (parsed as { task?: unknown } | null)?.task
      const task = typeof taskRaw === "string" ? taskRaw : undefined
      const lines: string[] = []
      const code = await runCli(argv, runtime, (line) => lines.push(line), { cwd, debug, task }).catch(() => 1)
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
      // tk-1: the launch's explicit task (MIDA_TASK from the hook env, or --task/MIDA_TASK from
      // the MCP adapter) — buildHandoff validates and resolves it; absent means folder rules
      const task = typeof record.task === "string" ? record.task : undefined
      const started = deps.now()
      const result = await buildHandoff(
        runtime,
        { agent, cwd, authorNames: authorNamesFor(runtime), sessionId, task },
        {
          ...deps.handoffDeps,
          // the session-start read seeds the same copy whats-new serves — the first prompt is warm.
          // A partial list never seeds it: an incomplete read must not stand in for the full one (M3-D).
          read: async (rt, agentName, projectId) => {
            const outcome = await (deps.handoffDeps?.read ?? readCheckpoints)(rt, agentName, projectId)
            if (!outcome.partial) copies.seed(agentName, projectId, outcome.checkpoints)
            return outcome
          },
          limitMs: deps.handoffLimitMs ?? deps.handoffDeps?.limitMs,
        },
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
        // the size the model received, the limit it was cut against, and whether it was cut —
        // never re-derived from the text: the render reports them itself
        chars: result.text.length,
        limitChars: result.kind === "handoff" ? result.limitChars : null,
        cut: result.kind === "handoff" && result.cut,
        oversized: result.kind === "handoff" && result.oversized,
        partial: result.kind !== "refused" && result.partial,
        readMs: result.kind === "refused" ? null : result.readMs,
        ms: deps.now() - started,
      })
      respond(res, 200, result)
      return
    }
    if (req.url === "/whatsnew") {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
      const agent = typeof record.agent === "string" ? record.agent : ""
      const cwd = typeof record.cwd === "string" ? record.cwd : ""
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined
      const task = typeof record.task === "string" ? record.task : undefined
      const started = deps.now()
      const result = await buildWhatsNew(runtime, { agent, cwd, sessionId, task }, {
        copies,
        log: deps.log,
        ...deps.whatsnewDeps,
      })
      // same discipline as the handoff line: codes and counts, never note or checkpoint text
      deps.log({
        event: "whatsnew",
        agent: isSafeName(agent) ? agent : null,
        kind: result.kind,
        reason: result.kind === "refused" ? result.reason : null,
        updates: result.kind === "updates" ? result.updates.length : 0,
        ms: deps.now() - started,
      })
      respond(res, 200, result)
      return
    }
    // mida-mcp's one write: the model's checkpoint fields through the same gates and save path the
    // drain uses — identity, folder approval, CREATE grant and revocation are decided here, never
    // in the adapter, which holds no keys. Owner operations stay unreachable: there is no route for
    // them and the service runtime could not sign them anyway.
    if (req.url === "/save") {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
      const started = deps.now()
      const result = await buildMcpSave(runtime, record, { lastSaves: lastMcpSaves, now: deps.now, ...deps.mcpSaveDeps })
      if (result.kind === "saved") {
        // the new checkpoint enters the same copy the drain's saves seed — another session's
        // whats-new sees it without a new chain read
        copies.noteSaved(typeof record.agent === "string" ? record.agent : "", {
          checkpoint: result.checkpoint,
          projectId: result.projectId,
          sessionId: result.sessionId,
          continuesSession: null,
          compiledBy: typeof record.agent === "string" ? record.agent : "",
          ...(result.task === undefined ? {} : { task: result.task }),
          contextId: result.contextId,
          authorId:
            typeof record.agent === "string" ? (loadAgentIdentity(home, record.agent)?.agentId ?? record.agent) : "",
          namespaceId: NAMESPACE_ID,
          anchor: result.lane === "batched" || pendingAnchors(home).some((entry) => entry.contextId === result.contextId) ? "PENDING_ANCHOR" : "ANCHORED",
        })
      }
      deps.log({
        event: "mcp-save",
        agent: isSafeName(record.agent) ? record.agent : null,
        kind: result.kind,
        reason: result.kind === "refused" ? result.reason : null,
        duplicate: result.kind === "saved" ? result.duplicate : null,
        ms: deps.now() - started,
      })
      respond(res, 200, result)
      return
    }
    // the SDK's read: scoped context as verified records — the same gates and merged read the
    // handoff runs on, answered as items instead of prose so callers never parse handoff text
    if (req.url === "/context") {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
      const started = deps.now()
      const result = await buildContextRead(runtime, record, deps.contextDeps)
      // same discipline as the other lines: codes and counts, never record content
      deps.log({
        event: "context-read",
        agent: isSafeName(record.agent) ? record.agent : null,
        kind: result.kind,
        reason: result.kind === "refused" ? result.reason : null,
        items: result.kind === "context" ? result.items.length : 0,
        partial: result.kind === "context" && result.partial === true,
        ms: deps.now() - started,
      })
      respond(res, 200, result)
      return
    }
    // the SDK's write: one memory record — a note, a finding, a decision — through the same
    // identity, approval, grant and revoke gates /save runs, onto the same direct/batched lanes
    if (req.url === "/remember") {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = undefined
      }
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
      const started = deps.now()
      const result = await buildRemember(runtime, record, { admittedSaves: admittedRemembers, now: deps.now, ...deps.rememberDeps })
      // codes, names and the lane — never the content written
      deps.log({
        event: "remember",
        agent: isSafeName(record.agent) ? record.agent : null,
        kind: result.kind,
        reason: result.kind === "refused" ? result.reason : null,
        lane: result.kind === "saved" ? result.lane : (result.lane ?? null),
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
