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
import { scrubSecrets, scrubValue } from "./scrub.js"
import { cutSummary } from "./transcript-claude.js"
import type { Conversation } from "./transcript-claude.js"
import { FIRST_USER_CHARS, PART_CHARS, cut, fitMessages, hardCut } from "./transcript-lines.js"

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
 * True when this runtime can open the sessions database — node:sqlite is a
 * builtin only from Node 22.13. doctor prints its PROBLEM line off this; the
 * drain's own opener raises DevinSqliteUnavailableError on the same absence.
 */
export function devinSqliteAvailable(): boolean {
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync?: unknown }
    return typeof mod.DatabaseSync === "function"
  } catch {
    return false
  }
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

// ── the reader ─────────────────────────────────────────────────────────────
// The conversation a job asks for is ONE chain in the node graph: walk
// parent_node_id from sessions.main_chain_id back to its root — every other
// node (side branches, earlier compacted chains) is ignored for rendering.
// The earliest chain still owns the original request, and a compaction's
// summary is pinned beside it the way the Claude reader pins a /compact block.
//
// A wrong guess about Devin's internals must degrade to "current chain only",
// never to a crash or out-of-order text: a broken parent link ends the walk,
// an unparseable chat_message row is skipped, and a session with no
// main_chain_id answers unknown-tail like an unreadable file.

/** The chat_message JSON, typed only as far as the reader looks. */
interface DevinChatMessage {
  role?: unknown
  content?: unknown
  metadata?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
  thinking?: unknown
  phase?: unknown
}

const parseMessage = (raw: string): DevinChatMessage | null => {
  try {
    const obj = JSON.parse(raw) as DevinChatMessage | null
    return obj !== null && typeof obj === "object" ? obj : null
  } catch {
    return null // a truncated or non-JSON row — skip it, never read as conversation
  }
}

const parseNodeMeta = (raw: string | null): Record<string, unknown> => {
  if (raw === null) return {}
  try {
    const obj = JSON.parse(raw) as Record<string, unknown> | null
    return obj !== null && typeof obj === "object" && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

/** metadata.is_user_input === true — the ONLY mark of the owner speaking. */
const isUserInput = (msg: DevinChatMessage): boolean => {
  const meta = msg.metadata
  return (
    typeof meta === "object" && meta !== null &&
    (meta as Record<string, unknown>).is_user_input === true
  )
}

/** One tool call on an assistant message — name + arguments, capped like the Codex reader. */
const toolCallBlock = (label: string, call: unknown): string | null => {
  if (typeof call !== "object" || call === null) return null
  const c = call as Record<string, unknown>
  const name = typeof c.name === "string" && c.name !== "" ? c.name : "?"
  let detail = ""
  try {
    // scrubValue before stringify — a secret under a sensitive key name survives
    // the string-level scrub once JSON-escaped
    detail = JSON.stringify(scrubValue(c.arguments ?? null)) ?? ""
  } catch {
    detail = ""
  }
  const body = cut(scrubSecrets(`${name} ${detail}`.trimEnd()), PART_CHARS)
  return body === "" ? null : `N${label} tool:\n${body}`
}

/**
 * The chain root→tip for one tip node id. A missing or cyclic parent ends the
 * walk at whatever was collected — the chain simply reads shorter, never wrong.
 */
function chainFor(byId: Map<number, DevinNodeRow>, tipId: number): DevinNodeRow[] {
  const chain: DevinNodeRow[] = []
  const seen = new Set<number>()
  let cur = byId.get(tipId)
  while (cur !== undefined && !seen.has(cur.nodeId)) {
    seen.add(cur.nodeId)
    chain.unshift(cur)
    cur = cur.parentNodeId === null ? undefined : byId.get(cur.parentNodeId)
  }
  return chain
}

/** Every node whose root-ward walk ends at `rootId` — the chain that root heads. */
function chainRootedAt(byId: Map<number, DevinNodeRow>, nodes: DevinNodeRow[], rootId: number): DevinNodeRow[] {
  const rootOf = (n: DevinNodeRow): number | null => {
    const seen = new Set<number>()
    let cur: DevinNodeRow | undefined = n
    while (cur !== undefined && !seen.has(cur.nodeId)) {
      seen.add(cur.nodeId)
      if (cur.parentNodeId === null) return cur.nodeId
      cur = byId.get(cur.parentNodeId)
    }
    return null // a broken link: this node belongs to no readable chain
  }
  return nodes.filter((n) => rootOf(n) === rootId).sort((a, b) => a.nodeId - b.nodeId)
}

/**
 * The session's conversation as the normalized Conversation type. `dbPath` is the
 * sessions database; `sessionId` picks the session — a miss raises
 * DevinSessionNotFoundError, whose code the drain files as permanent.
 */
export function readDevinConversation(
  dbPath: string,
  options: {
    maxChars?: number
    /** The earlier checkpoint's kept originalRequest — heads the render when the store holds none. */
    preferRequest?: string | null
    /** The session the job named — required; the store is read only for its rows. */
    sessionId?: string
    open?: OpenDevinDb
  } = {},
): Conversation {
  const { maxChars = 40_000 } = options
  const open = options.open ?? openDevinDb
  const sessionId = options.sessionId ?? ""
  const db = open(dbPath)
  let session: DevinSessionRow
  let nodes: DevinNodeRow[]
  try {
    session = readSession(db, sessionId)
    nodes = readNodes(db, sessionId)
  } finally {
    try {
      db.close()
    } catch {
      // see above — read-only close, nothing to lose
    }
  }

  const cwds = session.workingDirectory === null ? [] : [session.workingDirectory]
  const empty: Conversation = {
    format: "unknown-tail",
    text: "",
    firstUserMessage: null,
    openedWithScaffolding: false,
    cwds,
    messagesKept: 0,
    messagesTotal: 0,
    omitted: 0,
  }
  if (session.mainChainId === null) return empty

  const byId = new Map<number, DevinNodeRow>()
  for (const n of nodes) byId.set(n.nodeId, n)
  const chain = chainFor(byId, session.mainChainId)
  if (chain.length === 0) return empty

  // Compaction, the shape probed on a live session (Devin CLI v3000.11.3, Sep 26):
  // the new chain's ROOT is the summarizer's own system prompt and the next node is
  // the old chain verbatim fed to it — neither carries the summary. The summary
  // rides a few nodes later on the pair whose NODE metadata holds an integer
  // summarized_from pointing at the old-chain node where the summary cut: an
  // assistant node holding the text and a system node re-injecting it for the
  // continuing model. The LAST summarized_from node marks the cut — everything up
  // to it is the summarizer's bookkeeping and never renders as a turn. A chain
  // with no summarized_from node is not a compaction at all, whatever its root
  // looks like: helper runs (sub-agents) root on is_system_prefix too, and the
  // probe saw them outnumber real compactions — pinning one would label a foreign
  // prompt as "the summary".
  let cutIdx = -1
  let summaryAssistant: { nodeId: number; role: string; content: string } | null = null
  let summarySystem: { nodeId: number; role: string; content: string } | null = null
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i]!
    if (intOf(parseNodeMeta(n.metadata).summarized_from) === null) continue
    cutIdx = i
    const msg = parseMessage(n.chatMessage)
    if (typeof msg?.content !== "string" || msg.content === "") continue
    if (msg.role === "assistant") summaryAssistant = { nodeId: n.nodeId, role: "assistant", content: msg.content }
    else if (msg.role === "system") summarySystem = { nodeId: n.nodeId, role: "system", content: msg.content }
  }
  // the summary text is the last summarized_from assistant node with content;
  // when none carried it, the system re-injection's content is the same text
  const summaryPick = summaryAssistant ?? summarySystem
  const summaryBlock =
    summaryPick === null
      ? null
      : `N${summaryPick.nodeId} ${summaryPick.role} — Summary of the earlier session (from compaction):\n${cutSummary(scrubSecrets(summaryPick.content))}`

  // The original request lives at the END of the link path: each compacted
  // chain's summarized_from points at the earlier chain it cut from, so follow
  // them until a chain carries no link of its own — that chain's first
  // is_user_input is the ask. A live chain with no link was never compacted and
  // falls back to the lowest-root rule; a dangling or cyclic link degrades to
  // the earliest chain the path could reach.
  const rootIdOf = (n: DevinNodeRow): number | null => {
    const seen = new Set<number>()
    let cur: DevinNodeRow | undefined = n
    while (cur !== undefined && !seen.has(cur.nodeId)) {
      seen.add(cur.nodeId)
      if (cur.parentNodeId === null) return cur.nodeId
      cur = byId.get(cur.parentNodeId)
    }
    return null
  }
  const lastLinkTarget = (rows: DevinNodeRow[]): number | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const target = intOf(parseNodeMeta(rows[i]!.metadata).summarized_from)
      if (target !== null) return target
    }
    return null
  }
  const lowestRootChain = (): DevinNodeRow[] => {
    const rootId = nodes
      .filter((n) => n.parentNodeId === null)
      .reduce<number | null>((low, n) => (low === null || n.nodeId < low ? n.nodeId : low), null)
    return rootId === null ? [] : chainRootedAt(byId, nodes, rootId)
  }
  let requestChain: DevinNodeRow[]
  {
    let rows = chain
    const seenRoots = new Set<number>()
    for (;;) {
      const target = lastLinkTarget(rows)
      const targetNode = target === null ? undefined : byId.get(target)
      const targetRoot = targetNode === undefined ? null : rootIdOf(targetNode)
      if (targetRoot === null || seenRoots.has(targetRoot)) {
        // no readable link of its own: this chain ends the path — and when it is
        // the live chain itself, the lowest root is the earliest chain
        requestChain = rows === chain ? lowestRootChain() : rows
        break
      }
      seenRoots.add(targetRoot)
      rows = chainRootedAt(byId, nodes, targetRoot)
    }
  }

  // The original request: the first is_user_input user message of the chain the
  // links ended on — kept verbatim across compactions like the Claude reader's
  // originalRequest.
  let earliestRequest: string | null = null
  let earliestRequestNode: DevinNodeRow | null = null
  let openedWithScaffolding = false
  for (const n of requestChain) {
    const msg = parseMessage(n.chatMessage)
    if (msg?.role !== "user") continue
    if (isUserInput(msg)) {
      if (typeof msg.content === "string" && msg.content !== "") {
        earliestRequest = msg.content
        earliestRequestNode = n
      }
      break // the first real input decides; an empty one still ends the search
    }
    openedWithScaffolding = true // an injected user turn sat before the owner's first words
  }
  const firstUserMessage = earliestRequest === null ? null : hardCut(scrubSecrets(earliestRequest), FIRST_USER_CHARS)

  // Render only the turns AFTER the compaction cut — the summarizer's prompt,
  // the verbatim history it was fed and the summary pair are bookkeeping, not
  // turns — and only the current chain, since side branches and earlier chains
  // are not this conversation. Without a summarized_from node the whole live
  // chain renders (cutIdx stays -1). messagesTotal counts every
  // user/assistant/tool node rendered, dropped or skipped within that slice.
  const msgs: { role: string; block: string }[] = []
  let messagesTotal = 0
  let pinIdx: number | undefined
  for (const n of chain.slice(cutIdx + 1)) {
    const msg = parseMessage(n.chatMessage)
    if (msg === null || msg.role === "system") continue
    const label = String(n.nodeId)
    if (msg.role === "user") {
      messagesTotal++
      if (!isUserInput(msg)) continue // system-injected: bookkeeping, not the owner
      if (typeof msg.content !== "string" || msg.content === "") continue
      const picked = n === earliestRequestNode
      const body = picked ? scrubSecrets(msg.content) : cut(scrubSecrets(msg.content), PART_CHARS)
      msgs.push({ role: "user", block: `N${label} user:\n${body}` })
      if (picked) pinIdx = msgs.length - 1
      continue
    }
    if (msg.role === "assistant") {
      messagesTotal++
      if (typeof msg.content === "string" && msg.content !== "") {
        msgs.push({ role: "assistant", block: `N${label} assistant:\n${cut(scrubSecrets(msg.content), PART_CHARS)}` })
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const block = toolCallBlock(label, call)
          if (block !== null) msgs.push({ role: "tool", block })
        }
      }
      continue
    }
    if (msg.role === "tool") {
      messagesTotal++
      if (typeof msg.content === "string" && msg.content !== "") {
        msgs.push({ role: "tool-result", block: `N${label} tool-result:\n${cut(scrubSecrets(msg.content), PART_CHARS)}` })
      }
      continue
    }
    // thinking, unknown roles and parse failures: bookkeeping — left out.
  }

  // The request's place in the render: when it lives in the current chain it is
  // the pinned block itself; across a compaction it is not a block at all, so it
  // takes the lead slot labelled for what it is — exactly the way the kept
  // earlier-checkpoint request heads a scaffolded file (M1).
  const ownRequest =
    firstUserMessage !== null && pinIdx === undefined
      ? `user — original request (kept from the earlier chain):\n${firstUserMessage}`
      : null
  const keptHead =
    ownRequest ??
    (options.preferRequest !== undefined &&
    options.preferRequest !== null &&
    (openedWithScaffolding || firstUserMessage === null)
      ? `user — original request (kept from the earlier checkpoint):\n${hardCut(scrubSecrets(options.preferRequest), FIRST_USER_CHARS)}`
      : null)

  if (msgs.length === 0 && summaryBlock === null && keptHead === null) return empty

  const fitted = fitMessages(msgs, maxChars, false, keptHead === null ? pinIdx : undefined, summaryBlock, keptHead)
  return {
    format: "devin-sqlite",
    text: fitted.text,
    firstUserMessage,
    openedWithScaffolding,
    cwds,
    messagesKept: fitted.messagesKept,
    messagesTotal,
    omitted: fitted.omitted,
  }
}
