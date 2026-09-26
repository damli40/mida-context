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

// The LIVE compaction shape, probed on a real Devin CLI v3000.11.3 session Sep 26 (not
// verifiable from the repo): after a compaction the new chain's ROOT is the summarizer's own
// system prompt, fed the old chain verbatim as an injected user input. The summary itself is
// the assistant node a few nodes later whose NODE metadata carries an integer summarized_from
// pointing at the old-chain node the summary cut at; a system node right after re-injects it
// for the continuing model and carries the same mark. The root carries no summarized_from.
const SUMMARIZER_PROMPT = "You are a Summarizer that summarizes conversation history. Produce sections 1-9."
const summarizerInput = (chain: string) => `<conversation>${chain} VERBATIM: everything that happened</conversation>`
const continuation = (summary: string) =>
  `You are continuing work from a previous conversation thread. Below is a summary of it:\n${summary}`
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

  itSqlite("two compactions in the live shape: the summarized_from output pins, and the request follows the links to the first chain", () => {
    const db = makeDevinDb([{ id: "bald-swordfish", mainChainId: 135, workingDirectory: "/work/proj" }], [
      // chain 1 — the session's start, compacted away
      { nodeId: 0, chatMessage: system("you are devin"), metadata: { is_system_prefix: 1 } },
      { nodeId: 1, parentNodeId: 0, chatMessage: user("the original ask") },
      { nodeId: 2, parentNodeId: 1, chatMessage: assistant("early work") },
      { nodeId: 3, parentNodeId: 2, chatMessage: assistant("the branch point the first summary cut at") },
      { nodeId: 4, parentNodeId: 3, chatMessage: assistant("old chain continues past the cut") },
      // chain 2 — first compaction: root is the summarizer's prompt, the summary pair
      // carries summarized_from, then ordinary turns resume
      { nodeId: 110, chatMessage: system(SUMMARIZER_PROMPT), metadata: { is_system_prefix: 1 } },
      { nodeId: 111, parentNodeId: 110, chatMessage: injectedUser(summarizerInput("CHAIN ONE")) },
      { nodeId: 112, parentNodeId: 111, chatMessage: assistant("SUMMARY ONE of the session"), metadata: { summarized_from: 3 } },
      { nodeId: 113, parentNodeId: 112, chatMessage: system(continuation("SUMMARY ONE of the session")), metadata: { summarized_from: 3 } },
      { nodeId: 114, parentNodeId: 113, chatMessage: user("keep going") },
      { nodeId: 115, parentNodeId: 114, chatMessage: assistant("more work — the second cut point") },
      { nodeId: 116, parentNodeId: 115, chatMessage: assistant("chain two continues past the cut") },
      // chain 3 — second compaction, this is the live chain
      { nodeId: 130, chatMessage: system(SUMMARIZER_PROMPT), metadata: { is_system_prefix: 1 } },
      { nodeId: 131, parentNodeId: 130, chatMessage: injectedUser(summarizerInput("CHAIN TWO")) },
      { nodeId: 132, parentNodeId: 131, chatMessage: assistant("SUMMARY TWO the newest state"), metadata: { summarized_from: 115 } },
      { nodeId: 133, parentNodeId: 132, chatMessage: system(continuation("SUMMARY TWO the newest state")), metadata: { summarized_from: 115 } },
      { nodeId: 134, parentNodeId: 133, chatMessage: user("one more thing") },
      { nodeId: 135, parentNodeId: 134, chatMessage: assistant("wrapping up") },
    ])
    const convo = readDevinConversation(db, { sessionId: "bald-swordfish" })
    expect(convo.format).toBe("devin-sqlite")
    // the request survived two compactions by following each chain's summarized_from
    // link back to the chain it cut from — chain 3 → chain 2 → chain 1
    expect(convo.firstUserMessage).toBe("the original ask")
    expect(convo.text).toContain("user — original request (kept from the earlier chain):\nthe original ask")
    // the pinned summary is the live chain's summarized_from ASSISTANT node — the
    // summarizer's output, labelled for what it is
    expect(convo.text).toContain("N132 assistant — Summary of the earlier session (from compaction):")
    expect(convo.text).toContain("SUMMARY TWO the newest state")
    // the summarizer's own prompt, the verbatim histories it was fed, the earlier
    // summary's chain and the re-injection never render as turns
    expect(convo.text).not.toContain("You are a Summarizer")
    expect(convo.text).not.toContain("VERBATIM")
    expect(convo.text).not.toContain("SUMMARY ONE")
    expect(convo.text).not.toContain("early work")
    expect(convo.text).not.toContain("more work")
    expect(convo.text).not.toContain("keep going")
    expect(convo.text).toContain("N134 user:\none more thing")
    expect(convo.text).toContain("N135 assistant:\nwrapping up")
  })

  itSqlite("a later root whose chain carries no summarized_from is NOT a compaction — no summary block", () => {
    const db = makeDevinDb([{ id: "calm-otter", mainChainId: 32, workingDirectory: "/work/proj" }], [
      { nodeId: 0, chatMessage: system("you are devin"), metadata: { is_system_prefix: 1 } },
      { nodeId: 1, parentNodeId: 0, chatMessage: user("the original ask") },
      { nodeId: 2, parentNodeId: 1, chatMessage: assistant("work") },
      // a second root that is some other run (a helper sub-agent call), not a compaction:
      // is_system_prefix alone must never pin a summary — the live probe saw roots like
      // this outnumber real compactions two to one
      { nodeId: 30, chatMessage: system("You are a helper sub-agent. Search the repo for X."), metadata: { is_system_prefix: 1 } },
      { nodeId: 31, parentNodeId: 30, chatMessage: injectedUser("search for X") },
      { nodeId: 32, parentNodeId: 31, chatMessage: assistant("found X in a.ts") },
    ])
    const convo = readDevinConversation(db, { sessionId: "calm-otter" })
    expect(convo.format).toBe("devin-sqlite")
    expect(convo.text).not.toContain("Summary of the earlier session")
    expect(convo.text).not.toContain("You are a helper sub-agent")
    expect(convo.text).toContain("found X in a.ts")
    // with no link to follow, the lowest-root rule still finds the request
    expect(convo.firstUserMessage).toBe("the original ask")
  })

  itSqlite("no summarized_from assistant: the system re-injection's content pins instead", () => {
    const db = makeDevinDb([{ id: "calm-otter", mainChainId: 5, workingDirectory: "/work/proj" }], [
      { nodeId: 0, chatMessage: system("you are devin"), metadata: { is_system_prefix: 1 } },
      { nodeId: 1, parentNodeId: 0, chatMessage: user("the original ask") },
      { nodeId: 2, parentNodeId: 1, chatMessage: assistant("work") },
      { nodeId: 3, chatMessage: system(SUMMARIZER_PROMPT), metadata: { is_system_prefix: 1 } },
      { nodeId: 4, parentNodeId: 3, chatMessage: injectedUser(summarizerInput("CHAIN ONE")) },
      // the assistant node came back empty — the system re-injection still carries the text
      { nodeId: 5, parentNodeId: 4, chatMessage: system(continuation("THE SUMMARY via the system node")), metadata: { summarized_from: 2 } },
    ])
    const convo = readDevinConversation(db, { sessionId: "calm-otter" })
    expect(convo.text).toContain("Summary of the earlier session (from compaction):")
    expect(convo.text).toContain("THE SUMMARY via the system node")
    expect(convo.firstUserMessage).toBe("the original ask")
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
