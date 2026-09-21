import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"

/**
 * The data tree holds ciphertext, reader wraps and auth state — it is user-only: every directory
 * is mode 0700 and every file 0600, the same rules the midad home follows. `secureDir` makes a
 * folder (and every ancestor down to `root`) exist at 0700, `writeJsonAtomic` is the home's
 * writeSecretJson shape (temp file opened "wx" 0600, fsynced, renamed over the target, parent
 * fsynced), and `repairModes` re-pins an existing tree at startup so a folder made before these
 * rules — or chmodded by hand — is corrected rather than trusted.
 */
export function secureDir(root: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let folder = dir
  while (folder.length > root.length && folder.startsWith(root)) {
    chmodSync(folder, 0o700)
    folder = dirname(folder)
  }
  if (folder === root) chmodSync(root, 0o700)
}

export function writeJsonAtomic(root: string, path: string, value: unknown): void {
  secureDir(root, dirname(path))
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, JSON.stringify(value, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Creates `root` at 0700 if absent, then walks the whole tree pinning dirs to 0700 and files to 0600. */
export function repairModes(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        chmodSync(full, 0o700)
        visit(full)
      } else {
        chmodSync(full, 0o600)
      }
    }
  }
  visit(root)
}
