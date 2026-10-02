// bench/continuation/run.ts carries four small pure helpers this file tests:
// the session id inside agent A's stream-json output, the lookup of A's OWN
// session file under a projects root (never "the newest file on the machine"),
// the tokens-used number inside agent B's output, and the rule for whether
// agent B ran at all. Nothing here starts an agent or touches a model.
//   cd bench && pnpm exec vitest run test/continuation-run-helpers.test.ts

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  bRanOf, parseArgs, sessionIdOf, tokensUsedOf, transcriptOfSession,
} from "../continuation/run.js"

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
