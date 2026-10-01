import { describe, expect, it } from "vitest"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MidaHome,
  SUMMARIZER_FILE,
  compileWithSummarizer,
  currentSummarizer,
  readSummarizer,
  summarizerSummary,
  writeSummarizer,
} from "@mida/midad"
import type { CompileResult } from "@mida/compiler"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-sum-store-")))
const noPath = () => false
const allPath = () => true

describe("summarizer store", () => {
  it("write then read round-trips the saved choice, and the file is 0600", () => {
    const dir = home()
    writeSummarizer(dir, { use: "key", provider: "deepseek", apiKey: "sk-1", model: "m" })
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-1", baseUrl: undefined, model: "m" })
    expect(statSync(dir.path(SUMMARIZER_FILE)).mode & 0o777).toBe(0o600)

    const agents = home()
    writeSummarizer(agents, { use: "agents" })
    expect(readSummarizer(agents)).toEqual({ use: "agents" })
  })

  it("an absent file reads as undefined", () => {
    expect(readSummarizer(home())).toBeUndefined()
  })

  it("every malformed shape — and a file that is not JSON — reads as invalid", () => {
    const badShapes: unknown[] = [
      "agents",
      42,
      null,
      { use: "bogus" },
      { use: "key", provider: "other", apiKey: "x" },
      { use: "key", provider: "deepseek" }, // no apiKey
      { use: "key", provider: "deepseek", apiKey: 7 },
      { use: "key", provider: "deepseek", apiKey: "" },
      { use: "key", provider: "kimi", apiKey: "" },
      { use: "key", provider: "custom", apiKey: "x" }, // no baseUrl/model
      { use: "key", provider: "custom", apiKey: "x", baseUrl: "", model: "m" },
      { use: "key", provider: "custom", apiKey: "x", baseUrl: "http://h/v1" }, // no model
      { use: "key", provider: "custom", apiKey: "x", baseUrl: "http://h/v1", model: "" },
      { use: "key", provider: "deepseek", apiKey: "x", model: 5 },
    ]
    for (const shape of badShapes) {
      const dir = home()
      writeFileSync(dir.path(SUMMARIZER_FILE), JSON.stringify(shape))
      expect(readSummarizer(dir), JSON.stringify(shape)).toBe("invalid")
    }
    const dir = home()
    writeFileSync(dir.path(SUMMARIZER_FILE), "this is not json{")
    expect(readSummarizer(dir)).toBe("invalid")
  })

  it("no saved file: mode agents, chosen false — the choice was never made", () => {
    const choice = currentSummarizer(home(), {}, { onPath: noPath })
    expect(choice.mode).toBe("agents")
    expect(choice.chosen).toBe(false)
    expect(choice.invalid).toBe(false)
  })

  it("a saved agents choice is chosen:true", () => {
    const dir = home()
    writeSummarizer(dir, { use: "agents" })
    const choice = currentSummarizer(dir, {}, { onPath: allPath, claudeSafeMode: () => true })
    expect(choice.mode).toBe("agents")
    expect(choice.chosen).toBe(true)
    expect(choice.chain.map((e) => e.id)).toEqual(["claude", "codex"])
  })

  it("an invalid file resolves to the empty key result and never consults onPath", () => {
    const dir = home()
    writeFileSync(dir.path(SUMMARIZER_FILE), "{bad")
    let onPathCalls = 0
    const choice = currentSummarizer(dir, {}, {
      onPath: () => {
        onPathCalls += 1
        return true
      },
    })
    expect(choice).toMatchObject({ mode: "key", chosen: true, invalid: true })
    expect(choice.entries).toEqual([])
    expect(choice.chain).toEqual([])
    expect(onPathCalls).toBe(0)
  })

  it("the summary of a key choice carries no key anywhere in it", () => {
    const dir = home()
    writeSummarizer(dir, { use: "key", provider: "deepseek", apiKey: "sk-secret-value", model: "m" })
    const summary = summarizerSummary(currentSummarizer(dir, {}, { onPath: noPath }))
    expect(summary.mode).toBe("key")
    expect(JSON.stringify(summary)).not.toContain("sk-secret-value")
    // and no command survives into the summary at all
    expect(summary.entries.every((e) => !("command" in e))).toBe(true)
  })
})

describe("compileWithSummarizer", () => {
  const input = {
    transcriptPath: "/tmp/t.jsonl",
    agent: "claude-code",
    eventId: "e1",
    cwd: "/tmp/work",
    homeDir: "/tmp",
  }

  it("an empty chain fails as no-summarizer and never calls compile", async () => {
    let calls = 0
    const compile = (async () => {
      calls += 1
      return { ok: false } as CompileResult
    }) as Parameters<typeof compileWithSummarizer>[2]
    const run = compileWithSummarizer(home(), {}, compile, { onPath: noPath })
    const result = await run(input)
    expect(result).toMatchObject({ ok: false, reason: "no-summarizer", detail: "no summary model is available", attempts: 0 })
    expect(calls).toBe(0)
  })

  it("a choice written between two calls changes the next call's model — no restart", async () => {
    const dir = home()
    writeSummarizer(dir, { use: "agents" })
    const models: string[] = []
    const compile = (async (arg: { model?: { label: string }; fallbackModels?: { label: string }[] }) => {
      models.push(arg.model!.label)
      return { ok: true } as CompileResult
    }) as unknown as Parameters<typeof compileWithSummarizer>[2]
    const run = compileWithSummarizer(dir, {}, compile, { onPath: allPath, claudeSafeMode: () => false })

    await run(input)
    expect(models).toEqual(["claude-haiku"])

    // the owner saves a different choice; the very next save uses it
    writeSummarizer(dir, { use: "key", provider: "deepseek", apiKey: "k", model: "deepseek-v" })
    await run(input)
    expect(models).toEqual(["claude-haiku", "deepseek-v"])
  })

  it("a saved agents choice passes the rest of the chain as fallbackModels", async () => {
    const dir = home()
    writeSummarizer(dir, { use: "agents" })
    let fallbacks: string[] = []
    const compile = (async (arg: { fallbackModels?: { label: string }[] }) => {
      fallbacks = (arg.fallbackModels ?? []).map((m) => m.label)
      return { ok: true } as CompileResult
    }) as unknown as Parameters<typeof compileWithSummarizer>[2]
    const run = compileWithSummarizer(dir, {}, compile, { onPath: allPath, claudeSafeMode: () => false })
    await run(input)
    expect(fallbacks).toEqual(["codex-luna"])
  })
})
