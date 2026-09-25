import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"
import { createPublicClient, http } from "viem"
import { monadTestnet } from "viem/chains"
import { MAX_LOG_BLOCK_RANGE, MONAD_TESTNET_CHAIN_ID, chainFor, loadDeployment, parseDeployment } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import type { MidaHome } from "./home.js"
import type { Network } from "./runtime.js"
import { HOSTED_SPONSOR_URL, HOSTED_STORAGE_URL, serviceUrlInEffect } from "./runtime.js"
import { funderFor } from "./testnet.js"

/**
 * The ONE rule for which contract, RPC, store and sponsor a home uses — every entry point
 * resolves through here so the `mida` command, the daemon, the drainer and doctor can never
 * again answer about two different contracts (the Sep 22 split: the command ran the contract
 * built into the code while the service ran the one the setup saved).
 *
 * In one line: if the home saved it, the saved value wins; the built-in record is only for a
 * brand-new home. The full table is the plan's Task 1
 * (docs/superpowers/plans/2026-09-22-a-deployment-binding.md):
 *
 *   no network.json     built-in record (or MIDA_DEPLOYMENTS_DIR's), env RPC or the viem
 *                       default, the hosted services — exactly testnetNetwork's behaviour
 *   network.json        its saved deployment and rpcUrl; a service it never saved is the
 *                       LOCAL store / self-paid gas, never the hosted default
 *   environment         wins over the saved file in both directions: a URL replaces the
 *                       saved value, "off" disables it; an env value that is the empty
 *                       string counts as unset
 *   MIDA_DEPLOYMENTS_DIR naming a different contract than a saved network.json is a
 *                       `deployment-conflict` refusal, never a silent override
 */
export type ServiceSource = "environment" | "off" | "network.json" | "local" | "hosted-default"

export interface ResolvedNetwork {
  network: Network // what the process must use
  saved: boolean // true when network.json existed
  contractSource: "network.json" | "built-in" | "deployments-dir"
  builtIn: Deployment // the record this code ships (or MIDA_DEPLOYMENTS_DIR's)
  /** set when saved and the built-in record names a different contract */
  mismatch?: { saved: string; builtIn: string } // capabilityRegistry addresses, lowercase
  storage: { url: string | undefined; source: ServiceSource }
  sponsor: { url: string | undefined; source: ServiceSource }
}

export interface ResolveDeps {
  /** default: loadDeployment(MONAD_TESTNET_CHAIN_ID, env.MIDA_DEPLOYMENTS_DIR) — tests inject */
  loadBuiltIn?: () => Deployment
  /** default true: the testnetNetwork chain-id probe; daemon, drainer and doctor pass false */
  probeChainId?: boolean
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** An env value that is present but empty counts as unset, everywhere this rule reads one. */
function unset(value: string | undefined): value is undefined | "" {
  return value === undefined || value === ""
}

/**
 * MIDA_LOG_BLOCK_RANGE: the eth_getLogs window a history scan opens with — an integer
 * 1..MAX_LOG_BLOCK_RANGE. Anything else (missing, empty, non-numeric, out of range) is ignored
 * and the library default stands; a bad value must never crash a command.
 */
function parseLogBlockRange(raw: string | undefined): bigint | undefined {
  if (unset(raw) || !/^\d+$/.test(raw)) return undefined
  const value = BigInt(raw)
  return value >= 1n && value <= MAX_LOG_BLOCK_RANGE ? value : undefined
}

/** "Same contract" = same chainId and the same two registry addresses, compared lowercase. */
function sameContract(a: Deployment, b: Deployment): boolean {
  return (
    a.chainId === b.chainId &&
    a.capabilityRegistry.toLowerCase() === b.capabilityRegistry.toLowerCase() &&
    a.contextRegistry.toLowerCase() === b.contextRegistry.toLowerCase()
  )
}

export interface SavedNetwork {
  rpcUrl: string
  deployment: Deployment
  storageUrl?: string
  sponsorUrl?: string
  /** The batched-lane switch `mida batching on|off` writes; absent means off. */
  batching?: boolean
}

/**
 * The home's network.json, parsed and checked. undefined only when the file is absent; a file
 * that exists but cannot be parsed, lacks rpcUrl/deployment, or carries a deployment
 * parseDeployment refuses is a `network-json-invalid` refusal — corrupt is never treated as
 * missing, and a broken file never silently falls back to the built-in record.
 */
export function readSavedNetwork(home: MidaHome): SavedNetwork | undefined {
  if (!home.has("network.json")) return undefined
  let stored: { rpcUrl?: unknown; deployment?: unknown; storageUrl?: unknown; sponsorUrl?: unknown; batching?: unknown } | undefined
  try {
    stored = home.readJson("network.json")
  } catch {
    throw codedError("network-json-invalid", "network.json exists but could not be parsed")
  }
  if (typeof stored?.rpcUrl !== "string" || stored.rpcUrl === "" || stored.deployment === undefined) {
    throw codedError("network-json-invalid", "network.json is missing rpcUrl or deployment")
  }
  let deployment: Deployment
  try {
    deployment = parseDeployment(stored.deployment)
  } catch {
    throw codedError("network-json-invalid", "network.json's deployment could not be parsed")
  }
  return {
    rpcUrl: stored.rpcUrl,
    deployment,
    storageUrl: typeof stored.storageUrl === "string" && stored.storageUrl !== "" ? stored.storageUrl : undefined,
    sponsorUrl: typeof stored.sponsorUrl === "string" && stored.sponsorUrl !== "" ? stored.sponsorUrl : undefined,
    ...(typeof stored.batching === "boolean" ? { batching: stored.batching } : {}),
  }
}

export async function resolveNetwork(
  home: MidaHome,
  env: Record<string, string | undefined>,
  deps?: ResolveDeps,
): Promise<ResolvedNetwork> {
  const deploymentsDir = unset(env.MIDA_DEPLOYMENTS_DIR) ? undefined : env.MIDA_DEPLOYMENTS_DIR
  const loadBuiltIn = deps?.loadBuiltIn ?? (() => loadDeployment(MONAD_TESTNET_CHAIN_ID, deploymentsDir))
  const saved = readSavedNetwork(home)
  const builtIn = loadBuiltIn()

  // A deployments dir that names a different contract than the setup's own file is a conflict
  // to refuse, never a silent override — the operator pointed at two records at once.
  if (saved !== undefined && deploymentsDir !== undefined && !sameContract(saved.deployment, builtIn)) {
    throw codedError(
      "deployment-conflict",
      `MIDA_DEPLOYMENTS_DIR names a different contract (${builtIn.capabilityRegistry}) than this setup's network.json (${saved.deployment.capabilityRegistry})`,
    )
  }

  // An older saved deployment predates BatchAnchor — the contract that anchors many saves in one
  // transaction — so it carries no `batchAnchor` field. When the saved deployment is provably the
  // SAME deployment the built-in record describes (same chain, same two registries) the shipped
  // anchor and its block are adopted into the resolved deployment — additive only, no other saved
  // field is replaced, a mismatched contract adopts nothing, and network.json is never rewritten.
  const deployment =
    saved !== undefined &&
    saved.deployment.batchAnchor === undefined &&
    builtIn.batchAnchor !== undefined &&
    sameContract(saved.deployment, builtIn)
      ? { ...saved.deployment, batchAnchor: builtIn.batchAnchor, batchAnchorBlock: builtIn.batchAnchorBlock }
      : saved?.deployment ?? builtIn
  const envRpc = env.MONAD_TESTNET_RPC
  const rpcUrl = !unset(envRpc) ? envRpc : saved?.rpcUrl ?? monadTestnet.rpcUrls.default.http[0]

  // One resolution shared by store and sponsor: the environment wins in both directions, then
  // the saved file — and only a FIRST-time home falls through to the hosted default. A home
  // that saved no service address runs the local store and pays its own gas ("local"), because
  // that is what it was doing when it was made.
  const service = (
    raw: string | undefined,
    storedUrl: string | undefined,
    hosted: string,
  ): { url: string | undefined; source: ServiceSource } => {
    const resolved = serviceUrlInEffect(raw, storedUrl, hosted)
    if (resolved.source !== "default") return { url: resolved.url, source: resolved.source }
    return saved === undefined
      ? { url: resolved.url, source: "hosted-default" }
      : { url: undefined, source: "local" }
  }
  const storage = service(env.MIDA_STORAGE_URL, saved?.storageUrl, HOSTED_STORAGE_URL)
  const sponsor = service(env.MIDA_SPONSOR_URL, saved?.sponsorUrl, HOSTED_SPONSOR_URL)

  if (deps?.probeChainId ?? true) {
    // The same one RPC call testnetNetwork makes, against the RESOLVED deployment: a wrong-RPC
    // mistake writes registrations to the wrong chain and nothing afterwards explains why.
    const probe = createPublicClient({ chain: chainFor(deployment.chainId), transport: http(rpcUrl) })
    const chainId = await probe.getChainId()
    if (BigInt(chainId) !== deployment.chainId) {
      throw new Error(`RPC ${rpcUrl} is chain ${chainId}, not Monad testnet ${deployment.chainId}`)
    }
  }

  const fund = funderFor(env, rpcUrl, deployment)
  const logBlockRange = parseLogBlockRange(env.MIDA_LOG_BLOCK_RANGE)
  const network: Network = {
    rpcUrl,
    deployment,
    ...(fund === undefined ? {} : { fund }),
    ...(storage.url === undefined ? {} : { storageUrl: storage.url }),
    ...(sponsor.url === undefined ? {} : { sponsorUrl: sponsor.url }),
    ...(logBlockRange === undefined ? {} : { logBlockRange }),
  }
  const mismatch =
    saved !== undefined && !sameContract(saved.deployment, builtIn)
      ? { saved: saved.deployment.capabilityRegistry.toLowerCase(), builtIn: builtIn.capabilityRegistry.toLowerCase() }
      : undefined
  return {
    network,
    saved: saved !== undefined,
    contractSource: saved !== undefined ? "network.json" : deploymentsDir !== undefined ? "deployments-dir" : "built-in",
    builtIn,
    ...(mismatch === undefined ? {} : { mismatch }),
    storage,
    sponsor,
  }
}

const shortAddress = (a: string): string => `${a.slice(0, 6)}…`

/** One line for owner commands and doctor, or undefined when there is no mismatch. */
export function mismatchLine(resolved: ResolvedNetwork): string | undefined {
  if (resolved.mismatch === undefined) return undefined
  return `this setup is on contract ${shortAddress(resolved.mismatch.saved)}; this version of Mida ships ${shortAddress(resolved.mismatch.builtIn)} — run \`mida migrate\` to move`
}

/**
 * The stderr line an owner command prints when the saved setup sits on another contract than
 * this build ships. `migrate` IS the move, so it hears what it is about to do — "run mida
 * migrate" would tell the owner to run the command they are already running.
 */
export function ownerCommandNotice(resolved: ResolvedNetwork, command: string): string | undefined {
  if (resolved.mismatch === undefined) return undefined
  if (command === "migrate") {
    return `moving this setup from contract ${shortAddress(resolved.mismatch.saved)} to ${shortAddress(resolved.mismatch.builtIn)}`
  }
  return mismatchLine(resolved)
}

/**
 * For daemon-main and drain-main: undefined when the home has no network.json (their
 * first-time behaviour stays theirs); otherwise the resolved network with no chain probe.
 */
export async function serviceNetwork(
  home: MidaHome,
  env: Record<string, string | undefined>,
): Promise<Network | undefined> {
  if (!home.has("network.json")) return undefined
  return (await resolveNetwork(home, env, { probeChainId: false })).network
}

/**
 * Writes `batching` into network.json while leaving every other byte untouched. When the flag
 * already exists only its value token is replaced in place; when it does not, the flag is
 * inserted as the file's first key at the file's own indentation, so field order, spacing and the
 * whole deployment block survive byte-for-byte. Only a file whose shape the surgical edit cannot
 * honour — a non-canonical layout — is rewritten whole (its values still preserved). A missing or
 * unparsable file is a refusal, never a rewrite.
 */
export function setBatchingFlag(home: MidaHome, on: boolean): void {
  const file = home.path("network.json")
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    throw codedError("network-json-invalid", "network.json is missing or unreadable")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw codedError("network-json-invalid", "network.json could not be parsed")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw codedError("network-json-invalid", "network.json is not a JSON object")
  }
  const value = on ? "true" : "false"
  const span = batchingSpan(text)
  let next: string | undefined
  if (Object.hasOwn(parsed, "batching")) {
    if (span?.kind === "replace") next = text.slice(0, span.start) + value + text.slice(span.end)
    // a "batching" the scanner cannot place (an escaped key) falls to the full rewrite below —
    // inserting a second raw key would lose to it, because JSON.parse keeps the last duplicate
  } else if (span?.kind === "insert-pair") {
    next = text.slice(0, span.at) + span.leading + `"batching": ${value},` + span.leading + text.slice(span.at + span.leading.length)
  } else if (span?.kind === "insert-value") {
    next = text.slice(0, span.at) + `"batching": ${value}` + text.slice(span.at)
  }
  // a surgical splice that does not leave batching === on — a second top-level "batching" key
  // later in the object would still win the parse — falls back to the whole-file rewrite
  if (next !== undefined) {
    const check = JSON.parse(next) as { batching?: unknown }
    if (check.batching !== on) next = undefined
  }
  next ??= JSON.stringify({ ...(parsed as Record<string, unknown>), batching: on }, null, 2)
  writeFileAtomic(file, next)
}

/**
 * Where the top-level `"batching"` key sits inside a JSON object's raw text. `replace` is the
 * existing value's span; `insert-pair` splices `"batching": <v>,` before the first key, reusing
 * that key's leading whitespace so the file keeps its own layout; `insert-value` is the empty
 * object. Keys are matched as raw text at depth 1 only — a `"batching"` nested inside another
 * field is never touched. null when the text is not a well-formed object; the caller then
 * rewrites the file whole.
 */
function batchingSpan(
  text: string,
): { kind: "replace"; start: number; end: number } | { kind: "insert-pair"; at: number; leading: string } | { kind: "insert-value"; at: number } | null {
  const open = text.indexOf("{")
  if (open === -1) return null
  const n = text.length
  let i = open + 1
  const ws = (): void => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1
  }
  const skipString = (): void => {
    i += 1 // opening quote
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\") i += 1
      i += 1
    }
    i += 1 // closing quote (i === n when unterminated — the callers' checks fail next)
  }
  const skipValue = (): boolean => {
    ws()
    const ch = text[i]
    if (ch === '"') {
      skipString()
      return true
    }
    if (ch === "{" || ch === "[") {
      const stack: string[] = []
      for (; i < n; i += 1) {
        const c = text[i]
        if (c === '"') {
          skipString()
          i -= 1 // the loop's own step moves past the closing quote
        } else if (c === "{") {
          stack.push("}")
        } else if (c === "[") {
          stack.push("]")
        } else if (c === "}" || c === "]") {
          if (stack.pop() !== c) return false
          if (stack.length === 0) {
            i += 1
            return true
          }
        }
      }
      return false
    }
    // a scalar: consume until the next structural character or whitespace
    while (i < n && text[i] !== "," && text[i] !== "}" && text[i] !== "]" && text[i] !== " " && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") i += 1
    return true
  }
  ws()
  if (i >= n) return null
  if (text[i] === "}") return { kind: "insert-value", at: open + 1 }
  if (text[i] !== '"') return null
  const leading = text.slice(open + 1, i) // the whitespace before the first key — reused on insert
  for (;;) {
    if (text[i] !== '"') return null
    const keyStart = i + 1
    skipString()
    const name = text.slice(keyStart, i - 1)
    ws()
    if (text[i] !== ":") return null
    i += 1
    ws()
    const valueStart = i
    if (!skipValue()) return null
    if (name === "batching") return { kind: "replace", start: valueStart, end: i }
    ws()
    if (text[i] === ",") {
      i += 1
      ws()
      continue
    }
    if (text[i] === "}") return { kind: "insert-pair", at: open + 1, leading }
    return null
  }
}

/** The same durability writeSecretJson gives: a 0600 temp file, fsync, rename, folder fsync. */
function writeFileAtomic(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  const folder = openSync(dirname(file), "r")
  try {
    fsyncSync(folder)
  } finally {
    closeSync(folder)
  }
}
