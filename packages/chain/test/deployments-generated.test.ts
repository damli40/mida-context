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
    const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID)
    expect(deployment.chainId).toBe(MONAD_TESTNET_CHAIN_ID)
    expect(deployment.capabilityRegistry).toBe("0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b")
    expect(deployment.contextRegistry).toBe("0x350dc422bb2979684573409f229679fed383b2e5")
    expect(deployment.deploymentBlock).toBe(63193282n)
  })

  it("never embeds the local-Anvil record — it is per-machine and stays a disk read", () => {
    expect(EMBEDDED_DEPLOYMENTS["31337"]).toBeUndefined()
    expect(Object.keys(EMBEDDED_DEPLOYMENTS)).toEqual(["10143"])
  })
})
