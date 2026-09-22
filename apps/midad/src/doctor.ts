import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { isMidaError } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { chainFor, parseDeployment } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { COMPILE_PROVIDERS, compileModelChoice } from "@mida/compiler"
import { ContextApiClient, DenyOverlay, RegistryReader } from "@mida/api"
import type { RevocationTarget } from "@mida/api"
import type { LocalAccount } from "viem"
import { callDaemon } from "./control.js"
import type { MidaHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { CODEX_TRUST_SENTENCE, claudeHooksStatus, codexHooksStatus } from "./install.js"
import type { InstallTool } from "./install.js"
import { isRevoked, listAgentNames, loadAgentIdentity, loadOwnerAddress, loadOwnerMode, loadOwnerPublicKey } from "./keys.js"
import type { OwnerMode } from "./keys.js"
import { approvalsFileStatus } from "./projects.js"
import { listJobs } from "./queue.js"
import { HOSTED_SPONSOR_URL, HOSTED_STORAGE_URL, MIN_BALANCE_WEI, formatMon, serviceUrlInEffect, sponsorReachable } from "./runtime.js"
import { cliPackageName, isBundled } from "./sibling.js"

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
  /** Shell environment for the API-key check; default process.env. Values are never printed. */
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** /health probe timeout; default 1 s. */
  daemonProbeMs?: number
  /** Whole-run cap; default 20 s. */
  capMs?: number
}

interface DoctorLiveDeps extends DoctorDeps {
  /** Default: process.stdin.isTTY. Injected so the refusal is testable. */
  stdinIsTTY?: boolean
  /** SessionStart watch window; default 60 s. */
  watchMs?: number
  /** Starts the throwaway headless session; the default spawns the real tool. */
  startSession?: (tool: InstallTool, cwd: string) => { stop(): void }
}

/** What the chain checks need; built lazily once network.json has been read. */
interface Shared {
  context?: ChainContext
  reader?: RegistryReader
  ownerAddress?: Address | "missing"
  /** Agents the "agents" check found live on chain — undefined until that check finished. */
  approved?: { name: string; agentId: Hex }[]
}

const problem = (sentence: string, fix: string) => `PROBLEM: ${sentence} — ${fix}`
const INIT_FIX = "run `mida init`"

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

/** network.json → rpcUrl + deployment, or a refusal-shaped problem. Read only; never written. */
function readNetwork(home: MidaHome): { rpcUrl: string; deployment: ReturnType<typeof parseDeployment> } | undefined {
  try {
    const stored = home.readJson<{ rpcUrl?: unknown; deployment?: unknown }>("network.json")
    if (typeof stored?.rpcUrl !== "string" || stored.deployment === undefined) return undefined
    return { rpcUrl: stored.rpcUrl, deployment: parseDeployment(stored.deployment) }
  } catch {
    return undefined
  }
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
 * The service URLs a call would use right now — one shared resolution so the checks and the
 * services report cannot diverge again (M3-D6 item 3): the environment wins in both directions,
 * then network.json (what init persisted — the daemon's and drainer's only source), then the
 * hosted default. The default is a source, not a probe target: nothing this home runs was
 * configured to it, so "default" resolves to undefined here and only the services check names
 * it, as what a fresh init would use.
 */
function serviceUrls(home: MidaHome, env: NodeJS.ProcessEnv) {
  const stored = home.readJson<{ storageUrl?: unknown; sponsorUrl?: unknown }>("network.json")
  const storage = serviceUrlInEffect(env.MIDA_STORAGE_URL, stored?.storageUrl, HOSTED_STORAGE_URL)
  const sponsor = serviceUrlInEffect(env.MIDA_SPONSOR_URL, stored?.sponsorUrl, HOSTED_SPONSOR_URL)
  return {
    storageUrl: storage.source === "default" ? undefined : storage.url,
    sponsorUrl: sponsor.source === "default" ? undefined : sponsor.url,
    storage,
    sponsor,
  }
}

/** The repo's own `bin/` — the missing-hook-command fix for SOURCE-tree runs only (see hookCommandFix). */
const BIN_DIR = fileURLToPath(new URL("../../../bin/", import.meta.url))
/** The commands `mida install` writes into the tools' hook settings — bare text on purpose. */
const HOOK_COMMANDS = ["mida-hook", "mida-inject"] as const

/**
 * The fix for a hook command missing from PATH. Running from the npm package, the answer is the
 * global install — npm links the bins itself, and the package name comes from its own
 * package.json so nothing but publish/names.json hard-codes it. Running from the source tree
 * the launchers live in the repo's bin/. The two texts must never cross: a packaged user has no
 * repo to add to PATH, and a repo run has no package.
 */
function hookCommandFix(): string {
  if (isBundled()) {
    const name = cliPackageName()
    return name === undefined ? "reinstall the mida CLI package globally" : `run \`npm i -g ${name}\``
  }
  return `add ${BIN_DIR} to your PATH`
}

/** The HOST of a service URL — the path or query could carry an operator's key, so only the host is ever printed. */
function hostOf(raw: string): string {
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

/**
 * Is `command` runnable on the PATH the doctor itself runs with? The PATH is walked directly —
 * spawning a shell to ask would answer for a DIFFERENT environment than the hooks get.
 */
function onPath(env: NodeJS.ProcessEnv, command: string): boolean {
  const pathEnv = env.PATH
  if (pathEnv === undefined || pathEnv === "") return false
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      // not here — keep walking
    }
  }
  return false
}

/** One line per check, in the order the spec fixes. Each returns its lines; it never decides. */
function buildChecks(deps: DoctorDeps, shared: Shared): { name: string; run(): Promise<string[]> }[] {
  const home = deps.home
  return [
    {
      name: "daemon",
      run: async () => {
        const reply = await callDaemon(home, "/health", undefined, { timeoutMs: deps.daemonProbeMs ?? DAEMON_PROBE_MS })
        if (reply.status === 0) return [problem("midad is not answering", "start the daemon")]
        // any answer at all used to read as healthy — only 200 with { ok: true } is midad;
        // anything else is a problem that names the status it actually got
        const body = reply.body as { ok?: unknown } | null
        return reply.status === 200 && body !== null && typeof body === "object" && body.ok === true
          ? ["ok: midad answers"]
          : [problem(`midad answered with status ${reply.status}, not ok:true`, "restart midad")]
      },
    },
    {
      name: "network",
      run: async () => {
        const network = readNetwork(home)
        if (network === undefined) return [problem("network.json is missing or unreadable", INIT_FIX)]
        shared.context = {
          publicClient: createPublicClient({ chain: chainFor(network.deployment.chainId), transport: http(network.rpcUrl) }),
          deployment: network.deployment,
        }
        shared.reader = new RegistryReader(shared.context)
        return ["ok: network.json present"]
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
              home.has(`agents/${name}/pending-request.json`)
                ? problem(`${name} asked but is not approved on chain`, `run \`mida approve ${name}\``)
                : problem(`${name} has never asked for access`, `run \`mida request ${name}\` then \`mida approve ${name}\``),
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
        const storageUrl = serviceUrls(home, deps.env ?? process.env).storageUrl
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
        return status === "missing" ? ["ok: no approved projects yet"] : ["ok: approved-projects signature valid"]
      },
    },
    {
      name: "hook-commands",
      run: async () => {
        // `install` writes the bare command name into the tools' settings (Codex fingerprints
        // the text) — so nothing works unless that name resolves on the PATH the hooks get (R4-6).
        const env = deps.env ?? process.env
        return HOOK_COMMANDS.map((command) =>
          onPath(env, command)
            ? `ok: ${command} is on the PATH`
            : problem(`the command \`${command}\` is not on your PATH, so the hooks cannot run`, hookCommandFix()),
        )
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
              : status === "unreadable"
                ? problem("claude-code settings cannot be read safely", "fix the file, then run `mida install claude-code`")
                : problem("claude-code hooks are not installed", "run `mida install claude-code`"),
          )
        }
        const codexPath = deps.settings?.codex ?? env.MIDA_CODEX_CONFIG
        if (codexPath !== undefined) {
          const status = codexHooksStatus(codexPath)
          lines.push(
            status === "installed"
              ? "ok: codex hooks installed"
              : status === "outdated"
                ? problem("codex's hook block is an older version — the whats-new hook is missing", "run `mida install codex`")
                : status === "unreadable"
                  ? problem("codex's hook block was edited", "remove the marked block, then run `mida install codex`")
                  : problem("codex hooks are not installed", "run `mida install codex`"),
          )
          // any managed block means the config was written or changed — Codex fingerprints the
          // hook text and skips an untrusted hook SILENTLY, and doctor cannot read Codex's trust
          // state, so the reminder runs whenever the block is there (R5-6)
          if (status !== "absent") lines.push(`note: ${CODEX_TRUST_SENTENCE}`)
        }
        return lines.length === 0 ? ["ok: no hook paths to check"] : lines
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
        return [`ok: ${jobs.length} job(s) waiting; oldest ${ageText(ageMs)}`]
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
        const sponsorUrl = serviceUrls(home, deps.env ?? process.env).sponsorUrl
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
        // first in both directions, then the value init persisted to network.json, else the
        // hosted default the package ships with. The host only — a path or query could carry a key.
        const { storage, sponsor } = serviceUrls(home, deps.env ?? process.env)
        const describe = (label: string, envName: string, resolved: { url: string | undefined; source: string }, off: string): string => {
          if (resolved.source === "off") return `${label}: ${off}`
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
        const sponsor = serviceUrls(home, deps.env ?? process.env).sponsor
        if (sponsor.source === "off") return ["ok: gas sponsor off — sends pay their own gas"]
        if (sponsor.source === "default") {
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
