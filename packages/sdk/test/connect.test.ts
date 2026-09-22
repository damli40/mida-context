import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { PERMISSION } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { FileAccessRequestStore, MidaAgent, connectAgent } from "../src/index.js"

const OWNER: Address = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address

/** A Mida home the way `mida init` leaves it: identity, owner, network, grants. */
function seedHome(opts: { network?: Record<string, unknown>; grants?: unknown[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mida-connect-"))
  const agentDir = join(home, "agents", "codex")
  mkdirSync(agentDir, { recursive: true })
  const signer = generatePrivateKey()
  writeFileSync(join(agentDir, "identity.json"), JSON.stringify({
    name: "codex",
    agentId: `0x${"ab".repeat(32)}`,
    signerPrivateKey: signer,
    encryptionPrivateKey: generatePrivateKey(),
    encryptionPublicKey: `0x${"cd".repeat(33)}`,
    callbackOrigin: "https://agent.example/mida",
    purposeId: "project_assistance",
    manifest: {},
    manifestHash: `0x${"ef".repeat(32)}`,
  }))
  writeFileSync(join(home, "owner-address.json"), JSON.stringify({ address: OWNER }))
  if (opts.network !== undefined) writeFileSync(join(home, "network.json"), JSON.stringify(opts.network))
  if (opts.grants !== undefined) writeFileSync(join(agentDir, "grants.json"), JSON.stringify(opts.grants))
  return { home, signer }
}

const ENV = { MIDA_HOME: undefined as string | undefined, MONAD_TESTNET_RPC: undefined, MIDA_STORAGE_URL: undefined, MIDA_SPONSOR_URL: undefined, MIDA_DEPLOYMENTS_DIR: undefined }

describe("connectAgent — home mode", () => {
  it("loads the provisioned identity, owner and grants without touching the network", () => {
    const { home } = seedHome({ grants: [] })
    const conn = connectAgent({ name: "codex", midaHome: home, env: ENV })
    expect(conn.agent).toBeInstanceOf(MidaAgent)
    expect(conn.owner).toBe(OWNER)
    expect(conn.name).toBe("codex")
    expect(conn.midaHome).toBe(home)
  })

  it("fails plainly when the agent was never provisioned", () => {
    const home = mkdtempSync(join(tmpdir(), "mida-connect-"))
    expect(() => connectAgent({ name: "codex", midaHome: home, env: ENV })).toThrow(/mida init/)
  })

  it("fails plainly when the owner record is missing", () => {
    const { home } = seedHome()
    const agentless = mkdtempSync(join(tmpdir(), "mida-connect-"))
    // identity present, owner-address.json absent
    mkdirSync(join(agentless, "agents", "codex"), { recursive: true })
    writeFileSync(join(agentless, "agents", "codex", "identity.json"), readFileSync(join(home, "agents", "codex", "identity.json"), "utf8"))
    expect(() => connectAgent({ name: "codex", midaHome: agentless, env: ENV })).toThrow(/owner-address\.json/)
  })

  it("rejects names that would escape the home", () => {
    const { home } = seedHome()
    expect(() => connectAgent({ name: "../etc", midaHome: home, env: ENV })).toThrow(/bad agent name/)
  })

  it("rejects a relative MIDA_HOME rather than resolving it silently", () => {
    const { home } = seedHome()
    expect(() => connectAgent({ name: "codex", midaHome: "relative/path", env: ENV })).toThrow(/absolute/)
    expect(home).toContain("mida-connect-")
  })
})

describe("connectAgent — network resolution", () => {
  it("treats a network.json without storageUrl as the local store, like init writes it", () => {
    const { home } = seedHome({ network: {} })
    // no api-url.json exists → the local-store path must say so, not silently fall back to hosted
    expect(() => connectAgent({ name: "codex", midaHome: home, env: ENV })).toThrow(/Context API/)
  })

  it("discovers the local Context API from api-url.json when the network says off", () => {
    const { home } = seedHome({ network: {} })
    writeFileSync(join(home, "api-url.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:54321" }))
    const conn = connectAgent({ name: "codex", midaHome: home, env: ENV })
    expect(conn.agent).toBeInstanceOf(MidaAgent)
  })

  it("env MIDA_STORAGE_URL overrides network.json", () => {
    const { home } = seedHome({ network: { storageUrl: "https://stale.example" } })
    const conn = connectAgent({ name: "codex", midaHome: home, env: { ...ENV, MIDA_STORAGE_URL: "https://override.example" } })
    expect(conn.agent).toBeInstanceOf(MidaAgent)
  })

  it("explicit network fields win over everything", () => {
    const { home } = seedHome({ network: { storageUrl: "https://stale.example" } })
    const conn = connectAgent({ name: "codex", midaHome: home, env: ENV, network: { storageUrl: "https://explicit.example", sponsorUrl: "off" } })
    expect(conn.agent).toBeInstanceOf(MidaAgent)
  })
})

describe("connectAgent — explicit mode", () => {
  it("builds an agent from bare identity fields with no home files", () => {
    const home = mkdtempSync(join(tmpdir(), "mida-connect-"))
    const conn = connectAgent({
      identity: {
        agentId: `0x${"ab".repeat(32)}` as Hex,
        signerPrivateKey: generatePrivateKey(),
        encryptionPrivateKey: generatePrivateKey(),
        callbackOrigin: "https://agent.example/mida",
      },
      owner: OWNER,
      midaHome: home,
      env: ENV,
      network: { storageUrl: "https://store.example", sponsorUrl: "off" },
    })
    expect(conn.owner).toBe(OWNER)
    expect(conn.name).toBeUndefined()
  })

  it("requires owner in explicit mode", () => {
    const home = mkdtempSync(join(tmpdir(), "mida-connect-"))
    expect(() => connectAgent({
      identity: {
        agentId: `0x${"ab".repeat(32)}` as Hex,
        signerPrivateKey: generatePrivateKey(),
        encryptionPrivateKey: generatePrivateKey(),
        callbackOrigin: "https://agent.example/mida",
      },
      midaHome: home,
      env: ENV,
    })).toThrow(/owner/)
  })

  it("rejects passing both name and identity", () => {
    const { home } = seedHome()
    expect(() => connectAgent({
      name: "codex",
      identity: { agentId: "0x" + "ab".repeat(32) as Hex, signerPrivateKey: generatePrivateKey(), encryptionPrivateKey: generatePrivateKey(), callbackOrigin: "x" },
      owner: OWNER,
      midaHome: home,
      env: ENV,
    })).toThrow(/either/)
  })
})

describe("FileAccessRequestStore", () => {
  const request = () => ({
    v: 1 as const,
    chainId: "31337",
    capabilityRegistry: OWNER,
    requestId: `0x${"11".repeat(32)}` as Hex,
    nonce: `0x${"33".repeat(32)}` as Hex,
    agentId: `0x${"22".repeat(32)}` as Hex,
    purposeId: "project_assistance" as const,
    callbackOrigin: "https://agent.example/mida",
    manifestHash: `0x${"44".repeat(32)}` as Hex,
    manifestVersion: 1,
    policyVersion: "mida-grant-policy-v1" as const,
    namespaceTreeVersion: "mida-namespace-tree-v1" as const,
    scopes: [{ namespaceId: `0x${"55".repeat(32)}` as Hex, permissions: PERMISSION.READ, provenancePolicy: 0 }],
    issuedAt: "0",
    requestExpiresAt: "999999999",
    capabilityExpiresAt: "0",
    agentSignature: `0x${"66".repeat(32)}` as Hex,
  })

  it("saves, loads and marks a request consumed — surviving a fresh store instance", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mida-req-")), "requests", "codex")
    const store = new FileAccessRequestStore(dir)
    const req = request()
    await store.save(req)
    const loaded = await store.load(req.requestId)
    expect(loaded?.request).toEqual(req)
    expect(loaded?.consumed).toBe(false)
    await store.markConsumed(req.requestId)
    expect((await new FileAccessRequestStore(dir).load(req.requestId))?.consumed).toBe(true)
  })

  it("refuses a second request under the same requestId", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mida-req-")), "r")
    const store = new FileAccessRequestStore(dir)
    await store.save(request())
    await expect(store.save(request())).rejects.toMatchObject({ code: "REPLAY" })
  })

  it("reports unknown requestIds as NOT_FOUND and double-consume as REQUEST_CONSUMED", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mida-req-")), "r")
    const store = new FileAccessRequestStore(dir)
    await expect(store.markConsumed(`0x${"77".repeat(32)}` as Hex)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await store.save(request())
    await store.markConsumed(request().requestId)
    await expect(store.markConsumed(request().requestId)).rejects.toMatchObject({ code: "REQUEST_CONSUMED" })
  })

  it("writes files nobody but the owner can read", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mida-req-")), "r")
    const store = new FileAccessRequestStore(dir)
    await store.save(request())
    expect(statSync(join(dir, `0x${"11".repeat(32)}.json`)).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir, `0x${"11".repeat(32)}.json`))).toBe(true)
  })
})
