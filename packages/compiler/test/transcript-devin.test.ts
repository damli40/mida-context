import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import {
  DevinDbUnreadableError,
  DevinSessionNotFoundError,
  DevinSqliteUnavailableError,
  devinSessionStat,
  openDevinDb,
} from "../src/transcript-devin.js"

/**
 * A synthetic Devin sessions database with the exact schema the brief records
 * (apps/midad/src/devin-facts.ts). No real Devin data ever enters the repo —
 * every row a test needs is inserted here by hand.
 */
const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
  model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
  title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT,
  workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL,
  metadata TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id));`

const hasSqlite = (): boolean => {
  try {
    createRequire(import.meta.url)("node:sqlite")
    return true
  } catch {
    return false
  }
}
// node:sqlite is a builtin only from Node 22.13; the engines floor is 22, so the
// fixture tests skip on a runtime that cannot open the store at all.
const itSqlite = hasSqlite() ? it : it.skip

interface SessionRow {
  id: string
  mainChainId?: number | null
  workingDirectory?: string
}

interface NodeRow {
  /** defaults to the first session — set it for multi-session fixtures */
  sessionId?: string
  nodeId: number
  parentNodeId?: number | null
  chatMessage: unknown
  metadata?: unknown
}

function makeDevinDb(sessions: SessionRow[], nodes: NodeRow[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mida-devin-db-"))
  const path = join(dir, "sessions.db")
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...params: unknown[]): void }
      close(): void
    }
  }
  const db = new DatabaseSync(path)
  try {
    db.exec(SCHEMA)
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at,
        last_activity_at, main_chain_id) VALUES (?, ?, 'devin', 'model-x', 'agent', 1, 2, ?)`,
    )
    for (const s of sessions) {
      insertSession.run(s.id, s.workingDirectory ?? "/work", s.mainChainId ?? null)
    }
    const insertNode = db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const n of nodes) {
      insertNode.run(
        n.sessionId ?? sessions[0]!.id,
        n.nodeId,
        n.parentNodeId ?? null,
        JSON.stringify(n.chatMessage),
        n.nodeId,
        typeof n.metadata === "string" ? n.metadata : n.metadata === undefined ? null : JSON.stringify(n.metadata),
      )
    }
  } finally {
    db.close()
  }
  return path
}

/** A node whose session id is chosen explicitly, for the multi-session fixture. */
const inSession = (sessionId: string, node: NodeRow): NodeRow => ({ sessionId, ...node })

const user = (content: string, isUserInput = true) => ({ role: "user", content, metadata: { is_user_input: isUserInput } })
const assistant = (content: string) => ({ role: "assistant", content, metadata: {} })

describe("devinSessionStat — the session fingerprint", () => {
  itSqlite("reads main_chain_id, the max node_id and the row count for that session only", () => {
    const db = makeDevinDb(
      [
        { id: "bald-swordfish", mainChainId: 7, workingDirectory: "/work/proj" },
        { id: "calm-otter", mainChainId: 1 },
      ],
      [
        { nodeId: 1, chatMessage: user("q1") },
        { nodeId: 3, parentNodeId: 1, chatMessage: assistant("a1") },
        { nodeId: 7, parentNodeId: 3, chatMessage: assistant("a2") },
        inSession("calm-otter", { nodeId: 100, chatMessage: user("other session") }),
        inSession("calm-otter", { nodeId: 200, parentNodeId: 100, chatMessage: assistant("other") }),
      ],
    )
    const stat = devinSessionStat(db, "bald-swordfish")
    expect(stat).toEqual({ mainChainId: 7, maxNodeId: 7, nodeCount: 3, workingDirectory: "/work/proj" })
  })

  itSqlite("a session id with a quote and a semicolon is bound, never interpolated", () => {
    const db = makeDevinDb([{ id: "o'clock;drop", mainChainId: 2 }], [
      { nodeId: 1, chatMessage: user("q") },
      { nodeId: 2, parentNodeId: 1, chatMessage: assistant("a") },
    ])
    expect(devinSessionStat(db, "o'clock;drop").nodeCount).toBe(2)
  })

  itSqlite("an injection-shaped id finds no row — it cannot leak another session's stat", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 1 }], [
      { nodeId: 1, chatMessage: user("q") },
    ])
    expect(() => devinSessionStat(db, "x' OR '1'='1")).toThrow(DevinSessionNotFoundError)
  })

  itSqlite("a missing session is DevinSessionNotFoundError with the permanent code", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 1 }], [
      { nodeId: 1, chatMessage: user("q") },
    ])
    try {
      devinSessionStat(db, "no-such-slug")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DevinSessionNotFoundError)
      expect((error as DevinSessionNotFoundError).code).toBe("devin-session-not-found")
    }
  })

  itSqlite("the default opener is read-only — Mida can never write Devin's store", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 1 }], [
      { nodeId: 1, chatMessage: user("q") },
    ])
    const handle = openDevinDb(db)
    try {
      expect(() => handle.exec("INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at) VALUES ('x','/w','b','m','a',1,1)")).toThrow(/readonly|read.only/i)
    } finally {
      handle.close()
    }
  })

  itSqlite("a file that is not sqlite is unreadable, permanent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-devin-db-"))
    const path = join(dir, "sessions.db")
    writeFileSync(path, "this is not a database")
    try {
      devinSessionStat(path, "bald-swordfish")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DevinDbUnreadableError)
      expect((error as DevinDbUnreadableError).code).toBe("devin-db-unreadable")
    }
  })

  it("an injected opener that lacks node:sqlite raises the permanent code", () => {
    expect(() => devinSessionStat("/nowhere", "s", () => { throw new DevinSqliteUnavailableError() }))
      .toThrow(DevinSqliteUnavailableError)
  })
})
