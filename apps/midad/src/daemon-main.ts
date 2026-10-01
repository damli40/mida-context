import { compileCheckpoint } from "@mida/compiler"
import { startDaemon } from "./daemon.js"
import { compileWithSummarizer } from "./summarizer.js"
import { resolveHome } from "./home.js"
import { appendLog } from "./log.js"
import { serviceNetwork } from "./network.js"

/**
 * The long-running Mida process entry. Like the detached drainer it never loads `.env` — the home
 * folder carries everything: agent keys under `agents/` and the public chain coordinates `init`
 * wrote to `network.json`. With no `network.json` there is nothing to serve, so it exits non-zero
 * and quietly; the spawner's health polling is what notices.
 */
async function main(): Promise<void> {
  const home = resolveHome(process.env)
  // The same resolution every entry point uses: the saved contract, RPC and service URLs —
  // never the contract this build happens to ship. A home with no usable network.json has
  // nothing to serve: exit quietly, as before.
  const network = await serviceNetwork(home, process.env).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "network-json-invalid") return undefined
    throw error
  })
  if (network === undefined) {
    process.exit(1)
  }
  // the daemon holds agent keys only — funding is the owner CLI's job
  network.fund = async () => { throw new Error("the daemon cannot fund accounts") }

  // The summariser is NOT chosen here: the saved choice (summarizer.json), the environment
  // and PATH are re-read on EVERY compile inside compileWithSummarizer, so a choice written
  // while the daemon runs takes effect on the next save — no restart. An empty chain fails
  // honestly as "no-summarizer" with no model run.
  const daemon = await startDaemon({
    home,
    network,
    compile: compileWithSummarizer(home, process.env, compileCheckpoint),
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
