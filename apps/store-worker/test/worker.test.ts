// M3-A item 6: the Worker entry end to end. esbuild produces the bundle workerd actually runs, Miniflare
// dispatches real requests into it, the stores are a real SQLite D1 and the reader is the real
// RegistryReader — the only thing stubbed is the chain itself, a JSON-RPC server that answers eth_call the
// way Monad would. The flow the brief demands: signed PUT → not visible (nothing anchored) → the chain
// reports it anchored → visible to a signer with READ, refused for one without.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, zeroHash } from "viem"
import type { Abi, LocalAccount } from "viem"
import { OWNER_AUTHOR_ID, PERMISSION, contextId as deriveContextId, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf, manifestHash } from "@mida/crypto"
import { contentHash } from "@mida/storage"
import { randomBytes } from "@noble/hashes/utils.js"
import { batchAnchorAbi, capabilityRegistryAbi, contextRegistryAbi } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { ContextApiClient } from "@mida/api"
import type { ContextRecordView, ObjectUploadBody } from "@mida/api"
import { d1Stores } from "@mida/store-worker"
import type { D1Like } from "@mida/store-worker"
import worker, { handleRequest } from "../src/worker.js"
import type { DurableObjectNamespaceLike, WorkerEnv } from "../src/worker.js"

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}
const NAMESPACE = namespaceId("goals.career")
const ABI: Abi = [...capabilityRegistryAbi, ...contextRegistryAbi, ...batchAnchorAbi]
const HERE = dirname(fileURLToPath(import.meta.url))

const ownerAccount = privateKeyToAccount(generatePrivateKey())
const owner = ownerAccount.address.toLowerCase() as Address
const agentAccount = privateKeyToAccount(generatePrivateKey())
const deniedAccount = privateKeyToAccount(generatePrivateKey())
const AGENT_ID = hexOf(randomBytes(32))
const DENIED_ID = hexOf(randomBytes(32))
const CAP_ID = hexOf(randomBytes(32))
const DENIED_CAP = hexOf(randomBytes(32))

/** Mutable chain state behind the stub RPC — the test writes to it the way Monad would change. */
interface StubChain {
  records: Map<string, ContextRecordView>
  signerToAgent: Map<string, Hex>
  agents: Map<string, unknown>
  capabilities: Map<string, unknown>
  authorityMask: Map<string, number>
  /** What BatchAnchor.CAPABILITY_REGISTRY() answers — a test points it at the wrong registry. */
  anchorRegistry: Address
  /** How many CAPABILITY_REGISTRY() calls the stub has served — the caching assertion's meter. */
  anchorRegistryReads: number
  /** Countdown of CAPABILITY_REGISTRY() calls that fail — proves a failed read retries, not latches. */
  anchorRegistryFails: number
}

function stubChain(): StubChain {
  const chain: StubChain = {
    records: new Map(),
    signerToAgent: new Map(),
    agents: new Map(),
    capabilities: new Map(),
    authorityMask: new Map(),
    anchorRegistry: deployment.capabilityRegistry,
    anchorRegistryReads: 0,
    anchorRegistryFails: 0,
  }
  const agentRecord = (signer: Address) => ({
    operator: owner,
    signer: signer.toLowerCase(),
    encryptionPublicKey: hexOf(randomBytes(32)),
    encryptionKeyVersion: 1,
    callbackOriginHash: hexOf(randomBytes(32)),
    capabilityManifestHash: hexOf(randomBytes(32)),
    capabilityManifestVersion: 1n,
    active: true,
  })
  const capability = (agentId: Hex, permissions: number) => ({
    owner,
    agentId,
    namespaceId: NAMESPACE,
    permissions,
    provenancePolicy: 0,
    issuedAt: 0n,
    expiresAt: 0n,
    agentEpoch: 0n,
    grantedAtReadEpoch: 0n,
    revoked: false,
  })
  chain.signerToAgent.set(agentAccount.address.toLowerCase(), AGENT_ID)
  chain.agents.set(AGENT_ID, agentRecord(agentAccount.address))
  chain.capabilities.set(CAP_ID, capability(AGENT_ID, PERMISSION.READ))
  chain.authorityMask.set(`${owner}|${AGENT_ID}|${NAMESPACE}`, PERMISSION.READ)
  chain.signerToAgent.set(deniedAccount.address.toLowerCase(), DENIED_ID)
  chain.agents.set(DENIED_ID, agentRecord(deniedAccount.address))
  chain.capabilities.set(DENIED_CAP, capability(DENIED_ID, 0))
  return chain
}

function latestBlock(): unknown {
  return {
    baseFeePerGas: "0x0",
    blobGasUsed: "0x0",
    difficulty: "0x0",
    excessBlobGas: "0x0",
    extraData: "0x",
    gasLimit: "0x1000000",
    gasUsed: "0x0",
    hash: `0x${"ab".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: `0x${"00".repeat(20)}`,
    mixHash: zeroHash,
    nonce: "0x0000000000000000",
    number: "0x1",
    parentHash: zeroHash,
    receiptsRoot: zeroHash,
    sha3Uncles: zeroHash,
    size: "0x0",
    stateRoot: zeroHash,
    timestamp: `0x${BigInt(Math.floor(Date.now() / 1000)).toString(16)}`,
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: zeroHash,
    uncles: [],
  }
}

/** A JSON-RPC server answering exactly the reads RegistryReader makes, from the mutable StubChain. */
async function startStubRpc(chain: StubChain): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
    req.on("end", () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown[] }
      const reply = (result: unknown) => {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
      }
      const revert = (errorName: string, args: unknown[]) =>
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: 3, message: `execution reverted: ${errorName}`, data: encodeErrorResult({ abi: ABI, errorName, args } as never) },
          }),
        )
      if (method === "eth_chainId") return reply(`0x${deployment.chainId.toString(16)}`)
      if (method === "net_version") return reply(deployment.chainId.toString(10))
      if (method === "eth_blockNumber") return reply("0x1")
      if (method === "eth_getBlockByNumber") return reply(latestBlock())
      if (method !== "eth_call") return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled ${method}` } }))
      const [{ data }] = params as [{ data: Hex }]
      let call: { functionName: string; args: readonly unknown[] }
      try {
        call = decodeFunctionData({ abi: ABI, data }) as { functionName: string; args: readonly unknown[] }
      } catch {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "undecodable calldata" } }))
      }
      const encode = (result: unknown) =>
        reply(encodeFunctionResult({ abi: ABI, functionName: call.functionName, result } as never))
      const [a0, a1, a2, a3] = call.args ?? [] // a zero-arg getter (CAPABILITY_REGISTRY) has no args tuple
      switch (call.functionName) {
        case "CAPABILITY_REGISTRY":
          chain.anchorRegistryReads += 1
          if (chain.anchorRegistryFails > 0) {
            chain.anchorRegistryFails -= 1
            return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "stub RPC: anchor read failed" } }))
          }
          return encode(chain.anchorRegistry)
        case "requiredReadEpoch":
          return encode(1n)
        case "isWriteEpochValid":
          return encode(true)
        case "agentIdOfSigner":
          return encode(chain.signerToAgent.get((a0 as string).toLowerCase()) ?? zeroHash)
        case "getAgent": {
          const agent = chain.agents.get((a0 as string).toLowerCase())
          return agent === undefined ? revert("AgentNotFound", [a0]) : encode(agent)
        }
        case "getCapability": {
          const capability = chain.capabilities.get((a0 as string).toLowerCase())
          return capability === undefined ? revert("CapabilityNotFound", [a0]) : encode(capability)
        }
        case "agentEpoch":
          return encode(0n)
        case "hasAuthority": {
          const mask = chain.authorityMask.get(`${(a0 as string).toLowerCase()}|${(a1 as string).toLowerCase()}|${(a2 as string).toLowerCase()}`) ?? 0
          return encode((mask & Number(a3)) === Number(a3))
        }
        case "getRecord": {
          const record = chain.records.get((a0 as string).toLowerCase())
          return record === undefined ? revert("ContextNotFound", [a0]) : encode(record)
        }
        case "activeCapabilityIds":
          return encode([])
        case "epochPublicKey":
          return encode(zeroHash)
        case "ownerP256Key":
          return encode([0n, 0n])
        default:
          return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled function ${call.functionName}` } }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

function envVars(rpcUrl: string): Record<string, string> {
  return {
    RPC_URL: rpcUrl,
    CHAIN_ID: deployment.chainId.toString(10),
    CAPABILITY_REGISTRY: deployment.capabilityRegistry,
    CONTEXT_REGISTRY: deployment.contextRegistry,
    DEPLOYMENT_BLOCK: deployment.deploymentBlock.toString(10),
    POLICY_HASH_V1: deployment.policyHashV1,
    VAULT_RP_ID: deployment.vaultRpId,
    VAULT_RP_ID_HASH: deployment.vaultRpIdHash,
  }
}

function env(db: D1Like, rpcUrl: string): WorkerEnv {
  return { DB: db, ...envVars(rpcUrl) } as WorkerEnv
}

async function applySchema(db: D1Like): Promise<void> {
  const statements = readFileSync(join(HERE, "..", "schema.sql"), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
  await db.batch(statements.map((sql) => db.prepare(sql)))
}

/** The bundle Miniflare runs: what `wrangler deploy` would produce, built the same way. */
async function bundleWorker(): Promise<string> {
  const outfile = join(mkdtempSync(join(tmpdir(), "mida-worker-")), "worker.mjs")
  await build({
    entryPoints: [join(HERE, "..", "src", "worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
    // No define for import.meta.url: @mida/chain's directory constants are resolved lazily on first
    // call now, so module scope never evaluates fileURLToPath(new URL(…)) — this bundle is the proof
    // that the Worker starts in workerd with no shim.
    outfile,
    logLevel: "silent",
  })
  return readFileSync(outfile, "utf8")
}

async function makeWorker(script: string, vars: Record<string, string>): Promise<{ mf: Miniflare; db: D1Like }> {
  const mf = new Miniflare({
    // A file-named module (not a `script` string), the shape a real deploy ships. Module scope of the
    // bundle never evaluates import.meta.url — whatever workerd assigns it is simply never read.
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    // The newest date this workerd build supports; wrangler.toml uses today's date for real deploys.
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    bindings: vars,
  })
  const db = (await mf.getD1Database("DB")) as unknown as D1Like
  await applySchema(db)
  return { mf, db }
}

function clientFor(mf: Miniflare, account: LocalAccount): ContextApiClient {
  return new ContextApiClient({
    baseUrl: "http://worker.test",
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    fetch: async (url, init) => (await mf.dispatchFetch(url, init as never)) as unknown as Response,
  })
}

/**
 * The same client against a bare env (no Miniflare): requests go straight through handleRequest,
 * and each response is captured raw so a test can read the error body the client would hide.
 */
function clientForEnv(envObj: WorkerEnv, account: LocalAccount): {
  client: ContextApiClient
  last: () => { status: number; body: unknown } | undefined
} {
  let last: { status: number; body: unknown } | undefined
  const client = new ContextApiClient({
    baseUrl: "http://worker.test",
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    fetch: async (url, init) => {
      const response = await handleRequest(envObj, new Request(url, init))
      last = { status: response.status, body: await response.clone().json() }
      return response
    },
  })
  return { client, last: () => last }
}

function upload(ciphertext: Uint8Array): ObjectUploadBody {
  const objectNonce = hexOf(randomBytes(32))
  const contextId = deriveContextId({
    chainId: deployment.chainId,
    contextRegistry: deployment.contextRegistry,
    owner,
    authorId: OWNER_AUTHOR_ID,
    namespaceId: NAMESPACE,
    objectNonce,
  })
  return {
    owner,
    namespaceId: NAMESPACE,
    objectNonce,
    expectedParentId: zeroHash,
    manifest: {
      v: 1,
      contextId,
      ciphertextHash: contentHash(ciphertext),
      ciphertextSize: ciphertext.length,
      payloadNonce: hexOf(randomBytes(24)),
      cryptoVersion: "mida-crypto-v1",
      readEpoch: "1",
      epochDekWrap: {
        v: 1,
        contextId,
        namespaceId: NAMESPACE,
        readEpoch: "1",
        ephemeralPublicKey: hexOf(randomBytes(32)),
        nonce: hexOf(randomBytes(24)),
        wrappedDek: hexOf(randomBytes(48)),
      },
    },
    ciphertext: hexOf(ciphertext),
  }
}

function anchoredRecord(body: ObjectUploadBody): ContextRecordView {
  return {
    contextId: body.manifest.contextId,
    owner,
    author: OWNER_AUTHOR_ID,
    namespaceId: NAMESPACE,
    lineageId: body.manifest.contextId,
    parentId: zeroHash,
    manifestHash: manifestHash(body.manifest),
    ciphertextCommitment: body.manifest.ciphertextHash,
    evidenceCommitment: zeroHash,
    readEpoch: 1n,
    createdAt: 1n,
    expiresAt: 0n,
    version: 1,
    recordType: 1,
    lineagePolicy: 0,
    kind: 1,
    provenanceSource: 1,
  }
}

describe("the worker entry", () => {
  let chain: StubChain
  let rpc: { url: string; close: () => Promise<void> }
  let mf: Miniflare
  let db: D1Like
  let ownerClient: ContextApiClient

  beforeAll(async () => {
    chain = stubChain()
    rpc = await startStubRpc(chain)
    const scriptPath = await bundleWorker()
    const made = await makeWorker(scriptPath, envVars(rpc.url))
    mf = made.mf
    db = made.db
    ownerClient = clientFor(mf, ownerAccount)
  })

  afterAll(async () => {
    await mf?.dispose()
    await rpc?.close()
  })

  it("serves the whole lifecycle through workerd: signed PUT → invisible until anchored → READ yes, no-READ no", async () => {
    const ciphertext = randomBytes(96)
    const body = upload(ciphertext)

    const put = await ownerClient.putObject(body)
    expect(put).toMatchObject({ contextId: body.manifest.contextId, manifestHash: manifestHash(body.manifest), state: "pending" })

    // Nothing on chain yet: the store has the ciphertext but must not serve it — to anyone.
    expect(await ownerClient.listObjects({ owner, namespaceId: NAMESPACE })).toEqual({ objects: [], partial: false })
    await expect(ownerClient.getManifest(body.manifest.contextId)).rejects.toMatchObject({ code: "NOT_FOUND" })

    // Monad anchors the record: now the owner sees the object and its ciphertext.
    chain.records.set(body.manifest.contextId.toLowerCase(), anchoredRecord(body))
    const listed = await ownerClient.listObjects({ owner, namespaceId: NAMESPACE })
    expect(listed.objects.map((object) => object.contextId)).toEqual([body.manifest.contextId])
    expect(listed.objects[0]!.ciphertext).toBe(hexOf(ciphertext))
    await expect(ownerClient.getManifest(body.manifest.contextId)).resolves.toMatchObject({ manifestHash: manifestHash(body.manifest) })

    // An agent holding READ on this namespace sees it; one whose capability lacks READ does not.
    const agentClient = clientFor(mf, agentAccount)
    expect((await agentClient.listObjects({ owner, namespaceId: NAMESPACE, capabilityId: CAP_ID })).objects.map((object) => object.contextId)).toEqual([
      body.manifest.contextId,
    ])
    const deniedClient = clientFor(mf, deniedAccount)
    await expect(deniedClient.listObjects({ owner, namespaceId: NAMESPACE, capabilityId: DENIED_CAP })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    })
  })

  it("GET /revocations lists the signer's own denies through the shared app — the nonce never leaves", async () => {
    // owner denies agent A's capability: POST /revocations checks ownership against the stub chain.
    const created = await ownerClient.requestRevocationDeny({ capabilityId: CAP_ID })
    expect(created.state).toBe("active")

    const all = await ownerClient.listRevocations()
    const mine = all.filter((intent) => intent.intentId === created.intentId)
    expect(mine).toEqual([
      {
        intentId: created.intentId,
        state: "active",
        target: { kind: "capability", capabilityId: CAP_ID },
        agentEpochAtIntent: null,
      },
    ])
    const active = await ownerClient.listRevocations("active")
    expect(active.every((intent) => intent.state === "active")).toBe(true)
    // another signer lists only their own intents — nothing of the owner's leaks
    expect(await clientFor(mf, deniedAccount).listRevocations()).toEqual([])
  })

  it("the rate-limit bindings gate requests per CF-Connecting-IP with 429 and Retry-After", async () => {
    const calls = { signed: [] as string[], unsigned: [] as string[] }
    const limitedEnv: WorkerEnv = {
      ...env(db, rpc.url),
      LIMITER_SIGNED: { limit: async ({ key }) => (calls.signed.push(key), { success: true }) },
      LIMITER_UNSIGNED: { limit: async ({ key }) => (calls.unsigned.push(key), { success: false }) },
    }
    // An unsigned request is checked against the unsigned binding — it says stop → 429 + Retry-After.
    const denied = await handleRequest(
      limitedEnv,
      new Request(`http://worker.test/agent-manifests/${`0x${"0".repeat(64)}`}`, { headers: { "cf-connecting-ip": "198.51.100.9" } }),
    )
    expect(denied.status).toBe(429)
    expect(denied.headers.get("retry-after")).toBe("60")
    expect(calls).toEqual({ signed: [], unsigned: ["198.51.100.9"] })
    // A request carrying a signature header goes to the signed binding; allowed → the app answers (401
    // here, because the signature is shape-valid but wrong — the limiter let it through).
    const signedRequest = new Request(`http://worker.test/manifests/${`0x${"0".repeat(64)}`}`, {
      headers: {
        "cf-connecting-ip": "192.0.2.4",
        "x-mida-signer": `0x${"0".repeat(40)}`,
        "x-mida-timestamp": "1",
        "x-mida-nonce": `0x${"0".repeat(64)}`,
        "x-mida-signature": `0x${"0".repeat(130)}`,
      },
    })
    const passed = await handleRequest(limitedEnv, signedRequest)
    expect(passed.status).toBe(401)
    expect(calls.signed).toEqual(["192.0.2.4"])

    // GET / is a route like any other: the same unsigned binding gates it before the app is asked.
    expect((await handleRequest(limitedEnv, new Request("http://worker.test/"))).status).toBe(429)

    // With both bindings present and permitting, GET / advertises the budgets wrangler.toml configures.
    const openEnv: WorkerEnv = {
      ...env(db, rpc.url),
      LIMITER_SIGNED: { limit: async () => ({ success: true }) },
      LIMITER_UNSIGNED: { limit: async () => ({ success: true }) },
    }
    const root = await handleRequest(openEnv, new Request("http://worker.test/"))
    expect(root.status).toBe(200)
    expect(((await root.json()) as Record<string, unknown>)["rateLimitsPerMinute"]).toEqual({ signed: 120, unsigned: 20 })
  })

  it("GET / reports the deployment, the shared limits and the ciphertext-only sentence", async () => {
    const response = await mf.dispatchFetch("http://worker.test/")
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      name: "mida-context-store",
      version: "0.0.0",
      chainId: "31337",
      capabilityRegistry: deployment.capabilityRegistry,
      contextRegistry: deployment.contextRegistry,
    })
    expect(body["limits"]).toEqual({
      maxCiphertextBytes: 262_144,
      maxPutsPerSignerPerDay: 2_000,
      maxPendingBytesPerSigner: 20 * 1024 * 1024,
      maxManifestBodyBytes: 16_384,
      maxManifestPutsPerSignerPerDay: 20,
      maxRequestBodyBytes: 1_048_576,
    })
    // The 60-second manifest verification cache is advertised; a removed agent disappears within it.
    expect(body["manifestVerifyCacheSeconds"]).toBe(60)
    // The chain-read budget, the partial-list header and the 15-minute bounded sweep are advertised too.
    expect(body["chainReadsPerRequest"]).toBe(30)
    expect(body["partialObjectsHeader"]).toBe("x-mida-partial")
    expect(body["sweep"]).toEqual({ cron: "*/15 * * * *", maxObjectsPerRun: 25 })
    // This Miniflare env binds no [[ratelimits]], so the worker honestly reports no per-IP budget.
    expect(body["rateLimitsPerMinute"]).toEqual({ signed: null, unsigned: null })
    expect(body["notice"]).toBe(
      "This server stores ciphertext only. It holds no keys and cannot read what it stores. Source: <repo url placeholder>",
    )
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("answers CORS preflights for reads and writes from any origin, never with credentials", async () => {
    const response = await mf.dispatchFetch("http://worker.test/objects", {
      method: "OPTIONS",
      headers: { origin: "https://integrator.example", "access-control-request-method": "PUT" },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT")
    expect(response.headers.get("access-control-allow-headers")).toContain("x-mida-signature")
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("rejects an unsigned request with 401 before any chain read", async () => {
    const response = await mf.dispatchFetch(`http://worker.test/objects?owner=${owner}&namespaceId=${NAMESPACE}`, { method: "GET" })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_INVALID" } })
  })

  it("refuses to start when a required variable is missing, and names it", async () => {
    const vars = envVars(rpc.url)
    delete vars["CONTEXT_REGISTRY"]
    const bad = await makeWorker(await bundleWorker(), vars)
    try {
      const response = await bad.mf.dispatchFetch("http://worker.test/")
      expect(response.status).toBe(500)
      expect(JSON.stringify(await response.json())).toContain("CONTEXT_REGISTRY")
    } finally {
      await bad.mf.dispose()
    }
  })

  it("a non-numeric BATCH_ANCHOR_BLOCK beside a real BATCH_ANCHOR fails the whole worker at boot", async () => {
    const vars = envVars(rpc.url)
    vars["BATCH_ANCHOR"] = "0x1111111111111111111111111111111111111aa5"
    vars["BATCH_ANCHOR_BLOCK"] = "yesterday"
    const bad = await makeWorker(await bundleWorker(), vars)
    try {
      const response = await bad.mf.dispatchFetch("http://worker.test/")
      expect(response.status).toBe(500)
      expect(JSON.stringify(await response.json())).toContain("BATCH_ANCHOR_BLOCK")
    } finally {
      await bad.mf.dispose()
    }
  })

  it("a disabled batch lane needs no receipt key — the store boots and the surface answers off", async () => {
    // The boot trap this fixes: the worker used to demand RECEIPT_PRIVATE_KEY whenever BATCH_ANCHOR
    // parsed, so this env — lane off, no secrets — used to 500 every single route.
    const laneEnv: WorkerEnv = {
      ...env(db, rpc.url),
      BATCH_ANCHOR: "0x1111111111111111111111111111111111111aa5",
      BATCHING_ENABLED: "false",
    }
    expect((await handleRequest(laneEnv, new Request("http://worker.test/"))).status).toBe(200)
    expect(await (await handleRequest(laneEnv, new Request("http://worker.test/batch/status"))).json()).toMatchObject({ enabled: false })

    const { client, last } = clientForEnv(laneEnv, ownerAccount)
    // A signed write gets the disabled answer — not a config crash — and a normal route still serves.
    await client.postBatchSave({} as never).catch(() => {})
    expect(last()).toMatchObject({ status: 503, body: { error: { code: "BATCHING_DISABLED" } } })
    // This suite's shared chain/db may already hold anchored records — the point is the route serves.
    const listed = await client.listObjects({ owner, namespaceId: NAMESPACE })
    expect(Array.isArray(listed.objects)).toBe(true)
    expect(listed.partial).toBe(false)
  })

  it("an enabled lane verifies the anchor's CAPABILITY_REGISTRY lazily once, caches it, and refuses clearly on a mismatch", async () => {
    const anchor = "0x1111111111111111111111111111111111111aa5" as Address
    const coordinator: DurableObjectNamespaceLike = {
      idFromName: () => "batcher",
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true })) }),
    }
    const enabledEnv = (): WorkerEnv => ({
      ...env(db, rpc.url),
      BATCH_ANCHOR: anchor,
      BATCHING_ENABLED: "true",
      BATCHER_PRIVATE_KEY: `0x${"44".repeat(32)}`,
      RECEIPT_PRIVATE_KEY: `0x${"55".repeat(32)}`,
      BATCH_COORDINATOR: coordinator,
    })

    // Lazy: neither boot nor the unsigned discovery probe touches the chain for this check.
    const { client, last } = clientForEnv(enabledEnv(), ownerAccount)
    const readsBefore = chain.anchorRegistryReads
    expect((await client.batchStatus()).enabled).toBe(true)
    expect(chain.anchorRegistryReads).toBe(readsBefore)

    // The first gated request runs the check once and proceeds — the junk save then fails on the
    // wire (400 INVALID_WIRE), which proves it got past the anchor gate.
    await client.postBatchSave({} as never).catch(() => {})
    expect(last()!.status).toBe(400)
    expect(chain.anchorRegistryReads).toBe(readsBefore + 1)

    // The verdict is cached: a second gated request costs no second read.
    await client.postBatchSave({} as never).catch(() => {})
    expect(chain.anchorRegistryReads).toBe(readsBefore + 1)

    // A different deployment's anchor reports a different registry — a fresh env object means a
    // fresh check, and the whole batch surface (writes AND reads) refuses by name.
    chain.anchorRegistry = "0x6666666666666666666666666666666666666666" as Address
    try {
      const bad = clientForEnv(enabledEnv(), ownerAccount)
      await bad.client.postBatchSave({} as never).catch(() => {})
      expect(bad.last()).toMatchObject({ status: 503, body: { error: { code: "BATCH_ANCHOR_UNVERIFIED" } } })
      const message = JSON.stringify(bad.last()!.body)
      expect(message).toContain(anchor)
      expect(message).toContain("6666666666666666666666666666666666666666")

      // The refusal latches: even reads refuse, without spending another chain call.
      const readsAtMismatch = chain.anchorRegistryReads
      await bad.client.listBatchSaves({ owner, namespaceId: NAMESPACE }).catch(() => {})
      expect(bad.last()).toMatchObject({ status: 503, body: { error: { code: "BATCH_ANCHOR_UNVERIFIED" } } })
      expect(chain.anchorRegistryReads).toBe(readsAtMismatch)
    } finally {
      chain.anchorRegistry = deployment.capabilityRegistry
    }

    // A read that never reached the contract is not a verdict: the request refuses, and the next
    // gated request asks the chain again instead of latching the outage. The flag stays up for the
    // whole first request — however many times the transport retries inside it.
    chain.anchorRegistryFails = Number.MAX_SAFE_INTEGER
    const flaky = clientForEnv(enabledEnv(), ownerAccount)
    await flaky.client.postBatchSave({} as never).catch(() => {})
    expect(flaky.last()).toMatchObject({ status: 503, body: { error: { code: "BATCH_ANCHOR_UNVERIFIED" } } })
    chain.anchorRegistryFails = 0
    const readsBeforeRetry = chain.anchorRegistryReads
    await flaky.client.postBatchSave({} as never).catch(() => {})
    expect(flaky.last()!.status).toBe(400) // back past the gate, judged on the wire
    expect(chain.anchorRegistryReads).toBe(readsBeforeRetry + 1)
  })

  it("the scheduled handler sweeps stale pending uploads and nonces on the real D1", async () => {
    const stores = d1Stores(db)
    // The cron runs on wall-clock time: seed ages relative to Date.now(), not a fixed date.
    const nowMs = Date.now()
    const stalePending = upload(randomBytes(8))
    const staleObject = {
      contextId: stalePending.manifest.contextId,
      owner,
      uploader: owner,
      namespaceId: NAMESPACE,
      authorId: OWNER_AUTHOR_ID,
      objectNonce: stalePending.objectNonce,
      expectedParentId: zeroHash,
      manifest: stalePending.manifest,
      manifestHash: manifestHash(stalePending.manifest),
      uploadedAt: new Date(nowMs - 25 * 60 * 60_000).toISOString(),
      anchoredAt: null,
    }
    const anchoredBody = upload(randomBytes(8))
    const anchoredObject = { ...staleObject, contextId: anchoredBody.manifest.contextId, objectNonce: anchoredBody.objectNonce, manifest: anchoredBody.manifest, manifestHash: manifestHash(anchoredBody.manifest) }
    chain.records.set(anchoredObject.contextId.toLowerCase(), anchoredRecord(anchoredBody))
    await stores.objects.putObject(staleObject)
    await stores.objects.putObject(anchoredObject)

    const nowSeconds = BigInt(Math.floor(nowMs / 1000))
    const staleNonce = hexOf(randomBytes(32))
    const liveNonce = hexOf(randomBytes(32))
    await stores.nonces.consume(owner, staleNonce, nowSeconds - 61n, nowSeconds)
    await stores.nonces.consume(owner, liveNonce, nowSeconds, nowSeconds)

    let sweep: Promise<unknown> | undefined
    await worker.scheduled({ cron: "0 4 * * *" }, env(db, rpc.url), { waitUntil: (promise) => void (sweep = promise) })
    await sweep

    expect(await stores.objects.getObject(staleObject.contextId)).toBeUndefined()
    expect(await stores.objects.getObject(anchoredObject.contextId)).toBeDefined()
    await stores.nonces.consume(owner, staleNonce, nowSeconds - 61n, nowSeconds) // swept: admitted again
    await expect(stores.nonces.consume(owner, liveNonce, nowSeconds, nowSeconds)).rejects.toMatchObject({ code: "REPLAY" })
  })

  it("logs method, path template, status, bytes and ms — never a body, signature, full address or full hash", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const contextId = hexOf(randomBytes(32))
      const request = new Request(`http://worker.test/manifests/${contextId}?capabilityId=${hexOf(randomBytes(32))}`, { method: "GET" })
      const response = await handleRequest(env(db, rpc.url), request)
      expect(response.status).toBe(401) // unsigned — but it is still logged
      const line = spy.mock.calls.map((call) => String(call[0])).find((entry) => entry.includes("/manifests"))
      expect(line).toBeDefined()
      const entry = JSON.parse(line!) as Record<string, unknown>
      expect(Object.keys(entry).sort()).toEqual(["bytes", "method", "ms", "path", "status"])
      expect(entry).toMatchObject({ method: "GET", path: "/manifests/:contextId", status: 401 })
      expect(line).not.toContain(contextId.slice(2)) // the full hash appears nowhere, not even truncated
    } finally {
      spy.mockRestore()
    }
  })
})
