import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { MidaHome } from "./home.js"

/**
 * Where Codex keeps its config and session rollouts: `CODEX_HOME` when it is a non-empty absolute
 * path, else `~/.codex`. A relative or empty value falls back to the default rather than trusting
 * a folder that would resolve differently in every process that reads it.
 */
export function resolveCodexHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.CODEX_HOME
  return configured !== undefined && configured !== "" && isAbsolute(configured) ? configured : join(homeDir, ".codex")
}

/**
 * `mida install codex` records the Codex home it wrote into as one line in the Mida home —
 * `codex-home`, readable by the user only, written through a temp file and rename so a crash
 * never leaves a half line. The hook and the drain run in processes that never see Codex's own
 * environment, so this record is how a custom CODEX_HOME becomes a trusted transcript root.
 */
export function recordCodexHome(home: MidaHome, dir: string): void {
  const full = home.path("codex-home")
  const temp = `${full}.${process.pid}.tmp`
  rmSync(temp, { force: true }) // a leftover from a crashed write is never valid content
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, `${dir}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, full)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  const dirFd = openSync(home.root, "r")
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/**
 * The recorded Codex home, or `undefined` when there is none. Only an absolute path is a usable
 * root — a missing, unreadable or junk file simply means no custom home is trusted, never an
 * error that would widen or block the default rule.
 */
export function recordedCodexHome(home: MidaHome): string | undefined {
  try {
    const full = home.path("codex-home")
    if (!existsSync(full)) return undefined
    const line = readFileSync(full, "utf8").trim()
    return isAbsolute(line) ? line : undefined
  } catch {
    return undefined
  }
}
