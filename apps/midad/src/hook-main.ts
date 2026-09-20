import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { MidaHome } from "./home.js"
import { runHook } from "./hook.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const DRAIN_MAIN = fileURLToPath(new URL("./drain-main.ts", import.meta.url))
const STDIN_CAP_BYTES = 1_000_000

/** Reads all of stdin, giving up on anything past 1 MB — a hooked CLI should never send more. */
async function readStdin(cap: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > cap) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const stdin = await readStdin(STDIN_CAP_BYTES)
  await runHook({
    agent: process.argv[2] ?? "unknown",
    stdin,
    home: new MidaHome(process.env.MIDA_HOME),
    env: process.env,
    spawnDrainer: () => {
      const child = spawn(process.execPath, ["--import", "tsx", DRAIN_MAIN], {
        detached: true,
        stdio: "ignore",
        cwd: REPO_ROOT,
        env: process.env,
      })
      child.on("error", () => {})
      child.unref()
    },
  })
}

// The hook fails open: whatever goes wrong, stdout stays clean and the exit code is 0.
main().catch(() => {}).finally(() => process.exit(0))
