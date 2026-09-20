// The deterministic benchmark runner. Runs the seven group files in order as
// child processes — exactly the way each group is run by hand — collects every
// JSON line they emit, and writes docs/evidence/bench-<YYYY-MM-DD>.json:
//   { commit, startedAt, seconds, checks: [...] }
// Skipped checks are kept with their reason — a check that cannot run locally
// stays visible in the evidence instead of silently absent. Prints one summary
// line and exits non-zero when any check failed.

import { execSync, spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
const GROUPS = [
  "a-cost.ts",
  "b-freshness.ts",
  "c-fidelity.ts",
  "d-safety.ts",
  "e-authority.ts",
  "f-scale.ts",
  "h-reliability.ts",
]

interface BenchCheck {
  id: string
  pass: boolean | null
  skipped?: string
  value?: unknown
  limit?: unknown
  unit?: string
  detail?: unknown
}

/** Child env: everything the groups need, minus anything that looks like a model key. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_")) delete env[key]
  }
  return env
}

/** Runs one group file; resolves with the raw stdout lines. Never rejects on a
 * non-zero exit — a group's exit code IS its failed-check count, not an error. */
function runGroupFile(file: string): Promise<{ lines: string[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join("bench", "deterministic", file)], {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "inherit"], // stderr is the groups' diagnostics channel
    })
    let stdout = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.on("error", reject)
    child.on("close", (code) => resolve({ lines: stdout.split("\n"), code }))
  })
}

const startedAt = new Date()
const checks: BenchCheck[] = []
let passed = 0
let failed = 0
let skipped = 0

for (const file of GROUPS) {
  const letter = file.split("-")[0]!.toUpperCase()
  const { lines, code } = await runGroupFile(file)
  let sawCheck = false
  let sawBadLine = false
  for (const line of lines) {
    if (line.trim() === "") continue
    try {
      const check = JSON.parse(line) as BenchCheck
      checks.push(check)
      sawCheck = true
      if (check.pass === null || check.skipped !== undefined) skipped += 1
      else if (check.pass) passed += 1
      else failed += 1
    } catch {
      sawBadLine = true
    }
  }
  // contract violations surface as failed checks — never silently, never with
  // the offending line's contents (stdout could carry anything)
  if (sawBadLine) {
    checks.push({ id: `${letter}.output`, pass: false, value: "non-json-stdout" })
    failed += 1
  }
  if (!sawCheck && code !== 0) {
    checks.push({ id: `${letter}.group`, pass: false, value: "no-check-output" })
    failed += 1
  }
}

const seconds = Math.round((Date.now() - startedAt.getTime()) / 100) / 10
const day = startedAt.toISOString().slice(0, 10)
const evidenceDir = join(REPO_ROOT, "docs", "evidence")
mkdirSync(evidenceDir, { recursive: true })
const evidencePath = join(evidenceDir, `bench-${day}.json`)
const commit = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim()
writeFileSync(
  evidencePath,
  `${JSON.stringify({ commit, startedAt: startedAt.toISOString(), seconds, checks }, null, 2)}\n`,
)

console.log(
  `bench: ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s -> docs/evidence/bench-${day}.json`,
)
process.exitCode = Math.min(failed, 9)
