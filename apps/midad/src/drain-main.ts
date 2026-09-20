import { parseDeployment } from "@mida/chain"
import { compileCheckpoint } from "@mida/compiler"
import { drainUntilSettled } from "./drain.js"
import { MidaHome } from "./home.js"
import { appendLog } from "./log.js"
import { Runtime } from "./runtime.js"
import type { Network } from "./runtime.js"

/**
 * The detached drainer entry. It never loads `.env` — everything it needs is in the home folder:
 * agent keys under `agents/` and the public chain coordinates `init` wrote to `network.json`. If a
 * live process holds the home's lock, `Runtime.open` waits it out for up to 30 s before the drain
 * records a `lock-timeout`.
 */
async function main(): Promise<void> {
  const home = new MidaHome(process.env.MIDA_HOME)
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

  // One settle run: it waits out the save gap inside the drain lock rather than leaving a
  // held-back job for a hook that may never come.
  const result = await drainUntilSettled({ home, open, compile: compileCheckpoint })
  appendLog(home, "drain", { outcome: "pass", ...result })
}

// Like the hook, the drainer fails open: a broken drain writes a log line at most, never an exit code.
main()
  .catch(() => {})
  .finally(() => process.exit(0))
