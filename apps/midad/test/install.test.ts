import { describe, expect, it } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import {
  CODEX_BLOCK,
  CODEX_BLOCK_V1,
  CODEX_TRUST_SENTENCE,
  HOOK_COMMAND,
  INJECT_COMMAND,
  MidaHome,
  claudeHooksStatus,
  codexBlock,
  codexHooksStatus,
  cursorMcpConfigPath,
  hookCommand,
  injectCommand,
  installClaudeCode,
  installCodex,
  installMcpClient,
  parseMidaCommand,
  recordCodexHome,
  recordedCodexHome,
  runInstall,
  transcriptPathAllowed,
  uninstallClaudeCode,
  uninstallCodex,
  uninstallMcpClient,
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

  it("installs into CODEX_HOME when set and records the resolved home in the Mida home", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "mida-codex-home-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    const config = join(codexHome, "config.toml")
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    const lines: string[] = []
    let code = -1
    try {
      code = runInstall(["install", "codex"], {
        print: (line) => lines.push(line),
        claudeSettings: join(dir(), "settings.json"),
        codexConfig: config,
        home: midaHome,
      })
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
    expect(code).toBe(0)
    // the managed block is exactly codexBlock() — an unchanged block never re-asks Codex's trust
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock()}\n`)
    expect(readFileSync(midaHome.path("codex-home"), "utf8")).toBe(`${codexHome}\n`)
    expect(recordedCodexHome(midaHome)).toBe(codexHome)
  })

  /** runInstall under a pinned CODEX_HOME, collecting printed lines. */
  const runCodexInstall = (argv: string[], codexHome: string, midaHome: MidaHome, lines: string[]) => {
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    try {
      return runInstall(argv, {
        print: (line) => lines.push(line),
        claudeSettings: join(dir(), "settings.json"),
        codexConfig: join(codexHome, "config.toml"),
        home: midaHome,
      })
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  }

  it("installing under a different CODEX_HOME names the home that stops being trusted (F8)", () => {
    const homeA = mkdtempSync(join(tmpdir(), "mida-codex-a-"))
    const homeB = mkdtempSync(join(tmpdir(), "mida-codex-b-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    recordCodexHome(midaHome, homeA)
    const lines: string[] = []
    expect(runCodexInstall(["install", "codex"], homeB, midaHome, lines)).toBe(0)
    // the record moved to the new home…
    expect(recordedCodexHome(midaHome)).toBe(homeB)
    // …and the owner heard which home is no longer trusted
    expect(lines.some((line) => line.includes(homeA) && line.includes("no longer trusted"))).toBe(true)
  })

  it("re-installing under the recorded home prints no move line (F8)", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "mida-codex-same-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    recordCodexHome(midaHome, codexHome)
    const lines: string[] = []
    expect(runCodexInstall(["install", "codex"], codexHome, midaHome, lines)).toBe(0)
    expect(lines.every((line) => !line.includes("no longer trusted"))).toBe(true)
    expect(recordedCodexHome(midaHome)).toBe(codexHome)
  })

  it("uninstall clears the recorded home — nothing stays trusted (F8)", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "mida-codex-off-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    const lines: string[] = []
    expect(runCodexInstall(["install", "codex"], codexHome, midaHome, lines)).toBe(0)
    expect(recordedCodexHome(midaHome)).toBe(codexHome)
    lines.length = 0
    expect(runCodexInstall(["uninstall", "codex"], codexHome, midaHome, lines)).toBe(0)
    expect(recordedCodexHome(midaHome)).toBeUndefined()
    expect(midaHome.has("codex-home")).toBe(false)
  })

  it("uninstall codex edits the config under the RECORDED home, not the shell's CODEX_HOME (G7)", () => {
    const homeA = mkdtempSync(join(tmpdir(), "mida-codex-a-"))
    const homeB = mkdtempSync(join(tmpdir(), "mida-codex-b-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    const lines: string[] = []
    expect(runCodexInstall(["install", "codex"], homeA, midaHome, lines)).toBe(0)
    expect(recordedCodexHome(midaHome)).toBe(homeA)
    lines.length = 0
    // the shell's CODEX_HOME is a different folder by uninstall time — the managed block lives
    // under homeA, so that is the config edited, and only after the edit does the record clear
    expect(runCodexInstall(["uninstall", "codex"], homeB, midaHome, lines)).toBe(0)
    expect(lines).toContain("uninstalled")
    expect(readFileSync(join(homeA, "config.toml"), "utf8")).not.toContain("mida hooks")
    expect(recordedCodexHome(midaHome)).toBeUndefined()
  })

  it("a codex uninstall that refuses the recorded config keeps the record (G7)", () => {
    const homeA = mkdtempSync(join(tmpdir(), "mida-codex-a-"))
    const homeB = mkdtempSync(join(tmpdir(), "mida-codex-b-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    // markers without a valid close are a tampered block — the edit under homeA is refused,
    // and the record must survive it: the trust it describes was never lifted
    writeFileSync(join(homeA, "config.toml"), `${CODEX_BLOCK_V1.slice(0, -12)}\n`)
    recordCodexHome(midaHome, homeA)
    const lines: string[] = []
    expect(runCodexInstall(["uninstall", "codex"], homeB, midaHome, lines)).toBe(1)
    expect(lines.some((line) => line.includes("refused"))).toBe(true)
    expect(recordedCodexHome(midaHome)).toBe(homeA)
  })

  it("the move line is true — the old Codex home really stops being trusted (G7)", () => {
    const userHome = mkdtempSync(join(tmpdir(), "mida-user-"))
    const defaultCodex = join(userHome, ".codex")
    const homeB = mkdtempSync(join(tmpdir(), "mida-codex-b-"))
    const midaHome = new MidaHome(mkdtempSync(join(tmpdir(), "mida-home-")))
    // as an install under the default home recorded it
    recordCodexHome(midaHome, defaultCodex)
    const rollout = join(defaultCodex, "sessions", "2026", "09", "25", "rollout-x.jsonl")
    mkdirSync(dirname(rollout), { recursive: true })
    writeFileSync(rollout, "{}\n")
    expect(transcriptPathAllowed(rollout, "codex", userHome, midaHome)).toBe(true)
    const lines: string[] = []
    expect(runCodexInstall(["install", "codex"], homeB, midaHome, lines)).toBe(0)
    expect(lines.some((line) => line.includes(defaultCodex) && line.includes("no longer trusted"))).toBe(true)
    expect(transcriptPathAllowed(rollout, "codex", userHome, midaHome)).toBe(false)
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
    const code = runInstall(argv, {
      print: (line) => lines.push(line),
      claudeSettings: settings,
      codexConfig: config,
      home: new MidaHome(join(dir(), "mida-home")),
    })
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

/**
 * The MCP clients (Task 11, I1): `mida install claude-desktop|cursor` merges one mcpServers entry
 * — the mida-mcp launcher, the client's own `--as` identity, this home in env — into the client's
 * config. Every other server and key is kept as parsed; the first change leaves a one-time
 * `.mida-backup`. The identity half (init + requestAccess) lives in the owner command, tested in
 * cli.test.ts — here the file behaviour is proven on its own.
 */
describe("installMcpClient — the client adapters", () => {
  it("merges mida-claude-desktop into an existing config: other servers byte-equal, backup once, re-run a no-op", () => {
    const config = join(dir(), "claude_desktop_config.json")
    const original = `${JSON.stringify({ mcpServers: { other: { command: "/usr/local/bin/other", args: ["--serve"] } }, theme: "dark" }, null, 4)}\n`
    writeFileSync(config, original)
    const home = join(dir(), "mida-home")
    const work = join(dir(), "work")
    expect(installMcpClient("claude-desktop", config, home, work)).toBe("installed")
    const parsed = JSON.parse(readFileSync(config, "utf8"))
    // everything already in the file is still there, exactly as parsed
    expect(parsed.theme).toBe("dark")
    expect(parsed.mcpServers.other).toEqual({ command: "/usr/local/bin/other", args: ["--serve"] })
    const entry = parsed.mcpServers["mida-claude-desktop"]
    // an absolute launcher the client can spawn with no Mida PATH, its own identity, this home
    expect(isAbsolute(entry.command)).toBe(true)
    expect(basename(entry.command)).toMatch(/^mida-mcp/)
    expect(entry.args).toEqual(["--as", "claude-desktop", "--project", work])
    expect(entry.env).toEqual({ MIDA_HOME: home })
    // the pre-install bytes are kept once — a later install never rewrites the backup
    expect(readFileSync(`${config}.mida-backup`, "utf8")).toBe(original)
    const afterInstall = readFileSync(config, "utf8")
    expect(installMcpClient("claude-desktop", config, home, work)).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(afterInstall)
  })

  it("writes the config when none exists, creating the folder — no backup, nothing to keep", () => {
    const config = join(dir(), "Claude", "claude_desktop_config.json")
    expect(installMcpClient("claude-desktop", config, join(dir(), "home"), dir())).toBe("installed")
    const parsed = JSON.parse(readFileSync(config, "utf8"))
    expect(Object.keys(parsed)).toEqual(["mcpServers"])
    expect(Object.keys(parsed.mcpServers)).toEqual(["mida-claude-desktop"])
    expect(existsSync(`${config}.mida-backup`)).toBe(false)
  })

  it("cursor writes <cwd>/.cursor/mcp.json with the literal ${workspaceFolder} — Cursor resolves it per window", () => {
    const work = dir()
    const home = join(dir(), "mida-home")
    const config = cursorMcpConfigPath(work)
    expect(config).toBe(join(work, ".cursor", "mcp.json"))
    expect(installMcpClient("cursor", config, home, work)).toBe("installed")
    const entry = JSON.parse(readFileSync(config, "utf8")).mcpServers["mida-cursor"]
    expect(entry.args).toEqual(["--as", "cursor", "--project", "${workspaceFolder}"])
    expect(entry.env).toEqual({ MIDA_HOME: home })
    expect(isAbsolute(entry.command)).toBe(true)
  })

  it("each client carries its own identity — no entry ever says --as assistant", () => {
    const home = join(dir(), "mida-home")
    const desktopConfig = join(dir(), "claude_desktop_config.json")
    const cursorConfig = join(dir(), "mcp.json")
    installMcpClient("claude-desktop", desktopConfig, home, dir())
    installMcpClient("cursor", cursorConfig, home, dir())
    const desktop = JSON.parse(readFileSync(desktopConfig, "utf8")).mcpServers["mida-claude-desktop"]
    const cursor = JSON.parse(readFileSync(cursorConfig, "utf8")).mcpServers["mida-cursor"]
    expect(desktop.args).toContain("claude-desktop")
    expect(cursor.args).toContain("cursor")
    for (const entry of [desktop, cursor]) expect(entry.args).not.toContain("assistant")
  })

  it("a mcpServers that is not an object — or any unreadable config — is refused whole, file untouched", () => {
    for (const bad of ["not json {", "[1,2]", JSON.stringify({ mcpServers: [1] })]) {
      const config = join(dir(), "claude_desktop_config.json")
      writeFileSync(config, bad)
      expect(() => installMcpClient("claude-desktop", config, join(dir(), "home"), dir())).toThrowError(/cannot be read/)
      expect(readFileSync(config, "utf8")).toBe(bad)
      expect(() => uninstallMcpClient("claude-desktop", config)).toThrowError(/cannot be read/)
      expect(readFileSync(config, "utf8")).toBe(bad)
    }
  })

  it("an entry that is ours but stale is rewritten — an install from an older checkout's path is ours to update", () => {
    const config = join(dir(), "mcp.json")
    const home = join(dir(), "home")
    installMcpClient("cursor", config, home, dir())
    const parsed = JSON.parse(readFileSync(config, "utf8"))
    parsed.mcpServers["mida-cursor"].command = "/older/checkout/bin/mida-mcp"
    writeFileSync(config, JSON.stringify(parsed))
    const outcome = installMcpClient("cursor", config, home, dir())
    const now = JSON.parse(readFileSync(config, "utf8")).mcpServers["mida-cursor"].command
    expect(now).not.toBe("/older/checkout/bin/mida-mcp")
    expect(outcome).toEqual({ moved: { from: "/older/checkout/bin/mida-mcp", to: now } })
  })

  it("a server named mida-<client> whose args are not ours is refused — never overwritten (G13)", () => {
    for (const foreign of [
      { command: "/opt/tools/claude-bridge" },
      { command: "/x", args: ["--as", "assistant"] },
      { command: "/x", args: ["--as", "claude-desktop"], env: { MIDA_HOME: "/someone/elses/home" } },
    ]) {
      const config = join(dir(), "claude_desktop_config.json")
      const original = { mcpServers: { "mida-claude-desktop": foreign, other: { command: "/y" } }, theme: "dark" }
      writeFileSync(config, JSON.stringify(original))
      expect(() => installMcpClient("claude-desktop", config, join(dir(), "home"), dir()))
        .toThrowError("a server named mida-claude-desktop exists and is not Mida's — rename it or remove it")
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(original)
    }
  })

  it("re-installing from another folder asks nothing but reports the move from old project to new (G13)", () => {
    const home = join(dir(), "mida-home")
    const oldWork = join(dir(), "work-a")
    const newWork = join(dir(), "work-b")
    const config = join(dir(), "claude_desktop_config.json")
    expect(installMcpClient("claude-desktop", config, home, oldWork)).toBe("installed")
    expect(installMcpClient("claude-desktop", config, home, newWork)).toEqual({ moved: { from: oldWork, to: newWork } })
    expect(JSON.parse(readFileSync(config, "utf8")).mcpServers["mida-claude-desktop"].args)
      .toEqual(["--as", "claude-desktop", "--project", newWork])
  })

  it("the config file's mode survives an install or uninstall — temp+rename must not reset it (G13)", () => {
    const config = join(dir(), "claude_desktop_config.json")
    writeFileSync(config, JSON.stringify({ mcpServers: { other: { command: "/x" } } }))
    chmodSync(config, 0o600)
    expect(installMcpClient("claude-desktop", config, join(dir(), "home"), dir())).toBe("installed")
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(uninstallMcpClient("claude-desktop", config)).toBe("uninstalled")
    expect(statSync(config).mode & 0o777).toBe(0o600)
  })
})

describe("uninstallMcpClient", () => {
  it("removes only Mida's entry — other servers and other keys stay", () => {
    const config = join(dir(), "claude_desktop_config.json")
    writeFileSync(config, JSON.stringify({ mcpServers: { other: { command: "/x" } }, theme: 1 }))
    installMcpClient("claude-desktop", config, join(dir(), "home"), dir())
    expect(uninstallMcpClient("claude-desktop", config)).toBe("uninstalled")
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ mcpServers: { other: { command: "/x" } }, theme: 1 })
    expect(uninstallMcpClient("claude-desktop", config)).toBe("not-installed")
    // one client's entry never touches the other's
    installMcpClient("claude-desktop", config, join(dir(), "home"), dir())
    expect(uninstallMcpClient("cursor", config)).toBe("not-installed")
    expect("mida-claude-desktop" in JSON.parse(readFileSync(config, "utf8")).mcpServers).toBe(true)
  })

  it("drops an emptied mcpServers install created, and keeps one the file already had", () => {
    // install created the whole file — mcpServers was ours, so it goes
    const fresh = join(dir(), "mcp.json")
    installMcpClient("cursor", fresh, join(dir(), "home"), dir())
    expect(uninstallMcpClient("cursor", fresh)).toBe("uninstalled")
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({})
    // mcpServers was already in the file the first install saw — the emptied object stays
    const owned = join(dir(), "mcp.json")
    writeFileSync(owned, JSON.stringify({ mcpServers: {} }))
    installMcpClient("cursor", owned, join(dir(), "home"), dir())
    expect(uninstallMcpClient("cursor", owned)).toBe("uninstalled")
    expect(JSON.parse(readFileSync(owned, "utf8"))).toEqual({ mcpServers: {} })
  })

  it("a missing file is not-installed and writes nothing", () => {
    const config = join(dir(), "claude_desktop_config.json")
    expect(uninstallMcpClient("claude-desktop", config)).toBe("not-installed")
    expect(existsSync(config)).toBe(false)
  })

  it("a config with no mcpServers key at all is not-installed — never a bare crash (G13)", () => {
    const config = join(dir(), "claude_desktop_config.json")
    writeFileSync(config, JSON.stringify({ theme: 1 }))
    expect(uninstallMcpClient("claude-desktop", config)).toBe("not-installed")
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ theme: 1 })
  })

  it("a mida-<client> entry that is not Mida's is left in place — we never installed it (G13)", () => {
    const config = join(dir(), "claude_desktop_config.json")
    const original = { mcpServers: { "mida-claude-desktop": { command: "/opt/tools/claude-bridge" } } }
    writeFileSync(config, JSON.stringify(original))
    expect(uninstallMcpClient("claude-desktop", config)).toBe("not-installed")
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(original)
  })
})

describe("runInstall for the clients", () => {
  const run = (argv: string[], extra: Record<string, unknown> = {}) => {
    const lines: string[] = []
    const code = runInstall(argv, {
      print: (line) => lines.push(line),
      claudeSettings: join(dir(), "settings.json"),
      codexConfig: join(dir(), "config.toml"),
      home: new MidaHome(join(dir(), "mida-home")),
      ...extra,
    })
    return { code, lines }
  }

  it("uninstall <client> removes only the entry and says the identity stays behind", () => {
    const config = join(dir(), "claude_desktop_config.json")
    // one home for install and uninstall alike — an entry pointing at another home is not ours
    const home = new MidaHome(join(dir(), "mida-home"))
    installMcpClient("claude-desktop", config, home.root, dir())
    const { code, lines } = run(["uninstall", "claude-desktop"], { claudeDesktopConfig: config, home })
    expect(code).toBe(0)
    expect(lines[0]).toBe("uninstalled")
    expect(lines.some((line) => line.includes("identity") && line.includes("`mida revoke claude-desktop`"))).toBe(true)
    expect("mcpServers" in JSON.parse(readFileSync(config, "utf8"))).toBe(false)
  })

  it("uninstall cursor resolves <cwd>/.cursor/mcp.json", () => {
    const work = dir()
    const home = new MidaHome(join(dir(), "mida-home"))
    installMcpClient("cursor", cursorMcpConfigPath(work), home.root, work)
    const { code, lines } = run(["uninstall", "cursor"], { cwd: work, home })
    expect(code).toBe(0)
    expect(lines[0]).toBe("uninstalled")
    expect(JSON.parse(readFileSync(cursorMcpConfigPath(work), "utf8"))).toEqual({})
  })

  it("install <client> is refused here — the identity half belongs to the owner command", () => {
    for (const client of ["claude-desktop", "cursor"]) {
      const { code, lines } = run(["install", client], { cwd: dir() })
      expect(code).toBe(2)
      expect(lines.some((line) => line.includes("owner command"))).toBe(true)
    }
    // and an uninstalled client still answers cleanly
    const { code, lines } = run(["uninstall", "cursor"], { cwd: dir() })
    expect(code).toBe(0)
    expect(lines).toEqual(["not installed"])
  })
})
