import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { DevinSqliteUnavailableError, devinSessionStat } from "@mida/compiler"
import type { CompileInput, compileCheckpoint } from "@mida/compiler"
import { MidaHome, drainOnce, enqueue, projectIdFor } from "@mida/midad"
import { DEVIN_DB_SCHEMA } from "@mida/midad"
import type { DrainDeps, Runtime, saveCheckpoint } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const T0 = Date.parse("2026-09-21T10:00:00.000Z")

/** The exact schema the brief records — shared from devin-facts so a wrong fact is fixed once. */
const SCHEMA = DEVIN_DB_SCHEMA

interface TestDb {
  path: string
  addNode(nodeId: number, parentNodeId: number | null, chatMessage: unknown): void
}

/**
 * A synthetic sessions database the test can still append to: `addNode` opens a
 * normal (write) handle — Mida itself only ever opens the file read-only.
 */
function makeDevinDb(dir: string, sessionId: string, opts: { mainChainId?: number | null; workingDirectory?: string } = {}): TestDb {
  const dbDir = join(dir, "devin", "cli")
  mkdirSync(dbDir, { recursive: true })
  const path = join(dbDir, "sessions.db")
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...params: unknown[]): void }
      close(): void
    }
  }
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at,
      last_activity_at, main_chain_id) VALUES (?, ?, 'devin', 'model-x', 'agent', 1, 2, ?)`,
  ).run(sessionId, opts.workingDirectory ?? "/work", opts.mainChainId ?? null)
  db.close()
  return {
    path,
    addNode(nodeId, parentNodeId, chatMessage) {
      const w = new DatabaseSync(path)
      w.prepare(
        `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(sessionId, nodeId, parentNodeId, JSON.stringify(chatMessage), nodeId)
      w.close()
    },
  }
}

const hasSqlite = (): boolean => {
  try {
    createRequire(import.meta.url)("node:sqlite")
    return true
  } catch {
    return false
  }
}
const itSqlite = hasSqlite() ? it : it.skip

/**
 * The drain-rules pattern pointed at a devin job: the "transcript" is the sessions
 * database, resolved the way the hook resolves it — MIDA_DEVIN_DB over the injected env.
 */
function setup(opts: { sessionId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mida-draindevin-"))
  const home = new MidaHome(join(dir, "mida"))
  const homeDir = join(dir, "user-home")
  const sessionId = opts.sessionId ?? "bald-swordfish"
  const db = makeDevinDb(homeDir, sessionId, { mainChainId: null, workingDirectory: join(dir, "work") })
  const cwd = join(dir, "work")
  mkdirSync(join(cwd, ".mida"), { recursive: true })
  writeFileSync(join(cwd, ".mida", "project.json"), JSON.stringify({ projectId: "p-1" }))
  const compileCalls: CompileInput[] = []
  const compile: typeof compileCheckpoint = async (input) => {
    compileCalls.push(input)
    return {
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      retried: 0,
      format: "devin-sqlite",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    }
  }
  const save: typeof saveCheckpoint = async () => ({
    contextId: `0x${"ab".repeat(32)}`,
    transactionHash: null,
    milliseconds: 1,
    duplicate: false,
  })
  const open = async (): Promise<Runtime> => ({ close: async () => {} }) as unknown as Runtime
  const checkProject: NonNullable<DrainDeps["checkProject"]> = async (input) => {
    const projectId = projectIdFor(input.cwd)
    return projectId === null
      ? { ok: false, reason: "not-a-project" }
      : { ok: true, approval: { agent: input.agent, projectId, root: input.cwd, approvedAt: "2026-09-21T00:00:00.000Z" } }
  }
  const env = { MIDA_DEVIN_DB: db.path }
  const job = (over: Record<string, unknown> = {}, at = T0) =>
    enqueue(home, { agent: "devin", event: "Stop", sessionId, transcriptPath: db.path, cwd, error: null, ...over }, () => new Date(at))
  const drain = (over: Record<string, unknown> = {}) =>
    drainOnce({ home, open, compile, save, homeDir, checkProject, env, isApproved: async () => true, now: () => new Date(T0 + 120_000), ...over })
  const drainLog = () => readFileSync(home.path("logs/drain.jsonl"), "utf8")
  const badJobs = () => home.list("queue/bad")
  return { dir, home, homeDir, db, sessionId, cwd, env, compileCalls, compile, save, open, checkProject, job, drain, drainLog, badJobs }
}

describe("a devin job's session lookup in the drain", () => {
  itSqlite("a session id the database does not hold is bad devin-session-not-found, never a crash or a guess", async () => {
    const { job, drain, drainLog, badJobs, compileCalls } = setup()
    job({ sessionId: "wrong-slug" })
    await drain()
    expect(compileCalls).toHaveLength(0)
    expect(badJobs()).toHaveLength(1)
    expect(drainLog()).toContain('"outcome":"bad"')
    expect(drainLog()).toContain('"reason":"devin-session-not-found"')
  })

  itSqlite("a node:sqlite-less opener is bad devin-needs-node-22.13 — the runtime gap is permanent", async () => {
    const { job, drain, drainLog, badJobs, compileCalls } = setup()
    job()
    await drain({
      openDevinDb: () => {
        throw new DevinSqliteUnavailableError()
      },
    })
    expect(compileCalls).toHaveLength(0)
    expect(badJobs()).toHaveLength(1)
    expect(drainLog()).toContain('"reason":"devin-needs-node-22.13"')
  })

  itSqlite("a file that is not sqlite is bad devin-db-unreadable", async () => {
    const { homeDir, job, drain, drainLog, badJobs } = setup()
    const wrong = join(homeDir, "devin", "cli", "notadb.db")
    writeFileSync(wrong, "plain text, not a database")
    job({ transcriptPath: wrong }, T0)
    // the env must point at the broken file or the path check never reaches the read
    await drain({ env: { MIDA_DEVIN_DB: wrong } })
    expect(badJobs()).toHaveLength(1)
    expect(drainLog()).toContain('"reason":"devin-db-unreadable"')
  })

  itSqlite("a database outside the configured path is bad-transcript-path — the hook's rule applies again at drain", async () => {
    const { dir, job, drain, drainLog, badJobs } = setup()
    const stray = join(dir, "elsewhere.db")
    writeFileSync(stray, "anything")
    job({ transcriptPath: stray })
    await drain()
    expect(badJobs()).toHaveLength(1)
    expect(drainLog()).toContain('"reason":"bad-transcript-path"')
  })

  itSqlite("the fingerprint is (main_chain_id, max node_id, count) — a grown session never reads as unchanged", () => {
    const { db, sessionId } = setup()
    db.addNode(1, null, { role: "user", content: "q", metadata: { is_user_input: true } })
    const before = devinSessionStat(db.path, sessionId)
    expect(before).toEqual({ mainChainId: null, maxNodeId: 1, nodeCount: 1, workingDirectory: expect.any(String) })
    db.addNode(3, 1, { role: "assistant", content: "a" })
    const after = devinSessionStat(db.path, sessionId)
    expect(after.nodeCount).toBe(2)
    expect(after.maxNodeId).toBe(3)
    // any one of the three fields moving must move the fingerprint — count and max moved here
    expect(`${after.mainChainId}:${after.maxNodeId}:${after.nodeCount}`).not.toBe(`${before.mainChainId}:${before.maxNodeId}:${before.nodeCount}`)
  })
})
