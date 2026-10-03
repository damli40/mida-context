import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import { MONAD_TESTNET_CHAIN_ID, createSponsoredSender, createWriteContext, loadDeployment, parseDeployment } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import { bytesOf } from "@mida/crypto"
import { MidaError } from "@mida/protocol"
import type { AccessRequest, Address, Hex } from "@mida/protocol"
import { MidaAgent } from "./agent.js"
import type { AccessRequestInput, Grant } from "./agent.js"
import type { AccessRequestStore, StoredAccessRequest } from "./request-store.js"
import { fsyncFolder, writeSecretJson } from "./durability.js"

/**
 * The public endpoints the published CLI and this SDK default to — the same constants
 * `apps/midad` uses, re-exported there so there is one definition. "off" anywhere a URL is
 * accepted opts back into the local store or self-paid gas.
 */
export const HOSTED_STORAGE_URL = "https://store.midacontext.xyz"
export const HOSTED_SPONSOR_URL = "https://sponsor.midacontext.xyz"

const AGENT_NAME = /^[a-z0-9-]{1,64}$/
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** An agent identity as `mida init` writes it, or as an integrator holds it out-of-band. */
export interface ConnectIdentity {
  agentId: Hex
  signerPrivateKey: Hex
  encryptionPrivateKey: Hex | Uint8Array
  callbackOrigin: string
}

/**
 * The network to connect to. Every field is optional: with no `network` at all the defaults are
 * Monad testnet's public RPC, the embedded deployment record, the hosted store and the hosted
 * sponsor. `"off"` on `storageUrl` means "the Context API the local daemon is serving" (home
 * mode discovers it from `api-url.json`); on `sponsorUrl` it means "this wallet pays its own gas".
 */
export interface ConnectNetwork {
  rpcUrl?: string
  deployment?: Deployment
  storageUrl?: string
  sponsorUrl?: string
}

export interface ConnectOptions {
  /**
   * Home mode: the name `mida init` provisioned the agent under. The identity, the grants
   * completed so far, the owner address and the network all load from the Mida home
   * (`midaHome`, `$MIDA_HOME`, or `~/.mida`), and `requestAccess` files the pending request
   * where `mida approve <name>` finds it.
   */
  name?: string
  /** The Mida home directory. Default: `$MIDA_HOME`, then `~/.mida`. */
  midaHome?: string
  /** Environment overrides; defaults to `process.env`. `MIDA_HOME`, `MONAD_TESTNET_RPC`,
   *  `MIDA_STORAGE_URL`, `MIDA_SPONSOR_URL` and `MIDA_DEPLOYMENTS_DIR` are read. */
  env?: Record<string, string | undefined>
  /**
   * Explicit mode: the identity fields directly, no home files read. `owner` is then required —
   * it is the owner address the agent will ask about and write under.
   */
  identity?: ConnectIdentity
  owner?: Address
  network?: ConnectNetwork
  /** Defaults to the home-backed store in home mode, in-memory otherwise. */
  requests?: AccessRequestStore
  /** Completed grants from an earlier run; in home mode `grants.json` is loaded when this is omitted. */
  grants?: readonly Grant[]
}

/** What `connectAgent` returns: the agent plus the owner it connects to. */
export interface ConnectedAgent {
  agent: MidaAgent
  owner: Address
  /** Present in home mode. */
  name?: string
  /** Present in home mode — the directory the connection was loaded from. */
  midaHome?: string
  /**
   * `agent.createAccessRequest` plus, in home mode, recording the request as the pending one the
   * owner's `mida approve <name>` acts on. In explicit mode the returned request must reach the
   * owner's approval path some other way.
   */
  requestAccess(input: AccessRequestInput): Promise<AccessRequest>
}

/** A durable request store as one folder of `<requestId>.json` files plus `.consumed` markers —
 *  the same layout the Mida home keeps under `requests/<name>/`, so `mida approve` can complete a
 *  request this store saved. */
export class FileAccessRequestStore implements AccessRequestStore {
  readonly #dir: string
  readonly #platform: NodeJS.Platform

  constructor(dir: string, platform: NodeJS.Platform = process.platform) {
    this.#dir = dir
    this.#platform = platform
  }

  #file(requestId: Hex): string {
    if (!HEX_KEY.test(requestId)) throw new MidaError("INVALID_WIRE", "requestId must be 32 bytes of hex")
    return join(this.#dir, `${requestId.toLowerCase()}.json`)
  }

  async save(request: AccessRequest): Promise<void> {
    const file = this.#file(request.requestId)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    try {
      const fd = openSync(temp, "wx", 0o600)
      try {
        writeSync(fd, JSON.stringify(request, null, 2))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      try {
        linkSync(temp, file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MidaError("REPLAY", "requestId was already used")
        throw error
      }
    } finally {
      rmSync(temp, { force: true })
    }
  }

  async load(requestId: Hex): Promise<StoredAccessRequest | undefined> {
    const file = this.#file(requestId)
    if (!existsSync(file)) return undefined
    return { request: JSON.parse(readFileSync(file, "utf8")) as AccessRequest, consumed: existsSync(`${file}.consumed`) }
  }

  async markConsumed(requestId: Hex): Promise<void> {
    const file = this.#file(requestId)
    if (!existsSync(file)) throw new MidaError("NOT_FOUND", "no stored request for this requestId")
    let fd: number
    try {
      fd = openSync(`${file}.consumed`, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MidaError("REQUEST_CONSUMED", "this requestId was already completed")
      throw error
    }
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    fsyncFolder(this.#dir, this.#platform)
  }
}

function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, "utf8")) as T
}

function requireHex(record: Record<string, unknown>, field: string, file: string, pattern: RegExp): string {
  const value = record[field]
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${file}: field "${field}" is missing or malformed`)
  }
  return value
}

/** The `agents/<name>/identity.json` record `mida init` writes. */
function loadIdentity(home: string, name: string): ConnectIdentity {
  if (!AGENT_NAME.test(name)) throw new Error(`bad agent name: ${name}`)
  const file = join(home, "agents", name, "identity.json")
  const record = readJsonFile<Record<string, unknown>>(file)
  if (record === undefined) {
    throw new Error(`${file} is missing — agent "${name}" is not provisioned in this home; run \`mida init\` first`)
  }
  return {
    agentId: requireHex(record, "agentId", file, HEX_KEY).toLowerCase() as Hex,
    signerPrivateKey: requireHex(record, "signerPrivateKey", file, HEX_KEY) as Hex,
    encryptionPrivateKey: requireHex(record, "encryptionPrivateKey", file, HEX_KEY) as Hex,
    callbackOrigin:
      typeof record.callbackOrigin === "string" && record.callbackOrigin !== ""
        ? record.callbackOrigin
        : (() => { throw new Error(`${file}: field "callbackOrigin" is missing or is not a string`) })(),
  }
}

function loadOwner(home: string): Address {
  const file = join(home, "owner-address.json")
  const record = readJsonFile<Record<string, unknown>>(file)
  if (record === undefined) throw new Error(`${file} is missing — run \`mida init\` first`)
  return requireHex(record, "address", file, ADDRESS).toLowerCase() as Address
}

function loadGrantsFile(home: string, name: string): Grant[] {
  const file = `agents/${name}/grants.json`
  const grants = readJsonFile<unknown>(join(home, file))
  if (grants === undefined) return []
  if (!Array.isArray(grants)) throw new Error(`${file}: expected an array of grants`)
  for (const entry of grants) {
    const record = (entry ?? {}) as Record<string, unknown>
    for (const field of ["owner", "agentId", "requestId"] as const) {
      if (typeof record[field] !== "string") throw new Error(`${file}: field "${field}" is missing or is not a string`)
    }
    if (!Array.isArray(record.capabilities)) throw new Error(`${file}: field "capabilities" is missing or is not an array`)
  }
  return grants as Grant[]
}

/** One env-style service value → the URL in effect: unset means `fallback`, `off` means none. */
function serviceUrl(raw: string | undefined, fallback: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return fallback
  if (raw === "off") return undefined
  return raw
}

/**
 * Connects an agent to a Mida owner. This is the SDK's front door: it builds the chain context,
 * the Context API client and the `MidaAgent` from the provisioned identity (home mode) or fields
 * passed directly (explicit mode) — the pieces a consumer could never construct from the public
 * entry alone.
 */
export function connectAgent(options: ConnectOptions): ConnectedAgent {
  const env = options.env ?? process.env
  const homeMode = options.name !== undefined
  if (homeMode && options.identity !== undefined) throw new Error("connectAgent: pass either `name` (home mode) or `identity` (explicit), not both")
  if (!homeMode && options.identity === undefined) throw new Error("connectAgent: pass `name` or `identity`")

  const home =
    options.midaHome ??
    (env.MIDA_HOME !== undefined && env.MIDA_HOME !== "" ? env.MIDA_HOME : undefined) ??
    join(homedir(), ".mida")
  if (!isAbsolute(home)) throw new Error("the Mida home must be an absolute path (or unset for the default ~/.mida)")

  const identity = homeMode ? loadIdentity(home, options.name!) : options.identity!
  const owner = options.owner ?? (homeMode ? loadOwner(home) : undefined)
  if (owner === undefined) throw new Error("connectAgent: explicit mode needs `owner` (the owner's address — `mida init` prints it)")

  // The network init persisted (home mode) or the published defaults (explicit mode / no file).
  const stored = readJsonFile<{ rpcUrl?: unknown; deployment?: unknown; storageUrl?: unknown; sponsorUrl?: unknown }>(
    join(home, "network.json"),
  )
  const rpcUrl = options.network?.rpcUrl ?? env.MONAD_TESTNET_RPC ?? (typeof stored?.rpcUrl === "string" ? stored.rpcUrl : undefined) ?? monadTestnet.rpcUrls.default.http[0]
  const deployment =
    options.network?.deployment ??
    (stored?.deployment !== undefined ? parseDeployment(stored.deployment) : loadDeployment(MONAD_TESTNET_CHAIN_ID, env.MIDA_DEPLOYMENTS_DIR))

  // storageUrl: explicit option > env > network.json > hosted default. "off" (or a network.json
  // written without one) means the Context API the local daemon serves — discovered through
  // api-url.json, which a running midad maintains.
  const rawStorage = options.network?.storageUrl ?? env.MIDA_STORAGE_URL ?? (typeof stored?.storageUrl === "string" ? stored.storageUrl : stored !== undefined ? "off" : undefined)
  let storageUrl = serviceUrl(rawStorage, HOSTED_STORAGE_URL)
  if (storageUrl === undefined) {
    const apiRecord = readJsonFile<{ baseUrl?: unknown }>(join(home, "api-url.json"))
    storageUrl = typeof apiRecord?.baseUrl === "string" ? apiRecord.baseUrl : undefined
    if (storageUrl === undefined) {
      throw new Error("no Context API to reach — the local store needs a running midad (`mida init` starts one), or set MIDA_STORAGE_URL")
    }
  }

  // sponsorUrl: same precedence; "off" or a network.json without one means the agent's wallet
  // pays its own gas.
  const rawSponsor = options.network?.sponsorUrl ?? env.MIDA_SPONSOR_URL ?? (typeof stored?.sponsorUrl === "string" ? stored.sponsorUrl : stored !== undefined ? "off" : undefined)
  const sponsorUrl = serviceUrl(rawSponsor, HOSTED_SPONSOR_URL)

  const signer = privateKeyToAccount(identity.signerPrivateKey)
  const chain = createWriteContext({ rpcUrl, deployment, account: signer })
  if (sponsorUrl !== undefined) {
    // An agent signer holds no MON by design — the sponsor pays for its sends.
    chain.sponsor = createSponsoredSender({ sponsorUrl, rpcUrl, account: signer, deployment })
  }
  const api = new ContextApiClient({ baseUrl: storageUrl, account: signer, chainId: deployment.chainId, capabilityRegistry: deployment.capabilityRegistry })

  const name = homeMode ? options.name : undefined
  const requests = options.requests ?? (homeMode ? new FileAccessRequestStore(join(home, "requests", name!)) : undefined)
  const grants = options.grants ?? (homeMode ? loadGrantsFile(home, name!) : undefined)
  const agent = new MidaAgent({
    agentId: identity.agentId,
    callbackOrigin: identity.callbackOrigin,
    encryptionPrivateKey: typeof identity.encryptionPrivateKey === "string" ? bytesOf(identity.encryptionPrivateKey, 32) : identity.encryptionPrivateKey,
    chain,
    api,
    ...(requests === undefined ? {} : { requests }),
    ...(grants === undefined ? {} : { grants }),
  })

  return {
    agent,
    owner,
    ...(name === undefined ? {} : { name }),
    midaHome: home,
    requestAccess: async (input) => {
      const request = await agent.createAccessRequest(input)
      if (homeMode) writeSecretJson(join(home, "agents", name!, "pending-request.json"), { request })
      return request
    },
  }
}
