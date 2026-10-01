import { describe, expect, it } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { releaseDirLock, takeDirLock } from "../src/local.js"

// PROC-07 (Oct 1): a test run killed mid-deploy left contracts/deployments/.deploy-lock behind, and
// every later test file that deploys waited out the full ten minutes behind a lock nobody held.
// The Oct 1 follow-up: deciding "stale" by age alone let two waiters both remove the same lock and
// both hold it (36 of 40 rounds with 8 processes). UF-K: a lock is left behind only when its owner
// pid is gone, or when it has no owner file and is older than the stale threshold — a lock whose
// owner pid is running is never taken, however old (the 30-minute override robbed live deploys
// that were merely slow, and two deploys then wrote the same deployment file). Takeovers are
// serialised through a `${lock}.steal` mutex so one waiter removes a leftover at a time, and the
// lock is re-checked inside that mutex before it is removed.
describe("the local deploy lock", () => {
  const lockIn = () => join(mkdtempSync(join(tmpdir(), "mida-deploy-lock-")), ".deploy-lock")

  it("takes over a lock left by a killed run — one older than any real deploy", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, tenMinutesAgo, tenMinutesAgo)
    await takeDirLock(lock, { waitMs: 1_000, staleMs: 5 * 60_000 })
    expect(existsSync(lock)).toBe(true) // held by this caller now
  })

  it("takes over a lock whose owner process is gone, however new the directory is", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    const dead = spawnSync(process.execPath, ["-e", ""])
    if (dead.pid === undefined) throw new Error("could not spawn a child for a dead pid")
    writeFileSync(join(lock, "owner"), String(dead.pid))
    await takeDirLock(lock, { waitMs: 1_000, staleMs: 5 * 60_000 })
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(String(process.pid))
  })

  it("still waits for a fresh lock, and the timeout names the holder and what to do", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    writeFileSync(join(lock, "owner"), String(process.pid))
    await expect(takeDirLock(lock, { waitMs: 400, staleMs: 5 * 60_000 })).rejects.toThrow(
      `deploy lock ${lock} held for 0.4s by pid ${process.pid}. If no test run is active, delete that folder.`,
    )
  })

  it("the timeout names no pid when the lock's owner is unknown", async () => {
    const lock = lockIn()
    mkdirSync(lock) // ownerless and fresh — not left behind, and nobody to name
    await expect(takeDirLock(lock, { waitMs: 400, staleMs: 5 * 60_000 })).rejects.toThrow(
      `deploy lock ${lock} held for 0.4s. If no test run is active, delete that folder.`,
    )
  })

  // UF-K: a lock whose owner pid is running is never taken, however old — the 30-minute
  // maxHoldMs override is gone; it took the lock from live deploys that were merely slow.
  it("never takes a lock whose owner is still running, however old the directory is", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    writeFileSync(join(lock, "owner"), String(process.pid))
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000)
    utimesSync(lock, fortyMinutesAgo, fortyMinutesAgo)
    await expect(takeDirLock(lock, { waitMs: 400, staleMs: 5 * 60_000 })).rejects.toThrow(/deploy lock .* held/)
  })

  it("releaseDirLock removes only a lock this process owns", async () => {
    const missing = lockIn()
    expect(() => releaseDirLock(missing)).not.toThrow()

    const mine = lockIn()
    mkdirSync(mine)
    writeFileSync(join(mine, "owner"), String(process.pid))
    releaseDirLock(mine)
    expect(existsSync(mine)).toBe(false)

    const theirs = lockIn()
    mkdirSync(theirs)
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
    if (holder.pid === undefined) throw new Error("could not spawn the lock holder")
    writeFileSync(join(theirs, "owner"), String(holder.pid))
    try {
      releaseDirLock(theirs)
      expect(existsSync(theirs)).toBe(true)
    } finally {
      holder.kill()
      await new Promise((resolve) => holder.once("exit", resolve))
    }
  })

  // UF-J: the workers used to race whenever each one's spawn happened to land; with staggered
  // starts the `.steal` mutex could be removed and the test still passed. Every worker now waits
  // for one shared instant ~400 ms out before calling takeDirLock, so all twelve hit the leftover
  // lock together — removing the mutex really does let two holders overlap.
  it("twelve waiters starting at one instant never hold the lock at once", async () => {
    const worker = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url))
    // failures collect per round instead of aborting at the first one: when this test is run
    // against a mutex-less takeDirLock as a check of itself, the message names every round
    // that let two holders overlap.
    const failures: number[] = []
    for (let round = 0; round < 10; round++) {
      const dir = mkdtempSync(join(tmpdir(), "mida-deploy-lock-race-"))
      const lock = join(dir, ".deploy-lock")
      const logPath = join(dir, "log")
      mkdirSync(lock) // a leftover: no owner file, ten minutes old
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(lock, tenMinutesAgo, tenMinutesAgo)

      const startAt = Date.now() + 400 // shared instant: every worker waits for it, then strikes
      const children = Array.from({ length: 12 }, () =>
        spawn(process.execPath, ["--import", "tsx", worker, lock, logPath, String(startAt)]),
      )
      try {
        await Promise.all(
          children.map(
            (child) =>
              new Promise<void>((resolve, reject) => {
                child.once("error", reject)
                child.once("exit", (code) =>
                  code === 0 ? resolve() : reject(new Error(`lock worker exited with code ${code}`)),
                )
              }),
          ),
        )

        const lines = readFileSync(logPath, "utf8").trim().split("\n")
        if (lines.length !== 24) throw new Error(`${lines.length} log lines, expected 24`)
        let holder: string | undefined
        for (const line of lines) {
          const [kind, pid] = line.split(" ")
          if (kind === "start") {
            if (holder !== undefined) throw new Error(`${pid} started while ${holder} held the lock`)
            holder = pid
          } else {
            if (kind !== "end" || pid !== holder) throw new Error(`out-of-order line "${line}"`)
            holder = undefined
          }
        }
        if (holder !== undefined) throw new Error(`${holder} never ended`)
      } catch {
        failures.push(round)
      }
    }
    expect(failures).toEqual([])
  })

  // UF-K: a waiter that wins `.steal` must re-check the lock under the mutex before removing
  // it — another waiter may have retaken it while this one was paused between seeing the lock
  // left behind and making the mutex. Worker B pauses 600 ms there (the beforeTakeover hook);
  // worker A starts 150 ms later with no pause and holds the lock for 1,200 ms. The re-check
  // makes B's `start` come after A's `end`; without it B removes A's live lock and holds the
  // same lock beside A.
  it("a waiter that clears a leftover re-checks under the steal mutex — a live holder wins (UF-K)", async () => {
    const worker = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), "mida-deploy-lock-recheck-"))
    const lock = join(dir, ".deploy-lock")
    const logPath = join(dir, "log")
    mkdirSync(lock) // a leftover: no owner file, ten minutes old
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, tenMinutesAgo, tenMinutesAgo)
    const spawnWorker = (beforeTakeoverMs: number, holdMs: number) =>
      spawn(process.execPath, ["--import", "tsx", worker, lock, logPath, "", String(beforeTakeoverMs), String(holdMs)])
    const exited = (child: ReturnType<typeof spawn>) =>
      new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`lock worker exited with code ${code}`))))
      })
    const b = spawnWorker(600, 0)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const a = spawnWorker(0, 1_200)
    await Promise.all([exited(b), exited(a)])
    const lines = readFileSync(logPath, "utf8").trim().split("\n")
    const aEnd = lines.indexOf(`end ${a.pid}`)
    const bStart = lines.indexOf(`start ${b.pid}`)
    expect(aEnd).toBeGreaterThanOrEqual(0)
    expect(bStart).toBeGreaterThanOrEqual(0)
    expect(bStart).toBeGreaterThan(aEnd)
  })
})
