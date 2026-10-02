// bench/continuation/summary.ts counts the real-agent continuation runs from
// the run.json files under <runs root>/<condition>/<n>/. Nothing here starts
// an agent or touches a model: each test builds a temp runs root by hand.
// NOTE: the root vitest include covers packages/*/test and apps/*/test; bench
// files are outside it. Run this file from bench/ where bench/vitest.config.ts
// picks it up:
//   cd bench && pnpm exec vitest run test/continuation-summary.test.ts

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { main, readRuns, renderSummary, summarize } from "../continuation/summary.js"

interface RecordOpts {
  steps?: { file: string; built: boolean }[]
  checks?: { command: string; pass: boolean }[]
  constraints?: { constraint: string; kept: boolean }[]
  aProducedOutput?: boolean
  aLeftWork?: boolean
  bRan?: boolean
}

const record = (over: RecordOpts = {}) => ({
  condition: "mida",
  run: 1,
  aProducedOutput: over.aProducedOutput ?? true,
  aLeftWork: over.aLeftWork ?? true,
  bRan: over.bRan ?? true,
  steps: over.steps ?? [{ file: "src/lru.mjs", built: true }],
  checks: over.checks ?? [{ command: "node --test", pass: true }],
  constraints: over.constraints ?? [{ constraint: "c", kept: true }],
})

const constraint = (kept: boolean) => ({ constraint: "c", kept })

/** One STARTED run folder: "none" leaves it empty, "bad" writes unparseable JSON. */
function writeRun(root: string, condition: string, n: number, body: object | "none" | "bad"): void {
  const dir = join(root, condition, String(n))
  mkdirSync(dir, { recursive: true })
  if (body === "none") return
  writeFileSync(join(dir, "run.json"), body === "bad" ? "{not json" : `${JSON.stringify(body)}\n`)
}

const tempRoot = () => mkdtempSync(join(os.tmpdir(), "mida-bench-summary-"))

/** The 15-run fixture matching the example table in the brief. */
function exampleRoot(): string {
  const root = tempRoot()
  // mida: 5 scored, 4 finished, 1 nothingLeft (A had built every step already)
  for (let n = 1; n <= 4; n += 1) writeRun(root, "mida", n, record())
  writeRun(root, "mida", 5, record({ aLeftWork: false }))
  // none: 5 scored, none finished, 4 checksOnly, 1 where B never ran, 2 of 5 rules kept
  const notBuilt = [{ file: "src/lru.mjs", built: true }, { file: "src/bucket.mjs", built: false }]
  writeRun(root, "none", 1, record({ steps: notBuilt }))
  writeRun(root, "none", 2, record({ steps: notBuilt }))
  writeRun(root, "none", 3, record({ steps: notBuilt, constraints: [constraint(false)] }))
  writeRun(root, "none", 4, record({ steps: notBuilt, constraints: [constraint(false)] }))
  writeRun(root, "none", 5, record({ bRan: false, constraints: [constraint(false)] }))
  // raw: 5 started, 4 scored (run 5 crashed before writing run.json),
  // 1 finished, 2 checksOnly, 1 where A produced nothing, 4 of 4 rules kept
  writeRun(root, "raw", 1, record())
  writeRun(root, "raw", 2, record({ steps: notBuilt }))
  writeRun(root, "raw", 3, record({ steps: notBuilt }))
  writeRun(root, "raw", 4, record({ aProducedOutput: false }))
  writeRun(root, "raw", 5, "none")
  return root
}

describe("readRuns", () => {
  it("counts a folder without run.json as started, not scored, not finished", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, "none")
    const [row] = readRuns(root)
    expect(row).toMatchObject({ condition: "mida", scored: false, finished: false, checksOnly: false })
  })

  it("counts a run.json that is not JSON as started, not scored, not finished", () => {
    const root = tempRoot()
    writeRun(root, "none", 1, "bad")
    const [row] = readRuns(root)
    expect(row).toMatchObject({ condition: "none", scored: false, finished: false })
  })

  it("counts a run.json missing the scored fields as started, not scored", () => {
    const root = tempRoot()
    writeRun(root, "raw", 1, { steps: [] }) // no checks, constraints, aProducedOutput or aLeftWork
    const [row] = readRuns(root)
    expect(row).toMatchObject({ condition: "raw", scored: false })
  })

  it("does not score a run.json without a boolean aLeftWork", () => {
    const root = tempRoot()
    const r = record() as Record<string, unknown>
    delete r.aLeftWork
    writeRun(root, "mida", 1, r)
    const [row] = readRuns(root)
    expect(row).toMatchObject({ scored: false, finished: false })
  })

  it("does not score a run.json without a boolean bRan", () => {
    const root = tempRoot()
    const r = record() as Record<string, unknown>
    delete r.bRan
    writeRun(root, "mida", 1, r)
    const [row] = readRuns(root)
    expect(row).toMatchObject({ scored: false, finished: false })
  })

  it("flags a scored run with bRan false as bDidNotRun, never finished even when steps and checks all hold", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record({ bRan: false }))
    const [row] = readRuns(root)
    expect(row).toMatchObject({ scored: true, bDidNotRun: true, finished: false, checksOnly: false })
  })

  it("does not score a run.json whose constraints carry the old literalInSource field", () => {
    const root = tempRoot()
    const r = record() as Record<string, unknown>
    r.constraints = [{ constraint: "c", literalInSource: true }]
    writeRun(root, "mida", 1, r)
    const [row] = readRuns(root)
    expect(row).toMatchObject({ scored: false, finished: false })
  })

  it("flags a scored run with aLeftWork false as nothingLeft, never finished", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record({ aLeftWork: false }))
    const [row] = readRuns(root)
    expect(row).toMatchObject({ scored: true, nothingLeft: true, finished: false, checksOnly: false })
  })

  it("returns zero runs for a missing root and never throws", () => {
    expect(readRuns(join(tempRoot(), "does-not-exist"))).toEqual([])
    expect(readRuns(join(tempRoot(), "also-missing", "deeper"))).toEqual([])
  })
})

describe("summarize", () => {
  it("renders the example counts", () => {
    const summary = summarize(readRuns(exampleRoot()))
    expect(summary).toEqual({
      mida: { started: 5, scored: 5, finished: 4, checksOnly: 0, agentAEmpty: 0, nothingLeft: 1, bDidNotRun: 0, leftOut: 1, constraintsKept: 5, constraintsTotal: 5 },
      none: { started: 5, scored: 5, finished: 0, checksOnly: 4, agentAEmpty: 0, nothingLeft: 0, bDidNotRun: 1, leftOut: 1, constraintsKept: 2, constraintsTotal: 5 },
      raw: { started: 5, scored: 4, finished: 1, checksOnly: 2, agentAEmpty: 1, nothingLeft: 0, bDidNotRun: 0, leftOut: 1, constraintsKept: 4, constraintsTotal: 4 },
    })
  })

  it("counts all-checks-pass with one step unbuilt as checksOnly, not finished", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record({ steps: [{ file: "a", built: true }, { file: "b", built: false }] }))
    const summary = summarize(readRuns(root))
    expect(summary.mida).toMatchObject({ finished: 0, checksOnly: 1 })
  })

  it("counts an empty steps list as not finished, even when checks pass", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record({ steps: [] }))
    const summary = summarize(readRuns(root))
    expect(summary.mida).toMatchObject({ finished: 0, checksOnly: 0 })
  })

  it("counts a failed check as neither finished nor checksOnly", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record({ checks: [{ command: "x", pass: false }] }))
    const summary = summarize(readRuns(root))
    expect(summary.mida).toMatchObject({ finished: 0, checksOnly: 0 })
  })

  it("counts aProducedOutput false under agentAEmpty", () => {
    const root = tempRoot()
    writeRun(root, "none", 1, record({ aProducedOutput: false }))
    const summary = summarize(readRuns(root))
    expect(summary.none).toMatchObject({ agentAEmpty: 1 })
  })

  it("subtracts a run that is both aLeftWork false and bRan false only once", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record())
    writeRun(root, "mida", 2, record({ aLeftWork: false, bRan: false }))
    const summary = summarize(readRuns(root))
    expect(summary.mida).toMatchObject({ nothingLeft: 1, bDidNotRun: 1, leftOut: 1 })
  })
})

describe("renderSummary", () => {
  it("prints the exact text for the example", () => {
    const root = exampleRoot()
    expect(renderSummary(summarize(readRuns(root)), root)).toBe(
      `Continuation benchmark: 15 runs in ${root}\n` +
      `\n` +
      `| Condition | Runs started | Scored | Finished | Checks passed, job not finished | Agent A produced nothing | Nothing left to continue | Agent B did not run | Rules kept |\n` +
      `|---|---|---|---|---|---|---|---|---|\n` +
      `| With Mida (mida) | 5 | 5 | 4 | 0 | 0 | 1 | 0 | 5 of 5 |\n` +
      `| Without Mida, nothing given (none) | 5 | 5 | 0 | 4 | 0 | 0 | 1 | 2 of 5 |\n` +
      `| Without Mida, transcript tail pasted (raw) | 5 | 4 | 1 | 2 | 1 | 0 | 0 | 4 of 4 |\n` +
      `\n` +
      `With Mida: 4 of 4 runs finished.\n` +
      `Without Mida: 1 of 8 runs finished (nothing given: 0 of 4; transcript tail pasted: 1 of 4).\n` +
      `\n` +
      `Finished means every step was built and every check passed. "Of" counts every run that was started, so a run that crashed or was never scored counts as not finished. Three kinds of run are left out of "of" because they are not continuation tests: the first agent produced nothing, the first agent had already built every step before it was stopped, or the second agent never ran.\n`,
    )
  })

  it("leaves a nothingLeft run out of the sentence's of number", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record())
    writeRun(root, "mida", 2, record({ aLeftWork: false }))
    const text = renderSummary(summarize(readRuns(root)), root)
    expect(text).toContain("With Mida: 1 of 1 run finished.\n")
    expect(text).toContain("| With Mida (mida) | 2 | 2 | 1 | 0 | 0 | 1 | 0 | 2 of 2 |\n")
  })

  it("leaves a bRan false run out of the of number, even one whose steps and checks all hold", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record())
    writeRun(root, "mida", 2, record({ bRan: false }))
    const text = renderSummary(summarize(readRuns(root)), root)
    expect(text).toContain("| With Mida (mida) | 2 | 2 | 1 | 0 | 0 | 0 | 1 | 2 of 2 |\n")
    expect(text).toContain("With Mida: 1 of 1 run finished.\n")
  })

  it("leaves an aProducedOutput false run out of the of number", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record())
    writeRun(root, "mida", 2, record({ aProducedOutput: false }))
    const text = renderSummary(summarize(readRuns(root)), root)
    expect(text).toContain("| With Mida (mida) | 2 | 2 | 1 | 0 | 1 | 0 | 0 | 2 of 2 |\n")
    expect(text).toContain("With Mida: 1 of 1 run finished.\n")
  })

  it("keeps a started-but-unscored run in the of number: 5 started, 1 unscored, 1 nothingLeft gives 'of 4', never 'of 3'", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record())
    writeRun(root, "mida", 2, record({ steps: [{ file: "a", built: true }, { file: "b", built: false }] }))
    writeRun(root, "mida", 3, record({ checks: [{ command: "x", pass: false }] }))
    writeRun(root, "mida", 4, record({ aLeftWork: false }))
    writeRun(root, "mida", 5, "none") // started, crashed before run.json: stays in "of"
    const text = renderSummary(summarize(readRuns(root)), root)
    expect(text).toContain("| With Mida (mida) | 5 | 4 | 1 | 1 | 0 | 1 | 0 | 4 of 4 |\n")
    expect(text).toContain("With Mida: 1 of 4 runs finished.\n")
    expect(text).not.toContain("of 3")
  })

  it("prints the no-runs text for an empty root", () => {
    const root = tempRoot()
    expect(renderSummary(summarize(readRuns(root)), root)).toBe(
      `Continuation benchmark: no runs in ${root}\n` +
      `\n` +
      `Nothing to count yet. Each run is one call of bench/continuation/run.ts with --condition mida, none or raw.\n`,
    )
  })

  it("uses the singular for one run: '1 run in' and '1 of 1 run finished'", () => {
    const root = tempRoot()
    writeRun(root, "mida", 1, record())
    const text = renderSummary(summarize(readRuns(root)), root)
    expect(text).toContain(`Continuation benchmark: 1 run in ${root}\n`)
    expect(text).toContain("With Mida: 1 of 1 run finished.\n")
  })
})

describe("main", () => {
  it("prints the Summary object as JSON with --json and carries nothingLeft", () => {
    const root = exampleRoot()
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(main(["--runs-root", root, "--json"])).toBe(0)
      const parsed = JSON.parse(spy.mock.calls.map((c) => String(c[0])).join("\n")) as ReturnType<typeof summarize>
      expect(parsed).toEqual(summarize(readRuns(root)))
      expect(parsed.mida.nothingLeft).toBe(1)
      expect(parsed.raw.nothingLeft).toBe(0)
      expect(parsed.none.nothingLeft).toBe(0)
      expect(parsed.none.bDidNotRun).toBe(1)
      expect(parsed.mida.bDidNotRun).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("prints usage and exits 2 on an unknown flag", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(main(["--bogus"])).toBe(2)
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toBe(
        "usage: bench/continuation/summary.ts [--runs-root <dir>] [--json]\n",
      )
    } finally {
      spy.mockRestore()
    }
  })
})
