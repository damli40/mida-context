import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { randomBytes } from "node:crypto"

/** One folder that holds everything Mida keeps on this machine. Secrets in it are readable by the user only. */
export class MidaHome {
  readonly root: string

  constructor(root: string = join(homedir(), ".mida")) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  path(relativePath: string): string {
    const full = resolve(this.root, relativePath)
    const back = relative(this.root, full)
    if (back.startsWith("..") || back === "") throw new Error(`path escapes the Mida home: ${relativePath}`)
    return full
  }

  has(relativePath: string): boolean {
    return existsSync(this.path(relativePath))
  }

  /** undefined only when the file is absent. A file that exists but will not parse throws: never treat corrupt as missing. */
  readJson<T>(relativePath: string): T | undefined {
    const full = this.path(relativePath)
    if (!existsSync(full)) return undefined
    return JSON.parse(readFileSync(full, "utf8")) as T
  }

  writeSecretJson(relativePath: string, value: unknown): void {
    const full = this.path(relativePath)
    let folder = dirname(full)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    while (folder.length > this.root.length) {
      chmodSync(folder, 0o700)
      folder = dirname(folder)
    }
    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" })
    renameSync(temp, full)
  }

  list(relativePath: string): string[] {
    const full = this.path(relativePath)
    return existsSync(full) ? readdirSync(full) : []
  }
}
