// Plan A Task 2: every entry point resolves the network through the one rule, so the command
// side (networkForCommand) and the service side (serviceNetwork) answer the same contract for
// the same home — the Sep 22 split, where `mida` ran the built-in record while the daemon ran
// the saved one, cannot come back. X is the pre-Sep-22 deployment a real ~/.mida saved; Y is
// the record this code ships.

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDeployment } from "@mida/chain"
import { MidaHome, mismatchLine, networkForCommand, serviceNetwork } from "@mida/midad"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const X_RAW = JSON.parse(
  readFileSync(join(REPO_ROOT, "docs/evidence/deployment-10143-vault.mida.xyz-2026-09-17.json"), "utf8"),
) as unknown
const Y_RAW = JSON.parse(readFileSync(join(REPO_ROOT, "contracts/deployments/10143.json"), "utf8")) as unknown
const X = parseDeployment(X_RAW)
const Y = parseDeployment(Y_RAW)

const SAVED_RPC = "https://saved-rpc.example"

/** A Sep-22-era home: a valid network.json naming the old contract, no service URLs saved. */
const savedHome = () => {
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-entry-")))
  home.writeSecretJson("network.json", { chainId: 10143, rpcUrl: SAVED_RPC, deployment: X_RAW })
  return home
}

describe("the entry points resolve the setup's saved contract", () => {
  it("networkForCommand returns the saved deployment X — not the built-in Y — and names the mismatch", async () => {
    const resolved = await networkForCommand(savedHome(), {}, { loadBuiltIn: () => Y, probeChainId: false })
    expect(resolved.network.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(resolved.network.rpcUrl).toBe(SAVED_RPC)
    expect(resolved.mismatch).toEqual({
      saved: X.capabilityRegistry.toLowerCase(),
      builtIn: Y.capabilityRegistry.toLowerCase(),
    })
    // the stderr notice owner commands print — short addresses, the migrate pointer
    expect(mismatchLine(resolved)).toBe(
      `this setup is on contract ${X.capabilityRegistry.slice(0, 6)}…; this version of Mida ships ${Y.capabilityRegistry.slice(0, 6)}… — run \`mida migrate\` to move`,
    )
  })

  it("serviceNetwork returns the same saved network — daemon and drainer agree with the command", async () => {
    const network = await serviceNetwork(savedHome(), {})
    expect(network?.deployment.capabilityRegistry).toBe(X.capabilityRegistry)
    expect(network?.rpcUrl).toBe(SAVED_RPC)
    // a saved home with no service URLs runs the local store and pays its own gas — never the
    // hosted defaults a brand-new home would get
    expect(network?.storageUrl).toBeUndefined()
    expect(network?.sponsorUrl).toBeUndefined()
  })

  it("serviceNetwork is undefined for a home with no network.json — the first-time quiet exit", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-entry-")))
    await expect(serviceNetwork(home, {})).resolves.toBeUndefined()
  })
})
