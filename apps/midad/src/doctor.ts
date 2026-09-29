import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { spawn } from "node:child_process"
import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { decodeUint64, isMidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { chainFor, rpcTransport } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { REQUEST_LIFETIME_SECONDS } from "@mida/sdk"
import { COMPILE_PROVIDERS, compileModelChoice, devinSqliteAvailable } from "@mida/compiler"
import { ContextApiClient, DenyOverlay, RegistryReader, StoreHttpError } from "@mida/api"
import type { RevocationTarget } from "@mida/api"
import type { LocalAccount } from "viem"
import { RESUBMIT_LANE_CLOSED, batchClient, batchStatusProbe, decideLane, pendingAnchors, pendingPlaintextPath, rejectedAnchors } from "./batching.js"
import type { Lane, PendingAnchor } from "./batching.js"
import { laneWhyText, resubmitStuckText } from "./batching.js"
import { callDaemon, socketPathFor } from "./control.js"
import { codeIdentity } from "./code-identity.js"
import type { MidaHome } from "./home.js"
import { DEVIN_NODE_SQLITE_MIN } from "./devin-facts.js"
import { drainerEnv } from "./hook.js"
import { sessionWaits } from "./drain.js"
import { CODEX_TRUST_SENTENCE, claudeCodeMcpStatus, claudeDesktopConfigPath, claudeHooksStatus, claudeUserConfigPath, codexHooksStatus, codexMcpStatus, cursorMcpConfigPath, devinHooksStatus, installedMcpLauncherPath, macosProtectedFolderNote, midaCommandsInClaudeSettings, midaCommandsInCodexConfig, midaCommandsInDevinConfig, parseMidaCommand } from "./install.js"
import type { InstallTool, McpClientTool } from "./install.js"
import { isRevoked, listAgentNames, loadAgentIdentity, loadOwnerAddress, loadOwnerMode, loadOwnerPublicKey } from "./keys.js"
import type { OwnerMode } from "./keys.js"
import { approvalsFileStatus, readApprovalsFile } from "./projects.js"
import { listJobs } from "./queue.js"
import { HOSTED_SPONSOR_URL, HOSTED_STORAGE_URL, MIN_BALANCE_WEI, formatMon, liveLockHolderPid, serviceUrlInEffect, sponsorReachable } from "./runtime.js"
import { mismatchLine, readSavedNetwork, resolveNetwork } from "./network.js"
import type { ResolvedNetwork, SavedNetwork, ServiceSource } from "./network.js"
import { cliPackageName, isBundled, siblingEntryArgs, siblingEntryPath } from "./sibling.js"
import { folderTaskFor } from "./task.js"

/** The whole run is capped — a check may stall, the report may not. */
const RUN_CAP_MS = 20_000
/** How long the /health probe waits before declaring the daemon down. */
const DAEMON_PROBE_MS = 1_000
/** `doctor --live` waits this long for the SessionStart handoff to reach the daemon log. */
const LIVE_WATCH_MS = 60_000

export interface DoctorDeps {
  home: MidaHome
  print(line: string): void
  /** Each tool's real config path — built only inside cli.ts main(); tests pass temp paths. */
  settings?: Partial<Record<InstallTool, string>>
  /**
   * Each MCP client's config path for the protected-folder note (in-15 J-7). Defaults: Claude
   * Desktop's account-level config under `homeDir`, Cursor's `.cursor/mcp.json` under `cwd`.
   */
  mcpConfigs?: Partial<Record<McpClientTool, string>>
  /** Claude Code's user-level MCP list (~/.claude.json) — read only; the claude CLI writes it. */
  claudeUserConfig?: string
  /** The account home and OS platform the protected-folder note is judged on — tests inject both. */
  homeDir?: string
  platform?: NodeJS.Platform
  /** Where Cursor's `.cursor/mcp.json` is looked for; default process.cwd(). */
  cwd?: string
  /** Shell environment for the API-key check; default process.env. Values are never printed. */
  env?: NodeJS.ProcessEnv
  /** node:sqlite probe for the devin check — injectable since a test cannot uninstall a builtin. */
  devinSqliteAvailable?: () => boolean
  now?: () => number
  /** /health probe timeout; default 1 s. */
  daemonProbeMs?: number
  /** Whole-run cap; default 20 s. */
  capMs?: number
  /**
   * Asks the store where a pending batched save stands — the default is a signed
   * `getBatchSave` as the entry's own agent; null means "could not find out", which counts as
   * still waiting. Injectable so tests script the store's answer.
   */
  probeBatchSave?: (entry: PendingAnchor) => Promise<{ state: string; reason: string | null } | null>
}

interface DoctorLiveDeps extends DoctorDeps {
  /** Default: process.stdin.isTTY. Injected so the refusal is testable. */
  stdinIsTTY?: boolean
  /** SessionStart watch window; default 60 s. */
  watchMs?: number
  /** Starts the throwaway headless session; the default spawns the real tool. */
  startSession?: (tool: InstallTool, cwd: string) => { stop(): void }
}

/** What the chain checks need; built lazily once the network has been resolved. */
interface Shared {
  context?: ChainContext
  reader?: RegistryReader
  ownerAddress?: Address | "missing"
  /** Agents the "agents" check found live on chain — undefined until that check finished. */
  approved?: { name: string; agentId: Hex }[]
  /** The run's one resolveNetwork result — null once a resolution was tried and refused. */
  resolved?: ResolvedNetwork | null
}

const problem = (sentence: string, fix: string) => `PROBLEM: ${sentence} — ${fix}`
const INIT_FIX = "run `mida init`"
/** A batched save still QUEUED or SUBMITTED this long is a stuck-batch report, not a note. */
const STUCK_ANCHOR_MS = 10 * 60 * 1000

/** A thrown check becomes a PROBLEM line with a stable code — never a raw error message. */
function stableCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : "check-failed"
}

/** Races a check against the time left in the run cap; a timeout is a thrown check. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("the check timed out") as Error & { code: string }
      error.code = "check-timeout"
      reject(error)
    }, ms)
    if (typeof timer.unref === "function") timer.unref()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * The one resolveNetwork run for the whole report — every check resolves the network the same
 * way the command, the daemon and the drainer do, so doctor can never again answer about a
 * different contract than they would use. No chain-id probe: doctor measures the chain itself.
 * A refusal is cached as null so later checks do not re-resolve; they fall back to the raw file.
 */
async function resolveShared(deps: DoctorDeps, shared: Shared): Promise<ResolvedNetwork | undefined> {
  if (shared.resolved !== undefined) return shared.resolved ?? undefined
  try {
    const resolved = await resolveNetwork(deps.home, deps.env ?? process.env, { probeChainId: false })
    shared.resolved = resolved
  } catch {
    shared.resolved = null
  }
  return shared.resolved ?? undefined
}

function chainOf(shared: Shared): { context: ChainContext; reader: RegistryReader } | undefined {
  return shared.context === undefined || shared.reader === undefined ? undefined : { context: shared.context, reader: shared.reader }
}

/** The home's owner mode; a malformed mode.json reads as undefined here — the owner check names it. */
function ownerModeOf(home: MidaHome): OwnerMode | undefined {
  try {
    return loadOwnerMode(home)
  } catch {
    return undefined
  }
}

/**
 * The owner address — software homes derive it from the saved key, passkey homes from
 * owner-address.json. Read only, never created here.
 */
function ownerAddressOf(home: MidaHome): Address | "missing" {
  try {
    if (ownerModeOf(home) === "passkey") {
      try {
        return loadOwnerAddress(home) ?? "missing"
      } catch {
        return "missing"
      }
    }
    const secrets = home.readJson<Record<string, unknown>>("owner/secrets.json")
    const key = secrets?.privateKey
    if (typeof key !== "string" || !/^0x[0-9a-f]{64}$/.test(key)) return "missing"
    return privateKeyToAccount(key as Hex).address
  } catch {
    return "missing"
  }
}

const NEEDS_NETWORK = `needs network.json — ${INIT_FIX}`
const NEEDS_OWNER = `needs the owner key — ${INIT_FIX}`

/** The owner-fix line, mode-aware: a passkey home is repaired by the passkey init, not `mida init`. */
function needsOwner(home: MidaHome): string {
  return ownerModeOf(home) === "passkey" ? "needs the owner — run `mida init --passkey`" : NEEDS_OWNER
}

/** The owner signing key from the saved secrets — read only, never created here. */
function ownerAccountOf(home: MidaHome): LocalAccount | "missing" {
  try {
    const secrets = home.readJson<Record<string, unknown>>("owner/secrets.json")
    const key = secrets?.privateKey
    if (typeof key !== "string" || !/^0x[0-9a-f]{64}$/.test(key)) return "missing"
    return privateKeyToAccount(key as Hex)
  } catch {
    return "missing"
  }
}

/**
 * The service URLs a call would use right now — the run's shared resolveNetwork result, so the
 * checks and the services report cannot diverge again (M3-D6 item 3). Sources the rule reports:
 * the environment wins in both directions, then the saved file; a saved home that never stored
 * a service address resolves to "local" — this setup ran the local store and pays its own gas,
 * so nothing is probed and nothing is reported as hosted. Only a home with no file at all falls
 * through to "hosted-default". The default is a source, not a probe target: its effective URL
 * is undefined here and only the services check names it, as what a fresh init would use.
 *
 * When the shared resolution refuses (a network.json that is corrupt or missing fields) the
 * checks still answer from the raw file — a doctor that needed a valid deployment to name a
 * saved service would hide the one thing the file did record. That fallback keeps the old
 * "default" source for a file it cannot prove belongs to a working setup.
 */
interface DoctorService {
  /** The URL a call would use — undefined for "local", "off", and the hosted default. */
  url: string | undefined
  source: ServiceSource | "default"
}

async function doctorServices(
  deps: DoctorDeps,
  shared: Shared,
): Promise<{ storageUrl: string | undefined; sponsorUrl: string | undefined; storage: DoctorService; sponsor: DoctorService }> {
  const resolved = await resolveShared(deps, shared)
  if (resolved !== undefined) {
    const effective = (service: { url: string | undefined; source: ServiceSource }) =>
      service.source === "environment" || service.source === "network.json" ? service.url : undefined
    return {
      storageUrl: effective(resolved.storage),
      sponsorUrl: effective(resolved.sponsor),
      storage: resolved.storage,
      sponsor: resolved.sponsor,
    }
  }
  const env = deps.env ?? process.env
  let stored: { storageUrl?: unknown; sponsorUrl?: unknown } | undefined
  try {
    stored = deps.home.readJson("network.json")
  } catch {
    stored = undefined
  }
  const storage = serviceUrlInEffect(env.MIDA_STORAGE_URL, stored?.storageUrl, HOSTED_STORAGE_URL)
  const sponsor = serviceUrlInEffect(env.MIDA_SPONSOR_URL, stored?.sponsorUrl, HOSTED_SPONSOR_URL)
  return {
    storageUrl: storage.source === "default" ? undefined : storage.url,
    sponsorUrl: sponsor.source === "default" ? undefined : sponsor.url,
    storage,
    sponsor,
  }
}

/**
 * The entries this check resolves — the hooks install points the tools' settings at, plus the
 * MCP adapter, which no settings file carries: an MCP client launches it by absolute path from
 * its own config, so the same "the file the path names exists" check applies.
 */
const RESOLVED_ENTRIES = ["mida-hook", "mida-inject", "mida-mcp"] as const

/**
 * The fix for a hook binary that is not where install would point. Running from the npm
 * package, the answer is the global install — the package name comes from its own package.json
 * so nothing but publish/names.json hard-codes it. Running from the source tree a missing
 * entry means the repo itself is incomplete — nothing PATH can fix, because the hooks name
 * the file absolutely now.
 */
function hookCommandFix(): string {
  if (isBundled()) {
    const name = cliPackageName()
    return name === undefined ? "reinstall the mida CLI package globally" : `run \`npm i -g ${name}\``
  }
  return "restore the repository — the apps/midad sources are incomplete"
}

/** The HOST of a service URL — the path or query could carry an operator's key, so only the host is ever printed. */
export function hostOf(raw: string): string {
  try {
    const host = new URL(raw).host
    return host === "" ? "an address that does not parse" : host
  } catch {
    return "an address that does not parse"
  }
}

/** Every environment variable Mida reads — the environment check prints set/unset, never a value. */
const ENV_VARS = [
  "MIDA_HOME",
  "MIDA_STORAGE_URL",
  "MIDA_SPONSOR_URL",
  "MIDA_DEPLOYMENTS_DIR",
  "MIDA_DEBUG",
  "MIDA_COMPILE_MODEL",
  "MIDA_COMPILE_FALLBACK",
  "MIDA_COMPILE_API_KEY",
  "MIDA_COMPILE_BASE_URL",
  "MIDA_COMPILE_MODEL_ID",
  "MIDA_COMPILE_TIMEOUT_MS",
  "MIDA_CLAUDE_SETTINGS",
  "MIDA_CODEX_CONFIG",
  "MIDA_INNER",
  "MIDA_E2E_MONAD_TESTNET",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_TIMEOUT_MS",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "KIMI_MODEL",
  "KIMI_TIMEOUT_MS",
  "MONAD_TESTNET_RPC",
  "DEPLOYER_PRIVATE_KEY",
  "TESTNET_FUNDING_WEI",
  "FOUNDRY_BIN",
  "VAULT_RP_ID",
] as const

/** Is the file executable? The bundled hook bins are chmod 0755 at build time; anything less means a dead hook. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * What the hook commands a settings file carries resolve to — a PROBLEM line for each distinct
 * failure: a path that is gone or a program that lost its executable bit. A bare name is not
 * reported here — the "outdated" status line already names that fix. The path in the FILE is
 * checked, never PATH — that is the contract the absolute-path install bought (R5-7).
 */
function hookPathProblems(commands: string[] | "absent" | "unreadable", tool: InstallTool): string[] {
  if (!Array.isArray(commands)) return []
  const problems = new Set<string>()
  const reinstall = `run \`mida install ${tool}\``
  for (const command of commands) {
    const parsed = parseMidaCommand(command)
    if (parsed === null) continue
    for (const target of parsed.paths) {
      if (!isAbsolute(target.file)) continue
      if (!existsSync(target.file)) {
        problems.add(problem(`a ${tool} hook points at ${target.file}, which does not exist`, reinstall))
      } else if (target.executable && !isExecutable(target.file)) {
        problems.add(problem(`a ${tool} hook points at ${target.file}, which is not executable`, reinstall))
      }
    }
  }
  return [...problems]
}

/** One line per check, in the order the spec fixes. Each returns its lines; it never decides. */
function buildChecks(deps: DoctorDeps, shared: Shared): { name: string; run(): Promise<string[]> }[] {
  const home = deps.home
  return [
    {
      name: "daemon",
      run: async () => {
        const reply = await callDaemon(home, "/health", undefined, { timeoutMs: deps.daemonProbeMs ?? DAEMON_PROBE_MS })
        if (reply.status === 0) {
          // in-29 S-1 (Sep 29 item 14): the lock's pid alive while the socket does not answer —
          // with the socket file or the api-url.json a daemon left behind — is a RUNNING service
          // that cannot be reached, orphaned most often by an earlier start deleting its socket.
          // It must be stopped, not started over; "start the daemon" would orphan it again.
          const pid = liveLockHolderPid(home)
          if (pid !== undefined && (existsSync(socketPathFor(home)) || home.has("api-url.json"))) {
            return [`PROBLEM: the Mida service (pid ${pid}) is running but cannot be reached. Stop it with kill ${pid}, then run any mida command to start a fresh one.`]
          }
          return [problem("midad is not answering", "start the daemon")]
        }
        // any answer at all used to read as healthy — only 200 with { ok: true } is midad;
        // anything else is a problem that names the status it actually got
        const body = reply.body as { ok?: unknown; codeRoot?: unknown; codeCommit?: unknown } | null
        if (!(reply.status === 200 && body !== null && typeof body === "object" && body.ok === true)) {
          return [problem(`midad answered with status ${reply.status}, not ok:true`, "restart midad")]
        }
        // an answering midad must also be running THIS code — a service from another checkout
        // quietly serves agent commands with the wrong build
        const lines = ["ok: midad answers"]
        const self = codeIdentity()
        const codeRoot = typeof body.codeRoot === "string" ? body.codeRoot : undefined
        const codeCommit = typeof body.codeCommit === "string" ? body.codeCommit : undefined
        if (codeRoot === undefined || codeCommit === undefined) {
          lines.push(problem("midad predates code reporting", "run any mida command to replace it"))
        } else if (codeRoot === self.codeRoot && codeCommit === self.codeCommit) {
          lines.push(`ok: midad runs ${codeRoot} @ ${codeCommit.slice(0, 7)}; this command runs the same`)
        } else {
          lines.push(problem(`midad runs ${codeRoot} @ ${codeCommit.slice(0, 7)}; this command runs ${self.codeRoot} @ ${self.codeCommit.slice(0, 7)}`, "run any mida command to replace it"))
        }
        return lines
      },
    },
    {
      name: "network",
      run: async () => {
        let resolved: ResolvedNetwork
        try {
          resolved = await resolveNetwork(home, deps.env ?? process.env, { probeChainId: false })
        } catch (error) {
          shared.resolved = null
          const code = (error as { code?: unknown }).code
          // The operator pointed MIDA_DEPLOYMENTS_DIR at a different contract than the setup
          // saved — doctor names the conflict instead of picking a side.
          return code === "deployment-conflict"
            ? [problem("MIDA_DEPLOYMENTS_DIR names a different contract than this setup", "unset MIDA_DEPLOYMENTS_DIR")]
            : [problem("network.json is missing or unreadable", INIT_FIX)]
        }
        shared.resolved = resolved
        // The host only — an RPC URL's path or query can carry a provider's key, and doctor
        // output gets quoted into reports. This prints even when network.json is missing so a
        // first-time setup still sees which RPC a fixed home would use.
        const rpcLines = [`ok: chain RPC ${hostOf(resolved.network.rpcUrl)} (${resolved.rpcSource})`]
        if (resolved.rpcSource === "public default") {
          rpcLines.push(
            "note: the public Monad RPC allows about 15 requests a second; a provider URL in MONAD_TESTNET_RPC or network.json raises that",
          )
        }
        if (!resolved.saved) return [problem("network.json is missing or unreadable", INIT_FIX), ...rpcLines]
        shared.context = {
          publicClient: createPublicClient({ chain: chainFor(resolved.network.deployment.chainId), batch: { multicall: true }, transport: rpcTransport(resolved.network.rpcUrl) }),
          deployment: resolved.network.deployment,
        }
        shared.reader = new RegistryReader(shared.context)
        const short = (a: string) => `${a.slice(0, 6)}…`
        const lines = ["ok: network.json present", `contract ${short(resolved.network.deployment.capabilityRegistry)}`, ...rpcLines]
        // A saved contract that differs from this build's record is a note, not a problem —
        // the setup still works on the contract it saved.
        const note = mismatchLine(resolved)
        if (note !== undefined) lines.push(`note: ${note}`)
        return lines
      },
    },
    {
      name: "owner",
      run: async () => {
        const chain = chainOf(shared)
        if (chain === undefined) return [problem("the owner check cannot run", NEEDS_NETWORK)]
        if (ownerModeOf(home) === "passkey") {
          let owner: Address | undefined
          try {
            owner = loadOwnerAddress(home)
          } catch {
            return [problem("owner-address.json is unreadable", "run `mida init --passkey`")]
          }
          if (owner === undefined) return [problem("this passkey home has no owner yet", "run `mida init --passkey`")]
          shared.ownerAddress = owner
          const lines = [`ok: owner is a passkey (address ${owner}); no owner key on this machine`]
          const key = await chain.reader.ownerP256Key(owner)
          if (key === null) {
            lines.push(problem("the chain holds no passkey for this owner", "run `mida init --passkey`"))
          } else {
            // "matches" is claimed only against the point init recorded — an older home without
            // the field gets the weaker, honest line.
            const stored = loadOwnerPublicKey(home)
            if (stored !== undefined && (BigInt(stored.x) !== key.qx || BigInt(stored.y) !== key.qy)) {
              lines.push(problem("the passkey on chain is not the key this home registered", "the home and the chain disagree — set up a fresh MIDA_HOME with `mida init --passkey`"))
            } else {
              lines.push(stored === undefined ? "ok: owner passkey registered on chain" : "ok: owner passkey registered on chain (P-256 key matches)")
            }
          }
          lines.push("note: remember is not available with a passkey owner yet")
          return lines
        }
        const owner = ownerAddressOf(home)
        if (owner === "missing") return [problem("the owner key is missing", INIT_FIX)]
        shared.ownerAddress = owner
        const key = await chain.reader.ownerP256Key(owner)
        return key === null
          ? [problem("the owner is not registered on chain", INIT_FIX)]
          : ["ok: owner registered on chain"]
      },
    },
    {
      name: "agents",
      run: async () => {
        // Set before any early return: an empty array really means "nobody is approved", while
        // undefined (this check threw or never ran) tells the store-denies check it cannot say "ok".
        shared.approved = []
        const names = listAgentNames(home)
        if (names.length === 0) return [problem("no agents are set up", INIT_FIX)]
        const chain = chainOf(shared)
        const owner = shared.ownerAddress ?? ownerAddressOf(home)
        const lines: string[] = []
        for (const name of names) {
          const identity = loadAgentIdentity(home, name)
          if (chain === undefined) {
            lines.push(problem(`${name}'s grant cannot be checked`, NEEDS_NETWORK))
            continue
          }
          if (owner === "missing") {
            lines.push(problem(`${name}'s grant cannot be checked`, needsOwner(home)))
            continue
          }
          const ids = await chain.reader.activeCapabilityIds(owner, identity!.agentId)
          const views = (await Promise.all(ids.map((id) => chain.reader.getCapability(id)))).filter((v) => v !== null)
          const now = await chain.reader.now()
          const live = views.filter((v) => !v.revoked && (v.expiresAt === 0n || now < v.expiresAt))
          if (live.length > 0) {
            lines.push(`ok: ${name} approved`)
            shared.approved!.push({ name, agentId: identity!.agentId })
          } else if (views.length === 0 && isRevoked(home, name)) {
            // an agent-level revoke empties the live capability list entirely — the marker says it
            // was revoked, not that it never asked
            lines.push(problem(`${name}'s access was revoked`, `run \`mida request ${name}\` then \`mida approve ${name}\``))
          } else if (views.length === 0) {
            lines.push(
              !home.has(`agents/${name}/pending-request.json`)
                ? problem(`${name} has never asked for access`, `run \`mida request ${name}\` then \`mida approve ${name}\``)
                : pendingRequestExpired(home, name, now)
                  ? // an expired request cannot be approved — "run approve" sent the owner into
                    // REQUEST_EXPIRED; the fix starts with a fresh request (in-15 J-3)
                    problem(`${name}'s access request expired (requests last ${REQUEST_LIFETIME_SECONDS / 60n} minutes)`, `run \`mida request ${name}\`, then \`mida approve ${name}\` right away`)
                  : problem(`${name} asked but is not approved on chain`, `run \`mida approve ${name}\``),
            )
          } else if (views.some((v) => v.revoked)) {
            lines.push(problem(`${name}'s access was revoked`, `run \`mida request ${name}\` then \`mida approve ${name}\``))
          } else {
            const latest = views.reduce((max, v) => (v.expiresAt > max ? v.expiresAt : max), 0n)
            const date = new Date(Number(latest) * 1000).toISOString()
            lines.push(problem(`${name}'s grant expired ${date}`, `run \`mida request ${name}\` then \`mida approve ${name}\``))
          }
        }
        return lines
      },
    },
    {
      // M3-D4: the chain saying "approved" is only half the truth — a revoke that failed after its
      // deny was staged leaves the store refusing an agent the chain approves. One signed call
      // (or one read of the local store's own deny file) covers every approved agent.
      name: "store-denies",
      run: async () => {
        if (shared.approved === undefined) {
          return ["note: the agents check did not finish, so the store's deny list cannot be judged"]
        }
        if (shared.approved.length === 0) return ["ok: store blocks nobody who is approved"]
        const chain = chainOf(shared)
        if (chain === undefined) return [problem("the store's deny list cannot be checked", NEEDS_NETWORK)]
        const owner = shared.ownerAddress ?? ownerAddressOf(home)
        if (owner === "missing") return [problem("the store's deny list cannot be checked", needsOwner(home))]
        const storageUrl = (await doctorServices(deps, shared)).storageUrl
        let targets: RevocationTarget[]
        try {
          if (storageUrl !== undefined) {
            const account = ownerAccountOf(home)
            if (account === "missing") {
              // A passkey home holds no key that could sign this call — and needs none: the page
              // cancels stale denies inside its own approve ceremony. A note, not a problem.
              return ownerModeOf(home) === "passkey"
                ? ["note: the deny list is owner-authenticated — the passkey page clears stale denies during approve; this machine cannot read it"]
                : [problem("the store's deny list cannot be checked", needsOwner(home))]
            }
            const api = new ContextApiClient({
              baseUrl: storageUrl,
              account,
              chainId: chain.context.deployment.chainId,
              capabilityRegistry: chain.context.deployment.capabilityRegistry,
              // a hung store must not eat the run cap — two seconds, like the sponsor probe
              fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(2_000) }),
            })
            targets = (await api.listRevocations("active")).map((intent) => intent.target)
          } else {
            // No remote store: the local server's deny file IS the store's state — reading it
            // directly answers whether the daemon is up or down.
            const overlay = new DenyOverlay(home.path("data/revocations.json"))
            targets = (await overlay.list())
              .filter((intent) => intent.state === "active" && intent.owner === owner.toLowerCase())
              .map((intent) => intent.target)
          }
        } catch (error) {
          // A store that answered with a refusal is a fault, not an outage — name the code as a
          // problem; only a call that never got an answer earns the note.
          if (isMidaError(error)) {
            return [problem(`the store answered ${error.code} when asked for stale denies`, "re-run `mida doctor` — and if it repeats, the store's signed route is refusing the owner key")]
          }
          // a plain-text 404 means the deployed store has no revocations routes at all — the
          // same predates answer the store-write-check probe names (in-11 R-3). A StoreHttpError
          // can only come from the remote call above, so storageUrl is set here.
          if (error instanceof StoreHttpError && error.status === 404 && storageUrl !== undefined) {
            return [`note: the store at ${hostOf(storageUrl)} predates the pending-revoke check — redeploy the store to enable the pending-revoke check`]
          }
          return ["note: the store could not be reached, so stale denies could not be checked"]
        }
        const byAgentId = new Map(shared.approved.map((agent) => [agent.agentId.toLowerCase(), agent.name]))
        const blocked = new Set<string>()
        for (const target of targets) {
          const agentId =
            target.kind === "agent"
              ? target.agentId
              : (await chain.reader.getCapability(target.capabilityId))?.agentId
          const name = agentId === undefined ? undefined : byAgentId.get(agentId.toLowerCase())
          if (name !== undefined) blocked.add(name)
        }
        if (blocked.size === 0) return ["ok: store blocks nobody who is approved"]
        return [...blocked].map((name) => problem(`the store still blocks ${name} after a failed revoke`, `run \`mida approve ${name}\``))
      },
    },
    {
      name: "approved-projects",
      run: async () => {
        const owner = shared.ownerAddress ?? ownerAddressOf(home)
        if (owner === "missing") return [problem("the approved-projects list cannot be verified", needsOwner(home))]
        const status = await approvalsFileStatus(home, owner)
        if (status === "unreadable") {
          // the fix is permissions, not re-approving — re-running approve could not rebuild a
          // list it cannot read anyway
          return [problem("the approved-projects list could not be read", "check the file's permissions")]
        }
        if (status === "bad-signature") {
          return [problem("the approved-projects list failed its signature check", "re-run `mida approve <agent>` in each project folder")]
        }
        if (status === "missing") return ["ok: no approved projects yet"]
        const file = await readApprovalsFile(home, owner)
        const lines = ["ok: approved-projects signature valid"]
        // lk-1 — one project may live in several approved folders; the report names each
        // project with every folder its rows cover, sorted so the lines are stable
        if (file.kind !== "signed") return lines
        const byProject = new Map<string, Set<string>>()
        for (const entry of file.entries) {
          const roots = byProject.get(entry.projectId) ?? new Set<string>()
          roots.add(entry.root)
          byProject.set(entry.projectId, roots)
        }
        const short = (id: string) => `${id.slice(0, 8)}…`
        for (const [projectId, roots] of [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const folders = [...roots].sort()
          lines.push(`ok: project ${short(projectId)} — ${folders.length === 1 ? "1 folder" : `${folders.length} folders`} (${folders.join(", ")})`)
          for (const root of folders) {
            if (!existsSync(root)) {
              lines.push(
                problem(
                  `project ${short(projectId)} names ${root}, which no longer exists`,
                  `run \`mida unlink --folder ${root}\` — never hand-edit approved-projects.json, the owner signature protects every row`,
                ),
              )
            }
          }
        }
        return lines
      },
    },
    {
      name: "task",
      run: async () => {
        // tk-1: one line — the current task new sessions in this folder start under. A task
        // file that will not parse is a real problem: the resolution falls back to `main` and
        // the agent would silently work the wrong thread.
        const folder = folderTaskFor(deps.cwd ?? process.cwd())
        if (folder.markerDir === null) return ["note: this folder is not a Mida project — tasks live inside one"]
        if (folder.invalid) {
          return [problem("this folder's .mida/task.json is not a valid task file — sessions fall back to main", "run `mida task <name>` or delete the file")]
        }
        return [`ok: this folder's current task is ${folder.task ?? "main"}${folder.task === undefined ? " (default)" : ""}`]
      },
    },
    {
      name: "hook-commands",
      run: async () => {
        // `install` writes the resolved absolute path into the tools' settings — the check is
        // that every file that path names exists (and, bundled, stays executable). PATH is
        // not consulted: the hooks stopped depending on it (R5-7).
        return RESOLVED_ENTRIES.map((entry) => {
          const missing = siblingEntryArgs(entry).filter((token) => isAbsolute(token) && !existsSync(token))
          if (missing.length > 0) {
            return problem(`the ${entry} binary is missing at ${missing[0]}`, hookCommandFix())
          }
          const file = siblingEntryPath(entry)
          if (isBundled() && !isExecutable(file)) {
            return problem(`the ${entry} binary at ${file} is not executable`, hookCommandFix())
          }
          return `ok: ${entry} resolves to ${file}`
        })
      },
    },
    {
      name: "hooks",
      run: async () => {
        const lines: string[] = []
        // MIDA_CLAUDE_SETTINGS / MIDA_CODEX_CONFIG let a run that uses throwaway settings files
        // point the check at them — without it the check would report two false problems (R4-6).
        const env = deps.env ?? process.env
        const claudePath = deps.settings?.["claude-code"] ?? env.MIDA_CLAUDE_SETTINGS
        if (claudePath !== undefined) {
          const status = claudeHooksStatus(claudePath)
          lines.push(
            status === "installed"
              ? "ok: claude-code hooks installed"
              : status === "outdated"
                ? problem("claude-code hooks point at an older command — the bare name needs PATH", "run `mida install claude-code` to pin the absolute path")
                : status === "unreadable"
                  ? problem("claude-code settings cannot be read safely", "fix the file, then run `mida install claude-code`")
                  : problem("claude-code hooks are not installed", "run `mida install claude-code`"),
          )
          // "installed" only proves the text matches — the path inside it is what runs, so it
          // is stat'ed too; an "outdated" file may be a moved checkout's paths, worth the same stat (R5-7)
          if (status === "installed" || status === "outdated") {
            lines.push(...hookPathProblems(midaCommandsInClaudeSettings(claudePath), "claude-code"))
          }
          // in-28: a tool with hooks installed also reports whether install's MCP half ran —
          // an older or --no-mcp install has the hooks without the server, and the note
          // names the one command that adds it. Only "installed" earns the line: the
          // problem lines for every other status already end in the same install command.
          if (status === "installed") {
            const userConfig = deps.claudeUserConfig ?? claudeUserConfigPath(env, deps.homeDir ?? homedir())
            const mcpStatus = claudeCodeMcpStatus(userConfig, home.root)
            lines.push(
              mcpStatus === "installed"
                ? "ok: claude-code MCP server installed"
                : mcpStatus === "outdated"
                  ? "note: claude-code's MCP server starts a different copy of Mida than this one. Run mida install claude-code to point it here."
                  : "note: claude-code MCP server not installed. Run mida install claude-code.",
            )
          }
        }
        const codexPath = deps.settings?.codex ?? env.MIDA_CODEX_CONFIG
        if (codexPath !== undefined) {
          const status = codexHooksStatus(codexPath)
          lines.push(
            status === "installed"
              ? "ok: codex hooks installed"
              : status === "outdated"
                ? problem("codex's hook block is an older version", "run `mida install codex`")
                : status === "unreadable"
                  ? problem("codex's hook block was edited", "remove the marked block, then run `mida install codex`")
                  : problem("codex hooks are not installed", "run `mida install codex`"),
          )
          if (status === "installed" || status === "outdated") {
            lines.push(...hookPathProblems(midaCommandsInCodexConfig(codexPath), "codex"))
          }
          // in-28: the same "did install's MCP half run" line — a hooks-only block (from a
          // --no-mcp install or an older build) reports the note, the managed table the ok
          if (status === "installed") {
            lines.push(
              codexMcpStatus(codexPath, home.root) === "installed"
                ? "ok: codex MCP server installed"
                : "note: codex MCP server not installed. Run mida install codex.",
            )
          }
          // any managed block means the config was written or changed — Codex fingerprints the
          // hook text and skips an untrusted hook SILENTLY, and doctor cannot read Codex's trust
          // state, so the reminder runs whenever the block is there (R5-6)
          if (status !== "absent") lines.push(`note: ${CODEX_TRUST_SENTENCE}`)
        }
        // Devin without ~/.config/devin is simply not installed — it is not a problem and
        // earns no line. The directory's existence is the tell (the file may legitimately
        // not exist yet — Devin writes it on first change — and that IS "not installed").
        const devinPath = deps.settings?.devin ?? env.MIDA_DEVIN_CONFIG
        if (devinPath !== undefined && existsSync(dirname(devinPath))) {
          const status = devinHooksStatus(devinPath)
          lines.push(
            status === "installed"
              ? "ok: devin hooks installed"
              : status === "outdated"
                ? problem("devin's hook block is an older version", "run `mida install devin`")
                : status === "unreadable"
                  ? problem("devin's hook block cannot be read safely", "fix the file, then run `mida install devin`")
                  : problem("devin hooks are not installed", "run `mida install devin`"),
          )
          if (status === "installed" || status === "outdated") {
            lines.push(...hookPathProblems(midaCommandsInDevinConfig(devinPath), "devin"))
          }
          if (status === "installed") {
            // this build does not know where Devin keeps MCP servers, so the note is all the
            // line can ever say — it is literal (the server is not installed) and the command
            // it names explains why
            lines.push("note: devin MCP server not installed. Run mida install devin.")
          }
          const sqliteOk = (deps.devinSqliteAvailable ?? devinSqliteAvailable)()
          if (!sqliteOk) {
            lines.push(problem(`devin's session database needs node:sqlite — Node ${DEVIN_NODE_SQLITE_MIN} or later`, "upgrade Node"))
          }
        }
        return lines.length === 0 ? ["ok: no hook paths to check"] : lines
      },
    },
    {
      // in-15 J-7: an installed MCP entry whose launcher sits under a macOS-protected folder
      // cannot be spawned by the app — Claude Desktop showed "Server disconnected" while
      // Terminal-run hooks worked. The note is the same line install prints. An absent entry
      // or a non-macOS platform earns no line.
      name: "mcp-clients",
      run: async () => {
        const homeDir = deps.homeDir ?? homedir()
        const platform = deps.platform ?? process.platform
        const entries: [McpClientTool, string][] = [
          ["claude-desktop", deps.mcpConfigs?.["claude-desktop"] ?? claudeDesktopConfigPath(homeDir)],
          ["cursor", deps.mcpConfigs?.cursor ?? cursorMcpConfigPath(deps.cwd ?? process.cwd())],
        ]
        const lines: string[] = []
        for (const [client, configPath] of entries) {
          const commandPath = installedMcpLauncherPath(client, configPath, home.root)
          if (commandPath === undefined) continue
          const note = macosProtectedFolderNote(client, commandPath, homeDir, platform)
          if (note !== undefined) lines.push(note)
        }
        return lines
      },
    },
    {
      name: "api-keys",
      run: async () => {
        const env = deps.env ?? process.env
        const set = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter((name) => env[name] !== undefined && env[name] !== "")
        return set.length === 0
          ? ["ok: no Anthropic key variable in the shell"]
          : [`note: ${set.join(", ")} set in the shell (midad strips them for the compiler)`]
      },
    },
    {
      name: "compile-model",
      run: async () => {
        // the same resolution the daemon used at start-up — the owner sees which model compiles
        // sessions, exactly which host the transcript text goes to (secrets are scrubbed first),
        // and the real fallback chain — all computed from the choice, never hard-coded
        const env = deps.env ?? process.env
        const choice = compileModelChoice(env)
        const lines = [`ok: compile model is ${choice.model.label}`]
        const head = choice.chain[0]!
        const rest = choice.chain.slice(1)
        const nameOf = (entry: (typeof choice.chain)[number]) => (entry.provider === "haiku" ? entry.label : entry.provider)
        const fallbackClause = rest.length === 0 ? "no fallback" : `a failed call falls back to ${rest.map(nameOf).join(", then ")}`
        if (head.provider === "custom") {
          lines.push(`note: compile text is sent to ${head.host ?? "an address that does not parse"} (your own endpoint); ${fallbackClause}`)
          // a pinned custom without its required vars fails every compile — name the vars, never values
          const missing = [COMPILE_PROVIDERS.custom.baseVar, COMPILE_PROVIDERS.custom.modelVar].filter((v) => env[v] === undefined || env[v] === "")
          if (missing.length > 0) {
            lines.push(problem(`MIDA_COMPILE_MODEL=custom needs ${missing.join(" and ")}`, "set them or unset MIDA_COMPILE_MODEL"))
          }
        } else {
          const via = head.provider === "haiku" ? " via the claude CLI" : ""
          lines.push(
            `note: ${nameOf(head)} sends the session's transcript text to ${head.host ?? "an address that does not parse"}${via} (secrets are scrubbed first); ${fallbackClause}`,
          )
        }
        // an overridden base URL on a NAMED provider in the chain means the key and the transcript
        // go somewhere other than the vendor — the owner must see which HOST that is; the full URL
        // is never printed (its path or query may be secret). A custom base URL is not a problem:
        // it IS the endpoint the user chose.
        for (const entry of choice.chain) {
          if (entry.provider !== "deepseek" && entry.provider !== "kimi") continue
          const table = COMPILE_PROVIDERS[entry.provider]
          if (env[table.baseVar] === undefined) continue
          const vendor = entry.provider === "deepseek" ? "DeepSeek" : "Moonshot"
          const defaultHost = new URL(table.baseDefault).host
          const host = entry.host !== undefined && entry.host !== "" ? entry.host : "an address that does not parse"
          if (host !== defaultHost) {
            lines.push(problem(`compile text is being sent to ${host}, not ${vendor}`, `unset ${table.baseVar} to compile against ${vendor}`))
          }
        }
        return lines
      },
    },
    {
      name: "queue",
      run: async () => {
        const jobs = listJobs(home)
        if (jobs.length === 0) return ["ok: queue empty"]
        const oldest = jobs.reduce((min, job) => Math.min(min, Date.parse(job.at)), Number.POSITIVE_INFINITY)
        const ageMs = Math.max(0, (deps.now ?? Date.now)() - oldest)
        const lines = [`ok: ${jobs.length} job(s) waiting; oldest ${ageText(ageMs)}`]
        // in-29 S-2: a session's wait record names the drain code it is waiting on — an
        // out-of-gas wait names the agent whose wallet is dry and the two ways to clear it,
        // instead of reading as indistinguishable "chain-error" minutes.
        const waits = sessionWaits(home, jobs)
        const outOfGas = [...new Set(waits.filter((wait) => wait.reason === "out-of-gas").map((wait) => wait.agent))].sort()
        for (const agent of outOfGas) {
          lines.push(`PROBLEM: ${agent}'s wallet ran out of gas, so its saves are waiting. Run mida sponsor on, or mida init to top it up.`)
        }
        if (waits.length > 0) {
          const next = waits.reduce((min, wait) => Math.min(min, wait.dueAtMs), Number.POSITIVE_INFINITY)
          const at = new Date(next)
          const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
          lines.push(`note: ${waits.length} session(s) waiting to save; the next try is at ${hhmm} local time.`)
        }
        return lines
      },
    },
    {
      name: "batching",
      run: async () => {
        // The lane line reports what the NEXT save would do — the same decideLane the save path
        // runs. The flag comes from the raw file (resolution may have failed), the contract and
        // store from the resolved network so adoption and env overrides match the daemon's view.
        const resolved = await resolveShared(deps, shared)
        let saved: SavedNetwork | undefined
        try {
          saved = readSavedNetwork(home)
        } catch {
          saved = undefined
        }
        const deployment = resolved?.network.deployment ?? saved?.deployment
        const storageUrl = resolved?.network.storageUrl ?? saved?.storageUrl
        const lane: Lane =
          deployment === undefined
            ? { kind: "direct", why: "no-batch-anchor" }
            : await decideLane({ saved, deployment, storageUrl, status: () => batchStatusProbe(storageUrl ?? "") })
        const lines: string[] = [
          lane.kind === "batched"
            ? `ok: checkpoint saves: batched via ${hostOf(lane.storeUrl)}`
            : "ok: checkpoint saves: one transaction each",
        ]
        // the lane line itself is informational — but a switch turned on that still resolves to
        // the direct lane is a configuration the owner meant to be different
        if (lane.kind === "direct" && saved?.batching === true) {
          lines.push(
            problem(
              `batching is on but saves are taking the direct lane: ${laneWhyText(lane.why)}`,
              "check the store or run `mida batching off`",
            ),
          )
        }
        for (const entry of rejectedAnchors(home)) {
          lines.push(
            problem(
              `a checkpoint save was rejected on chain (${entry.reason}, session ${entry.sessionId})`,
              "it was not anchored; check the agent's approval with `mida doctor`",
            ),
          )
        }
        // in-13 M-4: a save the store already judged unchangeable is not "pending" — it was
        // refused as composed and is waiting out its hourly retry. Each is a named PROBLEM so
        // it never reads as an ordinary stuck batch or a quietly young anchor.
        const live: PendingAnchor[] = []
        for (const entry of pendingAnchors(home)) {
          if (entry.stuck === undefined) {
            live.push(entry)
            continue
          }
          // in-14 F-3: the fix clause names the kept plaintext's file so a save that can never
          // land still shows the owner where its text sits on this laptop; a code that closes
          // the batched LANE is phrased as that — the save itself is being resent directly
          const text = resubmitStuckText(entry.stuck, home.path(pendingPlaintextPath(entry.contextId)))
          const verb = RESUBMIT_LANE_CLOSED.has(entry.stuck) ? "cannot go through the batch lane" : "cannot be resubmitted"
          lines.push(
            problem(
              `a checkpoint save (${entry.eventId}, session ${entry.sessionId}) ${verb}: ${text.what}`,
              `${text.fix}; it retries once an hour meanwhile`,
            ),
          )
        }
        if (live.length > 0) {
          const nowMs = (deps.now ?? Date.now)()
          const young: PendingAnchor[] = []
          const old: PendingAnchor[] = []
          for (const entry of live) {
            const queuedAt = Date.parse(entry.queuedAt)
            ;(Number.isNaN(queuedAt) || nowMs - queuedAt >= STUCK_ANCHOR_MS ? old : young).push(entry)
          }
          // An old entry the store already reports final is not stuck — the ledger simply has not
          // been followed since it landed. Asking the store before crying wolf keeps a quiet
          // setup (no drain pass to run the follow-up) from reporting a stuck batcher forever.
          const probe =
            deps.probeBatchSave ??
            (async (entry: PendingAnchor) => {
              if (storageUrl === undefined || deployment === undefined) return null
              const client = batchClient(home, storageUrl, deployment, entry.agent)
              return client === undefined ? null : await client.getBatchSave(entry.contextId).catch(() => null)
            })
          let stuck = 0
          for (const entry of old) {
            const answer = await probe(entry)
            if (answer !== null && answer.state === "ANCHORED") continue
            if (answer !== null && answer.state === "REJECTED") {
              lines.push(
                problem(
                  `a checkpoint save was rejected on chain (${answer.reason ?? "unknown"}, session ${entry.sessionId})`,
                  "it was not anchored; check the agent's approval with `mida doctor`",
                ),
              )
              continue
            }
            stuck += 1
          }
          if (stuck > 0) {
            lines.push(
              problem(
                `${stuck} checkpoint save(s) waiting to anchor for over 10 minutes`,
                `check the store${storageUrl === undefined ? "" : ` at ${hostOf(storageUrl)}`}`,
              ),
            )
          }
          if (young.length > 0) lines.push(`note: ${young.length} checkpoint save(s) pending anchor (PENDING_ANCHOR)`)
        }
        return lines
      },
    },
    {
      name: "whatsnew",
      run: async () => {
        // the prompt hook is silent by contract — a give-up lands in the hook log instead, and
        // this check makes that silence visible: a count, a problem past the line
        const timeouts = whatsnewTimeouts(home, (deps.now ?? Date.now)())
        if (timeouts > 3) {
          return [problem("the per-prompt update is timing out; the daemon may be unreachable", "check `midad` is running and restart it")]
        }
        return timeouts === 0
          ? ["ok: the per-prompt update is answering"]
          : [`note: ${timeouts} whats-new timeout(s) in the last hour`]
      },
    },
    {
      name: "wallets",
      run: async () => {
        const chain = chainOf(shared)
        if (chain === undefined) return [problem("wallets cannot be checked", NEEDS_NETWORK)]
        const owner = shared.ownerAddress ?? ownerAddressOf(home)
        if (owner === "missing") return [problem("wallets cannot be checked", needsOwner(home))]
        const passkey = ownerModeOf(home) === "passkey"
        // A reachable sponsor pays the gas, so wallet balances stop being a health signal
        // (M3-D3 — the Sep 22 run printed a low-balance PROBLEM while the sponsor was working).
        // Only with no sponsor configured, or one that is not answering, does a low wallet
        // matter again: the self-paid fallback is what would have to carry the next send.
        const sponsorUrl = (await doctorServices(deps, shared)).sponsorUrl
        if (sponsorUrl !== undefined && (await sponsorReachable(sponsorUrl))) {
          // A passkey owner has no wallet on this machine to call a fallback — only software
          // mode prints the owner balance.
          if (passkey) return [`ok: gas is sponsored by ${hostOf(sponsorUrl)}`]
          const balance = await chain.context.publicClient.getBalance({ address: owner })
          // reachable is all the probe proved — the wallet stays funded as the fallback (M3-D6)
          return [`ok: gas is sponsored by ${hostOf(sponsorUrl)} — wallet holds ${formatMon(balance)} MON (kept as a fallback)`]
        }
        const lines: string[] = []
        // The passkey's EVM address holds no key material here and funds nothing — only the
        // agents' wallets can pay, so only they are checked.
        const wallets: { label: string; address: Address }[] = passkey ? [] : [{ label: "owner", address: owner }]
        for (const name of listAgentNames(home)) {
          const identity = loadAgentIdentity(home, name)
          if (identity !== undefined) {
            wallets.push({ label: name, address: privateKeyToAccount(identity.signerPrivateKey).address })
          }
        }
        for (const wallet of wallets) {
          const balance = await chain.context.publicClient.getBalance({ address: wallet.address })
          if (balance < MIN_BALANCE_WEI) {
            lines.push(problem(`${wallet.label}'s wallet is below the gas top-up line`, `${INIT_FIX} to top it up`))
          }
        }
        if (wallets.length === 0) return ["ok: no wallets on this machine — only the passkey page signs owner sends"]
        return lines.length === 0 ? ["ok: wallets have gas"] : lines
      },
    },
    {
      name: "services",
      run: async () => {
        // What the Context API and the gas sponsor resolve to right now — the env override
        // first in both directions, then the value init persisted to network.json. A saved home
        // that never stored one is "local": this setup ran the local store and pays its own gas,
        // so no hosted default is named for it. The host only — a path or query could carry a key.
        const { storage, sponsor } = await doctorServices(deps, shared)
        const describe = (label: string, envName: string, resolved: { url: string | undefined; source: string }, off: string): string => {
          if (resolved.source === "off") return `${label}: ${off}`
          if (resolved.source === "local") {
            return label === "store" ? "store: local (this setup saved no store address)" : "sponsor: none — this setup pays its own gas"
          }
          if (resolved.source === "environment") return `${label}: ${hostOf(resolved.url!)} (${envName})`
          if (resolved.source === "network.json") return `${label}: ${hostOf(resolved.url!)} (network.json)`
          return `${label}: ${hostOf(resolved.url!)} (default)`
        }
        return [
          `ok: ${describe("store", "MIDA_STORAGE_URL", storage, "off — the local store")}`,
          `ok: ${describe("sponsor", "MIDA_SPONSOR_URL", sponsor, "off — sends pay their own gas")}`,
        ]
      },
    },
    {
      // in-11 R-3: a store deployed before in-3 has no GET /write-authority. Saves still work —
      // the client falls back to the pre-in-3 flow — but the pending-revoke check is absent and
      // the owner should be told to redeploy. The probe is unsigned on purpose: any answer other
      // than 404 (a coded 401 as surely as a 200) proves the route exists.
      name: "store-write-check",
      run: async () => {
        const storageUrl = (await doctorServices(deps, shared)).storageUrl
        // a local store is this code — the route exists by definition, nothing to probe
        if (storageUrl === undefined) return ["ok: the local store has the pending-revoke check"]
        try {
          const response = await fetch(`${storageUrl.replace(/\/+$/, "")}/write-authority`, { signal: AbortSignal.timeout(2_000) })
          return response.status === 404
            ? [`note: the store at ${hostOf(storageUrl)} predates the pending-revoke check — redeploy the store to enable the pending-revoke check`]
            : [`ok: the store at ${hostOf(storageUrl)} answers the pending-revoke check`]
        } catch {
          return [`note: the store at ${hostOf(storageUrl)} could not be reached to check for the pending-revoke check`]
        }
      },
    },
    {
      name: "environment",
      run: async () => {
        // Every variable Mida reads, named set or unset — never a value: DEPLOYER_PRIVATE_KEY,
        // KIMI_API_KEY and a URL carrying a key must not echo to a pasted report.
        const env = deps.env ?? process.env
        const set = ENV_VARS.filter((name) => env[name] !== undefined && env[name] !== "")
        const unset = ENV_VARS.filter((name) => env[name] === undefined || env[name] === "")
        return [
          `ok: environment — set: ${set.length === 0 ? "none" : set.join(", ")}`,
          `ok: environment — unset: ${unset.length === 0 ? "none" : unset.join(", ")}`,
        ]
      },
    },
    {
      name: "sponsor",
      run: async () => {
        // the same resolution the send path uses — env first, then network.json — so
        // MIDA_SPONSOR_URL=off here means what it means there (M3-D6). No chain needed.
        const { sponsor } = await doctorServices(deps, shared)
        if (sponsor.source === "off") return ["ok: gas sponsor off — sends pay their own gas"]
        // a saved home that never stored a sponsor pays its own gas — nothing to probe
        if (sponsor.source === "local") return ["ok: no gas sponsor — this setup pays its own gas"]
        if (sponsor.source === "default" || sponsor.source === "hosted-default") {
          return ["ok: no gas sponsor in network.json — the services check shows what init will use"]
        }
        const sponsorUrl = sponsor.url!
        const fix = sponsor.source === "environment" ? "check MIDA_SPONSOR_URL" : "check sponsorUrl in network.json"
        // the HOST is printed, never the URL — its path or query may carry an operator's key
        const host = hostOf(sponsorUrl)
        try {
          const reply = await fetch(sponsorUrl, { signal: AbortSignal.timeout(2_000) })
          if (!reply.ok) {
            return [problem(`the gas sponsor ${host} answered HTTP ${reply.status}`, fix)]
          }
          const body = (await reply.json().catch(() => undefined)) as
            | { limits?: { signingsPerSenderPerDay?: unknown; signingsGlobalPerDay?: unknown; freeCallsPerSenderPerDay?: unknown } }
            | undefined
          const limits = body?.limits
          const detail =
            typeof limits?.signingsPerSenderPerDay === "number" && typeof limits?.signingsGlobalPerDay === "number"
              ? `; it advertises ${limits.signingsPerSenderPerDay} signings per address a day, ${limits.signingsGlobalPerDay} a day in total`
              : ""
          // a 2xx proves reachable, never willing — the Sep 22 refusal came from a reachable sponsor
          return [`ok: gas sponsor reachable at ${host} (willingness is only proven by a real send${detail})`]
        } catch {
          return [
            problem(
              `the gas sponsor ${host} did not answer within 2 s`,
              `${fix} — sends will pay their own gas until it answers`,
            ),
          ]
        }
      },
    },
  ]
}

/** `whatsnew-timeout` records the prompt hook wrote to logs/hook.jsonl during the last hour. */
function whatsnewTimeouts(home: MidaHome, nowMs: number): number {
  let text: string
  try {
    text = readFileSync(home.path("logs/hook.jsonl"), "utf8")
  } catch {
    return 0 // no hook log yet — nothing has ever timed out
  }
  const since = nowMs - 60 * 60 * 1000
  let count = 0
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const record = JSON.parse(line) as { event?: unknown; at?: unknown }
      if (record.event !== "whatsnew-timeout" || typeof record.at !== "string") continue
      const at = Date.parse(record.at)
      if (!Number.isNaN(at) && at >= since) count += 1
    } catch {
      // a corrupt log line is not a timeout — and never a doctor problem
    }
  }
  return count
}

/**
 * Whether the stored pending request's five-minute window has already closed: the file carries
 * its own `requestExpiresAt`, so the answer needs only the chain's clock — the same boundary
 * approve's assertRequestFresh applies (`now >= requestExpiresAt`). An unreadable or shapeless
 * file is not "expired": the plain waiting line stays the answer (in-15 J-3).
 */
function pendingRequestExpired(home: MidaHome, name: string, now: bigint): boolean {
  try {
    const expiresAt = home.readJson<{ request?: { requestExpiresAt?: unknown } }>(`agents/${name}/pending-request.json`)?.request?.requestExpiresAt
    return typeof expiresAt === "string" && now >= decodeUint64(expiresAt as Hex)
  } catch {
    return false
  }
}

function ageText(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * `mida doctor`: one line per check — `ok:`, `note:` or `PROBLEM: <sentence> — <the fix>`. The
 * exit code is the number of PROBLEM lines, capped at 9; notes never count. Every check is
 * isolated: a thrown or timed-out check is itself a PROBLEM line with a stable code and the run
 * goes on. Nothing here takes `midad.lock` — chain state is read through a read-only registry
 * reader built from network.json, so the checks run whether or not the daemon is up.
 */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.capMs ?? RUN_CAP_MS)
  const shared: Shared = {}
  let problems = 0
  for (const check of buildChecks(deps, shared)) {
    const remaining = deadline - now()
    let lines: string[]
    if (remaining <= 0) {
      lines = [problem(`the ${check.name} check did not run`, "re-run `mida doctor`")]
    } else {
      try {
        lines = await within(check.run(), remaining)
      } catch (error) {
        lines = [problem(`the ${check.name} check failed (${stableCode(error)})`, "re-run `mida doctor`")]
      }
    }
    for (const line of lines) {
      deps.print(line)
      if (line.startsWith("PROBLEM:")) problems += 1
    }
  }
  return Math.min(problems, 9)
}

/**
 * `mida doctor --live <tool>`: the only check that proves a hook really fires, because Codex
 * skips an untrusted hook silently. It starts one throwaway headless session of the tool and
 * watches the daemon log for the SessionStart handoff it triggers — inside 60 s or it reports.
 * A real agent is started, so the check refuses to run in CI or without an interactive terminal;
 * the guards run before anything is spawned.
 */
export async function runDoctorLive(tool: InstallTool, deps: DoctorLiveDeps): Promise<number> {
  const env = deps.env ?? process.env
  if (env.CI !== undefined && env.CI !== "") {
    deps.print("refused: live checks do not run in CI")
    return 2
  }
  if (!(deps.stdinIsTTY ?? process.stdin.isTTY ?? false)) {
    deps.print("refused: live checks need an interactive terminal")
    return 2
  }
  const started = (deps.now ?? Date.now)()
  const deadline = started + (deps.watchMs ?? LIVE_WATCH_MS)
  const cwd = mkdtempSync(join(tmpdir(), "mida-live-"))
  const session = (deps.startSession ?? startToolSession)(tool, cwd)
  try {
    for (;;) {
      if (handoffLogged(deps.home, tool, started)) {
        deps.print(`ok: ${tool} SessionStart hook fired`)
        return 0
      }
      if ((deps.now ?? Date.now)() >= deadline) {
        deps.print(problem(`${tool}'s SessionStart hook did not fire within 60 s`, "check the hooks are installed and trusted"))
        return 1
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    session.stop()
  }
}

/**
 * The throwaway session: a headless one-shot prompt in an empty folder — just enough for the
 * tool to start, fire SessionStart and exit. `claude -p` and `codex exec` are the headless forms.
 */
function startToolSession(tool: InstallTool, cwd: string): { stop(): void } {
  const [command, args] =
    tool === "claude-code" ? ["claude", ["-p", "Reply with the word ok."]] : ["codex", ["exec", "Reply with the word ok."]]
  // A model child gets the same environment rule as the drainer: no ANTHROPIC_* name crosses over.
  const child = spawn(command, args, { cwd, stdio: "ignore", env: drainerEnv(process.env) })
  child.on("error", () => {})
  return {
    stop() {
      try {
        child.kill()
      } catch {
        // already gone
      }
    },
  }
}

/** True once the daemon log holds a handoff record for this tool written after `since`. */
function handoffLogged(home: MidaHome, tool: string, since: number): boolean {
  try {
    const file = home.path("logs/daemon.jsonl")
    if (!existsSync(file)) return false
    const sinceIso = new Date(since).toISOString()
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .some((line) => {
        try {
          const record = JSON.parse(line) as { at?: unknown; event?: unknown; agent?: unknown }
          return record.event === "handoff" && record.agent === tool && typeof record.at === "string" && record.at >= sinceIso
        } catch {
          return false
        }
      })
  } catch {
    return false
  }
}
