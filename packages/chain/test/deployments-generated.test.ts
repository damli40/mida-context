import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONAD_TESTNET_CHAIN_ID, loadDeployment } from "@mida/chain"
import { EMBEDDED_DEPLOYMENTS } from "../src/deployments.generated.js"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))

describe("deployments.generated.ts", () => {
  it("matches contracts/deployments/ — regenerate with `node scripts/gen-deployments.mjs`", () => {
    const out = join(mkdtempSync(join(tmpdir(), "mida-gendeploy-")), "deployments.generated.ts")
    execFileSync(process.execPath, [join(ROOT, "scripts", "gen-deployments.mjs"), out])
    expect(readFileSync(out, "utf8")).toBe(
      readFileSync(join(ROOT, "packages", "chain", "src", "deployments.generated.ts"), "utf8"),
    )
  })

  it("the embedded record answers loadDeployment with no directory", () => {
    // Compared against the committed record, never a copied literal: the Sep 22 redeploy moved
    // the addresses and a copied address would have failed here for the wrong reason.
    const committed = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/10143.json"), "utf8")) as {
      capabilityRegistry: string
      contextRegistry: string
      deploymentBlock: number
    }
    const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID)
    expect(deployment.chainId).toBe(MONAD_TESTNET_CHAIN_ID)
    expect(deployment.capabilityRegistry).toBe(committed.capabilityRegistry.toLowerCase())
    expect(deployment.contextRegistry).toBe(committed.contextRegistry.toLowerCase())
    expect(deployment.deploymentBlock).toBe(BigInt(committed.deploymentBlock))
  })

  it("never embeds the local-Anvil record — it is per-machine and stays a disk read", () => {
    expect(EMBEDDED_DEPLOYMENTS["31337"]).toBeUndefined()
    expect(Object.keys(EMBEDDED_DEPLOYMENTS)).toEqual(["10143"])
  })
})
