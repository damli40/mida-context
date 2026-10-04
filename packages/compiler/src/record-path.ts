import { posix, win32 } from "node:path"

/**
 * A path as a saved record may show it: relative under the project folder, "~" under the user's
 * home, otherwise unchanged, so the local folder layout does not leak. Windows compares without
 * case and treats / and \ alike; the original spelling of the kept part is returned.
 */
export function recordPath(path: string, cwd: string | undefined, homeDir: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === "win32"
  const fold = (s: string): string => (windows ? s.replace(/\//g, "\\").toLowerCase() : s)
  const sep = windows ? "\\" : "/"
  const p = fold(path)
  if (cwd && p.startsWith(fold(cwd) + sep)) return path.slice(cwd.length + 1)
  const absolute = windows ? win32.isAbsolute(path) : posix.isAbsolute(path)
  if (absolute && homeDir.length > 1 && (p === fold(homeDir) || p.startsWith(fold(homeDir) + sep))) return "~" + path.slice(homeDir.length)
  return path
}
