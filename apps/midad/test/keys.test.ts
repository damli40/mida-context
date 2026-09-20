import { describe, expect, it } from "vitest"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import type { Address, Hex } from "@mida/protocol"
import type { ProvisionedAgent } from "@mida/fake-vault"
import type { Grant } from "@mida/sdk"
import {
  MidaHome, identityFrom, isRevoked, listAgentNames, loadAgentIdentity, loadGrants, loadOrCreateOperatorSecrets,
  loadOrCreateOwnerSecrets, loadOrCreateSignerKey, markRevoked, saveAgentIdentity, saveGrants,
} from "@mida/midad"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-keys-")))
const KEY = /^0x[0-9a-f]{64}$/

describe("owner, operator and signer secrets", () => {
  it("creates three distinct 32-byte owner secrets and returns the same ones next time", () => {
    const home = freshHome()
    const first = loadOrCreateOwnerSecrets(home)
    expect(first.privateKey).toMatch(KEY)
    expect(first.seed).toMatch(KEY)
    expect(first.p256PrivateKey).toMatch(KEY)
    expect(new Set([first.privateKey, first.seed, first.p256PrivateKey]).size).toBe(3)
    expect(loadOrCreateOwnerSecrets(home)).toEqual(first)
    expect(statSync(home.path("owner/secrets.json")).mode & 0o777).toBe(0o600)
  })

  it("keeps the operator key stable and different from the owner key", () => {
    const home = freshHome()
    const operator = loadOrCreateOperatorSecrets(home)
    expect(loadOrCreateOperatorSecrets(home)).toEqual(operator)
    expect(operator.privateKey).not.toBe(loadOrCreateOwnerSecrets(home).privateKey)
  })

  it("gives each agent its own stable signer key", () => {
    const home = freshHome()
    const claude = loadOrCreateSignerKey(home, "claude-code")
    expect(loadOrCreateSignerKey(home, "claude-code")).toBe(claude)
    expect(loadOrCreateSignerKey(home, "codex")).not.toBe(claude)
  })

  it("refuses an owner secrets file that is missing a field, instead of generating a new owner", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { privateKey: `0x${"11".repeat(32)}` })
    expect(() => loadOrCreateOwnerSecrets(home)).toThrow()
  })

  it("names the bad field in the error but never its value", () => {
    const home = freshHome()
    home.writeSecretJson("owner/secrets.json", { privateKey: "0xnot-a-key-SECRETVALUE", seed: "x", p256PrivateKey: "y" })
    expect(() => loadOrCreateOwnerSecrets(home)).toThrow(/privateKey/)
    expect(() => loadOrCreateOwnerSecrets(home)).not.toThrow(/SECRETVALUE/)
  })
})

describe("agent identities, grants and the revoked list", () => {
  const signerPrivateKey = `0x${"5a".repeat(32)}` as Hex
  const provisioned = {
    agentId: `0x${"aa".repeat(32)}`,
    signer: privateKeyToAccount(signerPrivateKey),
    encryptionPrivateKey: new Uint8Array(32).fill(9),
    encryptionPublicKey: `0x${"bb".repeat(32)}`,
    callbackOrigin: "https://codex.mida.example",
    purposeId: "project_assistance",
    manifest: { body: { name: "codex" }, signature: "0x01" },
    manifestHash: `0x${"cc".repeat(32)}`,
  } as unknown as ProvisionedAgent

  it("round-trips an identity and stores the encryption key as hex, not raw bytes", () => {
    const home = freshHome()
    const identity = identityFrom("codex", signerPrivateKey, provisioned)
    expect(identity.encryptionPrivateKey).toBe(`0x${"09".repeat(32)}`)
    saveAgentIdentity(home, identity)
    expect(loadAgentIdentity(home, "codex")).toEqual(identity)
    expect(loadAgentIdentity(home, "claude-code")).toBeUndefined()
    expect(listAgentNames(home)).toEqual(["codex"])
  })

  it("refuses an identity whose signer key does not match the provisioned signer", () => {
    expect(() => identityFrom("codex", `0x${"5b".repeat(32)}` as Hex, provisioned)).toThrow()
  })

  it("refuses a half-written identity that has only the hex key fields", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/identity.json", {
      agentId: `0x${"aa".repeat(32)}`,
      signerPrivateKey: `0x${"5a".repeat(32)}`,
      encryptionPrivateKey: `0x${"09".repeat(32)}`,
      manifestHash: `0x${"cc".repeat(32)}`,
    })
    expect(() => loadAgentIdentity(home, "codex")).toThrow(/identity\.json: field "(name|encryptionPublicKey|callbackOrigin|purposeId|manifest)"/)
  })

  it("refuses an identity whose name does not match the folder it lives in", () => {
    const home = freshHome()
    saveAgentIdentity(home, identityFrom("codex", signerPrivateKey, provisioned))
    const saved = loadAgentIdentity(home, "codex")!
    home.writeSecretJson("agents/codex/identity.json", { ...saved, name: "claude-code" })
    expect(() => loadAgentIdentity(home, "codex")).toThrow(/name/)
  })

  it("round-trips grants and starts empty", () => {
    const home = freshHome()
    expect(loadGrants(home, "codex")).toEqual([])
    const grant: Grant = { owner: `0x${"dd".repeat(20)}` as Address, agentId: `0x${"aa".repeat(32)}` as Hex, requestId: `0x${"01".repeat(32)}` as Hex, capabilities: [] }
    saveGrants(home, "codex", [grant])
    expect(loadGrants(home, "codex")).toEqual([grant])
  })

  it("refuses a grants file that is not an array", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/grants.json", {})
    expect(() => loadGrants(home, "codex")).toThrow(/grants\.json/)
  })

  it("refuses a grants file whose entries are missing fields", () => {
    const home = freshHome()
    home.writeSecretJson("agents/codex/grants.json", [{ owner: `0x${"dd".repeat(20)}` }])
    expect(() => loadGrants(home, "codex")).toThrow(/grants\.json/)
    expect(() => loadGrants(home, "codex")).toThrow(/agentId/)
  })

  it("remembers a revoked agent", () => {
    const home = freshHome()
    expect(isRevoked(home, "claude-code")).toBe(false)
    markRevoked(home, "claude-code")
    expect(isRevoked(home, "claude-code")).toBe(true)
    expect(isRevoked(home, "codex")).toBe(false)
  })
})
