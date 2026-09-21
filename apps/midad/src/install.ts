import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

/**
 * The hook command text is exact and carries nothing else — no path, no `node`, no version, no
 * environment variable, no trailing space. Codex fingerprints the command text and silently drops
 * a hook whose text changed (spike); the same discipline is kept for Claude Code. Install,
 * uninstall and doctor all compare against these constants.
 */
export const HOOK_COMMAND = {
  "claude-code": "mida-hook claude-code",
  "codex": "mida-hook codex",
} as const
export const INJECT_COMMAND = {
  "claude-code": "mida-inject claude-code",
  "codex": "mida-inject codex",
} as const

export type InstallTool = keyof typeof HOOK_COMMAND

/** Claude Code events: the inject command on session start and on every prompt, the capture hook on the five save events. */
const EVENT_COMMANDS: Readonly<Record<string, string>> = {
  SessionStart: INJECT_COMMAND["claude-code"],
  UserPromptSubmit: INJECT_COMMAND["claude-code"],
  PostToolUse: HOOK_COMMAND["claude-code"],
  Stop: HOOK_COMMAND["claude-code"],
  StopFailure: HOOK_COMMAND["claude-code"],
  PreCompact: HOOK_COMMAND["claude-code"],
  SessionEnd: HOOK_COMMAND["claude-code"],
}
const CLAUDE_EVENTS: readonly string[] = Object.keys(EVENT_COMMANDS)

export type InstallOutcome = "installed" | "already-installed"
export type UninstallOutcome = "uninstalled" | "not-installed"

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

/** Same-folder temp file, then rename — a crash never leaves a half-written settings file. */
function writeFileAtomic(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    writeFileSync(temp, text)
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Reads and validates the settings file. Missing is not an error — it means "create it". Invalid
 * JSON, a non-object top level, a `hooks` that is not an object, or an event key that is not an
 * array all refuse: the user's file is never "repaired" by writing over it.
 */
function readSettings(settingsPath: string): { text: string; settings: Record<string, unknown> } | "absent" {
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
  for (const event of CLAUDE_EVENTS) {
    if (event in hooks && !Array.isArray(hooks[event])) throw settingsUnreadable()
  }
  return { text, settings: parsed }
}

/**
 * Adds Mida's hook entries to Claude Code's settings.json, one new element appended per event;
 * existing elements are never edited, reordered or removed. Idempotent by exact command string —
 * with all six present it prints-and-does nothing ("already installed"). The first change ever
 * leaves `settings.json.mida-backup` holding the pre-install bytes; a later install never
 * overwrites an existing backup.
 */
export function installClaudeCode(settingsPath: string): InstallOutcome {
  const read = readSettings(settingsPath)
  if (read === "absent") {
    const hooks: Record<string, unknown> = {}
    for (const event of CLAUDE_EVENTS) hooks[event] = [hookElement(EVENT_COMMANDS[event]!)]
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileAtomic(settingsPath, `${JSON.stringify({ hooks }, null, 2)}\n`)
    return "installed"
  }
  const { text, settings } = read
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  const missing = CLAUDE_EVENTS.filter(
    (event) => !((hooks[event] ?? []) as unknown[]).some((el) => eventHasCommand(el, EVENT_COMMANDS[event]!)),
  )
  if (missing.length === 0) return "already-installed"
  const backupPath = `${settingsPath}.mida-backup`
  if (!existsSync(backupPath)) writeFileAtomic(backupPath, text)
  if (!isPlainObject(settings.hooks)) settings.hooks = {}
  const target = settings.hooks as Record<string, unknown>
  for (const event of missing) {
    if (!Array.isArray(target[event])) target[event] = []
    ;(target[event] as unknown[]).push(hookElement(EVENT_COMMANDS[event]!))
  }
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, detectIndent(text))}\n`)
  return "installed"
}

/**
 * Doctor's read-only view: "installed" only when all six events carry the exact command; an
 * unreadable file is reported, never repaired. "incomplete" covers a missing hooks key and a
 * partial install alike — the fix is `mida install claude-code` either way.
 */
export function claudeHooksStatus(settingsPath: string): "installed" | "incomplete" | "absent" | "unreadable" {
  try {
    const read = readSettings(settingsPath)
    if (read === "absent") return "absent"
    const hooks = (read.settings.hooks ?? {}) as Record<string, unknown>
    const present = CLAUDE_EVENTS.filter((event) =>
      ((hooks[event] ?? []) as unknown[]).some((element) => eventHasCommand(element, EVENT_COMMANDS[event]!)),
    )
    return present.length === CLAUDE_EVENTS.length ? "installed" : "incomplete"
  } catch {
    return "unreadable"
  }
}

const isMidaCommand = (command: unknown): boolean =>
  command === HOOK_COMMAND["claude-code"] || command === INJECT_COMMAND["claude-code"]

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
  const read = readSettings(settingsPath)
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

/** Every managed-block shape this build recognises as its own — anything else between the markers is a human's edit. */
const CODEX_KNOWN_BLOCKS: Readonly<Record<string, "current" | "v1">> = {
  [CODEX_BLOCK]: "current",
  [CODEX_BLOCK_V1]: "v1",
}

/** The exact sentence the owner sees after `mida install codex` — Codex asks once. */
export const CODEX_TRUST_SENTENCE =
  "Codex must be told to trust these hooks once: open Codex in this folder and approve them. Then run `mida doctor`."

/** Finds a KNOWN managed block between its markers; "absent" when neither marker is present. */
function locateCodexBlock(text: string): { start: number; end: number; version: "current" | "v1" } | "absent" {
  const hasOpen = text.includes(CODEX_MARKER_OPEN)
  const hasClose = text.includes(CODEX_MARKER_CLOSE)
  if (!hasOpen && !hasClose) return "absent"
  const start = text.indexOf(CODEX_MARKER_OPEN)
  const closeAt = text.indexOf(CODEX_MARKER_CLOSE)
  if (!hasOpen || !hasClose || closeAt < start) throw settingsUnreadable()
  const end = closeAt + CODEX_MARKER_CLOSE.length
  const version = CODEX_KNOWN_BLOCKS[text.slice(start, end)]
  // markers around anything that is not a known managed block mean a human touched it
  if (version === undefined) throw settingsUnreadable()
  return { start, end, version }
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
      writeFileAtomic(configPath, `${text.slice(0, block.start)}${CODEX_BLOCK}${text.slice(block.end)}`)
      return "installed"
    }
  }
  const separator = text === null || text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileAtomic(configPath, `${text ?? ""}${separator}${CODEX_BLOCK}\n`)
  return "installed"
}

/**
 * Doctor's read-only view: "installed" only for the current managed block, "outdated" for an
 * older one install can still upgrade. "unreadable" means the markers wrap edited content —
 * `mida install codex` would refuse the file too.
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
