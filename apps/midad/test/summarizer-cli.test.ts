// `mida summarizer` (UF-P2): shows who writes the summaries, switches the saved
// choice, and probes each entry. Everything outside the process is injected —
// temp home, queued prompt answers, a fake PATH probe, a fake health reply and
// a fake model probe. The real claude/codex are never spawned.

import { describe, expect, it } from "vitest"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, NEEDS_TERMINAL_LINE, USAGE, askSummarizerKey, chooseSummarizer, readSummarizer, runSummarizer, writeSummarizer } from "@mida/midad"
import type { SecretKeyAnswer } from "@mida/midad"
import type { ModelCommand } from "@mida/compiler"

type ProbeResult = { ok: true; ms: number } | { ok: false; why: "limit" | "missing" | "timeout" | "failed"; detail: string; ms: number }

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-sumcli-")))

interface Deps {
  lines: string[]
  run: (argv: string[]) => Promise<number>
  prompts: string[]
  secrets: string[]
}

/** A deps set where every outside thing is a fake. Answers are consumed in order. */
function rig(
  dir: MidaHome,
  over: {
    env?: Record<string, string>
    /** each entry is one typed answer; an explicit undefined is an abandoned prompt (Ctrl-C/Ctrl-D) */
    answers?: (string | undefined)[]
    /** each entry is one hidden-prompt answer — a string, or {key, trailing} like a paste that kept going after Enter */
    secrets?: (string | SecretKeyAnswer | undefined)[]
    onPath?: (bin: string) => boolean
    stdinIsTTY?: boolean
    stdoutIsTTY?: boolean
    health?: () => Promise<unknown>
    probe?: (command: ModelCommand) => Promise<ProbeResult>
    kick?: () => unknown | Promise<unknown>
    now?: number
  } = {},
): Deps {
  const lines: string[] = []
  const prompts: string[] = []
  const secrets: string[] = []
  const answers = [...(over.answers ?? [])]
  const secretAnswers = [...(over.secrets ?? [])]
  return {
    lines,
    prompts,
    secrets,
    run: (argv) =>
      runSummarizer(argv, {
        home: dir,
        env: over.env ?? {},
        print: (line) => lines.push(line),
        now: () => over.now ?? Date.parse("2026-10-01T12:00:00.000Z"),
        stdinIsTTY: over.stdinIsTTY ?? false,
        stdoutIsTTY: over.stdoutIsTTY ?? false,
        prompt: async (q) => (prompts.push(q), answers.length === 0 ? "" : answers.shift()),
        secretPrompt: async (q) => (secrets.push(q), secretAnswers.length === 0 ? "" : secretAnswers.shift()),
        onPath: over.onPath ?? (() => false),
        claudeSafeMode: () => false,
        ...(over.health !== undefined ? { health: over.health } : {}),
        ...(over.probe !== undefined ? { probe: over.probe } : {}),
        ...(over.kick !== undefined ? { kick: over.kick } : {}),
      }),
  }
}

const drainLine = (dir: MidaHome, record: Record<string, unknown>) => {
  mkdirSync(dir.path("logs"), { recursive: true })
  appendFileSync(dir.path("logs/drain.jsonl"), `${JSON.stringify(record)}\n`)
}

describe("mida summarizer (show)", () => {
  it("a saved agents choice is the first line", async () => {
    const dir = home()
    writeSummarizer(dir, { use: "agents" })
    const r = rig(dir, { onPath: () => true })
    expect(await r.run(["summarizer"])).toBe(0)
    expect(r.lines[0]).toBe("Summaries are written by: your agents' small models")
  })

  it("nothing saved is the default line", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => true })
    expect(await r.run(["summarizer"])).toBe(0)
    expect(r.lines[0]).toBe("Summaries are written by: your agents' small models (the default; you have not chosen yet)")
  })

  it("a saved key names the provider's display", async () => {
    const dir = home()
    writeSummarizer(dir, { use: "key", provider: "deepseek", apiKey: "sk-never-shown" })
    const r = rig(dir)
    expect(await r.run(["summarizer"])).toBe(0)
    expect(r.lines[0]).toBe("Summaries are written by: DeepSeek (deepseek-flash), with your own API key")
    // the key never appears in any printed line
    expect(r.lines.every((line) => !line.includes("sk-never-shown"))).toBe(true)
  })

  it("an environment-decided choice says so", async () => {
    const dir = home()
    const r = rig(dir, { env: { DEEPSEEK_API_KEY: "env-key" }, onPath: () => true })
    expect(await r.run(["summarizer"])).toBe(0)
    expect(r.lines[0]).toBe("Summaries are written by: the models your environment variables set")
    expect(r.lines.every((line) => !line.includes("env-key"))).toBe(true)
  })

  it("an unreadable saved choice is the invalid line and the run returns 1", async () => {
    const dir = home()
    writeFileSync(dir.path("summarizer.json"), "{not json")
    const r = rig(dir, { onPath: () => true })
    expect(await r.run(["summarizer"])).toBe(1)
    expect(r.lines[0]).toBe("Summaries are written by: nothing. The saved choice (summarizer.json) cannot be read.")
  })

  it("entries print with ordinals and display padding, one line each", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => true })
    await r.run(["summarizer"])
    // "Claude Code (haiku)" is 18 chars; "Codex (luna)" pads to the same width
    expect(r.lines[1]).toBe("  1st  Claude Code (haiku)   ready, not used yet")
    expect(r.lines[2]).toBe("  2nd  Codex (luna)          ready, not used yet")
  })

  it("an entry whose binary is missing is 'not installed'", async () => {
    const dir = home()
    const r = rig(dir, { onPath: (bin) => bin === "codex" })
    await r.run(["summarizer"])
    expect(r.lines[1]).toBe("  1st  Claude Code (haiku)   not installed")
    expect(r.lines[2]).toBe("  2nd  Codex (luna)          ready, not used yet")
  })

  it("a saved drain line with the entry's label is 'working, used <age> ago'", async () => {
    const dir = home()
    drainLine(dir, { at: "2026-10-01T11:00:00.000Z", outcome: "saved", model: "codex-luna" })
    const r = rig(dir, { onPath: () => true })
    await r.run(["summarizer"])
    expect(r.lines[2]).toBe("  2nd  Codex (luna)          working, used 60 min ago")
    expect(r.lines[1]).toBe("  1st  Claude Code (haiku)   ready, not used yet")
  })

  it("the last-24-hours count includes saved and summarizer failures, skips old and unparseable lines", async () => {
    const dir = home()
    drainLine(dir, { at: "2026-10-01T11:30:00.000Z", outcome: "saved", model: "claude-haiku" })
    drainLine(dir, { at: "2026-09-30T11:59:00.000Z", outcome: "saved", model: "claude-haiku" }) // older than 24h
    drainLine(dir, { at: "2026-10-01T11:40:00.000Z", outcome: "failed", reason: "model-failed" })
    drainLine(dir, { at: "2026-10-01T11:45:00.000Z", outcome: "bad", reason: "no-json" })
    drainLine(dir, { at: "2026-10-01T11:50:00.000Z", outcome: "bad", reason: "gave-up" }) // not a summarizer reason
    appendFileSync(dir.path("logs/drain.jsonl"), "{this will not parse\n")
    const r = rig(dir, { onPath: () => true })
    await r.run(["summarizer"])
    expect(r.lines).toContain("Last 24 hours: 1 written, 2 failed tries")
  })

  it("no drain log means no 24-hour line", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => true })
    await r.run(["summarizer"])
    expect(r.lines.some((line) => line.startsWith("Last 24 hours:"))).toBe(false)
  })

  it("an empty chain prints the two nothing-can-write lines and returns 1", async () => {
    const dir = home()
    const r = rig(dir) // nothing on PATH
    expect(await r.run(["summarizer"])).toBe(1)
    expect(r.lines).toContain("No model can write summaries right now, so Mida is not saving your sessions.")
    expect(r.lines).toContain("Install Claude Code or Codex, or run: mida summarizer use key")
  })

  it("a running service with a different chain earns the note; the same chain or no answer does not", async () => {
    const dir = home()
    const differ = rig(dir, {
      onPath: () => true,
      health: async () => ({ summarizer: { chain: ["deepseek-flash"] } }),
    })
    await differ.run(["summarizer"])
    expect(differ.lines).toContain(
      "Note: the running Mida service uses deepseek-flash. This shell would use claude-haiku, codex-luna. The service's answer is the one that counts.",
    )

    const same = rig(dir, {
      onPath: () => true,
      health: async () => ({ summarizer: { chain: ["claude-haiku", "codex-luna"] } }),
    })
    await same.run(["summarizer"])
    expect(same.lines.some((line) => line.startsWith("Note: the running Mida service"))).toBe(false)

    const silent = rig(dir, { onPath: () => true, health: async () => undefined })
    await silent.run(["summarizer"])
    expect(silent.lines.some((line) => line.startsWith("Note: the running Mida service"))).toBe(false)
  })

  it("a service that answers without a summarizer field is an older version; no answer earns no note (UF-P2R)", async () => {
    const dir = home()
    const older = rig(dir, {
      onPath: () => true,
      health: async () => ({ version: "old", queue: { pending: 0 } }),
    })
    await older.run(["summarizer"])
    expect(older.lines).toContain(
      "Note: the running Mida service is an older version and does not read this choice. Run mida doctor to restart it.",
    )
    expect(older.lines.some((line) => line.includes("The service's answer is the one that counts."))).toBe(false)

    const silent = rig(dir, { onPath: () => true, health: async () => undefined })
    await silent.run(["summarizer"])
    expect(silent.lines.every((line) => !line.startsWith("Note: the running Mida service"))).toBe(true)
  })

  it("the tail is an empty line and the change/check pointers", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => true })
    await r.run(["summarizer"])
    expect(r.lines.slice(-3)).toEqual([
      "",
      "Change it: mida summarizer use agents | mida summarizer use key",
      "Check it:  mida summarizer test",
    ])
  })

  it("unknown words print USAGE and return 2", async () => {
    const dir = home()
    const r = rig(dir)
    for (const argv of [["summarizer", "bogus"], ["summarizer", "use"], ["summarizer", "use", "bogus"], ["summarizer", "test", "extra"]]) {
      expect(await r.run(argv)).toBe(2)
      expect(r.lines.at(-1)).toBe(USAGE)
    }
  })
})

describe("mida summarizer use", () => {
  it("use agents writes the file, prints the saved line, then the whole show", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => true })
    expect(await r.run(["summarizer", "use", "agents"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({ use: "agents" })
    expect(r.lines[0]).toBe("Saved: your agents' small models write the summaries.")
    expect(r.lines[1]).toBe("Summaries are written by: your agents' small models")

    // a second bare run shows the saved form, not the default
    const again = rig(dir, { onPath: () => true })
    await again.run(["summarizer"])
    expect(again.lines[0]).toBe("Summaries are written by: your agents' small models")
  })

  it("use key without a terminal prints the terminal line, returns 2, writes nothing", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: false, stdoutIsTTY: true })
    expect(await r.run(["summarizer", "use", "key"])).toBe(2)
    expect(r.lines).toEqual([NEEDS_TERMINAL_LINE])
    expect(dir.has("summarizer.json")).toBe(false)

    const r2 = rig(dir, { stdinIsTTY: true, stdoutIsTTY: false })
    expect(await r2.run(["summarizer", "use", "key"])).toBe(2)
    expect(dir.has("summarizer.json")).toBe(false)
  })

  it("use key with a terminal asks the questions and saves the key provider", async () => {
    const dir = home()
    const r = rig(dir, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      onPath: () => true,
      answers: ["1"],
      secrets: ["sk-live-key"],
    })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-live-key" })
    const saved = r.lines.indexOf("Saved: DeepSeek (deepseek-flash) writes the summaries, with your key.")
    expect(saved).toBeGreaterThanOrEqual(0)
    expect(r.lines[saved + 1]).toBe(`Saved in ${dir.path("summarizer.json")}, readable only by you.`)
    expect(r.lines[saved + 2]).toBe("Summaries are written by: DeepSeek (deepseek-flash), with your own API key")
    expect(r.lines.every((line) => !line.includes("sk-live-key"))).toBe(true)
  })

  // UF-P3 P3a: switching the summariser choice is the way out of a "no model" wait — the waits
  // clear at once, the running service is asked for a pass, and the owner sees the one line.
  it("use agents clears a waiting save, kicks the service once and prints the line (UF-P3)", async () => {
    const dir = home()
    dir.writeSecretJson("queue/state/s1.json", {
      transcriptBytes: 10,
      lastLineHash: "",
      savedAt: "2026-10-01T11:00:00.000Z",
      failedAt: "2026-10-01T11:30:00.000Z",
      reason: "summarizer-limit",
    })
    let kicks = 0
    const r = rig(dir, { onPath: () => true, kick: () => (kicks += 1) })
    expect(await r.run(["summarizer", "use", "agents"])).toBe(0)
    const saved = r.lines.indexOf("Saved: your agents' small models write the summaries.")
    expect(saved).toBeGreaterThanOrEqual(0)
    expect(r.lines[saved + 1]).toBe("Saves that were waiting for a summary model will be tried again now.")
    expect(kicks).toBe(1)
    const state = dir.readJson<{ failedAt?: string; reason?: string }>("queue/state/s1.json")
    expect(state?.failedAt).toBeUndefined()
    expect(state?.reason).toBeUndefined()
  })

  it("use key clears a waiting save and kicks too (UF-P3)", async () => {
    const dir = home()
    dir.writeSecretJson("queue/state/s1.json", {
      transcriptBytes: 10,
      lastLineHash: "",
      savedAt: "2026-10-01T11:00:00.000Z",
      failedAt: "2026-10-01T11:30:00.000Z",
      reason: "no-summarizer",
    })
    let kicks = 0
    const r = rig(dir, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      onPath: () => true,
      answers: ["1"],
      secrets: ["sk-live-key"],
      kick: () => (kicks += 1),
    })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(r.lines).toContain("Saves that were waiting for a summary model will be tried again now.")
    expect(kicks).toBe(1)
    expect(dir.readJson<{ reason?: string }>("queue/state/s1.json")?.reason).toBeUndefined()
  })

  it("use agents with nothing waiting prints no retry line (UF-P3)", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => true, kick: () => {} })
    expect(await r.run(["summarizer", "use", "agents"])).toBe(0)
    expect(r.lines.some((line) => line.includes("waiting for a summary model"))).toBe(false)
  })

  it("use agents returns 0 once the file is written, even with neither tool on PATH (UF-P2R)", async () => {
    const dir = home()
    const r = rig(dir, { onPath: () => false })
    expect(await r.run(["summarizer", "use", "agents"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({ use: "agents" })
    expect(r.lines[0]).toBe("Saved: your agents' small models write the summaries.")
  })

  it("an abandoned choice question saves nothing, prints the nothing-saved line and reports skipped (UF-P2R)", async () => {
    const dir = home()
    const lines: string[] = []
    const result = await chooseSummarizer({
      home: dir,
      env: {},
      print: (line) => lines.push(line),
      prompt: async () => undefined,
      secretPrompt: async () => undefined,
      onPath: () => true,
    })
    expect(result).toBe("skipped")
    expect(lines.at(-1)).toBe("Nothing saved. Mida uses your agents' small models until you choose: mida summarizer")
    expect(readSummarizer(dir)).toBeUndefined()
  })

  it("an abandoned provider, URL, model or key question inside use key saves nothing (UF-P2R)", async () => {
    const cases: { name: string; answers: (string | undefined)[]; secrets: (string | undefined)[] }[] = [
      { name: "provider", answers: [undefined], secrets: [] },
      { name: "endpoint URL", answers: ["3", undefined], secrets: [] },
      { name: "model name", answers: ["3", "https://openai.example/v1", undefined], secrets: [] },
      { name: "deepseek key", answers: ["1"], secrets: [undefined] },
      { name: "custom endpoint key", answers: ["3", "https://openai.example/v1", "local-1"], secrets: [undefined] },
    ]
    for (const c of cases) {
      const dir = home()
      const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: c.answers, secrets: c.secrets })
      expect(await r.run(["summarizer", "use", "key"]), c.name).toBe(1)
      expect(r.lines.at(-1), c.name).toBe("Nothing saved.")
      expect(readSummarizer(dir), c.name).toBeUndefined()
    }
  })

  it("an empty line at the custom key prompt saves an empty key; an abandoned one saves nothing (UF-P2R)", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["3", "https://openai.example/v1", "local-1"], secrets: [""] })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "custom", apiKey: "", baseUrl: "https://openai.example/v1", model: "local-1" })
  })

  it("a key with a space is refused with the paste-again line and asked again (UF-P2R)", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["1"], secrets: ["sk 1", "sk-clean"] })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(r.lines).toContain("That key has spaces or hidden characters in it. Paste it again.")
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-clean" })
  })

  it("three spaced keys run out the same three tries an empty key would (UF-P2R)", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["1"], secrets: ["sk 1", "sk\t2", "sk 3"] })
    expect(await r.run(["summarizer", "use", "key"])).toBe(1)
    expect(r.lines.filter((line) => line === "That key has spaces or hidden characters in it. Paste it again.")).toHaveLength(3)
    expect(r.lines.at(-1)).toBe("Nothing saved.")
    expect(readSummarizer(dir)).toBeUndefined()
  })

  // UF-QB1: the hidden prompt reports when the Enter ended a chunk that still held input —
  // the saved part of a mid-paste break is not a key.
  it("a key the prompt marked trailing is refused and asked again (UF-QB)", async () => {
    const dir = home()
    const r = rig(dir, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      answers: ["1"],
      secrets: [{ key: "sk-ab", trailing: true }, "sk-clean"],
    })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(r.lines).toContain("That key has spaces or hidden characters in it. Paste it again.")
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-clean" })
  })

  it("one pair of surrounding quotes is removed before the key is saved (UF-QB)", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["1"], secrets: ['"sk-abc"'] })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-abc" })

    const dir2 = home()
    const single = rig(dir2, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["1"], secrets: ["'sk-abc'"] })
    expect(await single.run(["summarizer", "use", "key"])).toBe(0)
    expect(readSummarizer(dir2)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-abc" })
  })

  it("a key that is not plain printable ASCII is refused (UF-QB)", async () => {
    // a zero-width space, a non-breaking space, and a decode-broken U+FFFD
    const hidden = [
      "sk-1" + String.fromCharCode(0x200b),
      "sk" + String.fromCharCode(0xa0) + "1",
      "sk-" + String.fromCharCode(0xfffd),
    ]
    for (const bad of hidden) {
    // ["sk-1​", "sk 1", "sk-"]
    // ["sk-1​", "sk 1", "sk-"]) {
      const dir = home()
      const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["1"], secrets: [bad, "sk-clean"] })
      expect(await r.run(["summarizer", "use", "key"]), bad).toBe(0)
      expect(r.lines).toContain("That key has spaces or hidden characters in it. Paste it again.")
      expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-clean" })
    }
  })

  it("key characters = / + - _ . are all fine (UF-QB)", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["1"], secrets: ["sk=a/b+c-d_e.f"] })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk=a/b+c-d_e.f" })
  })

  it("a custom endpoint's key is checked the same way (UF-QB)", async () => {
    const dir = home()
    const r = rig(dir, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      answers: ["3", "https://openai.example/v1", "local-1"],
      secrets: ["sp aced", "k-clean"],
    })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(r.lines).toContain("That key has spaces or hidden characters in it. Paste it again.")
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "custom", apiKey: "k-clean", baseUrl: "https://openai.example/v1", model: "local-1" })
  })

  it("a URL with a username, a query or a fragment is refused with the base-address line (UF-P2R)", async () => {
    const dir = home()
    const r = rig(dir, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      answers: ["3", "https://user:pass@host.example/v1", "https://host.example/v1?x=1", "https://host.example/v1#f"],
      secrets: [],
    })
    expect(await r.run(["summarizer", "use", "key"])).toBe(1)
    expect(r.lines.filter((line) => line === 'Use the base address only: no username, no "?" and no "#".')).toHaveLength(3)
    expect(r.lines.at(-1)).toBe("Nothing saved.")
    expect(readSummarizer(dir)).toBeUndefined()
  })

  it("a trailing /chat/completions and trailing slashes are removed before the address is saved (UF-P2R)", async () => {
    const dir = home()
    const r = rig(dir, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      answers: ["3", "https://host.example/v1/chat/completions/", "m-local"],
      secrets: [""],
    })
    expect(await r.run(["summarizer", "use", "key"])).toBe(0)
    expect(readSummarizer(dir)).toEqual({
      use: "key",
      provider: "custom",
      apiKey: "",
      baseUrl: "https://host.example/v1",
      model: "m-local",
    })
  })

  it("abandoned key questions print Nothing saved and return 1", async () => {
    const dir = home()
    const r = rig(dir, { stdinIsTTY: true, stdoutIsTTY: true, answers: ["9", "9", "9"] })
    expect(await r.run(["summarizer", "use", "key"])).toBe(1)
    expect(r.lines.at(-1)).toBe("Nothing saved.")
    expect(dir.has("summarizer.json")).toBe(false)
  })
})

describe("mida summarizer test", () => {
  const probes = (results: Record<string, ProbeResult>, calls: string[]) => async (command: ModelCommand) => {
    calls.push(command.label)
    return results[command.label] ?? { ok: true, ms: 1 }
  }

  it("walks the entries in order and stops at the first success", async () => {
    const dir = home()
    const calls: string[] = []
    const r = rig(dir, {
      onPath: () => true,
      probe: probes({ "claude-haiku": { ok: false, why: "failed", detail: "exit 2 signal null", ms: 40 }, "codex-luna": { ok: true, ms: 2500 } }, calls),
    })
    expect(await r.run(["summarizer", "test"])).toBe(0)
    expect(calls).toEqual(["claude-haiku", "codex-luna"])
    expect(r.lines).toEqual([
      "Asking Claude Code (haiku) for a test summary. This can take up to 90 s.",
      "Claude Code (haiku) could not write it: exit 2 signal null.",
      "Asking Codex (luna) for a test summary. This can take up to 180 s.",
      "Wrote one test summary with Codex (luna) in 3 s.",
    ])
  })

  it("a missing binary and a usage limit each get their own line; an uninstalled entry is not probed", async () => {
    const dir = home()
    const calls: string[] = []
    const r = rig(dir, {
      onPath: () => true,
      probe: probes(
        {
          "claude-haiku": { ok: false, why: "missing", detail: "spawn: ENOENT", ms: 5 },
          "codex-luna": { ok: false, why: "limit", detail: "exit 1 (usage limit)", ms: 5 },
        },
        calls,
      ),
    })
    expect(await r.run(["summarizer", "test"])).toBe(1)
    expect(r.lines).toEqual([
      "Asking Claude Code (haiku) for a test summary. This can take up to 90 s.",
      "Claude Code (haiku) could not write it: its command is not installed.",
      "Asking Codex (luna) for a test summary. This can take up to 180 s.",
      "Codex (luna) could not write it: it hit its usage limit.",
      "No model could write a test summary. Mida cannot save your sessions until one can.",
    ])

    calls.length = 0
    const notInstalled = rig(dir, { onPath: (bin) => bin === "codex", probe: probes({ "codex-luna": { ok: true, ms: 100 } }, calls) })
    expect(await notInstalled.run(["summarizer", "test"])).toBe(0)
    // claude was never probed — its line comes from the PATH answer alone, and earns no Asking line
    expect(calls).toEqual(["codex-luna"])
    expect(notInstalled.lines[0]).toBe("Claude Code (haiku) could not write it: its command is not installed.")
    expect(notInstalled.lines[1]).toBe("Asking Codex (luna) for a test summary. This can take up to 180 s.")
    expect(notInstalled.lines[2]).toBe("Wrote one test summary with Codex (luna) in 1 s.")
  })

  it("a timeout line carries the whole seconds", async () => {
    const dir = home()
    const r = rig(dir, {
      onPath: () => true,
      probe: async () => ({ ok: false, why: "timeout", detail: "timeout after 90000 ms", ms: 90_000 }),
    })
    expect(await r.run(["summarizer", "test"])).toBe(1)
    expect(r.lines[0]).toBe("Asking Claude Code (haiku) for a test summary. This can take up to 90 s.")
    expect(r.lines[1]).toBe("Claude Code (haiku) could not write it: it gave no answer in 90 s.")
  })

  it("no entries at all prints the two nothing-can-write lines and returns 1", async () => {
    const dir = home()
    writeFileSync(dir.path("summarizer.json"), "{bad")
    const r = rig(dir)
    expect(await r.run(["summarizer", "test"])).toBe(1)
    expect(r.lines).toEqual([
      "No model can write summaries right now, so Mida is not saving your sessions.",
      "Install Claude Code or Codex, or run: mida summarizer use key",
    ])
  })
})

// ---------- P2b: the questions ----------

const CHOICE_HEAD = [
  "How should Mida write its summaries?",
  "When a session ends, Mida turns the chat into a short",
  "record for your next agent. A model writes that record.",
  "",
]
const CHOICE_TAIL = [
  "",
  "  2  Your own API key",
  "     Who reads the chat: the provider you choose.",
  "     What it uses: your key. Most providers charge under one cent a summary.",
  "",
]
const choiceBlock = (a: string, b: string) => [
  ...CHOICE_HEAD,
  "  1  Your agents' small models (recommended)",
  `     ${a}`,
  `     Who reads the chat: ${b}, under your login.`,
  "     What it uses: your plan. It stops at your plan's limit.",
  ...CHOICE_TAIL,
]

function chooseRig(dir: MidaHome, onPath: (bin: string) => boolean, answers: string[], secrets: string[] = []) {
  const lines: string[] = []
  const prompts: string[] = []
  const secretQs: string[] = []
  const answersLeft = [...answers]
  const secretsLeft = [...secrets]
  return {
    lines,
    prompts,
    secretQs,
    run: () =>
      chooseSummarizer({
        home: dir,
        env: {},
        print: (line) => lines.push(line),
        prompt: async (q) => (prompts.push(q), answersLeft.shift() ?? ""),
        secretPrompt: async (q) => (secretQs.push(q), secretsLeft.shift() ?? ""),
        onPath,
      }),
  }
}

describe("chooseSummarizer", () => {
  const NOTHING_SAVED = "Nothing saved. Mida uses your agents' small models until you choose: mida summarizer"

  it.each<[string, (bin: string) => boolean, string, string]>([
    [
      "both agents",
      () => true,
      "Claude Code's haiku first, Codex's luna if Claude can't.",
      "Anthropic or OpenAI",
    ],
    [
      "only claude",
      (bin) => bin === "claude",
      "Claude Code's haiku. Install Codex and its luna becomes the backup.",
      "Anthropic",
    ],
    [
      "only codex",
      (bin) => bin === "codex",
      "Codex's luna.",
      "OpenAI",
    ],
    [
      "neither",
      () => false,
      "Neither Claude Code nor Codex is installed yet. Mida uses their small models once one is.",
      "Anthropic or OpenAI",
    ],
  ])("prints the exact block for %s", async (_name, onPath, a, b) => {
    const dir = home()
    const r = chooseRig(dir, onPath, ["", ""]) // Enter answers the first question
    expect(await r.run()).toBe("saved")
    expect(r.lines.slice(0, choiceBlock(a, b).length)).toEqual(choiceBlock(a, b))
    expect(r.prompts).toEqual(["Choose 1 or 2 [1]: "])
  })

  it("Enter and 1 both save { use: agents } and print the two saved lines", async () => {
    for (const answer of ["", "1", "  1  "]) {
      const dir = home()
      const r = chooseRig(dir, () => true, [answer])
      expect(await r.run()).toBe("saved")
      expect(readSummarizer(dir)).toEqual({ use: "agents" })
      expect(r.lines.slice(-2)).toEqual([
        "Saved: your agents' small models write the summaries.",
        "Change it later with: mida summarizer",
      ])
    }
  })

  it("2 then DeepSeek and a key saves the key choice and names its display", async () => {
    const dir = home()
    const r = chooseRig(dir, () => false, ["2", "1"], ["sk-chosen"])
    expect(await r.run()).toBe("saved")
    expect(readSummarizer(dir)).toEqual({ use: "key", provider: "deepseek", apiKey: "sk-chosen" })
    expect(r.lines.slice(-2)).toEqual([
      "Saved: DeepSeek (deepseek-flash) writes the summaries, with your key.",
      "Change it later with: mida summarizer",
    ])
    // the provider list was shown between the block and the saved lines
    expect(r.lines).toContain("Which provider?")
    expect(r.lines).toContain("  1  DeepSeek")
    expect(r.lines).toContain("  2  Moonshot (Kimi)")
    expect(r.lines).toContain("  3  Another OpenAI-compatible endpoint")
  })

  it("three wrong answers print the nothing-saved line and write nothing", async () => {
    const dir = home()
    const r = chooseRig(dir, () => true, ["banana", "9", "what"])
    expect(await r.run()).toBe("skipped")
    expect(r.lines.at(-1)).toBe(NOTHING_SAVED)
    expect(dir.has("summarizer.json")).toBe(false)
    expect(r.prompts.filter((q) => q === "Choose 1 or 2 [1]: ").length).toBe(3)
  })

  it("two wrong answers then 1 still saves", async () => {
    const dir = home()
    const r = chooseRig(dir, () => true, ["x", "?", "1"])
    expect(await r.run()).toBe("saved")
    expect(readSummarizer(dir)).toEqual({ use: "agents" })
  })

  it("abandoned key questions print the nothing-saved line and return skipped", async () => {
    const dir = home()
    const r = chooseRig(dir, () => true, ["2", "9", "9", "9"])
    expect(await r.run()).toBe("skipped")
    expect(r.lines.at(-1)).toBe(NOTHING_SAVED)
    expect(dir.has("summarizer.json")).toBe(false)
  })
})

describe("askSummarizerKey", () => {
  function keyRig(dir: MidaHome, answers: string[], secrets: (string | SecretKeyAnswer | undefined)[]) {
    const lines: string[] = []
    const prompts: string[] = []
    const secretQs: string[] = []
    const answersLeft = [...answers]
    const secretsLeft = [...secrets]
    return {
      lines,
      prompts,
      secretQs,
      run: () =>
        askSummarizerKey({
          print: (line) => lines.push(line),
          prompt: async (q) => (prompts.push(q), answersLeft.shift() ?? ""),
          secretPrompt: async (q) => (secretQs.push(q), secretsLeft.shift() ?? ""),
        }),
    }
  }

  it("asks the provider, then the key through secretPrompt only", async () => {
    const dir = home()
    const r = keyRig(dir, ["2"], ["sk-kimi"])
    const saved = await r.run()
    expect(saved).toEqual({ use: "key", provider: "kimi", apiKey: "sk-kimi" })
    expect(r.secretQs).toEqual(["API key (typing is hidden): "])
    expect(r.prompts).toEqual(["Choose 1, 2 or 3: "])
    // the key question never goes through the plain prompt
    expect(r.prompts.every((q) => !q.includes("API key"))).toBe(true)
    expect(r.lines.every((line) => !line.includes("sk-kimi"))).toBe(true)
  })

  it("three wrong provider answers return undefined", async () => {
    const r = keyRig(home(), ["0", "4", "x"], [])
    expect(await r.run()).toBe(undefined)
    expect(r.prompts).toEqual(["Choose 1, 2 or 3: ", "Choose 1, 2 or 3: ", "Choose 1, 2 or 3: "])
  })

  it("an empty DeepSeek key three times returns undefined", async () => {
    const r = keyRig(home(), ["1"], ["", "", ""])
    expect(await r.run()).toBe(undefined)
    expect(r.lines.filter((l) => l === "No key entered.").length).toBe(3)
    expect(r.secretQs.length).toBe(3)
  })

  it("custom endpoint: http://example.com is refused, http://localhost:1234/v1 is accepted, empty key is allowed", async () => {
    const r = keyRig(home(), ["3", "http://example.com", "http://localhost:1234/v1", "llama-9"], [""])
    expect(await r.run()).toEqual({
      use: "key",
      provider: "custom",
      apiKey: "",
      baseUrl: "http://localhost:1234/v1",
      model: "llama-9",
    })
    expect(r.lines).toContain("That address must start with https:// (http:// only for this machine).")
    expect(r.prompts).toEqual([
      "Choose 1, 2 or 3: ",
      "Endpoint base URL (for OpenAI: https://api.openai.com/v1): ",
      "Endpoint base URL (for OpenAI: https://api.openai.com/v1): ",
      "Model name: ",
    ])
    expect(r.secretQs).toEqual(["API key (typing is hidden; leave empty if your endpoint needs none): "])
  })

  it("https endpoints and three bad URLs behave", async () => {
    const ok = keyRig(home(), ["3", "https://api.openai.com/v1", "gpt-5"], ["k"])
    expect(await ok.run()).toEqual({
      use: "key",
      provider: "custom",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5",
    })
    const bad = keyRig(home(), ["3", "nope", "ftp://x", "http://10.0.0.1"], [])
    expect(await bad.run()).toBe(undefined)
    expect(bad.lines.filter((l) => l === "That address must start with https:// (http:// only for this machine).").length).toBe(3)
  })

  it("three empty model names return undefined", async () => {
    const r = keyRig(home(), ["3", "https://e.com/v1", "", "", ""], [])
    expect(await r.run()).toBe(undefined)
  })
})
