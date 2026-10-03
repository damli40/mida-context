// UF-C41C E6: every bench run deletes its $TMPDIR/mida-bench-* scratch folder
// at the end (the transcript fixtures are hundreds of MB) unless
// KEEP_BENCH_DIR=1 asks for it to stay. These tests call the cleanup function
// with and without the variable set in process.env and restore it afterwards.
//   cd bench && pnpm exec vitest run test/cleanup-bench-dir.test.ts

import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupBenchDir } from "../lib/env.js"

describe("cleanupBenchDir", () => {
  const original = process.env.KEEP_BENCH_DIR
  afterEach(() => {
    if (original === undefined) delete process.env.KEEP_BENCH_DIR
    else process.env.KEEP_BENCH_DIR = original
  })

  it("removes the folder when KEEP_BENCH_DIR is not set", () => {
    delete process.env.KEEP_BENCH_DIR
    const dir = mkdtempSync(join(tmpdir(), "mida-bench-f-"))
    writeFileSync(join(dir, "fixture.jsonl"), "x\n")
    cleanupBenchDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it("keeps the folder when KEEP_BENCH_DIR=1, and removes it on a later run without it", () => {
    process.env.KEEP_BENCH_DIR = "1"
    const dir = mkdtempSync(join(tmpdir(), "mida-bench-f-"))
    writeFileSync(join(dir, "fixture.jsonl"), "x\n")
    cleanupBenchDir(dir)
    expect(existsSync(dir)).toBe(true)
    delete process.env.KEEP_BENCH_DIR
    cleanupBenchDir(dir)
    expect(existsSync(dir)).toBe(false)
  })
})
