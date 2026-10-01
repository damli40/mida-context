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
// both hold it (36 of 40 rounds with 8 processes), and a live deploy paused past five minutes — a
// sleeping laptop — was robbed. A lock is now left behind only when its owner pid is gone, and
// takeovers are serialised through a `${lock}.steal` mutex so one waiter removes it at a time.
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

  it("still waits for a fresh lock, and says so when the wait runs out", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    await expect(takeDirLock(lock, { waitMs: 400, staleMs: 5 * 60_000 })).rejects.toThrow(/deploy lock .* held/)
  })

  it("never takes a lock whose owner is still running, however old the directory is", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    writeFileSync(join(lock, "owner"), String(process.pid))
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, tenMinutesAgo, tenMinutesAgo)
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

  it("eight waiters never hold the lock at once", async () => {
    const worker = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url))
    for (let round = 0; round < 5; round++) {
      const dir = mkdtempSync(join(tmpdir(), "mida-deploy-lock-race-"))
      const lock = join(dir, ".deploy-lock")
      const logPath = join(dir, "log")
      mkdirSync(lock) // a leftover: no owner file, ten minutes old
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(lock, tenMinutesAgo, tenMinutesAgo)

      const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["--import", "tsx", worker, lock, logPath]))
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
      expect(lines).toHaveLength(16)
      let holder: string | undefined
      for (const line of lines) {
        const [kind, pid] = line.split(" ")
        if (kind === "start") {
          expect(holder).toBeUndefined() // a start between another pid's start and end means two holders
          holder = pid
        } else {
          expect(kind).toBe("end")
          expect(pid).toBe(holder)
          holder = undefined
        }
      }
      expect(holder).toBeUndefined()
    }
  })
})
