// bench/continuation/run.ts carries four small pure helpers this file tests:
// the session id inside agent A's stream-json output, the lookup of A's OWN
// session file under a projects root (never "the newest file on the machine"),
// the tokens-used number inside agent B's output, and the rule for whether
// agent B ran at all. Nothing here starts an agent or touches a model.
//   cd bench && pnpm exec vitest run test/continuation-run-helpers.test.ts

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  LATE_RUNS_ROOT, agentBResumeArgv, agentCArgv, bRanOf, codexSessionIdOf,
  codexToml, harnessMarkersIn, hookCmd, injectCmd, loadScore, parseArgs,
  rawPasteOf, scoreFiles, sessionIdOf, tokensUsedOf, transcriptOfSession,
} from "../continuation/run.js"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const TRIE_SESSION = join(REPO_ROOT, "bench", "fixtures", "transcripts", "trie-session.jsonl")

const tempDir = () => mkdtempSync(join(os.tmpdir(), "mida-bench-run-"))

describe("sessionIdOf", () => {
  it("reads the id from the first JSON line that carries a session_id", () => {
    const text = [
      "not json at all",
      '{"type":"system"}',
      '{"type":"system","session_id":"abc-123"}',
      '{"type":"assistant","session_id":"later-id"}',
    ].join("\n")
    expect(sessionIdOf(text)).toBe("abc-123")
  })

  it("skips lines that are not JSON and JSON lines without an id", () => {
    expect(sessionIdOf('hello\n{"type":"init"}\n')).toBeNull()
    expect(sessionIdOf('{"session_id":""}\n')).toBeNull()
    expect(sessionIdOf("")).toBeNull()
  })

  it("rejects an id that could be a path", () => {
    expect(sessionIdOf('{"session_id":"a/b"}\n')).toBeNull()
    expect(sessionIdOf('{"session_id":".."}\n')).toBeNull()
    expect(sessionIdOf('{"session_id":"a..b"}\n')).toBeNull()
  })
})

describe("transcriptOfSession", () => {
  it("finds the named session file inside whichever project folder holds it", () => {
    const root = tempDir()
    mkdirSync(join(root, "proj-a"), { recursive: true })
    mkdirSync(join(root, "proj-b"), { recursive: true })
    writeFileSync(join(root, "proj-a", "other.jsonl"), "{}")
    writeFileSync(join(root, "proj-b", "sess-1.jsonl"), "{}")
    expect(transcriptOfSession(root, "sess-1")).toBe(join(root, "proj-b", "sess-1.jsonl"))
  })

  it("never returns a newer .jsonl with a different name", () => {
    const root = tempDir()
    mkdirSync(join(root, "proj-a"), { recursive: true })
    const target = join(root, "proj-a", "sess-2.jsonl")
    const newer = join(root, "proj-a", "zz-newer.jsonl")
    writeFileSync(target, "{}")
    // make the decoy newer than the target
    const past = new Date(Date.now() - 60_000)
    writeFileSync(newer, "{}")
    utimesSync(newer, past, new Date())
    utimesSync(target, past, past)
    expect(transcriptOfSession(root, "sess-2")).toBe(target)
    expect(transcriptOfSession(root, "missing")).toBeNull()
  })

  it("gives null for a missing id and for a root that cannot be read", () => {
    const root = tempDir()
    mkdirSync(join(root, "proj-a"), { recursive: true })
    expect(transcriptOfSession(root, "nope")).toBeNull()
    expect(transcriptOfSession(join(root, "not-there"), "nope")).toBeNull()
  })
})

describe("tokensUsedOf", () => {
  it("parses the one-line layout", () => {
    expect(tokensUsedOf("blah\ntokens used: 1,234\nmore")).toBe(1234)
  })

  it("parses the two-line layout codex prints today", () => {
    expect(tokensUsedOf("tokens used\n16,637\n")).toBe(16637)
  })

  it("gives null when there is no token line", () => {
    expect(tokensUsedOf("no tokens here\n")).toBeNull()
  })
})

describe("bRanOf", () => {
  it("is true when B exited cleanly or ran at least 60 seconds", () => {
    expect(bRanOf(0, 3)).toBe(true)
    expect(bRanOf(1, 2)).toBe(false)
    expect(bRanOf(null, 600)).toBe(true)
    expect(bRanOf(1, 60)).toBe(true)
    expect(bRanOf(null, 0)).toBe(false)
  })
})

describe("parseArgs --stop-at", () => {
  const base = ["--condition", "mida", "--run", "1", "--dry-run"]

  it("defaults to msUntilAvailable", () => {
    expect(parseArgs(base).stopAt).toBe("msUntilAvailable")
  })

  it("takes a given value", () => {
    expect(parseArgs([...base, "--stop-at", "step 3 done"]).stopAt).toBe("step 3 done")
  })

  it("rejects a missing value like the other flags", () => {
    expect(() => parseArgs([...base, "--stop-at"])).toThrowError()
    expect(() => parseArgs([...base, "--stop-at", ""])).toThrowError()
  })
})

describe("rawPasteOf", () => {
  it("pastes the readable conversation, not encoded file bytes", () => {
    const { text, fullChars } = rawPasteOf(TRIE_SESSION, 8_000)
    // the session's first user request survives as readable text, rendered in
    // the compiler's "L<n> <role>:" block format — not the session file's JSON
    expect(text).toContain("Port the session cache to a trie")
    expect(text).toMatch(/^L\d+ user:/m)
    expect(text).not.toMatch(/^\{"type":/m)
    // the old slice of raw file bytes was mostly base64-like signature data
    expect(/[A-Za-z0-9+/=]{200,}/.test(text)).toBe(false)
    expect(text.length).toBeLessThanOrEqual(8_000)
    expect(fullChars).toBeGreaterThanOrEqual(text.length)
  })

  it("cuts to the last `chars` characters and reports the whole length", () => {
    const { text, fullChars } = rawPasteOf(TRIE_SESSION, 100)
    expect(text.length).toBeLessThanOrEqual(100)
    expect(fullChars).toBeGreaterThanOrEqual(text.length)
  })

  it("returns the whole text when chars exceeds it", () => {
    const { text, fullChars } = rawPasteOf(TRIE_SESSION, 10_000_000)
    expect(text.length).toBe(fullChars)
  })
})

describe("harnessMarkersIn", () => {
  it("finds each marker and the repo root string", () => {
    const out = "I looked at TASK.md and score.json, then ../a-output.jsonl and raw-tail.txt"
    expect(harnessMarkersIn(out, "/repo")).toEqual(
      ["TASK.md", "a-output", "raw-tail", "score.json"].sort(),
    )
    expect(harnessMarkersIn(`files under /repo are off limits`, "/repo")).toEqual(["/repo"])
  })

  it("gives [] when agent B touched nothing outside the work folder", () => {
    expect(harnessMarkersIn("edited src/bucket.mjs and ran npm test", "/repo")).toEqual([])
  })

  it("is sorted and has no duplicates", () => {
    const out = "TASK.md TASK.md a-output a-output raw-tail"
    const found = harnessMarkersIn(out, "/repo")
    expect(found).toEqual([...new Set(found)].sort())
  })
})

describe("parseArgs --late-change", () => {
  const base = ["--condition", "mida", "--run", "1", "--dry-run"]

  it("is false by default and true when passed", () => {
    expect(parseArgs(base).lateChange).toBe(false)
    expect(parseArgs([...base, "--late-change"]).lateChange).toBe(true)
  })
})

describe("codexSessionIdOf", () => {
  const header = [
    "workdir: /tmp/work",
    "model: gpt-5-codex",
    "session id: 01a0fd04-fe9a-7ab3-87eb-e5a871ade246",
    "--------",
  ].join("\n")

  it("finds the id in a real-shaped Codex header", () => {
    expect(codexSessionIdOf(header)).toBe("01a0fd04-fe9a-7ab3-87eb-e5a871ade246")
  })

  it("returns null when no session id line is present", () => {
    expect(codexSessionIdOf("workdir: /tmp/work\nmodel: gpt-5\n")).toBeNull()
    expect(codexSessionIdOf("")).toBeNull()
  })

  it("does not accept the words in the middle of other text", () => {
    expect(codexSessionIdOf("the session id: 01a0fd04-fe9a-7ab3-87eb-e5a871ade246 was printed")).toBeNull()
    expect(codexSessionIdOf("session id: abc")).toBeNull()
  })
})

describe("agentCArgv", () => {
  const argv = agentCArgv("the late-change prompt")

  it("carries the prompt and a read-only tool set", () => {
    expect(argv).toContain("--allowedTools")
    expect(argv).toContain("Read")
    expect(argv).toContain("the late-change prompt")
    expect(argv.join(" ")).not.toContain("--permission-mode")
    expect(argv.join(" ")).not.toContain("acceptEdits")
  })

  it("carries the settings file only when one is given", () => {
    expect(agentCArgv("p", "/run/claude-settings.json")).toContain("/run/claude-settings.json")
    expect(agentCArgv("p")).not.toContain("--settings")
  })
})

describe("agentBResumeArgv", () => {
  it("starts with codex exec resume <id> Continue.", () => {
    const argv = agentBResumeArgv("sess-42")
    expect(argv.slice(0, 5)).toEqual(["codex", "exec", "resume", "sess-42", "Continue."])
  })
})

describe("codexToml and the late-change hook", () => {
  it("adds [[hooks.UserPromptSubmit]] for mida only when late-change is on", () => {
    const on = codexToml("mida", "/run", true)!
    const off = codexToml("mida", "/run", false)!
    expect(on).toContain("[[hooks.UserPromptSubmit]]")
    expect(off).not.toContain("[[hooks.UserPromptSubmit]]")
    // same inject command text as SessionStart carries
    expect(on).toContain(`command = ${JSON.stringify(injectCmd("codex"))}`)
  })

  it("is identical for raw and none with and without late-change", () => {
    expect(codexToml("raw", "/run", true)).toBe(codexToml("raw", "/run", false))
    expect(codexToml("none", "/run", true)).toBe(codexToml("none", "/run", false))
    expect(codexToml("none", "/run", true)).toBeNull()
  })
})

describe("the late-change rubric", () => {
  const LATE_SCORE = join(REPO_ROOT, "bench", "fixtures", "continuation-task", "score-late-change.json")

  it("loadScore returns 2 steps, 1 constraint, 1 check", () => {
    const score = loadScore(LATE_SCORE)
    expect(score.steps).toHaveLength(2)
    expect(score.constraints).toHaveLength(1)
    expect(score.checks).toHaveLength(1)
  })

  const work = (files: Record<string, string>) => {
    const dir = tempDir()
    for (const [rel, text] of Object.entries(files)) {
      const p = join(dir, rel)
      mkdirSync(join(p, ".."), { recursive: true })
      writeFileSync(p, text)
    }
    return dir
  }

  it("only the old name exported: neither step is built", () => {
    const score = loadScore(LATE_SCORE)
    const { steps } = scoreFiles(work({ "src/keyed.mjs": "export class KeyedLimiter {}" }), score)
    expect(steps.map((s) => s.built)).toEqual([false, false])
  })

  it("only the new name exported: both steps are built", () => {
    const score = loadScore(LATE_SCORE)
    const { steps } = scoreFiles(work({ "src/keyed.mjs": "export class KeyedRateLimiter {}" }), score)
    expect(steps.map((s) => s.built)).toEqual([true, true])
  })

  it("both names exported: the rename landed but the old name is still there", () => {
    const score = loadScore(LATE_SCORE)
    const { steps } = scoreFiles(
      work({ "src/keyed.mjs": "export class KeyedLimiter {}\nexport class KeyedRateLimiter {}" }),
      score,
    )
    expect(steps.map((s) => s.built)).toEqual([true, false])
  })
})

describe("LATE_RUNS_ROOT", () => {
  it("is the runs-late-change folder", () => {
    expect(LATE_RUNS_ROOT).toContain("runs-late-change")
  })
})

describe("hook commands", () => {
  it("load tsx by its absolute path so they work outside the repo", () => {
    for (const cmd of [injectCmd("codex"), hookCmd("claude-code")]) {
      expect(cmd).toContain(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"))
      expect(cmd).not.toContain("--import tsx ")
    }
  })
})
