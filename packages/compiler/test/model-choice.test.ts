// compileModelChoice (M3-D5) — which provider compiles a checkpoint, and who
// takes over when it fails. Unpinned order by which keys are present:
// deepseek → kimi → haiku. MIDA_COMPILE_MODEL pins one of
// deepseek | kimi | haiku | custom; a pinned custom never falls back unless
// MIDA_COMPILE_FALLBACK=1 — a user who pointed at their own endpoint chose
// privacy, and the transcript must not silently leave for a vendor.

import { describe, expect, it } from "vitest"
import { compileModelChoice, kimiModelCommand, providerModelCommand } from "../src/index.js"

const labels = (choice: ReturnType<typeof compileModelChoice>) =>
  [choice.model.label, ...choice.fallbacks.map((f) => f.label)]

describe("compileModelChoice — unpinned order is deepseek → kimi → haiku (M3-D5)", () => {
  it("no variables at all means claude-haiku with no fallback", () => {
    const choice = compileModelChoice({})
    expect(choice.model.label).toBe("claude-haiku")
    expect(choice.fallbacks).toEqual([])
    expect(labels(choice)).toEqual(["claude-haiku"])
  })

  it("DEEPSEEK_API_KEY alone makes deepseek the default, haiku behind it", () => {
    const choice = compileModelChoice({ DEEPSEEK_API_KEY: "test-key" })
    expect(choice.model.label).toBe("deepseek-flash")
    expect(labels(choice)).toEqual(["deepseek-flash", "claude-haiku"])
  })

  it("KIMI_API_KEY alone keeps kimi first, haiku behind it", () => {
    const choice = compileModelChoice({ KIMI_API_KEY: "test-key" })
    expect(labels(choice)).toEqual(["kimi-k2.7-code-highspeed", "claude-haiku"])
  })

  it("both keys set means deepseek first, then kimi, then haiku", () => {
    const choice = compileModelChoice({ DEEPSEEK_API_KEY: "d", KIMI_API_KEY: "k" })
    expect(labels(choice)).toEqual(["deepseek-flash", "kimi-k2.7-code-highspeed", "claude-haiku"])
  })

  it("an empty DEEPSEEK_API_KEY or KIMI_API_KEY counts as no key", () => {
    const choice = compileModelChoice({ DEEPSEEK_API_KEY: "", KIMI_API_KEY: "" })
    expect(labels(choice)).toEqual(["claude-haiku"])
    const kimiOnly = compileModelChoice({ DEEPSEEK_API_KEY: "", KIMI_API_KEY: "k" })
    expect(labels(kimiOnly)).toEqual(["kimi-k2.7-code-highspeed", "claude-haiku"])
  })
})

describe("compileModelChoice — MIDA_COMPILE_MODEL pins (M3-D5)", () => {
  it("deepseek wins over a set KIMI_API_KEY and keeps the same fallback order", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "deepseek", KIMI_API_KEY: "k" })
    expect(labels(choice)).toEqual(["deepseek-flash", "kimi-k2.7-code-highspeed", "claude-haiku"])
  })

  it("deepseek pinned with no key at all still leads — the chain does the work when it fails", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "deepseek" })
    expect(labels(choice)).toEqual(["deepseek-flash", "claude-haiku"])
  })

  it("kimi pinned keeps only what follows it in the order — haiku", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "kimi", DEEPSEEK_API_KEY: "d" })
    expect(labels(choice)).toEqual(["kimi-k2.7-code-highspeed", "claude-haiku"])
  })

  it("haiku pinned means just haiku — it is always the end of the chain", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "haiku", DEEPSEEK_API_KEY: "d", KIMI_API_KEY: "k" })
    expect(labels(choice)).toEqual(["claude-haiku"])
  })

  it("custom pinned builds the custom command and — privacy — has NO fallback by default", () => {
    const choice = compileModelChoice({
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "http://127.0.0.1:11434/v1",
      MIDA_COMPILE_MODEL_ID: "qwen-local",
      DEEPSEEK_API_KEY: "d",
      KIMI_API_KEY: "k",
    })
    expect(choice.model.label).toBe("qwen-local")
    expect(choice.fallbacks).toEqual([])
  })

  it("custom pinned + MIDA_COMPILE_FALLBACK=1 opts back into the vendor order", () => {
    const choice = compileModelChoice({
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "http://127.0.0.1:11434/v1",
      MIDA_COMPILE_MODEL_ID: "qwen-local",
      MIDA_COMPILE_FALLBACK: "1",
      DEEPSEEK_API_KEY: "d",
      KIMI_API_KEY: "k",
    })
    expect(labels(choice)).toEqual(["qwen-local", "deepseek-flash", "kimi-k2.7-code-highspeed", "claude-haiku"])
    const noKeys = compileModelChoice({
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "http://127.0.0.1:11434/v1",
      MIDA_COMPILE_MODEL_ID: "qwen-local",
      MIDA_COMPILE_FALLBACK: "1",
    })
    expect(labels(noKeys)).toEqual(["qwen-local", "claude-haiku"])
  })

  it("a value that is not a known pin follows the unpinned rule", () => {
    const choice = compileModelChoice({ MIDA_COMPILE_MODEL: "deepseek-v4-pro", DEEPSEEK_API_KEY: "d" })
    expect(labels(choice)).toEqual(["deepseek-flash", "claude-haiku"])
  })
})

describe("providerModelCommand — the spawned command's shape (M3-D5)", () => {
  it("carries the provider name in argv and never the key — the key only reaches the child through env", () => {
    for (const provider of ["deepseek", "kimi", "custom"] as const) {
      const command = providerModelCommand({ DEEPSEEK_API_KEY: "d-secret", KIMI_API_KEY: "k-secret", MIDA_COMPILE_API_KEY: "c-secret" }, provider)
      expect(command.argv[0]).toBe(process.execPath)
      expect(command.argv[command.argv.length - 1]).toBe(provider)
      expect(command.argv.join(" ")).not.toContain("secret")
      expect(command.stderrDetail).toBe(true)
      expect(command.argv.some((a) => a.endsWith("openai-compatible-model.mjs"))).toBe(true)
    }
  })

  it("the label is the provider's model var or its default — the label tells the truth", () => {
    expect(providerModelCommand({}, "deepseek").label).toBe("deepseek-flash")
    expect(providerModelCommand({ DEEPSEEK_MODEL: "deepseek-other" }, "deepseek").label).toBe("deepseek-other")
    expect(providerModelCommand({}, "kimi").label).toBe("kimi-k2.7-code-highspeed")
    expect(providerModelCommand({ MIDA_COMPILE_MODEL_ID: "qwen-local" }, "custom").label).toBe("qwen-local")
    expect(providerModelCommand({}, "custom").label).toBe("custom")
  })

  it("each provider's own timeout var sets the process timeout, defaulting to 120 s", () => {
    expect(providerModelCommand({}, "deepseek").timeoutMs).toBe(120_000)
    expect(providerModelCommand({ DEEPSEEK_TIMEOUT_MS: "5000" }, "deepseek").timeoutMs).toBe(5_000)
    expect(providerModelCommand({ MIDA_COMPILE_TIMEOUT_MS: "2500" }, "custom").timeoutMs).toBe(2_500)
    expect(providerModelCommand({ KIMI_TIMEOUT_MS: "junk" }, "kimi").timeoutMs).toBe(120_000)
  })

  it("kimiModelCommand stays as the compat alias — same command the shim execs", () => {
    const command = kimiModelCommand({ KIMI_API_KEY: "test-key-material" })
    expect(command.argv.join(" ")).not.toContain("test-key-material")
    expect(command.label).toBe("kimi-k2.7-code-highspeed")
    expect(command.argv[command.argv.length - 1]).toBe("kimi")
  })
})

describe("compileModelChoice — the chain descriptor doctor renders from (M3-D5)", () => {
  it("names each provider in run order with the host its request goes to", () => {
    const choice = compileModelChoice({ DEEPSEEK_API_KEY: "d", KIMI_API_KEY: "k" })
    expect(choice.chain).toEqual([
      { provider: "deepseek", label: "deepseek-flash", host: "api.deepseek.com" },
      { provider: "kimi", label: "kimi-k2.7-code-highspeed", host: "api.moonshot.ai" },
      { provider: "haiku", label: "claude-haiku", host: "api.anthropic.com" },
    ])
  })

  it("a base URL override shows the real host — the note must never claim the default", () => {
    const choice = compileModelChoice({ KIMI_API_KEY: "k", KIMI_BASE_URL: "https://proxy.example.com/v1" })
    expect(choice.chain[0]).toMatchObject({ provider: "kimi", host: "proxy.example.com" })
  })

  it("custom carries the user's own host; a missing base leaves host undefined for doctor to flag", () => {
    const withBase = compileModelChoice({
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "http://127.0.0.1:11434/v1",
      MIDA_COMPILE_MODEL_ID: "q",
    })
    // the host includes the port — for a local server the port IS the destination
    expect(withBase.chain).toEqual([{ provider: "custom", label: "q", host: "127.0.0.1:11434" }])
    const noBase = compileModelChoice({ MIDA_COMPILE_MODEL: "custom", MIDA_COMPILE_MODEL_ID: "q" })
    expect(noBase.chain[0]!.host).toBeUndefined()
  })
})
