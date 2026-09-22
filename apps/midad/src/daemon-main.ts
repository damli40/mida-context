import { parseDeployment } from "@mida/chain"
import { compileCheckpoint, compileModelChoice } from "@mida/compiler"
import { startDaemon } from "./daemon.js"
import { resolveHome } from "./home.js"
import { appendLog } from "./log.js"
import type { Network } from "./runtime.js"

/**
 * The long-running Mida process entry. Like the detached drainer it never loads `.env` — the home
 * folder carries everything: agent keys under `agents/` and the public chain coordinates `init`
 * wrote to `network.json`. With no `network.json` there is nothing to serve, so it exits non-zero
 * and quietly; the spawner's health polling is what notices.
 */
async function main(): Promise<void> {
  const home = resolveHome(process.env)
  const stored = home.readJson<{ rpcUrl?: unknown; deployment?: unknown; storageUrl?: unknown; sponsorUrl?: unknown }>("network.json")
  if (typeof stored?.rpcUrl !== "string" || stored.deployment === undefined) {
    process.exit(1)
  }
  const network: Network = {
    rpcUrl: stored.rpcUrl,
    deployment: parseDeployment(stored.deployment),
    // the daemon holds agent keys only — funding is the owner CLI's job
    fund: async () => { throw new Error("the daemon cannot fund accounts") },
    storageUrl: typeof stored.storageUrl === "string" ? stored.storageUrl : undefined,
    sponsorUrl: typeof stored.sponsorUrl === "string" ? stored.sponsorUrl : undefined,
  }

  // The compile model is chosen once here from the environment (MIDA_COMPILE_MODEL /
  // the provider keys): deepseek → kimi → haiku, with the chain as its ordered fallbacks.
  const compileModel = compileModelChoice(process.env)
  const daemon = await startDaemon({
    home,
    network,
    compile: (input) => compileCheckpoint({ ...input, model: compileModel.model, fallbackModels: compileModel.fallbacks }),
    now: () => Date.now(),
    log: (entry) => appendLog(home, "daemon", entry as Record<string, unknown>),
  })
  // A live daemon already owns this home — this process has nothing to do.
  if (daemon.alreadyRunning) process.exit(0)

  const shutdown = () => {
    void daemon.close().finally(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((error) => {
  // one plain line when the home was never initialised — the fix is `mida init`, not a retry
  if (error instanceof Error) console.error(error.message)
  process.exit(1)
})
