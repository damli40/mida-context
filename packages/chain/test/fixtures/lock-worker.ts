import { appendFileSync } from "node:fs"
import { releaseDirLock, takeDirLock } from "../../src/local.js"

const [lockDir, logPath] = process.argv.slice(2)
if (!lockDir || !logPath) throw new Error("usage: lock-worker <lockDir> <logPath>")
await takeDirLock(lockDir, { waitMs: 30_000, staleMs: 5 * 60_000 })
try {
  appendFileSync(logPath, `start ${process.pid}\n`)
  await new Promise((resolve) => setTimeout(resolve, 40))
  appendFileSync(logPath, `end ${process.pid}\n`)
} finally {
  releaseDirLock(lockDir)
}
