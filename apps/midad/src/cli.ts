import { spawn } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { createInterface } from "node:readline"
import { compareChainOrder, orderTime, recordedAt, taskOf } from "@mida/checkpoint"
import type { StoredCheckpoint } from "@mida/checkpoint"
import { decodeUint64, displaySafeBlock, displaySafeText, isMidaError, namespaceById } from "@mida/protocol"
import type { Address, Hex, RequestedScope } from "@mida/protocol"
import { privateKeyToAccount } from "viem/accounts"
import type { Deployment } from "@mida/chain"
import { REQUEST_LIFETIME_SECONDS } from "@mida/sdk"
import { permissionNames } from "@mida/grant-advisor"
import { clearCodexHome, recordCodexHome, recordedCodexHome, resolveCodexHome, trustedCodexHome } from "./codex-home.js"
import { callDaemon, ensureCurrentDaemon } from "./control.js"
import { batchStatusProbe, decideLane, laneWhyText } from "./batching.js"
import { debugLine, refusalCode } from "./debug-line.js"
import { hostOf, runDoctor, runDoctorLive } from "./doctor.js"
import { buildHandoff, generalAssistanceText, identityUnreadableText, isGeneralAssistant, noIdentityText, projectCheckRefusal } from "./handoff.js"
import { MidaHome, resolveHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { agoText } from "./hook-output.js"
import { CODEX_TRUST_SENTENCE, InstallRefusal, MCP_CLIENT_TOOLS, MCP_SERVER_NAME, claudeDesktopConfigPath, claudeUserConfigPath, codexHookCommands, cursorMcpConfigPath, installClaudeCode, installClaudeCodeMcp, installCodex, installDevin, installMcpClient, macosProtectedFolderNote, mcpLauncherPath, spawnClaude, uninstallClaudeCode, uninstallClaudeCodeMcp, uninstallCodex, uninstallDevin, uninstallMcpClient } from "./install.js"
import type { ClaudeCliRunner } from "./install.js"
import { resolveDevinConfigPath } from "./devin-facts.js"
import type { InstallTool, McpClientTool } from "./install.js"
import {
  checkProject,
  ensureProjectMarker,
  linkProject,
  newProject,
  planProjectLink,
  planFolderUnlink,
  planProjectUnlink,
  projectNewPlan,
  readApprovalsFile,
  sameProjectRoot,
  unlinkFolderRows,
  unlinkProject,
} from "./projects.js"
import type { ListOwner, ProjectApproval, ProjectCheck, ProjectUnlinkPlan } from "./projects.js"
import { projectIdFor } from "./queue.js"
import { DEFAULT_FACT_NAMESPACE, attemptNamespaceRead, factShortId, factStamp, readOwnerFacts, remember, resolveFactId } from "./remember.js"
import type { FactNamespace } from "./remember.js"
import { Runtime, HOSTED_SPONSOR_URL, NAMESPACE, PURPOSE_ID, ServiceRuntime, parseSponsorUrl } from "./runtime.js"
import type { Network } from "./runtime.js"
import { ownerCommandNotice, readSavedNetwork, resolveNetwork, setBatchingFlag, setSponsorUrl } from "./network.js"
import { resetOutOfGasWaits } from "./drain.js"
import type { ResolveDeps, ResolvedNetwork } from "./network.js"
import { siblingEntryArgs } from "./sibling.js"
import { approve, authorNamesFor, deploymentMismatchError, hasAnyLiveCapability, init, pendingApprovalAdvice, readCheckpoints, requestAccess, resolveAgentId, revoke, saveCheckpoint } from "./skeleton.js"
import { isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets, loadOwnerAddress, loadOwnerMode, saveOwnerAddress } from "./keys.js"
import { DEFAULT_TASK, TASK_RULE_TEXT, clearFolderTask, folderTaskFor, isTaskName, resolveSessionTask, taskOrUndefined, writeFolderTask } from "./task.js"
import type { OwnerMode } from "./keys.js"
import { migrate, migrateUndo } from "./migrate.js"
import { exportRecords } from "./export.js"
import { OwnerLinkOutcome, approvePasskey, initPasskey, provisionPasskeyAgents, revokePasskey } from "./owner-link/flows.js"
import type { PasskeyDeps } from "./owner-link/flows.js"

/**
 * The agents `mida init` provisions — `assistant` is a stand-in for any other assistant you use.
 * in-9: `devin` is deliberately absent — `mida init` on a machine that never runs Devin must not
 * register a devin identity (an on-chain transaction) for it. `mida install devin` is the
 * provision pass: an owner command exactly like `install <mcp-client>`.
 */
const AGENTS = ["claude-code", "codex", "assistant"]
/** Only the real tools can be installed or doctored. */
const HOOK_TOOLS = ["claude-code", "codex", "devin"]
/** install takes a hook tool or an MCP client; `doctor --live` only ever checks the hook tools. */
const INSTALL_TOOLS = [...HOOK_TOOLS, ...MCP_CLIENT_TOOLS]
const WITH_AGENT = ["request", "approve", "save-demo", "read", "revoke"]
const WITH_PROJECT = ["save-demo"]
/** The namespaces `read --as <agent> <namespace>` may name — the same three the MCP adapter exposes. */
const READ_AS_NAMESPACES: readonly string[] = ["projects.current", "profile.skills", "preferences.communication"]
/**
 * `read --as` may name any identity this home could hold — the key store's own name rule
 * (`keys.ts` NAME), not the three names `mida init` provisions by default. A name that cannot
 * be an identity is still usage, never read under.
 */
const READ_AS_NAME = /^[a-z0-9-]{1,64}$/
/**
 * The name `mida add-agent` accepts — the SDK-side agents' own rule (`install`/`init` names are
 * fixed strings): lowercase letters, digits and dashes, starting with a letter or digit.
 */
const ADD_AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
/**
 * The names this build already knows how to provision — init's own agents plus every tool an
 * install registers. `add-agent` is only for names outside this set.
 */
const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set([...AGENTS, ...INSTALL_TOOLS])
export const USAGE =
  "usage: mida init | install <tool> [--no-mcp] | uninstall <tool> | add-agent <name> | doctor [--live <tool>] | request <agent> | approve <agent> | approve --all | save-demo <agent> <projectId> | read <agent> <projectId> | read --as <agent> | remember <fact> | remember --replaces <id> <fact> | revoke <agent> | revoke --all | link <folder> | unlink [--folder <path>] | project new | batching on|off | sponsor on|off | migrate [--undo] | task [<name> | --clear | show <name>] | export <folder>" +
  "   (tool = claude-code | codex | devin | claude-desktop | cursor; agent = claude-code | codex | devin | assistant — or any identity add-agent or a client install provisions)"
/** Every first word runCli understands — the daemon's /cli route refuses anything else. */
export const CLI_COMMANDS: readonly string[] = ["init", "install", "add-agent", "remember", "migrate", "batching", "sponsor", "link", "unlink", "project", "task", "export", ...WITH_AGENT]
/**
 * The commands that change who has access — or which folder belongs to which project. Only `mida`
 * in the owner's own terminal may run them: they never go to the daemon socket. `install` for an
 * MCP client belongs here: it registers that client's identity on the chain. `add-agent` belongs
 * here for the same reason: it registers a new identity on the chain. `link` and `unlink`
 * sign only the owner list, `project new` writes only a marker — they never open the runtime. `export`
 * changes nothing, but it decrypts everything, so it is the owner's alone too.
 */
export const OWNER_COMMANDS: readonly string[] = ["init", "install", "add-agent", "approve", "revoke", "remember", "migrate", "batching", "sponsor", "link", "unlink", "project", "export"]
/** The owner commands that must see a real terminal. `init` is exempt: it grants nothing to an agent. */
export const TERMINAL_COMMANDS: readonly string[] = ["install", "add-agent", "approve", "revoke", "remember", "migrate", "batching", "sponsor", "link", "unlink", "project", "export"]
export const NEEDS_TERMINAL_LINE = "needs-terminal: run this yourself in a terminal window"

/** What the daemon answers when an owner command reaches /cli anyway. */
export function ownerOnlyLine(command: string): string {
  // export changes nothing — it decrypts everything — but it is the owner's command all the same
  if (command === "export") return "export runs only in your own terminal: mida export <folder>"
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
   * After a confirmed `sponsor on|off` the running service is replaced, not kicked: the sponsor
   * address is loaded into the send path when the service opens, so only a fresh start reads
   * the new file. The default shuts the answering service down and spawns a new one; a service
   * that is not running is not started. Best-effort, like the kick. Injectable in tests.
   */
  restartDaemon?: () => unknown | Promise<unknown>
  /**
   * The detached service spawn `sponsor on|off` fires once the old service has gone quiet —
   * a test injects a spy so exercising the restart path never starts a real daemon.
   */
  spawnService?: (cwd: string) => void
  /** The restart window `sponsor on|off` waits inside — default SPONSOR_STOP_WAIT_MS; tests shrink it. */
  sponsorRestartWaitMs?: number
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
  /** Claude Desktop's config file — `mida install claude-desktop` merges into it. Tests inject a temp path. */
  claudeDesktopConfig?: string
  /** Devin's config file — `mida install devin` merges the hook block into it. Tests inject a temp path. */
  devinConfig?: string
  /**
   * The account home and OS platform the macOS privacy note judges the launcher path against —
   * macOS protects <home>/Desktop, Documents and Downloads from ungranted apps (in-15 J-7).
   * `launcherPath` overrides the path checked; the default is the launcher install writes.
   * Tests inject all three so the note's firing does not depend on where this checkout lives.
   */
  homeDir?: string
  platform?: NodeJS.Platform
  launcherPath?: string
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
  /** `cwd` is the folder the command ran in; `debug` is the daemon's pass-through of MIDA_DEBUG=1; `task` is the caller's MIDA_TASK. */
  context?: { cwd?: string; debug?: boolean; task?: string },
): Promise<number> {
  const [command = ""] = argv
  if (OWNER_COMMANDS.includes(command)) {
    print(ownerOnlyLine(command))
    return 2
  }
  // tk-1: `task` is folder state plus the same gated reads `read` makes — not an owner command:
  // nothing here signs, and a session may legitimately name its own effort mid-work.
  if (command === "task") return runTaskCommand(argv.slice(1), runtime, print, context)
  const asFlag = command === "read" && argv[1] === "--as"
  const agent = asFlag ? (argv[2] ?? "") : (argv[1] ?? "")
  const projectId = argv[2] ?? ""
  const usage = () => {
    print(USAGE)
    return 2
  }
  if (!WITH_AGENT.includes(command)) return usage()
  // A client identity this home registered (claude-desktop, cursor, …) is a valid target for
  // request/read even though it was never in init's built-in list — `read --as` keeps the wider
  // name-shape gate, which the identity file check on the read path still stands behind.
  const known = AGENTS.includes(agent) || listAgentNames(runtime.home).includes(agent)
  if (WITH_AGENT.includes(command) && !known && !(asFlag && READ_AS_NAME.test(agent))) return usage()
  if (command === "read" && !asFlag && projectId.length === 0) return usage()
  // `read --as <agent> <namespace>` takes exactly one namespace, from the known set — anything
  // else on the line is refused rather than silently ignored.
  if (asFlag && (argv.length > 4 || (argv[3] !== undefined && !READ_AS_NAMESPACES.includes(argv[3])))) return usage()
  if (WITH_PROJECT.includes(command) && projectId.length === 0) return usage()

  try {
    if (command === "request") {
      print(`requested ${agent} ${(await requestAccess(runtime, agent)).requestId}`)
    } else if (command === "save-demo") {
      // the same gate `read <agent> <projectId>` runs: the folder must be approved for this
      // agent, and the named project must be THIS folder's project — a save under another
      // project's id is refused exactly as a read is (in-15 J-6)
      const cwd = context?.cwd
      const check: ProjectCheck = cwd === undefined ? { ok: false, reason: "not-approved" } : await checkProject(runtime, { agent, cwd })
      if (!check.ok) {
        print(projectCheckRefusal(runtime, agent, check).text)
        return 1
      }
      if (projectId !== check.approval.projectId) {
        print(`project-mismatch: this folder is approved for ${check.approval.projectId}, not ${projectId}`)
        return 1
      }
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
        // The same identity gate the other read routes enforce at checkAccess, first: a missing
        // or unloadable identity is its own refusal — never a namespace read under another name.
        // Absent and unreadable are different answers, exactly as in checkAccess: a stat that
        // answers ENOENT/ENOTDIR means "not set up"; anything else that leaves no identity —
        // corrupt JSON, a refused read — means "exists but could not be read".
        let identity: ReturnType<typeof loadAgentIdentity>
        try {
          identity = loadAgentIdentity(runtime.home, agent)
        } catch {
          identity = undefined
        }
        if (identity === undefined) {
          let absent = false
          try {
            statSync(runtime.home.path(`agents/${agent}/identity.json`))
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            absent = code === "ENOENT" || code === "ENOTDIR"
          }
          print(absent ? noIdentityText(agent, runtime.home.root) : identityUnreadableText(agent, runtime.home.root))
          return 1
        }
        const only = argv[3]
        if (only === "projects.current") {
          const cwd = context?.cwd
          const projectId = cwd === undefined ? null : projectIdFor(cwd)
          if (cwd === undefined || projectId === null) {
            // A general-assistance identity can never hold a project row — the "make it one" hint
            // would send the owner into a request/approve loop that can only answer already-approved
            print(
              isGeneralAssistant(runtime.home, agent)
                ? generalAssistanceText(agent)
                : `projects.current: this folder is not a Mida project — run \`mida request ${agent} && mida approve ${agent}\` here to make it one`,
            )
          } else {
            // a marker names the project but grants nothing: the owner-signed list must approve
            // THIS folder for THIS agent — the same gate the handoff runs, answered with the
            // handoff's own refusal text (F7)
            const check = await checkProject(runtime, { agent, cwd })
            if (!check.ok) {
              print(projectCheckRefusal(runtime, agent, check).text)
              return 1
            }
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
            // the owner's own list keeps history: a superseded fact prints with its replacement
            facts = await readOwnerFacts(runtime, agent, { history: true })
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
              // every fact names itself: short id (what --replaces takes) + the record's chain
              // date; a fact the chain shows superseded carries its replacement's id and date
              if (only === undefined || fact.namespace === only) {
                const replaced = fact.replacedBy === undefined ? "" : ` (replaced by ${factShortId(fact.replacedBy.contextId)} on ${factStamp(fact.replacedBy.assertedAt)})`
                // a fact is stored text the owner did not type today: control chars, bidi
                // overrides and hidden newlines all become spaces so one fact stays one
                // printed line and can never repaint the terminal (in-40 L-4)
                const text = displaySafeText(fact.text).replace(/\s+/g, " ").trim()
                print(`  ${fact.namespace}: ${text} (id ${factShortId(fact.contextId)}, ${factStamp(fact.assertedAt)})${replaced}`)
              }
            }
          }
          if (only === undefined) {
            const attempt = await attemptNamespaceRead(runtime, agent, NAMESPACE)
            print(attempt.ok ? `${NAMESPACE}: read ${attempt.objects} object(s)` : `${NAMESPACE}: refused ${attempt.code}`)
            if (attempt.ok && attempt.partial) print("list incomplete — run again")
          }
        }
      } else {
        // the same gate `read --as <agent> projects.current` runs (G12): a project id names
        // the list to read but grants nothing — the owner-signed list must approve THIS
        // folder for THIS agent, answered with the handoff's own refusal text. The daemon
        // accepts a /cli body that carries no cwd, and a call that names no folder cannot
        // hold a folder approval — it gets the same not-approved answer, never the ids.
        const cwd = context?.cwd
        const check: ProjectCheck = cwd === undefined ? { ok: false, reason: "not-approved" } : await checkProject(runtime, { agent, cwd })
        if (!check.ok) {
          print(projectCheckRefusal(runtime, agent, check).text)
          return 1
        }
        // The approval names THIS folder's project: an agent approved for project A may not
        // list another project's checkpoints by passing B's id on the command line — the
        // folder gate alone would have let that through (L1).
        if (projectId !== check.approval.projectId) {
          print(`project-mismatch: this folder is approved for ${check.approval.projectId}, not ${projectId}`)
          return 1
        }
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
      // from `request` the next step really is `approve` — that adds THIS folder, no transaction.
      // For the general-assistance identity that hint loops: it can never hold a project row,
      // so approve can only ever answer already-approved again.
      print(
        isGeneralAssistant(runtime.home, agent)
          ? generalAssistanceText(agent)
          : `${agent} is already approved on chain. To use it in THIS folder, run \`mida approve ${agent}\` here (no transaction, nothing to pay).`,
      )
      // For `request` on a real agent that line is guidance, not a failure — a
      // `request a && request b` chain must run on through it (in-15 J-5). The assistant
      // identity is different: its already-approved answer is a real refusal — no per-folder
      // approval can ever exist for it (G8) — and approve still counts the code, as before.
      if (command === "request" && !isGeneralAssistant(runtime.home, agent)) return 0
    } else if (code === "chain-busy") {
      // the chain could not be asked at all — the same owner-facing line ownerRefusalLine prints
      print("Monad is busy right now — nothing was sent or decided; wait a moment and run the same command again")
    } else if (code === "chain-misconfigured") {
      print("the RPC answered but found no Mida contract — check MONAD_TESTNET_RPC or this setup's network.json; nothing was sent or decided")
    } else if (code === "rpc-auth") {
      print("the RPC provider refused the key — check the provider URL in MONAD_TESTNET_RPC or network.json; nothing was sent or decided")
    } else if (code === "store-misconfigured") {
      // the store's own Monad connection is broken — the owner's RPC setup was never asked (in-12 N-8)
      print("the store's connection to Monad is misconfigured — the store operator must fix it; nothing was sent or decided")
    } else if (code === "store-rpc-auth") {
      print("the store's RPC key was refused — the store operator must fix it; nothing was sent or decided")
    } else if (code === "CHAIN_CALL_FAILED") {
      print(`the chain call failed — this setup's contract is ${runtime.chain.deployment.capabilityRegistry.slice(0, 6)}…; run with MIDA_DEBUG=1 to see why`)
    } else if (code === "agent-not-setup") {
      print(noIdentityText(agent, runtime.home.root))
    } else {
      print(`refused: ${code}`)
    }
    if (context?.debug === true) print(debugLine(error))
    return 1
  }
}

/**
 * The identity a task read stands behind (tk-1): listing tasks and `task show` both read
 * checkpoints, so they need an agent the owner approved for this folder — the first registered
 * name whose project gate passes, in sorted order for a stable answer. A refusal is quoted as
 * the first candidate's, exactly as `read` does.
 */
async function taskReadAgent(
  runtime: ServiceRuntime,
  cwd: string,
): Promise<{ ok: true; agent: string } | { ok: false; text: string }> {
  const candidates = [...new Set([...AGENTS, ...listAgentNames(runtime.home)])].sort()
  if (candidates.length === 0) {
    return { ok: false, text: `no agents are set up in this Mida home (${runtime.home.root}) — run \`mida init\` first` }
  }
  let firstRefusal: string | undefined
  for (const agent of candidates) {
    const check = await checkProject(runtime, { agent, cwd })
    if (check.ok) return { ok: true, agent }
    firstRefusal ??= projectCheckRefusal(runtime, agent, check).text
  }
  return { ok: false, text: firstRefusal ?? `refused: not-approved` }
}

/**
 * `mida task` (tk-1): the named-task command. Bare prints the folder's current task and every
 * task that has checkpoints, newest activity first; `task <name>` sets the folder's default;
 * `task --clear` takes it back to `main`; `task show <name>` prints that task's handoff — the
 * one deliberate boundary crossing, and strictly read-only (no session id means no pin, no
 * continuation link and no seen-set write).
 */
async function runTaskCommand(
  argv: string[],
  runtime: ServiceRuntime,
  print: (line: string) => void,
  context?: { cwd?: string; debug?: boolean; task?: string },
): Promise<number> {
  const usage = () => {
    print(USAGE)
    return 2
  }
  const cwd = context?.cwd ?? process.cwd()
  const folder = folderTaskFor(cwd)
  const notAProject = () => {
    print("this folder is not a Mida project — tasks live inside one: run `mida approve <agent>` here first")
    return 1
  }
  const arg = argv[0]

  if (arg === "show") {
    const name = argv[1]
    if (name === undefined || argv.length !== 2) return usage()
    if (!isTaskName(name)) {
      print(`refused: "${name}" — ${TASK_RULE_TEXT}`)
      return 2
    }
    if (folder.markerDir === null || folder.projectId === null) return notAProject()
    const picked = await taskReadAgent(runtime, cwd)
    if (!picked.ok) {
      print(picked.text)
      return 1
    }
    const result = await buildHandoff(runtime, {
      agent: picked.agent,
      cwd,
      authorNames: authorNamesFor(runtime),
      task: name,
    })
    // the read borrowed an approved agent's identity — name it, so the answer's provenance is
    // never implicit (in-18 N3)
    print(`(read as ${picked.agent})`)
    // the handoff's own line breaks are the contract, but every other unsafe byte — an ESC
    // sequence, a bidi override, a zero-width space — folds to a space (in-40 L-4)
    print(displaySafeBlock(result.text))
    return result.kind === "refused" ? 1 : 0
  }

  if (arg === "--clear") {
    if (argv.length !== 1) return usage()
    if (folder.markerDir === null) return notAProject()
    clearFolderTask(folder.markerDir)
    print(`current task: ${DEFAULT_TASK}`)
    return 0
  }

  if (arg !== undefined && !arg.startsWith("-")) {
    if (argv.length !== 1) return usage()
    if (!isTaskName(arg)) {
      print(`refused: "${arg}" — ${TASK_RULE_TEXT}`)
      return 2
    }
    if (folder.markerDir === null) return notAProject()
    writeFolderTask(folder.markerDir, arg)
    print(arg === DEFAULT_TASK ? `current task: ${DEFAULT_TASK}` : `current task: ${arg} — new sessions in this folder start under it`)
    return 0
  }

  if (arg !== undefined) return usage()

  // bare `mida task`: the task THIS shell resolves under — MIDA_TASK first, then the folder's
  // default — and every task the project holds checkpoints for, newest activity first.
  const resolved = resolveSessionTask(runtime.home, {
    cwd,
    projectId: folder.projectId ?? undefined,
    explicit: taskOrUndefined(context?.task),
  })
  const where =
    resolved.source === "explicit" ? " (MIDA_TASK)"
    : resolved.source === "folder" ? " (folder)"
    : resolved.source === "default" ? " (default)"
    : ` (${resolved.source})`
  print(`current task: ${resolved.task}${where}`)
  if (folder.markerDir === null || folder.projectId === null) {
    print("this folder is not a Mida project — no task list")
    return 0
  }
  const picked = await taskReadAgent(runtime, cwd)
  if (!picked.ok) {
    print(picked.text)
    return 1
  }
  let checkpoints: StoredCheckpoint[]
  try {
    checkpoints = (await readCheckpoints(runtime, picked.agent, folder.projectId)).checkpoints
  } catch (error) {
    print(`could not read the task list (${refusalCode(error)})`)
    return 1
  }
  const newest = new Map<string, StoredCheckpoint>()
  for (const cp of checkpoints) {
    const prev = newest.get(taskOf(cp))
    if (prev === undefined || compareChainOrder(cp, prev) > 0) newest.set(taskOf(cp), cp)
  }
  const names = authorNamesFor(runtime)
  const now = Date.now()
  const rows = [...newest.values()].sort((a, b) => compareChainOrder(b, a))
  print(rows.length === 0 ? "no checkpoints saved yet" : "tasks:")
  for (const cp of rows) {
    const author = names[cp.authorId.toLowerCase()] ?? "unknown agent"
    print(`  ${taskOf(cp)} — ${author} — ${agoText(recordedAt(cp), now)}`)
  }
  return 0
}

/**
 * The owner address for a folder command's PLAN — read-only (in-16 L8): a refused link or unlink
 * must not write `owner/secrets.json` to discover it was refused, so the plan runs on the saved
 * address alone. A home with a key file but no address record derives the address from the key
 * without creating anything; a fresh home plans with no owner at all — the list either does not
 * exist (empty) or cannot be verified (the plan refuses `no-owner`).
 */
function ownerAddressFor(home: MidaHome): Address | undefined {
  const saved = loadOwnerAddress(home)
  if (saved !== undefined) return saved
  return home.has("owner/secrets.json")
    ? privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    : undefined
}

/**
 * The `{ home, owner }` the folder commands sign the approved-projects list with — never the
 * owner runtime. Signing is local cryptography, so link, unlink and project new run with no
 * chain in reach: the owner address comes from the saved file or the key the file names. This
 * runs only after the owner typed yes — creating owner material is a consequence of signing,
 * never of asking (in-16 L8) — and the address lands in `owner-address.json` so the list the
 * command just signed can be verified the same way next time.
 */
function listOwnerFor(home: MidaHome): ListOwner {
  const saved = loadOwnerAddress(home)
  if (saved !== undefined) return { home, owner: saved }
  const account = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey)
  saveOwnerAddress(home, account.address)
  return { home, owner: account.address }
}

/**
 * The folder commands (lk-1): `link <folder>` joins this folder to the project <folder> belongs
 * to, `unlink` takes this folder back out, `project new` starts a separate project here. They
 * run in the `mida` process like every owner command — but sign only the owner-signed list or a
 * folder marker, so they open no runtime and reach no chain at all.
 */
async function runFolderCommand(argv: string[], deps: CliDeps): Promise<number> {
  const command = argv[0]!
  const usage = () => {
    deps.print(USAGE)
    return 2
  }
  const cwd = deps.cwd ?? process.cwd()
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  const askYes = async (question: string): Promise<boolean> => {
    await drain()
    return (await prompt(question)).trim() === "yes"
  }
  let ownerAddress: Address | undefined
  // the shared unlink tail — what will be removed, the typed yes, the signed write and the
  // marker removal — used by plain `unlink` and by `unlink --folder` on a live marked folder
  const runUnlinkPlan = async (plan: Extract<ProjectUnlinkPlan, { kind: "ok" }>): Promise<number> => {
    const agents = [...new Set(plan.rows.map((e) => e.agent))].sort()
    deps.print(`project ${plan.projectId} — unlinking ${plan.root}`)
    deps.print(
      `this removes ${plan.rows.length} approval row(s)${agents.length > 0 ? ` (${agents.join(", ")})` : ""} ` +
        `and the marker ${join(plan.markerDir, ".mida")}`,
    )
    if (plan.otherRoots.length > 0) deps.print(`the project keeps its other folder(s): ${plan.otherRoots.join(", ")}`)
    if (!(await askYes("Type yes to unlink: "))) {
      deps.print("not approved")
      return 1
    }
    const owner = listOwnerFor(deps.home)
    ownerAddress = owner.owner
    const result = await unlinkProject(owner, { projectId: plan.projectId, markerDir: plan.markerDir })
    deps.print(`unlinked ${plan.root} from project ${plan.projectId} (${result.removed} row(s) removed)`)
    return 0
  }
  try {
    if (command === "link") {
      if (argv.length !== 2) return usage()
      // the plan runs on the saved address alone — a refused link on a fresh home must not
      // create the owner key file to discover it was refused (in-16 L8); the key is created
      // only when a confirmed link actually signs the list
      const reader = { home: deps.home, owner: ownerAddressFor(deps.home) }
      ownerAddress = reader.owner
      const plan = await planProjectLink(reader, { folder: argv[1]!, cwd, homeDir: deps.homeDir })
      if (plan.kind === "refused") {
        deps.print(plan.message)
        return 1
      }
      if (plan.kind === "already") {
        deps.print(plan.message ?? `already linked to project ${plan.projectId} — nothing to change`)
        return 0
      }
      if (plan.kind === "move") {
        // the folder move prompt (in-16 K-2, wording per Dami): what the folder leaves, what
        // the old project keeps, and that its history is not copied. `checkpoints === null`
        // means no local count exists — say "unknown number of", never a guess.
        deps.print(`This folder currently belongs to project ${plan.fromProjectId}.`)
        deps.print(`Project ${plan.fromProjectId}:`)
        deps.print(`• ${plan.fromFolders === 1 ? "1 folder" : `${plan.fromFolders} folders`}`)
        deps.print(plan.checkpoints === null ? "• unknown number of saved checkpoints" : `• ${plan.checkpoints} saved checkpoints`)
        deps.print(`Linking will move this folder to project ${plan.projectId}.`)
        deps.print(
          plan.checkpoints === null
            ? `The existing checkpoints stay in project ${plan.fromProjectId}'s history.`
            : `The ${plan.checkpoints} existing checkpoints stay in project ${plan.fromProjectId}'s history.`,
        )
        deps.print(`They will NOT be copied into project ${plan.projectId} or appear in project ${plan.projectId}'s handoffs.`)
        if (!(await askYes("Continue? Type yes: "))) {
          deps.print("not approved")
          return 1
        }
        const owner = listOwnerFor(deps.home)
        ownerAddress = owner.owner
        const result = await linkProject(owner, { projectId: plan.projectId, dir: plan.root, fromProjectId: plan.fromProjectId })
        deps.print(
          `moved ${result.root} from project ${plan.fromProjectId} to project ${plan.projectId} ` +
            `for ${result.agents.length === 0 ? "no agents yet" : result.agents.join(", ")}`,
        )
        return 0
      }
      // what the owner is confirming: the project, its marker folder, this folder's canonical
      // path, and every agent that will be allowed to work here
      deps.print(`project ${plan.projectId} — its marker is ${plan.sourceRoot}`)
      deps.print(`linking ${plan.root}`)
      deps.print(
        plan.agents.length === 0
          ? "no agent is approved for this project yet — run `mida approve <agent>` in it after linking"
          : `agents allowed to work in ${plan.root}: ${plan.agents.join(", ")}`,
      )
      if (!(await askYes("Type yes to link: "))) {
        deps.print("not approved")
        return 1
      }
      const owner = listOwnerFor(deps.home)
      ownerAddress = owner.owner
      const result = await linkProject(owner, { projectId: plan.projectId, dir: plan.root })
      deps.print(`linked ${result.root} to project ${plan.projectId} for ${result.agents.length === 0 ? "no agents yet" : result.agents.join(", ")}`)
      return 0
    }
    if (command === "unlink") {
      const reader = { home: deps.home, owner: ownerAddressFor(deps.home) }
      ownerAddress = reader.owner
      // `--folder <path>` (in-16 B3) is for the folder unlink cannot be run inside — deleted or
      // otherwise unreachable: its rows leave through the same signed write, and doctor can name
      // a fix that exists. A live folder with its own marker plans as a normal unlink instead.
      if (argv[1] === "--folder") {
        if (argv.length !== 3) return usage()
        const plan = await planFolderUnlink(reader, { folder: argv[2]!, cwd, homeDir: deps.homeDir })
        if (plan.kind === "refused") {
          deps.print(plan.message)
          return 1
        }
        if ("removals" in plan) {
          deps.print(
            plan.gone
              ? `${plan.root} is gone — removing the rows the signed list still keeps for it`
              : `${plan.root} carries no marker of its own — removing the rows the signed list keeps for it`,
          )
          for (const removal of plan.removals) {
            const agents = [...new Set(removal.rows.map((e) => e.agent))].sort()
            deps.print(`project ${removal.projectId}: ${removal.rows.length} row(s) (${agents.join(", ")})`)
          }
          if (!(await askYes("Type yes to unlink: "))) {
            deps.print("not approved")
            return 1
          }
          const owner = listOwnerFor(deps.home)
          ownerAddress = owner.owner
          const result = await unlinkFolderRows(owner, {
            root: plan.root,
            asTyped: plan.asTyped,
            projectIds: plan.removals.map((r) => r.projectId),
          })
          deps.print(`unlinked ${plan.root} (${result.removed} row(s) removed)`)
          return 0
        }
        // a live folder with its own marker — the normal plan below
        return await runUnlinkPlan(plan)
      }
      if (argv.length !== 1) return usage()
      const plan = await planProjectUnlink(reader, { cwd })
      if (plan.kind === "refused") {
        deps.print(plan.message)
        return 1
      }
      return await runUnlinkPlan(plan)
    }
    // command === "project" — the only subcommand is `new`
    if (argv.length !== 2 || argv[1] !== "new") return usage()
    const plan = projectNewPlan(cwd, deps.homeDir ?? homedir())
    if (plan.kind === "refused") {
      deps.print(plan.message)
      return 1
    }
    if (plan.parent !== null) {
      deps.print(
        `this folder currently uses project ${plan.parent.projectId} (marker in ${plan.parent.markerDir}) ` +
          "— a new project here means it stops using that one",
      )
      if (!(await askYes("Type yes to create a new project: "))) {
        deps.print("not approved")
        return 1
      }
    }
    const { projectId } = newProject(cwd)
    deps.print(`created project ${projectId} in ${cwd}`)
    deps.print("agents must still be approved for it — run `mida approve <agent>` in this folder")
    return 0
  } catch (error) {
    deps.print(ownerRefusalLine(command, argv[1] ?? "", error, ownerAddress, deps.network.deployment.capabilityRegistry, deps.home))
    if (process.env.MIDA_DEBUG === "1") deps.print(debugLine(error))
    return 1
  }
}

/**
 * The gate `mida add-agent <name>` runs before any prompt: the argument has to be present, a
 * name that can be an identity, not one this build provisions through its own command, and not
 * one this home already holds. Software and passkey homes share the check — it reads only files.
 */
function addAgentCheck(home: MidaHome, argv: string[]): { kind: "usage" } | { kind: "refused"; line: string } | { kind: "ok"; name: string } {
  if (argv.length !== 2) return { kind: "usage" }
  const name = argv[1]!
  if (BUILTIN_AGENT_NAMES.has(name)) {
    return { kind: "refused", line: `refused: ${name} is a built-in agent — it already has its own setup path` }
  }
  if (!ADD_AGENT_NAME.test(name)) {
    return { kind: "refused", line: `refused: agent names match ^[a-z0-9][a-z0-9-]{0,39}$ — lowercase letters, digits and dashes, starting with a letter or digit` }
  }
  if (listAgentNames(home).includes(name)) {
    return { kind: "refused", line: `refused: ${name} already has an identity in this Mida home — nothing to add` }
  }
  return { kind: "ok", name }
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
  // An installed client's identity (claude-desktop, cursor) is a real approve/revoke target —
  // `install <client>` registered it, so the name is checked against the home, not only AGENTS.
  if ((command === "approve" || command === "revoke") && agent !== "--all" && !AGENTS.includes(agent) && !listAgentNames(runtime.home).includes(agent)) return usage()
  // `remember` needs a fact; `remember --replaces` needs an id to name AND a fact after it.
  if (command === "remember") {
    const replaces = argv[1] === "--replaces"
    const tail = argv.slice(replaces ? 3 : 1).join(" ").trim()
    if ((replaces && (argv[2] ?? "").trim().length === 0) || tail.length === 0) return usage()
  }

  try {
    if (command === "init") {
      const result = await init(runtime, AGENTS)
      deps.print(`owner ${result.owner}`)
      for (const [name, agentId] of Object.entries(result.agents)) deps.print(`agent ${name} ${agentId}`)
    } else if (command === "add-agent") {
      const check = addAgentCheck(runtime.home, argv)
      if (check.kind === "usage") return usage()
      if (check.kind === "refused") {
        deps.print(check.line)
        return 1
      }
      const prompt = deps.prompt ?? terminalPrompt
      const drain = deps.drainInput ?? drainBufferedStdin
      deps.print(`add-agent ${check.name}: registers a new project-context identity on chain — the same provision pass \`mida init\` runs per agent`)
      // same stale-input rule as approve: only a line typed against the visible ask counts
      await drain()
      if ((await prompt(`Type yes to add ${check.name}: `)).trim() !== "yes") {
        deps.print("not approved")
        return 1
      }
      const result = await init(runtime, [check.name])
      deps.print(`added ${check.name} ${result.agents[check.name]}`)
      deps.print(`next: the agent files its own access request — run \`mida request ${check.name}\` or let its integration call requestAccess(), then \`mida approve ${check.name}\` in a project folder`)
    } else if (command === "remember") {
      const replaceId = argv[1] === "--replaces" ? (argv[2] ?? "") : undefined
      let replaces: { contextId: Hex; namespace: FactNamespace } | undefined
      if (replaceId !== undefined) {
        // The target is resolved BEFORE the ask — an id that names no fact or several facts
        // refuses here, without spending a signature prompt on it.
        const resolved = await resolveFactId(runtime, replaceId)
        if (resolved.kind === "refused") {
          deps.print(`refused: ${resolved.code} — ${resolved.message}`)
          return 1
        }
        replaces = { contextId: resolved.contextId, namespace: resolved.namespace }
        deps.print(`replaces: fact ${factShortId(resolved.contextId)} in ${resolved.namespace} — the old fact stays readable as history`)
      }
      // The owner sees WHICH context area the fact will land in before the ask — answering the
      // "which namespace does this belong to" question — and sees it again after the write. A
      // replacement lands where its parent lives, so that namespace is the one named.
      const area = `area: ${replaces?.namespace ?? DEFAULT_FACT_NAMESPACE} (agents with READ on this area will see it)`
      deps.print(area)
      const prompt = deps.prompt ?? terminalPrompt
      const drain = deps.drainInput ?? drainBufferedStdin
      // same stale-input rule as approve: only a line typed against the visible ask counts
      await drain()
      if ((await prompt("Type yes to remember: ")).trim() !== "yes") {
        deps.print("not approved")
        return 1
      }
      const result = await remember(runtime, argv.slice(replaceId === undefined ? 1 : 3).join(" "), replaces === undefined ? {} : { replaces })
      if (result.kind === "remembered") {
        deps.print(`area: ${result.namespace} (agents with READ on this area will see it)`)
        deps.print(`remembered ${result.contextId} in ${result.namespace}`)
      } else {
        deps.print(`refused: ${result.code}`)
      }
      return result.kind === "remembered" ? 0 : 1
    } else if (command === "approve" && agent === "--all") {
      if (argv.length !== 2) return usage()
      return await approveAll(runtime, deps)
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
        deps.print("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
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
    } else if (command === "install") {
      const tool = argv[1] ?? ""
      // devin is a hook tool, not an MCP client — but its install provisions an identity (in-9:
      // init no longer registers one by default), so it is an owner command all the same.
      // --no-mcp is devin's only extra word here: for the MCP clients the entry IS the install,
      // so a flag that skips it has nothing left to do — that is usage, not a no-op.
      const devinNoMcp = argv.length === 3 && argv[2] === "--no-mcp" && tool === "devin"
      if ((argv.length !== 2 && !devinNoMcp) || !(MCP_CLIENT_TOOLS.includes(tool) || tool === "devin")) return usage()
      // the identity comes first — provisioning is init's per-agent pass over this one name, so
      // install is idempotent the same way init is: an existing identity is kept, a missing one
      // registers on chain as a project-context agent (never `assistant`)
      await init(runtime, [tool])
      // the pending request is what `mida approve <client>` completes — file one if none waits
      if (!runtime.home.has(`agents/${tool}/pending-request.json`)) {
        try {
          await requestAccess(runtime, tool)
        } catch (error) {
          if (refusalCode(error) !== "already-approved") throw error
        }
      }
      if (tool === "devin") {
        const outcome = installDevin(deps.devinConfig ?? resolveDevinConfigPath(process.env, homedir()))
        deps.print(outcome === "already-installed" ? "already installed" : "installed")
        // Devin's own MCP config location is not in this build — say so, unless the owner
        // explicitly skipped the server with --no-mcp
        if (!devinNoMcp) {
          deps.print("devin: MCP server not added. This build does not know where Devin keeps MCP servers; hooks are installed.")
        }
        deps.print(`next: run \`mida approve devin\` in this folder`)
        return 0
      }
      const client = tool as McpClientTool
      const cwd = deps.cwd ?? process.cwd()
      const configPath = client === "cursor"
        ? cursorMcpConfigPath(cwd)
        : deps.claudeDesktopConfig ?? claudeDesktopConfigPath(homedir())
      const outcome = installMcpClient(client, configPath, runtime.home.root, cwd)
      if (typeof outcome === "object") {
        deps.print("installed")
        deps.print(`the ${MCP_SERVER_NAME[client]} entry moved from ${outcome.moved.from} to ${outcome.moved.to}`)
      } else {
        deps.print(outcome === "already-installed" ? "already installed" : "installed")
      }
      // the per-workspace mcp.json carries personal absolute paths (the launcher, the home) —
      // committing it would leak the machine's layout to anyone reading the repo
      if (client === "cursor") deps.print("heads-up: .cursor/mcp.json holds absolute paths from this machine — do not commit it")
      const protectedNote = macosProtectedFolderNote(
        client,
        deps.launcherPath ?? mcpLauncherPath(),
        deps.homeDir ?? homedir(),
        deps.platform ?? process.platform,
      )
      if (protectedNote !== undefined) deps.print(protectedNote)
      deps.print(`next: run \`mida approve ${client}\` in this folder`)
    } else if (command === "batching") {
      return await runBatching(runtime, argv[1], deps)
    } else if (command === "sponsor") {
      return await runSponsor(runtime, argv[1], deps)
    } else if (command === "revoke" && agent === "--all") {
      if (argv.length !== 2) return usage()
      return await revokeAll(runtime, deps)
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
      if (result.transactionHashes.length > 0) {
        deps.print(`This stops future reads through Mida. It does not erase what ${agent} already read.`)
      }
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
    deps.print(ownerRefusalLine(command, agent, error, runtime.owner, runtime.chain.deployment.capabilityRegistry, runtime.home))
    // Owner commands run in the owner's own terminal, and an unnamed failure leaves them blind.
    // Only when they ask (MIDA_DEBUG=1): the error's name and first lines, long hex strings masked.
    if (process.env.MIDA_DEBUG === "1") {
      deps.print(debugLine(error))
    }
    return 1
  }
}

/**
 * One registered agent's place in an `approve --all` batch: its pending request goes through
 * the advisor gate, a live grant without this folder's row needs only the row (the AUTH-15
 * case — `mida request` files nothing once the grant exists), an agent with neither is
 * reported with its fix and is never a failure, and an agent whose row is already signed in —
 * or the `assistant` identity, which project approvals exclude by design — leaves no work.
 */
type BatchAgent = { name: string; kind: "pending" | "folder" | "noperm" }

/**
 * The agents `approve --all` works over, in listAgentNames order so the preview reads the same
 * on every run. With no folder to approve (cwd unset) the batch is exactly the pending list —
 * the pre-AUTH-15 behaviour — since a live grant's only remaining work is the folder row.
 */
async function batchAgents(
  runtime: ServiceRuntime,
  marker: { markerDir: string; projectId: string } | undefined,
): Promise<BatchAgent[]> {
  const out: BatchAgent[] = []
  let root = ""
  let entries: ProjectApproval[] = []
  if (marker !== undefined) {
    root = realpathSync.native(marker.markerDir)
    const file = await readApprovalsFile(runtime.home, runtime.owner)
    entries = file.kind === "signed" ? file.entries : []
  }
  for (const name of listAgentNames(runtime.home)) {
    if (runtime.home.has(`agents/${name}/pending-request.json`)) {
      out.push({ name, kind: "pending" })
      continue
    }
    if (marker === undefined) continue
    const identity = loadAgentIdentity(runtime.home, name)
    if (identity === undefined || identity.purposeId !== PURPOSE_ID) continue
    if (!(await hasAnyLiveCapability(runtime, identity.agentId))) {
      out.push({ name, kind: "noperm" })
      continue
    }
    const listed = entries.some(
      (e) => e.agent === name && e.projectId === marker.projectId && sameProjectRoot(e.root, root),
    )
    if (!listed) out.push({ name, kind: "folder" })
  }
  return out
}

/** One pending agent's ask inside the combined preview — the same lines a single approve shows. */
function printPendingAsk(deps: CliDeps, home: MidaHome, name: string, projectId: string | undefined): void {
  deps.print(`${name} is asking for:`)
  if (projectId !== undefined) deps.print(`  project ${projectId} (this folder)`)
  const pending = home.readJson<{ request?: { scopes?: RequestedScope[]; capabilityExpiresAt?: string } }>(`agents/${name}/pending-request.json`)?.request
  for (const scope of pending?.scopes ?? []) {
    deps.print(`  ${namespaceLabel(scope.namespaceId)}: ${permissionNames(scope.permissions).join(" + ")}`)
  }
  if (pending?.capabilityExpiresAt !== undefined) {
    deps.print(`  until ${new Date(Number(decodeUint64(pending.capabilityExpiresAt)) * 1000).toISOString()}`)
  }
}

/**
 * `mida approve --all`: one combined list, one typed yes, then each approve runs in turn — the
 * batch ask already covered every agent, so each approve signs without asking again. A failure
 * names itself and the next agent still runs; the last line is the verdict. Nothing to do says
 * so and exits 0 — the answer "everyone is approved" is honest without a transaction.
 */
async function approveAll(runtime: Runtime, deps: CliDeps): Promise<number> {
  // The marker resolves before the list, exactly as a single approve resolves it before the ask:
  // a folder that may not hold a project refuses here, before any signature. It also decides
  // which live-grant agents still need this folder's row (AUTH-15).
  const marker = deps.cwd === undefined ? undefined : ensureProjectMarker(deps.cwd)
  const batch = await batchAgents(runtime, marker)
  if (!batch.some((agent) => agent.kind !== "noperm")) {
    for (const { name, kind } of batch) {
      if (kind === "noperm") deps.print(`${name}: no permission yet — run \`mida request ${name}\` first`)
    }
    deps.print(
      marker === undefined
        ? "nothing to approve — no agent has a pending request"
        : "nothing to approve — every agent with permission is already approved for this folder",
    )
    return 0
  }
  // One combined preview in agent order. Each pending agent gets the same gate a single approve
  // runs before its prompt — the ask, then the grant advisor's verdict; a request that fails
  // the advisor's current-request checks (expired, consumed, stale signature) is named here and
  // excluded before the prompt — nothing is ever sent for it. A live grant gets the same line
  // a single approve's project preview shows, and a no-permission agent its fix.
  const ready: string[] = []
  const failed: string[] = []
  // the live-grant sweep the batch adds to this folder (in-18 N2) — counted for the summary
  // line the owner reads right above the yes
  const gainingFolder: string[] = []
  for (const { name, kind } of batch) {
    if (kind === "noperm") {
      deps.print(`${name}: no permission yet — run \`mida request ${name}\` first`)
      continue
    }
    if (kind === "folder") {
      deps.print(`${name} already holds a live grant; this lists it for project ${marker!.projectId} (this folder)`)
      ready.push(name)
      gainingFolder.push(name)
      continue
    }
    printPendingAsk(deps, runtime.home, name, marker?.projectId)
    try {
      const advice = await pendingApprovalAdvice(runtime, name)
      deps.print(`grant advisor: ${advice.risk} risk; recommends ${advice.recommended.length} scope(s) until ${new Date(Number(decodeUint64(advice.recommendedExpiresAt)) * 1000).toISOString()}`)
      for (const warning of advice.warnings) deps.print(`  ${warning.severity}: ${warning.messageKey}`)
      ready.push(name)
    } catch (error) {
      deps.print(ownerRefusalLine("approve", name, error, runtime.owner, runtime.chain.deployment.capabilityRegistry, runtime.home))
      failed.push(`${name} (${refusalCode(error)})`)
    }
  }
  // Everything the batch could try failed the gate — there is nothing left to confirm, so the
  // batch ends with the verdict instead of an ask.
  if (ready.length === 0) {
    deps.print(`approved: none${failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`}`)
    return 1
  }
  deps.print("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
  // N2: when the sweep adds live-grant agents to this folder, name them in the line the owner
  // reads last — right above the yes
  if (gainingFolder.length > 0) {
    deps.print(`${gainingFolder.length} agent${gainingFolder.length === 1 ? "" : "s"} will gain this folder: ${gainingFolder.join(", ")}`)
  }
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  await drain()
  if ((await prompt("Type yes to approve all: ")).trim() !== "yes") {
    deps.print("not approved")
    return 1
  }
  const approved: string[] = []
  for (const name of ready) {
    try {
      const result = await approve(runtime, name, deps.cwd)
      approved.push(name)
      deps.print(
        result.transactionHash === null
          ? // "now approved" only when this batch actually wrote the row — a re-list is not a grant
            result.projectAlreadyListed === true
            ? `${name} is already approved on chain. This folder was already approved for ${name}.`
            : `${name} is already approved on chain. This folder is now approved for ${name} too (no transaction).`
          : `approved ${name} tx ${result.transactionHash}`,
      )
    } catch (error) {
      deps.print(ownerRefusalLine("approve", name, error, runtime.owner, runtime.chain.deployment.capabilityRegistry, runtime.home))
      failed.push(`${name} (${refusalCode(error)})`)
    }
  }
  // A partial batch still changed the chain for its successes — the daemon must hear it even
  // though the exit code below is 1 (runCli's own kick fires only on a clean 0)
  if (approved.length > 0 && failed.length > 0) await kickDaemonNow(deps)
  deps.print(`approved: ${approved.length === 0 ? "none" : approved.join(", ")}${failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`}`)
  return failed.length === 0 ? 0 : 1
}

/** The daemon poke `runCli` sends after a clean approve/revoke — a partial `--all` exits 1 but still changed the chain for its successes, so the batch kicks itself in exactly that case. */
async function kickDaemonNow(deps: CliDeps): Promise<void> {
  await Promise.resolve(deps.kickDaemon ? deps.kickDaemon() : callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 })).catch(() => {})
}

/** How long a service is given to leave after POST /shutdown before `sponsor` gives up on it — the same ten seconds ensureCurrentDaemon allows a replaced service. */
const SPONSOR_STOP_WAIT_MS = 10_000

/**
 * What the service did after `sponsor on|off` asked it to restart (in-40 L-3): `restarted` — a
 * fresh service is answering; `not-running` — nothing was listening, so nothing was spawned;
 * `kept-running` — /shutdown was refused or timed out and the old gas setting is still live;
 * `stopping` — /shutdown was accepted but the old service is still finishing its pass at the
 * deadline; `stopped-not-started` — the old service left but no fresh one answered in time.
 */
type DaemonRestartOutcome = "restarted" | "not-running" | "kept-running" | "stopping" | "stopped-not-started"

const RESTART_OUTCOMES = new Set<string>(["restarted", "not-running", "kept-running", "stopping", "stopped-not-started"])

/**
 * The service poke `runCli` sends after a confirmed `sponsor on|off`. Batching's flag is re-read
 * from network.json on every save, so a `/kick` suffices for it; the sponsor URL is bound into
 * the send path when the service opens, so the answering service has to be replaced: POST
 * /shutdown, poll /health until it goes quiet, then the same detached spawn `mida init` uses —
 * and then prove the fresh service answers before claiming a restart. A `/health` probe that
 * TIMES OUT counts as a running service — a busy daemon holds the socket open without answering,
 * and only "nothing is listening" is not-running. A service that never answered is not started —
 * the next mida command's ensureCurrentDaemon opens one that reads the new file. Best-effort
 * like the kick: a service that will not stop is left alone rather than fought (the change lands
 * on its next start), and a failure never fails the command — but the outcome is reported so the
 * caller can say when the old gas setting is still live (in-39 B-6). Injectable via
 * `deps.restartDaemon`; an injected stub may return any outcome, and anything else counts as
 * "restarted" — what every pre-B-6 stub meant.
 */
async function restartDaemonNow(deps: CliDeps): Promise<DaemonRestartOutcome> {
  if (deps.restartDaemon !== undefined) {
    const result = await Promise.resolve(deps.restartDaemon()).catch(() => undefined)
    return typeof result === "string" && RESTART_OUTCOMES.has(result) ? (result as DaemonRestartOutcome) : "restarted"
  }
  const spawn = deps.spawnService ?? spawnDaemon
  const waitMs = deps.sponsorRestartWaitMs ?? SPONSOR_STOP_WAIT_MS
  const health = await callDaemon(deps.home, "/health", undefined, { timeoutMs: 500 })
  // "unreachable" is the only verdict that means nothing is listening; a timeout is a busy
  // service that held the connection, and a bad reply still proves a live peer (in-40 L-3)
  if (health.status === 0 && health.failure !== "timeout" && health.failure !== "bad-reply") return "not-running"
  const shutdown = await callDaemon(deps.home, "/shutdown", {}, { timeoutMs: 2_000 })
  // refused, timed out or answered gibberish — the running service never agreed to stop
  if (shutdown.status !== 200) return "kept-running"
  const stopDeadline = Date.now() + waitMs
  for (;;) {
    const reply = await callDaemon(deps.home, "/health", undefined, { timeoutMs: 500 })
    if (reply.status === 0 && reply.failure !== "timeout" && reply.failure !== "bad-reply") {
      // the socket went quiet: the old service is gone, so the fresh one is spawned — and the
      // command waits inside the same window for it to answer before calling this a restart
      spawn(deps.home.root)
      const upDeadline = Date.now() + waitMs
      for (;;) {
        const up = await callDaemon(deps.home, "/health", undefined, { timeoutMs: 500 })
        if (up.status === 200) return "restarted"
        if (Date.now() >= upDeadline) return "stopped-not-started"
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, upDeadline - Date.now()))))
      }
    }
    if (Date.now() >= stopDeadline) return "stopping"
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, stopDeadline - Date.now()))))
  }
}

/**
 * After a successful `sponsor on|off`: restart the service so the send path re-opens on the new
 * file, then say the two things that decide whether the change is already in effect — a service
 * that survived keeps the OLD setting until its next start, and a MIDA_SPONSOR_URL in this shell
 * wins over whatever the command just wrote (in-39 B-6, nit 1, in-40 L-3).
 */
async function finishSponsorChange(deps: CliDeps): Promise<void> {
  const outcome = await restartDaemonNow(deps)
  if (outcome === "kept-running") {
    deps.print("note: the Mida service did not restart, so it keeps the old gas setting until its next start. Run mida doctor to check.")
  } else if (outcome === "stopping") {
    deps.print("note: the Mida service is finishing its current work and will then stop. After that, open any agent session or run mida task to start it with the new gas setting.")
  } else if (outcome === "stopped-not-started") {
    deps.print("note: the Mida service stopped, but a new one did not start. Open any agent session or run mida task to start it with the new gas setting.")
  }
  if ((deps.env ?? process.env).MIDA_SPONSOR_URL !== undefined) {
    deps.print("note: MIDA_SPONSOR_URL is set in this shell and wins over network.json while it is set.")
  }
}

/**
 * The agents `revoke --all` lists: every `agents/*` folder that still holds an approval — a live
 * capability on chain, or a grants.json left by a grant that completed while no revoked marker says
 * it was taken back and whose last listed expiry is still ahead. Scanning the folders themselves —
 * not only the names with a readable identity.json — is what lets a damaged or partially written
 * folder still be checked: resolveAgentId falls back to signer.json and grants.json, and a folder
 * it cannot identify at all is returned in `unidentifiable` so the owner sees the name rather than
 * the agent silently vanishing from the batch. The chain answers first; the local file only adds
 * an agent the chain cannot show (a signed grant that was never proved, or one already dead the
 * folder never heard about), and only while some capability in it has not expired. A chain or
 * permission error propagates: a temporary failure must never silently drop an agent from the
 * list the owner is about to confirm.
 */
async function approvedAgents(runtime: ServiceRuntime): Promise<{ held: string[]; unidentifiable: { name: string; error: unknown }[] }> {
  const { home } = runtime
  const held: string[] = []
  const unidentifiable: { name: string; error: unknown }[] = []
  const now = BigInt(Math.floor(Date.now() / 1000))
  for (const name of home.list("agents").filter((entry) => READ_AS_NAME.test(entry)).sort()) {
    let agentId: Hex
    try {
      agentId = await resolveAgentId(runtime, name)
    } catch (error) {
      // "agent-unidentified" means the folder's local evidence ran out — report it by name and go
      // on. Anything else (a chain read, a permission problem) stays a hard failure.
      if (refusalCode(error) !== "agent-unidentified") throw error
      unidentifiable.push({ name, error })
      continue
    }
    if (await hasAnyLiveCapability(runtime, agentId)) {
      held.push(name)
      continue
    }
    if (!home.has(`agents/${name}/grants.json`) || isRevoked(home, name)) continue
    // The file's record counts only while some capability in it could still be live — an
    // all-expired grants.json is not "holds an approval". A file that cannot be read or parsed
    // cannot prove expiry either, so it still counts; the revoke itself then answers honestly.
    let fileShowsHeld = true
    try {
      fileShowsHeld = loadGrants(home, name).some((grant) =>
        grant.capabilities.some((capability) => {
          const expiresAt = decodeUint64(capability.expiresAt)
          return expiresAt === 0n || expiresAt > now
        }),
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EACCES" || code === "EPERM") throw error
    }
    if (fileShowsHeld) held.push(name)
  }
  return { held, unidentifiable }
}

/**
 * `mida revoke --all`: the approved agents are listed, one typed yes confirms the batch, then each
 * revoke runs in turn — the whole-agent revoke `mida revoke <agent>` performs, with its chain line,
 * its "stops future reads" note and its per-agent key lines. A failure names itself and the next
 * agent still runs; the last line is the verdict. Nobody approved says so and exits 0.
 */
async function revokeAll(runtime: Runtime, deps: CliDeps): Promise<number> {
  const scan = await approvedAgents(runtime)
  if (scan.held.length === 0 && scan.unidentifiable.length === 0) {
    deps.print("nothing to revoke — no agent in this Mida home holds an approval")
    return 0
  }
  for (const name of scan.held) deps.print(`${name} holds an approval`)
  const failed: string[] = []
  for (const { name, error } of scan.unidentifiable) {
    deps.print(ownerRefusalLine("revoke", name, error, runtime.owner, runtime.chain.deployment.capabilityRegistry, runtime.home))
    failed.push(`${name} (${refusalCode(error)})`)
  }
  const revoked: string[] = []
  if (scan.held.length === 0) {
    deps.print(`revoked: none; failed: ${failed.join(", ")}`)
    return 1
  }
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  await drain()
  if ((await prompt("Type yes to revoke all: ")).trim() !== "yes") {
    deps.print("not revoked")
    return 1
  }
  for (const name of scan.held) {
    try {
      const result = await revoke(runtime, name)
      // the same per-agent lines a single revoke prints — the chain answer first, always (M3-D4)
      if (result.transactionHashes.length === 0) {
        deps.print(`${name}: nothing to revoke`)
      } else {
        // only an agent whose approval actually went away counts under "revoked:" — a
        // nothing-to-revoke answer is reported, not counted
        revoked.push(name)
        deps.print(`revoked ${name} on chain${result.sponsored ? " (sponsored)" : ""} — tx ${result.transactionHashes.join(" ")}`)
      }
      if (result.transactionHashes.length > 0) {
        deps.print(`This stops future reads through Mida. It does not erase what ${name} already read.`)
      }
      for (const other of result.rewrapped) deps.print(`new read key sent to ${other}`)
      for (const failure of result.failed) {
        deps.print(`could not send the new key to ${failure.name}: ${failure.reason} — run \`mida approve ${failure.name}\``)
      }
      if (result.repairError !== undefined) {
        deps.print(`the key repair pass could not run: ${result.repairError} — run \`mida revoke ${name}\` again to retry it`)
      }
    } catch (error) {
      deps.print(ownerRefusalLine("revoke", name, error, runtime.owner, runtime.chain.deployment.capabilityRegistry, runtime.home))
      failed.push(`${name} (${refusalCode(error)})`)
    }
  }
  if (revoked.length > 0 && failed.length > 0) await kickDaemonNow(deps)
  deps.print(`revoked: ${revoked.length === 0 ? "none" : revoked.join(", ")}${failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`}`)
  return failed.length === 0 ? 0 : 1
}

/**
 * `mida batching on|off` — the switch for the batched checkpoint lane (the shared-transaction
 * save). `on` first runs the same lane check the save path runs, pretending the flag is already
 * set, and refuses with the plain reason when the lane would still be direct — a flag that
 * changes nothing is not written. A confirmed `on` writes only `batching: true`, leaving every
 * other network.json byte alone; the daemon picks the flag up on its next save. `off` writes
 * `batching: false` — saves already queued still finish, because the pending ledger owns them.
 */
async function runBatching(runtime: ServiceRuntime, arg: string | undefined, deps: CliDeps): Promise<number> {
  if (arg !== "on" && arg !== "off") {
    deps.print(USAGE)
    return 2
  }
  let saved
  try {
    saved = readSavedNetwork(runtime.home)
  } catch {
    deps.print(`batching cannot be turned ${arg}: network.json could not be read`)
    return 1
  }
  if (saved === undefined) {
    deps.print(`batching cannot be turned ${arg}: there is no network.json to switch — run \`mida init\` first`)
    return 1
  }
  if (arg === "off") {
    setBatchingFlag(runtime.home, false)
    deps.print("batching is off; saves already queued will still finish")
    return 0
  }
  const lane = await decideLane({
    saved: { ...saved, batching: true },
    deployment: runtime.network.deployment,
    storageUrl: runtime.network.storageUrl,
    status: () => batchStatusProbe(runtime.network.storageUrl ?? ""),
  })
  if (lane.kind === "direct") {
    deps.print(`batching cannot be turned on: ${laneWhyText(lane.why)}`)
    return 1
  }
  deps.print(
    `automatic checkpoint saves will be anchored in shared batches via ${hostOf(lane.storeUrl)}; grants, revokes and facts are unaffected; saves are usable at once and marked PENDING_ANCHOR until anchored`,
  )
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  await drain()
  if ((await prompt("Type yes to turn batching on: ")).trim() !== "yes") {
    deps.print("not approved")
    return 1
  }
  setBatchingFlag(runtime.home, true)
  deps.print("batching is on")
  return 0
}

/**
 * `mida sponsor on|off` — the switch between the hosted gas sponsor and self-paid gas, for
 * setups made before the sponsor existed. `on` writes the sponsor URL this build ships into
 * network.json (MIDA_SPONSOR_URL still wins over the file while it is set); `off` removes the
 * pair. Either way every other byte of the file survives, and the service restart that applies
 * the change happens after this returns — the sponsor lives in the send path the service built
 * when it opened, so a kick cannot reach it. `on` also clears recorded out-of-gas waits: a
 * session that was waiting out a dry wallet can save on the next pass (in-29 S-2).
 */
async function runSponsor(runtime: ServiceRuntime, arg: string | undefined, deps: CliDeps): Promise<number> {
  if (arg !== "on" && arg !== "off") {
    deps.print(USAGE)
    return 2
  }
  let saved
  try {
    saved = readSavedNetwork(runtime.home)
  } catch {
    deps.print(`sponsor cannot be turned ${arg}: network.json could not be read`)
    return 1
  }
  if (saved === undefined) {
    deps.print(`sponsor cannot be turned ${arg}: there is no network.json to switch — run \`mida init\` first`)
    return 1
  }
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  if (arg === "off") {
    await drain()
    if ((await prompt("Type yes to turn the sponsor off: ")).trim() !== "yes") {
      deps.print("not approved")
      return 1
    }
    setSponsorUrl(runtime.home, undefined)
    deps.print("gas sponsor off: your wallets pay their own gas")
    return 0
  }
  // the value written is the hosted sponsor the build knows — validated by the same rule the
  // send path applies, so a malformed shipped constant can never land in the file
  const sponsorUrl = parseSponsorUrl(HOSTED_SPONSOR_URL)!
  const host = hostOf(sponsorUrl)
  deps.print(
    `Your saves and grants will use the gas sponsor at ${host}, so your wallets stop paying. Your wallets keep what they hold as a fallback.`,
  )
  await drain()
  if ((await prompt("Type yes to turn the sponsor on: ")).trim() !== "yes") {
    deps.print("not approved")
    return 1
  }
  setSponsorUrl(runtime.home, sponsorUrl)
  resetOutOfGasWaits(runtime.home)
  deps.print(`gas sponsor on: ${host}`)
  return 0
}

/**
 * What an owner command prints when it fails. Codes with an obvious next step get a plain line
 * that names it; everything else keeps `refused: <code>` — a message from a deeper layer is
 * never echoed because it could carry data. `agent` is the command's subject — for `remember`
 * argv[1] is fact text, but the agent-naming codes cannot surface from remember anyway.
 */
/**
 * Where the last `mida migrate` run stopped, in migrate.ts's own terms — the persisted
 * migrate/state.json step is the only record that survives a crash mid-send. `step` names
 * the last FINISHED phase and sends begin inside target-setup: "none" is no file or a
 * pre-send step (preview/paused/backed-up), "finished" is "switched" — the last step a
 * completed move writes, whose sends are done and whose failure wording must never read like
 * a stopped run — and everything else, including a file that will not parse, is "mid-run":
 * fail closed, never claim "nothing was sent" on a guess.
 */
type MigrateProgress = "none" | "mid-run" | "finished"

const migrateProgress = (home: MidaHome | undefined): MigrateProgress => {
  if (home === undefined) return "none"
  let step: unknown
  try {
    const state = home.readJson<{ step?: unknown }>("migrate/state.json")
    if (state === undefined) return "none"
    step = state.step
  } catch {
    return "mid-run"
  }
  if (step === "switched") return "finished"
  return typeof step !== "string" || !["preview", "paused", "backed-up"].includes(step) ? "mid-run" : "none"
}

export function ownerRefusalLine(command: string, agent: string, error: unknown, ownerAddress?: string, capabilityRegistry?: string, home?: MidaHome, undo = false): string {
  const code = refusalCode(error)
  // The "nothing was sent/written" claims are true only before migrate's first transaction —
  // the state file tells the three cases apart (ex-4 G-1): no move started keeps the plain
  // claim; a mid-run move names resume and --undo; a FINISHED move ("switched") is neither —
  // the failure is a new run that had sent nothing when it stopped. An --undo failure is its
  // own line: it names the undo route and never points at resuming the move.
  const progress = command === "migrate" ? migrateProgress(home) : "none"
  const partway =
    command !== "migrate"
      ? undefined
      : undo
        ? progress === "none"
          ? undefined
          : "the undo stopped before it finished — run `mida migrate --undo` again to go back"
        : progress === "finished"
          ? "the move already finished — this run had sent nothing when it stopped; run `mida migrate` again to retry, or `mida migrate --undo` to go back"
          : progress === "mid-run"
            ? "the move stopped partway — run `mida migrate` again to resume it, or `mida migrate --undo` to go back"
            : undefined
  switch (code) {
    // The owner saw the preview and answered something other than yes — nothing was signed.
    case "not-approved": return "not approved"
    case "REQUEST_EXPIRED":
      return `${agent}'s request has expired (a request lasts ${Number(REQUEST_LIFETIME_SECONDS) / 60} minutes): run \`mida request ${agent}\` and approve again`
    case "already-approved":
      // A general-assistance identity can never hold a project row — pointing at `approve` here
      // would send the owner round a loop that can only ever answer already-approved again.
      if (home !== undefined && isGeneralAssistant(home, agent)) return generalAssistanceText(agent)
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
    // A software home with an owner address but no owner/secrets.json — export refuses to mint
    // one; the same line its own refusal prints.
    case "no-owner-key":
      return "no owner key on this machine — export needs the local software owner key"
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
    // The plan refuses a tampered list before the ask, so reaching this means the file broke
    // mid-command — the answer is still the same: nothing was written by this run.
    case "list-tampered":
      return "the approved-projects list failed its signature check — run `mida doctor`"
    // in-16 K-2: the signed write landed but the marker could not flip AND the undo write also
    // failed — the sentence the error carries is the true state, so print it
    case "move-not-undone":
      return error instanceof Error ? error.message : "refused: move-not-undone"
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
    // A send gave up waiting on Monad (in-15 J-4): the error's own sentence already says what is
    // true — a hash means "sent, not confirmed", none means either "may have gone out" or
    // "nothing was sent". Since in-16 K-4 the pending cases carry "don't run the command again
    // until `mida doctor` shows the result", which is the safe advice for `remember` too — no
    // command-specific rewrite remains.
    case "SEND_TIMEOUT": {
      if (!(error instanceof Error)) return "refused: SEND_TIMEOUT"
      const prefix = "SEND_TIMEOUT: "
      return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
    }
    // The saved setup names another contract than this build ships. Only `mida migrate` may
    // move it — init refuses rather than rewrite the file (the error carries both addresses).
    case "deployment-mismatch": {
      const detail = error as { saved?: unknown; builtIn?: unknown }
      const short = (a: unknown) => (typeof a === "string" ? `${a.slice(0, 6)}…` : "unknown")
      return `this setup is on contract ${short(detail.saved)}; this version of Mida ships ${short(detail.builtIn)}. \`init\` will not move it — run \`mida migrate\``
    }
    // The chain could not be asked at all — a busy or down RPC, never an authorization answer:
    // nothing was signed, sent or decided, and a moment later the same command answers for real.
    // export's owner read could not certify every record. The line is built from the error's
    // contextIds and reason CODES — never its message or a deeper layer's, which can carry a
    // provider URL with an API key in its path.
    case "owner-read-incomplete": {
      const detail = error as { contextIds?: unknown; reasons?: unknown }
      const ids = (Array.isArray(detail.contextIds) ? detail.contextIds : []).filter((id): id is string => typeof id === "string")
      const reasons = (Array.isArray(detail.reasons) ? detail.reasons : []).filter((r): r is string => typeof r === "string")
      const named =
        ids.length === 0 ? "" : `: ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more` : ""}`
      const why = reasons.length === 0 ? "" : ` (${reasons.join("; ")})`
      const head =
        partway !== undefined
          ? `${ids.length === 0 ? "the owner read" : `${ids.length} record(s)`} could not be read back — ${partway}`
          : ids.length === 0
            ? "the owner read could not verify every record — nothing was written"
            : `${ids.length} record(s) could not be read back — nothing was written`
      return `${head}${named}${why}`
    }
    // Two records Monad registered disagree with each other — that throw names the lineage and
    // the record ids, so the line short-forms them and asks the owner to report a state the
    // chain should never produce (ex-3 E-2). Every other export-inconsistent producer is the
    // unknown-enum throw — this version of mida meeting a value newer than it, not a chain
    // anomaly — so the line says plainly what mida does not recognise and names the fix:
    // update mida (ex-4 G-4). The chain is never blamed for it.
    case "export-inconsistent": {
      const detail = error as { lineage?: unknown; contextIds?: unknown; unknownField?: unknown; unknownValue?: unknown }
      const ids = (Array.isArray(detail.contextIds) ? detail.contextIds : []).filter((id): id is string => typeof id === "string")
      const shortId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`
      if (typeof detail.lineage === "string" && ids.length === 2) {
        return `the export found a chain state that should be impossible on Monad — lineage ${shortId(detail.lineage)} holds two records claiming the same parent — ${shortId(ids[0]!)} and ${shortId(ids[1]!)}; please report it`
      }
      const field = typeof detail.unknownField === "string" ? `${detail.unknownField} ` : ""
      const value =
        typeof detail.unknownValue === "number" || typeof detail.unknownValue === "bigint" ? ` (${String(detail.unknownValue)})` : ""
      const who = typeof ids[0] === "string" ? `record ${shortId(ids[0])}` : "a record"
      return `${who} carries a ${field}value${value} this version of mida does not recognise — update mida and run the export again`
    }
    case "chain-busy":
      return partway === undefined
        ? "Monad is busy right now — nothing was sent or decided; wait a moment and run the same command again"
        : `Monad is busy right now — ${partway}`
    // Not busy — a setup the owner must fix: the RPC answered but the configured address held
    // no Mida contract, or the provider refused the credential (in-11 R-8).
    case "chain-misconfigured":
      return partway === undefined
        ? "the RPC answered but found no Mida contract — check MONAD_TESTNET_RPC or this setup's network.json; nothing was sent or decided"
        : `the RPC answered but found no Mida contract — check MONAD_TESTNET_RPC or this setup's network.json; ${partway}`
    case "rpc-auth":
      return partway === undefined
        ? "the RPC provider refused the key — check the provider URL in MONAD_TESTNET_RPC or network.json; nothing was sent or decided"
        : `the RPC provider refused the key — check the provider URL in MONAD_TESTNET_RPC or network.json; ${partway}`
    // The same failures when the STORE reported them: whose RPC broke is the store's, so the
    // advice names the store operator, not this setup's MONAD_TESTNET_RPC (in-12 N-8).
    case "store-misconfigured":
      return partway === undefined
        ? "the store's connection to Monad is misconfigured — the store operator must fix it; nothing was sent or decided"
        : `the store's connection to Monad is misconfigured — the store operator must fix it; ${partway}`
    case "store-rpc-auth":
      return partway === undefined
        ? "the store's RPC key was refused — the store operator must fix it; nothing was sent or decided"
        : `the store's RPC key was refused — the store operator must fix it; ${partway}`
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
    // The export block above normally returns first; this is the refusal a reorder must keep —
    // a passkey home holds no local owner key, so there is nothing to decrypt with here.
    if (command === "export") {
      deps.print("export supports software-key setups only in this version")
      return 1
    }
    if (command === "batching") {
      // the switch needs no owner signature — it only rewrites a flag in network.json — so a
      // passkey home runs it on a secret-less session like the agent-facing commands
      const session = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
      try {
        session.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
        return await runBatching(session, argv[1], deps)
      } finally {
        await session.close()
      }
    }
    if (command === "sponsor") {
      // same story as batching: the switch only edits network.json, no owner signature — a
      // passkey home's gas payer is decided by that file too, so the command applies
      const session = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
      try {
        session.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
        return await runSponsor(session, argv[1], deps)
      } finally {
        await session.close()
      }
    }
    if (command === "install") {
      const tool = argv[1] ?? ""
      // devin too (in-9): the hook tool's install is where its identity comes from now.
      if (argv.length !== 2 || !(MCP_CLIENT_TOOLS.includes(tool) || tool === "devin")) {
        deps.print(USAGE)
        return 2
      }
      // registering a project-context agent needs no passkey round — the operator carries the
      // manifest — so install is one provision pass, exactly like the software path's init call
      const installSession = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
      try {
        installSession.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
        await provisionPasskeyAgents(installSession, [tool], linkDeps)
        if (!deps.home.has(`agents/${tool}/pending-request.json`)) {
          try {
            await requestAccess(installSession, tool)
          } catch (error) {
            if (refusalCode(error) !== "already-approved") throw error
          }
        }
        if (tool === "devin") {
          const outcome = installDevin(deps.devinConfig ?? resolveDevinConfigPath(process.env, homedir()))
          deps.print(outcome === "already-installed" ? "already installed" : "installed")
          deps.print(`next: run \`mida approve devin\` in this folder`)
          return 0
        }
        const client = tool as McpClientTool
        const cwd = deps.cwd ?? process.cwd()
        const configPath = client === "cursor"
          ? cursorMcpConfigPath(cwd)
          : deps.claudeDesktopConfig ?? claudeDesktopConfigPath(homedir())
        const outcome = installMcpClient(client, configPath, deps.home.root, cwd)
        if (typeof outcome === "object") {
          deps.print("installed")
          deps.print(`the ${MCP_SERVER_NAME[client]} entry moved from ${outcome.moved.from} to ${outcome.moved.to}`)
        } else {
          deps.print(outcome === "already-installed" ? "already installed" : "installed")
        }
        if (client === "cursor") deps.print("heads-up: .cursor/mcp.json holds absolute paths from this machine — do not commit it")
        const protectedNote = macosProtectedFolderNote(
          client,
          deps.launcherPath ?? mcpLauncherPath(),
          deps.homeDir ?? homedir(),
          deps.platform ?? process.platform,
        )
        if (protectedNote !== undefined) deps.print(protectedNote)
        deps.print(`next: run \`mida approve ${client}\` in this folder`)
        return 0
      } finally {
        await installSession.close()
      }
    }
    if (command === "add-agent") {
      const check = addAgentCheck(deps.home, argv)
      if (check.kind === "usage") {
        deps.print(USAGE)
        return 2
      }
      if (check.kind === "refused") {
        deps.print(check.line)
        return 1
      }
      deps.print(`add-agent ${check.name}: registers a new project-context identity on chain — the same provision pass \`mida init --passkey\` runs per agent`)
      const drain = deps.drainInput ?? drainBufferedStdin
      const prompt = deps.prompt ?? terminalPrompt
      await drain()
      if ((await prompt(`Type yes to add ${check.name}: `)).trim() !== "yes") {
        deps.print("not approved")
        return 1
      }
      // registering a project-context agent needs no passkey round — the operator carries the
      // manifest — so add-agent is one provision pass on a secret-less session, exactly like
      // the install path above
      const addSession = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
      try {
        addSession.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
        const agents = await provisionPasskeyAgents(addSession, [check.name], linkDeps)
        deps.print(`added ${check.name} ${agents[check.name]}`)
        deps.print(`next: the agent files its own access request — run \`mida request ${check.name}\` or let its integration call requestAccess(), then \`mida approve ${check.name}\` in a project folder`)
        return 0
      } finally {
        await addSession.close()
      }
    }
    const agent = argv[1] ?? ""
    if (agent !== "--all" && !AGENTS.includes(agent) && !listAgentNames(deps.home).includes(agent)) {
      deps.print(USAGE)
      return 2
    }
    const session = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
    try {
      session.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
      if (command === "approve" && agent === "--all") {
        if (argv.length !== 2) {
          deps.print(USAGE)
          return 2
        }
        return await passkeyApproveAll(session, deps, linkDeps)
      }
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
      } else if (command === "revoke" && agent === "--all") {
        if (argv.length !== 2) {
          deps.print(USAGE)
          return 2
        }
        return await passkeyRevokeAll(session, deps, linkDeps)
      } else {
        const result = await revokePasskey(session, agent, linkDeps)
        deps.print(
          result.nothingToRevoke || result.transactionHashes.length === 0
            ? "nothing to revoke"
            : `revoked ${agent} on chain — tx ${result.transactionHashes.join(" ")}`,
        )
        if (!result.nothingToRevoke && result.transactionHashes.length > 0) {
          deps.print(`This stops future reads through Mida. It does not erase what ${agent} already read.`)
        }
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
    deps.print(ownerRefusalLine(command, argv[1] ?? "", error, undefined, deps.network.deployment.capabilityRegistry, deps.home))
    if (process.env.MIDA_DEBUG === "1") {
      deps.print(debugLine(error))
    }
    return 1
  }
}

/**
 * `mida approve --all` on a passkey home: the same combined list and one terminal yes as the
 * software path, then ONE owner-link round per agent — the passkey is asked once per signature
 * and never once for the batch. A declined or failed agent names itself and the next still runs.
 */
async function passkeyApproveAll(session: ServiceRuntime, deps: CliDeps, linkDeps: PasskeyDeps): Promise<number> {
  // The marker resolves before the list, as in software mode: a folder that may not hold a
  // project refuses here, before any signature — and it decides which live-grant agents still
  // need this folder's row (AUTH-15).
  const marker = deps.cwd === undefined ? undefined : ensureProjectMarker(deps.cwd)
  const batch = await batchAgents(session, marker)
  if (!batch.some((agent) => agent.kind !== "noperm")) {
    for (const { name, kind } of batch) {
      if (kind === "noperm") deps.print(`${name}: no permission yet — run \`mida request ${name}\` first`)
    }
    deps.print(
      marker === undefined
        ? "nothing to approve — no agent has a pending request"
        : "nothing to approve — every agent with permission is already approved for this folder",
    )
    return 0
  }
  // One combined preview in agent order, same as software mode: a pending request shows its
  // ask, a live grant its folder line, a no-permission agent its fix — never a failure.
  const agents: string[] = []
  const gainingFolder: string[] = []
  for (const { name, kind } of batch) {
    if (kind === "noperm") {
      deps.print(`${name}: no permission yet — run \`mida request ${name}\` first`)
      continue
    }
    if (kind === "folder") {
      deps.print(`${name} already holds a live grant; this lists it for project ${marker!.projectId} (this folder)`)
      agents.push(name)
      gainingFolder.push(name)
      continue
    }
    printPendingAsk(deps, session.home, name, marker?.projectId)
    agents.push(name)
  }
  deps.print("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
  // same N2 summary as the software path — the live-grant sweep is named above the yes
  if (gainingFolder.length > 0) {
    deps.print(`${gainingFolder.length} agent${gainingFolder.length === 1 ? "" : "s"} will gain this folder: ${gainingFolder.join(", ")}`)
  }
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  await drain()
  if ((await prompt("Type yes to approve all: ")).trim() !== "yes") {
    deps.print("not approved")
    return 1
  }
  const approved: string[] = []
  const failed: string[] = []
  for (const name of agents) {
    try {
      const result = await approvePasskey(session, name, deps.cwd, linkDeps)
      approved.push(name)
      deps.print(
        result.listOnly
          ? result.projectAlreadyListed === true
            ? `${name} is already approved on chain. This folder was already approved for ${name}.`
            : `${name} is already approved on chain. This folder is now approved for ${name} too (no transaction).`
          : `approved ${name} via your passkey — tx ${result.transactionHashes.join(" ")}`,
      )
    } catch (error) {
      // A page outcome already IS the line the owner reads; a coded error goes through the mapper.
      deps.print(error instanceof OwnerLinkOutcome ? error.line : ownerRefusalLine("approve", name, error, undefined, deps.network.deployment.capabilityRegistry, session.home))
      failed.push(`${name} (${error instanceof OwnerLinkOutcome ? error.kind : refusalCode(error)})`)
    }
  }
  if (approved.length > 0 && failed.length > 0) await kickDaemonNow(deps)
  deps.print(`approved: ${approved.length === 0 ? "none" : approved.join(", ")}${failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`}`)
  return failed.length === 0 ? 0 : 1
}

/**
 * `mida revoke --all` on a passkey home: the approved agents are listed, one terminal yes confirms
 * the batch, then ONE owner-link round per agent — the passkey is asked once per revocation and
 * never once for the batch. A declined or failed agent names itself and the next still runs.
 */
async function passkeyRevokeAll(session: ServiceRuntime, deps: CliDeps, linkDeps: PasskeyDeps): Promise<number> {
  const scan = await approvedAgents(session)
  if (scan.held.length === 0 && scan.unidentifiable.length === 0) {
    deps.print("nothing to revoke — no agent in this Mida home holds an approval")
    return 0
  }
  for (const name of scan.held) deps.print(`${name} holds an approval`)
  const failed: string[] = []
  for (const { name, error } of scan.unidentifiable) {
    deps.print(ownerRefusalLine("revoke", name, error, undefined, deps.network.deployment.capabilityRegistry, session.home))
    failed.push(`${name} (${refusalCode(error)})`)
  }
  const revoked: string[] = []
  if (scan.held.length === 0) {
    deps.print(`revoked: none; failed: ${failed.join(", ")}`)
    return 1
  }
  const prompt = deps.prompt ?? terminalPrompt
  const drain = deps.drainInput ?? drainBufferedStdin
  await drain()
  if ((await prompt("Type yes to revoke all: ")).trim() !== "yes") {
    deps.print("not revoked")
    return 1
  }
  for (const name of scan.held) {
    try {
      const result = await revokePasskey(session, name, linkDeps)
      if (result.nothingToRevoke || result.transactionHashes.length === 0) {
        deps.print(`${name}: nothing to revoke`)
      } else {
        revoked.push(name)
        deps.print(`revoked ${name} on chain — tx ${result.transactionHashes.join(" ")}`)
      }
      if (!result.nothingToRevoke && result.transactionHashes.length > 0) {
        deps.print(`This stops future reads through Mida. It does not erase what ${name} already read.`)
      }
      for (const other of result.rewrapped) deps.print(`new read key sent to ${other}`)
    } catch (error) {
      // A page outcome already IS the line the owner reads; a coded error goes through the mapper.
      deps.print(error instanceof OwnerLinkOutcome ? error.line : ownerRefusalLine("revoke", name, error, undefined, deps.network.deployment.capabilityRegistry, session.home))
      failed.push(`${name} (${error instanceof OwnerLinkOutcome ? error.kind : refusalCode(error)})`)
    }
  }
  if (revoked.length > 0 && failed.length > 0) await kickDaemonNow(deps)
  deps.print(`revoked: ${revoked.length === 0 ? "none" : revoked.join(", ")}${failed.length === 0 ? "" : `; failed: ${failed.join(", ")}`}`)
  return failed.length === 0 ? 0 : 1
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
        progress: deps.progress ?? ((line) => process.stderr.write(`${line}\n`)),
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
      // Same refusal surface as every other owner command — a chain failure prints the
      // honest chain-busy/misconfigured line, never a provider message (ex-2 X-3).
      deps.print(ownerRefusalLine("migrate", "", error, undefined, deps.network.deployment.capabilityRegistry, deps.home, argv[1] === "--undo"))
      if (process.env.MIDA_DEBUG === "1") deps.print(debugLine(error))
      return 1
    }
  }
  // export is an owner command that opens the owner runtime itself: it decrypts every record the
  // chain attributes to the owner, so a passkey home (which holds no local owner key) refuses,
  // and it is never sent to the daemon socket — a daemon answer would mean an agent asked.
  if (command === "export") {
    // `--as` anywhere on the line means an agent tried to drive the owner's own command.
    if (argv.includes("--as")) {
      deps.print("export is the owner's own command — agents never export")
      return 1
    }
    if (argv.length !== 2) {
      deps.print(USAGE)
      return 2
    }
    try {
      const result = await exportRecords({
        home: deps.home,
        network: deps.network,
        folder: argv[1]!,
        cwd: deps.cwd ?? process.cwd(),
        print: deps.print,
        progress: deps.progress ?? ((line) => process.stderr.write(`${line}\n`)),
        now: () => new Date(),
      })
      return result.outcome === "refused" ? 1 : 0
    } catch (error) {
      deps.print(ownerRefusalLine("export", "", error, undefined, deps.network.deployment.capabilityRegistry, deps.home))
      if (process.env.MIDA_DEBUG === "1") deps.print(debugLine(error))
      return 1
    }
  }
  // The folder commands (lk-1) are local work — link and unlink re-sign only the owner-signed
  // list, project new writes only a marker — so they run before the runtime opens and never
  // reach the chain. A passkey home cannot sign the list (the page's sign path carries a
  // different shape), so link and unlink refuse plainly there; project new signs nothing and
  // runs on either home.
  if (command === "link" || command === "unlink" || command === "project") {
    if (command !== "project" && loadOwnerMode(deps.home) === "passkey") {
      deps.print(`${command} is not available with a passkey owner yet`)
      return 2
    }
    const code = await runFolderCommand(argv, deps)
    if (code === 0 && command !== "project") {
      await Promise.resolve(deps.kickDaemon ? deps.kickDaemon() : callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 })).catch(() => {})
    }
    return code
  }
  const mode = loadOwnerMode(deps.home)
  const passkeyInit = command === "init" && argv[1] === "--passkey"
  // init on a setup saved to another contract refuses before the runtime even opens — the
  // file is never rewritten; only `mida migrate` may move it. Covers software and passkey
  // init alike (initPasskey keeps the same check internally for direct callers).
  if (command === "init" && deps.resolvedNetwork?.mismatch !== undefined) {
    const mismatch = deps.resolvedNetwork.mismatch
    deps.print(ownerRefusalLine(command, argv[1] ?? "", deploymentMismatchError(mismatch.saved, mismatch.builtIn), undefined, undefined, deps.home))
    return 1
  }
  if (OWNER_COMMANDS.includes(command) && (mode === "passkey" || passkeyInit)) {
    const code = await runPasskeyOwnerCommand(argv, deps, mode)
    if (code === 0 && (command === "approve" || command === "revoke" || command === "batching")) {
      await Promise.resolve(deps.kickDaemon ? deps.kickDaemon() : callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 })).catch(() => {})
    }
    if (code === 0 && command === "sponsor") await finishSponsorChange(deps)
    return code
  }
  if (mode === "passkey") {
    // The agent-facing commands on a passkey home: the same ServiceRuntime the daemon uses —
    // read surface only, no owner material anywhere in the process.
    let session: ServiceRuntime
    try {
      session = await ServiceRuntime.openOwnerSession(deps.home, deps.network)
    } catch (error) {
      deps.print(ownerRefusalLine(command, argv[1] ?? "", error, undefined, deps.network.deployment.capabilityRegistry, deps.home))
      return 1
    }
    try {
      session.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
      return await runCliWithRuntime(argv, session, deps.print, { cwd: deps.cwd, task: (deps.env ?? process.env).MIDA_TASK })
    } finally {
      await session.close()
    }
  }
  const runtime = await Runtime.open(deps.home, deps.network)
  try {
    // Owner-command narration goes to STDERR by default: `print` output keeps its exact shape.
    runtime.progress = deps.progress ?? ((line) => process.stderr.write(`${line}\n`))
    const command = argv[0]!
    if (!OWNER_COMMANDS.includes(command)) {
      return await runCliWithRuntime(argv, runtime, deps.print, { cwd: deps.cwd, task: (deps.env ?? process.env).MIDA_TASK })
    }
    const code = await runOwnerCommand(argv, runtime, deps)
    if (code === 0 && (command === "approve" || command === "revoke" || command === "batching")) {
      await Promise.resolve(deps.kickDaemon ? deps.kickDaemon() : callDaemon(deps.home, "/kick", {}, { timeoutMs: 2_000 })).catch(() => {})
    }
    if (code === 0 && command === "sponsor") await finishSponsorChange(deps)
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
  deps: {
    print: (line: string) => void
    claudeSettings: string
    codexConfig: string
    home: MidaHome
    cwd?: string
    claudeDesktopConfig?: string
    devinConfig?: string
    /** Claude Code's MCP servers live in ~/.claude.json — owned by Claude Code, read only for the is-it-ours check. */
    claudeUserConfig?: string
    /** The claude binary invocation — injected in tests; the real spawnSync by default. */
    claudeCli?: ClaudeCliRunner
  },
): number {
  const tool = argv[1] ?? ""
  // --no-mcp is an install flag: it names exactly what it skips. On uninstall there is nothing
  // to skip — the entry goes with the hooks — so the flag is usage there. For the MCP-only
  // clients the server IS the whole install, so skipping it makes the command do nothing:
  // usage too, and it must be named before the owner-command check claims a different reason.
  const noMcp = argv.length === 3 && argv[2] === "--no-mcp"
  if (!INSTALL_TOOLS.includes(tool) || (argv.length !== 2 && !(argv[0] === "install" && noMcp)) || (noMcp && MCP_CLIENT_TOOLS.includes(tool))) {
    deps.print(USAGE)
    return 2
  }
  // An install that registers an identity is an owner command (main routes it there): the MCP
  // clients' identities, and — since in-9 — devin's, which init no longer provisions by default.
  if (argv[0] === "install" && (MCP_CLIENT_TOOLS.includes(tool) || tool === "devin")) {
    deps.print(`mida install ${tool} is an owner command — run it in your own terminal`)
    return 2
  }
  // An MCP client is not a hook tool: its uninstall only removes Mida's entry from the client's
  // MCP config; the identity and its approvals are untouched either way.
  if (MCP_CLIENT_TOOLS.includes(tool)) {
    const client = tool as McpClientTool
    const cwd = deps.cwd ?? process.cwd()
    const configPath = client === "cursor"
      ? cursorMcpConfigPath(cwd)
      : deps.claudeDesktopConfig ?? claudeDesktopConfigPath(homedir())
    try {
      const outcome = uninstallMcpClient(client, configPath, deps.home.root)
      deps.print(outcome === "not-installed" ? "not installed" : outcome)
      if (outcome === "uninstalled") {
        deps.print(`the ${client} identity and its approvals are unchanged — \`mida revoke ${client}\` revokes access`)
      }
      return 0
    } catch (error) {
      deps.print(`refused: ${refusalCode(error)}`)
      return 1
    }
  }
  // uninstall codex edits the config under the Codex home install RECORDED — the shell's
  // CODEX_HOME may be a different folder entirely by now, and editing that would report
  // "not installed" while the managed block stays in place and the record clears anyway.
  const settingsPath =
    tool === "claude-code"
      ? deps.claudeSettings
      : tool === "devin"
        ? (deps.devinConfig ?? resolveDevinConfigPath(process.env, homedir()))
        : argv[0] === "uninstall" && recordedCodexHome(deps.home) !== undefined
          ? join(recordedCodexHome(deps.home)!, "config.toml")
          : deps.codexConfig
  const run =
    argv[0] === "install"
      ? (p: string) => (tool === "claude-code" ? installClaudeCode(p) : tool === "devin" ? installDevin(p) : installCodex(p, { home: deps.home.root, mcp: !noMcp }))
      : (p: string) => (tool === "claude-code" ? uninstallClaudeCode(p) : tool === "devin" ? uninstallDevin(p) : uninstallCodex(p))
  // the trust reminder answers "did the hook command lines change", not "did the file" — the
  // block's hook lines are snapshotted before the write and compared after (in-28b N-1)
  const codexHooksBefore = argv[0] === "install" && tool === "codex" ? codexHookCommands(settingsPath) : undefined
  try {
    const outcome = run(settingsPath)
    // Claude Code's MCP servers live in ~/.claude.json, which only the claude CLI may write —
    // the userConfig read is the is-it-ours check, never an edit. Codex's table needs no
    // extra step here: it rides inside the managed block installCodex wrote. The MCP step
    // runs before the summary line so a refused MCP step never sits under a bare "installed".
    let mcp: ReturnType<typeof installClaudeCodeMcp> | ReturnType<typeof uninstallClaudeCodeMcp> | undefined
    if (tool === "claude-code") {
      const claudeOpts = {
        home: deps.home.root,
        userConfig: deps.claudeUserConfig ?? claudeUserConfigPath(process.env, homedir()),
        run: deps.claudeCli ?? spawnClaude,
      }
      if (argv[0] === "install" && !noMcp) mcp = installClaudeCodeMcp(claudeOpts)
      if (argv[0] === "uninstall") mcp = uninstallClaudeCodeMcp(claudeOpts)
    }
    // the summary says changed when the hooks OR the MCP step changed something — a hooks-only
    // install followed by a full one prints installed because the MCP half changed (in-28b F-4)
    const changed = outcome === "installed" || outcome === "uninstalled" || mcp === "installed" || mcp === "uninstalled"
    deps.print(changed ? (argv[0] === "install" ? "installed" : "uninstalled") : outcome === "not-installed" ? "not installed" : "already installed")
    if (mcp === "unavailable") {
      deps.print(
        argv[0] === "install"
          ? "claude-code: MCP server not added. The claude command is not on your PATH; hooks are installed."
          : "claude-code: MCP server not removed. The claude command is not on your PATH.",
      )
    }
    if (typeof mcp === "object") {
      deps.print(`claude-code: an MCP server named mida for another Mida home (${mcp.otherHome}) was left in place. Remove it with claude mcp remove -s user mida.`)
    }
    if (argv[0] === "install" && tool === "codex") {
      // the hook and the drain never see Codex's own environment — the home install wrote into
      // is recorded so <CODEX_HOME>/sessions becomes a trusted transcript root. When the record
      // moves, the owner is told which home stops being trusted (F8).
      const previous = recordedCodexHome(deps.home)
      const resolved = resolveCodexHome(process.env, homedir())
      recordCodexHome(deps.home, resolved)
      if (previous !== undefined && previous !== resolved) {
        deps.print(`the Codex home moved: ${previous} is no longer trusted — rollouts under it are not read`)
      }
      // the reminder follows the hook commands, not the write: an MCP-only upgrade or a new
      // MIDA_HOME rewrites the block while leaving the commands Codex fingerprinted intact
      if (!isDeepStrictEqual(codexHooksBefore, codexHookCommands(settingsPath))) deps.print(CODEX_TRUST_SENTENCE)
    }
    if (argv[0] === "uninstall" && tool === "codex") {
      // the record clears only after the edit under the recorded home ran — a refused config
      // keeps it, because the trust the record describes was never lifted
      clearCodexHome(deps.home)
    }
    return 0
  } catch (error) {
    deps.print(`refused: ${refusalCode(error)}`)
    if (error instanceof InstallRefusal) deps.print(error.message)
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
  // `install <client>` and `install devin` are the exception: they register the tool's identity
  // on the chain (in-9: devin's install is its provision pass), so they fall through to the
  // owner commands like approve. `install devin --no-mcp` is that same provisioning install
  // with the server step skipped — it belongs on the owner path too (in-28b).
  const installProvisionsIdentity =
    (argv.length === 2 && (MCP_CLIENT_TOOLS.includes(argv[1] ?? "") || argv[1] === "devin")) ||
    (argv.length === 3 && argv[1] === "devin" && argv[2] === "--no-mcp")
  if (argv[0] === "uninstall" || (argv[0] === "install" && !installProvisionsIdentity)) {
    // the real settings paths are built here and only here — tests always pass their own
    process.exitCode = runInstall(argv, {
      print,
      claudeSettings: join(homedir(), ".claude", "settings.json"),
      codexConfig: join(resolveCodexHome(process.env, homedir()), "config.toml"),
      home,
      claudeDesktopConfig: claudeDesktopConfigPath(homedir()),
      devinConfig: resolveDevinConfigPath(process.env, homedir()),
    })
    return
  }

  if (argv[0] === "doctor") {
    const settings = {
      "claude-code": join(homedir(), ".claude", "settings.json"),
      // doctor checks the home install recorded — a CODEX_HOME exported since must not
      // redirect the check away from where the hooks actually live (F8)
      codex: join(trustedCodexHome(home, process.env, homedir()), "config.toml"),
      // the check itself is silent when ~/.config/devin does not exist — Devin is
      // simply not installed there and earns no line
      devin: resolveDevinConfigPath(process.env, homedir()),
    }
    if (argv[1] === "--live") {
      const tool = argv[2] ?? ""
      if (argv.length !== 3 || !HOOK_TOOLS.includes(tool)) {
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

  // `link`, `unlink` and `project new` sign only local owner data — the chain probe would fail
  // them on a machine with no RPC reachable, so for them the resolution stays file-only
  // (in-16 B6): the saved setup's contract still fills deps.network for any refusal line.
  const folderOnly = argv[0] === "link" || argv[0] === "unlink" || argv[0] === "project"
  const resolved = await networkForCommand(home, process.env, folderOnly ? { probeChainId: false } : undefined)

  // Owner commands — init, approve, revoke, remember — run in this process on the owner
  // runtime and are never sent to the daemon socket. `init` still spawns the daemon when one
  // is not already running; the others reuse a live daemon's Context API or start their own.
  if (OWNER_COMMANDS.includes(argv[0] ?? "")) {
    // A setup saved on another contract still works — the saved contract is where its data
    // lives — but the owner is told, on stderr so the command's stdout keeps its shape. The
    // line is command-aware: migrate hears what it is moving, not "run mida migrate".
    const notice = ownerCommandNotice(resolved, argv[0] ?? "")
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
    print(ensured.refusal ?? "midad did not start; run mida doctor")
    process.exitCode = 1
    return
  }
  if (ensured.replaced !== undefined) {
    // the service that answered was running other code and has been shut down and restarted —
    // say so on stderr so the command's stdout keeps its shape
    process.stderr.write(`restarted the Mida service (it was running code from ${ensured.replaced.codeRoot} @ ${ensured.replaced.codeCommit.slice(0, 7)})\n`)
  }
  const reply = await callDaemon(
    home,
    "/cli",
    { argv, cwd: process.cwd(), debug: process.env.MIDA_DEBUG === "1", task: process.env.MIDA_TASK },
    { timeoutMs: CLI_CALL_TIMEOUT_MS },
  )
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
// while import.meta.url is the real file, so the comparison must run on realpaths — .native on
// both, since either side can carry the case the path was typed in (in-6 R6).
const invoked =
  process.argv[1] !== undefined &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
if (invoked) {
  main().catch((error: unknown) => {
    const e = error as { message?: unknown }
    console.error(`mida: ${typeof e.message === "string" ? e.message : String(error)}`)
    process.exitCode = 1
  })
}
