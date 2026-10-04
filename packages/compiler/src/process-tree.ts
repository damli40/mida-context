import { spawnSync } from "node:child_process"

/**
 * Kill a spawned child and everything it started. On POSIX a `detached` child is its own
 * process-group leader, so the negative pid signals the whole tree; a throw propagates so the
 * caller can fall back to killing the direct child. Windows has no process groups:
 * `taskkill /T` walks the tree instead, and a failed taskkill throws for the same fallback.
 * Injectable for tests.
 */
export function killProcessTree(
  pid: number,
  opts: {
    platform?: NodeJS.Platform
    kill?: (pid: number, signal: NodeJS.Signals) => void
    spawnSync?: typeof spawnSync
  } = {},
): void {
  const platform = opts.platform ?? process.platform
  if (platform === "win32") {
    const run = opts.spawnSync ?? spawnSync
    // The full path: a PATH that lacks System32 must not lose the tree kill. A non-zero exit
    // throws so the caller's direct-child fallback runs; 128 means the pid was already gone,
    // which is the outcome wanted. The five-second timeout keeps a wedged taskkill from hanging
    // the caller — the same fallback then runs.
    const root = process.env.SystemRoot ?? "C:\\Windows"
    const result = run(`${root}\\System32\\taskkill.exe`, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0 && result.status !== 128) throw new Error(`taskkill exited ${result.status}`)
    return
  }
  const kill = opts.kill ?? ((p, s) => process.kill(p, s))
  kill(-pid, "SIGKILL")
}
