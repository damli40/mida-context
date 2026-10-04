import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Which code this process is running. `codeRoot` is the realpath of the folder four levels above
 * this file — the repository root in development, the installed package root in an npm build.
 * `codeCommit` is that folder's git HEAD — but only when the folder is itself the top of a git
 * work tree: an install sitting inside a parent checkout (Homebrew's /opt/homebrew) must not
 * wear that unrelated repository's commit. `codeVersion` is the version field of the
 * package.json one level above the folder holding this file — the installed package's own
 * version, which changes on every `npm update` even when the folder and the commit do not.
 * The triple is what /health reports and what a `mida` command compares against, so a command
 * never talks to a service running other code.
 */
export interface CodeIdentity {
  codeRoot: string
  codeCommit: string
  codeVersion: string
}

// four levels up: src/code-identity.ts -> src -> apps/midad -> apps -> the repository root
const CODE_ROOT = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."))
const MODULE_FILE = fileURLToPath(import.meta.url)

/**
 * The version of the package this module file belongs to: the `version` field of the
 * package.json in the folder ONE level above the folder the file sits in (`src/` in
 * development -> `apps/midad/package.json`; the dist folder in the published build -> the
 * installed package's own package.json). "unknown" when it cannot be read.
 */
export function codeVersionFor(moduleFile: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dirname(dirname(moduleFile)), "package.json"), "utf8"))
    const version = (parsed as { version?: unknown } | null)?.version
    return typeof version === "string" && version !== "" ? version : "unknown"
  } catch {
    return "unknown"
  }
}

/** A test injects one to script git's answers; the default shells out to real git. */
export type GitRunner = (args: string[]) => string

const runGit: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true }).trim()

const commitAt = (root: string, git: GitRunner): string => {
  try {
    // HEAD counts only when this folder is the worktree's own top — a deeper folder's HEAD is
    // the parent checkout's commit, which says nothing about which package is installed here
    const top = git(["-C", root, "rev-parse", "--show-toplevel"])
    if (top === "" || realpathSync.native(top) !== root) return "unknown"
    const head = git(["-C", root, "rev-parse", "HEAD"])
    return head === "" ? "unknown" : head
  } catch {
    return "unknown"
  }
}

let cached: CodeIdentity | undefined

/**
 * The identity is asked of git and package.json once per process and then cached — a /health
 * answer and a command's self-check must be the same record for the process's whole life.
 * `root` asks "as if the code ran from this folder" and is never cached; callers (tests) use it
 * to stand outside the worktree, and may inject a `git` runner in place of a real worktree.
 */
export function codeIdentity(root?: string, git: GitRunner = runGit): CodeIdentity {
  if (root !== undefined) {
    const resolved = realpathSync.native(root)
    return { codeRoot: resolved, codeCommit: commitAt(resolved, git), codeVersion: codeVersionFor(MODULE_FILE) }
  }
  cached ??= { codeRoot: CODE_ROOT, codeCommit: commitAt(CODE_ROOT, git), codeVersion: codeVersionFor(MODULE_FILE) }
  return cached
}
