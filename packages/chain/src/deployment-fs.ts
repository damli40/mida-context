import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MidaError } from "@mida/protocol"
import { parseDeployment } from "./deployment.js"
import type { Deployment } from "./deployment.js"

/**
 * The filesystem half of deployment loading, split from deployment.js so that module — and every
 * module that imports it (writes.js, registry.js, sponsored.js, the browser bundle) — stays free
 * of node: specifiers. index.js re-exports this file, so the CLI surface is unchanged; the
 * `@mida/chain/browser` entry deliberately does not.
 */
let deploymentsDir: string | undefined
/**
 * The contracts/deployments directory, resolved on first use and cached. It must stay lazy: this module is
 * bundled into the store Worker, where `import.meta.url` is not a parseable URL — evaluating
 * fileURLToPath(new URL(…)) at module scope would throw on startup. The Worker never calls this.
 */
export function DEFAULT_DEPLOYMENTS_DIR(): string {
  return (deploymentsDir ??= fileURLToPath(new URL("../../../contracts/deployments/", import.meta.url)))
}

export function loadDeployment(chainId: bigint, directory: string = DEFAULT_DEPLOYMENTS_DIR()): Deployment {
  const path = `${directory.replace(/\/$/, "")}/${chainId}.json`
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new MidaError("NOT_FOUND", `no deployment file at ${path}`)
  }
  const deployment = parseDeployment(JSON.parse(text))
  if (deployment.chainId !== chainId) throw new MidaError("INVALID_WIRE", `deployment: ${path} is for chain ${deployment.chainId}`)
  return deployment
}
