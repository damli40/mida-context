import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname } from "node:path"

/**
 * Forces a folder's entry list to disk after a rename. Windows refuses to open a folder for
 * fsync (EPERM: the Oct 2 probe's `mida init` failure); there the rename or link is the
 * durability step the file system offers, so this does nothing. The platform is a parameter
 * so a test can take the Windows branch on a Mac.
 */
export function fsyncFolder(folder: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return
  const fd = openSync(folder, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** An atomic secret-file write: durable temp file, rename into place, folder fsync. */
export function writeSecretJson(file: string, value: unknown, platform: NodeJS.Platform = process.platform): void {
  const parent = dirname(file)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, JSON.stringify(value, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  fsyncFolder(parent, platform)
}
