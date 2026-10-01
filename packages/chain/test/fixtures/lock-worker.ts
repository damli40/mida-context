import { appendFileSync, existsSync } from "node:fs"
import { releaseDirLock, takeDirLock } from "../../src/local.js"

const [lockDir, logPath, startAtArg, pauseBeforeTakeoverArg, holdMsArg] = process.argv.slice(2)
if (!lockDir || !logPath)
  throw new Error("usage: lock-worker <lockDir> <logPath> [startAtMs] [pauseBeforeTakeoverMs] [holdMs]")
// UF-J: a shared start instant — every worker sleeps until it, so all of them hit the
// leftover lock together instead of racing whenever each spawn happened to land.
const startAt = Number(startAtArg)
if (Number.isFinite(startAt) && startAt > 0) {
  const delay = startAt - Date.now()
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}
// UF-K: optional pauses — beforeTakeoverMs sleeps inside takeDirLock's beforeTakeover hook
// (after the lock was seen left behind, before the .steal mkdir), holdMs is how long the
// lock is held once taken.
// UF-L: beforeTakeoverMs "go" is a handshake instead of a sleep — the worker logs `paused`
// then polls every 20 ms for a `<lockDir>.go` file the test writes, so the two-worker
// re-check test drives the interleaving instead of hoping a 150 ms stagger lands inside it.
const pauseBeforeTakeover = Number(pauseBeforeTakeoverArg)
const holdMs = Number.isFinite(Number(holdMsArg)) ? Number(holdMsArg) : 40
await takeDirLock(lockDir, {
  waitMs: 30_000,
  staleMs: 5 * 60_000,
  ...(pauseBeforeTakeoverArg === "go"
    ? {
        beforeTakeover: async () => {
          appendFileSync(logPath, `paused ${process.pid}\n`)
          while (!existsSync(`${lockDir}.go`)) await new Promise((resolve) => setTimeout(resolve, 20))
        },
      }
    : Number.isFinite(pauseBeforeTakeover) && pauseBeforeTakeoverArg !== undefined
      ? { beforeTakeover: () => new Promise((resolve) => setTimeout(resolve, pauseBeforeTakeover)) }
      : {}),
})
try {
  appendFileSync(logPath, `start ${process.pid}\n`)
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  appendFileSync(logPath, `end ${process.pid}\n`)
} finally {
  releaseDirLock(lockDir)
}
