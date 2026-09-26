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
  readDevinConversation,
} from "../src/transcript-devin.js"
import { readTranscriptFor } from "../src/transcript-codex.js"

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
const injectedUser = (content: string) => ({ role: "user", content, metadata: { is_user_input: false } })
const assistant = (content: string) => ({ role: "assistant", content, metadata: {} })
const system = (content: string) => ({ role: "system", content, metadata: {} })
const tool = (content: string) => ({ role: "tool", content, tool_call_id: "tc-1" })
const assistantWithCalls = (content: string, toolCalls: unknown[]) => ({
  role: "assistant",
  content,
  metadata: {},
  tool_calls: toolCalls,
})

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

describe("readDevinConversation — the chain the job asked for", () => {
  itSqlite("a plain session renders current-chain turns labelled by node, drops the system root", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 5, workingDirectory: "/work/proj" }], [
      { nodeId: 1, chatMessage: system("you are devin") },
      { nodeId: 2, parentNodeId: 1, chatMessage: user("fix the flaky test") },
      { nodeId: 3, parentNodeId: 2, chatMessage: assistant("looking at it") },
      { nodeId: 4, parentNodeId: 3, chatMessage: user("try the retry flag") },
      { nodeId: 5, parentNodeId: 4, chatMessage: assistant("done") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.format).toBe("devin-sqlite")
    expect(convo.firstUserMessage).toBe("fix the flaky test")
    expect(convo.cwds).toEqual(["/work/proj"])
    expect(convo.text).toContain("N2 user:\nfix the flaky test")
    expect(convo.text).toContain("N5 assistant:\ndone")
    expect(convo.text).not.toContain("you are devin")
    expect(convo.messagesTotal).toBe(4)
  })

  itSqlite("two compactions: the current chain's prefix pins as the summary, the earliest chain keeps the request", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 22, workingDirectory: "/work/proj" }], [
      // chain 1 — the session's start, compacted away
      { nodeId: 1, chatMessage: system("system prompt") },
      { nodeId: 2, parentNodeId: 1, chatMessage: user("the original ask") },
      { nodeId: 3, parentNodeId: 2, chatMessage: assistant("early work") },
      // chain 2 — first compaction root, itself compacted later
      { nodeId: 10, chatMessage: system("SUMMARY ONE of the session"), metadata: { is_system_prefix: 1, summarized_from: 3 } },
      { nodeId: 11, parentNodeId: 10, chatMessage: user("keep going") },
      { nodeId: 12, parentNodeId: 11, chatMessage: assistant("more work") },
      // chain 3 — second compaction, this is the live chain
      { nodeId: 20, chatMessage: system("SUMMARY TWO the newest state"), metadata: { is_system_prefix: 1, summarized_from: 12 } },
      { nodeId: 21, parentNodeId: 20, chatMessage: user("one more thing") },
      { nodeId: 22, parentNodeId: 21, chatMessage: assistant("wrapping up") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.format).toBe("devin-sqlite")
    // the request survives compaction, headed by its kept-from-the-earlier-chain label
    expect(convo.firstUserMessage).toBe("the original ask")
    expect(convo.text).toContain("user — original request (kept from the earlier chain):\nthe original ask")
    // the LIVE chain's prefix pins — not the older summary
    expect(convo.text).toContain("N20 system — Summary of the earlier session (from compaction):")
    expect(convo.text).toContain("SUMMARY TWO the newest state")
    expect(convo.text).not.toContain("SUMMARY ONE")
    // earlier chains render nothing else
    expect(convo.text).not.toContain("early work")
    expect(convo.text).not.toContain("more work")
    expect(convo.text).toContain("N21 user:\none more thing")
    expect(convo.text).toContain("N22 assistant:\nwrapping up")
  })

  itSqlite("an abandoned side branch is ignored — the chain walk never leaves its path", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 6 }], [
      { nodeId: 1, chatMessage: system("root") },
      { nodeId: 2, parentNodeId: 1, chatMessage: user("main question") },
      { nodeId: 4, parentNodeId: 2, chatMessage: assistant("main line answer") },
      { nodeId: 5, parentNodeId: 2, chatMessage: user("ABANDONED branch words") }, // sibling branch
      { nodeId: 7, parentNodeId: 5, chatMessage: assistant("branch answer") },
      { nodeId: 6, parentNodeId: 4, chatMessage: assistant("main continues") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.text).not.toContain("ABANDONED branch words")
    expect(convo.text).not.toContain("branch answer")
    expect(convo.text).toContain("main line answer")
    expect(convo.messagesTotal).toBe(3)
  })

  itSqlite("a system-injected user message is not the owner: it renders nothing and never pins", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 4 }], [
      { nodeId: 1, chatMessage: system("root") },
      { nodeId: 2, parentNodeId: 1, chatMessage: injectedUser("<environment>darwin /work</environment>") },
      { nodeId: 3, parentNodeId: 2, chatMessage: user("the real ask") },
      { nodeId: 4, parentNodeId: 3, chatMessage: assistant("sure") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.firstUserMessage).toBe("the real ask")
    expect(convo.text).not.toContain("<environment>")
    // the injected turn sat before the owner's first words — the pick is a continuation
    expect(convo.openedWithScaffolding).toBe(true)
  })

  itSqlite("tool calls and results render capped like the Codex reader; thinking stays out", () => {
    const long = "x".repeat(2_000)
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 5 }], [
      { nodeId: 1, chatMessage: system("root") },
      { nodeId: 2, parentNodeId: 1, chatMessage: user("run the suite") },
      {
        nodeId: 3,
        parentNodeId: 2,
        chatMessage: {
          ...assistantWithCalls("checking", [{ id: "tc-1", index: 0, kind: "function", name: "Bash", arguments: { command: long } }]),
          thinking: { text: "internal reasoning never rendered" },
        },
      },
      { nodeId: 4, parentNodeId: 3, chatMessage: tool(long) },
      { nodeId: 5, parentNodeId: 4, chatMessage: assistant("all green") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.text).toContain("N3 tool:\nBash {")
    expect(convo.text).not.toContain("internal reasoning")
    // tool output capped at the same 600 + ellipsis the Codex reader uses
    const resultLine = convo.text.split("\n").find((l) => l.startsWith("x".repeat(10)))
    expect(resultLine?.length).toBe(601)
    expect(resultLine?.endsWith("…")).toBe(true)
    expect(convo.text).toContain("N4 tool-result:")
    expect(convo.messagesTotal).toBe(4)
  })

  itSqlite("a session with no main chain answers unknown-tail — nothing readable, like an unreadable file", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: null }], [
      { nodeId: 1, chatMessage: user("q") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.format).toBe("unknown-tail")
    expect(convo.text).toBe("")
  })

  itSqlite("readTranscriptFor routes devin to the store reader — and a missing sessionId lands not-found", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 2 }], [
      { nodeId: 1, chatMessage: system("root") },
      { nodeId: 2, parentNodeId: 1, chatMessage: user("the ask") },
    ])
    const convo = readTranscriptFor("devin", db, { sessionId: "bald-swordfish" })
    expect(convo?.format).toBe("devin-sqlite")
    expect(() => readTranscriptFor("devin", db)).toThrow(DevinSessionNotFoundError)
  })

  itSqlite("a broken parent link degrades to a shorter chain, never a crash", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 4 }], [
      { nodeId: 4, parentNodeId: 99, chatMessage: assistant("tail answer") }, // parent 99 absent
      { nodeId: 2, chatMessage: user("orphaned ask") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.format).toBe("devin-sqlite")
    expect(convo.text).toContain("tail answer")
  })
})
