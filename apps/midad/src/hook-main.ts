import { spawn } from "node:child_process"
import { resolveHome } from "./home.js"
import { drainerEnv, extractHookFields, runHook } from "./hook.js"
import { appendLog } from "./log.js"
import { siblingEntryArgs } from "./sibling.js"

const STDIN_CAP_BYTES = 1_000_000
const HEAD_BYTES = 64 * 1024

/**
 * Reads stdin to EOF — stopping early would leave the hooked CLI holding a full pipe. Only the
 * first `cap` bytes are kept: a payload bigger than that is reported as `input-too-large` or
 * salvaged by field extraction, never parsed as JSON.
 */
async function readStdin(cap: number): Promise<{ text: string; oversized: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer
    size += buf.length
    if (size <= cap) chunks.push(buf)
  }
  return { text: Buffer.concat(chunks).toString("utf8"), oversized: size > cap }
}

async function main(): Promise<void> {
  const home = resolveHome(process.env)
  const agent = process.argv[2] ?? "unknown"
  const { text, oversized } = await readStdin(STDIN_CAP_BYTES)
  let stdin = text
  if (oversized) {
    const fields = extractHookFields(text.slice(0, HEAD_BYTES))
    if (
      fields.hook_event_name !== undefined && fields.session_id !== undefined &&
      fields.transcript_path !== undefined
    ) {
      stdin = JSON.stringify(fields)
    } else {
      appendLog(home, "hook", { agent, outcome: "ignored", reason: "input-too-large" })
      return
    }
  }
  // While `migrate/in-progress` exists a migration owns this setup: the hook still queues its job
  // (runHook does that before either callback) but must not start a daemon or a drainer.
  const suppressForMigration = (): boolean => {
    if (!home.has("migrate/in-progress")) return false
    appendLog(home, "hook", { agent, outcome: "service-suppressed", reason: "migration-in-progress" })
    return true
  }
  await runHook({
    agent,
    stdin,
    home,
    env: process.env,
    // Built `midad`/`mida-drain` beside this file in dist, or the .ts entries through the
    // repo's tsx loader — sibling.ts decides; the Mida home is the child's working directory.
    spawnDaemon: () => {
      if (suppressForMigration()) return
      const child = spawn(process.execPath, siblingEntryArgs("midad"), {
        detached: true,
        stdio: "ignore",
        cwd: home.root,
        env: drainerEnv(process.env),
      })
      child.on("error", () => {})
      child.unref()
    },
    spawnDrainer: () => {
      if (suppressForMigration()) return
      const child = spawn(process.execPath, siblingEntryArgs("mida-drain"), {
        detached: true,
        stdio: "ignore",
        cwd: home.root,
        env: drainerEnv(process.env),
      })
      child.on("error", () => {})
      child.unref()
    },
  })
}

// The hook fails open: whatever goes wrong, stdout stays clean and the exit code is 0.
main().catch(() => {}).finally(() => process.exit(0))
