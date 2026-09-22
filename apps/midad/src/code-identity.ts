import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Which code this process is running. `codeRoot` is the realpath of the folder four levels above
 * this file — the repository root in development, the installed package root in an npm build.
 * `codeCommit` is that folder's git HEAD, or "unknown" when git cannot answer (not a worktree, no
 * git, a timed-out call). The pair is what /health reports and what a `mida` command compares
 * against, so a command never talks to a service running other code.
 */
export interface CodeIdentity {
  codeRoot: string
  codeCommit: string
}

// four levels up: src/code-identity.ts -> src -> apps/midad -> apps -> the repository root
const CODE_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."))

const commitAt = (root: string): string => {
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim()
    return head === "" ? "unknown" : head
  } catch {
    return "unknown"
  }
}

let cached: CodeIdentity | undefined

/**
 * The identity is asked of git once per process and then cached — a /health answer and a command's
 * self-check must be the same record for the process's whole life. `root` asks "as if the code ran
 * from this folder" and is never cached; callers (tests) use it to stand outside the worktree.
 */
export function codeIdentity(root?: string): CodeIdentity {
  if (root !== undefined) {
    const resolved = realpathSync(root)
    return { codeRoot: resolved, codeCommit: commitAt(resolved) }
  }
  cached ??= { codeRoot: CODE_ROOT, codeCommit: commitAt(CODE_ROOT) }
  return cached
}
