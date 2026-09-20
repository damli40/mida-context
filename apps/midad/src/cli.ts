import { MidaHome } from "./home.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"
import { approve, init, readCheckpoints, requestAccess, revoke, saveCheckpoint } from "./skeleton.js"

const AGENTS = ["claude-code", "codex"]
const WITH_AGENT = ["request", "approve", "save-demo", "read", "revoke"]
const WITH_PROJECT = ["save-demo", "read"]
const USAGE = "usage: mida init | request <agent> | approve <agent> | save-demo <agent> <projectId> | read <agent> <projectId> | revoke <agent>   (agent = claude-code | codex)"

export interface CliDeps {
  home: MidaHome
  network: Network
  print(line: string): void
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command = "", agent = "", projectId = ""] = argv
  const usage = () => {
    deps.print(USAGE)
    return 2
  }
  if (command !== "init" && !WITH_AGENT.includes(command)) return usage()
  if (WITH_AGENT.includes(command) && !AGENTS.includes(agent)) return usage()
  if (WITH_PROJECT.includes(command) && projectId.length === 0) return usage()

  const runtime = await Runtime.open(deps.home, deps.network)
  try {
    if (command === "init") {
      const result = await init(runtime, AGENTS)
      deps.print(`owner ${result.owner}`)
      for (const [name, agentId] of Object.entries(result.agents)) deps.print(`agent ${name} ${agentId}`)
    } else if (command === "request") {
      deps.print(`requested ${agent} ${(await requestAccess(runtime, agent)).requestId}`)
    } else if (command === "approve") {
      const result = await approve(runtime, agent)
      deps.print(`approved ${agent} tx ${result.transactionHash} gas ${result.gasUsed}`)
    } else if (command === "save-demo") {
      const result = await saveCheckpoint(runtime, agent, { projectId, checkpoint: { objective: "M0 demo checkpoint", savedBy: agent } })
      deps.print(`saved ${result.contextId} tx ${result.transactionHash} in ${result.milliseconds} ms`)
    } else if (command === "read") {
      const result = await readCheckpoints(runtime, agent, projectId)
      deps.print(`read ${result.checkpoints.length} checkpoint(s) in ${result.milliseconds} ms`)
      for (const checkpoint of result.checkpoints) deps.print(`  ${checkpoint.contextId} written by ${checkpoint.authorId}`)
    } else {
      const result = await revoke(runtime, agent)
      deps.print(`revoked ${agent} tx ${result.transactionHashes.join(" ")}; new key sent to: ${result.rewrapped.join(", ") || "nobody"}`)
    }
    return 0
  } catch (error) {
    // The error code only. A message from a deeper layer is never echoed: it could carry data.
    const code = (error as { code?: unknown }).code
    deps.print(`refused: ${typeof code === "string" ? code : "ERROR"}`)
    return 1
  } finally {
    await runtime.close()
  }
}

/** Entry point for `pnpm mida`. Monad testnet only; needs DEPLOYER_PRIVATE_KEY in the environment as the funder. */
async function main(): Promise<void> {
  const { monadTestnetEnvironment } = await import("@mida/cli")
  const env = await monadTestnetEnvironment()
  try {
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    process.exitCode = await runCli(process.argv.slice(2), { home: new MidaHome(), network, print: (line) => console.log(line) })
  } finally {
    await env.stop()
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
