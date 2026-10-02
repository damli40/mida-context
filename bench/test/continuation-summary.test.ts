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
  constraints?: { constraint: string; literalInSource: boolean }[]
  aProducedOutput?: boolean
}

const record = (over: RecordOpts = {}) => ({
  condition: "mida",
  run: 1,
  aProducedOutput: over.aProducedOutput ?? true,
  steps: over.steps ?? [{ file: "src/lru.mjs", built: true }],
  checks: over.checks ?? [{ command: "node --test", pass: true }],
  constraints: over.constraints ?? [{ constraint: "KeyedLimiter", literalInSource: true }],
})

const constraint = (kept: boolean) => ({ constraint: "c", literalInSource: kept })

/** One STARTED run folder: "none" leaves it empty, "bad" writes unparseable JSON. */
function writeRun(root: string, condition: string, n: number, body: object | "none" | "bad"): void {
  const dir = join(root, condition, String(n))
  mkdirSync(dir, { recursive: true })
  if (body === "none") return
  writeFileSync(join(dir, "run.json"), body === "bad" ? "{not json" : `${JSON.stringify(body)}\n`)
}

const tempRoot = () => mkdtempSync(join(os.tmpdir(), "mida-bench-summary-"))

/** The 14-run fixture matching the example table in the brief. */
function exampleRoot(): string {
  const root = tempRoot()
  // mida: 5 scored, all finished, 20 of 20 rules kept
  for (let n = 1; n <= 5; n += 1) {
    writeRun(root, "mida", n, record({ constraints: [constraint(true), constraint(true), constraint(true), constraint(true)] }))
  }
  // none: 6 scored, none finished, all 6 checksOnly, 3 of 24 rules kept
  const notBuilt = [{ file: "src/lru.mjs", built: true }, { file: "src/bucket.mjs", built: false }]
  writeRun(root, "none", 1, record({ steps: notBuilt, constraints: [constraint(true), constraint(true), constraint(true), constraint(false)] }))
  for (let n = 2; n <= 6; n += 1) {
    writeRun(root, "none", n, record({ steps: notBuilt, constraints: [constraint(false), constraint(false), constraint(false), constraint(false)] }))
  }
  // raw: 3 started, 2 scored (run 3 crashed before writing run.json),
  // 1 finished, 1 checksOnly, 6 of 8 rules kept
  writeRun(root, "raw", 1, record({ constraints: [constraint(true), constraint(true), constraint(true), constraint(false)] }))
  writeRun(root, "raw", 2, record({ steps: notBuilt, constraints: [constraint(true), constraint(true), constraint(true), constraint(false)] }))
  writeRun(root, "raw", 3, "none")
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
    writeRun(root, "raw", 1, { steps: [] }) // no checks, constraints or aProducedOutput
    const [row] = readRuns(root)
    expect(row).toMatchObject({ condition: "raw", scored: false })
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
      mida: { started: 5, scored: 5, finished: 5, checksOnly: 0, agentAEmpty: 0, constraintsKept: 20, constraintsTotal: 20 },
      none: { started: 6, scored: 6, finished: 0, checksOnly: 6, agentAEmpty: 0, constraintsKept: 3, constraintsTotal: 24 },
      raw: { started: 3, scored: 2, finished: 1, checksOnly: 1, agentAEmpty: 0, constraintsKept: 6, constraintsTotal: 8 },
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
})

describe("renderSummary", () => {
  it("prints the exact text for the example", () => {
    const root = exampleRoot()
    expect(renderSummary(summarize(readRuns(root)), root)).toBe(
      `Continuation benchmark: 14 runs in ${root}\n` +
      `\n` +
      `| Condition | Runs started | Scored | Finished | Checks passed, job not finished | Agent A produced nothing | Rules kept |\n` +
      `|---|---|---|---|---|---|---|\n` +
      `| With Mida (mida) | 5 | 5 | 5 | 0 | 0 | 20 of 20 |\n` +
      `| Without Mida, nothing given (none) | 6 | 6 | 0 | 6 | 0 | 3 of 24 |\n` +
      `| Without Mida, transcript tail pasted (raw) | 3 | 2 | 1 | 1 | 0 | 6 of 8 |\n` +
      `\n` +
      `With Mida: 5 of 5 runs finished.\n` +
      `Without Mida: 1 of 9 runs finished (nothing given: 0 of 6; transcript tail pasted: 1 of 3).\n` +
      `\n` +
      `Finished means every step was built and every check passed. "Of" counts every run that was started, so a run that crashed or was never scored counts as not finished.\n`,
    )
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
  it("prints the Summary object as JSON with --json and the same counts", () => {
    const root = exampleRoot()
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(main(["--runs-root", root, "--json"])).toBe(0)
      const parsed = JSON.parse(spy.mock.calls.map((c) => String(c[0])).join("\n")) as ReturnType<typeof summarize>
      expect(parsed).toEqual(summarize(readRuns(root)))
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
