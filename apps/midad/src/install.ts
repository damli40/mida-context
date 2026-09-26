import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { isBundled, siblingEntryArgs, siblingEntryPath } from "./sibling.js"
import type { SiblingEntry } from "./sibling.js"
import { DEVIN_INSTALLED_EVENTS } from "./devin-facts.js"

/**
 * The hook command text is exact and carries nothing else — no environment variable, no
 * trailing space. Codex fingerprints the command text and silently drops a hook whose text
 * changed (spike); the same discipline is kept for Claude Code.
 *
 * Since the Sep 22 live failure (`/bin/sh: mida-hook: command not found` in a Claude Code
 * window started outside a Mida PATH shell) the command names the hook binary ABSOLUTELY —
 * the path `mida` itself resolved to — instead of a bare name the tool's shell must find.
 * These constants keep the legacy bare text for recognition only: uninstall removes both
 * forms and doctor reports a bare entry as stale.
 */
export const HOOK_COMMAND = {
  "claude-code": "mida-hook claude-code",
  "codex": "mida-hook codex",
  "devin": "mida-hook devin",
} as const
export const INJECT_COMMAND = {
  "claude-code": "mida-inject claude-code",
  "codex": "mida-inject codex",
  "devin": "mida-inject devin",
} as const

export type InstallTool = keyof typeof HOOK_COMMAND

/** The MCP clients — each connects over mida-mcp with its own identity, never a hook. */
export const MCP_CLIENT_TOOLS: readonly string[] = ["claude-desktop", "cursor"]
export type McpClientTool = "claude-desktop" | "cursor"

/** The one server entry each client's mcpServers map carries. */
export const MCP_SERVER_NAME: Record<McpClientTool, string> = {
  "claude-desktop": "mida-claude-desktop",
  "cursor": "mida-cursor",
}

/** Claude Desktop's config lives under the account, not the project — overridable in tests. */
export const claudeDesktopConfigPath = (homeDir: string): string =>
  join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")

/** Cursor reads <project>/.cursor/mcp.json — the install cwd is the workspace. */
export const cursorMcpConfigPath = (cwd: string): string => join(cwd, ".cursor", "mcp.json")

/**
 * The mcp launcher. Bundled the dist file is the executable entry; from source the sh launcher
 * is the path a client can spawn without a Mida PATH.
 */
function mcpServerCommand(): string {
  if (isBundled()) return siblingEntryPath("mida-mcp")
  return fileURLToPath(new URL("../../../bin/mida-mcp", import.meta.url))
}

/** The entry written into the client's mcpServers — absolute launcher, own identity, its home. */
function mcpServerEntry(client: McpClientTool, homeRoot: string, cwd: string): Record<string, unknown> {
  return {
    command: mcpServerCommand(),
    // Cursor substitutes ${workspaceFolder} itself; Claude Desktop has no workspace variable, so
    // its project is the folder `mida install` ran in
    args: ["--as", client, "--project", client === "cursor" ? "${workspaceFolder}" : cwd],
    env: { MIDA_HOME: homeRoot },
  }
}

/**
 * Reads the client's MCP config. A missing file is an empty config; a file that is not a JSON
 * object — or whose mcpServers is not an object — is refused whole rather than rewritten.
 */
function readMcpConfig(configPath: string): { text: string; config: Record<string, unknown> } | "absent" {
  if (!existsSync(configPath)) return "absent"
  const text = readFileSync(configPath, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw settingsUnreadable()
  }
  if (!isPlainObject(parsed)) throw settingsUnreadable()
  if ("mcpServers" in parsed && !isPlainObject(parsed.mcpServers)) throw settingsUnreadable()
  return { text, config: parsed }
}

/**
 * Ours only when the entry runs this client's identity out of this Mida home — an entry that
 * shares the mida-<client> name but was written by anything else (or points at another home)
 * is the user's server, and neither install nor uninstall may touch it.
 */
function isMidaServerEntry(value: unknown, client: McpClientTool, homeRoot: string | undefined): boolean {
  if (!isPlainObject(value)) return false
  const args = value.args
  if (!Array.isArray(args) || args[0] !== "--as" || args[1] !== client) return false
  return homeRoot === undefined || (isPlainObject(value.env) && value.env.MIDA_HOME === homeRoot)
}

/**
 * Merges Mida's server entry into the client's MCP config. Everything else in the file is kept
 * as parsed — other servers, other keys. A backup of the pre-install bytes is taken once, and
 * re-running with the same entry changes nothing. An existing entry under our name is rewritten
 * only when it is recognisably Mida's (this client's --as, this home's MIDA_HOME); anything else
 * refuses rather than overwrite a server someone else owns. An ours-but-stale entry reports
 * what moved — re-installing from another folder or checkout is silent about nothing.
 */
export function installMcpClient(client: McpClientTool, configPath: string, homeRoot: string, cwd: string): McpInstallOutcome {
  const name = MCP_SERVER_NAME[client]
  const entry = mcpServerEntry(client, homeRoot, cwd)
  const read = readMcpConfig(configPath)
  if (read === "absent") {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileAtomic(configPath, `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`)
    return "installed"
  }
  const { text, config } = read
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  const existing = servers[name]
  if (isDeepStrictEqual(existing, entry)) return "already-installed"
  if (existing !== undefined && !isMidaServerEntry(existing, client, homeRoot)) {
    throw new Error(`a server named ${name} exists and is not Mida's — rename it or remove it`)
  }
  const backup = `${configPath}.mida-backup`
  if (!existsSync(backup)) writeFileSync(backup, text)
  servers[name] = entry
  config.mcpServers = servers
  writeFileAtomic(configPath, `${JSON.stringify(config, null, detectIndent(text))}\n`)
  if (existing === undefined) return "installed"
  // name the field that moved: the project folder first, else the launcher path (a moved checkout)
  const projectOf = (value: unknown): unknown =>
    isPlainObject(value) && Array.isArray(value.args) ? value.args[value.args.indexOf("--project") + 1] : undefined
  const from = projectOf(existing) !== projectOf(entry) ? projectOf(existing) : (existing as { command?: unknown }).command
  const to = projectOf(existing) !== projectOf(entry) ? projectOf(entry) : entry.command
  return { moved: { from: String(from), to: String(to) } }
}

/**
 * Removes only Mida's server entry — the client's identity and its approvals stay behind.
 * mcpServers itself goes only when it is empty and was not in the pre-install backup. A config
 * with no mcpServers key, or a same-name entry that is not Mida's, is simply "not-installed":
 * there is nothing of ours to remove.
 */
export function uninstallMcpClient(client: McpClientTool, configPath: string, homeRoot?: string): UninstallOutcome {
  const name = MCP_SERVER_NAME[client]
  const read = readMcpConfig(configPath)
  if (read === "absent") return "not-installed"
  const { text, config } = read
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (!isMidaServerEntry(servers[name], client, homeRoot)) return "not-installed"
  delete servers[name]
  if (Object.keys(servers).length === 0 && !existedBeforeInstall(configPath, ["mcpServers"])) {
    delete config.mcpServers
  }
  writeFileAtomic(configPath, `${JSON.stringify(config, null, detectIndent(text))}\n`)
  return "uninstalled"
}

/** Characters safe to leave unquoted in a command line — anything else is double-quoted. */
const BARE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/
const quoteToken = (token: string): string =>
  BARE_TOKEN.test(token) ? token : `"${token.replace(/(["\\$`])/g, "\\$1")}"`

/**
 * The invocation install writes for one entry: the entry file absolutely, runnable without
 * PATH. Bundled, the dist file itself is executable (shebang + 0o755 are built in). From the
 * source tree the file is TypeScript, so the command spells out node + the tsx loader — every
 * token still absolute.
 */
function invocation(entry: SiblingEntry, tool: InstallTool): string {
  const tokens = isBundled() ? [siblingEntryPath(entry)] : [process.execPath, ...siblingEntryArgs(entry)]
  return `${tokens.map(quoteToken).join(" ")} ${tool}`
}

/** The current hook command text for this install — absolute; what a fresh `mida install` writes. */
export function hookCommand(tool: InstallTool): string {
  return invocation("mida-hook", tool)
}

/** The current inject command text for this install — absolute; what a fresh `mida install` writes. */
export function injectCommand(tool: InstallTool): string {
  return invocation("mida-inject", tool)
}

/**
 * What a Mida hook command resolves to: which sibling it invokes, which tool it serves, and
 * the file paths inside it a checker can stat. `paths` lists the program run first — marked
 * whether the shell needs it executable — then the script file it loads. A bare-name command
 * (the pre-absolute form) reports its single token as `executable` but NOT absolute, which is
 * how doctor tells "installed the old way" from "installed".
 */
export interface ParsedHookCommand {
  kind: "hook" | "inject"
  tool: InstallTool
  paths: { file: string; executable: boolean }[]
}

/** The file names a Mida hook command can point at — bare bin, bundled dist file, source file. */
const ENTRY_FILES: Record<"hook" | "inject", readonly string[]> = {
  hook: ["mida-hook", "mida-hook.js", "hook-main.ts"],
  inject: ["mida-inject", "mida-inject.js", "inject-main.ts"],
}

/** Splits a command line into tokens; double-quoted spans are kept whole, quotes stripped. */
function commandTokens(command: string): string[] {
  const tokens: string[] = []
  for (const match of command.matchAll(/"([^"]*)"|(\S+)/g)) tokens.push(match[1] ?? match[2]!)
  return tokens
}

/**
 * Parses a settings-file command: ours if its last token is a tool name and some earlier
 * token's file name is a Mida entry point. Returns null for anything else — a command that
 * merely mentions mida mid-text is not ours to touch.
 */
export function parseMidaCommand(command: unknown): ParsedHookCommand | null {
  if (typeof command !== "string") return null
  const tokens = commandTokens(command)
  if (tokens.length < 2) return null
  const tool = tokens[tokens.length - 1]
  if (tool === undefined || !(tool in HOOK_COMMAND)) return null
  for (const [index, token] of tokens.slice(0, -1).entries()) {
    for (const kind of ["hook", "inject"] as const) {
      if (!ENTRY_FILES[kind].includes(basename(token))) continue
      const paths: ParsedHookCommand["paths"] = []
      const program = tokens[0]!
      if (index === 0) {
        // the entry file IS the program — bundled form or legacy bare name
        paths.push({ file: program, executable: true })
      } else {
        // node + loader + script — the program is checked executable, the script readable
        if (isAbsolute(program)) paths.push({ file: program, executable: true })
        paths.push({ file: token, executable: false })
      }
      return { kind, tool: tool as InstallTool, paths }
    }
  }
  return null
}

/**
 * The event set each JSON-configured hook client gets. Claude Code's list is its own;
 * Devin's comes from devin-facts (PostCompaction, never PreCompact/StopFailure — Devin has
 * no such events). The two never share a list: a Devin config must not inherit Claude's
 * event assumptions.
 */
const JSON_HOOK_EVENTS: Record<"claude-code" | "devin", readonly string[]> = {
  "claude-code": ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "PreCompact", "SessionEnd"],
  devin: DEVIN_INSTALLED_EVENTS,
}
type JsonHookTool = keyof typeof JSON_HOOK_EVENTS

/** The command each event carries: the inject command on the two prompt events, the capture hook on the rest. */
function eventCommands(tool: JsonHookTool): Readonly<Record<string, string>> {
  const inject = injectCommand(tool)
  const hook = hookCommand(tool)
  const commands: Record<string, string> = {}
  for (const event of JSON_HOOK_EVENTS[tool]) {
    commands[event] = kindFor(event) === "inject" ? inject : hook
  }
  return commands
}

export type InstallOutcome = "installed" | "already-installed"
export type UninstallOutcome = "uninstalled" | "not-installed"
/** An MCP install that overwrote our own stale entry reports what moved (project folder or launcher path). */
export type McpInstallOutcome = InstallOutcome | { moved: { from: string; to: string } }

function settingsUnreadable(): Error {
  const error = new Error("the settings file cannot be read safely") as Error & { code: string }
  error.code = "settings-unreadable"
  return error
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The one element install appends to an event's array: `{ hooks: [{ type: "command", command }] }`. */
const hookElement = (command: string): Record<string, unknown> => ({
  hooks: [{ type: "command", command }],
})

/** True when the event's array already holds an element carrying this exact command string. */
const eventHasCommand = (element: unknown, command: string): boolean => {
  if (!isPlainObject(element) || !Array.isArray(element.hooks)) return false
  return element.hooks.some(
    (hook) => isPlainObject(hook) && hook.command === command,
  )
}

/** The indentation of the file being edited — the first indented line wins; two spaces otherwise. */
function detectIndent(text: string): string | number {
  const match = /\n([ \t]+)\S/.exec(text)
  return match === null ? 2 : match[1]!
}

/**
 * Same-folder temp file, then rename — a crash never leaves a half-written settings file. The
 * existing file's mode is copied onto the temp before the rename: a 0600 client config must not
 * come back 0644 just because Mida edited it.
 */
function writeFileAtomic(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    writeFileSync(temp, text)
    if (existsSync(file)) chmodSync(temp, statSync(file).mode & 0o777)
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Reads and validates the settings file. Missing is not an error — it means "create it". Invalid
 * JSON, a non-object top level, a `hooks` that is not an object, or an event key that is not an
 * array all refuse: the user's file is never "repaired" by writing over it. The event list is
 * the tool's own — a non-array entry under an event the tool manages refuses the file.
 */
function readSettings(settingsPath: string, events: readonly string[]): { text: string; settings: Record<string, unknown> } | "absent" {
  if (!existsSync(settingsPath)) return "absent"
  const text = readFileSync(settingsPath, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw settingsUnreadable()
  }
  if (!isPlainObject(parsed)) throw settingsUnreadable()
  if ("hooks" in parsed && !isPlainObject(parsed.hooks)) throw settingsUnreadable()
  const hooks = (parsed.hooks ?? {}) as Record<string, unknown>
  for (const event of events) {
    if (event in hooks && !Array.isArray(hooks[event])) throw settingsUnreadable()
  }
  return { text, settings: parsed }
}

/**
 * Adds Mida's hook entries to a JSON-configured client's settings file (Claude Code's
 * settings.json, Devin's config.json), one new element appended per event; existing elements
 * are never edited, reordered or removed. Idempotent by exact command string — with every
 * event present it prints-and-does nothing ("already installed"). The first change ever
 * leaves `<file>.mida-backup` holding the pre-install bytes; a later install never
 * overwrites an existing backup.
 */
function installJsonHooks(settingsPath: string, tool: JsonHookTool): InstallOutcome {
  const commands = eventCommands(tool)
  const events = JSON_HOOK_EVENTS[tool]
  const read = readSettings(settingsPath, events)
  if (read === "absent") {
    const hooks: Record<string, unknown> = {}
    for (const event of events) hooks[event] = [hookElement(commands[event]!)]
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileAtomic(settingsPath, `${JSON.stringify({ hooks }, null, 2)}\n`)
    return "installed"
  }
  const { text, settings } = read
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  // For each event: rewrite any Mida command of the right kind that is not the current text
  // (a bare `mida-hook <tool>` from an older install) and append where none exists. An
  // element is ours to rewrite only when its command parses as Mida's FOR THIS TOOL — a
  // `mida-hook claude-code` line inside Devin's config is a foreign entry and stays put;
  // user entries are never edited, reordered or removed.
  let changed = false
  for (const event of events) {
    const expected = commands[event]!
    let present = false
    for (const element of (hooks[event] ?? []) as unknown[]) {
      if (!isPlainObject(element) || !Array.isArray(element.hooks)) continue
      for (const hook of element.hooks as unknown[]) {
        if (!isPlainObject(hook)) continue
        if (hook.command === expected) {
          present = true
        } else {
          const parsed = parseMidaCommand(hook.command)
          if (parsed !== null && parsed.tool === tool && parsed.kind === kindFor(event)) {
            hook.command = expected
            present = true
            changed = true
          }
        }
      }
    }
    if (!present) {
      if (!isPlainObject(settings.hooks)) settings.hooks = {}
      const target = settings.hooks as Record<string, unknown>
      if (!Array.isArray(target[event])) target[event] = []
      ;(target[event] as unknown[]).push(hookElement(expected))
      changed = true
    }
  }
  if (!changed) return "already-installed"
  const backupPath = `${settingsPath}.mida-backup`
  if (!existsSync(backupPath)) writeFileAtomic(backupPath, text)
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, detectIndent(text))}\n`)
  return "installed"
}

/** `mida install claude-code` — the JSON installer over Claude Code's settings.json. */
export function installClaudeCode(settingsPath: string): InstallOutcome {
  return installJsonHooks(settingsPath, "claude-code")
}

/** `mida install devin` — the same installer over Devin's own config, its own events. */
export function installDevin(configPath: string): InstallOutcome {
  return installJsonHooks(configPath, "devin")
}

/** Which sibling an event's command must invoke — inject on the two prompt events, hook on the rest. */
const kindFor = (event: string): "hook" | "inject" =>
  event === "SessionStart" || event === "UserPromptSubmit" ? "inject" : "hook"

/**
 * Doctor's read-only view: "installed" only when every event carries the exact current
 * command; "outdated" when every event is covered but at least one entry is an older form
 * (the bare name) — `mida install <tool>` rewrites it in place. "incomplete" covers a
 * missing hooks key and a partial install alike; an unreadable file is reported, never repaired.
 */
function jsonHooksStatus(settingsPath: string, tool: JsonHookTool): "installed" | "outdated" | "incomplete" | "absent" | "unreadable" {
  try {
    const events = JSON_HOOK_EVENTS[tool]
    const read = readSettings(settingsPath, events)
    if (read === "absent") return "absent"
    const hooks = (read.settings.hooks ?? {}) as Record<string, unknown>
    const commands = eventCommands(tool)
    let stale = 0
    for (const event of events) {
      let exact = false
      let ours = false
      for (const element of (hooks[event] ?? []) as unknown[]) {
        if (eventHasCommand(element, commands[event]!)) exact = true
        if (isPlainObject(element) && Array.isArray(element.hooks)) {
          for (const hook of element.hooks as unknown[]) {
            const parsed = isPlainObject(hook) ? parseMidaCommand(hook.command) : null
            if (parsed !== null && parsed.tool === tool && parsed.kind === kindFor(event)) ours = true
          }
        }
      }
      if (!exact && !ours) return "incomplete"
      if (!exact) stale += 1
    }
    return stale === 0 ? "installed" : "outdated"
  } catch {
    return "unreadable"
  }
}

export function claudeHooksStatus(settingsPath: string): ReturnType<typeof jsonHooksStatus> {
  return jsonHooksStatus(settingsPath, "claude-code")
}

export function devinHooksStatus(configPath: string): ReturnType<typeof jsonHooksStatus> {
  return jsonHooksStatus(configPath, "devin")
}

/**
 * Every Mida command string the settings file carries — doctor stats the paths inside them.
 * "absent" when there is no file, "unreadable" when it cannot be parsed.
 */
export function midaCommandsInClaudeSettings(settingsPath: string): string[] | "absent" | "unreadable" {
  try {
    // every event name any JSON-configured tool manages: a non-array entry under one of them
    // is a malformed file and refuses, same rule install/status apply
    const read = readSettings(settingsPath, [...JSON_HOOK_EVENTS["claude-code"], ...JSON_HOOK_EVENTS.devin])
    if (read === "absent") return "absent"
    const hooks = (read.settings.hooks ?? {}) as Record<string, unknown>
    const commands: string[] = []
    for (const list of Object.values(hooks)) {
      if (!Array.isArray(list)) continue
      for (const element of list) {
        if (!isPlainObject(element) || !Array.isArray(element.hooks)) continue
        for (const hook of element.hooks as unknown[]) {
          if (isPlainObject(hook) && parseMidaCommand(hook.command) !== null) commands.push(hook.command as string)
        }
      }
    }
    return commands
  } catch {
    return "unreadable"
  }
}

/** The same listing over Devin's config — the walk is identical, only the file differs. */
export function midaCommandsInDevinConfig(configPath: string): string[] | "absent" | "unreadable" {
  return midaCommandsInClaudeSettings(configPath)
}

/** Ours whatever form it takes — the bare name from an older install or an absolute path. */
const isMidaCommand = (command: unknown): boolean => parseMidaCommand(command) !== null

/**
 * What the pre-install backup says was there before the first change — the only record of which
 * keys install created. An unreadable or absent backup answers "not there": an emptied key is
 * treated as ours and removed.
 */
function existedBeforeInstall(settingsPath: string, path: readonly string[]): boolean {
  try {
    const backup = `${settingsPath}.mida-backup`
    if (!existsSync(backup)) return false
    let node: unknown = JSON.parse(readFileSync(backup, "utf8"))
    for (const key of path) {
      if (!isPlainObject(node) || !(key in node)) return false
      node = node[key]
    }
    return true
  } catch {
    return false
  }
}

/**
 * Removes every hook entry whose command is exactly ours — and nothing else. An element whose
 * hooks array still holds other commands keeps its place; one left empty is dropped. An event key
 * emptied by the removal is dropped only when the pre-install backup shows install created it —
 * an empty array that was already there stays. Same for a now-empty `hooks` object.
 */
export function uninstallClaudeCode(settingsPath: string): UninstallOutcome {
  const read = readSettings(settingsPath, [...JSON_HOOK_EVENTS["claude-code"], ...JSON_HOOK_EVENTS.devin])
  if (read === "absent") return "not-installed"
  const { text, settings } = read
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  let removed = 0
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue
    const kept = list.flatMap((element) => {
      if (!isPlainObject(element) || !Array.isArray(element.hooks)) return [element]
      const had = (element.hooks as unknown[]).length
      const inner = (element.hooks as unknown[]).filter(
        (hook) => !(isPlainObject(hook) && isMidaCommand(hook.command)),
      )
      removed += had - inner.length
      // an element is dropped only when removing our hooks emptied it — one that was already
      // empty is the user's data and stays
      if (inner.length === 0 && had > 0) return []
      element.hooks = inner
      return [element]
    })
    if (kept.length !== list.length) hooks[event] = kept
    // an event key install created is dropped when its array empties; one that predates
    // install (the backup knows) keeps its empty array
    if ((hooks[event] as unknown[]).length === 0 && !existedBeforeInstall(settingsPath, ["hooks", event])) {
      delete hooks[event]
    }
  }
  if (removed === 0) return "not-installed"
  if (isPlainObject(settings.hooks) && Object.keys(settings.hooks).length === 0 && !existedBeforeInstall(settingsPath, ["hooks"])) {
    delete settings.hooks
  }
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, detectIndent(text))}\n`)
  return "uninstalled"
}

/** `mida uninstall devin` — the same removal over Devin's config: only Mida's entries go. */
export function uninstallDevin(configPath: string): UninstallOutcome {
  return uninstallClaudeCode(configPath)
}

/**
 * Codex is configured in TOML and there is no TOML library in this project — deliberately. The
 * managed block is plain text between two marker comments, appended at the end of config.toml
 * where a TOML array-of-tables is always valid. Everything outside the block is byte-preserved.
 * The block is compared whole: markers around edited content mean a human touched it, and the
 * file is refused rather than repaired.
 */
const CODEX_MARKER_OPEN = "# >>> mida hooks — managed by `mida install codex`; do not edit >>>"
const CODEX_MARKER_CLOSE = "# <<< mida hooks <<<"

/** The block install wrote before UserPromptSubmit existed — still recognised as ours, and upgraded in place. */
export const CODEX_BLOCK_V1 = [
  CODEX_MARKER_OPEN,
  "[[hooks.SessionStart]]",
  'matcher = "startup|resume|clear|compact"',
  "",
  "[[hooks.SessionStart.hooks]]",
  'type = "command"',
  `command = "${INJECT_COMMAND.codex}"`,
  "",
  "[[hooks.Stop]]",
  "",
  "[[hooks.Stop.hooks]]",
  'type = "command"',
  `command = "${HOOK_COMMAND.codex}"`,
  CODEX_MARKER_CLOSE,
].join("\n")

/**
 * The block installs before the absolute-path change wrote — the same shape with the bare
 * command names. Still recognised as ours so doctor can call it outdated and uninstall can
 * remove it.
 */
export const CODEX_BLOCK = [
  CODEX_MARKER_OPEN,
  "[[hooks.SessionStart]]",
  'matcher = "startup|resume|clear|compact"',
  "",
  "[[hooks.SessionStart.hooks]]",
  'type = "command"',
  `command = "${INJECT_COMMAND.codex}"`,
  "",
  "[[hooks.UserPromptSubmit]]",
  "",
  "[[hooks.UserPromptSubmit.hooks]]",
  'type = "command"',
  `command = "${INJECT_COMMAND.codex}"`,
  "",
  "[[hooks.Stop]]",
  "",
  "[[hooks.Stop.hooks]]",
  'type = "command"',
  `command = "${HOOK_COMMAND.codex}"`,
  CODEX_MARKER_CLOSE,
].join("\n")

/** The managed block a fresh `mida install codex` writes — the same shape, with absolute commands. */
export function codexBlock(): string {
  return [
    CODEX_MARKER_OPEN,
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume|clear|compact"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = "${injectCommand("codex")}"`,
    "",
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = "${injectCommand("codex")}"`,
    "",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = "${hookCommand("codex")}"`,
    CODEX_MARKER_CLOSE,
  ].join("\n")
}

/**
 * Every managed-block shape this build recognises as its own — anything else between the
 * markers is a human's edit. Built per call because the current block carries the resolved
 * absolute paths.
 */
function codexKnownBlocks(): Readonly<Record<string, "current" | "bare" | "v1">> {
  return {
    [codexBlock()]: "current",
    [CODEX_BLOCK]: "bare",
    [CODEX_BLOCK_V1]: "v1",
  }
}

/**
 * The exact sentence the owner sees whenever the Codex config was written or changed. Codex
 * fingerprints a hook's command text and skips an untrusted hook silently — and re-asks after
 * every change — so the reminder belongs on every write, and only on a write (R5-6).
 */
export const CODEX_TRUST_SENTENCE =
  "Codex will ignore these hooks until you trust them: open codex, type /hooks, and trust the Mida entries."

/** Finds a KNOWN managed block between its markers; "absent" when neither marker is present. */
function locateCodexBlock(text: string): { start: number; end: number; version: "current" | "bare" | "v1" | "stale" } | "absent" {
  const hasOpen = text.includes(CODEX_MARKER_OPEN)
  const hasClose = text.includes(CODEX_MARKER_CLOSE)
  if (!hasOpen && !hasClose) return "absent"
  const start = text.indexOf(CODEX_MARKER_OPEN)
  const closeAt = text.indexOf(CODEX_MARKER_CLOSE)
  if (!hasOpen || !hasClose || closeAt < start) throw settingsUnreadable()
  const end = closeAt + CODEX_MARKER_CLOSE.length
  const version = codexKnownBlocks()[text.slice(start, end)]
  if (version !== undefined) return { start, end, version }
  // A block we do not byte-match can still be ours: an absolute-path block written from a
  // different checkout (the repo moved, or an older build's dist). Every command line must
  // parse as a Mida hook for that to be true — anything else between the markers is a
  // human's edit and refuses.
  const commands = [...text.slice(start, end).matchAll(/command = "([^"]*)"/g)].map((match) => match[1]!)
  if (commands.length > 0 && commands.every((command) => parseMidaCommand(command) !== null)) {
    return { start, end, version: "stale" }
  }
  throw settingsUnreadable()
}

/**
 * Appends the managed block to config.toml, one blank line separating it from whatever came
 * before (or nothing, when the file is created). A block that is already exactly right is a
 * byte-identical no-op; an older KNOWN block is upgraded in place — the markers still mean it
 * is ours to rewrite. Markers around anything else refuse settings-unreadable — the block is
 * never silently overwritten.
 */
export function installCodex(configPath: string): InstallOutcome {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : null
  if (text !== null) {
    const block = locateCodexBlock(text)
    if (block !== "absent") {
      if (block.version === "current") return "already-installed"
      // an older managed block is ours to replace in place — same outcome as a fresh append
      writeFileAtomic(configPath, `${text.slice(0, block.start)}${codexBlock()}${text.slice(block.end)}`)
      return "installed"
    }
  }
  const separator = text === null || text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileAtomic(configPath, `${text ?? ""}${separator}${codexBlock()}\n`)
  return "installed"
}

/**
 * Doctor's read-only view: "installed" only for the current managed block, "outdated" for an
 * older one install can still upgrade — the bare-name block and the pre-UserPromptSubmit v1
 * both land there. "unreadable" means the markers wrap edited content — `mida install codex`
 * would refuse the file too.
 */
export function codexHooksStatus(configPath: string): "installed" | "outdated" | "absent" | "unreadable" {
  try {
    if (!existsSync(configPath)) return "absent"
    const block = locateCodexBlock(readFileSync(configPath, "utf8"))
    if (block === "absent") return "absent"
    return block.version === "current" ? "installed" : "outdated"
  } catch {
    return "unreadable"
  }
}

/**
 * Every command line inside the managed block — doctor stats the paths inside them. Absent
 * or unreadable blocks surface as their own statuses first, so this is only called on a
 * current block.
 */
export function midaCommandsInCodexConfig(configPath: string): string[] | "absent" | "unreadable" {
  try {
    if (!existsSync(configPath)) return "absent"
    const text = readFileSync(configPath, "utf8")
    const block = locateCodexBlock(text)
    if (block === "absent") return "absent"
    const commands: string[] = []
    for (const match of text.slice(block.start, block.end).matchAll(/command = "([^"]*)"/g)) {
      commands.push(match[1]!)
    }
    return commands
  } catch {
    return "unreadable"
  }
}

/**
 * Removes the managed block plus the one blank line install put before it; every byte outside
 * the block survives. A file install itself created becomes empty. A tampered block is not
 * removed — the same settings-unreadable refusal install uses, because what sits between the
 * markers is no longer Mida's to delete.
 */
export function uninstallCodex(configPath: string): UninstallOutcome {
  if (!existsSync(configPath)) return "not-installed"
  const text = readFileSync(configPath, "utf8")
  const block = locateCodexBlock(text)
  if (block === "absent") return "not-installed"
  const before = text.slice(0, block.start)
  // the newline that ends the close-marker line belongs to the block
  const after = text[block.end] === "\n" ? text.slice(block.end + 1) : text.slice(block.end)
  // install added one blank line ("\n") when the file ended in a lone newline — the common case.
  // Two or more blank lines before the block could not have come from install: they stay.
  const restored = before.endsWith("\n\n") && !before.endsWith("\n\n\n") ? before.slice(0, -1) : before
  writeFileAtomic(configPath, restored + after)
  return "uninstalled"
}
