import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { takeDirLock } from "../src/local.js"

// PROC-07 (Oct 1): a test run killed mid-deploy left contracts/deployments/.deploy-lock behind, and
// every later test file that deploys waited out the full ten minutes behind a lock nobody held.
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

  it("still waits for a fresh lock, and says so when the wait runs out", async () => {
    const lock = lockIn()
    mkdirSync(lock)
    await expect(takeDirLock(lock, { waitMs: 400, staleMs: 5 * 60_000 })).rejects.toThrow(/deploy lock .* held/)
  })

  it("takes a free lock at once", async () => {
    const lock = lockIn()
    await takeDirLock(lock, { waitMs: 400, staleMs: 5 * 60_000 })
    expect(existsSync(lock)).toBe(true)
  })
})
