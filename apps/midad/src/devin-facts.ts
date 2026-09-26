import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"

/**
 * Devin CLI facts the code depends on — from Devin docs / local inspection, Sep 25
 * (Devin CLI v3000.11.3, docs.devin.ai/cli/extensibility/hooks + the owner's own
 * `~/.config/devin`, `~/.local/share/devin`). NOT verifiable from this repo: every
 * externally-observed fact lives in this one module so a wrong fact is fixed in
 * exactly one place.
 */

/**
 * The hook events Devin can fire (docs.devin.ai/cli/extensibility/hooks/overview and
 * …/hooks/lifecycle-hooks). Mida registers only the subset it acts on; the rest are
 * ignored by the payload reader like any other unknown event.
 */
export const DEVIN_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "PostCompaction",
  "SessionEnd",
] as const

/** Events that run the inject entry: session start carries the handoff; prompts carry what's-new. */
export const DEVIN_INJECT_EVENTS: readonly string[] = ["SessionStart", "UserPromptSubmit"]

/** Events that enqueue a save job — Devin's compaction event is PostCompaction, never PreCompact. */
export const DEVIN_SAVE_EVENTS: readonly string[] = ["PostToolUse", "Stop", "PostCompaction", "SessionEnd"]

/** Every event Mida writes into Devin's "hooks" config block, in install order. */
export const DEVIN_INSTALLED_EVENTS: readonly string[] = [...DEVIN_INJECT_EVENTS, ...DEVIN_SAVE_EVENTS]

/**
 * The environment variable Devin sets on every hook process it spawns — it carries the
 * project folder (Devin's hook payload has no `cwd`). Its presence also marks the process
 * as Devin-spawned, which is what the foreign-client guard reads: a Mida entry for any
 * other agent firing under it is Devin replaying that client's imported config.
 */
export const DEVIN_PROJECT_DIR_ENV = "DEVIN_PROJECT_DIR"

/**
 * User-level hook config: `~/.config/devin/config.json` under a "hooks" key, in the same
 * shape as Claude Code's hooks block (event → array of { hooks: [{ type: "command",
 * command }] }). Project-level `.devin/hooks.v1.json` exists but Mida does not use it.
 * `MIDA_DEVIN_CONFIG` overrides the path — the same escape hatch `MIDA_CODEX_CONFIG` gives
 * Codex — so tests and relocated installs never touch the real file.
 */
export function resolveDevinConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env.MIDA_DEVIN_CONFIG ?? join(homeDir, ".config", "devin", "config.json")
}

/**
 * The session database: SQLite (WAL, can exceed 2 GB), written live by Devin, holding every
 * session's message-node graph — opened read-only. The `transcripts/*.json` files next to it
 * are occasional exports, not the live record, and are never read. `MIDA_DEVIN_DB`
 * overrides the default so tests point at a synthetic file.
 */
export function resolveDevinDbPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env.MIDA_DEVIN_DB ?? join(homeDir, ".local", "share", "devin", "cli", "sessions.db")
}

/**
 * The drain-side check for a devin job's database path — the analogue of
 * transcriptPathAllowed for the file clients. Devin has exactly one sessions database, so
 * the allowed path is the configured path itself: the job must be an absolute path that
 * really is a regular file (never a symlink) whose realpath IS the resolved path's
 * realpath. Anything else — a stray .db file, a symlink to the real database, a path that
 * only shares the folder — is refused; the drain never reads an arbitrary file as a
 * session store.
 */
export function devinDbPathAllowed(dbPath: unknown, env: NodeJS.ProcessEnv, homeDir: string): dbPath is string {
  if (typeof dbPath !== "string" || dbPath === "" || !isAbsolute(dbPath)) return false
  try {
    const stat = lstatSync(dbPath)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    return realpathSync.native(dbPath) === realpathSync.native(resolveDevinDbPath(env, homeDir))
  } catch {
    return false
  }
}

/**
 * `node:sqlite` is a Node builtin only from 22.13; midad's engine floor is 22. A devin job
 * on an older runtime ends `bad` with reason `devin-needs-node-22.13` and doctor prints the
 * matching PROBLEM line. Kept here so the message and the gate are changed together.
 */
export const DEVIN_NODE_SQLITE_MIN = "22.13"

/**
 * The sessions database schema, observed Sep 25. `sessions.id` is a two-word slug
 * (`bald-swordfish`) expected to equal the hook payload's session_id — NOT verified;
 * a miss ends cleanly as `devin-session-not-found`. `message_nodes` is one row per
 * message; `main_chain_id` names the newest node of the live conversation and
 * `parent_node_id` walks it back to its root. The compiler's reader
 * (packages/compiler/src/transcript-devin.ts) depends on these column names.
 */
export const DEVIN_DB_SCHEMA = `CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
  model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
  title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT,
  workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL,
  metadata TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id));`

/**
 * The payload fields Devin's hooks send on stdin (local inspection, Sep 25): `session_id`
 * and `prompt_id` on every event; `source` on SessionStart, `prompt` on UserPromptSubmit,
 * `tool_name`/`tool_input` on tool events, `reason` on SessionEnd, `summary` on
 * PostCompaction (may be null). There is NO `transcript_path` and NO `cwd` — the session is
 * found in the database by session_id and the project folder comes from
 * DEVIN_PROJECT_DIR_ENV. `sessions.id` is a two-word slug expected to equal the hook's
 * session_id — unverified upstream; a miss ends cleanly as `devin-session-not-found`.
 */
