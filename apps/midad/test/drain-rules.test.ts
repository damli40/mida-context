import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CompileInput, compileCheckpoint } from "@mida/compiler"
import { MidaHome, drainOnce, enqueue, listJobs } from "@mida/midad"
import type { Runtime } from "@mida/midad"

/**
 * Drain-rule tests that never reach the chain: every dep that could touch it is a stub that records
 * or throws. `homeDir` stands in for the user's real home; transcripts live under its
 * `.claude/projects/` exactly as Claude Code writes them.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mida-drainrules-"))
  const home = new MidaHome(join(dir, "mida"))
  const homeDir = join(dir, "user-home")
  mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
  const transcriptPath = join(homeDir, ".claude", "projects", "proj", "t.jsonl")
  writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
  const cwd = join(dir, "work")
  mkdirSync(join(cwd, ".mida"), { recursive: true })
  writeFileSync(join(cwd, ".mida", "project.json"), JSON.stringify({ projectId: "p-1" }))
  const compileCalls: CompileInput[] = []
  const compile: typeof compileCheckpoint = async (input) => {
    compileCalls.push(input)
    throw new Error("compile must not run")
  }
  const open = async (): Promise<Runtime> => {
    throw new Error("open must not run")
  }
  return { dir, home, homeDir, transcriptPath, cwd, compileCalls, compile, open }
}

describe("the drainer re-checks transcript paths before trusting them", () => {
  it("a queued job naming a non-transcript file goes to queue/bad with bad-transcript-path", async () => {
    const { home, homeDir, cwd, compile, open } = setup()
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/etc/hosts", cwd, error: null })
    await drainOnce({ home, open, compile, homeDir })
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(listJobs(home)).toHaveLength(0)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("a transcript swapped for a symlink after enqueue is rejected at drain time", async () => {
    const { home, homeDir, cwd, transcriptPath, compile, open } = setup()
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath, cwd, error: null })
    unlinkSync(transcriptPath)
    symlinkSync("/etc/hosts", transcriptPath)
    await drainOnce({ home, open, compile, homeDir })
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("bad-transcript-path")
  })

  it("a transcript in an unknown format is never sent to the model", async () => {
    const { home, homeDir, cwd, compileCalls, compile, open } = setup()
    const weird = join(homeDir, ".claude", "projects", "proj", "weird.jsonl")
    writeFileSync(weird, "this is not a jsonl transcript\nneither is this\n")
    const job = enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: weird, cwd, error: null })
    await drainOnce({ home, open, compile, homeDir })
    expect(compileCalls).toHaveLength(0)
    expect(home.has(`queue/bad/${job.id}.json`)).toBe(true)
    expect(readFileSync(home.path("logs/drain.jsonl"), "utf8")).toContain("unknown-transcript-format")
  })
})
