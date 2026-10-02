import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ensureDaemon } from "./control.js"
import { resolveHome } from "./home.js"
import { foreignClientReplayReason, parentProcessBasename } from "./devin-facts.js"
import { drainerEnv } from "./hook.js"
import { MCP_USAGE, createMidaMcpServer, parseMcpArgs, startupCheck } from "./mcp.js"
import { siblingEntryArgs } from "./sibling.js"
import { DEFAULT_TASK, folderTaskFor, taskOrUndefined } from "./task.js"

/**
 * `mida-mcp` — the local MCP adapter (M3-G). One stdio MCP server per client launch, a pure
 * client of the daemon's socket like the hooks: it reports its own launch folder as the project,
 * carries no keys and signs nothing. Startup mirrors inject-main.ts: the daemon is only expected
 * (or spawned) once `mida init` has written network.json, and a daemon that cannot come up does
 * not stop the server — every tool then answers the same degraded line instead of failing.
 */

/** The session-start hook's budget — the adapter waits the same 4 s for the daemon to come up. */
const DAEMON_WAIT_MS = 4_000

// Built `midad` beside this file in dist, or the .ts entry through the repo's tsx loader —
// sibling.ts decides; the Mida home is the child's working directory. Same env-stripping as the
// hooks: nothing agent-scoped (ANTHROPIC_* and friends) leaks into the daemon.
function spawnDaemon(cwd: string): void {
  const child = spawn(process.execPath, siblingEntryArgs("midad"), {
    detached: true,
    stdio: "ignore",
    cwd,
    env: drainerEnv(process.env),
  })
  child.on("error", () => {})
  child.unref()
}

async function main(): Promise<void> {
  // Mida's own summariser run sets MIDA_INNER=1 — inside it this entry is not an MCP
  // server at all: exit 0 at once, before parsing, before the home, before any socket.
  // Nothing is written — stdout is the JSON-RPC channel and stderr would leak into the
  // tool's own output that the limit check reads.
  if (process.env.MIDA_INNER === "1") return
  // stdout is the JSON-RPC channel — a client that dies mid-write must not become an unhandled
  // stream error, and every diagnostic (including the usage refusal) goes to stderr
  process.stdout.on("error", () => {})
  const parsed = parseMcpArgs(process.argv.slice(2))
  if (!parsed.ok) {
    process.stderr.write(`mida-mcp: ${parsed.error}\n${MCP_USAGE}\n`)
    process.exitCode = 2
    return
  }
  // Same foreign-client guard as the hook and inject entries (in-7 D1): Devin imports other
  // clients' MCP config and launches it under its own environment, so an entry for any other
  // client is a replay, not that client's session. One stderr line, exit 2, before the home
  // is resolved or the daemon is touched: otherwise a replayed entry could read and
  // mida_save under cursor or claude-desktop's identity (in-10 R-12). The second wall is the
  // parent process's basename (in-13 M-8): the Sep 26 live probe showed Devin launches MCP
  // children WITHOUT DEVIN_PROJECT_DIR or any env mark of its own — the parent is the only
  // thing left that names it. The lookup is lazy — it never runs once --as devin or the env
  // wall answered — and a failed lookup proceeds, because this is a replay guard, not the
  // permission check.
  const replay = foreignClientReplayReason(parsed.args.agent, process.env, parentProcessBasename)
  if (replay !== null) {
    // Devin imports Claude Code's user MCP list (Sep 26 probe), so a replayed claude-code entry
    // is EXPECTED traffic, not a broken server: it stays off but exits 0 — a non-zero exit reads
    // as an error storm in the host, and this server doing nothing is the intended state.
    if (parsed.args.agent === "claude-code") {
      process.stderr.write(
        "mida-mcp: this is Claude Code's Mida server running inside Devin, so it stays off. Devin uses its own Mida server.\n",
      )
      return
    }
    process.stderr.write(
      `mida-mcp: ${replay} — inside Devin's environment only --as devin may serve (got ${parsed.args.agent === undefined ? "no --as" : `--as ${parsed.args.agent}`})\n`,
    )
    process.exitCode = 2
    return
  }
  let home
  try {
    // the adapter never creates the home: a mistyped MIDA_HOME is refused before the
    // MidaHome constructor could mkdir/chmod the wrong folder (F6)
    home = resolveHome(process.env, { mustExist: true })
  } catch (error) {
    const e = error as { message?: unknown }
    process.stderr.write(`mida-mcp: ${typeof e.message === "string" ? e.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  const gate = startupCheck(home, parsed.args)
  if (!gate.ok) {
    // before ensureDaemon: a wrong MIDA_HOME must not start a key-less daemon in the wrong home
    process.stderr.write(`mida-mcp: ${gate.error}\n`)
    process.exitCode = 2
    return
  }
  // one session id per server instance — the whats-new seen set lives under it for this process's life
  const sessionId = `mcp-${gate.agent}-${randomBytes(4).toString("hex")}`
  // tk-1: the task is resolved ONCE here — one server process is one session (invariant 1):
  // --task beats MIDA_TASK beats the folder's current task; `main` when nothing named one.
  // Sent explicitly on every call, so a mid-life `mida task` switch cannot re-file this server.
  const task = parsed.args.task ?? taskOrUndefined(process.env.MIDA_TASK) ?? folderTaskFor(parsed.args.project).task ?? DEFAULT_TASK
  const up = home.has("network.json") && (await ensureDaemon(home, () => spawnDaemon(home.root), { waitMs: DAEMON_WAIT_MS }))
  const server = createMidaMcpServer({
    home,
    agent: gate.agent,
    project: parsed.args.project,
    sessionId,
    task,
    daemonUp: up,
  })
  await server.connect(new StdioServerTransport())
}

// `node dist/mida-mcp.js` reaches main through the bin symlink too: argv[1] is the .bin shim path
// while import.meta.url is the real file, so the comparison must run on realpaths.
const invoked =
  process.argv[1] !== undefined &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
if (invoked) {
  main().catch((error: unknown) => {
    const e = error as { message?: unknown }
    process.stderr.write(`mida-mcp: ${typeof e.message === "string" ? e.message : String(error)}\n`)
    process.exitCode = 1
  })
}
