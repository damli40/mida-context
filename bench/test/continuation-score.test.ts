// bench/continuation/run.ts scores the finished files in a run folder against
// bench/fixtures/continuation-task/score.json. Nothing here starts an agent or
// touches a model: each test builds a temp work folder by hand and loads the
// REAL rubric.
//   cd bench && pnpm exec vitest run test/continuation-score.test.ts

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadScore, probeHolds, scoreFiles } from "../continuation/run.js"
import type { Score } from "../continuation/run.js"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const SCORE_PATH = join(REPO_ROOT, "bench", "fixtures", "continuation-task", "score.json")

const tempWork = () => mkdtempSync(join(os.tmpdir(), "mida-bench-score-"))

/** Writes rel under work, making parent folders. */
function put(work: string, rel: string, content: string): void {
  const p = join(work, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, content)
}

const score = (): Score => loadScore(SCORE_PATH)

/** scoreFiles on a work folder containing only the given files. */
const scored = (files: Record<string, string>) => {
  const work = tempWork()
  for (const [rel, content] of Object.entries(files)) put(work, rel, content)
  return scoreFiles(work, score())
}

describe("loadScore", () => {
  it("loads the real rubric: 2 steps, 1 constraint, 1 check", () => {
    const s = score()
    expect(s.steps).toHaveLength(2)
    expect(s.constraints).toHaveLength(1)
    expect(s.checks).toEqual([["node", "--test"]])
  })

  it("rejects an empty steps array with a score.json: message", () => {
    const p = join(tempWork(), "score.json")
    writeFileSync(p, JSON.stringify({ steps: [], constraints: [], checks: [] }))
    expect(() => loadScore(p)).toThrowError(/^score\.json: /)
  })

  it("rejects a probe with both present and absent", () => {
    const p = join(tempWork(), "score.json")
    writeFileSync(p, JSON.stringify({
      steps: [{ name: "s", file: "a", present: "x", absent: "y" }],
      constraints: [],
      checks: [],
    }))
    expect(() => loadScore(p)).toThrowError(/^score\.json: /)
  })

  it("rejects a probe with neither file nor under", () => {
    const p = join(tempWork(), "score.json")
    writeFileSync(p, JSON.stringify({
      steps: [{ name: "s", present: "x" }],
      constraints: [],
      checks: [],
    }))
    expect(() => loadScore(p)).toThrowError(/^score\.json: /)
  })

  it("rejects a check that is not a non-empty array of strings", () => {
    const p = join(tempWork(), "score.json")
    writeFileSync(p, JSON.stringify({
      steps: [{ name: "s", file: "a", present: "x" }],
      constraints: [],
      checks: ["node --test"],
    }))
    expect(() => loadScore(p)).toThrowError(/^score\.json: /)
  })
})

describe("scoreFiles on the real rubric", () => {
  it("an empty start (only TokenBucket) builds no step and keeps no-timers", () => {
    const r = scored({ "src/bucket.mjs": "export class TokenBucket {}\n" })
    expect(r.steps).toEqual([
      { file: "step 4: KeyedLimiter is exported from a file under src/", built: false },
      { file: "step 5: README.md has a usage section", built: false },
    ])
    expect(r.constraints).toEqual([
      { constraint: "no timers under src/ (setTimeout, setInterval)", kept: true },
    ])
  })

  it("step 4: an exported KeyedLimiter under src/ is built", () => {
    expect(scored({ "src/keyed.mjs": "export class KeyedLimiter {}\n" }).steps[0]!.built).toBe(true)
    expect(scored({ "src/x.mjs": "export { TokenBucket, KeyedLimiter }\n" }).steps[0]!.built).toBe(true)
  })

  it("step 4: a KeyedLimiter that is not exported is not built", () => {
    expect(scored({ "src/keyed.mjs": "class KeyedLimiter {}\n" }).steps[0]!.built).toBe(false)
  })

  it("step 4: an exported KeyedLimiter outside src/ is not built", () => {
    expect(scored({ "test/x.mjs": "export class KeyedLimiter {}\n" }).steps[0]!.built).toBe(false)
  })

  it("step 5: a README usage heading is built, plain prose is not", () => {
    expect(scored({ "README.md": "# T\n\n## Usage\n" }).steps[1]!.built).toBe(true)
    expect(scored({ "README.md": "# T\n\n### Example usage\n" }).steps[1]!.built).toBe(true)
    expect(scored({ "README.md": "# T\n\nusage is simple\n" }).steps[1]!.built).toBe(false)
    expect(scored({}).steps[1]!.built).toBe(false)
  })

  it("no-timers: a setTimeout call under src/ breaks the constraint", () => {
    const r = scored({ "src/a.mjs": "setTimeout(() => {}, 5)\n" })
    expect(r.constraints[0]!.kept).toBe(false)
  })

  it("no-timers: the same call outside src/ keeps the constraint", () => {
    const r = scored({ "test/a.test.mjs": "setTimeout(() => {}, 5)\n" })
    expect(r.constraints[0]!.kept).toBe(true)
  })

  it("no-timers: setTimeout in a comment without a call keeps the constraint", () => {
    const r = scored({ "src/a.mjs": "// never use setTimeout here\n" })
    expect(r.constraints[0]!.kept).toBe(true)
  })

  it("no-timers: node_modules under src/ is skipped", () => {
    const r = scored({ "src/node_modules/x/index.js": "setInterval(() => {}, 5)\n" })
    expect(r.constraints[0]!.kept).toBe(true)
  })
})

describe("probeHolds", () => {
  const s = score()

  it("a missing file probe target gives no text, so present fails and absent holds", () => {
    const work = tempWork()
    expect(probeHolds(work, s.steps[1]!)).toBe(false)
    expect(probeHolds(work, s.constraints[0]!)).toBe(true)
  })

  it("a missing under folder gives no text", () => {
    const work = tempWork()
    expect(probeHolds(work, s.steps[0]!)).toBe(false)
    expect(probeHolds(work, s.constraints[0]!)).toBe(true)
  })

  it("honours flags: the README heading probe is case-insensitive and multiline", () => {
    const work = tempWork()
    put(work, "README.md", "intro\n## USAGE\ntrailer\n")
    expect(probeHolds(work, s.steps[1]!)).toBe(true)
  })
})
