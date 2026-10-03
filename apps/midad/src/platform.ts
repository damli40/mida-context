import { closeSync, fsyncSync, openSync } from "node:fs"
import { randomBytes } from "node:crypto"

/** True on native Windows. Every Windows-only branch asks this; tests pass "win32" to take it on a Mac. */
export const isWindows = (platform: NodeJS.Platform = process.platform): boolean => platform === "win32"

/**
 * Forces a folder's entry list to disk after a rename. Windows refuses to open a folder for
 * fsync (EPERM: the Oct 2 probe's `mida init` failure); there the rename is the durability
 * step the file system offers, so this does nothing.
 */
export function fsyncFolder(folder: string, platform: NodeJS.Platform = process.platform): void {
  if (isWindows(platform)) return
  const fd = openSync(folder, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** A fresh pipe address for one service start. Unguessable, so no other account can create it first. */
export function newPipeName(): string {
  return `\\\\.\\pipe\\mida-${randomBytes(16).toString("hex")}`
}
