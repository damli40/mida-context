// Devin's sessions live in a SQLite database (sessions + message_nodes, WAL,
// written live by the CLI — schema in apps/midad/src/devin-facts.ts), never in
// the per-session transcript files the file-based agents write. This module
// owns everything about reading that store: the lazy node:sqlite load, the
// session fingerprint the drain's unchanged-check uses, and the node graph the
// normalized Conversation is built from.
//
// node:sqlite is a builtin only from Node 22.13 (the repo's engines floor is
// 22), so the module is loaded lazily through createRequire: on an older Node
// the open throws DevinSqliteUnavailableError, whose code the drain maps onto
// the permanent "devin-needs-node-22.13" reason — never a crash and never a
// silent skip.

import { createRequire } from "node:module"

/**
 * The narrow slice of node:sqlite's DatabaseSync this file uses — declared here
 * so the lazy require stays untyped and tests can inject a fake database. The
 * session id is always a bound `?` parameter, never interpolated into SQL text.
 */
export interface DevinDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  exec(sql: string): void
  close(): void
}

/** Opens the sessions database for read. Injectable — tests open a synthetic file. */
export type OpenDevinDb = (path: string) => DevinDb

/** node:sqlite is absent below Node 22.13 — the drain ends the job `bad` on this code. */
export class DevinSqliteUnavailableError extends Error {
  readonly code = "devin-needs-node-22.13"
  constructor() {
    super("Devin's session database needs node:sqlite — Node 22.13 or later")
    this.name = "DevinSqliteUnavailableError"
  }
}

/** The job's session id has no row — a mismatch between hook payload and store, permanent. */
export class DevinSessionNotFoundError extends Error {
  readonly code = "devin-session-not-found"
  constructor(readonly sessionId: string) {
    super(`no session ${sessionId} in the Devin sessions database`)
    this.name = "DevinSessionNotFoundError"
  }
}

/** The file opens but does not answer as the sessions database — permanent, never retried. */
export class DevinDbUnreadableError extends Error {
  readonly code = "devin-db-unreadable"
  constructor(message: string) {
    super(message)
    this.name = "DevinDbUnreadableError"
  }
}

function sqliteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  // a lock that outlives the busy timeout is transient — the retry may still read it —
  // so it rethrows uncoded rather than landing in queue/bad
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) {
    return error instanceof Error ? error : new Error(message)
  }
  return new DevinDbUnreadableError(`the Devin sessions database cannot be read: ${message}`)
}

/**
 * The default opener: DatabaseSync read-only — Mida never writes Devin's store — with
 * a two-second busy timeout, since Devin writes the WAL file live and a read-only
 * handle must wait out a writer's short lock instead of failing the job at once.
 */
export const openDevinDb: OpenDevinDb = (path) => {
  let DatabaseSync: unknown
  try {
    DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync?: unknown }).DatabaseSync
  } catch {
    throw new DevinSqliteUnavailableError()
  }
  if (typeof DatabaseSync !== "function") throw new DevinSqliteUnavailableError()
  try {
    return new (DatabaseSync as new (path: string, options: { readOnly: boolean; timeout: number }) => DevinDb)(path, {
      readOnly: true,
      timeout: 2000,
    })
  } catch (error) {
    throw sqliteError(error)
  }
}

/** Every statement reads only the requested session's rows — the id is always a bound parameter. */
const SESSION_SQL = "SELECT id, working_directory, main_chain_id FROM sessions WHERE id = ?"
const NODES_SQL =
  "SELECT node_id, parent_node_id, chat_message, metadata FROM message_nodes WHERE session_id = ? ORDER BY node_id"
const STAT_SQL = "SELECT MAX(node_id) AS maxNode, COUNT(*) AS nodeCount FROM message_nodes WHERE session_id = ?"

const intOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

/** One session row, parsed only as far as the reader looks. */
interface DevinSessionRow {
  mainChainId: number | null
  workingDirectory: string | null
}

/** One message_nodes row — the fields the chain walk and the reader use. */
export interface DevinNodeRow {
  nodeId: number
  parentNodeId: number | null
  chatMessage: string
  metadata: string | null
}

function readSession(db: DevinDb, sessionId: string): DevinSessionRow {
  let row: unknown
  try {
    row = db.prepare(SESSION_SQL).get(sessionId)
  } catch (error) {
    throw sqliteError(error)
  }
  if (typeof row !== "object" || row === null) throw new DevinSessionNotFoundError(sessionId)
  const r = row as Record<string, unknown>
  return {
    mainChainId: intOf(r.main_chain_id),
    workingDirectory: typeof r.working_directory === "string" && r.working_directory !== "" ? r.working_directory : null,
  }
}

function readNodes(db: DevinDb, sessionId: string): DevinNodeRow[] {
  let rows: unknown[]
  try {
    rows = db.prepare(NODES_SQL).all(sessionId)
  } catch (error) {
    throw sqliteError(error)
  }
  const nodes: DevinNodeRow[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const r = row as Record<string, unknown>
    const nodeId = intOf(r.node_id)
    if (nodeId === null || typeof r.chat_message !== "string") continue
    nodes.push({
      nodeId,
      parentNodeId: intOf(r.parent_node_id),
      chatMessage: r.chat_message,
      metadata: typeof r.metadata === "string" ? r.metadata : null,
    })
  }
  return nodes
}

/**
 * The session's fingerprint for the drain's unchanged-check: the same three fields the
 * brief pins — main_chain_id, the highest node_id, and the node count — so a growing
 * session always shows a different fingerprint and an untouched one always skips. File
 * size and a last-line hash would be wrong here: a WAL write can rewrite pages anywhere.
 */
export interface DevinSessionStat {
  mainChainId: number | null
  maxNodeId: number
  nodeCount: number
  workingDirectory: string | null
}

export function devinSessionStat(
  dbPath: string,
  sessionId: string,
  open: OpenDevinDb = openDevinDb,
): DevinSessionStat {
  const db = open(dbPath)
  try {
    const session = readSession(db, sessionId)
    let row: unknown
    try {
      row = db.prepare(STAT_SQL).get(sessionId)
    } catch (error) {
      throw sqliteError(error)
    }
    const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>
    return {
      mainChainId: session.mainChainId,
      maxNodeId: intOf(r.maxNode) ?? -1,
      nodeCount: intOf(r.nodeCount) ?? 0,
      workingDirectory: session.workingDirectory,
    }
  } finally {
    try {
      db.close()
    } catch {
      // a close that fails leaves nothing behind — the handle was read-only
    }
  }
}
