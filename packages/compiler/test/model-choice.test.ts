// compileModelChoice (R5-8) — MIDA_COMPILE_MODEL=kimi|haiku, defaulting to kimi when KIMI_API_KEY
// is set and to haiku otherwise. The kimi command always carries claude-haiku as its fallback.

import { describe, expect, it } from "vitest"
import { compileModelChoice, kimiModelCommand } from "../src/index.js"

describe("compileModelChoice — which model compiles a checkpoint (R5-8)", () => {
  it("no variables at all means claude-haiku with no fallback", () => {
    const choice = compileModelChoice({})
    expect(choice.model.label).toBe("claude-haiku")
    expect(choice.fallback).toBeUndefined()
  })

  it("KIMI_API_KEY alone selects the kimi command, with claude-haiku as the fallback", () => {
    const choice = compileModelChoice({ KIMI_API_KEY: "test-key" })
    expect(choice.model.label).toBe("kimi-k2.7-code-highspeed")
    expect(choice.fallback?.label).toBe("claude-haiku")
  })

  it("MIDA_COMPILE_MODEL=haiku wins over a set KIMI_API_KEY", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "haiku", KIMI_API_KEY: "test-key" })
    expect(choice.model.label).toBe("claude-haiku")
    expect(choice.fallback).toBeUndefined()
  })

  it("MIDA_COMPILE_MODEL=kimi selects kimi even without a key — the fallback then does the work", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "kimi" })
    expect(choice.model.label).toBe("kimi-k2.7-code-highspeed")
    expect(choice.fallback?.label).toBe("claude-haiku")
  })

  it("an empty KIMI_API_KEY counts as no key", () => {
    const choice = compileModelChoice({ KIMI_API_KEY: "" })
    expect(choice.model.label).toBe("claude-haiku")
  })
})

describe("kimiModelCommand — the spawned command's shape (R5-8)", () => {
  it("carries no secret in argv: the key only ever reaches the child through the environment", () => {
    const command = kimiModelCommand({ KIMI_API_KEY: "test-key-material" })
    expect(command.argv[0]).toBe(process.execPath)
    expect(command.argv.join(" ")).not.toContain("test-key-material")
    expect(command.label).toBe("kimi-k2.7-code-highspeed")
    // stderr is the script's controlled channel ("kimi http 429") — opted in so the daemon log
    // can say WHY a compile fell back, while every other model's stderr stays ignored
    expect(command.stderrDetail).toBe(true)
  })

  it("KIMI_MODEL overrides the model name, and the label tells the truth about it", () => {
    const command = kimiModelCommand({ KIMI_MODEL: "kimi-other" })
    expect(command.label).toBe("kimi-other")
  })
})
