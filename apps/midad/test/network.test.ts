// Plan A Task 1: resolveNetwork — the one rule for which contract, RPC, store and sponsor a
// home uses. The rule in one line: a saved network.json wins; the built-in deployment record
// is only for a brand-new home. (CHAIN-07/11 — the Sep 22 split where `mida` used the new
// contract while the daemon used the saved one, and both answered truthfully about different
// contracts.)
//
// The fixtures are the two real records: X is the contract that was live until the Sep 22
// redeploy (what an existing ~/.mida saved); Y is the record this code ships now.

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { monadTestnet } from "viem/chains"
import { parseDeployment } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { HOSTED_SPONSOR_URL, HOSTED_STORAGE_URL, MidaHome, mismatchLine, resolveNetwork, serviceNetwork } from "@mida/midad"
import type { ResolveDeps } from "@mida/midad"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const X_RAW = JSON.parse(
  readFileSync(join(REPO_ROOT, "docs/evidence/deployment-10143-vault.mida.xyz-2026-09-17.json"), "utf8"),
) as unknown
const Y_RAW = JSON.parse(readFileSync(join(REPO_ROOT, "contracts/deployments/10143.json"), "utf8")) as unknown
const X = parseDeployment(X_RAW)
const Y = parseDeployment(Y_RAW)

const SAVED_RPC = "https://saved-rpc.example"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-network-")))

/** Every test here runs without an RPC: the chain-id probe is the one network call. */
const deps = (loadBuiltIn: () => Deployment = () => Y): ResolveDeps => ({ loadBuiltIn, probeChainId: false })

/** What `init` writes: the public chain coordinates plus whatever service URLs were in effect. */
const saveNetwork = (h: MidaHome, over: Record<string, unknown> = {}) =>
  h.writeSecretJson("network.json", { chainId: 10143, rpcUrl: SAVED_RPC, deployment: X_RAW, ...over })

describe("resolveNetwork — first time (no network.json)", () => {
  it("uses the built-in record, the viem default RPC and the hosted services", async () => {
    const resolved = await resolveNetwork(home(), {}, deps())
    expect(resolved.saved).toBe(false)
    expect(resolved.contractSource).toBe("built-in")
    expect(resolved.network.deployment.capabilityRegistry).toBe(Y.capabilityRegistry)
    expect(resolved.network.rpcUrl).toBe(monadTestnet.rpcUrls.default.http[0])
    expect(resolved.storage).toEqual({ url: HOSTED_STORAGE_URL, source: "hosted-default" })
    expect(resolved.sponsor).toEqual({ url: HOSTED_SPONSOR_URL, source: "hosted-default" })
    expect(resolved.network.storageUrl).toBe(HOSTED_STORAGE_URL)
    expect(resolved.network.sponsorUrl).toBe(HOSTED_SPONSOR_URL)
    expect(resolved.mismatch).toBeUndefined()
    expect(mismatchLine(resolved)).toBeUndefined()
  })

  it("honours the env overrides exactly as testnetNetwork does — URL, off, and RPC", async () => {
    const resolved = await resolveNetwork(
      home(),
      { MONAD_TESTNET_RPC: "https://env-rpc.example", MIDA_STORAGE_URL: "off", MIDA_SPONSOR_URL: "https://sponsor.example" },
      deps(),
    )
    expect(resolved.network.rpcUrl).toBe("https://env-rpc.example")
    expect(resolved.storage).toEqual({ url: undefined, source: "off" })
    expect(resolved.sponsor).toEqual({ url: "https://sponsor.example", source: "environment" })
    expect(resolved.network.storageUrl).toBeUndefined()
    expect(resolved.network.sponsorUrl).toBe("https://sponsor.example")
  })

  it("with MIDA_DEPLOYMENTS_DIR set takes that record and says so", async () => {
    const resolved = await resolveNetwork(home(), { MIDA_DEPLOYMENTS_DIR: "/tmp/deployments" }, deps(() => X))
    expect(resolved.contractSource).toBe("deployments-dir")
    expect(resolved.builtIn.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(resolved.network.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
  })
})

describe("resolveNetwork — a saved home keeps what it saved", () => {
  it("keeps the saved contract and RPC; no saved store means the LOCAL store, never the hosted default", async () => {
    const h = home()
    saveNetwork(h) // the Sep 22 ~/.mida case: saved before storage/sponsor URLs existed
    const resolved = await resolveNetwork(h, {}, deps())
    expect(resolved.saved).toBe(true)
    expect(resolved.contractSource).toBe("network.json")
    expect(resolved.network.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(resolved.network.rpcUrl).toBe(SAVED_RPC)
    expect(resolved.storage).toEqual({ url: undefined, source: "local" })
    expect(resolved.sponsor).toEqual({ url: undefined, source: "local" })
    expect(resolved.network.storageUrl).toBeUndefined()
    expect(resolved.network.sponsorUrl).toBeUndefined()
  })

  it("a saved storageUrl and sponsorUrl come back as source network.json", async () => {
    const h = home()
    saveNetwork(h, { storageUrl: "https://stored.example", sponsorUrl: "https://saved-sponsor.example" })
    const resolved = await resolveNetwork(h, {}, deps(() => X))
    expect(resolved.storage).toEqual({ url: "https://stored.example", source: "network.json" })
    expect(resolved.sponsor).toEqual({ url: "https://saved-sponsor.example", source: "network.json" })
    expect(resolved.network.storageUrl).toBe("https://stored.example")
    expect(resolved.network.sponsorUrl).toBe("https://saved-sponsor.example")
  })

  it("the environment beats the saved services in both directions", async () => {
    const h = home()
    saveNetwork(h, { storageUrl: "https://stored.example", sponsorUrl: "https://saved-sponsor.example" })
    const off = await resolveNetwork(h, { MIDA_STORAGE_URL: "off", MIDA_SPONSOR_URL: "off" }, deps(() => X))
    expect(off.storage).toEqual({ url: undefined, source: "off" })
    expect(off.sponsor).toEqual({ url: undefined, source: "off" })
    const env = await resolveNetwork(
      h,
      { MIDA_STORAGE_URL: "https://env-store.example", MIDA_SPONSOR_URL: "https://env-sponsor.example" },
      deps(() => X),
    )
    expect(env.storage).toEqual({ url: "https://env-store.example", source: "environment" })
    expect(env.sponsor).toEqual({ url: "https://env-sponsor.example", source: "environment" })
  })

  it("MONAD_TESTNET_RPC overrides the saved rpcUrl", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, { MONAD_TESTNET_RPC: "https://env-rpc.example" }, deps(() => X))
    expect(resolved.network.rpcUrl).toBe("https://env-rpc.example")
  })
})

describe("resolveNetwork — empty env values count as unset", () => {
  it("an empty MIDA_STORAGE_URL falls through to the saved value, not 'environment'", async () => {
    const h = home()
    saveNetwork(h, { storageUrl: "https://stored.example" })
    const resolved = await resolveNetwork(h, { MIDA_STORAGE_URL: "" }, deps(() => X))
    expect(resolved.storage).toEqual({ url: "https://stored.example", source: "network.json" })
  })

  it("an empty MONAD_TESTNET_RPC falls through to the saved rpcUrl", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, { MONAD_TESTNET_RPC: "" }, deps(() => X))
    expect(resolved.network.rpcUrl).toBe(SAVED_RPC)
  })

  it("an empty MIDA_DEPLOYMENTS_DIR is no override — a shipped-record difference is a mismatch, not a conflict", async () => {
    const h = home()
    saveNetwork(h) // saved X; injected built-in Y
    const resolved = await resolveNetwork(h, { MIDA_DEPLOYMENTS_DIR: "" }, deps())
    expect(resolved.mismatch).toBeDefined()
  })
})

describe("resolveNetwork — the contract, the mismatch and the conflict", () => {
  it("saved X with a shipped Y resolves the SAVED record, flags the mismatch and names the migrate step", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, {}, deps())
    expect(resolved.network.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(resolved.mismatch).toEqual({
      saved: X.capabilityRegistry.toLowerCase(),
      builtIn: Y.capabilityRegistry.toLowerCase(),
    })
    expect(mismatchLine(resolved)).toBe(
      "this setup is on contract 0xf07d…; this version of Mida ships 0xabbd… — run `mida migrate` to move",
    )
  })

  it("saved = shipped resolves the saved record with no mismatch and no line", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, {}, deps(() => X))
    expect(resolved.mismatch).toBeUndefined()
    expect(mismatchLine(resolved)).toBeUndefined()
  })

  it("MIDA_DEPLOYMENTS_DIR naming the SAME contract resolves the saved record normally", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, { MIDA_DEPLOYMENTS_DIR: "/tmp/deployments" }, deps(() => X))
    expect(resolved.contractSource).toBe("network.json")
    expect(resolved.network.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(resolved.mismatch).toBeUndefined()
  })

  it("MIDA_DEPLOYMENTS_DIR naming a DIFFERENT contract than the saved one throws deployment-conflict naming both", async () => {
    const h = home()
    saveNetwork(h) // saved X; injected dir record Y
    const error = await resolveNetwork(h, { MIDA_DEPLOYMENTS_DIR: "/tmp/deployments" }, deps()).then(
      () => {
        throw new Error("resolveNetwork did not throw")
      },
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: "deployment-conflict" })
    expect((error as Error).message).toContain("0xf07d24")
    expect((error as Error).message).toContain("0xabbd06")
  })
})

describe("resolveNetwork — an unreadable or incomplete network.json", () => {
  it("network.json = {} throws network-json-invalid", async () => {
    const h = home()
    h.writeSecretJson("network.json", {})
    await expect(resolveNetwork(h, {}, deps())).rejects.toMatchObject({ code: "network-json-invalid" })
  })

  it("an unparseable network.json throws network-json-invalid, not a raw JSON error", async () => {
    const h = home()
    writeFileSync(h.path("network.json"), "not json {")
    await expect(resolveNetwork(h, {}, deps())).rejects.toMatchObject({ code: "network-json-invalid" })
  })

  it("a network.json whose deployment will not parse throws network-json-invalid", async () => {
    const h = home()
    h.writeSecretJson("network.json", { rpcUrl: SAVED_RPC, deployment: { nope: true } })
    await expect(resolveNetwork(h, {}, deps())).rejects.toMatchObject({ code: "network-json-invalid" })
  })
})

describe("resolveNetwork — the funder", () => {
  it("has no fund without DEPLOYER_PRIVATE_KEY, and refuses a malformed key", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, {}, deps(() => X))
    expect(resolved.network.fund).toBeUndefined()
    await expect(resolveNetwork(h, { DEPLOYER_PRIVATE_KEY: "0xnothex" }, deps(() => X))).rejects.toThrow(
      "DEPLOYER_PRIVATE_KEY",
    )
  })

  it("builds the funder for the RESOLVED deployment when DEPLOYER_PRIVATE_KEY is set", async () => {
    const h = home()
    saveNetwork(h)
    const resolved = await resolveNetwork(h, { DEPLOYER_PRIVATE_KEY: `0x${"ab".repeat(32)}` }, deps(() => X))
    expect(typeof resolved.network.fund).toBe("function")
  })
})

describe("serviceNetwork — the service entry points' share of the rule", () => {
  it("is undefined for a home with no network.json", async () => {
    expect(await serviceNetwork(home(), {})).toBeUndefined()
  })

  it("returns the resolved network for a saved home — saved contract, saved RPC, local services", async () => {
    const h = home()
    saveNetwork(h)
    const network = await serviceNetwork(h, {})
    expect(network?.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(network?.rpcUrl).toBe(SAVED_RPC)
    expect(network?.storageUrl).toBeUndefined()
    expect(network?.sponsorUrl).toBeUndefined()
  })
})
