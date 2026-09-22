import { basename, dirname, resolve } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"
import { callDaemon, socketPathFor } from "./control.js"
import type { MidaHome } from "./home.js"
import { degradedMessage } from "./hook-output.js"
import type { SessionStartBody } from "./hook-output.js"
import { appendLog } from "./log.js"
import { writeSeen } from "./seen.js"

/**
 * The local MCP adapter (M3-G): a stdio MCP server that is a pure client of the daemon's Unix
 * socket, exactly like the hooks. It holds no keys, signs nothing and exposes only read tools —
 * `read --as` through /cli, /handoff, /whatsnew, /health. The daemon keeps every gate: project
 * approval, capability and revocation are answered there, never here.
 *
 * The import discipline is the security boundary: this file may only reach leaf modules. Anything
 * that loads keys or can sign — keys.ts, skeleton.ts, runtime.ts, cli.ts, remember.ts and friends —
 * must stay out of this module's import graph. mcp.test.ts walks that graph and proves it.
 */

/** The agent names `mida init` provisions and `mida approve` accepts — a closed set. */
export const MCP_AGENTS = ["claude-code", "codex", "assistant"] as const
export type McpAgent = (typeof MCP_AGENTS)[number]

/** The namespaces `mida_read` may name — the same set the daemon's `read --as <agent> <ns>` accepts. */
export const READ_NAMESPACES = ["projects.current", "profile.skills", "preferences.communication"] as const
export type ReadNamespace = (typeof READ_NAMESPACES)[number]

/** The session-start hook's budgets — the adapter answers inside the same envelopes. */
const HANDOFF_TIMEOUT_MS = 8_000
const WHATS_NEW_TIMEOUT_MS = 1_500
/** `/cli` reads can take real chain calls; the terminal CLI waits 120 s, the adapter allows 30. */
const READ_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 2_000
const STATUS_PROBE_TIMEOUT_MS = 8_000

/** Every tool result is capped like the handoff text: 8 000 chars, cut with the same `…` marker. */
const TOOL_TEXT_CAP = 8_000
const capText = (text: string): string => (text.length > TOOL_TEXT_CAP ? `${text.slice(0, TOOL_TEXT_CAP - 1)}…` : text)

const toolText = (text: string) => ({ content: [{ type: "text" as const, text: capText(text) }] })
const degraded = (reason: string) => toolText(degradedMessage(reason))

export const MCP_USAGE = "usage: mida-mcp [--as claude-code|codex|assistant] [--project <dir>]"

export interface McpArgs {
  agent: McpAgent
  /** Absolute path — the folder the client launched the server for; reported to the daemon as cwd. */
  project: string
}

/**
 * The launch contract: `--as <agent>` (default `assistant`) and `--project <dir>` (default the
 * process cwd) are the only flags — anything else, or a flag without its value, is refused. The
 * refusal is a plain line for stderr; the process's stdout carries JSON-RPC and stays clean.
 */
export function parseMcpArgs(argv: string[]): { ok: true; args: McpArgs } | { ok: false; error: string } {
  let agent = "assistant"
  let project = process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === "--as" || flag === "--project") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `${flag} needs a value` }
      }
      if (flag === "--as") agent = value
      else project = value
      i += 1
    } else {
      return { ok: false, error: `unknown flag: ${flag}` }
    }
  }
  if (!(MCP_AGENTS as readonly string[]).includes(agent)) {
    return { ok: false, error: `unknown agent "${agent}" — --as takes ${MCP_AGENTS.join(" | ")}` }
  }
  return { ok: true, args: { agent: agent as McpAgent, project: resolve(project) } }
}

/** The stable tool surface — names and input schemas are API; the report carries them verbatim. */
export const MCP_TOOLS = [
  {
    name: "mida_handoff",
    description:
      "The project handoff the session-start hook would inject for this agent and folder: saved context from earlier sessions, or the plain refusal line when this agent is not approved here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mida_whats_new",
    description:
      "What's new since this session last checked — one short note about checkpoints other agents saved to this project. Delivered ids are recorded so a note is never repeated.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mida_read",
    description:
      "Read one Mida context area through the daemon — the same output `mida read --as <agent>` prints. Default namespace is projects.current, this folder's saved checkpoints.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          enum: ["projects.current", "profile.skills", "preferences.communication"],
          description: "The context area to read; default projects.current.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mida_status",
    description: "Whether the local midad daemon is answering and which agents are approved for this folder.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const

export interface McpServerDeps {
  home: MidaHome
  agent: McpAgent
  project: string
  /** This server instance's session id — the whats-new seen set is keyed by it. */
  sessionId: string
  /** False when the daemon could not be brought up at start — every tool then answers degraded. */
  daemonUp: boolean
}

/**
 * `mida_handoff` — the same /handoff call the session-start hook makes: same body, same timeout,
 * and the daemon's `text` is the answer, so the not-approved line is exactly the hook's. After a
 * delivered (non-refused) answer the covered contextIds seed this session's seen set, the same
 * writeSeen the hook performs.
 */
async function toolHandoff(deps: McpServerDeps) {
  if (!deps.daemonUp) return degraded("daemon-down")
  const reply = await callDaemon(
    deps.home,
    "/handoff",
    { agent: deps.agent, cwd: deps.project, sessionId: deps.sessionId },
    { timeoutMs: HANDOFF_TIMEOUT_MS },
  )
  if (reply.status === 0) return degraded("daemon-down")
  const body = reply.body as SessionStartBody | null
  if (typeof body?.text !== "string") return degraded("bad-reply")
  const covered =
    body.kind === "refused" || !Array.isArray(body.seen)
      ? undefined
      : body.seen.filter((id): id is string => typeof id === "string")
  if (covered !== undefined) {
    try {
      writeSeen(deps.home, deps.sessionId, covered)
    } catch {
      // a failed baseline write only means a later whats-new may re-offer what this covered
    }
  }
  return toolText(body.text)
}

/**
 * `mida_whats_new` — the prompt-hook's note as a tool: /whatsnew with the same body and the same
 * 1.5 s ceiling. On a delivered note the proposed seen ids are recorded the way the hook records
 * them, so the note is not repeated. A timeout logs the same whatsnew-timeout line the hook logs.
 */
async function toolWhatsNew(deps: McpServerDeps) {
  if (!deps.daemonUp) return degraded("daemon-down")
  const reply = await callDaemon(
    deps.home,
    "/whatsnew",
    { agent: deps.agent, cwd: deps.project, sessionId: deps.sessionId },
    { timeoutMs: WHATS_NEW_TIMEOUT_MS },
  )
  if (reply.status === 0) {
    appendLog(deps.home, "hook", { event: "whatsnew-timeout", agent: deps.agent, sessionId: deps.sessionId })
    return degraded("daemon-down")
  }
  const body = reply.body as { kind?: unknown; note?: unknown; reason?: unknown; seen?: unknown } | null
  if (body?.kind === "updates" && typeof body.note === "string" && body.note !== "") {
    const seen = Array.isArray(body.seen) ? body.seen.filter((id): id is string => typeof id === "string") : undefined
    if (seen !== undefined) {
      try {
        writeSeen(deps.home, deps.sessionId, seen)
      } catch {
        // a failed state write only means the same note may be offered once more
      }
    }
    return toolText(body.note)
  }
  if (body?.kind === "none") return toolText("Mida: nothing new from other agents since this session started.")
  if (body?.kind === "refused") {
    const reason = typeof body.reason === "string" ? body.reason : "refused"
    if (reason === "not-approved") {
      return toolText(`Mida: ${deps.agent} is not approved for this project — run \`mida approve ${deps.agent}\` in this folder.`)
    }
    if (reason === "revoked") {
      return toolText(`Mida: ${deps.agent}'s access was revoked by the owner. Nothing was shared.`)
    }
    // the two list-integrity refusals carry their own canonical lines — the same ones the
    // session-start handoff text uses (they are reproduced, not imported: handoff.ts must stay
    // out of this module's graph)
    if (reason === "list-tampered") {
      return toolText("Mida: the approved-projects list failed its signature check. Nothing was shared. Run `mida doctor`.")
    }
    if (reason === "list-unreadable") {
      return toolText("Mida: the approved-projects list could not be read: check the file's permissions. Nothing was shared. Run `mida doctor`.")
    }
    return toolText(`Mida: no context available right now (${reason}).`)
  }
  return degraded("bad-reply")
}

/**
 * `mida_read` — `/cli` with `["read", "--as", agent, namespace]`: the daemon runs the same code
 * `mida read --as` does and the printed lines are the result. Owner commands are not reachable
 * through this path — /cli refuses them before dispatch, and this tool only ever sends `read`.
 */
async function toolRead(deps: McpServerDeps, args: Record<string, unknown> | undefined) {
  if (!deps.daemonUp) return degraded("daemon-down")
  const namespace = args?.namespace
  if (namespace !== undefined && (typeof namespace !== "string" || !(READ_NAMESPACES as readonly string[]).includes(namespace))) {
    return toolText(`refused: namespace must be one of ${READ_NAMESPACES.join(", ")}`)
  }
  const argv = ["read", "--as", deps.agent, typeof namespace === "string" ? namespace : "projects.current"]
  const reply = await callDaemon(deps.home, "/cli", { argv, cwd: deps.project }, { timeoutMs: READ_TIMEOUT_MS })
  if (reply.status === 0) return degraded("daemon-down")
  const body = reply.body as { code?: unknown; lines?: unknown } | null
  if (typeof body?.code !== "number" || !Array.isArray(body.lines)) return degraded("bad-reply")
  return toolText(body.lines.map((line) => String(line)).join("\n"))
}

/**
 * `mida_status` — /health, then one /handoff probe per provisioned agent so "approved for this
 * folder" means exactly what the real gate answers (project list and chain capability included).
 * The probes run in parallel; their texts are never used — only the verdict. The output carries
 * no ids and no path under the home except the socket directory's own name.
 */
async function toolStatus(deps: McpServerDeps) {
  if (!deps.daemonUp) return degraded("daemon-down")
  const health = await callDaemon(deps.home, "/health", undefined, { timeoutMs: STATUS_TIMEOUT_MS })
  if (health.status === 0) return degraded("daemon-down")
  const body = health.body as { ok?: unknown; pid?: unknown; startedAt?: unknown; queueDepth?: unknown } | null
  if (body?.ok !== true) return degraded("bad-reply")
  const lines = [
    `midad: answering — pid ${typeof body.pid === "number" ? body.pid : "unknown"}, up since ${
      typeof body.startedAt === "string" ? body.startedAt : "unknown"
    }, queue ${typeof body.queueDepth === "number" ? body.queueDepth : "unknown"} — socket in ${basename(
      dirname(socketPathFor(deps.home)),
    )}`,
  ]
  const probes = await Promise.all(
    MCP_AGENTS.map((name) => callDaemon(deps.home, "/handoff", { agent: name, cwd: deps.project }, { timeoutMs: STATUS_PROBE_TIMEOUT_MS })),
  )
  const reason = (i: number): string | undefined => {
    const b = probes[i]?.body as { kind?: unknown; reason?: unknown } | null
    return b?.kind === "refused" && typeof b.reason === "string" ? b.reason : undefined
  }
  // A refusal that is about the folder or the approval list — not the agent — comes back the
  // same for all three probes; say it once instead of printing three identical verdicts.
  const FOLDER_LINES: Record<string, string> = {
    "not-a-project": "this folder is not a Mida project — no .mida marker found",
    "folder-mismatch": "this folder's .mida marker belongs to a different folder — it was moved or copied",
    "list-tampered": "the approved-projects list failed its signature check — run `mida doctor`",
    "list-unreadable": "the approved-projects list could not be read — check the file's permissions",
  }
  const folderReasons = new Set(probes.map((_, i) => reason(i)))
  const folderLine = folderReasons.size === 1 ? FOLDER_LINES[[...folderReasons][0] ?? ""] : undefined
  if (probes.every((p) => p.status !== 0) && folderLine !== undefined) {
    lines.push(folderLine)
  } else {
    for (let i = 0; i < MCP_AGENTS.length; i += 1) {
      const name = MCP_AGENTS[i]!
      const probe = probes[i]!
      const kind = (probe.body as { kind?: unknown } | null)?.kind
      if (probe.status === 0) lines.push(`${name}: no answer from the daemon`)
      else if (kind === "handoff" || kind === "empty") lines.push(`${name}: approved for this folder`)
      else if (reason(i) === "revoked") lines.push(`${name}: access revoked by the owner`)
      else if (reason(i) === "not-approved") lines.push(`${name}: not approved for this folder`)
      else lines.push(`${name}: cannot tell (${reason(i) ?? "bad reply"})`)
    }
  }
  return toolText(lines.join("\n"))
}

/**
 * Builds the MCP server. The caller wires the transport — stdio in `mida-mcp`, an in-memory pair
 * in tests. `daemonUp` is decided once at start: when the daemon could not come up, the server
 * still answers so the client sees a working MCP endpoint whose tools all say the same degraded
 * line — never a stack, never a protocol error for a daemon problem.
 */
export function createMidaMcpServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: "mida-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Mida read-only adapter over the local midad daemon. It can fetch the project handoff, the what's-new note, a namespace read and status — and that is all: there are deliberately no write tools here (no save, no remember, no approve, no revoke), because a model must not be able to write context through MCP without the owner having decided that.",
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...MCP_TOOLS] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as Record<string, unknown> | undefined
    switch (request.params.name) {
      case "mida_handoff":
        return toolHandoff(deps)
      case "mida_whats_new":
        return toolWhatsNew(deps)
      case "mida_read":
        return toolRead(deps, args)
      case "mida_status":
        return toolStatus(deps)
      default:
        throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${request.params.name}`)
    }
  })
  return server
}
