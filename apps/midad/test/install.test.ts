import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CODEX_BLOCK,
  CODEX_BLOCK_V1,
  CODEX_TRUST_SENTENCE,
  HOOK_COMMAND,
  INJECT_COMMAND,
  claudeHooksStatus,
  codexBlock,
  codexHooksStatus,
  hookCommand,
  injectCommand,
  installClaudeCode,
  installCodex,
  parseMidaCommand,
  runInstall,
  uninstallClaudeCode,
  uninstallCodex,
} from "@mida/midad"

const dir = () => mkdtempSync(join(tmpdir(), "mida-install-"))

describe("mida install claude-code", () => {
  it("the legacy constants keep the bare text — what uninstall must still recognise", () => {
    expect(HOOK_COMMAND["claude-code"]).toBe("mida-hook claude-code")
    expect(INJECT_COMMAND["claude-code"]).toBe("mida-inject claude-code")
    expect(HOOK_COMMAND["codex"]).toBe("mida-hook codex")
    expect(INJECT_COMMAND["codex"]).toBe("mida-inject codex")
  })

  it("the commands install writes are absolute and parse back to the right entry (R5-7)", () => {
    for (const tool of ["claude-code", "codex"] as const) {
      for (const [command, kind] of [
        [hookCommand(tool), "hook"],
        [injectCommand(tool), "inject"],
      ] as const) {
        expect(command.endsWith(` ${tool}`)).toBe(true)
        // never the bare name — a hook's shell owes the command nothing on PATH
        expect(command).not.toBe(`mida-${kind} ${tool}`)
        const parsed = parseMidaCommand(command)
        expect(parsed?.kind).toBe(kind)
        expect(parsed?.tool).toBe(tool)
        for (const target of parsed!.paths) expect(target.file.startsWith("/")).toBe(true)
      }
    }
  })

  it("installs all seven events into a missing settings file, creating the folder", () => {
    const settings = join(dir(), ".claude", "settings.json")
    const result = installClaudeCode(settings)
    expect(result).toBe("installed")
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    const commandOf = (event: string) => parsed.hooks[event]![0]!.hooks[0]!.command
    expect(commandOf("SessionStart")).toBe(injectCommand("claude-code"))
    // the whats-new hook rides the same inject command — one trusted command serves both events
    expect(commandOf("UserPromptSubmit")).toBe(injectCommand("claude-code"))
    for (const event of ["PostToolUse", "Stop", "StopFailure", "PreCompact", "SessionEnd"]) {
      expect(commandOf(event)).toBe(hookCommand("claude-code"))
    }
    // every command written is exactly the resolved invocation — nothing else
    for (const event of Object.keys(parsed.hooks)) {
      for (const element of parsed.hooks[event]!) {
        for (const hook of element.hooks) {
          expect([hookCommand("claude-code"), injectCommand("claude-code")]).toContain(hook.command)
        }
      }
    }
    // no backup when the file did not exist before
    expect(existsSync(`${settings}.mida-backup`)).toBe(false)
  })

  it("appends one element per event without touching unrelated hooks, and backs up the original once", () => {
    const settings = join(dir(), "settings.json")
    const original = {
      model: "opus",
      hooks: {
        Stop: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
        CustomEvent: [{ hooks: [{ type: "command", command: "lint" }] }],
      },
    }
    const originalText = `${JSON.stringify(original, null, 2)}\n`
    writeFileSync(settings, originalText)

    expect(installClaudeCode(settings)).toBe("installed")
    const backup = `${settings}.mida-backup`
    // the backup holds the pre-install bytes and is written before the first change only
    expect(readFileSync(backup, "utf8")).toBe(originalText)

    const parsed = JSON.parse(readFileSync(settings, "utf8")) as {
      model: string
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>
    }
    expect(parsed.model).toBe("opus")
    // the user's entries are first and unchanged; ours are the last element of each array
    expect(parsed.hooks.Stop).toHaveLength(2)
    expect(parsed.hooks.Stop![0]).toEqual(original.hooks.Stop[0])
    expect(parsed.hooks.Stop![1]).toEqual({ hooks: [{ type: "command", command: hookCommand("claude-code") }] })
    expect(parsed.hooks.CustomEvent).toEqual(original.hooks.CustomEvent)
    expect(parsed.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: injectCommand("claude-code") }] },
    ])
  })

  it("a second install prints already-installed and leaves the file byte-identical", () => {
    const settings = join(dir(), "settings.json")
    writeFileSync(settings, `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
    expect(installClaudeCode(settings)).toBe("installed")
    const beforeBytes = readFileSync(settings, "utf8")
    const beforeMtime = statSync(settings).mtimeMs
    const backupBytes = readFileSync(`${settings}.mida-backup`, "utf8")

    expect(installClaudeCode(settings)).toBe("already-installed")
    expect(readFileSync(settings, "utf8")).toBe(beforeBytes)
    expect(statSync(settings).mtimeMs).toBe(beforeMtime)
    // the backup is never overwritten by a later install
    expect(readFileSync(`${settings}.mida-backup`, "utf8")).toBe(backupBytes)
  })

  it("a partial install adds only the missing events", () => {
    const settings = join(dir(), "settings.json")
    const partial = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: injectCommand("claude-code") }] }],
        Stop: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
      },
    }
    writeFileSync(settings, JSON.stringify(partial, null, 2))
    expect(installClaudeCode(settings)).toBe("installed")
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    // the two pre-installed events were not duplicated
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.Stop).toHaveLength(1)
    for (const event of ["PostToolUse", "StopFailure", "PreCompact", "SessionEnd"]) {
      expect(parsed.hooks[event]).toHaveLength(1)
      expect(parsed.hooks[event]![0]!.hooks[0]!.command).toBe(hookCommand("claude-code"))
    }
    // and a further install is a no-op
    expect(installClaudeCode(settings)).toBe("already-installed")
  })

  it("a bare-name install from before the absolute-path change is rewritten in place, not duplicated (R5-7)", () => {
    const settings = join(dir(), "settings.json")
    const legacy = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: INJECT_COMMAND["claude-code"] }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: INJECT_COMMAND["claude-code"] }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: HOOK_COMMAND["claude-code"] }] }],
        Stop: [{ hooks: [{ type: "command", command: HOOK_COMMAND["claude-code"] }] }],
        StopFailure: [{ hooks: [{ type: "command", command: HOOK_COMMAND["claude-code"] }] }],
        PreCompact: [{ hooks: [{ type: "command", command: HOOK_COMMAND["claude-code"] }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: HOOK_COMMAND["claude-code"] }] }],
      },
    }
    writeFileSync(settings, JSON.stringify(legacy, null, 2))
    // doctor calls this shape outdated — every event covered, none by the current command
    expect(claudeHooksStatus(settings)).toBe("outdated")
    expect(installClaudeCode(settings)).toBe("installed")
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    // each event still holds one element — the command text inside was rewritten
    for (const event of Object.keys(legacy.hooks)) {
      expect(parsed.hooks[event]).toHaveLength(1)
      expect(parsed.hooks[event]![0]!.hooks[0]!.command).toBe(
        event === "SessionStart" || event === "UserPromptSubmit" ? injectCommand("claude-code") : hookCommand("claude-code"),
      )
    }
    expect(claudeHooksStatus(settings)).toBe("installed")
  })

  it("refuses settings-unreadable on invalid JSON and writes nothing", () => {
    const settings = join(dir(), "settings.json")
    const text = '{ "hooks": trul'
    writeFileSync(settings, text)
    expect(() => installClaudeCode(settings)).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
    expect(readFileSync(settings, "utf8")).toBe(text)
    expect(existsSync(`${settings}.mida-backup`)).toBe(false)
  })

  it("refuses settings-unreadable on a non-object top level", () => {
    for (const text of ['["hooks"]', '"hooks"', "42", "null"]) {
      const settings = join(dir(), "settings.json")
      writeFileSync(settings, text)
      expect(() => installClaudeCode(settings)).toThrowError(
        expect.objectContaining({ code: "settings-unreadable" }),
      )
      expect(readFileSync(settings, "utf8")).toBe(text)
    }
  })

  it("refuses settings-unreadable when hooks is not an object, or an event is not an array", () => {
    const cases = [
      { hooks: ["Stop"] },
      { hooks: "Stop" },
      { hooks: { SessionStart: { hooks: [] } } },
      { hooks: { Stop: "mida-hook claude-code" } },
    ]
    for (const shape of cases) {
      const settings = join(dir(), "settings.json")
      const text = JSON.stringify(shape, null, 2)
      writeFileSync(settings, text)
      expect(() => installClaudeCode(settings)).toThrowError(
        expect.objectContaining({ code: "settings-unreadable" }),
      )
      expect(readFileSync(settings, "utf8")).toBe(text)
    }
  })

  it("keeps the file's indentation and ends with a newline", () => {
    const settings = join(dir(), "settings.json")
    writeFileSync(settings, `{\n    "hooks": {},\n    "model": "opus"\n}\n`)
    expect(installClaudeCode(settings)).toBe("installed")
    const text = readFileSync(settings, "utf8")
    expect(text).toContain('\n    "hooks": {')
    expect(text.endsWith("\n")).toBe(true)
  })

  it("an install from before UserPromptSubmit reads incomplete and gains the event", () => {
    const settings = join(dir(), "settings.json")
    const old = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: injectCommand("claude-code") }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
        Stop: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
        StopFailure: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
        PreCompact: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
      },
    }
    writeFileSync(settings, JSON.stringify(old, null, 2))
    expect(claudeHooksStatus(settings)).toBe("incomplete")
    expect(installClaudeCode(settings)).toBe("installed")
    expect(claudeHooksStatus(settings)).toBe("installed")
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(parsed.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: injectCommand("claude-code") }] },
    ])
  })
})

describe("mida uninstall claude-code", () => {
  it("install then uninstall restores the original JSON deep-equal, unrelated hooks untouched", () => {
    const settings = join(dir(), "settings.json")
    const original = {
      model: "opus",
      hooks: {
        Stop: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
        CustomEvent: [{ hooks: [{ type: "command", command: "lint" }] }],
      },
      permissions: { allow: ["Bash(git status)"] },
    }
    writeFileSync(settings, JSON.stringify(original, null, 2))
    installClaudeCode(settings)
    expect(uninstallClaudeCode(settings)).toBe("uninstalled")
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(JSON.parse(JSON.stringify(original)))
  })

  it("round-trips an empty object, an empty hooks object and an empty event array", () => {
    for (const original of [{}, { hooks: {} }, { hooks: { SessionStart: [] } }]) {
      const settings = join(dir(), "settings.json")
      writeFileSync(settings, JSON.stringify(original, null, 2))
      installClaudeCode(settings)
      uninstallClaudeCode(settings)
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(original)
    }
  })

  it("keeps an element that shares an event with ours but carries other commands", () => {
    const settings = join(dir(), "settings.json")
    const original = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo user" }] },
          { hooks: [{ type: "command", command: HOOK_COMMAND["claude-code"] }, { type: "command", command: "echo also-user" }] },
        ],
      },
    }
    writeFileSync(settings, JSON.stringify(original, null, 2))
    expect(uninstallClaudeCode(settings)).toBe("uninstalled")
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as typeof original
    // only the mida command entries are removed — the element's other hooks stay
    expect(parsed.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "echo user" }] },
      { hooks: [{ type: "command", command: "echo also-user" }] },
    ])
  })

  it("not-installed on a file without our entries and on a missing file, writing nothing", () => {
    const settings = join(dir(), "settings.json")
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } })
    writeFileSync(settings, text)
    expect(uninstallClaudeCode(settings)).toBe("not-installed")
    expect(readFileSync(settings, "utf8")).toBe(text)
    expect(uninstallClaudeCode(join(dir(), "settings.json"))).toBe("not-installed")
  })
})

describe("mida install codex", () => {
  it("creates a missing config.toml with exactly the managed block", () => {
    const config = join(dir(), "nested", "config.toml")
    expect(installCodex(config)).toBe("installed")
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock()}\n`)
  })

  it("the managed block carries the whats-new hook on the same inject command, absolutely (R5-7)", () => {
    const block = codexBlock()
    expect(block).toContain("[[hooks.UserPromptSubmit]]")
    expect(block).toContain(`command = "${injectCommand("codex")}"`)
    expect(block).toContain(`command = "${hookCommand("codex")}"`)
    // every command line in the block names an absolute file
    for (const match of block.matchAll(/command = "([^"]*)"/g)) {
      expect(parseMidaCommand(match[1])).not.toBeNull()
    }
  })

  it("an older managed block is upgraded in place, bytes outside preserved", () => {
    for (const legacy of [CODEX_BLOCK_V1, CODEX_BLOCK]) {
      const config = join(dir(), "config.toml")
      const before = 'model = "gpt-5"\n'
      writeFileSync(config, `${before}\n${legacy}\n`)
      expect(codexHooksStatus(config)).toBe("outdated")
      expect(installCodex(config)).toBe("installed")
      const text = readFileSync(config, "utf8")
      expect(text).toBe(`${before}\n${codexBlock()}\n`)
      expect(codexHooksStatus(config)).toBe("installed")
      // and the upgrade is idempotent
      expect(installCodex(config)).toBe("already-installed")
      expect(readFileSync(config, "utf8")).toBe(text)
    }
  })

  it("uninstall removes an outdated block too — markers still mean it is ours", () => {
    for (const legacy of [CODEX_BLOCK_V1, CODEX_BLOCK]) {
      const config = join(dir(), "config.toml")
      const before = 'model = "gpt-5"\n'
      writeFileSync(config, `${before}\n${legacy}\n`)
      expect(uninstallCodex(config)).toBe("uninstalled")
      expect(readFileSync(config, "utf8")).toBe(before)
    }
  })

  it("appends after existing content with one blank line, bytes outside preserved", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\napproval_policy = "untrusted"\n'
    writeFileSync(config, before)
    expect(installCodex(config)).toBe("installed")
    const text = readFileSync(config, "utf8")
    expect(text).toBe(`${before}\n${codexBlock()}\n`)
    // second install is a byte-identical no-op
    expect(installCodex(config)).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(text)
    expect(statSync(config).mtimeMs).toBe(statSync(config).mtimeMs)
  })

  it("completes a last line without newline before the blank line", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"'
    writeFileSync(config, before)
    installCodex(config)
    expect(readFileSync(config, "utf8")).toBe(`${before}\n\n${codexBlock()}\n`)
  })

  it("does not add a blank line when the file already ends in one", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\n\n'
    writeFileSync(config, before)
    installCodex(config)
    expect(readFileSync(config, "utf8")).toBe(`${before}${codexBlock()}\n`)
  })

  it("refuses settings-unreadable when the markers wrap edited content, writing nothing", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\n'
    writeFileSync(config, before)
    installCodex(config)
    const tampered = readFileSync(config, "utf8").replace(
      /command = "[^"]*"/,
      'command = "mida-hook codex --extra"',
    )
    writeFileSync(config, tampered)
    expect(() => installCodex(config)).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
    expect(readFileSync(config, "utf8")).toBe(tampered)
  })

  it("refuses settings-unreadable when only one marker is present", () => {
    const config = join(dir(), "config.toml")
    const text = 'model = "x"\n# >>> mida hooks — managed by `mida install codex`; do not edit >>>\n'
    writeFileSync(config, text)
    expect(() => installCodex(config)).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
    expect(readFileSync(config, "utf8")).toBe(text)
  })

  it("uninstall removes the block and its blank line, bytes outside preserved", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\napproval_policy = "untrusted"\n'
    writeFileSync(config, before)
    installCodex(config)
    expect(uninstallCodex(config)).toBe("uninstalled")
    expect(readFileSync(config, "utf8")).toBe(before)
  })

  it("uninstall on a file created by install leaves an empty file", () => {
    const config = join(dir(), "config.toml")
    installCodex(config)
    expect(uninstallCodex(config)).toBe("uninstalled")
    expect(readFileSync(config, "utf8")).toBe("")
  })

  it("uninstall is not-installed on absent block or missing file, writing nothing", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\n'
    writeFileSync(config, before)
    expect(uninstallCodex(config)).toBe("not-installed")
    expect(readFileSync(config, "utf8")).toBe(before)
    expect(uninstallCodex(join(dir(), "config.toml"))).toBe("not-installed")
  })
})

describe("the Codex trust reminder", () => {
  it("the sentence is the exact line the tools' docs describe", () => {
    expect(CODEX_TRUST_SENTENCE).toBe(
      "Codex will ignore these hooks until you trust them: open codex, type /hooks, and trust the Mida entries.",
    )
  })

  const install = (config: string, settings: string, argv: string[]) => {
    const lines: string[] = []
    const code = runInstall(argv, { print: (line) => lines.push(line), claudeSettings: settings, codexConfig: config })
    return { code, lines }
  }

  it("prints when the config was written — a fresh install and a version upgrade", () => {
    const config = join(dir(), "config.toml")
    const settings = join(dir(), "settings.json")
    const first = install(config, settings, ["install", "codex"])
    expect(first.code).toBe(0)
    expect(first.lines).toContain(CODEX_TRUST_SENTENCE)
    // an older managed block counts as a write too — the upgrade changes what Codex must trust
    const upgraded = join(dir(), "config.toml")
    writeFileSync(upgraded, `${CODEX_BLOCK_V1}\n`)
    const second = install(upgraded, settings, ["install", "codex"])
    expect(second.code).toBe(0)
    expect(second.lines).toContain(CODEX_TRUST_SENTENCE)
  })

  it("stays quiet when the config was not changed — already-installed, uninstall, claude-code", () => {
    const config = join(dir(), "config.toml")
    const settings = join(dir(), "settings.json")
    install(config, settings, ["install", "codex"])
    const again = install(config, settings, ["install", "codex"])
    expect(again.lines).toContain("already installed")
    expect(again.lines).not.toContain(CODEX_TRUST_SENTENCE)
    const removed = install(config, settings, ["uninstall", "codex"])
    expect(removed.lines).not.toContain(CODEX_TRUST_SENTENCE)
    const claude = install(config, settings, ["install", "claude-code"])
    expect(claude.lines).not.toContain(CODEX_TRUST_SENTENCE)
  })
})
