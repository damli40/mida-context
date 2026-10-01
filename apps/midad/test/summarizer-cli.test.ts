// `mida summarizer` (UF-P2): shows who writes the summaries, switches the saved
// choice, and probes each entry. Everything outside the process is injected —
// temp home, queued prompt answers, a fake PATH probe, a fake health reply and
// a fake model probe. The real claude/codex are never spawned.

import { describe, expect, it } from "vitest"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, NEEDS_TERMINAL_LINE, USAGE, askSummarizerKey, chooseSummarizer, readSummarizer, runSummarizer, writeSummarizer } from "@mida/midad"
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
    answers?: string[]
    secrets?: string[]
    onPath?: (bin: string) => boolean
    stdinIsTTY?: boolean
    stdoutIsTTY?: boolean
    health?: () => Promise<unknown>
    probe?: (command: ModelCommand) => Promise<ProbeResult>
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
        prompt: async (q) => (prompts.push(q), answers.shift() ?? ""),
        secretPrompt: async (q) => (secrets.push(q), secretAnswers.shift() ?? ""),
        onPath: over.onPath ?? (() => false),
        claudeSafeMode: () => false,
        ...(over.health !== undefined ? { health: over.health } : {}),
        ...(over.probe !== undefined ? { probe: over.probe } : {}),
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
    expect(r.lines).toContain("Last 24 hours: 1 written, 2 failed")
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
      "Claude Code (haiku) could not write it: exit 2 signal null.",
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
      "Claude Code (haiku) could not write it: its command is not installed.",
      "Codex (luna) could not write it: it hit its usage limit.",
      "No model could write a test summary. Mida cannot save your sessions until one can.",
    ])

    calls.length = 0
    const notInstalled = rig(dir, { onPath: (bin) => bin === "codex", probe: probes({ "codex-luna": { ok: true, ms: 100 } }, calls) })
    expect(await notInstalled.run(["summarizer", "test"])).toBe(0)
    // claude was never probed — its line comes from the PATH answer alone
    expect(calls).toEqual(["codex-luna"])
    expect(notInstalled.lines[0]).toBe("Claude Code (haiku) could not write it: its command is not installed.")
    expect(notInstalled.lines[1]).toBe("Wrote one test summary with Codex (luna) in 1 s.")
  })

  it("a timeout line carries the whole seconds", async () => {
    const dir = home()
    const r = rig(dir, {
      onPath: () => true,
      probe: async () => ({ ok: false, why: "timeout", detail: "timeout after 90000 ms", ms: 90_000 }),
    })
    expect(await r.run(["summarizer", "test"])).toBe(1)
    expect(r.lines[0]).toBe("Claude Code (haiku) could not write it: it gave no answer in 90 s.")
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
