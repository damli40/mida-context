import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"
import { decodeUint64, isMidaError, namespaceById } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import type { Deployment } from "@mida/chain"
import { REQUEST_LIFETIME_SECONDS } from "@mida/sdk"
import { permissionNames } from "@mida/grant-advisor"
import { callDaemon, ensureCurrentDaemon } from "./control.js"
import { debugLine, refusalCode } from "./debug-line.js"
import { runDoctor, runDoctorLive } from "./doctor.js"
import { MidaHome, resolveHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { CODEX_TRUST_SENTENCE, installClaudeCode, installCodex, uninstallClaudeCode, uninstallCodex } from "./install.js"
import type { InstallTool } from "./install.js"
import { projectIdFor } from "./queue.js"
import { DEFAULT_FACT_NAMESPACE, attemptNamespaceRead, readOwnerFacts, remember } from "./remember.js"
import { Runtime, NAMESPACE, ServiceRuntime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { mismatchLine, resolveNetwork } from "./network.js"
import type { ResolveDeps, ResolvedNetwork } from "./network.js"
import { siblingEntryArgs } from "./sibling.js"
import { approve, authorNamesFor, deploymentMismatchError, init, readCheckpoints, requestAccess, revoke, saveCheckpoint } from "./skeleton.js"
import { loadOwnerMode } from "./keys.js"
import type { OwnerMode } from "./keys.js"
import { migrate, migrateUndo } from "./migrate.js"
import { OwnerLinkOutcome, approvePasskey, initPasskey, revokePasskey } from "./owner-link/flows.js"
import type { PasskeyDeps } from "./owner-link/flows.js"

/** The agents `mida init` provisions — `assistant` is a stand-in for any other assistant you use. */
const AGENTS = ["claude-code", "codex", "assistant"]
/** The agents `mida init` provisions — `assistant` is a stand-in for any other assistant you use. Only the real tools can be installed or doctored. */
const INSTALL_TOOLS = ["claude-code", "codex"]
const WITH_AGENT = ["request", "approve", "save-demo", "read", "revoke"]
const WITH_PROJECT = ["save-demo"]
/** The namespaces `read --as <agent> <namespace>` may name — the same three the MCP adapter exposes. */
const READ_AS_NAMESPACES: readonly string[] = ["projects.current", "profile.skills", "preferences.communication"]
export const USAGE =
  "usage: mida init | install <tool> | uninstall <tool> | doctor [--live <tool>] | request <agent> | approve <agent> | save-demo <agent> <projectId> | read <agent> <projectId> | read --as <agent> | remember <fact> | revoke <agent> | migrate [--undo]" +
  "   (tool = claude-code | codex; agent = claude-code | codex | assistant — assistant is a stand-in for any other assistant you use)"
/** Every first word runCli understands — the daemon's /cli route refuses anything else. */
export const CLI_COMMANDS: readonly string[] = ["init", "remember", "migrate", ...WITH_AGENT]
/**
 * The commands that change who has access. Only `mida` in the owner's own terminal may run them —
 * they open the owner runtime in-process and are never sent to the daemon socket.
 */
export const OWNER_COMMANDS: readonly string[] = ["init", "approve", "revoke", "remember", "migrate"]
/** The owner commands that must see a real terminal. `init` is exempt: it grants nothing to an agent. */
const TERMINAL_COMMANDS: readonly string[] = ["approve", "revoke", "remember", "migrate"]
export const NEEDS_TERMINAL_LINE = "needs-terminal: run this yourself in a terminal window"

/** What the daemon answers when an owner command reaches /cli anyway. */
export function ownerOnlyLine(command: string): string {
  return `This changes who has access, so it only runs in your own terminal: mida ${command}`
}

/**
 * The context area's plain name for a bytes32 namespace id — never nothing: an id the namespace
 * tree cannot name shows its first ten characters so the owner can still tell records apart.
 */
export function namespaceLabel(id: string): string {
  try {
    return namespaceById(id as Hex).name
  } catch {
    return `${id.slice(0, 10)}…`
  }
}

/**
 * The command-side read of the one network rule: the home's saved contract, RPC and service
 * URLs win, and the built-in record only fills a brand-new home. Returns the full resolution —
 * main needs `mismatch` to warn on stderr and to refuse an `init` that would move the setup.
 */
export async function networkForCommand(
  home: MidaHome,
  env: Record<string, string | undefined>,
  deps?: ResolveDeps,
): Promise<ResolvedNetwork> {
  return resolveNetwork(home, env, deps)
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
  /**
   * The passkey-owner seams (M3-F2): listener, page opener, chain key read and agent
   * provisioning, injectable so tests drive a fake page end to end. `print` and `progress`
   * come from this deps object; everything else defaults to the real thing.
   */
  ownerLink?: Omit<PasskeyDeps, "print" | "progress">
  /**
   * The resolution the calling entry point ran under (main's `networkForCommand`). When its
   * `mismatch` is set — the saved setup names another contract than this build ships — `init`
   * refuses before anything opens the runtime; the other owner commands still run on the saved
   * contract, because that is where the setup's data lives.
   */
  resolvedNetwork?: ResolvedNetwork
  /** The environment `mida migrate` resolves its deployments against — tests inject a clean one. */
  env?: Record<string, string | undefined>
  /** `mida migrate`'s destination — default: the deployment this build ships; tests inject a local one. */
  migrateTarget?: Deployment
  /** What runs after `mida migrate` switches (or `--undo` restores) — default: spawn the daemon. */
  startService?: () => unknown | Promise<unknown>
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
  /** `cwd` is the folder the command ran in; `debug` is the daemon's pass-through of MIDA_DEBUG=1. */
  context?: { cwd?: string; debug?: boolean },
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
  // `read --as <agent> <namespace>` takes exactly one namespace, from the known set — anything
  // else on the line is refused rather than silently ignored.
  if (asFlag && (argv.length > 4 || (argv[3] !== undefined && !READ_AS_NAMESPACES.includes(argv[3])))) return usage()
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
        // `mida read --as <agent> [namespace]`: what this agent can see, through the real
        // protocol. No namespace reads the owner facts its grants cover, then a real
        // `projects.current` attempt whose answer (or refusal code) comes from the server,
        // never a local pre-check. A namespace narrows the read to that one area: the fact
        // namespaces print their owner facts, `projects.current` prints the objects in the
        // project the caller's folder belongs to — the same lines `read <agent> <projectId>`
        // produces.
        const only = argv[3]
        if (only === "projects.current") {
          const projectId = context?.cwd === undefined ? null : projectIdFor(context.cwd)
          if (projectId === null) {
            print(`projects.current: this folder is not a Mida project — run \`mida request ${agent} && mida approve ${agent}\` here to make it one`)
          } else {
            const result = await readCheckpoints(runtime, agent, projectId)
            print(`${NAMESPACE}: read ${result.checkpoints.length} object(s)`)
            if (result.partial) print("list incomplete — run again")
            const authorNames = authorNamesFor(runtime)
            for (const checkpoint of result.checkpoints) {
              const author = authorNames[checkpoint.authorId.toLowerCase()] ?? "unknown agent"
              print(`  ${namespaceLabel(checkpoint.namespaceId)}: ${checkpoint.contextId} written by ${author} (on-chain author ${checkpoint.authorId.slice(0, 10)}…)`)
            }
          }
        } else {
          let facts: Awaited<ReturnType<typeof readOwnerFacts>> | null
          try {
            facts = await readOwnerFacts(runtime, agent)
          } catch (error) {
            // a list the store calls incomplete is not "no facts" — say so, then still run the attempt
            if (!isMidaError(error, "PARTIAL_READ")) throw error
            facts = null
          }
          if (facts === null) {
            print("list incomplete — run again")
          } else {
            print("What you have told Mida about yourself")
            for (const fact of facts) {
              if (only === undefined || fact.namespace === only) print(`  ${fact.namespace}: ${fact.text}`)
            }
          }
          if (only === undefined) {
            const attempt = await attemptNamespaceRead(runtime, agent, NAMESPACE)
            print(attempt.ok ? `${NAMESPACE}: read ${attempt.objects} object(s)` : `${NAMESPACE}: refused ${attempt.code}`)
            if (attempt.ok && attempt.partial) print("list incomplete — run again")
          }
        }
      } else {
        const result = await readCheckpoints(runtime, agent, projectId)
        print(`read ${result.checkpoints.length} checkpoint(s) in ${result.milliseconds} ms`)
        if (result.partial) print("list incomplete — run again")
        const authorNames = authorNamesFor(runtime)
        for (const checkpoint of result.checkpoints) {
          const author = authorNames[checkpoint.authorId.toLowerCase()] ?? "unknown agent"
          print(`  ${namespaceLabel(checkpoint.namespaceId)}: ${checkpoint.contextId} written by ${author} (on-chain author ${checkpoint.authorId.slice(0, 10)}…)`)
        }
      }
    }
    return 0
  } catch (error) {
    // The error code only — plus the one plain-English line a code can honestly name. An error
    // with no code is still named (a chain failure names the contract, anything else UNEXPECTED);
    // the masked detail line prints only when the caller asked for it (MIDA_DEBUG=1).
    const code = refusalCode(error)
    if (code === "already-approved") {
      // from `request` the next step really is `approve` — that adds THIS folder, no transaction
      print(`${agent} is already approved on chain. To use it in THIS folder, run \`mida approve ${agent}\` here (no transaction, nothing to pay).`)
    } else if (code === "CHAIN_CALL_FAILED") {
      print(`the chain call failed — this setup's contract is ${runtime.chain.deployment.capabilityRegistry.slice(0, 6)}…; run with MIDA_DEBUG=1 to see why`)
    } else {
      print(`refused: ${code}`)
    }
    if (context?.debug === true) print(debugLine(error))
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
      // The owner sees WHICH context area the fact will land in before the ask — answering the
      // "which namespace does this belong to" question — and sees it again after the write.
      const area = `area: ${DEFAULT_FACT_NAMESPACE} (agents with READ on this area will see it)`
      deps.print(area)
      const prompt = deps.prompt ?? terminalPrompt
      const drain = deps.drainInput ?? drainBufferedStdin
      // same stale-input rule as approve: only a line typed against the visible ask counts
      await drain()
      if ((await prompt("Type yes to remember: ")).trim() !== "yes") {
        deps.print("not approved")
        return 1
      }
      const result = await remember(runtime, argv.slice(1).join(" "))
      if (result.kind === "remembered") {
        deps.print(`area: ${result.namespace} (agents with READ on this area will see it)`)
        deps.print(`remembered ${result.contextId} in ${result.namespace}`)
      } else {
        deps.print(`refused: ${result.code}`)
      }
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
            deps.print(`  ${namespaceLabel(scope.namespaceId)}: ${permissionNames(scope.permissions).join(" + ")}`)
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
          ? // nothing was sent because the chain already approves the agent — the honest answer is
            // what the folder's list row did, never "run the command you just ran" (M3-D4)
            result.projectAlreadyListed === true
            ? `${agent} is already approved on chain. This folder was already approved for ${agent}.`
            : `${agent} is already approved on chain. This folder is now approved for ${agent} too (no transaction).`
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
      // The chain answer first, always — the per-agent key lines follow it (M3-D4). A wrap the
      // store refused is its own line with the reason and the fix, never a "refused" for a revoke
      // that already landed.
      deps.print(
        result.transactionHashes.length === 0
          ? "nothing to revoke"
          : `revoked ${agent} on chain${result.sponsored ? " (sponsored)" : ""} — tx ${result.transactionHashes.join(" ")}`,
      )
      for (const name of result.rewrapped) deps.print(`new read key sent to ${name}`)
      for (const failure of result.failed) {
        deps.print(`could not send the new key to ${failure.name}: ${failure.reason} — run \`mida approve ${failure.name}\``)
      }
      if (result.repairError !== undefined) {
        deps.print(`the key repair pass could not run: ${result.repairError} — run \`mida revoke ${agent}\` again to retry it`)
      }
    }
    return 0
  } catch (error) {
    deps.print(ownerRefusalLine(command, agent, error, runtime.owner, runtime.chain.deployment.capabilityRegistry))
    // Owner commands run in the owner's own terminal, and an unnamed failure leaves them blind.
    // Only when they ask (MIDA_DEBUG=1): the error's name and first lines, long hex strings masked.
    if (process.env.MIDA_DEBUG === "1") {
      deps.print(debugLine(error))
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
export function ownerRefusalLine(command: string, agent: string, error: unknown, ownerAddress?: string, capabilityRegistry?: string): string {
  const code = refusalCode(error)
  switch (code) {
    // The owner saw the preview and answered something other than yes — nothing was signed.
    case "not-approved": return "not approved"
    case "REQUEST_EXPIRED":
      return `${agent}'s request has expired (a request lasts ${Number(REQUEST_LIFETIME_SECONDS) / 60} minutes): run \`mida request ${agent}\` and approve again`
    case "already-approved":
      // from `request` the honest next step is `approve` (it adds THIS folder, no transaction);
      // from `approve` itself this is reached only when no project folder could carry the answer —
      // the folder variants are printed by the approve branch above, never "run me again" (M3-D4)
      return command === "request"
        ? `${agent} is already approved on chain. To use it in THIS folder, run \`mida approve ${agent}\` here (no transaction, nothing to pay).`
        : `${agent} is already approved on chain`
    case "no-pending-request":
      return `${agent} has no pending request — run \`mida request ${agent}\` first`
    case "agent-unidentified":
    case "agent-not-setup":
      return `${agent} is not set up on this machine — run \`mida init\` first`
    // A passkey home whose owner-address.json is missing: init never finished, and only
    // `mida init --passkey` resumes it — there is no software path to fall back to.
    case "no-owner-address":
      return "this passkey home has no owner yet — run `mida init --passkey`"
    // The page never came back: a refusal, not a failure — nothing was signed and re-running
    // the command starts a fresh round with a fresh nonce.
    case "OWNER_LINK_TIMEOUT":
      return "the approval page did not come back within 10 minutes — run the command again to try once more"
    case "OWNER_LINK_CLOSED":
      return "the local return listener stopped before the page answered — run the command again"
    // The message IS the answer: we built it from the balance, the cost and the shortfall. A
    // MidaError prefixes its own message with "<code>: " — the owner reads the sentence, not
    // the code, so that prefix is stripped here.
    case "OWNER_WALLET_LOW": {
      // No funder and no sponsor means the owner wallet itself pays for everything — so the
      // answer to a failed init is always the address that needs MON, not the wallet that was
      // short mid-run. `init` resumes: re-running it sends only what has not landed yet.
      if (command === "init" && ownerAddress !== undefined) {
        return `your owner wallet cannot pay for the setup — send at least 0.5 testnet MON to this address, then run \`mida init\` again: ${ownerAddress}`
      }
      if (!(error instanceof Error)) return "refused: OWNER_WALLET_LOW"
      const prefix = "OWNER_WALLET_LOW: "
      return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
    }
    case "not-a-project":
      return `this folder cannot hold a project — run \`mida approve ${agent}\` inside the project's folder`
    case "list-unreadable":
      return "the approved-projects list could not be read — check the file's permissions"
    case "SPONSOR_PENDING": {
      // The call was accepted by the sponsor but its receipt never confirmed — resending would be
      // the double-send this error exists to prevent, so the line says where it stands and how to
      // check. The hash is shortened to 10 characters: enough to find the operation, little enough
      // that nobody mistakes it for something sensitive. The deeper message is never echoed.
      const hash = (error as { userOpHash?: unknown }).userOpHash
      const label = typeof hash === "string" && hash.startsWith("0x") ? ` ${hash.slice(0, 10)}…` : ""
      const opener = `the sponsored operation${label} was accepted and may still land`
      // A blind re-run is honest for approve, revoke and init — each asks the chain what already
      // landed and sends only what is missing. `remember` is the exception: a second run writes a
      // SECOND fact, so the owner must look first.
      if (command === "remember") {
        return `${opener} — check whether the fact is already there with \`mida read --as assistant\` before running it again; nothing was sent from your wallet`
      }
      return `${opener} — run the same command again in a minute — it will tell you if it already went through; nothing was sent from your wallet`
    }
    // The saved setup names another contract than this build ships. Only `mida migrate` may
    // move it — init refuses rather than rewrite the file (the error carries both addresses).
    case "deployment-mismatch": {
      const detail = error as { saved?: unknown; builtIn?: unknown }
      const short = (a: unknown) => (typeof a === "string" ? `${a.slice(0, 6)}…` : "unknown")
      return `this setup is on contract ${short(detail.saved)}; this version of Mida ships ${short(detail.builtIn)}. \`init\` will not move it — run \`mida migrate\``
    }
    // A chain error with no code: the line names this setup's contract so a wrong deployment
    // explains itself, and names the flag that prints the masked detail.
    case "CHAIN_CALL_FAILED": {
      const contract = typeof capabilityRegistry === "string" ? `${capabilityRegistry.slice(0, 6)}…` : "unknown"
      return `the chain call failed — this setup's contract is ${contract}; run with MIDA_DEBUG=1 to see why`
    }
    default:
      return `refused: ${code}`
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
 * The owner commands on a passkey home (M3-F2): `init --passkey`, `approve`, `revoke` — and
 * `remember`, which has no passkey path yet. None of them may open Runtime: that call creates
 * owner secrets, and a passkey home is defined by their absence. Every signature goes to the
 * page; what comes back is verified against the chain before a single file changes.
 */
async function runPasskeyOwnerCommand(argv: string[], deps: CliDeps, mode: OwnerMode | undefined): Promise<number> {
  const command = argv[0]!
  const linkDeps: PasskeyDeps = {
    print: deps.print,
    ...(deps.progress !== undefined ? { progress: deps.progress } : {}),
    ...(deps.ownerLink ?? {}),
  }
  try {
    if (command === "init") {
      if (argv[1] !== "--passkey") {
        deps.print("this home already has a passkey owner; a software owner needs a fresh MIDA_HOME")
        return 2
      }
      if (mode === "software") {
        deps.print("this home already has a software owner key; a passkey owner needs a fresh MIDA_HOME")
        return 2
      }
      const result = await initPasskey(deps.home, deps.network, AGENTS, linkDeps)
      deps.print(`owner ${result.owner}`)
      for (const [name, agentId] of Object.entries(result.agents)) deps.print(`agent ${name} ${agentId}`)
      return 0
    }
    if (command === "remember") {
      deps.print("remember is not available with a passkey owner yet")
      return 2
    }
    const agent = argv[1] ?? ""
    if (!AGENTS.includes(agent)) {
      deps.print(USAGE)
      return 2
    }
    const session = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
    try {
      session.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
      if (command === "approve") {
        const result = await approvePasskey(session, agent, deps.cwd, linkDeps)
        if (result.listOnly) {
          deps.print(
            result.projectAlreadyListed === true
              ? `${agent} is already approved on chain. This folder was already approved for ${agent}.`
              : `${agent} is already approved on chain. This folder is now approved for ${agent} too (no transaction).`,
          )
        } else {
          deps.print(
            `approved ${agent} via your passkey — tx ${result.transactionHashes.join(" ")}` +
              (result.projectId !== undefined ? ` project ${result.projectId}` : ""),
          )
        }
        if (result.droppedRows !== undefined && result.droppedRows !== 0) {
          deps.print(
            result.droppedRows === null
              ? "the old approved-projects list was invalid; the old list was discarded"
              : `the old approved-projects list was invalid; ${result.droppedRows} row(s) were dropped`,
          )
        }
      } else {
        const result = await revokePasskey(session, agent, linkDeps)
        deps.print(
          result.nothingToRevoke || result.transactionHashes.length === 0
            ? "nothing to revoke"
            : `revoked ${agent} on chain — tx ${result.transactionHashes.join(" ")}`,
        )
        for (const name of result.rewrapped) deps.print(`new read key sent to ${name}`)
      }
      return 0
    } finally {
      await session.close()
    }
  } catch (error) {
    // A page outcome — decline reason, wrong-owner line, mismatch line — is already the exact
    // line the owner should read; coded errors go through the same mapper as software mode.
    if (error instanceof OwnerLinkOutcome) {
      deps.print(error.line)
      return error.exitCode
    }
    deps.print(ownerRefusalLine(command, argv[1] ?? "", error, undefined, deps.network.deployment.capabilityRegistry))
    if (process.env.MIDA_DEBUG === "1") {
      deps.print(debugLine(error))
    }
    return 1
  }
}

/**
 * One `mida` command end to end: on a software home it opens the owner runtime in-process (the
 * only runtime that can sign as the owner); on a passkey home the owner commands go to the page
 * instead and the agent-facing ones run on a secret-less session. `owner/mode.json` decides —
 * an old home with secrets and no marker is software, exactly as before.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (!validCliArgv(argv)) {
    deps.print(USAGE)
    return 2
  }
  const command = argv[0]!
  // `init` takes one optional word, and only this one.
  if (command === "init" && (argv.length > 2 || (argv.length === 2 && argv[1] !== "--passkey"))) {
    deps.print(USAGE)
    return 2
  }
  // approve, revoke and remember change who has access or write owner facts, so they ask for a
  // real terminal — stdin and stdout both TTY — before the owner key is even loaded. This is a
  // speed bump, not a wall: on a software home the owner key is a file on disk, and a
  // determined program running as the user can read it or fake a terminal. The check is here to
  // stop a confused caller from changing authority by accident, not to stop one acting on
  // purpose. A passkey home keeps the same check — the page ceremony it leads to is stronger,
  // not weaker.
  const stdinTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true
  const stdoutTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true
  if (TERMINAL_COMMANDS.includes(command) && !(stdinTTY && stdoutTTY)) {
    deps.print(NEEDS_TERMINAL_LINE)
    return 2
  }
  // migrate and migrate --undo are owner commands: they open the owner runtime themselves, take
  // no agent argument, and never go near the daemon socket — a migration even stops the service.
  if (command === "migrate") {
    if (argv.length > 2 || (argv.length === 2 && argv[1] !== "--undo")) {
      deps.print(USAGE)
      return 2
    }
    if (loadOwnerMode(deps.home) === "passkey") {
      deps.print("migrate moves a software-key setup — a passkey setup has no local owner key to move")
      return 1
    }
    const env = deps.env ?? process.env
    const drain = deps.drainInput ?? drainBufferedStdin
    const prompt = deps.prompt ?? terminalPrompt
    const startService =
      deps.startService ??
      (async () => {
        const health = await callDaemon(deps.home, "/health", undefined, { timeoutMs: 500 })
        if (health.status === 0) spawnDaemon(deps.home.root)
      })
    try {
      if (argv[1] === "--undo") {
        const undone = await migrateUndo({ home: deps.home, env, print: deps.print, now: () => new Date(), startService })
        return undone.outcome === "refused" ? 1 : 0
      }
      const result = await migrate({
        home: deps.home,
        env,
        print: deps.print,
        now: () => new Date(),
        startService,
        confirm: async (text) => {
          deps.print(text)
          await drain()
          return (await prompt("Type yes to migrate: ")).trim() === "yes"
        },
        ...(deps.migrateTarget === undefined ? {} : { target: deps.migrateTarget }),
      })
      return result.outcome === "refused" ? 1 : 0
    } catch (error) {
      deps.print(`refused: ${refusalCode(error)}`)
      if (process.env.MIDA_DEBUG === "1") deps.print(debugLine(error))
      return 1
    }
  }
  const mode = loadOwnerMode(deps.home)
  const passkeyInit = command === "init" && argv[1] === "--passkey"
  // init on a setup saved to another contract refuses before the runtime even opens — the
  // file is never rewritten; only `mida migrate` may move it. Covers software and passkey
  // init alike (initPasskey keeps the same check internally for direct callers).
  if (command === "init" && deps.resolvedNetwork?.mismatch !== undefined) {
    const mismatch = deps.resolvedNetwork.mismatch
    deps.print(ownerRefusalLine(command, argv[1] ?? "", deploymentMismatchError(mismatch.saved, mismatch.builtIn)))
    return 1
  }
  if (OWNER_COMMANDS.includes(command) && (mode === "passkey" || passkeyInit)) {
    const code = await runPasskeyOwnerCommand(argv, deps, mode)
    if (code === 0 && (command === "approve" || command === "revoke")) {
      await Promise.resolve(deps.kickDaemon ? deps.kickDaemon() : callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 })).catch(() => {})
    }
    return code
  }
  if (mode === "passkey") {
    // The agent-facing commands on a passkey home: the same ServiceRuntime the daemon uses —
    // read surface only, no owner material anywhere in the process.
    let session: ServiceRuntime
    try {
      session = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
    } catch (error) {
      deps.print(ownerRefusalLine(command, argv[1] ?? "", error, undefined, deps.network.deployment.capabilityRegistry))
      return 1
    }
    try {
      session.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
      return await runCliWithRuntime(argv, session, deps.print, { cwd: deps.cwd })
    } finally {
      await session.close()
    }
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

/**
 * `mida install <tool>` / `mida uninstall <tool>` — edits the tool's own config file, which lives
 * outside the Mida home, so the paths come in as deps. The Codex trust reminder prints only when
 * the config was actually written or changed: Codex re-asks trust on every change and silently
 * ignores an untrusted hook, but repeating the reminder on a no-op teaches the owner to skip it.
 */
export function runInstall(
  argv: string[],
  deps: { print: (line: string) => void; claudeSettings: string; codexConfig: string },
): number {
  const tool = argv[1] ?? ""
  if (argv.length !== 2 || !INSTALL_TOOLS.includes(tool)) {
    deps.print(USAGE)
    return 2
  }
  const settingsPath = tool === "claude-code" ? deps.claudeSettings : deps.codexConfig
  try {
    const outcome =
      argv[0] === "install"
        ? tool === "claude-code"
          ? installClaudeCode(settingsPath)
          : installCodex(settingsPath)
        : tool === "claude-code"
          ? uninstallClaudeCode(settingsPath)
          : uninstallCodex(settingsPath)
    deps.print(outcome === "already-installed" ? "already installed" : outcome === "not-installed" ? "not installed" : outcome)
    if (argv[0] === "install" && tool === "codex" && outcome === "installed") deps.print(CODEX_TRUST_SENTENCE)
    return 0
  } catch (error) {
    deps.print(`refused: ${refusalCode(error)}`)
    return 1
  }
}

/** How long a CLI waits for a spawned daemon to open its runtime — the first open fetches the chain head. */
const DAEMON_WAIT_MS = 30_000
const CLI_CALL_TIMEOUT_MS = 120_000

/**
 * The detached daemon spawn: same env stripping as the old drainer — no agent credentials leak.
 * The child is the built `midad` next to this file when the package is bundled, the .ts source
 * through the repo's tsx loader when it is not (sibling.ts owns that decision), and its working
 * directory is the Mida home — never the folder the code happens to live in.
 */
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

/** Entry point for the `mida` command. Monad testnet only; a funder is optional (see testnet.ts). */
async function main(): Promise<void> {
  // MIDA_HOME must mean the same folder here as in the daemon and both hooks (they all read it);
  // when this ignored it, `init` wrote to ~/.mida while the daemon it spawned looked elsewhere.
  const home = resolveHome(process.env)
  const argv = process.argv.slice(2)
  const print = (line: string) => console.log(line)

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    print(USAGE)
    process.exitCode = argv.length === 0 ? 2 : 0
    return
  }

  // install, uninstall and doctor are local commands: they never go through the daemon.
  // install edits the tool's own config outside the Mida home, and doctor's first check is
  // whether the daemon is even up — running it through the socket would report on nothing.
  if (argv[0] === "install" || argv[0] === "uninstall") {
    // the real settings paths are built here and only here — tests always pass their own
    process.exitCode = runInstall(argv, {
      print,
      claudeSettings: join(homedir(), ".claude", "settings.json"),
      codexConfig: join(homedir(), ".codex", "config.toml"),
    })
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

  // Everything below touches the chain, so this is where the network is resolved — the saved
  // setup's contract and services when there is one, the built-in record for a first-time home
  // — never earlier: `--help`, `install` and `doctor` must work with no RPC reachable at all.
  const resolved = await networkForCommand(home, process.env)

  // Owner commands — init, approve, revoke, remember — run in this process on the owner
  // runtime and are never sent to the daemon socket. `init` still spawns the daemon when one
  // is not already running; the others reuse a live daemon's Context API or start their own.
  if (OWNER_COMMANDS.includes(argv[0] ?? "")) {
    // A setup saved on another contract still works — the saved contract is where its data
    // lives — but the owner is told, on stderr so the command's stdout keeps its shape.
    const notice = mismatchLine(resolved)
    if (notice !== undefined) process.stderr.write(`${notice}\n`)
    const code = await runCli(argv, { home, network: resolved.network, print, cwd: process.cwd(), resolvedNetwork: resolved, env: process.env })
    if (argv[0] === "init" && code === 0) {
      const health = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
      if (health.status === 0) spawnDaemon(home.root)
    }
    process.exitCode = code
    return
  }

  const ensured = await ensureCurrentDaemon(home, () => spawnDaemon(home.root), { waitMs: DAEMON_WAIT_MS })
  if (!ensured.up) {
    print(ensured.refusal ?? "midad did not start; run `mida init` first")
    process.exitCode = 1
    return
  }
  if (ensured.replaced !== undefined) {
    // the service that answered was running other code and has been shut down and restarted —
    // say so on stderr so the command's stdout keeps its shape
    process.stderr.write(`restarted the Mida service (it was running code from ${ensured.replaced.codeRoot} @ ${ensured.replaced.codeCommit.slice(0, 7)})\n`)
  }
  const reply = await callDaemon(home, "/cli", { argv, cwd: process.cwd(), debug: process.env.MIDA_DEBUG === "1" }, { timeoutMs: CLI_CALL_TIMEOUT_MS })
  const body = reply.body as { code?: unknown; lines?: unknown } | null
  if (reply.status === 0 || typeof body?.code !== "number" || !Array.isArray(body.lines)) {
    print("midad did not answer")
    process.exitCode = 1
    return
  }
  for (const line of body.lines) print(String(line))
  process.exitCode = body.code
}

// `node dist/mida.js` reaches main through the bin symlink too: argv[1] is the .bin shim path
// while import.meta.url is the real file, so the comparison must run on realpaths.
const invoked =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main().catch((error: unknown) => {
    const e = error as { message?: unknown }
    console.error(`mida: ${typeof e.message === "string" ? e.message : String(error)}`)
    process.exitCode = 1
  })
}
