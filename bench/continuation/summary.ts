// bench/continuation/summary.ts — counts the continuation benchmark's runs.
// run.ts writes <runs root>/<condition>/<n>/run.json per run; this reads those
// back and prints how many runs were started, scored and finished, per
// condition. It never runs an agent and never touches a model.
//
//   node --import tsx bench/continuation/summary.ts [--runs-root <dir>] [--json]
//
// A run folder under <root>/<condition>/ is one run that was STARTED. It is
// SCORED only if it holds a run.json that parses and carries the fields the
// summary needs (steps, checks, constraints, aProducedOutput, aLeftWork, bRan).
// "Finished" counts started runs, so a crashed run counts as not finished.
// Three kinds of scored run are not continuation tests and are left out of the
// "of" numbers, each in its own column: agent A produced nothing, agent A had
// already built every step before it was stopped, or agent B never ran (a
// logged-out or rate-limited CLI exits at once). A run can be counted in more
// than one of those columns but is subtracted from "of" only once.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { RUNS_ROOT } from "./run.js"

export type Condition = "mida" | "none" | "raw"
const CONDITIONS: readonly Condition[] = ["mida", "none", "raw"]

const USAGE = "usage: bench/continuation/summary.ts [--runs-root <dir>] [--json]"

export interface RunRow {
  condition: Condition
  /** the folder holds a run.json that parses and has the fields below */
  scored: boolean
  /** every step built AND every check passed, with at least one step */
  finished: boolean
  /** every check passed but at least one step was not built */
  checksOnly: boolean
  /** agent A produced no output, so there was nothing to hand over */
  agentAEmpty: boolean
  /** scored and agent A had built every step already: nothing to continue */
  nothingLeft: boolean
  /** scored and agent B never ran (a logged-out CLI exits at once) */
  bDidNotRun: boolean
  constraintsKept: number
  constraintsTotal: number
}

export interface ConditionSummary {
  started: number
  scored: number
  finished: number
  checksOnly: number
  agentAEmpty: number
  nothingLeft: number
  bDidNotRun: number
  /** scored runs left out of "of": A empty OR nothing left OR B never ran */
  leftOut: number
  constraintsKept: number
  constraintsTotal: number
}

export interface Summary {
  mida: ConditionSummary
  none: ConditionSummary
  raw: ConditionSummary
}

interface RunJson {
  aProducedOutput: boolean
  aLeftWork: boolean
  bRan: boolean
  steps: { built: boolean }[]
  checks: { pass: boolean }[]
  constraints: { kept: boolean }[]
}

const isBooleans = (v: unknown, field: string): v is Record<string, boolean>[] =>
  Array.isArray(v) && v.every((e) => typeof e === "object" && e !== null && typeof (e as Record<string, unknown>)[field] === "boolean")

/** Parses run.json into RunJson, or null when it is missing, unparseable or incomplete. */
function parseRunJson(path: string): RunJson | null {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.aProducedOutput !== "boolean") return null
  if (typeof b.aLeftWork !== "boolean") return null
  if (typeof b.bRan !== "boolean") return null
  if (!isBooleans(b.steps, "built")) return null
  if (!isBooleans(b.checks, "pass")) return null
  if (!isBooleans(b.constraints, "kept")) return null
  return b as unknown as RunJson
}

function rowFrom(condition: Condition, dir: string): RunRow {
  const row: RunRow = {
    condition,
    scored: false,
    finished: false,
    checksOnly: false,
    agentAEmpty: false,
    nothingLeft: false,
    bDidNotRun: false,
    constraintsKept: 0,
    constraintsTotal: 0,
  }
  const run = parseRunJson(join(dir, "run.json"))
  if (run === null) return row
  row.scored = true
  const allChecksPass = run.checks.every((c) => c.pass)
  const allStepsBuilt = run.steps.every((s) => s.built)
  row.nothingLeft = !run.aLeftWork
  row.bDidNotRun = !run.bRan
  row.agentAEmpty = !run.aProducedOutput
  // a run that never tested a continuation is neither finished nor checksOnly
  const leftOut = row.agentAEmpty || row.nothingLeft || row.bDidNotRun
  row.finished = !leftOut && run.steps.length > 0 && allStepsBuilt && allChecksPass
  row.checksOnly = !leftOut && allChecksPass && run.steps.some((s) => !s.built)
  row.constraintsKept = run.constraints.filter((c) => c.kept).length
  row.constraintsTotal = run.constraints.length
  return row
}

/** Every sub-folder of <root>/<condition>/ is one started run. Never throws. */
export function readRuns(root: string): RunRow[] {
  const rows: RunRow[] = []
  for (const condition of CONDITIONS) {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(join(root, condition), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      rows.push(rowFrom(condition, join(root, condition, entry.name)))
    }
  }
  return rows
}

const emptyCounts = (): ConditionSummary => ({
  started: 0, scored: 0, finished: 0, checksOnly: 0, agentAEmpty: 0, nothingLeft: 0, bDidNotRun: 0, leftOut: 0, constraintsKept: 0, constraintsTotal: 0,
})

export function summarize(rows: RunRow[]): Summary {
  const summary: Summary = { mida: emptyCounts(), none: emptyCounts(), raw: emptyCounts() }
  for (const row of rows) {
    const s = summary[row.condition]
    s.started += 1
    if (!row.scored) continue
    s.scored += 1
    if (row.finished) s.finished += 1
    if (row.checksOnly) s.checksOnly += 1
    if (row.agentAEmpty) s.agentAEmpty += 1
    if (row.nothingLeft) s.nothingLeft += 1
    if (row.bDidNotRun) s.bDidNotRun += 1
    // one run may sit in more than one of those columns but leaves "of" once
    if (row.agentAEmpty || row.nothingLeft || row.bDidNotRun) s.leftOut += 1
    s.constraintsKept += row.constraintsKept
    s.constraintsTotal += row.constraintsTotal
  }
  return summary
}

const runsWord = (n: number) => (n === 1 ? "run" : "runs")

export function renderSummary(summary: Summary, root: string): string {
  const total = summary.mida.started + summary.none.started + summary.raw.started
  if (total === 0) {
    return (
      `Continuation benchmark: no runs in ${root}\n\n` +
      "Nothing to count yet. Each run is one call of bench/continuation/run.ts with --condition mida, none or raw.\n"
    )
  }
  const rowLine = (label: string, s: ConditionSummary) =>
    `| ${label} | ${s.started} | ${s.scored} | ${s.finished} | ${s.checksOnly} | ${s.agentAEmpty} | ${s.nothingLeft} | ${s.bDidNotRun} | ${s.constraintsKept} of ${s.constraintsTotal} |\n`
  const ofRuns = (s: ConditionSummary) => s.started - s.leftOut
  const withoutFinished = summary.none.finished + summary.raw.finished
  const withoutOf = ofRuns(summary.none) + ofRuns(summary.raw)
  return (
    `Continuation benchmark: ${total} ${runsWord(total)} in ${root}\n\n` +
    "| Condition | Runs started | Scored | Finished | Checks passed, job not finished | Agent A produced nothing | Nothing left to continue | Agent B did not run | Rules kept |\n" +
    "|---|---|---|---|---|---|---|---|---|\n" +
    rowLine("With Mida (mida)", summary.mida) +
    rowLine("Without Mida, nothing given (none)", summary.none) +
    rowLine("Without Mida, transcript tail pasted (raw)", summary.raw) +
    "\n" +
    `With Mida: ${summary.mida.finished} of ${ofRuns(summary.mida)} ${runsWord(ofRuns(summary.mida))} finished.\n` +
    `Without Mida: ${withoutFinished} of ${withoutOf} ${runsWord(withoutOf)} finished ` +
    `(nothing given: ${summary.none.finished} of ${ofRuns(summary.none)}; transcript tail pasted: ${summary.raw.finished} of ${ofRuns(summary.raw)}).\n` +
    "\n" +
    'Finished means every step was built and every check passed. "Of" counts every run that was started, so a run that crashed or was never scored counts as not finished. Three kinds of run are left out of "of" because they are not continuation tests: the first agent produced nothing, the first agent had already built every step before it was stopped, or the second agent never ran.\n'
  )
}

/** Returns the process exit code; exported so the test needs no subprocess. */
export function main(argv: readonly string[]): number {
  let root = RUNS_ROOT
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === "--json") {
      json = true
    } else if (flag === "--runs-root") {
      const v = argv[++i]
      if (v === undefined || v.startsWith("--")) {
        process.stderr.write(`${USAGE}\n`)
        return 2
      }
      root = v
    } else {
      process.stderr.write(`${USAGE}\n`)
      return 2
    }
  }
  const summary = summarize(readRuns(root))
  if (json) console.log(JSON.stringify(summary, null, 2))
  else process.stdout.write(renderSummary(summary, root))
  return 0
}

const invokedAs = process.argv[1] !== undefined ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (invokedAs) {
  process.exitCode = main(process.argv.slice(2))
}
