import { createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import { MidaError, PERMISSION } from "@mida/protocol"
import type { Address } from "@mida/protocol"
import { bytesOf } from "@mida/crypto"
import { chainFor, createSponsoredSender, createWriteContext, sendValue } from "@mida/chain"
import type { ChainContext, Deployment, LocalWriteContext, SendCost } from "@mida/chain"
import { ContextApiClient, RegistryReader } from "@mida/api"
import { FakeVaultAuthority } from "@mida/fake-vault"
import { MidaAgent } from "@mida/sdk"
import type { MidaHome } from "./home.js"
import { callDaemon } from "./control.js"
import { FileAccessRequestStore } from "./request-store.js"
import { listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOwnerSecrets, loadOwnerAddress, loadOwnerStartBlock, saveOwnerStartBlock } from "./keys.js"
import type { AgentIdentity } from "./keys.js"
import { startPersistentApi } from "./api-server.js"

export interface Network {
  rpcUrl: string
  deployment: Deployment
  /**
   * Tops an account up — exists on the networks that have a funder (local Anvil, Monad
   * testnet). Absent elsewhere: a low owner wallet then fails with OWNER_WALLET_LOW instead
   * of a bare transaction error (R4-4).
   */
  fund?(address: Address): Promise<void>
  /** When set, the Context API lives at this URL (a remote store, M3) and no local server is started. */
  storageUrl?: string
  /**
   * When set, sends go through this gas sponsor first — the wallet still signs, the sponsor pays
   * (M3-D). Same URL rules as storageUrl plus no embedded credentials; a bad value is a
   * `bad-sponsor-url` error raised before the lock or any chain call is touched.
   */
  sponsorUrl?: string
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
 * Takes the home's lock or throws. A live pid in an existing lock means another Mida process
 * holds it — the waiter retries in `stepMs` steps for up to `waitMs` before giving up, because a
 * drainer that fired during a long CLI run must not die on a transient hold. A dead or
 * unreadable lock is stale and is replaced. `createSecretJsonExclusive` makes the
 * check-then-create race-free.
 */
async function acquireHomeLock(home: MidaHome, waitMs: number, stepMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  let heldPid = 0
  for (;;) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (home.createSecretJsonExclusive(LOCK_FILE, { pid: process.pid })) return
      let pid = 0
      try {
        const held = home.readJson<{ pid?: unknown }>(LOCK_FILE)
        if (typeof held?.pid === "number") pid = held.pid
      } catch {
        // A lock file that will not parse is stale: take it over.
      }
      if (pid > 0 && processAlive(pid)) {
        heldPid = pid
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

function apiClient(baseUrl: string, deployment: Deployment, account: LocalAccount): ContextApiClient {
  return new ContextApiClient({ baseUrl, account, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry })
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
): MidaAgent {
  const signer = privateKeyToAccount(identity.signerPrivateKey)
  const chain = createWriteContext({ rpcUrl: network.rpcUrl, deployment: network.deployment, account: signer })
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
    api: apiClient(apiBaseUrl, network.deployment, signer),
    requests: new FileAccessRequestStore(home, identity.name),
    grants: loadGrants(home, identity.name),
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
 * The runtime the daemon and the drainer run. It knows the owner's public address — enough to
 * verify the signed approved-projects list and to ask the chain about grants — and it holds only
 * agent keys. There is no owner account, no owner wallet client, no vault and no way to build
 * one: owner secrets are never read on this path, and that absence is a compile-time fact about
 * the type, not a flag.
 */
export class ServiceRuntime {
  readonly #close: () => Promise<void>
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

  static async open(home: MidaHome, network: Network, timing?: { lockWaitMs?: number; lockStepMs?: number }): Promise<ServiceRuntime> {
    const storageUrl = parseStorageUrl(network.storageUrl)
    parseSponsorUrl(network.sponsorUrl) // a malformed sponsor URL is refused before the lock too
    const owner = loadOwnerAddress(home)
    if (owner === undefined) {
      const error = new Error("owner-address.json is missing — run `mida init` first") as Error & { code: string }
      error.code = "no-owner-address"
      throw error
    }
    await acquireHomeLock(home, timing?.lockWaitMs ?? 30_000, timing?.lockStepMs ?? 250)
    let server: { baseUrl: string; close(): Promise<void> } | undefined
    try {
      if (storageUrl === undefined) {
        server = await startPersistentApi({ rpcUrl: network.rpcUrl, deployment: network.deployment, dataDir: home.path("data") })
      }
      const apiBaseUrl = storageUrl ?? server!.baseUrl
      home.writeSecretJson(API_URL_FILE, { baseUrl: apiBaseUrl })
      const chain: ChainContext = {
        publicClient: createPublicClient({ chain: chainFor(network.deployment.chainId), transport: http(network.rpcUrl) }),
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
   * Rebuilt from disk on every call: a grant or revocation written by the owner command after
   * this runtime opened must be visible on the very next drain pass or handoff, so nothing is
   * cached here.
   */
  agent(name: string): MidaAgent {
    const identity = loadAgentIdentity(this.home, name)
    if (identity === undefined) throw agentNotSetup(name)
    return buildAgent(this.home, this.network, this.apiBaseUrl, identity, (line) => this.progress?.(line))
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

  static override async open(home: MidaHome, network: Network, timing?: { lockWaitMs?: number; lockStepMs?: number }): Promise<Runtime> {
    const storageUrl = parseStorageUrl(network.storageUrl)
    const sponsorUrl = parseSponsorUrl(network.sponsorUrl)
    let server: { baseUrl: string; close(): Promise<void> } | undefined
    let apiBaseUrl: string
    let locked = false
    if (storageUrl !== undefined) {
      apiBaseUrl = storageUrl
    } else {
      apiBaseUrl = await daemonApiBaseUrl(home) ?? ""
      if (apiBaseUrl === "") {
        try {
          await acquireHomeLock(home, timing?.lockWaitMs ?? 30_000, timing?.lockStepMs ?? 250)
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
    try {
      const secrets = loadOrCreateOwnerSecrets(home)
      const ownerAccount = privateKeyToAccount(secrets.privateKey)
      // An owner has no history before it existed. On a live chain the contract may have been deployed hundreds of
      // thousands of blocks ago, and ownerHistory would scan all of it in 100-block windows on every approveGrant.
      // The first open on this chain therefore records a start block and only the owner's own context scans from
      // it. The head-minus-margin shortcut is valid only for a brand-new owner: if this owner already sent any
      // transaction on this chain, its history could reach back to deploymentBlock, so that is the start.
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
      const ownerApi = apiClient(apiBaseUrl, network.deployment, ownerAccount)
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
  async topUpFromOwner(address: Address): Promise<void> {
    await sendValue(this.ownerChain, { to: address, value: OWNER_TOP_UP_WEI }, "funding")
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
  fund?: (address: Address) => Promise<void>
  progress?: (line: string) => void
}): (cost: SendCost) => Promise<void> {
  const payer = input.chain.account.address
  // `bound` marks the cost as a ceiling-priced upper bound (the node's own estimate refused to
  // run): the sentence says "up to" rather than claiming the exact figure the estimate refused
  // to produce (M3-D6 item 1).
  const low = (balance: bigint, cost: bigint, bound: boolean) =>
    new MidaError(
      "OWNER_WALLET_LOW",
      `your wallet holds ${formatMon(balance)} MON but this transaction needs ${bound ? "up to " : ""}${formatMon(cost)} MON — ${formatMon(cost - balance)} MON short`,
    )
  return async ({ gasLimit, fee, value, upperBound }) => {
    const cost = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) + (value ?? 0n)
    const bound = upperBound === true
    let balance = await input.chain.publicClient.getBalance({ address: payer })
    if (balance >= cost) return
    if (input.fund === undefined) throw low(balance, cost, bound)
    input.progress?.("topping up your wallet…")
    await input.fund(payer)
    // A fixed top-up can under-shoot a big send (a revoke.agent at the ceiling needs more than
    // 0.2 MON) — so after the funder's own wait the balance is read AGAIN; still short is a
    // refusal with the real numbers, never a loop and never a send that dies at the node.
    balance = await input.chain.publicClient.getBalance({ address: payer })
    if (balance < cost) throw low(balance, cost, bound)
  }
}
