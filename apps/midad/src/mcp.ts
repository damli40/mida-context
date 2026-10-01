import { realpathSync, statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"
import { callDaemon, socketPathFor } from "./control.js"
import type { ControlReply } from "./control.js"
import type { MidaHome } from "./home.js"
import { CHAIN_REFUSAL_TEXT, HANDOFF_BEGIN, HANDOFF_TAIL, OVERSIZE_NOTE_LEAD, degradedMessage } from "./hook-output.js"
import type { SessionStartBody } from "./hook-output.js"
import { appendLog } from "./log.js"
import { HOOK_CLIENTS, MCP_CLIENT_TOOLS } from "./mcp-clients.js"
import { findProjectMarker } from "./queue.js"
import { writeSeen } from "./seen.js"
import { isTaskName, TASK_RULE_TEXT } from "./task.js"

/**
 * The local MCP adapter (M3-G + in-5): a stdio MCP server that is a pure client of the daemon's
 * Unix socket, exactly like the hooks. It holds no keys and signs nothing. Its tools are reads —
 * `read --as` through /cli, /handoff, /whatsnew, /health — plus the one write the owner decided
 * MCP clients may have (claude-desktop and cursor only — AUTH-17), `mida_save`, which forwards the model's checkpoint fields to the daemon's
 * POST /save. The daemon keeps every gate — identity, project approval, the CREATE grant and
 * revocation are answered there, never here — and seals, stores and signs the checkpoint itself.
 *
 * The import discipline is the security boundary: this file may only reach leaf modules. Anything
 * that loads keys or can sign — keys.ts, skeleton.ts, runtime.ts, cli.ts, remember.ts, mcp-save.ts
 * and friends — must stay out of this module's import graph. mcp.test.ts walks that graph and
 * proves it.
 */

/**
 * An agent name `--as` may carry: the same characters the key store allows (`keys.ts` NAME), so
 * a name that passes here can only ever address `agents/<name>/` — never a path. Whether that
 * agent is registered in this home is the startup check's question, not the parser's.
 */
export const AGENT_NAME = /^[a-z0-9-]{1,64}$/

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
/** A save is a real chain transaction through the daemon's gates — the read budget would cut it short. */
const SAVE_TIMEOUT_MS = 60_000

/** Every tool result except the handoff reply is capped at 8 000 chars, cut with the `…` marker. */
const TOOL_TEXT_CAP = 8_000
const capText = (text: string): string => (text.length > TOOL_TEXT_CAP ? `${text.slice(0, TOOL_TEXT_CAP - 1)}…` : text)

/**
 * mida_handoff's own cap (UF-H, widened to 40,000 in UF-I): the plain cut could slice the closing
 * fence off the handoff, leaving the agent reading saved, untrusted text with no end marker. A
 * too-long handoff first tries the SHORT form — the preamble's over-target note shrunk to its
 * lead alone — and if that fits, the reply goes out whole with no cut claimed (UF-L). Otherwise
 * it keeps its END line: the kept text, then `…`, a line saying where the reply was cut, a blank
 * line, then the fence — and the whole reply still fits the cap. A handoff text without the
 * fence is cut the way capText cuts, at this same cap.
 */
const HANDOFF_TEXT_CAP = 40_000
const capHandoffText = (text: string): string => {
  if (text.length <= HANDOFF_TEXT_CAP) return text
  if (!text.includes(HANDOFF_TAIL)) return `${text.slice(0, HANDOFF_TEXT_CAP - 1)}…`
  // The preamble is everything before the BEGIN line. Only its WHOLE lines starting with the
  // over-target note's lead are rewritten — the same words inside saved text are the save's
  // own and stay (they are quoted by defuse). indexOf/slice and a replacer FUNCTION, never a
  // replacement string: saved text can hold `$&`.
  const beginAt = text.indexOf(HANDOFF_BEGIN)
  const preamble = beginAt === -1 ? "" : text.slice(0, beginAt)
  const body = beginAt === -1 ? text : text.slice(beginAt)
  const noteLines = (note: string) =>
    preamble
      .split("\n")
      .map((line) => (line.startsWith(OVERSIZE_NOTE_LEAD) ? note : line))
      .join("\n")
  // SHORT form first (UF-L): the lead alone still says the handoff was over its size target —
  // true whether or not the reply was cut — and when that alone brings the reply under the cap
  // nothing was removed, so no sentence may say it was.
  if (beginAt !== -1) {
    const short = `${noteLines(OVERSIZE_NOTE_LEAD)}${body}`
    if (short.length <= HANDOFF_TEXT_CAP) return short
  }
  // CUT form on the ORIGINAL text: the cut drops entries near the end — possibly rules, and the
  // marked UNSENT blocks, which sit at the very end — so the note says the reply was cut, and
  // every "shown below, marked UNSENT" clause goes: the block it points at is gone (UF-K).
  const cutNote = `${OVERSIZE_NOTE_LEAD.slice(0, -1)}, and this reply was cut at ${HANDOFF_TEXT_CAP.toLocaleString("en-US")} characters, so entries near the end are missing.`
  const cut = `${noteLines(cutNote).replace(/; (it is|\d+ of them (is|are)) shown below, marked UNSENT/g, () => "")}${body}`
  const tail = `…\n(Mida cut this reply at ${HANDOFF_TEXT_CAP.toLocaleString("en-US")} characters. Text after this point is missing.)\n\n${HANDOFF_TAIL}`
  // UF-L: keep the text BEFORE the END line — a slice of the whole text could carry its own END
  // line next to the appended one — and at least one char fewer than it has, so a reply that
  // says it was cut really removed something.
  const endAt = cut.indexOf(HANDOFF_TAIL)
  const beforeEnd = endAt === -1 ? cut : cut.slice(0, endAt)
  const keep = Math.min(HANDOFF_TEXT_CAP - tail.length, Math.max(0, beforeEnd.length - 1))
  return `${beforeEnd.slice(0, keep)}${tail}`
}

const toolText = (text: string) => ({ content: [{ type: "text" as const, text: capText(text) }] })
const handoffToolText = (text: string) => ({ content: [{ type: "text" as const, text: capHandoffText(text) }] })
const degraded = (reason: string) => toolText(degradedMessage(reason))

export const MCP_USAGE = "usage: mida-mcp --as <client> [--project <dir>] [--task <name>]   (--as is required — each client carries its own identity)"

export interface McpArgs {
  /** Undefined when the launch named no identity — the startup check turns that into a refusal. */
  agent: string | undefined
  /** Absolute path — the project folder; reported to the daemon as cwd. */
  project: string
  /** False when the folder came from the launch cwd. */
  projectGiven: boolean
  /** tk-1: the named task this server process works under — one process is one session. */
  task?: string
}

/**
 * The launch contract: `--as <client>` and `--project <dir>` (default the process cwd) are the
 * only flags — anything else, or a flag without its value, is refused. `--as` may stay absent
 * here so the refusal can name this home's known identities; the startup check is what rejects
 * it — a client that does not name its identity would silently share `assistant`.
 * The refusal is a plain line for stderr; the process's stdout carries JSON-RPC and stays clean.
 */
export function parseMcpArgs(argv: string[]): { ok: true; args: McpArgs } | { ok: false; error: string } {
  let agent: string | undefined
  let project: string | undefined
  let task: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === "--as" || flag === "--project" || flag === "--task") {
      const value = argv[i + 1]
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, error: `${flag} needs a value` }
      }
      if (flag === "--as") {
        if (agent !== undefined) return { ok: false, error: "--as given twice" }
        agent = value
      } else if (flag === "--task") {
        if (task !== undefined) return { ok: false, error: "--task given twice" }
        task = value
      } else {
        if (project !== undefined) return { ok: false, error: "--project given twice" }
        project = value
      }
      i += 1
    } else {
      return { ok: false, error: `unknown flag: ${flag}` }
    }
  }
  if (agent !== undefined && !AGENT_NAME.test(agent)) return { ok: false, error: `bad agent name "${agent}" — lower-case letters, digits and "-" only` }
  if (task !== undefined && !isTaskName(task)) return { ok: false, error: `bad task name "${task}" — ${TASK_RULE_TEXT}` }
  // the folder reported to the daemon is canonicalised: a --project typed in another case must
  // land on the same approved root (in-6 R6); a path that cannot be resolved stays the resolve()
  // form and the startup check names what is wrong with it
  const resolved = resolve(project ?? process.cwd())
  let projectRoot = resolved
  try {
    projectRoot = realpathSync.native(resolved)
  } catch {
    /* keep the resolved form — the marker check below reports a missing folder plainly */
  }
  return { ok: true, args: { agent, project: projectRoot, projectGiven: project !== undefined, task } }
}

/** "yes", "no", or "blocked" — a refused read is not a missing file. */
function probe(path: string): "yes" | "no" | "blocked" {
  try {
    statSync(path)
    return "yes"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPERM" || code === "EACCES" ? "blocked" : "no"
  }
}

const blockedLine = (path: string) =>
  `${path} could not be read (the system refused access). If it is under Desktop, Documents or Downloads, macOS blocks desktop apps from it — move Mida or the project out of those folders.`

/**
 * Refuses to serve — before a daemon is found or started — when the configured identity is not
 * registered in this home, or the project folder carries no Mida marker. Desktop clients launch
 * servers with their own environment and folder, so a wrong MIDA_HOME or a missing --project is
 * the common failure; naming which one beats every tool answering "not approved". The identity
 * file is checked for existence only: this module never reads key material (import-graph test).
 */
export function startupCheck(home: MidaHome, args: McpArgs): { ok: true; agent: string } | { ok: false; error: string } {
  // --as is required: a client that does not name its identity would silently share one. The
  // refusal lists the identities this home already holds so the fix is one edit to the client's
  // config — and `mida install <client>` provisions a fresh one when none of these fits.
  if (args.agent === undefined) {
    const names = home
      .list("agents")
      .filter((name) => AGENT_NAME.test(name) && home.has(`agents/${name}/identity.json`))
      .sort()
    return {
      ok: false,
      // no program name here — the entry point prefixes mida-mcp: once when it prints this
      error: `needs --as <client>: the client's own identity. This home knows: ${names.length === 0 ? "none yet" : names.join(", ")} — give each client its own: mida install <client>`,
    }
  }
  // assistant is the general-assistance stand-in — it can never hold a project approval, so a
  // client configured with it would refuse at the project gate forever. The fix is a client
  // identity, not an approve loop.
  if (args.agent === "assistant") {
    return { ok: false, error: "assistant is a general assistant and cannot read project context — run: mida install <client>" }
  }
  const agent = args.agent
  const identityPath = home.path(`agents/${agent}/identity.json`)
  const identity = probe(identityPath)
  if (identity === "blocked") return { ok: false, error: blockedLine(identityPath) }
  if (identity === "no") {
    return { ok: false, error: `no agent "${agent}" is set up in the Mida home ${home.root} — check MIDA_HOME in this client's config` }
  }
  if (probe(args.project) === "blocked") return { ok: false, error: blockedLine(args.project) }
  const marker = findProjectMarker(args.project)
  if (marker === null || marker.projectId === null) {
    return { ok: false, error: `${args.project} is not a Mida project folder — start the server with --project <your project folder>` }
  }
  return { ok: true, agent }
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
      "Read one Mida context area through the daemon; you get the same output as `mida read --as <agent> <namespace>`. For profile.skills and preferences.communication you get the facts saved there that this agent may read (an area it has no access to says refused). For projects.current (the default) you get only each saved checkpoint's id and author, across every task; mida_handoff gives the content for the current task.",
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
  {
    name: "mida_save",
    description:
      "Save a checkpoint of your work on this project so another approved agent can pick it up. Call it when the user asks to save context or hand off, and before you finish a task. Claude Desktop and Cursor get this tool; agents with Mida hooks, like Claude Code and Codex, save through those hooks instead. The daemon signs each save as this client's own identity after the owner's approval checks pass. A list holds at most 50 entries. One save per minute at most.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "What the work is trying to achieve — one or two sentences." },
        progress: { type: "array", items: { type: "string" }, description: "What has been done so far, newest last." },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: { decision: { type: "string" }, rationale: { type: "string" } },
            required: ["decision", "rationale"],
            additionalProperties: false,
          },
          description: "Decisions taken and why — the reasoning another agent must not re-litigate.",
        },
        rejected: {
          type: "array",
          items: {
            type: "object",
            properties: { approach: { type: "string" }, why: { type: "string" } },
            required: ["approach", "why"],
            additionalProperties: false,
          },
          description: "Approaches considered and turned down, with the reason.",
        },
        constraints: { type: "array", items: { type: "string" }, description: "Rules, deadlines and hard limits the work must respect." },
        artifacts: { type: "array", items: { type: "string" }, description: "Files, commands or resources the work produced or touched." },
        unresolvedIssue: {
          type: ["string", "null"],
          description: "The open problem blocking progress, or null when none is.",
        },
        nextAction: { type: "string", description: "The single next step the continuing agent should take." },
        remainingPlan: { type: "array", items: { type: "string" }, description: "The steps still ahead, in order." },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: { field: { type: "string" }, ref: { type: "string" } },
            required: ["field", "ref"],
            additionalProperties: false,
          },
          description: "Where claims above can be checked — a field name and the file, url or command that backs it.",
        },
        originalRequest: {
          type: "string",
          maxLength: 6000,
          description: "The user's own ask, word for word — optional, at most 6,000 characters.",
        },
      },
      required: ["objective", "progress", "decisions", "rejected", "constraints", "artifacts", "unresolvedIssue", "nextAction", "remainingPlan", "evidence"],
      additionalProperties: false,
    },
  },
] as const

export interface McpServerDeps {
  home: MidaHome
  agent: string
  project: string
  /** This server instance's session id — the whats-new seen set is keyed by it. */
  sessionId: string
  /**
   * tk-1: the task this server resolved ONCE at start — `--task`, then MIDA_TASK, then the
   * folder's current task; `main` when nothing named one. It travels as an explicit task on
   * every call, so a `mida task` switch while this server lives can never re-file it — and a
   * deterministic save session id (`mcp-<agent>-<projectId>`) can never resurrect a previous
   * process's pinned task. Absent means "no explicit task" — the daemon resolves its own way,
   * which keeps old call sites and tests valid.
   */
  task?: string
  /** False when the daemon could not be brought up at start — tools then answer degraded. */
  daemonUp: boolean
  /** mida_status's per-agent probe limit; STATUS_PROBE_TIMEOUT_MS unless a test shortens it. */
  statusProbeMs?: number
}

/**
 * Is the daemon answering? The boot-time `ensureDaemon` has a 4 s window; a daemon that came up
 * late must not stay reported down for the server's whole life, so a latched-false verdict earns
 * one cheap /health re-probe per call — a dead socket refuses fast, so this costs a call almost
 * nothing; a hung daemon costs it at most HEALTH_PROBE_MS before the degraded line. The answer
 * is a tri-state (in-35 R-2): "slow" when the probe's own timer fired — the socket was held, the
 * daemon is there but not answering — "down" when nothing could be reached at all.
 */
const HEALTH_PROBE_MS = 500

type DaemonState = "up" | "slow" | "down"

async function daemonAnswering(deps: McpServerDeps): Promise<DaemonState> {
  if (deps.daemonUp) return "up"
  const reply = await callDaemon(deps.home, "/health", undefined, { timeoutMs: HEALTH_PROBE_MS })
  const ok = reply.status !== 0 && (reply.body as { ok?: unknown } | null)?.ok === true
  if (ok) {
    deps.daemonUp = true
    return "up"
  }
  return reply.failure === "timeout" ? "slow" : "down"
}

/** A status-0 control reply's degraded reason: a timeout is a slow-but-there daemon, the rest are down. */
const downReason = (reply: ControlReply): "daemon-slow" | "daemon-down" =>
  reply.failure === "timeout" ? "daemon-slow" : "daemon-down"

/**
 * `mida_handoff` — the same /handoff call the session-start hook makes: same body, same timeout,
 * and the daemon's `text` is the answer, so the not-approved line is exactly the hook's. After a
 * delivered (non-refused) answer the covered contextIds seed this session's seen set, the same
 * writeSeen the hook performs.
 */
async function toolHandoff(deps: McpServerDeps) {
  const state = await daemonAnswering(deps)
  if (state !== "up") return degraded(state === "slow" ? "daemon-slow" : "daemon-down")
  const reply = await callDaemon(
    deps.home,
    "/handoff",
    { agent: deps.agent, cwd: deps.project, sessionId: deps.sessionId, task: deps.task },
    { timeoutMs: HANDOFF_TIMEOUT_MS },
  )
  if (reply.status === 0) return degraded(downReason(reply))
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
  return handoffToolText(body.text)
}

/**
 * `mida_whats_new` — the prompt-hook's note as a tool: /whatsnew with the same body and the same
 * 1.5 s ceiling. On a delivered note the proposed seen ids are recorded the way the hook records
 * them, so the note is not repeated. A timeout logs the same whatsnew-timeout line the hook logs.
 */
async function toolWhatsNew(deps: McpServerDeps) {
  const state = await daemonAnswering(deps)
  if (state !== "up") return degraded(state === "slow" ? "daemon-slow" : "daemon-down")
  const reply = await callDaemon(
    deps.home,
    "/whatsnew",
    { agent: deps.agent, cwd: deps.project, sessionId: deps.sessionId, task: deps.task },
    { timeoutMs: WHATS_NEW_TIMEOUT_MS },
  )
  if (reply.status === 0) {
    appendLog(deps.home, "hook", { event: "whatsnew-timeout", agent: deps.agent, sessionId: deps.sessionId })
    return degraded(downReason(reply))
  }
  const body = reply.body as { kind?: unknown; note?: unknown; reason?: unknown; seen?: unknown; text?: unknown } | null
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
  if (body?.kind === "none") return toolText("Mida: nothing new since the last check.")
  if (body?.kind === "refused") {
    const reason = typeof body.reason === "string" ? body.reason : "refused"
    if (reason === "general-assistance") {
      // reproduced like the refusals above — the whats-new refusal carries reason only
      return toolText(`Mida: ${deps.agent} is a general assistant and cannot read project context — run \`mida install <client>\`.`)
    }
    if (reason === "not-approved") {
      return toolText(`Mida: ${deps.agent} is not approved for this project — run \`mida approve ${deps.agent}\` in this folder.`)
    }
    if (reason === "revoked") {
      return toolText(`Mida: ${deps.agent}'s access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.`)
    }
    // the chain could not answer honestly — the same line the hook prints for each reason
    // (imported, unlike the refusal lines above: hook-output.ts is a leaf this adapter may
    // already reach). Busy, a local misconfiguration, a refused key, and the store's own
    // versions of those each get their own wording (R-8, in-12 N-8).
    if (reason in CHAIN_REFUSAL_TEXT) {
      return toolText(CHAIN_REFUSAL_TEXT[reason as keyof typeof CHAIN_REFUSAL_TEXT])
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
    // the two identity refusals carry their own lines: the daemon's `text` when it sends one —
    // a /whatsnew refusal answers reason-only, so the same line is reproduced here the way the
    // ones above are (handoff.ts stays out of this module's graph). "identity-unreadable" means
    // the file is there but will not load — never report that as "not set up".
    if (reason === "no-identity" || reason === "identity-unreadable") {
      return toolText(
        typeof body.text === "string"
          ? body.text
          : reason === "no-identity"
            ? `Mida: no agent "${deps.agent}" is set up in this Mida home (${deps.home.root}). Nothing was shared.`
            : `Mida: ${deps.agent}'s identity in this Mida home (${deps.home.root}) exists but could not be read. Nothing was shared. Run \`mida doctor\`.`,
      )
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
  const state = await daemonAnswering(deps)
  if (state !== "up") return degraded(state === "slow" ? "daemon-slow" : "daemon-down")
  const namespace = args?.namespace
  if (namespace !== undefined && (typeof namespace !== "string" || !(READ_NAMESPACES as readonly string[]).includes(namespace))) {
    return toolText(`refused: namespace must be one of ${READ_NAMESPACES.join(", ")}`)
  }
  const argv = ["read", "--as", deps.agent, typeof namespace === "string" ? namespace : "projects.current"]
  const reply = await callDaemon(deps.home, "/cli", { argv, cwd: deps.project }, { timeoutMs: READ_TIMEOUT_MS })
  if (reply.status === 0) return degraded(downReason(reply))
  const body = reply.body as { code?: unknown; lines?: unknown } | null
  if (typeof body?.code !== "number" || !Array.isArray(body.lines)) return degraded("bad-reply")
  return toolText(body.lines.map((line) => String(line)).join("\n"))
}

/**
 * `mida_status` — /health, then one /handoff probe per agent registered in this home (plus this
 * server's own identity) so "approved for this folder" means exactly what the real gate answers
 * (project list and chain capability included). The probes run in parallel; their texts are never
 * used — only the verdict. The output carries no ids and no path under the home except the socket
 * directory's own name.
 */
async function toolStatus(deps: McpServerDeps) {
  const state = await daemonAnswering(deps)
  if (state !== "up") return degraded(state === "slow" ? "daemon-slow" : "daemon-down")
  const health = await callDaemon(deps.home, "/health", undefined, { timeoutMs: STATUS_TIMEOUT_MS })
  if (health.status === 0) return degraded(downReason(health))
  const body = health.body as { ok?: unknown; pid?: unknown; startedAt?: unknown; queueDepth?: unknown } | null
  if (body?.ok !== true) return degraded("bad-reply")
  // the socket is same-user, but a malformed body is still only printed after a shape check —
  // a string that is not ISO-shaped never reaches the output
  const startedAt =
    typeof body.startedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body.startedAt) ? body.startedAt : "unknown"
  const lines = [
    `midad: answering — pid ${typeof body.pid === "number" ? body.pid : "unknown"}, up since ${startedAt}, queue ${
      typeof body.queueDepth === "number" ? body.queueDepth : "unknown"
    } — socket in ${basename(dirname(socketPathFor(deps.home)))}`,
  ]
  // the same set keys.ts:listAgentNames computes — reproduced, not imported: keys.ts must stay
  // out of this module's graph — plus this server's own identity, whose verdict is printed even
  // when it is not registered here
  const agents = [
    ...new Set([deps.agent, ...deps.home.list("agents").filter((name) => AGENT_NAME.test(name) && deps.home.has(`agents/${name}/identity.json`))]),
  ].sort()
  const probeMs = deps.statusProbeMs ?? STATUS_PROBE_TIMEOUT_MS
  const probes = await Promise.all(
    agents.map((name) => callDaemon(deps.home, "/handoff", { agent: name, cwd: deps.project }, { timeoutMs: probeMs })),
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
    for (let i = 0; i < agents.length; i += 1) {
      const name = agents[i]!
      const probe = probes[i]!
      const kind = (probe.body as { kind?: unknown } | null)?.kind
      // AUTH-16: status 0 covers three different failures. Only "unreachable" means the daemon
      // did not answer — the others, and the daemon's read-slow refusal (which usually comes AFTER
      // the approval check passed), mean this call could not tell the verdict, never "not approved"; this call's health check already found it up, so a timeout is a slow
      // read and a bad reply is an unreadable one — neither may read as a missing daemon.
      if (probe.status === 0 && probe.failure === "unreachable") lines.push(`${name}: no answer from the daemon`)
      else if (probe.status === 0 && probe.failure === "timeout") {
        // rounded DOWN to a tenth, so "took over N s" is never more than the limit; no claim the
        // daemon is up — it may have frozen after this call's health check
        const seconds = String(Math.floor(probeMs / 100) / 10)
        lines.push(`${name}: could not tell. Reading its context took over ${seconds} s. Ask again in a moment.`)
      } else if (probe.status === 0) lines.push(`${name}: could not tell. Mida could not read the daemon's reply.`)
      else if (kind === "handoff" || kind === "empty") lines.push(`${name}: approved for this folder`)
      else if (reason(i) === "revoked") lines.push(`${name}: access revoked by the owner`)
      else if (reason(i) === "general-assistance") lines.push(`${name}: a general assistant — it cannot read project context`)
      else if (reason(i) === "not-approved") lines.push(`${name}: not approved for this folder`)
      else if (reason(i) === "read-slow") lines.push(`${name}: could not tell. The daemon ran out of time reading its context; its approval may already have passed. Ask again in a moment.`)
      else lines.push(`${name}: cannot tell (${reason(i) ?? "bad reply"})`)
    }
  }
  return toolText(lines.join("\n"))
}

/**
 * `mida_save` — POST /save with the model's checkpoint fields exactly as sent: the adapter adds
 * only who it is (`agent`) and where it ran (`cwd`). The daemon decides everything — a field it
 * does not know reaches its validator and is named in the refusal, and the saved or refused text
 * comes back verbatim. The tool's own timeout is wide: a direct save is a real transaction.
 */
async function toolSave(deps: McpServerDeps, args: Record<string, unknown> | undefined) {
  const state = await daemonAnswering(deps)
  if (state !== "up") return degraded(state === "slow" ? "daemon-slow" : "daemon-down")
  const reply = await callDaemon(
    deps.home,
    "/save",
    { agent: deps.agent, cwd: deps.project, fields: args ?? {}, task: deps.task },
    { timeoutMs: SAVE_TIMEOUT_MS },
  )
  if (reply.status === 0) return degraded(downReason(reply))
  const body = reply.body as { kind?: unknown; text?: unknown } | null
  if ((body?.kind !== "saved" && body?.kind !== "refused") || typeof body.text !== "string") return degraded("bad-reply")
  return toolText(body.text)
}

/**
 * Builds the MCP server. The caller wires the transport — stdio in `mida-mcp`, an in-memory pair
 * in tests. `daemonUp` is decided once at start: when the daemon could not come up, the server
 * still answers so the client sees a working MCP endpoint whose tools all say the same degraded
 * line — never a stack, never a protocol error for a daemon problem.
 */
export function createMidaMcpServer(deps: McpServerDeps): Server {
  // AUTH-17: mida_save is offered only to the identities the save route signs for — a hook-saved
  // client (claude-code, codex) or an unknown name would only ever get its refusal. The refusal
  // stays in mcp-save.ts as the backstop: clients cache tool lists.
  const offersSave = MCP_CLIENT_TOOLS.includes(deps.agent)
  const server = new Server(
    { name: "mida-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: offersSave
        ? "Mida adapter over the local midad daemon. It can fetch the project handoff, the what's-new note, a namespace read and status, and it can save a checkpoint with mida_save — the daemon validates, gates, scrubs and signs that write. Owner operations stay deliberately absent: there is no approve, revoke, request or remember here, because a model must never be able to change who has access through MCP."
        : HOOK_CLIENTS.includes(deps.agent)
          ? `Mida adapter over the local midad daemon. It can fetch the project handoff, the what's-new note, a namespace read and status. This server has no save tool: this client's saves come only from its Mida hooks, and only while they are installed.${
              // Fable review: doctor cannot read Codex's trust state — say what the owner must do instead
              deps.agent === "codex" ? " Codex ignores them until you trust them: open codex, type /hooks, and trust the Mida entries." : ""
            } Owner operations stay absent: no approve, revoke, request or remember, because a model must never change who has access through MCP.`
          : "Mida adapter over the local midad daemon. It can fetch the project handoff, the what's-new note, a namespace read and status. This server has no save tool for this client: mida_save signs only for claude-desktop and cursor. Owner operations stay absent: no approve, revoke, request or remember, because a model must never change who has access through MCP.",
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.filter((tool) => offersSave || tool.name !== "mida_save"),
  }))
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
      case "mida_save":
        return toolSave(deps, args)
      default:
        throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${request.params.name}`)
    }
  })
  return server
}
