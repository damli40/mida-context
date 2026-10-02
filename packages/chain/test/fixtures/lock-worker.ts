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
// UF-L, tightened in UF-N: beforeTakeoverMs "go" and holdMs "release" are handshakes instead
// of sleeps — the worker logs `paused`, polls for a `<lockDir>.go` file the test writes, then
// logs `resumed` the moment the gate opens; and a "release" hold polls for `<lockDir>.release`
// so worker A keeps the lock until the test says the interleaving happened. Every gate wait
// gives up after 30 seconds and exits 1, so a test that stalls fails instead of hanging.
const GATE_TIMEOUT_MS = 30_000
const waitForGate = async (path: string) => {
  const giveUp = Date.now() + GATE_TIMEOUT_MS
  while (!existsSync(path)) {
    if (Date.now() > giveUp) process.exit(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const pauseBeforeTakeover = Number(pauseBeforeTakeoverArg)
const holdMs = Number.isFinite(Number(holdMsArg)) ? Number(holdMsArg) : 40
await takeDirLock(lockDir, {
  waitMs: 30_000,
  staleMs: 5 * 60_000,
  ...(pauseBeforeTakeoverArg === "go"
    ? {
        beforeTakeover: async () => {
          appendFileSync(logPath, `paused ${process.pid}\n`)
          await waitForGate(`${lockDir}.go`)
          appendFileSync(logPath, `resumed ${process.pid}\n`)
        },
      }
    : Number.isFinite(pauseBeforeTakeover) && pauseBeforeTakeoverArg !== undefined
      ? { beforeTakeover: () => new Promise((resolve) => setTimeout(resolve, pauseBeforeTakeover)) }
      : {}),
})
try {
  appendFileSync(logPath, `start ${process.pid}\n`)
  if (holdMsArg === "release") await waitForGate(`${lockDir}.release`)
  else await new Promise((resolve) => setTimeout(resolve, holdMs))
  appendFileSync(logPath, `end ${process.pid}\n`)
} finally {
  releaseDirLock(lockDir)
}
