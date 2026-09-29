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
  devinHooksStatus,
  hookCommand,
  injectCommand,
  installClaudeCode,
  installCodex,
  installDevin,
  installMcpClient,
  mcpLauncherPath,
  codexMcpStatus,
  parseMidaCommand,
  recordCodexHome,
  recordedCodexHome,
  resolveDevinConfigPath,
  runInstall,
  transcriptPathAllowed,
  uninstallClaudeCode,
  uninstallCodex,
  uninstallDevin,
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
  // the env value is a plain string — nothing stats it on disk
  const home = "/mida-home"

  it("creates a missing config.toml with exactly the managed block", () => {
    const config = join(dir(), "nested", "config.toml")
    expect(installCodex(config, { home })).toBe("installed")
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock({ home })}\n`)
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
    // the managed block is exactly codexBlock({ home }) — an unchanged block never re-asks Codex's trust
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock({ home: midaHome.root })}\n`)
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
    const block = codexBlock({ home })
    expect(block).toContain("[[hooks.UserPromptSubmit]]")
    expect(block).toContain(`command = "${injectCommand("codex")}"`)
    expect(block).toContain(`command = "${hookCommand("codex")}"`)
    // every command line in the block names an absolute file — the hooks parse back to their
    // entries; the one that does not is the MCP server's own launcher
    for (const match of block.matchAll(/command = "([^"]*)"/g)) {
      expect(isAbsolute(match[1]!)).toBe(true)
      if (match[1] === mcpLauncherPath()) continue
      expect(parseMidaCommand(match[1])).not.toBeNull()
    }
  })

  it("an older managed block is upgraded in place, bytes outside preserved", () => {
    for (const legacy of [CODEX_BLOCK_V1, CODEX_BLOCK]) {
      const config = join(dir(), "config.toml")
      const before = 'model = "gpt-5"\n'
      writeFileSync(config, `${before}\n${legacy}\n`)
      expect(codexHooksStatus(config)).toBe("outdated")
      expect(installCodex(config, { home })).toBe("installed")
      const text = readFileSync(config, "utf8")
      expect(text).toBe(`${before}\n${codexBlock({ home })}\n`)
      expect(codexHooksStatus(config)).toBe("installed")
      // and the upgrade is idempotent
      expect(installCodex(config, { home })).toBe("already-installed")
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
    expect(installCodex(config, { home })).toBe("installed")
    const text = readFileSync(config, "utf8")
    expect(text).toBe(`${before}\n${codexBlock({ home })}\n`)
    // second install is a byte-identical no-op
    expect(installCodex(config, { home })).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(text)
    expect(statSync(config).mtimeMs).toBe(statSync(config).mtimeMs)
  })

  it("completes a last line without newline before the blank line", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"'
    writeFileSync(config, before)
    installCodex(config, { home })
    expect(readFileSync(config, "utf8")).toBe(`${before}\n\n${codexBlock({ home })}\n`)
  })

  it("does not add a blank line when the file already ends in one", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\n\n'
    writeFileSync(config, before)
    installCodex(config, { home })
    expect(readFileSync(config, "utf8")).toBe(`${before}${codexBlock({ home })}\n`)
  })

  it("refuses settings-unreadable when the markers wrap edited content, writing nothing", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\n'
    writeFileSync(config, before)
    installCodex(config, { home })
    const tampered = readFileSync(config, "utf8").replace(
      /command = "[^"]*"/,
      'command = "mida-hook codex --extra"',
    )
    writeFileSync(config, tampered)
    expect(() => installCodex(config, { home })).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
    expect(readFileSync(config, "utf8")).toBe(tampered)
  })

  it("refuses settings-unreadable when only one marker is present", () => {
    const config = join(dir(), "config.toml")
    const text = 'model = "x"\n# >>> mida hooks — managed by `mida install codex`; do not edit >>>\n'
    writeFileSync(config, text)
    expect(() => installCodex(config, { home })).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
    expect(readFileSync(config, "utf8")).toBe(text)
  })

  it("uninstall removes the block and its blank line, bytes outside preserved", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\napproval_policy = "untrusted"\n'
    writeFileSync(config, before)
    installCodex(config, { home })
    expect(uninstallCodex(config)).toBe("uninstalled")
    expect(readFileSync(config, "utf8")).toBe(before)
  })

  it("uninstall on a file created by install leaves an empty file", () => {
    const config = join(dir(), "config.toml")
    installCodex(config, { home })
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

describe("Codex's [hooks.state] trust records inside the managed block", () => {
  // the env value is a plain string — nothing stats it on disk
  const home = "/mida-home"
  // Codex fingerprints hook commands and writes the records the user trusted with /hooks as
  // [hooks.state."<path>:<event>:<row>:<index>"] tables — appended after the LAST hooks table in
  // the file, which lands inside our markers, before the close marker. They are Codex's data —
  // including another tool's entries (ecc@ecc here) — never ours to compare or delete.
  const trustedHash = (seed: string) => `trusted_hash = "sha256:${seed.padEnd(64, "0")}"`
  const codexStateTables = [
    "[hooks.state]",
    "",
    '[hooks.state."/Users/you/.codex/config.toml:session_start:0:0"]',
    trustedHash("ed997f3f"),
    "",
    '[hooks.state."/Users/you/.codex/config.toml:session_start:1:0"]',
    trustedHash("88ef7545"),
    "",
    '[hooks.state."/Users/you/.codex/config.toml:user_prompt_submit:0:0"]',
    trustedHash("005fd533"),
    "",
    '[hooks.state."/Users/you/.codex/config.toml:stop:0:0"]',
    trustedHash("22234841"),
    "",
    '[hooks.state."ecc@ecc:hooks/codex-hooks.json:session_start:0:0"]',
    trustedHash("323e8107"),
  ].join("\n")

  /** The live shape: our block, then Codex's state tables, then the close marker. */
  const withCodexState = (block: string) =>
    `${block.slice(0, block.lastIndexOf("# <<< mida hooks <<<"))}\n${codexStateTables}\n# <<< mida hooks <<<`

  it("a current block plus Codex's trust records reads installed, and install is a byte-identical no-op", () => {
    const config = join(dir(), "config.toml")
    const text = `model = "gpt-5"\n\n${withCodexState(codexBlock({ home }))}\n`
    writeFileSync(config, text)
    expect(codexHooksStatus(config)).toBe("installed")
    expect(installCodex(config, { home })).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(text)
  })

  it("an upgrade from an older managed block keeps every trust record, re-emitted after the close marker", () => {
    for (const legacy of [CODEX_BLOCK_V1, CODEX_BLOCK]) {
      const config = join(dir(), "config.toml")
      const before = 'model = "gpt-5"\n'
      writeFileSync(config, `${before}\n${withCodexState(legacy)}\n`)
      expect(codexHooksStatus(config)).toBe("outdated")
      expect(installCodex(config, { home })).toBe("installed")
      const text = readFileSync(config, "utf8")
      // bytes outside preserved, the new block written, all five records after the close marker
      expect(text).toBe(`${before}\n${codexBlock({ home })}\n${codexStateTables}\n`)
      expect(codexHooksStatus(config)).toBe("installed")
      expect(installCodex(config, { home })).toBe("already-installed")
      expect(readFileSync(config, "utf8")).toBe(text)
    }
  })

  it("uninstall removes only our tables — all five trust records survive, including the other tool's", () => {
    const config = join(dir(), "config.toml")
    const before = 'model = "gpt-5"\n'
    writeFileSync(config, `${before}\n${withCodexState(codexBlock({ home }))}\n`)
    expect(uninstallCodex(config)).toBe("uninstalled")
    const text = readFileSync(config, "utf8")
    expect(text).toBe(`${before}\n${codexStateTables}\n`)
    expect(text.match(/trusted_hash/g)).toHaveLength(5)
    expect(text).toContain("ecc@ecc")
    expect(text).not.toContain("mida hooks")
  })

  it("a state table carrying a field we do not know is still Codex's — it is preserved, not refused (in-16 K-3)", () => {
    const config = join(dir(), "config.toml")
    // a newer Codex could write more than trusted_hash inside its own state tables; the table's
    // header is not one of Mida's, so the whole table is foreign data carried verbatim
    const text = `${withCodexState(codexBlock({ home })).replace(trustedHash("323e8107"), 'custom_field = "value"')}\n`
    writeFileSync(config, text)
    expect(codexHooksStatus(config)).toBe("installed")
    expect(installCodex(config, { home })).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(text)
    expect(uninstallCodex(config)).toBe("uninstalled")
    expect(readFileSync(config, "utf8")).toContain('custom_field = "value"')
  })

  it("[hooks.state] with NO blank line before it still reads installed (in-16 K-3 / P1)", () => {
    const config = join(dir(), "config.toml")
    // Codex appends after the last hooks table — nothing says it adds a blank line first
    const tight = `${codexBlock({ home }).slice(0, codexBlock({ home }).lastIndexOf("# <<< mida hooks <<<"))}${codexStateTables}\n# <<< mida hooks <<<`
    const text = `model = "gpt-5"\n\n${tight}\n`
    writeFileSync(config, text)
    expect(codexHooksStatus(config)).toBe("installed")
    expect(installCodex(config, { home })).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(text)
  })

  it("any other table inside the markers is foreign data — preserved through install and uninstall (in-16 K-3)", () => {
    // whatever wrote [hooks.state] inside the markers can write [projects."…"] there too —
    // doctor must not call that outdated and install/uninstall must not delete it
    const foreign = '[projects."/Users/x/newproj"]\ntrust_level = "trusted"'
    const before = 'model = "gpt-5"\n'
    for (const block of [codexBlock({ home }), CODEX_BLOCK]) {
      const config = join(dir(), "config.toml")
      const text = `${before}\n${block.slice(0, block.lastIndexOf("# <<< mida hooks <<<"))}\n${foreign}\n# <<< mida hooks <<<\n`
      writeFileSync(config, text)
      const installed = installCodex(config, { home })
      const after = readFileSync(config, "utf8")
      expect(after).toContain("newproj")
      expect(after).toContain('trust_level = "trusted"')
      // a rewrite moves the foreign table out after the close marker — never deletes it; a
      // current block needs no rewrite, so it stays where it was (still ours to keep)
      if (installed === "installed") {
        expect(after.indexOf(foreign)).toBeGreaterThan(after.indexOf("# <<< mida hooks <<<"))
      }
      const config2 = join(dir(), "config.toml")
      writeFileSync(config2, text)
      expect(uninstallCodex(config2)).toBe("uninstalled")
      expect(readFileSync(config2, "utf8")).toContain("newproj")
    }
  })

  it("a foreign table, THEN state tables, THEN another foreign table — all preserved (in-16 K-3)", () => {
    const config = join(dir(), "config.toml")
    const extra = `[projects."/Users/x/newproj"]\ntrust_level = "trusted"\n\n${codexStateTables}\n\n[notice]\nhide_full_access_warning = true`
    const text = `model = "x"\n\n${codexBlock({ home }).slice(0, codexBlock({ home }).lastIndexOf("# <<< mida hooks <<<"))}\n${extra}\n# <<< mida hooks <<<\n`
    writeFileSync(config, text)
    expect(codexHooksStatus(config)).toBe("installed")
    expect(uninstallCodex(config)).toBe("uninstalled")
    const after = readFileSync(config, "utf8")
    expect(after).toContain("newproj")
    expect(after).toContain("hide_full_access_warning")
    expect(after.match(/trusted_hash/g)).toHaveLength(5)
    expect(after).not.toContain("mida hooks")
  })

  it("a hand edit INSIDE one of our hook tables refuses — never silently wiped (in-16 K-3 / P6)", () => {
    const config = join(dir(), "config.toml")
    const edited = codexBlock({ home }).replace('type = "command"', 'type = "command"\ntimeout = 5')
    const text = `model = "x"\n\n${edited}\n`
    writeFileSync(config, text)
    expect(codexHooksStatus(config)).toBe("unreadable")
    expect(() => installCodex(config, { home })).toThrowError(expect.objectContaining({ code: "settings-unreadable" }))
    expect(readFileSync(config, "utf8")).toBe(text)
    expect(() => uninstallCodex(config)).toThrowError(expect.objectContaining({ code: "settings-unreadable" }))
  })

  it("a foreign command line inside the markers refuses — the shape is not ours (in-16 K-3)", () => {
    const config = join(dir(), "config.toml")
    const edited = codexBlock({ home }).replace(/command = "[^"]*"/, 'command = "other-tool hook"')
    const text = `model = "x"\n\n${edited}\n`
    writeFileSync(config, text)
    expect(codexHooksStatus(config)).toBe("unreadable")
    expect(() => installCodex(config, { home })).toThrowError(expect.objectContaining({ code: "settings-unreadable" }))
    expect(readFileSync(config, "utf8")).toBe(text)
  })

  it("a CRLF file keeps CRLF through upgrade and uninstall — no mixed endings (in-16 K-3 / P5)", () => {
    const config = join(dir(), "config.toml")
    const lf = `model = "x"\n\n${CODEX_BLOCK.slice(0, CODEX_BLOCK.lastIndexOf("# <<< mida hooks <<<"))}\n${codexStateTables}\n# <<< mida hooks <<<\n`
    writeFileSync(config, lf.replace(/\n/g, "\r\n"))
    expect(codexHooksStatus(config)).toBe("outdated")
    expect(installCodex(config, { home })).toBe("installed")
    const after = readFileSync(config, "utf8")
    // no lone CR, no lone LF: every line break in the file is a full CRLF
    expect(/\r(?!\n)/.test(after)).toBe(false)
    expect(/[^\r]\n/.test(after)).toBe(false)
    expect(after).toContain(codexBlock({ home }).replace(/\n/g, "\r\n"))
    expect(after.match(/trusted_hash/g)).toHaveLength(5)
    // a CRLF block that is otherwise current reads installed — not rewritten to LF
    const config2 = join(dir(), "config.toml")
    writeFileSync(config2, `model = "x"\r\n\r\n${codexBlock({ home }).replace(/\n/g, "\r\n")}\r\n`)
    expect(codexHooksStatus(config2)).toBe("installed")
    expect(installCodex(config2, { home })).toBe("already-installed")
    // and uninstall on the upgraded CRLF file leaves clean CRLF
    expect(uninstallCodex(config)).toBe("uninstalled")
    const un = readFileSync(config, "utf8")
    expect(/\r(?!\n)/.test(un)).toBe(false)
    expect(/[^\r]\n/.test(un)).toBe(false)
    expect(un.match(/trusted_hash/g)).toHaveLength(5)
  })
})

describe("the codex MCP server inside the managed block (in-28)", () => {
  const midaHome = () => join(dir(), "mida-home")

  /** The hook command lines in a config — the mcp table's own command line is not a hook. */
  const hookLines = (text: string) =>
    text
      .split("\n")
      .map((line) => /^command = "([^"]*)"$/.exec(line)?.[1])
      .filter((command): command is string => command !== undefined && parseMidaCommand(command) !== null)

  it("install writes [mcp_servers.mida] inside the managed block — launcher, --as codex, MIDA_HOME, no --project", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    expect(installCodex(config, { home })).toBe("installed")
    const block = codexBlock({ home })
    expect(readFileSync(config, "utf8")).toBe(`${block}\n`)
    const lines = block.split("\n")
    const at = lines.indexOf("[mcp_servers.mida]")
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(`command = "${mcpLauncherPath()}"`)
    expect(lines[at + 2]).toBe('args = ["--as", "codex"]')
    expect(lines[at + 3]).toBe(`env = { MIDA_HOME = "${home}" }`)
    // the table sits inside the markers, FIRST — Codex writes its trust records after the
    // last hooks table, so anything after them is foreign content the block must survive
    expect(at).toBe(1)
    expect(at).toBeLessThan(lines.indexOf("[[hooks.SessionStart]]"))
    // a CLI-agent server never carries --project: the session's own folder is the project
    expect(block).not.toContain("--project")
  })

  it("adding the MCP table leaves every hook command line byte-identical — Codex never re-fingerprints them", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    installCodex(config, { home, mcp: false })
    const before = hookLines(readFileSync(config, "utf8"))
    expect(before).toHaveLength(3)
    expect(installCodex(config, { home })).toBe("installed")
    const after = readFileSync(config, "utf8")
    expect(after).toContain("[mcp_servers.mida]")
    expect(hookLines(after)).toEqual(before)
  })

  it("--no-mcp writes the hooks-only block — installed hooks, no MCP table, no fake upgrade", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    expect(installCodex(config, { home, mcp: false })).toBe("installed")
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock({ mcp: false })}\n`)
    expect(codexHooksStatus(config)).toBe("installed")
    expect(codexMcpStatus(config, home)).toBe("not-installed")
    // a second --no-mcp run is a no-op, and a default run adds just the table
    expect(installCodex(config, { home, mcp: false })).toBe("already-installed")
    expect(installCodex(config, { home })).toBe("installed")
    expect(codexMcpStatus(config, home)).toBe("installed")
  })

  it("--no-mcp never strips an existing MCP table — removal belongs to uninstall", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    installCodex(config, { home })
    expect(installCodex(config, { home, mcp: false })).toBe("already-installed")
    expect(codexMcpStatus(config, home)).toBe("installed")
  })

  it("codexMcpStatus answers installed only for this build's entry at this home", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    installCodex(config, { home })
    expect(codexMcpStatus(config, home)).toBe("installed")
    // the entry exists but points at another Mida home — not installed FOR this one
    expect(codexMcpStatus(config, join(dir(), "other-home"))).toBe("not-installed")
    expect(codexMcpStatus(join(dir(), "missing.toml"), home)).toBe("absent")
    // uninstall removes the table with the block — only the entry named mida, only ours
    expect(uninstallCodex(config)).toBe("uninstalled")
    expect(readFileSync(config, "utf8")).not.toContain("mcp_servers")
    expect(codexMcpStatus(config, home)).toBe("absent")
  })

  it("a foreign [mcp_servers.mida] outside the managed block refuses — never a duplicate table", () => {
    const foreign = '[mcp_servers.mida]\ncommand = "/usr/bin/other"\n'
    const config = join(dir(), "config.toml")
    const text = `model = "x"\n\n${foreign}`
    writeFileSync(config, text)
    expect(() => installCodex(config, { home: midaHome() })).toThrowError(/mcp_servers\.mida/)
    expect(readFileSync(config, "utf8")).toBe(text)
    // and the same table after our block is just as foreign — uninstall keeps it, never deletes it
    const config2 = join(dir(), "config.toml")
    writeFileSync(config2, `${codexBlock({ home: midaHome() })}\n\n${foreign}`)
    expect(uninstallCodex(config2)).toBe("uninstalled")
    expect(readFileSync(config2, "utf8")).toContain(foreign)
  })

  it("a stale block carrying the table upgrades — hook paths re-pinned, the MCP entry rebuilt", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    installCodex(config, { home })
    const stale = readFileSync(config, "utf8")
      .replace(hookCommand("codex"), "/other/checkout/mida-hook codex")
      .replaceAll(injectCommand("codex"), "/other/checkout/mida-inject codex")
      .replace(mcpLauncherPath(), "/other/checkout/bin/mida-mcp")
      .replace(home, "/other/home")
    writeFileSync(config, stale)
    expect(codexHooksStatus(config)).toBe("outdated")
    expect(installCodex(config, { home })).toBe("installed")
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock({ home })}\n`)
    expect(codexMcpStatus(config, home)).toBe("installed")
  })

  it("a hand edit inside the MCP table refuses — the block is never silently repaired", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    installCodex(config, { home })
    const edited = readFileSync(config, "utf8").replace(
      'args = ["--as", "codex"]',
      'args = ["--as", "codex", "--danger"]',
    )
    writeFileSync(config, edited)
    expect(codexHooksStatus(config)).toBe("unreadable")
    expect(codexMcpStatus(config, home)).toBe("unreadable")
    expect(() => installCodex(config, { home })).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
    expect(readFileSync(config, "utf8")).toBe(edited)
    expect(() => uninstallCodex(config)).toThrowError(
      expect.objectContaining({ code: "settings-unreadable" }),
    )
  })

  it("the MCP table survives inside a CRLF file — endings kept through upgrade (in-16 K-3)", () => {
    const config = join(dir(), "config.toml")
    const home = midaHome()
    writeFileSync(config, `model = "x"\r\n\r\n${CODEX_BLOCK.replace(/\n/g, "\r\n")}\r\n`)
    expect(installCodex(config, { home })).toBe("installed")
    const after = readFileSync(config, "utf8")
    expect(/\r(?!\n)/.test(after)).toBe(false)
    expect(/[^\r]\n/.test(after)).toBe(false)
    expect(after).toContain("[mcp_servers.mida]")
    expect(after).toContain(`env = { MIDA_HOME = "${home}" }`)
  })

  it("runInstall defaults to writing the server table alongside the hooks", () => {
    const config = join(dir(), "config.toml")
    const home = new MidaHome(join(dir(), "mida-home"))
    const lines: string[] = []
    expect(
      runInstall(["install", "codex"], {
        print: (line) => lines.push(line),
        claudeSettings: join(dir(), "settings.json"),
        codexConfig: config,
        home,
      }),
    ).toBe(0)
    const text = readFileSync(config, "utf8")
    expect(text).toContain("[mcp_servers.mida]")
    expect(text).toContain(`env = { MIDA_HOME = "${home.root}" }`)
    expect(codexMcpStatus(config, home.root)).toBe("installed")
  })

  it("runInstall honours --no-mcp after the tool name — the hooks-only block, no table", () => {
    const config = join(dir(), "config.toml")
    const home = new MidaHome(join(dir(), "mida-home"))
    const lines: string[] = []
    expect(
      runInstall(["install", "codex", "--no-mcp"], {
        print: (line) => lines.push(line),
        claudeSettings: join(dir(), "settings.json"),
        codexConfig: config,
        home,
      }),
    ).toBe(0)
    expect(readFileSync(config, "utf8")).toBe(`${codexBlock({ mcp: false })}\n`)
    expect(codexHooksStatus(config)).toBe("installed")
    expect(codexMcpStatus(config, home.root)).toBe("not-installed")
  })

  it("--no-mcp parses on the claude-code install too — hooks written, nothing MCP yet", () => {
    const settings = join(dir(), "settings.json")
    const home = new MidaHome(join(dir(), "mida-home"))
    const lines: string[] = []
    expect(
      runInstall(["install", "claude-code", "--no-mcp"], {
        print: (line) => lines.push(line),
        claudeSettings: settings,
        codexConfig: join(dir(), "config.toml"),
        home,
      }),
    ).toBe(0)
    expect(claudeHooksStatus(settings)).toBe("installed")
  })

  it("--no-mcp is an install flag — uninstall refuses it, and a bogus flag is usage", () => {
    const config = join(dir(), "config.toml")
    const home = new MidaHome(join(dir(), "mida-home"))
    const deps = {
      print: (line: string) => lines.push(line),
      claudeSettings: join(dir(), "settings.json"),
      codexConfig: config,
      home,
    }
    const lines: string[] = []
    expect(runInstall(["uninstall", "codex", "--no-mcp"], deps)).toBe(2)
    expect(runInstall(["install", "codex", "--bogus"], deps)).toBe(2)
  })
})

describe("the claude-code MCP server through the claude CLI (in-28)", () => {
  const midaHome = () => join(dir(), "mida-home")

  /** Deps for a runInstall claude-code round trip — the claude binary is ALWAYS injected. */
  const claudeDeps = (
    settings: string,
    home: MidaHome,
    lines: string[],
    run: (args: string[]) => { status: number | null; error?: Error },
    userConfig = join(dir(), ".claude.json"),
  ) => ({
    print: (line: string) => lines.push(line),
    claudeSettings: settings,
    codexConfig: join(dir(), "config.toml"),
    home,
    claudeUserConfig: userConfig,
    claudeCli: run,
  })

  const ENOENT = () => ({ status: null, error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) })

  it("install spawns `claude mcp add-json --scope user mida` with the launcher's JSON — no --project", () => {
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), ".claude.json")
    const home = new MidaHome(midaHome())
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["install", "claude-code"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }), userConfig)),
    ).toBe(0)
    expect(claudeHooksStatus(settings)).toBe("installed")
    expect(calls).toHaveLength(1)
    const [verb, sub, scope, scopeName, name, json] = calls[0]!
    expect([verb, sub, scope, scopeName, name]).toEqual(["mcp", "add-json", "--scope", "user", "mida"])
    const entry = JSON.parse(json!) as { command: string; args: string[]; env: { MIDA_HOME: string } }
    expect(entry.command).toBe(mcpLauncherPath())
    expect(entry.args).toEqual(["--as", "claude-code"])
    expect(entry.env.MIDA_HOME).toBe(home.root)
    // no --project anywhere: the session's own folder is the project
    expect(entry.args).not.toContain("--project")
  })

  it("a claude binary missing from PATH prints the exact note and the install still succeeds", () => {
    const settings = join(dir(), "settings.json")
    const home = new MidaHome(midaHome())
    const lines: string[] = []
    expect(runInstall(["install", "claude-code"], claudeDeps(settings, home, lines, () => ENOENT()))).toBe(0)
    expect(claudeHooksStatus(settings)).toBe("installed")
    expect(lines).toContain(
      "claude-code: MCP server not added. The claude command is not on your PATH; hooks are installed.",
    )
  })

  it("without an injected runner the install reaches `claude` on PATH — and the test wall answers 97 (in-28b)", () => {
    // The injected claudeCli is the ONLY road to the binary; this run leaves it unset so
    // runInstall's production default (spawnSync "claude") executes. Under the global test
    // wall that spawn is the refusing stub — exit 97, never the real binary — and the throw
    // it causes is what this test pins. A pass here means: had any earlier test forgotten to
    // inject, it would have hit the same stub and failed loudly.
    const settings = join(dir(), "settings.json")
    const home = new MidaHome(midaHome())
    const lines: string[] = []
    expect(
      runInstall(["install", "claude-code"], {
        print: (line) => lines.push(line),
        claudeSettings: settings,
        codexConfig: join(dir(), "config.toml"),
        home,
        claudeUserConfig: join(dir(), ".claude.json"),
      }),
    ).toBe(1)
    // hooks still landed — the refusal is about the server entry only
    expect(claudeHooksStatus(settings)).toBe("installed")
    expect(lines).toContain("refused: UNEXPECTED")
  })

  it("--no-mcp never reaches for the claude binary at all", () => {
    const settings = join(dir(), "settings.json")
    const home = new MidaHome(midaHome())
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["install", "claude-code", "--no-mcp"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }))),
    ).toBe(0)
    expect(claudeHooksStatus(settings)).toBe("installed")
    expect(calls).toHaveLength(0)
  })

  it("an identical entry already in ~/.claude.json short-circuits — no CLI call", () => {
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), ".claude.json")
    const home = new MidaHome(midaHome())
    writeFileSync(userConfig, JSON.stringify({
      mcpServers: {
        mida: { command: mcpLauncherPath(), args: ["--as", "claude-code"], env: { MIDA_HOME: home.root } },
      },
    }))
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["install", "claude-code"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }), userConfig)),
    ).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("a foreign mida entry in ~/.claude.json refuses the install — never overwritten", () => {
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), ".claude.json")
    const home = new MidaHome(midaHome())
    const foreign = { command: "/usr/bin/other-server", args: ["--serve"], env: {} }
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { mida: foreign } }))
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["install", "claude-code"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }), userConfig)),
    ).toBe(1)
    // the hooks still landed — the refusal is about the server entry only
    expect(claudeHooksStatus(settings)).toBe("installed")
    expect(calls).toHaveLength(0)
    expect(readFileSync(userConfig, "utf8")).toBe(JSON.stringify({ mcpServers: { mida: foreign } }))
  })

  it("uninstall spawns `claude mcp remove --scope user mida` — only when the entry is ours", () => {
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), ".claude.json")
    const home = new MidaHome(midaHome())
    writeFileSync(userConfig, JSON.stringify({
      mcpServers: {
        mida: { command: mcpLauncherPath(), args: ["--as", "claude-code"], env: { MIDA_HOME: home.root } },
        other: { command: "/usr/bin/other" },
      },
    }))
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["uninstall", "claude-code"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }), userConfig)),
    ).toBe(0)
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "mida"]])
  })

  it("uninstall never removes a foreign mida entry — the CLI is not even called", () => {
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), ".claude.json")
    const home = new MidaHome(midaHome())
    const foreign = { command: "/usr/bin/other-server", args: ["--serve"] }
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { mida: foreign } }))
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["uninstall", "claude-code"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }), userConfig)),
    ).toBe(0)
    expect(calls).toHaveLength(0)
    expect(readFileSync(userConfig, "utf8")).toBe(JSON.stringify({ mcpServers: { mida: foreign } }))
  })

  it("uninstall with no mida entry makes no CLI call — not-installed is honest", () => {
    const settings = join(dir(), "settings.json")
    const home = new MidaHome(midaHome())
    const calls: string[][] = []
    const lines: string[] = []
    expect(
      runInstall(["uninstall", "claude-code"], claudeDeps(settings, home, lines, (args) => (calls.push(args), { status: 0 }))),
    ).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe("the Codex trust reminder", () => {
  it("the sentence is the exact line the tools' docs describe", () => {
    expect(CODEX_TRUST_SENTENCE).toBe(
      "Codex will ignore these hooks until you trust them: open codex, type /hooks, and trust the Mida entries.",
    )
  })

  const install = (config: string, settings: string, argv: string[], midaHome = new MidaHome(join(dir(), "mida-home"))) => {
    const lines: string[] = []
    const code = runInstall(argv, {
      print: (line) => lines.push(line),
      claudeSettings: settings,
      codexConfig: config,
      home: midaHome,
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
    // the same Mida home across the repeat install — a different home means a different
    // MIDA_HOME env line, which IS a block change
    const midaHome = new MidaHome(join(dir(), "mida-home"))
    install(config, settings, ["install", "codex"], midaHome)
    const again = install(config, settings, ["install", "codex"], midaHome)
    expect(again.lines).toContain("already installed")
    expect(again.lines).not.toContain(CODEX_TRUST_SENTENCE)
    const removed = install(config, settings, ["uninstall", "codex"], midaHome)
    expect(removed.lines).not.toContain(CODEX_TRUST_SENTENCE)
    const claude = install(config, settings, ["install", "claude-code"], midaHome)
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

describe("mida install devin", () => {
  const devinEvents = {
    inject: ["SessionStart", "UserPromptSubmit"],
    hook: ["PostToolUse", "Stop", "PostCompaction", "SessionEnd"],
  }
  const devinConfig = () => {
    const path = join(dir(), ".config", "devin", "config.json")
    mkdirSync(dirname(path), { recursive: true })
    return path
  }
  const commandOf = (config: string, event: string) =>
    (JSON.parse(readFileSync(config, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }).hooks[event]![0]!.hooks[0]!.command

  it("the legacy constants keep the bare devin text, and the resolved commands parse back as devin", () => {
    expect(HOOK_COMMAND.devin).toBe("mida-hook devin")
    expect(INJECT_COMMAND.devin).toBe("mida-inject devin")
    for (const [command, kind] of [
      [hookCommand("devin"), "hook"],
      [injectCommand("devin"), "inject"],
    ] as const) {
      expect(command.endsWith(" devin")).toBe(true)
      expect(command).not.toBe(`mida-${kind} devin`) // never the bare name
      const parsed = parseMidaCommand(command)
      expect(parsed).toMatchObject({ kind, tool: "devin" })
    }
  })

  it("installs Devin's own six events into a missing config — never Claude's event set", () => {
    const config = devinConfig()
    expect(installDevin(config)).toBe("installed")
    const parsed = JSON.parse(readFileSync(config, "utf8")) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    for (const event of devinEvents.inject) expect(commandOf(config, event)).toBe(injectCommand("devin"))
    for (const event of devinEvents.hook) expect(commandOf(config, event)).toBe(hookCommand("devin"))
    // Devin has no StopFailure/PreCompact — those are Claude's events and must not appear
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      [...devinEvents.inject, ...devinEvents.hook].sort(),
    )
    // every command parses as this client's own tool — none can be read as claude-code's
    for (const element of Object.values(parsed.hooks).flat()) {
      for (const hook of element.hooks) {
        expect(parseMidaCommand(hook.command)?.tool).toBe("devin")
      }
    }
    expect(existsSync(`${config}.mida-backup`)).toBe(false)
  })

  it("keeps every other key and every non-Mida hook, backing up the original once", () => {
    const config = devinConfig()
    const original = {
      theme: "dark",
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "lint --fix" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
      },
    }
    writeFileSync(config, `${JSON.stringify(original, null, 2)}\n`)
    expect(installDevin(config)).toBe("installed")
    expect(readFileSync(`${config}.mida-backup`, "utf8")).toBe(`${JSON.stringify(original, null, 2)}\n`)
    const parsed = JSON.parse(readFileSync(config, "utf8")) as {
      theme: string
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(parsed.theme).toBe("dark")
    // the user's entries are untouched; ours appended after them
    expect(parsed.hooks.PostToolUse![0]).toEqual(original.hooks.PostToolUse[0])
    expect(parsed.hooks.PostToolUse![1]).toEqual({ hooks: [{ type: "command", command: hookCommand("devin") }] })
    // an event Devin fires but Mida does not manage keeps only the user's entries
    expect(parsed.hooks.PreToolUse).toEqual(original.hooks.PreToolUse)
  })

  it("a claude-code command sitting in Devin's config is NOT ours — it is left alone, not rewritten or counted", () => {
    const config = devinConfig()
    // an imported/foreign entry that happens to name another Mida client
    const original = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: hookCommand("claude-code") }] }],
      },
    }
    writeFileSync(config, JSON.stringify(original))
    expect(devinHooksStatus(config)).toBe("incomplete")
    expect(installDevin(config)).toBe("installed")
    const parsed = JSON.parse(readFileSync(config, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    // the claude entry survives verbatim; our devin entry was appended beside it
    expect(parsed.hooks.PostToolUse).toHaveLength(2)
    expect(parsed.hooks.PostToolUse![0]!.hooks[0]!.command).toBe(hookCommand("claude-code"))
    expect(parsed.hooks.PostToolUse![1]!.hooks[0]!.command).toBe(hookCommand("devin"))
  })

  it("is idempotent — a second install is already-installed and byte-identical", () => {
    const config = devinConfig()
    expect(installDevin(config)).toBe("installed")
    const before = readFileSync(config, "utf8")
    expect(installDevin(config)).toBe("already-installed")
    expect(readFileSync(config, "utf8")).toBe(before)
  })

  it("a bare-name devin block reads outdated and is rewritten in place — the versioned upgrade", () => {
    const config = devinConfig()
    const legacy = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: INJECT_COMMAND.devin }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: INJECT_COMMAND.devin }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: HOOK_COMMAND.devin }] }],
        Stop: [{ hooks: [{ type: "command", command: HOOK_COMMAND.devin }] }],
        PostCompaction: [{ hooks: [{ type: "command", command: HOOK_COMMAND.devin }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: HOOK_COMMAND.devin }] }],
      },
    }
    writeFileSync(config, JSON.stringify(legacy))
    expect(devinHooksStatus(config)).toBe("outdated")
    expect(installDevin(config)).toBe("installed")
    for (const event of devinEvents.inject) expect(commandOf(config, event)).toBe(injectCommand("devin"))
    for (const event of devinEvents.hook) expect(commandOf(config, event)).toBe(hookCommand("devin"))
    expect(devinHooksStatus(config)).toBe("installed")
  })

  it("statuses: absent on a missing file, incomplete on a partial install, unreadable on bad JSON", () => {
    const missing = devinConfig()
    expect(devinHooksStatus(missing)).toBe("absent")
    const partial = devinConfig()
    writeFileSync(partial, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: hookCommand("devin") }] }] } }))
    expect(devinHooksStatus(partial)).toBe("incomplete")
    const bad = devinConfig()
    writeFileSync(bad, "{ hooks: not json")
    expect(devinHooksStatus(bad)).toBe("unreadable")
  })

  it("uninstall removes only Mida's entries — user hooks and other keys survive", () => {
    const config = devinConfig()
    const original = {
      theme: "dark",
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "lint" }] }] },
    }
    writeFileSync(config, `${JSON.stringify(original, null, 2)}\n`)
    installDevin(config)
    expect(uninstallDevin(config)).toBe("uninstalled")
    const parsed = JSON.parse(readFileSync(config, "utf8"))
    // back to the original shape: theme kept, the user's PostToolUse entry kept,
    // install-created event keys dropped
    expect(parsed).toEqual(original)
    expect(uninstallDevin(config)).toBe("not-installed")
  })

  it("isolation both ways: claude settings get no devin commands; devin config gets no claude commands", () => {
    const settings = join(dir(), "settings.json")
    installClaudeCode(settings)
    const claudeText = readFileSync(settings, "utf8")
    expect(claudeText).not.toContain(" devin")
    const config = devinConfig()
    installDevin(config)
    const devinText = readFileSync(config, "utf8")
    expect(devinText).not.toContain(" claude-code")
    // and a claude command never parses as a devin command — one cannot be run as the other
    expect(parseMidaCommand(`mida-hook claude-code`)?.tool).toBe("claude-code")
    expect(parseMidaCommand(`mida-hook devin`)?.tool).toBe("devin")
  })

  it("resolveDevinConfigPath: MIDA_DEVIN_CONFIG wins, else ~/.config/devin/config.json", () => {
    const home = dir()
    expect(resolveDevinConfigPath({}, home)).toBe(join(home, ".config", "devin", "config.json"))
    expect(resolveDevinConfigPath({ MIDA_DEVIN_CONFIG: "/tmp/x.json" }, home)).toBe("/tmp/x.json")
  })

  it("runInstall refuses install devin — the identity half makes it an owner command (in-9) — while uninstall stays local", () => {
    const config = devinConfig()
    const lines: string[] = []
    const home = new MidaHome(join(dir(), "mida-home"))
    // the install half moved to the owner command: it provisions the devin identity, so the
    // local config-only path refuses it exactly like install <mcp-client>
    const code = runInstall(["install", "devin"], {
      print: (line) => lines.push(line),
      claudeSettings: join(dir(), "settings.json"),
      codexConfig: join(dir(), "config.toml"),
      devinConfig: config,
      home,
    })
    expect(code).toBe(2)
    expect(lines.some((line) => line.includes("owner command"))).toBe(true)
    expect(existsSync(config)).toBe(false)
    lines.length = 0
    // uninstall is config-only — no identity work — so it stays local
    installDevin(config)
    expect(
      runInstall(["uninstall", "devin"], {
        print: (line) => lines.push(line),
        claudeSettings: join(dir(), "settings.json"),
        codexConfig: join(dir(), "config.toml"),
        devinConfig: config,
        home,
      }),
    ).toBe(0)
    expect(lines).toEqual(["uninstalled"])
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({})
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
    for (const client of ["claude-desktop", "cursor", "devin"]) {
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
