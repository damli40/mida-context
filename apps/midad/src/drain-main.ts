import { parseDeployment } from "@mida/chain"
import { compileCheckpoint } from "@mida/compiler"
import { drainUntilSettled } from "./drain.js"
import { resolveHome } from "./home.js"
import { appendLog } from "./log.js"
import { ServiceRuntime } from "./runtime.js"
import type { Network } from "./runtime.js"

/**
 * The detached drainer entry. It never loads `.env` — everything it needs is in the home folder:
 * agent keys under `agents/`, the owner's public address in `owner-address.json`, and the public
 * chain coordinates `init` wrote to `network.json`. The owner key is never read: the drainer is a
 * service process and ServiceRuntime has no owner-signing member. If a live process holds the
 * home's lock, `ServiceRuntime.open` waits it out for up to 30 s before the drain
 * records a `lock-timeout`.
 */
async function main(): Promise<void> {
  const home = resolveHome(process.env)
  const open = async (): Promise<ServiceRuntime> => {
    const stored = home.readJson<{ rpcUrl?: unknown; deployment?: unknown; storageUrl?: unknown; sponsorUrl?: unknown }>("network.json")
    if (typeof stored?.rpcUrl !== "string" || stored.deployment === undefined) {
      throw new Error("network.json is missing or incomplete; run mida init first")
    }
    const network: Network = {
      rpcUrl: stored.rpcUrl,
      deployment: parseDeployment(stored.deployment),
      // the drainer holds agent keys only — funding is the owner CLI's job
      fund: async () => { throw new Error("the drainer cannot fund accounts") },
      // both URLs the daemon honours — a drain writing to a local store while the CLI writes to
      // the hosted one would split the checkpoints in two
      storageUrl: typeof stored.storageUrl === "string" ? stored.storageUrl : undefined,
      sponsorUrl: typeof stored.sponsorUrl === "string" ? stored.sponsorUrl : undefined,
    }
    return ServiceRuntime.open(home, network)
  }

  // One settle run: it waits out the save gap inside the drain lock rather than leaving a
  // held-back job for a hook that may never come.
  const result = await drainUntilSettled({ home, open, compile: compileCheckpoint })
  // drainUntilSettled already wrote the "lock-held" line when another drainer owns the
  // queue — logging "pass" here too would claim a clean pass that never ran
  if (result.lockHeld !== true) appendLog(home, "drain", { outcome: "pass", ...result })
}

// Like the hook, the drainer fails open: a broken drain writes a log line at most, never an exit code.
main()
  .catch(() => {})
  .finally(() => process.exit(0))
