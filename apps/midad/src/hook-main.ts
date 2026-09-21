import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveHome } from "./home.js"
import { drainerEnv, extractHookFields, runHook } from "./hook.js"
import { appendLog } from "./log.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const DRAIN_MAIN = fileURLToPath(new URL("./drain-main.ts", import.meta.url))
const DAEMON_MAIN = fileURLToPath(new URL("./daemon-main.ts", import.meta.url))
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
  await runHook({
    agent,
    stdin,
    home,
    env: process.env,
    spawnDaemon: () => {
      const child = spawn(process.execPath, ["--import", "tsx", DAEMON_MAIN], {
        detached: true,
        stdio: "ignore",
        cwd: REPO_ROOT,
        env: drainerEnv(process.env),
      })
      child.on("error", () => {})
      child.unref()
    },
    spawnDrainer: () => {
      const child = spawn(process.execPath, ["--import", "tsx", DRAIN_MAIN], {
        detached: true,
        stdio: "ignore",
        cwd: REPO_ROOT,
        env: drainerEnv(process.env),
      })
      child.on("error", () => {})
      child.unref()
    },
  })
}

// The hook fails open: whatever goes wrong, stdout stays clean and the exit code is 0.
main().catch(() => {}).finally(() => process.exit(0))
