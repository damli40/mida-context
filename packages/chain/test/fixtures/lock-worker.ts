import { appendFileSync } from "node:fs"
import { releaseDirLock, takeDirLock } from "../../src/local.js"

const [lockDir, logPath, startAtArg] = process.argv.slice(2)
if (!lockDir || !logPath) throw new Error("usage: lock-worker <lockDir> <logPath> [startAtMs]")
// UF-J: a shared start instant — every worker sleeps until it, so all of them hit the
// leftover lock together instead of racing whenever each spawn happened to land.
const startAt = Number(startAtArg)
if (Number.isFinite(startAt)) {
  const delay = startAt - Date.now()
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}
await takeDirLock(lockDir, { waitMs: 30_000, staleMs: 5 * 60_000 })
try {
  appendFileSync(logPath, `start ${process.pid}\n`)
  await new Promise((resolve) => setTimeout(resolve, 40))
  appendFileSync(logPath, `end ${process.pid}\n`)
} finally {
  releaseDirLock(lockDir)
}
