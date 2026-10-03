import { spawnSync } from "node:child_process"
import { createPublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import { MidaError, PERMISSION } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { bytesOf } from "@mida/crypto"
import { chainFor, createReadScope, createSponsoredSender, createWriteContext, memoizedReads, rpcTransport, sendValue } from "@mida/chain"
import type { ChainContext, Deployment, LocalWriteContext, ReadScope, SendCost, SendGate } from "@mida/chain"
import { ContextApiClient, RegistryReader } from "@mida/api"
import { FakeVaultAuthority } from "@mida/fake-vault"
import { MidaAgent } from "@mida/sdk"
import type { EpochKeyCache } from "@mida/sdk"
import type { MidaHome } from "./home.js"
import { callDaemon } from "./control.js"
import { daemonWarning } from "./log.js"
import { FileAccessRequestStore } from "./request-store.js"
import { listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets, loadOwnerAddress, loadOwnerSecrets, loadOwnerStartBlock, saveOwnerStartBlock } from "./keys.js"
import type { AgentIdentity } from "./keys.js"
import { startPersistentApi } from "./api-server.js"
import { isWindows } from "./platform.js"

export interface Network {
  rpcUrl: string
  deployment: Deployment
  /**
   * Tops an account up — exists on the networks that have a funder (local Anvil, Monad
   * testnet). Absent elsewhere: a low owner wallet then fails with OWNER_WALLET_LOW instead
   * of a bare transaction error (R4-4). Called from inside a send's balance guard it is handed
   * that send's abandonment gate: a funder that sends a transaction of its own must pass it
   * down so a timed-out outer send can never pay for the top-up afterwards (in-18 S4).
   */
  fund?(address: Address, gate?: SendGate): Promise<void>
  /** When set, the Context API lives at this URL (a remote store, M3) and no local server is started. */
  storageUrl?: string
  /**
   * When set, sends go through this gas sponsor first — the wallet still signs, the sponsor pays
   * (M3-D). Same URL rules as storageUrl plus no embedded credentials; a bad value is a
   * `bad-sponsor-url` error raised before the lock or any chain call is touched.
   */
  sponsorUrl?: string
  /**
   * The eth_getLogs window a history scan opens with (MIDA_LOG_BLOCK_RANGE, an integer
   * 1..1,000). Absent means the library default — the provider's answer, not this value, has the
   * final say: a refused window drops the scan to 100-block pieces.
   */
  logBlockRange?: bigint
}

export const NAMESPACE = "projects.current"
export const PURPOSE_ID = "project_assistance" as const
export const AGENT_PERMISSIONS = PERMISSION.READ | PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN
/** The hosted services the published CLI defaults to (M3-C): public endpoints, never secrets.
 *  Defined once in the SDK (connect.ts) so the CLI and integrators share one source of truth. */
export { HOSTED_SPONSOR_URL, HOSTED_STORAGE_URL } from "@mida/sdk"

/**
 * One env value → the service URL that should be in effect. Unset means the hosted default the
 * package ships with; the exact string `off` opts back into the local store or self-paid gas;
 * anything else is taken as the URL itself (the runtime's own URL rules still apply).
 */
export function serviceUrl(raw: string | undefined, hosted: string): string | undefined {
  if (raw === undefined || raw === "") return hosted
  if (raw === "off") return undefined
  return raw
}

/**
 * Where a service resolves for this home right now, in the order every consumer applies it
 * (M3-D6 item 3): the environment wins in BOTH directions — a URL replaces the persisted value
 * and "off" disables it — then network.json (what init persisted; the daemon and drainer read
 * nothing else), and finally the hosted default the package ships with. "default" means nothing
 * was ever configured — it is what a fresh init would write, so diagnostic checks must not
 * probe it as if this home's sends already used it.
 */
export function serviceUrlInEffect(
  raw: string | undefined,
  stored: unknown,
  hosted: string,
): { url: string | undefined; source: "environment" | "off" | "network.json" | "default" } {
  if (raw === "off") return { url: undefined, source: "off" }
  if (raw !== undefined && raw !== "") return { url: raw, source: "environment" }
  if (typeof stored === "string" && stored !== "") return { url: stored, source: "network.json" }
  return { url: hosted, source: "default" }
}

/**
 * One GET probe — true when the sponsor endpoint answers 2xx inside two seconds. init and
 * doctor share this so "the sponsor answers" means the same thing on both paths. Reachable is
 * all it proves: willingness to pay is only proven by a real send (M3-D6).
 */
export async function sponsorReachable(url: string): Promise<boolean> {
  try {
    const reply = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return reply.ok
  } catch {
    return false
  }
}
/**
 * Below this balance an account is topped up before it has to send a transaction. 0.15 MON, from
 * the live run on Sep 21: a grant bills about 0.043 MON on Monad (the full gas limit, at ~102 gwei)
 * and the node wants roughly twice that in the wallet to cover the maximum fee — so at the old
 * 0.05 line a wallet holding 0.064 was reported "has gas" and then could not pay for one approve.
 */
export const MIN_BALANCE_WEI = 150_000_000_000_000_000n
/** The owner wallet's top-up for operator and signer wallets on a network with no funder. */
export const OWNER_TOP_UP_WEI = 200_000_000_000_000_000n
/** One service runtime per home: a pid file created exclusively at open and removed at close. */
const LOCK_FILE = "midad.lock"
/** Where a running service publishes its Context API address so the owner CLI can reuse it. */
const API_URL_FILE = "api-url.json"

/**
 * The optional remote Context API address (A15). Empty/absent means "run the local server as
 * before". A set value must be https://, or http:// on 127.0.0.1/localhost only — anything else is
 * a `bad-storage-url` error raised before the lock or any chain call is touched.
 */
function parseStorageUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined
  try {
    const url = new URL(raw)
    if (url.protocol === "https:") return raw
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return raw
  } catch {
    // falls through to the refusal below
  }
  const error = new Error("network.storageUrl must be https://, or http:// on 127.0.0.1 or localhost") as Error & { code: string }
  error.code = "bad-storage-url"
  throw error
}

/**
 * The optional gas-sponsor address (M3-D). Empty/absent means every send pays its own gas, exactly
 * as before. A set value follows the storageUrl rules — https://, or http:// on 127.0.0.1 or
 * localhost only — and additionally refuses a URL carrying credentials, because the sponsor sees
 * every operation this wallet sends.
 */
export function parseSponsorUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined
  try {
    const url = new URL(raw)
    if (url.username !== "" || url.password !== "") {
      // not a protocol violation — a value we refuse on purpose; the catch folds it into bad-sponsor-url
      throw new Error("credentials in the sponsor URL")
    }
    if (url.protocol === "https:") return raw
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return raw
  } catch {
    // falls through to the refusal below
  }
  const error = new Error(
    "network.sponsorUrl must be https://, or http:// on 127.0.0.1 or localhost, with no credentials",
  ) as Error & { code: string }
  error.code = "bad-sponsor-url"
  throw error
}

/**
 * The wait a lock-taker shares — plus the process-table seam tests inject. `ps` answers
 * `ps -o <field>= -p <pid>`; returning undefined for everything is how a test says "this machine
 * has no usable ps", which must land every lock verdict on unknown-held.
 */
export interface LockTiming {
  lockWaitMs?: number
  lockStepMs?: number
  ps?: ProcessProbe
}

/**
 * What a process that took midad.lock was doing — written into the lock itself so a later reader
 * needs no command-line guesswork (in-40 L-1): `service` is the daemon's runtime, `save-helper`
 * is the detached drainer's (drain-main.ts), and `command` is every owner-command path.
 */
export type LockRole = "service" | "save-helper" | "command"

const LOCK_ROLES = new Set<string>(["service", "save-helper", "command"])
const lockRole = (raw: unknown): LockRole | undefined =>
  typeof raw === "string" && LOCK_ROLES.has(raw) ? (raw as LockRole) : undefined

/** `ServiceRuntime.open` options: the lock waits plus the role this opener writes into the lock. */
export interface OpenOptions extends LockTiming {
  role?: LockRole
}

/**
 * The one process-table lookup behind every lock decision: `ps -o <field>= -p <pid>` under
 * LC_ALL=C and TZ=UTC. `lstart` prints LOCAL time, so both the locale and the zone are pinned —
 * otherwise a lock written under one TZ and read under another compares unequal, a live service
 * looks like a recycled pid, and its lock and socket get removed. Returns the trimmed output,
 * or undefined on any failure — a spawn error, a non-zero exit, or empty output (BusyBox `ps`
 * has no `-p`; a dead pid prints nothing). The lock verdict table treats every one of those as
 * "cannot identify", which is a held verdict, never a removable lock.
 */
export type ProcessProbe = (pid: number, field: "lstart" | "command") => string | undefined

const psProbe: ProcessProbe = (pid, field) => {
  const ps = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
  if (ps.error !== undefined || ps.status !== 0) return undefined
  const out = ps.stdout.trim()
  return out === "" ? undefined : out
}

/**
 * The Windows answer to `ps -o lstart=|command= -p <pid>`: PowerShell's Win32_Process record.
 * The creation time is printed in UTC in round-trip form, so a lock written and read under
 * different time zones compares equal. Output is forced to UTF-8. The pid must be a positive
 * integer: it is placed in the PowerShell text, so anything else is refused before running.
 */
export const windowsProcessProbe = (run: typeof spawnSync = spawnSync): ProcessProbe => (pid, field) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const value = field === "lstart" ? "$p.CreationDate.ToUniversalTime().ToString('o')" : "$p.CommandLine"
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($null -eq $p){exit 1};${value}`
  const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  })
  if (out.error !== undefined || out.status !== 0) return undefined
  const text = String(out.stdout ?? "").trim()
  return text === "" ? undefined : text
}

/** The process probe for this platform: ps on Mac and Linux, PowerShell on Windows. */
export function processProbeFor(platform: NodeJS.Platform = process.platform): ProcessProbe {
  return isWindows(platform) ? windowsProcessProbe() : psProbe
}

/**
 * Takes the home's lock or throws. A live pid in an existing lock means another Mida process
 * holds it — the waiter retries in `stepMs` steps for up to `waitMs` before giving up, because a
 * drainer that fired during a long CLI run must not die on a transient hold. A dead, unreadable
 * or recycled-pid lock is stale and is replaced (in-39 B-1); a pid ps cannot identify is NOT —
 * it stays held rather than risk deleting files under a service ps could not see (in-40 L-1).
 * `createSecretJsonExclusive` makes the check-then-create race-free.
 *
 * The lock this writes carries `{ pid, started, role }`: `started` is this process's own
 * `ps -o lstart=` answer, read ONCE here and reused on every retry, so the file always names the
 * same instant. When ps cannot answer, `started` is left out and readers fall back to the
 * command-line shape check. `ps` runs at most once per distinct pid per call — the memoized
 * probe below, not once per step.
 */
async function acquireHomeLock(home: MidaHome, waitMs: number, stepMs: number, options: { role: LockRole; ps?: ProcessProbe }): Promise<void> {
  const deadline = Date.now() + waitMs
  const ps = options.ps ?? processProbeFor()
  const started = ps(process.pid, "lstart")
  const own: { pid: number; started?: string; role: LockRole } = {
    pid: process.pid,
    ...(started === undefined ? {} : { started }),
    role: options.role,
  }
  const seen = new Map<string, string | undefined>()
  const probe: ProcessProbe = (pid, field) => {
    const key = `${pid}:${field}`
    if (!seen.has(key)) seen.set(key, ps(pid, field))
    return seen.get(key)
  }
  let heldPid = 0
  for (;;) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (home.createSecretJsonExclusive(LOCK_FILE, own)) return
      let record: { pid?: unknown; started?: unknown; role?: unknown } | undefined
      try {
        record = home.readJson(LOCK_FILE)
      } catch {
        record = undefined // a lock file that will not parse is stale: take it over
      }
      const holder = lockVerdict(record, probe)
      if (holder !== undefined && (holder.kind === "held" || holder.kind === "unknown")) {
        heldPid = holder.pid
        break
      }
      home.remove(LOCK_FILE)
    }
    if (Date.now() >= deadline) {
      throw new Error(heldPid > 0 ? `another Mida process (pid ${heldPid}) already holds this home` : "another Mida process already holds this home")
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The executable names a Mida entry runs under — the npm package's bins and the shebang form a
 * package manager's shim ends up as (`node /usr/local/bin/mida`). Only `midad` (the service) and
 * `mida-drain` (the save helper) take the home lock through ServiceRuntime.open; `mida` takes it
 * on owner-command paths through resolveOwnerApi, and `mida-hook`, `mida-inject` and `mida-mcp`
 * never take it — they enqueue a job or call the control socket.
 */
const MIDA_BIN_NAMES = new Set(["mida", "midad", "mida-drain", "mida-hook", "mida-inject", "mida-mcp"])

/**
 * The entry files of every form Mida runs while holding midad.lock: the bundled npm package
 * (`dist/midad.js`, `dist/mida.js`, and the other dist bins) and a source checkout through tsx
 * (`apps/midad/src/cli.ts`, `daemon-main.ts`, `drain-main.ts`, `hook-main.ts`, `inject-main.ts`,
 * `mcp-main.ts`) — the `node --import …/tsx/dist/loader.mjs …` shape bin/mida and spawnDaemon
 * produce.
 */
const MIDA_ENTRY = /(?:^|\/)(?:dist\/(?:mida|midad|mida-drain|mida-hook|mida-inject|mida-mcp)\.js|apps\/midad\/src\/(?:cli|daemon-main|drain-main|hook-main|inject-main|mcp-main)\.ts)$/

/** Runners that launch a Mida entry — a bare `midad` bin also counts as argv0 (checked first). */
const MIDA_RUNNERS = new Set(["node", "nodejs", "tsx", "env"])

/**
 * The role a matched entry plays — consulted only for a legacy lock with no `started`, where the
 * command line is the only evidence left. Every entry not listed here (mida, the hooks, the MCP
 * adapter and their source mains) takes the lock for the length of an owner command.
 */
const ENTRY_ROLES: Record<string, LockRole> = {
  "midad": "service",
  "midad.js": "service",
  "daemon-main.ts": "service",
  "mida-drain": "save-helper",
  "mida-drain.js": "save-helper",
  "drain-main.ts": "save-helper",
}

/**
 * The role a command line implies, or null when it is not a Mida launch at all — the shape check
 * behind in-39 B-1, kept for locks written before `started` existed. An entry path counts only
 * behind a runner — `vim apps/midad/src/daemon-main.ts` is an editor, not the service.
 */
function midaRoleFromCommand(command: string): LockRole | null {
  const tokens = command
    .split(/\s+/)
    .map((token) => token.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/"))
  const base = (token: string) => token.split("/").pop()!.replace(/\.exe$/i, "")
  if (tokens.length > 0 && MIDA_BIN_NAMES.has(base(tokens[0]!))) return ENTRY_ROLES[base(tokens[0]!)] ?? "command"
  for (let i = 0; i < tokens.length; i++) {
    if (!MIDA_RUNNERS.has(base(tokens[i]!))) continue
    for (let k = i + 1; k < tokens.length; k++) {
      if (MIDA_ENTRY.test(tokens[k]!) || MIDA_BIN_NAMES.has(base(tokens[k]!))) {
        return ENTRY_ROLES[base(tokens[k]!)] ?? "command"
      }
    }
  }
  return null
}

/**
 * Whether pid is one of Mida's own processes, judged by `ps -o command= -p <pid>` — the identity
 * check a lock verdict falls back to when the lock predates `started` (in-39 B-1): `kill -0`
 * answering only proves SOME process owns the number, and a crashed Mida's pid is recycled to
 * an unrelated program fast enough that liveness alone once made doctor tell the owner to kill
 * a stranger. Returns undefined when `ps` itself fails or prints nothing: the caller then treats
 * the pid as live-but-unproven — the worst that does is leave a lock in place, never remove
 * files under a service it could not see.
 */
export function isMidaProcess(pid: number): boolean | undefined {
  const command = processProbeFor()(pid, "command")
  if (command === undefined) return undefined
  return midaRoleFromCommand(command) !== null
}

/**
 * What midad.lock says about who holds this home. `held` — a live Mida process took it (`role`
 * says which kind); `dead` — the pid is gone; `recycled` — the pid lives but belongs to a
 * different process than the one that wrote the lock (the start times disagree, or the command
 * line is not Mida's); `unknown` — the pid is live but ps cannot say what it is. Held and
 * unknown both keep every file in place; dead and recycled let the lock be replaced. Undefined
 * means no lock or an unreadable one.
 */
export type LockHolderKind = "held" | "dead" | "recycled" | "unknown"
export interface LockHolder {
  pid: number
  kind: LockHolderKind
  role?: LockRole
}

/**
 * The verdict table every caller shares (in-40 L-1): the writer's own pid is held without asking
 * ps; a dead pid is stale; a `started` that matches `ps -o lstart=` proves the live pid IS the
 * process that wrote the lock — whatever shape its command line takes; a mismatch means the
 * number was recycled onto a stranger; a ps that cannot answer is unknown-held on any lock
 * shape; and a lock with no `started` (an older Mida wrote it) falls back to the command-line
 * shape check, which names the role or calls the lock recycled.
 */
function lockVerdict(
  record: { pid?: unknown; started?: unknown; role?: unknown } | undefined,
  probe: ProcessProbe,
): LockHolder | undefined {
  const pid = typeof record?.pid === "number" ? record.pid : 0
  if (pid <= 0) return undefined
  const role = lockRole(record?.role)
  if (pid === process.pid) return { pid, kind: "held", role: role ?? "command" }
  if (!processAlive(pid)) return { pid, kind: "dead" }
  const started = typeof record?.started === "string" && record.started !== "" ? record.started : undefined
  if (started !== undefined) {
    const seen = probe(pid, "lstart")
    if (seen === undefined) return { pid, kind: "unknown" }
    return seen === started ? { pid, kind: "held", ...(role === undefined ? {} : { role }) } : { pid, kind: "recycled" }
  }
  const command = probe(pid, "command")
  if (command === undefined) return { pid, kind: "unknown" }
  const shaped = midaRoleFromCommand(command)
  return shaped === null ? { pid, kind: "recycled" } : { pid, kind: "held", role: shaped }
}

export function lockHolder(home: MidaHome, ps?: ProcessProbe): LockHolder | undefined {
  let record: { pid?: unknown; started?: unknown; role?: unknown } | undefined
  try {
    record = home.readJson(LOCK_FILE)
  } catch {
    return undefined
  }
  return lockVerdict(record, ps ?? processProbeFor())
}

/**
 * The pid of the process holding this home's lock — undefined when there is no lock, the lock is
 * unreadable, its pid is dead, or the pid was recycled onto another program (a recycled number
 * holds nothing, in-39 B-1). The socket probe answers a different question (is a listener
 * reachable right now); this answers the one that decides whether the socket file is stale: a
 * live holder's files must never be removed under it (in-29 S-1, the Sep 29 orphaning bug). A
 * live pid that cannot be identified still counts as held — leaving a lock in place is the safe
 * error, deleting a running service's files is the bad one.
 */
export function liveLockHolderPid(home: MidaHome, ps?: ProcessProbe): number | undefined {
  const holder = lockHolder(home, ps)
  return holder !== undefined && (holder.kind === "held" || holder.kind === "unknown") ? holder.pid : undefined
}

export function apiClient(
  baseUrl: string,
  deployment: Deployment,
  account: LocalAccount,
  readScopeTokens?: Map<string, string>,
  home?: MidaHome,
): ContextApiClient {
  return new ContextApiClient({
    baseUrl,
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    ...(readScopeTokens === undefined ? {} : { readScope: readScopeTokens }),
    // a client built inside midad reports its compat warnings to the daemon log, not the
    // stderr of a detached process (in-12 N-7); a home-less caller keeps console.warn
    ...(home === undefined ? {} : { warn: daemonWarning(home) }),
  })
}

/** A coded refusal — an agent-facing command that hits this must never print a bare `ERROR`. */
function agentNotSetup(name: string): Error {
  const error = new Error(`agent "${name}" is not set up on this machine; run init first`) as Error & { code: string }
  error.code = "agent-not-setup"
  return error
}

/** Builds an agent from its saved identity and the grants it completed so far. */
function buildAgent(
  home: MidaHome,
  network: Network,
  apiBaseUrl: string,
  identity: AgentIdentity,
  progress?: (line: string) => void,
  reads?: ReadScope,
  epochKeys?: EpochKeyCache,
): MidaAgent {
  const signer = privateKeyToAccount(identity.signerPrivateKey)
  const chain = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: signer })
  // Inside a read scope the agent's fresh client still shares the operation's memo — the
  // checkpoint read and the fact read ask each distinct chain question once between them — and its
  // api client carries the scope token, so the store's own chain reads join the same operation.
  if (reads !== undefined) chain.publicClient = memoizedReads(chain.publicClient, reads)
  const sponsorUrl = parseSponsorUrl(network.sponsorUrl)
  if (sponsorUrl !== undefined) {
    // An agent signer holds no MON by design — the sponsored send is how its chain calls get paid.
    chain.sponsor = createSponsoredSender({ sponsorUrl, rpcUrl: network.rpcUrl, account: signer, deployment: network.deployment, progress })
  }
  chain.progress = progress
  return new MidaAgent({
    agentId: identity.agentId,
    callbackOrigin: identity.callbackOrigin,
    encryptionPrivateKey: bytesOf(identity.encryptionPrivateKey, 32),
    chain,
    api: apiClient(apiBaseUrl, network.deployment, signer, reads?.tokens, home),
    requests: new FileAccessRequestStore(home, identity.name),
    grants: loadGrants(home, identity.name),
    ...(epochKeys === undefined ? {} : { epochKeyCache: epochKeys }),
  })
}

/**
 * The daemon's base URL, when midad answers its socket. Returns undefined when no daemon is up.
 * A live daemon without a readable api-url.json is a broken install — that is a throw, not a
 * silent fallback to a second server on the same data directory.
 */
async function daemonApiBaseUrl(home: MidaHome): Promise<string | undefined> {
  const health = await callDaemon(home, "/health", undefined, { timeoutMs: 500 })
  if (health.status === 0) return undefined
  const record = home.readJson<Record<string, unknown>>(API_URL_FILE)
  const baseUrl = record?.baseUrl
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
    throw new Error("midad is running but api-url.json is missing or invalid; restart midad")
  }
  return baseUrl
}

/**
 * The Context API address for an owner-facing session, exactly as Runtime.open resolves it: a
 * configured storage URL wins; else a running daemon's published address; else the home lock
 * plus a fresh local server. Shared so the passkey session — which has no owner secrets to open
 * a Runtime with — resolves the same address the same way.
 */
async function resolveOwnerApi(
  home: MidaHome,
  network: Network,
  timing?: LockTiming,
): Promise<{ apiBaseUrl: string; server?: { baseUrl: string; close(): Promise<void> }; locked: boolean }> {
  const storageUrl = parseStorageUrl(network.storageUrl)
  let server: { baseUrl: string; close(): Promise<void> } | undefined
  let apiBaseUrl: string
  let locked = false
  if (storageUrl !== undefined) {
    apiBaseUrl = storageUrl
  } else {
    apiBaseUrl = (await daemonApiBaseUrl(home)) ?? ""
    if (apiBaseUrl === "") {
      try {
        await acquireHomeLock(home, timing?.lockWaitMs ?? 30_000, timing?.lockStepMs ?? 250, { role: "command", ps: timing?.ps })
        locked = true
      } catch (error) {
        // The holder may be a daemon mid-start: if it has come up since, use its API instead of failing.
        const running = await daemonApiBaseUrl(home)
        if (running === undefined) throw error
        apiBaseUrl = running
      }
    }
    if (locked) {
      try {
        server = await startPersistentApi({ rpcUrl: network.rpcUrl, deployment: network.deployment, dataDir: home.path("data") })
        apiBaseUrl = server.baseUrl
      } catch (error) {
        home.remove(LOCK_FILE)
        throw error
      }
    }
  }
  return { apiBaseUrl, server, locked }
}

/**
 * The runtime the daemon and the drainer run. It knows the owner's public address — enough to
 * verify the signed approved-projects list and to ask the chain about grants — and it holds only
 * agent keys. There is no owner account, no owner wallet client, no vault and no way to build
 * one: owner secrets are never read on this path, and that absence is a compile-time fact about
 * the type, not a flag.
 */
export class ServiceRuntime {
  readonly #close: () => Promise<void>
  /**
   * The operation's shared read memo — set only on the facades `readScope` returns. Agents
   * built through a scoped runtime wrap their fresh client with it, so every identical
   * read-only chain call in the operation is one wire request (in-9 R-5).
   */
  #reads?: ReadScope
  /**
   * CHAIN-04: opened epoch keys, kept for this runtime's life and shared with every agent it
   * builds and every read scope it hands out — agents are rebuilt per call (so grants and revokes
   * are always fresh), but a past epoch's key never changes. Measured on testnet Oct 1: the two
   * wrap fetches were ~2 s of a ~5-6 s handoff read, every read. Memory only, never on disk.
   */
  #epochKeys: EpochKeyCache = new Map()
  readonly reader: RegistryReader
  /**
   * One plain line to the owner while a slow step runs — the `mida` command sets it to STDERR;
   * every other entry point (daemon, drainer, hooks, tests) leaves it unset and the library
   * stays silent. It never carries a key, a seed, a signature or a full hex value.
   */
  progress?: (line: string) => void

  protected constructor(
    readonly home: MidaHome,
    readonly network: Network,
    readonly owner: Address,
    readonly chain: ChainContext,
    readonly apiBaseUrl: string,
    close: () => Promise<void>,
  ) {
    this.#close = close
    this.reader = new RegistryReader(chain)
  }

  static async open(home: MidaHome, network: Network, options?: OpenOptions): Promise<ServiceRuntime> {
    const storageUrl = parseStorageUrl(network.storageUrl)
    parseSponsorUrl(network.sponsorUrl) // a malformed sponsor URL is refused before the lock too
    const owner = loadOwnerAddress(home)
    if (owner === undefined) {
      const error = new Error("owner-address.json is missing — run `mida init` first") as Error & { code: string }
      error.code = "no-owner-address"
      throw error
    }
    await acquireHomeLock(home, options?.lockWaitMs ?? 30_000, options?.lockStepMs ?? 250, { role: options?.role ?? "service", ps: options?.ps })
    let server: { baseUrl: string; close(): Promise<void> } | undefined
    try {
      if (storageUrl === undefined) {
        server = await startPersistentApi({ rpcUrl: network.rpcUrl, deployment: network.deployment, dataDir: home.path("data") })
      }
      const apiBaseUrl = storageUrl ?? server!.baseUrl
      home.writeSecretJson(API_URL_FILE, { baseUrl: apiBaseUrl })
      const chain: ChainContext = {
        publicClient: createPublicClient({ chain: chainFor(network.deployment.chainId), batch: { multicall: true }, transport: rpcTransport(network.rpcUrl) }),
        deployment: network.deployment,
      }
      return new ServiceRuntime(home, network, owner, chain, apiBaseUrl, async () => {
        try {
          await server?.close()
        } finally {
          home.remove(API_URL_FILE)
          home.remove(LOCK_FILE)
        }
      })
    } catch (error) {
      if (server !== undefined) await server.close()
      home.remove(API_URL_FILE)
      home.remove(LOCK_FILE)
      throw error
    }
  }

  /**
   * The passkey-owner session (M3-F2): the same Context API resolution and the same read surface
   * Runtime.open offers owner commands, minus every piece that needs an owner secret — there is
   * no owner account, no wallet context, no vault. Passkey commands send nothing themselves; the
   * page does the signing. The owner address comes from owner-address.json — written by
   * `mida init --passkey` after the chain proved the passkey's key is registered.
   */
  static async openOwnerSession(home: MidaHome, network: Network, timing?: LockTiming): Promise<ServiceRuntime> {
    parseSponsorUrl(network.sponsorUrl) // a malformed URL is refused before any work, as in Runtime.open
    const owner = loadOwnerAddress(home)
    if (owner === undefined) {
      const error = new Error("owner-address.json is missing — run `mida init --passkey` first") as Error & { code: string }
      error.code = "no-owner-address"
      throw error
    }
    const { apiBaseUrl, server, locked } = await resolveOwnerApi(home, network, timing)
    try {
      const chain: ChainContext = {
        publicClient: createPublicClient({ chain: chainFor(network.deployment.chainId), batch: { multicall: true }, transport: rpcTransport(network.rpcUrl) }),
        deployment: network.deployment,
      }
      return new ServiceRuntime(home, network, owner, chain, apiBaseUrl, async () => {
        try {
          await server?.close()
        } finally {
          if (locked) home.remove(LOCK_FILE)
        }
      })
    } catch (error) {
      if (server !== undefined) await server.close()
      if (locked) home.remove(LOCK_FILE)
      throw error
    }
  }

  /**
   * Rebuilt from disk on every call: a grant or revocation written by the owner command after
   * this runtime opened must be visible on the very next drain pass or handoff, so nothing is
   * cached here.
   */
  agent(name: string): MidaAgent {
    const identity = loadAgentIdentity(this.home, name)
    if (identity === undefined) throw agentNotSetup(name)
    return buildAgent(this.home, this.network, this.apiBaseUrl, identity, (line) => this.progress?.(line), this.#reads, this.#epochKeys)
  }

  /**
   * One operation's view of this runtime (in-9 R-5). The facade shares everything — home,
   * owner, API, deployment — except the chain reads: its own `chain`/`reader` and every agent
   * it builds run through a memo that answers each identical read-only call (same function,
   * same args, same block tag) with one wire request, and — when `deadlineMs` is given — that
   * starts no new chain read once the operation's budget is spent, so an abandoned handoff
   * stops consuming the shared RPC limiter.
   *
   * The memo is a per-operation snapshot by design: build a fresh scope per operation and a
   * revocation written between two operations is always seen by the second — the memo can
   * only ever hold what the chain already answered inside this one.
   */
  readScope(options?: { deadlineMs?: number }): ServiceRuntime {
    const scope = createReadScope(options)
    const scoped = new ServiceRuntime(
      this.home,
      this.network,
      this.owner,
      { publicClient: memoizedReads(this.chain.publicClient, scope), deployment: this.chain.deployment },
      this.apiBaseUrl,
      // the facade owns nothing: close() stays with the real runtime
      async () => {},
    )
    scoped.#reads = scope
    scoped.#epochKeys = this.#epochKeys // the scoped facade shares the real runtime's keys
    scoped.progress = this.progress
    return scoped
  }

  close(): Promise<void> {
    return this.#close()
  }
}

/**
 * The owner-facing runtime — what `mida` opens for the length of one owner command. It is the
 * only runtime that loads `owner/secrets.json` and the only one that can sign as the owner.
 * While the daemon is up it reuses the daemon's Context API (found via api-url.json) so the lock
 * is never contended; daemonless it takes the lock and runs its own server exactly as before.
 */
export class Runtime extends ServiceRuntime {
  readonly #agents = new Map<string, MidaAgent>()
  readonly ownerChain: LocalWriteContext
  readonly ownerApi: ContextApiClient
  readonly vault: FakeVaultAuthority
  readonly ownerStartBlock: bigint

  private constructor(
    home: MidaHome,
    network: Network,
    ownerChain: LocalWriteContext,
    ownerApi: ContextApiClient,
    vault: FakeVaultAuthority,
    ownerStartBlock: bigint,
    apiBaseUrl: string,
    close: () => Promise<void>,
  ) {
    super(home, network, vault.owner, ownerChain, apiBaseUrl, close)
    this.ownerChain = ownerChain
    this.ownerApi = ownerApi
    this.vault = vault
    this.ownerStartBlock = ownerStartBlock
  }

  /**
   * `keys: "load-only"` makes the open read-only for owner material — a caller that must never
   * mint a key (export) opens this way; a missing `owner/secrets.json` then throws
   * `no-owner-key` instead of writing a fresh one into the home.
   */
  static override async open(
    home: MidaHome,
    network: Network,
    timing?: LockTiming,
    keys: "load-or-create" | "load-only" = "load-or-create",
  ): Promise<Runtime> {
    const sponsorUrl = parseSponsorUrl(network.sponsorUrl)
    const { apiBaseUrl, server, locked } = await resolveOwnerApi(home, network, timing)
    try {
      const secrets = keys === "load-only" ? loadOwnerSecrets(home) : loadOrCreateOwnerSecrets(home)
      if (secrets === undefined) {
        throw Object.assign(new Error("no owner key on this machine — export needs the local software owner key"), { code: "no-owner-key" })
      }
      const ownerAccount = privateKeyToAccount(secrets.privateKey)
      // An owner has no context before it existed. On a live chain the contract may have been deployed hundreds of
      // thousands of blocks ago, and the owner's own context scans would walk all of it.
      // The first open on this chain therefore records a start block and only the owner's own context scans from
      // it. The head-minus-margin shortcut is valid only for a brand-new owner: if this owner already sent any
      // transaction on this chain, its records could reach back to deploymentBlock, so that is the start.
      const probe = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: ownerAccount })
      const head = await probe.publicClient.getBlockNumber()
      let ownerStartBlock = loadOwnerStartBlock(home, network.deployment.chainId, {
        registry: network.deployment.capabilityRegistry,
        head,
      })
      if (ownerStartBlock === undefined) {
        const alreadyActive = (await probe.publicClient.getTransactionCount({ address: ownerAccount.address })) > 0
        const start = alreadyActive ? network.deployment.deploymentBlock : head - 10n
        ownerStartBlock = start > network.deployment.deploymentBlock ? start : network.deployment.deploymentBlock
        saveOwnerStartBlock(home, network.deployment.chainId, ownerStartBlock, network.deployment.capabilityRegistry)
      }
      const ownerChain = createWriteContext({
        rpcUrl: network.rpcUrl,
        deployment: { ...network.deployment, deploymentBlock: ownerStartBlock },
        account: ownerAccount,
      })
      const ownerApi = apiClient(apiBaseUrl, network.deployment, ownerAccount, undefined, home)
      const vault = new FakeVaultAuthority({ seed: bytesOf(secrets.seed, 32), p256PrivateKey: secrets.p256PrivateKey, chain: ownerChain, api: ownerApi })
      const runtime = new Runtime(home, network, ownerChain, ownerApi, vault, ownerStartBlock, apiBaseUrl, async () => {
        await server?.close()
        if (locked) home.remove(LOCK_FILE)
      })
      // R4-4: every owner send checks the wallet can pay before it goes out. Both closures read
      // runtime.progress at send time so the CLI can attach its line after open — the sponsor
      // fallback explains itself through the second one.
      ownerChain.beforeSend = makeOwnerBalanceGuard({
        chain: ownerChain,
        fund: network.fund,
        progress: (line) => runtime.progress?.(line),
      })
      ownerChain.progress = (line) => runtime.progress?.(line)
      if (sponsorUrl !== undefined) {
        // The owner still signs every call; the sponsor only pays the gas (M3-D). The progress
        // line is the same deferred read — a slow receipt wait surfaces on the CLI after open.
        ownerChain.sponsor = createSponsoredSender({
          sponsorUrl,
          rpcUrl: network.rpcUrl,
          account: ownerAccount,
          deployment: network.deployment,
          progress: (line) => runtime.progress?.(line),
        })
      }
      for (const name of listAgentNames(home)) runtime.attach(loadAgentIdentity(home, name)!)
      return runtime
    } catch (error) {
      if (server !== undefined) await server.close()
      if (locked) home.remove(LOCK_FILE)
      throw error
    }
  }

  /**
   * One progress line for a send the owner's context is about to make — "(sponsored)" when that
   * context carries a sponsor, the old timing hint when the wallet itself pays (M3-D3). Reading
   * `ownerChain.sponsor` rather than a flag or the network config is what keeps the line true:
   * it answers for the exact context the send will run through.
   */
  sendProgress(what: string): void {
    this.progress?.(`${what} (${this.ownerChain.sponsor !== undefined ? "sponsored" : "about 5 seconds"})…`)
  }

  /** Builds the agent from its saved identity and the grants it completed before, and keeps it for `agent(name)`. */
  attach(identity: AgentIdentity): MidaAgent {
    const agent = buildAgent(this.home, this.network, this.apiBaseUrl, identity, (line) => this.progress?.(line))
    this.#agents.set(identity.name, agent)
    return agent
  }

  override agent(name: string): MidaAgent {
    const agent = this.#agents.get(name)
    if (agent === undefined) throw agentNotSetup(name)
    return agent
  }

  /**
   * 0.2 MON from the owner wallet to `address` — the top-up for networks that have no funder
   * (the published CLI ships without a deployer key). The send runs through the owner's own
   * balance guard, so an owner that cannot afford it fails as OWNER_WALLET_LOW with the real
   * numbers, and the init refusal prints the owner address, not a bare node error.
   */
  async topUpFromOwner(address: Address, gate?: SendGate): Promise<void> {
    await sendValue(this.ownerChain, { to: address, value: OWNER_TOP_UP_WEI }, "funding", gate)
  }

  async ensureFunded(address: Address, label?: string): Promise<void> {
    const balance = await this.ownerChain.publicClient.getBalance({ address })
    if (balance >= MIN_BALANCE_WEI) return
    // With no funder the owner wallet tops the account up itself (M3-C) — the one account that
    // cannot top itself up is the owner: below the line that is the refusal the CLI prints the
    // send-MON instruction for.
    const fund =
      this.network.fund ??
      (address === this.owner ? undefined : (target: Address) => this.topUpFromOwner(target))
    if (fund === undefined) {
      const whose = label ?? "the wallet"
      throw new MidaError(
        "OWNER_WALLET_LOW",
        `${whose} holds ${formatMon(balance)} MON and needs ${formatMon(MIN_BALANCE_WEI)} MON to start — ${formatMon(MIN_BALANCE_WEI - balance)} MON short`,
      )
    }
    if (label !== undefined) this.progress?.(`topping up ${label}…`)
    await fund(address)
  }
}

/** A wei amount printed as MON to four decimal places, truncated — never rounded up past the truth. */
export function formatMon(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = (wei % 1_000_000_000_000_000_000n) / 100_000_000_000_000n
  return `${whole}.${frac.toString().padStart(4, "0")}`
}

/**
 * The pre-send check wired onto the owner's write context (R4-4, priced like the send in R5-9).
 * Before a transaction goes out it compares the wallet's balance with the cost the node will
 * verify — gas limit × the send's OWN maxFeePerGas, plus any transferred value. On a network
 * with a funder the wallet is topped up and the send continues; without one the send is
 * refused with OWNER_WALLET_LOW naming the balance, the cost and the shortfall — never an
 * opaque "insufficient funds" from deep inside the send.
 */
export function makeOwnerBalanceGuard(input: {
  chain: LocalWriteContext
  fund?: (address: Address, gate?: SendGate) => Promise<void>
  progress?: (line: string) => void
}): (cost: SendCost, gate?: SendGate) => Promise<void> {
  const payer = input.chain.account.address
  // `bound` marks the cost as a ceiling-priced upper bound (the node's own estimate refused to
  // run): the sentence says "up to" rather than claiming the exact figure the estimate refused
  // to produce (M3-D6 item 1).
  const low = (balance: bigint, cost: bigint, bound: boolean) =>
    new MidaError(
      "OWNER_WALLET_LOW",
      `your wallet holds ${formatMon(balance)} MON but this transaction needs ${bound ? "up to " : ""}${formatMon(cost)} MON — ${formatMon(cost - balance)} MON short`,
    )
  return async ({ gasLimit, fee, value, upperBound }, gate) => {
    const cost = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) + (value ?? 0n)
    const bound = upperBound === true
    let balance = await input.chain.publicClient.getBalance({ address: payer })
    if (balance >= cost) return
    if (input.fund === undefined) throw low(balance, cost, bound)
    input.progress?.("topping up your wallet…")
    // The top-up is a send of its own — it inherits this send's abandonment, so a funder still
    // working when the outer cap fired cannot broadcast after the refusal was already reported
    // (in-18 S4).
    await input.fund(payer, gate)
    // A fixed top-up can under-shoot a big send (a revoke.agent at the ceiling needs more than
    // 0.2 MON) — so after the funder's own wait the balance is read AGAIN; still short is a
    // refusal with the real numbers, never a loop and never a send that dies at the node.
    balance = await input.chain.publicClient.getBalance({ address: payer })
    if (balance < cost) throw low(balance, cost, bound)
  }
}
