import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"
import { decodeUint64, namespaceById } from "@mida/protocol"
import { REQUEST_LIFETIME_SECONDS } from "@mida/sdk"
import { permissionNames } from "@mida/grant-advisor"
import { callDaemon, ensureDaemon } from "./control.js"
import { runDoctor, runDoctorLive } from "./doctor.js"
import { MidaHome, resolveHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { CODEX_TRUST_SENTENCE, installClaudeCode, installCodex, uninstallClaudeCode, uninstallCodex } from "./install.js"
import type { InstallTool } from "./install.js"
import { attemptNamespaceRead, readOwnerFacts, remember } from "./remember.js"
import { Runtime, NAMESPACE } from "./runtime.js"
import type { Network, ServiceRuntime } from "./runtime.js"
import { approve, authorNamesFor, init, readCheckpoints, requestAccess, revoke, saveCheckpoint } from "./skeleton.js"

/** The agents `mida init` provisions — `assistant` is a stand-in for any other assistant you use. */
const AGENTS = ["claude-code", "codex", "assistant"]
/** The agents `mida init` provisions — `assistant` is a stand-in for any other assistant you use. Only the real tools can be installed or doctored. */
const INSTALL_TOOLS = ["claude-code", "codex"]
const WITH_AGENT = ["request", "approve", "save-demo", "read", "revoke"]
const WITH_PROJECT = ["save-demo"]
export const USAGE =
  "usage: mida init | install <tool> | uninstall <tool> | doctor [--live <tool>] | request <agent> | approve <agent> | save-demo <agent> <projectId> | read <agent> <projectId> | read --as <agent> | remember <fact> | revoke <agent>" +
  "   (tool = claude-code | codex; agent = claude-code | codex | assistant — assistant is a stand-in for any other assistant you use)"
/** Every first word runCli understands — the daemon's /cli route refuses anything else. */
export const CLI_COMMANDS: readonly string[] = ["init", "remember", ...WITH_AGENT]
/**
 * The commands that change who has access. Only `mida` in the owner's own terminal may run them —
 * they open the owner runtime in-process and are never sent to the daemon socket.
 */
export const OWNER_COMMANDS: readonly string[] = ["init", "approve", "revoke", "remember"]
/** The owner commands that must see a real terminal. `init` is exempt: it grants nothing to an agent. */
const TERMINAL_COMMANDS: readonly string[] = ["approve", "revoke", "remember"]
export const NEEDS_TERMINAL_LINE = "needs-terminal: run this yourself in a terminal window"

/** What the daemon answers when an owner command reaches /cli anyway. */
export function ownerOnlyLine(command: string): string {
  return `This changes who has access, so it only runs in your own terminal: mida ${command}`
}

export interface CliDeps {
  home: MidaHome
  network: Network
  print(line: string): void
  /** The folder the command was run from — `approve` records it on the owner-signed project list. */
  cwd?: string
  /**
   * After a successful approve or revoke the command pokes the daemon for a drain pass so the
   * service notices on its next pass instead of its next tick. Best-effort: a daemon that is not
   * running cannot be kicked, and a failed kick never fails the command. Injectable in tests.
   */
  kickDaemon?: () => unknown | Promise<unknown>
  /**
   * One plain line before each slow step — registering keys, opening namespaces, sending
   * transactions, republishing reader wraps. The default writes the line to STDERR, so nothing
   * printed to stdout changes shape. A line is always present tense and never carries a key, a
   * seed, a signature or a full 64-hex value. Tests inject a collector.
   */
  progress?: (line: string) => void
  /**
   * Drops whatever is already buffered on stdin — a paste typed while the command ran must not
   * be consumed as the answer to `Type yes to approve:`. Called right before the ask is printed;
   * it drains without blocking. The default drains the real stdin; tests inject a spy.
   */
  drainInput?: () => unknown | Promise<unknown>
  /**
   * Reads the one line `approve` waits on. The default asks the real terminal; tests inject an
   * answer. There is no flag, file or environment variable that skips the question.
   */
  prompt?: (question: string) => Promise<string>
  /**
   * Terminal presence for the commands that require it — approve, revoke, remember. The defaults
   * are the real `process.stdin`/`process.stdout`; tests inject them. There is no flag, file or
   * environment variable that skips the check.
   */
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
}

/**
 * The /cli route's input rule: argv is data, never shell — an array of at most 8 strings of at most
 * 4,096 chars each, whose first word is a command runCli knows. Anything else is refused.
 */
export function validCliArgv(argv: unknown): argv is string[] {
  return (
    Array.isArray(argv) &&
    argv.length <= 8 &&
    argv.every((arg) => typeof arg === "string" && arg.length <= 4096) &&
    CLI_COMMANDS.includes(argv[0] as string)
  )
}

/**
 * The agent-facing commands against an already-open service runtime — what the daemon's /cli
 * route is allowed to run. Owner commands (init/approve/revoke/remember) are refused outright:
 * a ServiceRuntime cannot sign as the owner, and the refusal is stated here so the socket answer
 * is always the same line. Returns the exit code; output goes to print.
 */
export async function runCliWithRuntime(
  argv: string[],
  runtime: ServiceRuntime,
  print: (line: string) => void,
  /** `cwd` is the folder the command ran in — kept for interface parity; owner commands never reach here. */
  context?: { cwd?: string },
): Promise<number> {
  const [command = ""] = argv
  if (OWNER_COMMANDS.includes(command)) {
    print(ownerOnlyLine(command))
    return 2
  }
  const asFlag = command === "read" && argv[1] === "--as"
  const agent = asFlag ? (argv[2] ?? "") : (argv[1] ?? "")
  const projectId = argv[2] ?? ""
  const usage = () => {
    print(USAGE)
    return 2
  }
  if (!WITH_AGENT.includes(command)) return usage()
  if (WITH_AGENT.includes(command) && !AGENTS.includes(agent)) return usage()
  if (command === "read" && !asFlag && projectId.length === 0) return usage()
  if (WITH_PROJECT.includes(command) && projectId.length === 0) return usage()

  try {
    if (command === "request") {
      print(`requested ${agent} ${(await requestAccess(runtime, agent)).requestId}`)
    } else if (command === "save-demo") {
      const result = await saveCheckpoint(runtime, agent, {
        projectId,
        sessionId: "cli-demo",
        continuesSession: null,
        compiledBy: "mida-cli",
        checkpoint: {
          eventId: `cli-demo-${agent}-${projectId}`, agent, source: "agent-tool", createdAt: new Date().toISOString(),
          objective: "M0 demo checkpoint", originalRequest: null, progress: [], decisions: [], rejected: [],
          constraints: [], artifacts: [], unresolvedIssue: null, nextAction: "demo", remainingPlan: [], evidence: [],
        },
      })
      print(`saved ${result.contextId} tx ${result.transactionHash} in ${result.milliseconds} ms`)
    } else if (command === "read") {
      if (asFlag) {
        // `mida read --as <agent>`: what this agent can see, through the real protocol — the owner
        // facts its grants cover, then a real `projects.current` attempt whose answer (or refusal
        // code) comes from the server, never a local pre-check.
        const facts = await readOwnerFacts(runtime, agent)
        print("What you have told Mida about yourself")
        for (const fact of facts) print(`  ${fact.text}`)
        const attempt = await attemptNamespaceRead(runtime, agent, NAMESPACE)
        print(attempt.ok ? `${NAMESPACE}: read ${attempt.objects} object(s)` : `${NAMESPACE}: refused ${attempt.code}`)
      } else {
        const result = await readCheckpoints(runtime, agent, projectId)
        print(`read ${result.checkpoints.length} checkpoint(s) in ${result.milliseconds} ms`)
        const authorNames = authorNamesFor(runtime)
        for (const checkpoint of result.checkpoints) {
          const author = authorNames[checkpoint.authorId.toLowerCase()] ?? "unknown agent"
          print(`  ${checkpoint.contextId} written by ${author} (on-chain author ${checkpoint.authorId.slice(0, 10)}…)`)
        }
      }
    }
    return 0
  } catch (error) {
    // The error code only — plus the one plain-English line a code can honestly name.
    const code = (error as { code?: unknown }).code
    if (code === "already-approved") {
      print(`${agent} is already approved. To let it use THIS folder too, run \`mida approve ${agent}\` here (no transaction, nothing to pay).`)
    } else {
      print(`refused: ${typeof code === "string" ? code : "ERROR"}`)
    }
    return 1
  }
}

/**
 * The owner commands — init, approve, revoke, remember — run here, in the `mida` process, on the
 * owner runtime. They never touch the daemon socket: the daemon cannot sign as the owner, and a
 * socket client must never be able to.
 */
async function runOwnerCommand(argv: string[], runtime: Runtime, deps: CliDeps): Promise<number> {
  const command = argv[0]!
  const agent = argv[1] ?? ""
  const usage = () => {
    deps.print(USAGE)
    return 2
  }
  if ((command === "approve" || command === "revoke") && !AGENTS.includes(agent)) return usage()
  if (command === "remember" && argv.slice(1).join(" ").trim().length === 0) return usage()

  try {
    if (command === "init") {
      const result = await init(runtime, AGENTS)
      deps.print(`owner ${result.owner}`)
      for (const [name, agentId] of Object.entries(result.agents)) deps.print(`agent ${name} ${agentId}`)
    } else if (command === "remember") {
      const result = await remember(runtime, argv.slice(1).join(" "))
      deps.print(result.kind === "remembered" ? `remembered ${result.contextId} in ${result.namespace}` : `refused: ${result.code}`)
      return result.kind === "remembered" ? 0 : 1
    } else if (command === "approve") {
      const prompt = deps.prompt ?? terminalPrompt
      const drain = deps.drainInput ?? drainBufferedStdin
      const result = await approve(runtime, agent, deps.cwd, async (preview) => {
        if (preview.kind === "project") {
          deps.print(`${preview.agent} already holds a live grant; this lists it for project ${preview.projectId}`)
        } else {
          deps.print(`${preview.agent} is asking for:`)
          for (const scope of preview.requested) {
            deps.print(`  ${namespaceById(scope.namespaceId).name}: ${permissionNames(scope.permissions).join(" + ")}`)
          }
          deps.print(`  until ${new Date(Number(preview.expiresAt) * 1000).toISOString()}`)
          if (preview.scopes.length < preview.requested.length) {
            deps.print(`  ${preview.requested.length - preview.scopes.length} scope(s) are already granted on chain; only the missing ones are signed`)
          }
          deps.print(`grant advisor: ${preview.advice.risk} risk; recommends ${preview.advice.recommended.length} scope(s) until ${new Date(Number(decodeUint64(preview.advice.recommendedExpiresAt)) * 1000).toISOString()}`)
          for (const warning of preview.advice.warnings) deps.print(`  ${warning.severity}: ${warning.messageKey}`)
        }
        // Anything the owner typed — or pasted — before this question existed is stale input:
        // drain it so only a line typed against the visible ask can be the answer.
        await drain()
        return (await prompt("Type yes to approve: ")).trim() === "yes"
      })
      deps.print(
        result.transactionHash === null
          ? `approved ${agent} for project ${result.projectId}; the on-chain grant was already live`
          : `approved ${agent} tx ${result.transactionHash} gas ${result.gasUsed}` +
              (result.projectId !== undefined ? ` project ${result.projectId}` : ""),
      )
      // a list rebuilt from a bad signature silently dropped rows — the owner must hear the count
      if (result.droppedRows !== undefined && result.droppedRows !== 0) {
        deps.print(
          result.droppedRows === null
            ? "the old approved-projects list was invalid; the old list was discarded"
            : `the old approved-projects list was invalid; ${result.droppedRows} row(s) were dropped`,
        )
      }
    } else {
      const result = await revoke(runtime, agent)
      deps.print(`revoked ${agent} tx ${result.transactionHashes.join(" ")}; new key sent to: ${result.rewrapped.join(", ") || "nobody"}`)
    }
    return 0
  } catch (error) {
    deps.print(ownerRefusalLine(command, agent, error))
    // Owner commands run in the owner's own terminal, and a bare "ERROR" leaves them blind. Only
    // when they ask (MIDA_DEBUG=1): the error's name and first lines, long hex strings masked.
    if (process.env.MIDA_DEBUG === "1") {
      const e = error as { name?: unknown; shortMessage?: unknown; message?: unknown; details?: unknown }
      const text = [e.name, e.shortMessage ?? e.message, e.details].filter((part) => typeof part === "string").join(" | ")
      deps.print(`debug: ${text.split("\n").slice(0, 6).join(" / ").replace(/[0-9a-fA-F]{40,}/g, "<hex>").slice(0, 900)}`)
    }
    return 1
  }
}

/**
 * What an owner command prints when it fails. Codes with an obvious next step get a plain line
 * that names it; everything else keeps `refused: <code>` — a message from a deeper layer is
 * never echoed because it could carry data. `agent` is the command's subject — for `remember`
 * argv[1] is fact text, but the agent-naming codes cannot surface from remember anyway.
 */
export function ownerRefusalLine(command: string, agent: string, error: unknown): string {
  const code = (error as { code?: unknown }).code
  switch (code) {
    // The owner saw the preview and answered something other than yes — nothing was signed.
    case "not-approved": return "not approved"
    case "REQUEST_EXPIRED":
      return `${agent}'s request has expired (a request lasts ${Number(REQUEST_LIFETIME_SECONDS) / 60} minutes): run \`mida request ${agent}\` and approve again`
    case "already-approved":
      return `${agent} is already approved. To let it use THIS folder too, run \`mida approve ${agent}\` here (no transaction, nothing to pay).`
    case "no-pending-request":
      return `${agent} has no pending request — run \`mida request ${agent}\` first`
    case "agent-unidentified":
    case "agent-not-setup":
      return `${agent} is not set up on this machine — run \`mida init\` first`
    // The message IS the answer: we built it from the balance, the cost and the shortfall.
    case "OWNER_WALLET_LOW":
      return error instanceof Error ? error.message : "refused: OWNER_WALLET_LOW"
    case "not-a-project":
      return `this folder cannot hold a project — run \`mida approve ${agent}\` inside the project's folder`
    case "list-unreadable":
      return "the approved-projects list could not be read — check the file's permissions"
    default:
      return `refused: ${typeof code === "string" ? code : "ERROR"}`
  }
}

/**
 * How long the drain listens before the ask is printed — long enough for the OS to deliver a
 * buffered paste, short enough that a human about to read the question never notices.
 */
const STDIN_DRAIN_MS = 25

/**
 * Discards whatever is already waiting on stdin, without blocking: resume the stream, drop every
 * chunk that arrives for one beat, then pause again so the readline question reads fresh input.
 * Nothing here echoes or stores what was dropped.
 */
function drainBufferedStdin(): Promise<void> {
  const stdin = process.stdin
  return new Promise((resolve) => {
    const drop = (): void => {}
    stdin.on("data", drop)
    stdin.resume()
    const timer = setTimeout(() => {
      stdin.pause()
      stdin.removeListener("data", drop)
      resolve()
    }, STDIN_DRAIN_MS)
    timer.unref()
  })
}

/** The real-terminal prompt — the only way `approve` gets its yes outside tests. */
function terminalPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/**
 * One `mida` command end to end: opens the owner runtime in-process (it is the only runtime that
 * can sign as the owner), runs the command, closes. Owner commands run their own dispatch; the
 * agent-facing ones share the socket path's.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (!validCliArgv(argv)) {
    deps.print(USAGE)
    return 2
  }
  const command = argv[0]!
  // approve, revoke and remember change who has access or write owner facts, so they ask for a
  // real terminal — stdin and stdout both TTY — before the owner key is even loaded. This is a
  // speed bump, not a wall: until the passkey work (M3) the owner key is still a file on disk,
  // and a determined program running as the user can read it or fake a terminal. The check is
  // here to stop a confused caller from changing authority by accident, not to stop one acting
  // on purpose.
  const stdinTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true
  const stdoutTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true
  if (TERMINAL_COMMANDS.includes(command) && !(stdinTTY && stdoutTTY)) {
    deps.print(NEEDS_TERMINAL_LINE)
    return 2
  }
  const runtime = await Runtime.open(deps.home, deps.network)
  try {
    // Owner-command narration goes to STDERR by default: `print` output keeps its exact shape.
    runtime.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
    const command = argv[0]!
    if (!OWNER_COMMANDS.includes(command)) return await runCliWithRuntime(argv, runtime, deps.print, { cwd: deps.cwd })
    const code = await runOwnerCommand(argv, runtime, deps)
    if (code === 0 && (command === "approve" || command === "revoke")) {
      await Promise.resolve(deps.kickDaemon ? deps.kickDaemon() : callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 })).catch(() => {})
    }
    return code
  } finally {
    await runtime.close()
  }
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const DAEMON_MAIN = fileURLToPath(new URL("./daemon-main.ts", import.meta.url))
/** How long a CLI waits for a spawned daemon to open its runtime — the first open fetches the chain head. */
const DAEMON_WAIT_MS = 30_000
const CLI_CALL_TIMEOUT_MS = 120_000

/** The detached daemon spawn: same env stripping as the old drainer — no agent credentials leak. */
function spawnDaemon(): void {
  const child = spawn(process.execPath, ["--import", "tsx", DAEMON_MAIN], {
    detached: true,
    stdio: "ignore",
    cwd: REPO_ROOT,
    env: drainerEnv(process.env),
  })
  child.on("error", () => {})
  child.unref()
}

/** Entry point for `pnpm mida`. Monad testnet only; needs DEPLOYER_PRIVATE_KEY in the environment as the funder. */
async function main(): Promise<void> {
  const { monadTestnetEnvironment } = await import("@mida/cli")
  const env = await monadTestnetEnvironment()
  try {
    // MIDA_HOME must mean the same folder here as in the daemon and both hooks (they all read it);
    // when this ignored it, `init` wrote to ~/.mida while the daemon it spawned looked elsewhere.
    const home = resolveHome(process.env)
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    const argv = process.argv.slice(2)
    const print = (line: string) => console.log(line)

    // Owner commands — init, approve, revoke, remember — run in this process on the owner
    // runtime and are never sent to the daemon socket. `init` still spawns the daemon when one
    // is not already running; the others reuse a live daemon's Context API or start their own.
    if (OWNER_COMMANDS.includes(argv[0] ?? "")) {
      const code = await runCli(argv, { home, network, print, cwd: process.cwd() })
      if (argv[0] === "init" && code === 0) {
        const health = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
        if (health.status === 0) spawnDaemon()
      }
      process.exitCode = code
      return
    }

    // install, uninstall and doctor are local commands: they never go through the daemon.
    // install edits the tool's own config outside the Mida home, and doctor's first check is
    // whether the daemon is even up — running it through the socket would report on nothing.
    if (argv[0] === "install" || argv[0] === "uninstall") {
      const tool = argv[1] ?? ""
      if (argv.length !== 2 || !INSTALL_TOOLS.includes(tool)) {
        print(USAGE)
        process.exitCode = 2
        return
      }
      // the real settings paths are built here and only here — tests always pass their own
      const settingsPath =
        tool === "claude-code" ? join(homedir(), ".claude", "settings.json") : join(homedir(), ".codex", "config.toml")
      try {
        const outcome =
          argv[0] === "install"
            ? tool === "claude-code"
              ? installClaudeCode(settingsPath)
              : installCodex(settingsPath)
            : tool === "claude-code"
              ? uninstallClaudeCode(settingsPath)
              : uninstallCodex(settingsPath)
        print(outcome === "already-installed" ? "already installed" : outcome === "not-installed" ? "not installed" : outcome)
        if (argv[0] === "install" && tool === "codex") print(CODEX_TRUST_SENTENCE)
        process.exitCode = 0
      } catch (error) {
        const code = (error as { code?: unknown }).code
        print(`refused: ${typeof code === "string" ? code : "ERROR"}`)
        process.exitCode = 1
      }
      return
    }

    if (argv[0] === "doctor") {
      const settings = {
        "claude-code": join(homedir(), ".claude", "settings.json"),
        codex: join(homedir(), ".codex", "config.toml"),
      }
      if (argv[1] === "--live") {
        const tool = argv[2] ?? ""
        if (argv.length !== 3 || !INSTALL_TOOLS.includes(tool)) {
          print(USAGE)
          process.exitCode = 2
          return
        }
        process.exitCode = await runDoctorLive(tool as InstallTool, { home, print })
        return
      }
      if (argv.length !== 1) {
        print(USAGE)
        process.exitCode = 2
        return
      }
      process.exitCode = await runDoctor({ home, print, settings })
      return
    }

    const up = await ensureDaemon(home, spawnDaemon, { waitMs: DAEMON_WAIT_MS })
    if (!up) {
      print("midad did not start; run `mida init` first")
      process.exitCode = 1
      return
    }
    const reply = await callDaemon(home, "/cli", { argv, cwd: process.cwd() }, { timeoutMs: CLI_CALL_TIMEOUT_MS })
    const body = reply.body as { code?: unknown; lines?: unknown } | null
    if (reply.status === 0 || typeof body?.code !== "number" || !Array.isArray(body.lines)) {
      print("midad did not answer")
      process.exitCode = 1
      return
    }
    for (const line of body.lines) print(String(line))
    process.exitCode = body.code
  } finally {
    await env.stop()
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
