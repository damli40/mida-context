import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { callDaemon, ensureDaemon } from "./control.js"
import { runDoctor, runDoctorLive } from "./doctor.js"
import { MidaHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { CODEX_TRUST_SENTENCE, installClaudeCode, installCodex, uninstallClaudeCode, uninstallCodex } from "./install.js"
import type { InstallTool } from "./install.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { approve, authorNamesFor, init, readCheckpoints, requestAccess, revoke, saveCheckpoint } from "./skeleton.js"

const AGENTS = ["claude-code", "codex"]
const WITH_AGENT = ["request", "approve", "save-demo", "read", "revoke"]
const WITH_PROJECT = ["save-demo", "read"]
export const USAGE = "usage: mida init | install <tool> | uninstall <tool> | doctor [--live <tool>] | request <agent> | approve <agent> | save-demo <agent> <projectId> | read <agent> <projectId> | revoke <agent>   (tool/agent = claude-code | codex)"
/** Every first word runCli understands — the daemon's /cli route refuses anything else. */
export const CLI_COMMANDS: readonly string[] = ["init", ...WITH_AGENT]

export interface CliDeps {
  home: MidaHome
  network: Network
  print(line: string): void
  /** The folder the command was run from — `approve` records it on the owner-signed project list. */
  cwd?: string
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
 * All of `mida`'s commands against an already-open runtime: the daemon's /cli route runs owner
 * commands inside the daemon's runtime through this. Returns the exit code; output goes to print.
 */
export async function runCliWithRuntime(
  argv: string[],
  runtime: Runtime,
  print: (line: string) => void,
  /** `cwd` is the folder the command ran in — `approve` adds its project to the owner's list. */
  context?: { cwd?: string },
): Promise<number> {
  const [command = "", agent = "", projectId = ""] = argv
  const usage = () => {
    print(USAGE)
    return 2
  }
  if (command !== "init" && !WITH_AGENT.includes(command)) return usage()
  if (WITH_AGENT.includes(command) && !AGENTS.includes(agent)) return usage()
  if (WITH_PROJECT.includes(command) && projectId.length === 0) return usage()

  try {
    if (command === "init") {
      const result = await init(runtime, AGENTS)
      print(`owner ${result.owner}`)
      for (const [name, agentId] of Object.entries(result.agents)) print(`agent ${name} ${agentId}`)
    } else if (command === "request") {
      print(`requested ${agent} ${(await requestAccess(runtime, agent)).requestId}`)
    } else if (command === "approve") {
      const result = await approve(runtime, agent, context?.cwd)
      print(
        result.transactionHash === null
          ? `approved ${agent} for project ${result.projectId}; the on-chain grant was already live`
          : `approved ${agent} tx ${result.transactionHash} gas ${result.gasUsed}` +
              (result.projectId !== undefined ? ` project ${result.projectId}` : ""),
      )
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
      const result = await readCheckpoints(runtime, agent, projectId)
      print(`read ${result.checkpoints.length} checkpoint(s) in ${result.milliseconds} ms`)
      const authorNames = authorNamesFor(runtime)
      for (const checkpoint of result.checkpoints) {
        const author = authorNames[checkpoint.authorId.toLowerCase()] ?? "unknown agent"
        print(`  ${checkpoint.contextId} written by ${author} (on-chain author ${checkpoint.authorId.slice(0, 10)}…)`)
      }
    } else {
      const result = await revoke(runtime, agent)
      print(`revoked ${agent} tx ${result.transactionHashes.join(" ")}; new key sent to: ${result.rewrapped.join(", ") || "nobody"}`)
    }
    return 0
  } catch (error) {
    // The error code only. A message from a deeper layer is never echoed: it could carry data.
    const code = (error as { code?: unknown }).code
    print(`refused: ${typeof code === "string" ? code : "ERROR"}`)
    return 1
  }
}

/** Direct form kept for callers that own no daemon (tests, `mida init` before the daemon exists). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (!validCliArgv(argv)) {
    deps.print(USAGE)
    return 2
  }
  const runtime = await Runtime.open(deps.home, deps.network)
  try {
    return await runCliWithRuntime(argv, runtime, deps.print, { cwd: deps.cwd })
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
    const home = new MidaHome()
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    const argv = process.argv.slice(2)
    const print = (line: string) => console.log(line)

    // `init` is the one command allowed to run in-process: before it runs there is no
    // network.json, so no daemon could start. It spawns the daemon when it is done. With a
    // daemon already up, init goes through /cli like everything else.
    if (argv[0] === "init") {
      const health = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
      if (health.status === 0) {
        const code = await runCli(argv, { home, network, print, cwd: process.cwd() })
        if (code === 0) spawnDaemon()
        process.exitCode = code
        return
      }
    }

    // install, uninstall and doctor are local commands: they never go through the daemon.
    // install edits the tool's own config outside the Mida home, and doctor's first check is
    // whether the daemon is even up — running it through the socket would report on nothing.
    if (argv[0] === "install" || argv[0] === "uninstall") {
      const tool = argv[1] ?? ""
      if (argv.length !== 2 || !AGENTS.includes(tool)) {
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
        if (argv.length !== 3 || !AGENTS.includes(tool)) {
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
