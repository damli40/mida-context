// bench/continuation/summary.ts — counts the continuation benchmark's runs.
// run.ts writes <runs root>/<condition>/<n>/run.json per run; this reads those
// back and prints how many runs were started, scored and finished, per
// condition. It never runs an agent and never touches a model.
//
//   node --import tsx bench/continuation/summary.ts [--runs-root <dir>] [--json]
//
// A run folder under <root>/<condition>/ is one run that was STARTED. It is
// SCORED only if it holds a run.json that parses and carries the fields the
// summary needs (steps, checks, constraints, aProducedOutput). "Finished"
// counts started runs, so a crashed run counts as not finished.

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
  constraintsKept: number
  constraintsTotal: number
}

export interface ConditionSummary {
  started: number
  scored: number
  finished: number
  checksOnly: number
  agentAEmpty: number
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
  steps: { built: boolean }[]
  checks: { pass: boolean }[]
  constraints: { literalInSource: boolean }[]
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
  if (!isBooleans(b.steps, "built")) return null
  if (!isBooleans(b.checks, "pass")) return null
  if (!isBooleans(b.constraints, "literalInSource")) return null
  return b as unknown as RunJson
}

function rowFrom(condition: Condition, dir: string): RunRow {
  const row: RunRow = {
    condition,
    scored: false,
    finished: false,
    checksOnly: false,
    agentAEmpty: false,
    constraintsKept: 0,
    constraintsTotal: 0,
  }
  const run = parseRunJson(join(dir, "run.json"))
  if (run === null) return row
  row.scored = true
  const allChecksPass = run.checks.every((c) => c.pass)
  const allStepsBuilt = run.steps.every((s) => s.built)
  row.finished = run.steps.length > 0 && allStepsBuilt && allChecksPass
  row.checksOnly = allChecksPass && run.steps.some((s) => !s.built)
  row.agentAEmpty = !run.aProducedOutput
  row.constraintsKept = run.constraints.filter((c) => c.literalInSource).length
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
  started: 0, scored: 0, finished: 0, checksOnly: 0, agentAEmpty: 0, constraintsKept: 0, constraintsTotal: 0,
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
    `| ${label} | ${s.started} | ${s.scored} | ${s.finished} | ${s.checksOnly} | ${s.agentAEmpty} | ${s.constraintsKept} of ${s.constraintsTotal} |\n`
  const withoutFinished = summary.none.finished + summary.raw.finished
  const withoutStarted = summary.none.started + summary.raw.started
  return (
    `Continuation benchmark: ${total} ${runsWord(total)} in ${root}\n\n` +
    "| Condition | Runs started | Scored | Finished | Checks passed, job not finished | Agent A produced nothing | Rules kept |\n" +
    "|---|---|---|---|---|---|---|\n" +
    rowLine("With Mida (mida)", summary.mida) +
    rowLine("Without Mida, nothing given (none)", summary.none) +
    rowLine("Without Mida, transcript tail pasted (raw)", summary.raw) +
    "\n" +
    `With Mida: ${summary.mida.finished} of ${summary.mida.started} ${runsWord(summary.mida.started)} finished.\n` +
    `Without Mida: ${withoutFinished} of ${withoutStarted} ${runsWord(withoutStarted)} finished ` +
    `(nothing given: ${summary.none.finished} of ${summary.none.started}; transcript tail pasted: ${summary.raw.finished} of ${summary.raw.started}).\n` +
    "\n" +
    'Finished means every step was built and every check passed. "Of" counts every run that was started, so a run that crashed or was never scored counts as not finished.\n'
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
