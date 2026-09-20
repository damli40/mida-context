import { parseDeployment } from "@mida/chain"
import { compileCheckpoint } from "@mida/compiler"
import { drainOnce } from "./drain.js"
import { MidaHome } from "./home.js"
import { appendLog } from "./log.js"
import { listJobs } from "./queue.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The detached drainer entry. It never loads `.env` — everything it needs is in the home folder:
 * agent keys under `agents/` and the public chain coordinates `init` wrote to `network.json`. If a
 * live process already holds the home's lock it exits quietly — the holder will drain.
 */
async function main(): Promise<void> {
  const home = new MidaHome(process.env.MIDA_HOME)
  try {
    const held = home.readJson<{ pid?: unknown }>("midad.lock")
    if (typeof held?.pid === "number" && held.pid !== process.pid && processAlive(held.pid)) return
  } catch {
    // a lock file that will not parse is stale; Runtime.open takes it over inside drainOnce
  }

  const open = async (): Promise<Runtime> => {
    const stored = home.readJson<{ rpcUrl?: unknown; deployment?: unknown }>("network.json")
    if (typeof stored?.rpcUrl !== "string" || stored.deployment === undefined) {
      throw new Error("network.json is missing or incomplete; run mida init first")
    }
    const network: Network = {
      rpcUrl: stored.rpcUrl,
      deployment: parseDeployment(stored.deployment),
      // the drainer holds agent keys only — funding is the owner CLI's job
      fund: async () => { throw new Error("the drainer cannot fund accounts") },
    }
    return Runtime.open(home, network)
  }

  for (;;) {
    const result = await drainOnce({ home, open, compile: compileCheckpoint })
    appendLog(home, "drain", { outcome: "pass", ...result })
    if (result.saved === 0 || listJobs(home).length === 0) break
  }
}

// Like the hook, the drainer fails open: a broken drain writes a log line at most, never an exit code.
main()
  .catch(() => {})
  .finally(() => process.exit(0))
