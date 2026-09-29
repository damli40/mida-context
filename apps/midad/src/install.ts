import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, sep } from "node:path"
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

/**
 * The clients whose "current state" is a workspace — files and git. The handoff's
 * check-the-current-state bullets get one concrete adapter line for these; a general assistant
 * or any other identity sees the generic wording only. One list, shared with buildHandoff —
 * it lives here beside the other per-client tool tables.
 */
export const CODING_CLIENTS: readonly string[] = ["claude-code", "codex", "cursor", "devin"]

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
export function mcpLauncherPath(): string {
  if (isBundled()) return siblingEntryPath("mida-mcp")
  return fileURLToPath(new URL("../../../bin/mida-mcp", import.meta.url))
}

/** The entry written into the client's mcpServers — absolute launcher, own identity, its home. */
function mcpServerEntry(client: McpClientTool, homeRoot: string, cwd: string): Record<string, unknown> {
  return {
    command: mcpLauncherPath(),
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
function isMidaServerEntry(value: unknown, client: string, homeRoot: string | undefined): boolean {
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

/**
 * The command an installed Mida entry runs — undefined when the client has no Mida entry or the
 * config cannot be read as one. Doctor uses this to judge the path the app actually spawns: a
 * moved checkout's stale launcher is what macOS blocks, not the path this checkout would write.
 */
export function installedMcpLauncherPath(client: McpClientTool, configPath: string, homeRoot?: string): string | undefined {
  const read = readMcpConfig(configPath)
  if (read === "absent") return undefined
  const entry = ((read.config.mcpServers ?? {}) as Record<string, unknown>)[MCP_SERVER_NAME[client]]
  if (!isMidaServerEntry(entry, client, homeRoot)) return undefined
  return isPlainObject(entry) && typeof entry.command === "string" ? entry.command : undefined
}

/**
 * What a spawned `claude` answers — injectable so tests never touch a real binary. `status`
 * is null with `error.code === "ENOENT"` when the command is not on PATH.
 */
export type ClaudeCliResult = { status: number | null; error?: Error | undefined }
export type ClaudeCliRunner = (args: string[]) => ClaudeCliResult

/** The default runner — the real `claude` on PATH, inheriting this process's stdio. */
export const spawnClaude: ClaudeCliRunner = (args) => spawnSync("claude", args, { stdio: "inherit" })

/** spawnSync's ENOENT — the claude binary is not on this PATH. */
const claudeUnavailable = (result: ClaudeCliResult): boolean =>
  result.status === null && (result.error as { code?: string } | undefined)?.code === "ENOENT"

/** The failed-remove message — a `claude` exit status, or "unknown" when a signal killed it. */
const claudeCliRemoveFailed = (status: number | null): string =>
  `The claude command failed (exit ${status ?? "unknown"}) while removing Mida's MCP server, so it is still registered. Remove it with claude mcp remove -s user mida.`

/**
 * The JSON `claude mcp add-json` takes — the same entry the file-config clients get (absolute
 * launcher, this tool's --as identity, MIDA_HOME), with NO --project: the folder the agent
 * session runs in is the project.
 */
export function claudeCodeMcpJson(homeRoot: string): string {
  return JSON.stringify({
    command: mcpLauncherPath(),
    args: ["--as", "claude-code"],
    env: { MIDA_HOME: homeRoot },
  })
}

/**
 * Where Claude Code keeps the user config that lists MCP servers: `$CLAUDE_CONFIG_DIR/.claude.json`
 * when the variable is set non-empty, else `<home>/.claude.json`. Every Mida reader resolves it
 * through here — a user who set the variable would otherwise watch every `mida install
 * claude-code` add the entry again, because the file it just wrote is never the file Mida read.
 */
export function claudeUserConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.CLAUDE_CONFIG_DIR
  return configured !== undefined && configured !== "" ? join(configured, ".claude.json") : join(homeDir, ".claude.json")
}

/**
 * The mida entry in Claude Code's user config — READ ONLY. Claude Code owns ~/.claude.json
 * and rewrites it constantly, so Mida never writes that file; the read exists only to check
 * "is the mida entry ours" before the claude CLI is asked to add or remove. An unreadable
 * file answers undefined — the CLI is the authority on its own file.
 */
function claudeUserMidaEntry(userConfig: string): unknown {
  try {
    if (!existsSync(userConfig)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(userConfig, "utf8"))
    if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return undefined
    return parsed.mcpServers.mida
  } catch {
    return undefined
  }
}

/**
 * Adds Mida's server to Claude Code's user scope through `claude mcp add-json` — the file is
 * Claude Code's own, so only the claude CLI writes it. An identical entry is a no-op; a mida
 * entry that is not ours (right --as, right MIDA_HOME) refuses rather than overwrite; a stale
 * but ours entry is removed and re-added, because add-json refuses an existing name.
 * "unavailable" means the claude binary is not on PATH — the caller keeps the hooks and says so.
 */
export function installClaudeCodeMcp(opts: {
  home: string
  userConfig: string
  run: ClaudeCliRunner
}): "installed" | "already-installed" | "unavailable" {
  const json = claudeCodeMcpJson(opts.home)
  const existing = claudeUserMidaEntry(opts.userConfig)
  if (isDeepStrictEqual(existing, JSON.parse(json))) return "already-installed"
  if (existing !== undefined) {
    if (!isMidaServerEntry(existing, "claude-code", opts.home)) {
      throw new InstallRefusal(
        "CLAUDE_MCP_NAME_TAKEN",
        "Claude Code already has an MCP server named mida that Mida did not write, so Mida's hooks are installed but its MCP server is not. Rename or remove that server, then run mida install claude-code again.",
      )
    }
    const removed = opts.run(["mcp", "remove", "--scope", "user", "mida"])
    if (claudeUnavailable(removed)) return "unavailable"
    if (removed.status !== 0) throw new InstallRefusal("CLAUDE_CLI_FAILED", claudeCliRemoveFailed(removed.status))
  }
  const result = opts.run(["mcp", "add-json", "--scope", "user", "mida", json])
  if (claudeUnavailable(result)) return "unavailable"
  if (result.status !== 0) {
    throw new InstallRefusal(
      "CLAUDE_CLI_FAILED",
      `The claude command failed (exit ${result.status ?? "unknown"}) while adding Mida's MCP server, so Mida's hooks are installed but its MCP server is not. Update Claude Code, then run mida install claude-code again.`,
    )
  }
  return "installed"
}

/**
 * Removes Mida's server entry through `claude mcp remove` — only when the entry is ours (the
 * same is-it-ours rule the file-config clients apply). "unavailable" means the claude binary
 * is gone from PATH; the entry then stays where it is and the caller says so.
 */
export function uninstallClaudeCodeMcp(opts: {
  home: string
  userConfig: string
  run: ClaudeCliRunner
}): "uninstalled" | "not-installed" | "unavailable" {
  const existing = claudeUserMidaEntry(opts.userConfig)
  if (!isMidaServerEntry(existing, "claude-code", opts.home)) return "not-installed"
  const result = opts.run(["mcp", "remove", "--scope", "user", "mida"])
  if (claudeUnavailable(result)) return "unavailable"
  if (result.status !== 0) throw new InstallRefusal("CLAUDE_CLI_FAILED", claudeCliRemoveFailed(result.status))
  return "uninstalled"
}

/**
 * Doctor's read-only view of the server entry in Claude Code's user config: "installed" only
 * when the mida entry is recognisably ours (this identity, this home — the same rule install
 * and uninstall apply). Absent, foreign and unreadable all answer "not-installed": the named
 * fix is `mida install claude-code`, which adds the entry or refuses a foreign one out loud.
 */
export function claudeCodeMcpStatus(userConfig: string, home: string): "installed" | "not-installed" {
  return isMidaServerEntry(claudeUserMidaEntry(userConfig), "claude-code", home) ? "installed" : "not-installed"
}

/** The folders macOS hides from apps that lack Files and Folders access. */
export const MACOS_PROTECTED_FOLDERS = ["Desktop", "Documents", "Downloads"] as const

const MACOS_APP_NAME: Record<McpClientTool, string> = {
  "claude-desktop": "Claude Desktop",
  "cursor": "Cursor",
}

/**
 * The one warning install prints and doctor repeats (in-15 J-7): when the launcher a client
 * spawns sits inside a folder macOS protects, the app cannot exec it — the Sep 27 live failure,
 * "Operation not permitted" in the client's MCP log, showing as "Server disconnected" — while
 * Terminal-spawned hook clients run fine because Terminal holds the grant. The line names both
 * fixes. Off macOS, or outside the three folders, there is nothing to warn about.
 */
export function macosProtectedFolderNote(
  client: McpClientTool,
  commandPath: string,
  homeDir: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "darwin") return undefined
  // The typed path is not the real one: home may sit behind a symlink and macOS matches case
  //-insensitively, so both sides are resolved (realpath when they exist) and lowercased before the
  // prefix check — a launcher under e.g. ~/documents or a symlinked ~/Desktop still warns (in-16 K-8).
  // homeDir always exists; the leaf names join AFTER resolving so a symlinked home still prefixes.
  // A path that is not on disk yet (the launcher is installed after this check) resolves its
  // longest existing ancestor and keeps the tail — otherwise a symlinked home would compare
  // resolved on one side and raw on the other, and the prefix check would silently never match.
  const canonical = (path: string): string => {
    let probe = path
    const tail: string[] = []
    while (true) {
      try {
        return join(realpathSync.native(probe), ...tail)
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return path
        tail.unshift(basename(probe))
        probe = parent
      }
    }
  }
  const home = canonical(homeDir)
  const protectedDirs = MACOS_PROTECTED_FOLDERS.map((name) => join(home, name).toLowerCase())
  const command = canonical(commandPath).toLowerCase()
  if (!protectedDirs.some((dir) => command === dir || command.startsWith(`${dir}${sep}`))) return undefined
  const app = MACOS_APP_NAME[client]
  return (
    `note: macOS protects ~/Desktop, ~/Documents and ~/Downloads — the ${MCP_SERVER_NAME[client]} launcher ` +
    `is inside one at ${commandPath}, so macOS may block ${app} from running it: grant ${app} access in ` +
    `System Settings → Privacy & Security → Files and Folders, or run Mida outside those folders`
  )
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

/**
 * A refusal whose message is written for the owner — the code names it for `refusalCode`, and
 * the message is the line runInstall prints under `refused: <code>` (in-28b F-2).
 */
export class InstallRefusal extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

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

/** A TOML basic-string value — the two escapes a path can need inside double quotes. */
const tomlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/**
 * The managed block a fresh `mida install codex` writes — the same shape, with absolute
 * commands. With MCP on (the default) it also carries the [mcp_servers.mida] table FIRST,
 * before the hook tables: Codex appends its trust records after the last hooks table in the
 * file, so a table of ours after them could be swept into the foreign tail on a rewrite —
 * nothing ever lands between the open marker and the first hooks table. The server entry is
 * the same launcher the file-config clients get, and carries NO --project: the folder the
 * agent session runs in is the project (mcp.ts defaults it to the process cwd).
 */
export function codexBlock(options: { home?: string; mcp?: boolean } = {}): string {
  const lines = [CODEX_MARKER_OPEN]
  if (options.mcp !== false) {
    if (options.home === undefined) throw new Error("codexBlock needs the Mida home for the MCP table")
    lines.push(
      "[mcp_servers.mida]",
      `command = ${tomlString(mcpLauncherPath())}`,
      `args = ["--as", "codex"]`,
      `env = { MIDA_HOME = ${tomlString(options.home)} }`,
      "",
    )
  }
  lines.push(
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
  )
  return lines.join("\n")
}

/**
 * The exact sentence the owner sees whenever the Codex config was written or changed. Codex
 * fingerprints a hook's command text and skips an untrusted hook silently — and re-asks after
 * every change — so the reminder belongs on every write, and only on a write (R5-6).
 */
export const CODEX_TRUST_SENTENCE =
  "Codex will ignore these hooks until you trust them: open codex, type /hooks, and trust the Mida entries."

/**
 * The table headers Mida's managed block is made of — the `[[hooks.<event>]]` and
 * `[[hooks.<event>.hooks]]` array-of-table headers across every recognised block version.
 * Anything appended after the last hooks table lands inside our markers, before the close
 * marker — Codex's `[hooks.state]` trust records, a `[projects."…"]` table, whatever a tool
 * or a person put there (in-16 K-3). A table whose header is NOT one of ours is foreign
 * content: never part of the block we compare, never deleted — it is carried past the close
 * marker verbatim on a rewrite.
 */
function codexOwnTables(): Set<string> {
  const tables = new Set<string>()
  // every block shape this build writes — hooks+MCP, hooks-only, and the two legacy constants
  for (const block of [codexBlock({ home: "", mcp: true }), codexBlock({ mcp: false }), CODEX_BLOCK, CODEX_BLOCK_V1]) {
    for (const line of block.split("\n")) if (line.startsWith("[")) tables.add(line)
  }
  return tables
}

/**
 * A core block with each variable part replaced by a blank placeholder — the shape compare
 * that recognises OUR block written from a different checkout or for a different Mida home:
 * hook command paths, the MCP launcher's path and the env's MIDA_HOME value all blank. Inside
 * the server table a `command` line is the launcher itself — anything whose basename is not
 * mida-mcp is a hand edit. A command line that does not parse as a Mida hook returns null:
 * a foreign command inside the markers means the block is not ours to rewrite.
 */
function codexBlockShape(text: string): string | null {
  const out: string[] = []
  let inMcpTable = false
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) inMcpTable = line === "[mcp_servers.mida]"
    const command = /^command = "([^"]*)"$/.exec(line)
    if (command !== null) {
      const own = inMcpTable
        ? basename(command[1]!).startsWith("mida-mcp")
        : parseMidaCommand(command[1]!) !== null
      if (!own) return null
      out.push('command = ""')
      continue
    }
    if (inMcpTable && /^env = \{ MIDA_HOME = "(?:[^"\\]|\\.)*" \}$/.test(line)) {
      out.push('env = { MIDA_HOME = "" }')
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

/**
 * The recognised block SHAPES — what a managed block is compared against after its variable
 * parts are blanked. The hooks-only shape is what `--no-mcp` writes; the MCP shape adds the
 * server table. The bare legacy blocks are matched literally before any of these (they carry
 * fixed text, so their own shape equals the hooks shape).
 */
const CODEX_SHAPE_V1 = codexBlockShape(CODEX_BLOCK_V1)
const CODEX_SHAPE_HOOKS = codexBlockShape(codexBlock({ mcp: false }))
const CODEX_SHAPE_MCP = codexBlockShape(codexBlock({ home: "" }))

/** The MIDA_HOME a managed block's server table points at — null when it carries none. */
function codexBlockMcpHome(core: string): string | null {
  if (!core.includes("[mcp_servers.mida]")) return null
  const env = /\nenv = \{ MIDA_HOME = "((?:[^"\\]|\\.)*)" \}/.exec(`\n${core}`)
  if (env === null) return null
  return env[1]!.replace(/\\(["\\])/g, "$1")
}

/** Finds a KNOWN managed block between its markers; "absent" when neither marker is present. */
function locateCodexBlock(text: string):
  | {
      start: number
      end: number
      tailStart: number
      version: "current" | "no-mcp" | "bare" | "v1" | "stale"
      foreignTail: string
      /** The marker-wrapped core, \r-stripped and tail-free — what the block builder writes. */
      core: string
      /** The server table's MIDA_HOME when the block carries one; null for hooks-only blocks. */
      mcpHome: string | null
    }
  | "absent" {
  const hasOpen = text.includes(CODEX_MARKER_OPEN)
  const hasClose = text.includes(CODEX_MARKER_CLOSE)
  if (!hasOpen && !hasClose) return "absent"
  const start = text.indexOf(CODEX_MARKER_OPEN)
  const closeAt = text.indexOf(CODEX_MARKER_CLOSE)
  if (!hasOpen || !hasClose || closeAt < start) throw settingsUnreadable()
  const end = closeAt + CODEX_MARKER_CLOSE.length
  const interior = text.slice(start + CODEX_MARKER_OPEN.length, closeAt)
  // The interior is ours up to the first foreign table header. Whatever line break precedes
  // that header — `\n` or the `\r\n` of a CRLF file — belongs to the tail so it re-lands on a
  // line boundary when moved after the close marker.
  const own = codexOwnTables()
  const lines = interior.split("\n")
  let tailFrom = -1
  let offset = 0
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.startsWith("[") && !own.has(line)) {
      tailFrom = interior[offset - 2] === "\r" ? offset - 2 : offset - 1
      break
    }
    offset += raw.length + 1
  }
  const foreignTail = tailFrom >= 0 ? interior.slice(tailFrom).replace(/[\r\n]+$/, "") : ""
  const coreEnd = tailFrom >= 0 ? tailFrom : interior.length
  const coreInterior = interior
    .slice(0, coreEnd)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .join("\n")
    .replace(/\n+$/, "")
  const core = `${CODEX_MARKER_OPEN}${coreInterior}\n${CODEX_MARKER_CLOSE}`
  const tailStart = start + CODEX_MARKER_OPEN.length + coreEnd
  if (core === CODEX_BLOCK) return { start, end, tailStart, version: "bare", foreignTail, core, mcpHome: null }
  if (core === CODEX_BLOCK_V1) return { start, end, tailStart, version: "v1", foreignTail, core, mcpHome: null }
  // A block we do not byte-match can still be ours: an absolute-path block written from a
  // different checkout (the repo moved, or an older build's dist) has our table shape with
  // different command paths and maybe another home. The shape must match a known block — a
  // foreign command, a foreign server command, or any other line a known block does not
  // carry (a hand-added key like `timeout = 5`) is a human's edit and refuses (in-16 K-3).
  const shape = codexBlockShape(core)
  if (shape === null) throw settingsUnreadable()
  if (shape === CODEX_SHAPE_MCP) {
    const mcpHome = codexBlockMcpHome(core)
    if (mcpHome === null) throw settingsUnreadable()
    // the only free value a well-formed current block carries is the home — rebuilding the
    // canonical block around it is a byte-compare of everything else (this build's commands,
    // this build's launcher)
    const version = core === codexBlock({ home: mcpHome }) ? "current" : "stale"
    return { start, end, tailStart, version, foreignTail, core, mcpHome }
  }
  if (shape === CODEX_SHAPE_HOOKS) {
    const version = core === codexBlock({ mcp: false }) ? "no-mcp" : "stale"
    return { start, end, tailStart, version, foreignTail, core, mcpHome: null }
  }
  if (shape === CODEX_SHAPE_V1) return { start, end, tailStart, version: "stale", foreignTail, core, mcpHome: null }
  throw settingsUnreadable()
}

/**
 * Does the config's own text — everything outside the managed block — already define a
 * `mcp_servers.mida` server? TOML spells one table many ways: `[mcp_servers.mida]` with or
 * without spacing, quoting or a trailing comment; an inline `mida = { … }` or dotted
 * `mida.command = …` line under `[mcp_servers]`; a top-level `mcp_servers.mida.…` key. All of
 * them make the block's own `[mcp_servers.mida]` a duplicate — and a duplicate table voids the
 * whole file — so the check reads spelling, never bytes.
 */
function codexMcpNameTaken(text: string): boolean {
  // the table each key line belongs to: the root until the first header, [mcp_servers] after
  // its own header, anything else is irrelevant — a `mida` key under [other] is not ours
  let where: "root" | "mcp_servers" | "other" = "root"
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (/^\s*\[/.test(line)) {
      if (/^\s*\[\s*\[?\s*["']?mcp_servers["']?\s*\.\s*["']?mida["']?\s*\]/.test(line)) return true
      where = /^\s*\[\s*\[?\s*["']?mcp_servers["']?\s*\]/.test(line) ? "mcp_servers" : "other"
      continue
    }
    if (where === "root" && /^\s*["']?mcp_servers["']?\s*\.\s*["']?mida["']?\s*[=.]/.test(line)) return true
    if (where === "mcp_servers" && /^\s*["']?mida["']?\s*[=.]/.test(line)) return true
  }
  return false
}

/**
 * Appends the managed block to config.toml, one blank line separating it from whatever came
 * before (or nothing, when the file is created). A block that is already exactly right is a
 * byte-identical no-op; an older KNOWN block is upgraded in place — the markers still mean it
 * is ours to rewrite. Markers around anything else refuse settings-unreadable — the block is
 * never silently overwritten.
 *
 * `options.mcp` is the install's `--no-mcp` flag inverted: false writes hooks only — but it
 * never REMOVES a server table that is already ours (only uninstall does that), so a flag-off
 * rerun over an MCP block keeps the table, home and all. A `mcp_servers.mida` definition outside
 * the markers — however TOML spells it — is someone else's server: writing ours alongside would
 * make a duplicate and break the file, so the install refuses before a byte is written, the same
 * "is it ours" rule the JSON clients apply to a foreign "mida" name.
 */
export function installCodex(configPath: string, options: { home: string; mcp?: boolean }): InstallOutcome {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : null
  const block = text === null ? "absent" : locateCodexBlock(text)
  const outside = block === "absent" ? (text ?? "") : `${text!.slice(0, block.start)}${text!.slice(block.tailStart)}`
  if (codexMcpNameTaken(outside)) {
    throw new InstallRefusal(
      "CODEX_MCP_NAME_TAKEN",
      `Codex's config at ${configPath} already defines an MCP server named mida outside Mida's block, so nothing was changed. Rename or remove that server, then run mida install codex again.`,
    )
  }
  const mcpHome = options.mcp !== false ? options.home : block !== "absent" ? block.mcpHome : null
  const target = mcpHome === null ? codexBlock({ mcp: false }) : codexBlock({ home: mcpHome })
  if (block !== "absent") {
    if (block.core === target) return "already-installed"
    // an older managed block is ours to replace in place — same outcome as a fresh append.
    // The foreign tail (Codex's trust records and any other table that landed inside the
    // markers) comes back out immediately AFTER the close marker: still valid TOML, and
    // outside the region the next locate treats as ours to rewrite. The rewritten block
    // keeps the file's own line endings (in-16 K-3).
    const eol = text!.includes("\r\n") ? "\r\n" : "\n"
    const current = eol === "\r\n" ? target.replace(/\n/g, "\r\n") : target
    writeFileAtomic(configPath, `${text!.slice(0, block.start)}${current}${block.foreignTail}${text!.slice(block.end)}`)
    return "installed"
  }
  const eol = (text ?? "").includes("\r\n") ? "\r\n" : "\n"
  const separator = text === null || text === ""
    ? ""
    : text.endsWith(`${eol}${eol}`)
      ? ""
      : text.endsWith("\n")
        ? eol
        : `${eol}${eol}`
  mkdirSync(dirname(configPath), { recursive: true })
  const targetText = eol === "\r\n" ? target.replace(/\n/g, "\r\n") : target
  writeFileAtomic(configPath, `${text ?? ""}${separator}${targetText}${eol}`)
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
    // a hooks-only block carries the same current commands — the missing server table is a
    // MCP-status concern, not a hook concern
    return block.version === "current" || block.version === "no-mcp" ? "installed" : "outdated"
  } catch {
    return "unreadable"
  }
}

/**
 * Doctor's read-only view of the server table: "installed" only when the block carries THIS
 * build's entry at THIS home (a stale-path block or another home's table still needs a
 * reinstall to become ours). "not-installed" covers a hooks-only block and a server table we
 * recognise but do not own byte-for-byte; "absent" and "unreadable" mean the same as the hooks
 * status — there is no block, or the block refuses to be read as ours.
 */
export function codexMcpStatus(configPath: string, home: string): "installed" | "not-installed" | "absent" | "unreadable" {
  try {
    if (!existsSync(configPath)) return "absent"
    const block = locateCodexBlock(readFileSync(configPath, "utf8"))
    if (block === "absent") return "absent"
    if (block.mcpHome === null) return "not-installed"
    return block.version === "current" && block.mcpHome === home ? "installed" : "not-installed"
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
    for (const match of text.slice(block.start, block.tailStart).matchAll(/command = "([^"]*)"/g)) {
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
  // the line ending that ends the close-marker line belongs to the block — one or two bytes
  const after = text.startsWith("\r\n", block.end)
    ? text.slice(block.end + 2)
    : text[block.end] === "\n"
      ? text.slice(block.end + 1)
      : text.slice(block.end)
  // install added one blank line when the file ended in a lone newline — the common case.
  // Two or more blank lines before the block could not have come from install: they stay.
  const restored = before.endsWith("\r\n\r\n") && !before.endsWith("\r\n\r\n\r\n")
    ? before.slice(0, -2)
    : before.endsWith("\n\n") && !before.endsWith("\n\n\n")
      ? before.slice(0, -1)
      : before
  // Codex's trust records — and any other foreign table that landed inside the markers — are
  // not ours to delete: they stay where the block stood, valid TOML, keeping the file's own
  // line ending between them and what follows (in-16 K-3).
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  writeFileAtomic(configPath, `${restored}${block.foreignTail === "" ? "" : `${block.foreignTail}${eol}`}${after}`)
  return "uninstalled"
}
