import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "@mida/protocol"
import { chainFor, parseDeployment } from "@mida/chain"
import type { ChainContext } from "@mida/chain"
import { compileModelChoice } from "@mida/compiler"
import { RegistryReader } from "@mida/api"
import { callDaemon } from "./control.js"
import type { MidaHome } from "./home.js"
import { drainerEnv } from "./hook.js"
import { CODEX_TRUST_SENTENCE, claudeHooksStatus, codexHooksStatus } from "./install.js"
import type { InstallTool } from "./install.js"
import { isRevoked, listAgentNames, loadAgentIdentity } from "./keys.js"
import { approvalsFileStatus } from "./projects.js"
import { listJobs } from "./queue.js"
import { MIN_BALANCE_WEI } from "./runtime.js"

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

/** The owner address from the saved secrets — read only, never created here. */
function ownerAddressOf(home: MidaHome): Address | "missing" {
  try {
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
/**
 * The repo's own `bin/` — the fix text for a missing hook command names it, because until the
 * npm package exists the launchers live here and nowhere else.
 */
const BIN_DIR = fileURLToPath(new URL("../../../bin/", import.meta.url))
/** The commands `mida install` writes into the tools' hook settings — bare text on purpose. */
const HOOK_COMMANDS = ["mida-hook", "mida-inject"] as const

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
            lines.push(problem(`${name}'s grant cannot be checked`, NEEDS_OWNER))
            continue
          }
          const ids = await chain.reader.activeCapabilityIds(owner, identity!.agentId)
          const views = (await Promise.all(ids.map((id) => chain.reader.getCapability(id)))).filter((v) => v !== null)
          const now = await chain.reader.now()
          const live = views.filter((v) => !v.revoked && (v.expiresAt === 0n || now < v.expiresAt))
          if (live.length > 0) {
            lines.push(`ok: ${name} approved`)
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
      name: "approved-projects",
      run: async () => {
        const owner = shared.ownerAddress ?? ownerAddressOf(home)
        if (owner === "missing") return [problem("the approved-projects list cannot be verified", NEEDS_OWNER)]
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
            : problem(`the command \`${command}\` is not on your PATH, so the hooks cannot run`, `add ${BIN_DIR} to your PATH`),
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
        // sessions and, on the kimi path, that session text leaves the machine for Moonshot's API
        const env = deps.env ?? process.env
        const choice = compileModelChoice(env)
        const lines = [`ok: compile model is ${choice.model.label}`]
        if (choice.fallback !== undefined) {
          lines.push(
            `note: kimi sends the session's transcript text to api.moonshot.ai (secrets are scrubbed first); a failed call falls back to ${choice.fallback.label}`,
          )
        }
        // an overridden endpoint receives the API key and the transcript text — the owner must
        // see which HOST that is; the full URL is never printed (its path or query may be secret)
        const override = env.KIMI_BASE_URL
        if (override !== undefined && override.replace(/\/+$/, "") !== "https://api.moonshot.ai") {
          let host = "an address that does not parse"
          try {
            const parsed = new URL(override).host
            if (parsed !== "") host = parsed
          } catch {
            // a value that is not a URL is still not Moonshot — the placeholder names that
          }
          lines.push(problem(`compile text is being sent to ${host}, not Moonshot`, "unset KIMI_BASE_URL to compile against Moonshot"))
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
        if (owner === "missing") return [problem("wallets cannot be checked", NEEDS_OWNER)]
        const lines: string[] = []
        const wallets: { label: string; address: Address }[] = [{ label: "owner", address: owner }]
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
        return lines.length === 0 ? ["ok: wallets have gas"] : lines
      },
    },
    {
      name: "sponsor",
      run: async () => {
        // network.json again, not the shared context — the sponsor answer needs no chain at all
        const stored = home.readJson<{ sponsorUrl?: unknown }>("network.json")
        const sponsorUrl = typeof stored?.sponsorUrl === "string" ? stored.sponsorUrl : ""
        if (sponsorUrl === "") return ["ok: no gas sponsor configured — sends pay their own gas"]
        // the HOST is printed, never the URL — its path or query may carry an operator's key
        let host = "an address that does not parse"
        try {
          host = new URL(sponsorUrl).host
          if (host === "") host = "an address that does not parse"
        } catch {
          // the placeholder stands
        }
        try {
          const reply = await fetch(sponsorUrl, { signal: AbortSignal.timeout(2_000) })
          if (!reply.ok) {
            return [problem(`the gas sponsor ${host} answered HTTP ${reply.status}`, "check sponsorUrl in network.json")]
          }
          const body = (await reply.json().catch(() => undefined)) as
            | { limits?: { signingsPerSenderPerDay?: unknown; signingsGlobalPerDay?: unknown; freeCallsPerSenderPerDay?: unknown } }
            | undefined
          const limits = body?.limits
          const detail =
            typeof limits?.signingsPerSenderPerDay === "number" && typeof limits?.signingsGlobalPerDay === "number"
              ? ` (${limits.signingsPerSenderPerDay} signings per address a day, ${limits.signingsGlobalPerDay} a day in total)`
              : ""
          return [`ok: gas sponsor ${host} answers${detail}`]
        } catch {
          return [
            problem(
              `the gas sponsor ${host} did not answer within 2 s`,
              "check sponsorUrl in network.json — sends will pay their own gas until it answers",
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
