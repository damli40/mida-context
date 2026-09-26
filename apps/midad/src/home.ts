import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { randomBytes } from "node:crypto"

/**
 * The one way every entry point finds the home folder (R4-7). `MIDA_HOME` unset means the
 * default `~/.mida`; set, it must be an absolute path — an empty string or a relative path
 * would resolve against a different working directory in the CLI, the daemon and the hooks,
 * which is exactly how `init` and the daemon once disagreed about where the home was. A bad
 * value is refused with a plain message, never silently pointed somewhere else.
 *
 * `mustExist` is for entry points that must never CREATE the home: the MCP adapter refuses a
 * mistyped MIDA_HOME rather than let the constructor mkdir/chmod the wrong folder first —
 * and a folder that exists but is no Mida home (init's network.json is missing) is refused
 * too, mode untouched, since chmod would be the wrong folder's first mutation.
 */
export function resolveHome(
  env: { MIDA_HOME?: string | undefined } = process.env,
  options: { mustExist?: boolean } = {},
): MidaHome {
  const root = env.MIDA_HOME
  if (root === undefined) {
    if (options.mustExist === true) assertHomeExists(join(homedir(), ".mida"))
    return new MidaHome()
  }
  if (root === "" || !isAbsolute(root)) {
    throw new Error("MIDA_HOME must be an absolute path (or unset for the default ~/.mida)")
  }
  if (options.mustExist === true) assertHomeExists(root)
  return new MidaHome(root)
}

/** The stat check mustExist needs — before any mkdir/chmod the constructor would run. */
function assertHomeExists(root: string): void {
  let stat
  try {
    stat = statSync(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`the Mida home ${root} does not exist — run \`mida init\` first`)
    }
    throw new Error(`the Mida home ${root} could not be read (${code ?? "unknown error"})`)
  }
  if (!stat.isDirectory()) throw new Error(`the Mida home ${root} is not a folder`)
  // init writes network.json; a folder without it is not a Mida home the adapter may adopt
  if (!existsSync(join(root, "network.json"))) {
    throw new Error(`the folder ${root} is not a Mida home — it has no network.json; check MIDA_HOME or run \`mida init\` first`)
  }
}

/** One folder that holds everything Mida keeps on this machine. Secrets in it are readable by the user only. */
export class MidaHome {
  readonly root: string

  constructor(root: string = join(homedir(), ".mida")) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
  }

  path(relativePath: string): string {
    // Reject tricky input before resolving: a ".." segment, an empty segment ("a//b", "a/"), a NUL
    // byte, or an absolute path are all invalid inside the home even when resolve() would land back in it.
    if (
      isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      relativePath.split("/").some((segment) => segment === "" || segment === "..")
    ) {
      throw new Error(`bad path inside the Mida home: ${relativePath}`)
    }
    const full = resolve(this.root, relativePath)
    const back = relative(this.root, full)
    if (back.startsWith("..") || back === "") throw new Error(`path escapes the Mida home: ${relativePath}`)
    // resolve() does not follow links, so walk to the deepest ancestor that exists and compare real paths:
    // a symlink inside the home pointing out must not smuggle a write or a read with it.
    let ancestor = full
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    const fromRealRoot = relative(realpathSync.native(this.root), realpathSync.native(ancestor))
    if (fromRealRoot === ".." || fromRealRoot.startsWith(`..${sep}`) || isAbsolute(fromRealRoot)) {
      throw new Error(`path escapes the Mida home: ${relativePath}`)
    }
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
    const parent = this.#prepareParent(full)
    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`
    try {
      const fd = openSync(temp, "wx", 0o600)
      try {
        writeSync(fd, JSON.stringify(value, null, 2))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, full)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    this.#fsyncFolder(parent)
  }

  /**
   * Creates the file only when it does not exist: the content goes to a durable temp file, then a hard-link
   * is attempted — the operating system fails the link with EEXIST when the target is taken, so two racing
   * creators cannot both win. Returns true when this call created the file.
   */
  createSecretJsonExclusive(relativePath: string, value: unknown): boolean {
    const full = this.path(relativePath)
    const parent = this.#prepareParent(full)
    const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`
    try {
      const fd = openSync(temp, "wx", 0o600)
      try {
        writeSync(fd, JSON.stringify(value, null, 2))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      try {
        linkSync(temp, full)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
        throw error
      }
    } finally {
      rmSync(temp, { force: true })
    }
    this.#fsyncFolder(parent)
    return true
  }

  /** Removes a file inside the home. A missing file is not an error; the same escape rules apply as for reads. */
  remove(relativePath: string): void {
    const full = this.path(relativePath)
    if (!existsSync(full)) return
    rmSync(full)
    this.#fsyncFolder(dirname(full))
  }

  list(relativePath: string): string[] {
    const full = this.path(relativePath)
    return existsSync(full) ? readdirSync(full) : []
  }

  /** Creates the file's parent folder chain as 0700 and returns the parent path for the durability fsync. */
  #prepareParent(full: string): string {
    const parent = dirname(full)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    let folder = parent
    while (folder.length > this.root.length) {
      chmodSync(folder, 0o700)
      folder = dirname(folder)
    }
    return parent
  }

  #fsyncFolder(folder: string): void {
    const fd = openSync(folder, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
