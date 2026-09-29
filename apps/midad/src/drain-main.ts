import { compileCheckpoint, compileModelChoice } from "@mida/compiler"
import { drainUntilSettled } from "./drain.js"
import { resolveHome } from "./home.js"
import { appendLog } from "./log.js"
import { serviceNetwork } from "./network.js"
import { ServiceRuntime } from "./runtime.js"

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
    // The same resolution the daemon uses — a drain that ran a different contract or store than
    // the daemon would split the setup's checkpoints in two.
    const network = await serviceNetwork(home, process.env).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === "network-json-invalid") return undefined
      throw error
    })
    if (network === undefined) {
      throw new Error("network.json is missing or incomplete; run mida init first")
    }
    // the drainer holds agent keys only — funding is the owner CLI's job
    network.fund = async () => { throw new Error("the drainer cannot fund accounts") }
    return ServiceRuntime.open(home, network, { role: "save-helper" })
  }

  // The detached drainer honours the same provider choice the daemon resolves —
  // a drain that ignored DEEPSEEK_API_KEY or a pin would silently compile with haiku.
  const compileModel = compileModelChoice(process.env)

  // One settle run: it waits out the save gap inside the drain lock rather than leaving a
  // held-back job for a hook that may never come.
  const result = await drainUntilSettled({
    home,
    open,
    compile: (input) => compileCheckpoint({ ...input, model: compileModel.model, fallbackModels: compileModel.fallbacks }),
  })
  // drainUntilSettled already wrote the "lock-held" line when another drainer owns the
  // queue — logging "pass" here too would claim a clean pass that never ran
  if (result.lockHeld !== true) appendLog(home, "drain", { outcome: "pass", ...result })
}

// Like the hook, the drainer fails open: a broken drain writes a log line at most, never an exit code.
main()
  .catch(() => {})
  .finally(() => process.exit(0))
