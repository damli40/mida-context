import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ensureDaemon } from "./control.js"
import { resolveHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { MCP_USAGE, createMidaMcpServer, parseMcpArgs, startupCheck } from "./mcp.js"
import { siblingEntryArgs } from "./sibling.js"

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
  // stdout is the JSON-RPC channel — a client that dies mid-write must not become an unhandled
  // stream error, and every diagnostic (including the usage refusal) goes to stderr
  process.stdout.on("error", () => {})
  const parsed = parseMcpArgs(process.argv.slice(2))
  if (!parsed.ok) {
    process.stderr.write(`mida-mcp: ${parsed.error}\n${MCP_USAGE}\n`)
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
  const up = home.has("network.json") && (await ensureDaemon(home, () => spawnDaemon(home.root), { waitMs: DAEMON_WAIT_MS }))
  const server = createMidaMcpServer({
    home,
    agent: gate.agent,
    project: parsed.args.project,
    sessionId,
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
