import { describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir, userInfo } from "node:os"
import { join, sep } from "node:path"
import { removeTestRoot } from "./isolate-home.js"

/**
 * Pins the wall itself (in-28b): the isolate-home setup file rewired HOME and the per-tool
 * envs into a fresh temp folder and put refusing stubs named claude/codex/devin at the front
 * of PATH. If the wall ever stops running — a config rename, an unregistered setup file —
 * every one of these fails.
 */
describe("the test wall (in-28b)", () => {
  it("the home is a fresh temp folder, not the account's real one", () => {
    const home = homedir()
    expect(home.startsWith(`${tmpdir()}${sep}`)).toBe(true)
    // userInfo reads the account record, not $HOME — the one comparison that can prove
    // the folder really is a stand-in
    expect(home).not.toBe(userInfo().homedir)
    expect(process.env.HOME).toBe(home)
  })

  it("the per-tool home envs live inside the fake home", () => {
    const home = homedir()
    for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "MIDA_HOME"]) {
      const value = process.env[name]
      expect(value, name).toBeDefined()
      expect(value!.startsWith(`${home}${sep}`), `${name}=${value}`).toBe(true)
    }
  })

  it.each(["claude", "codex", "devin"])("a spawned `%s --version` hits the stub and exits 97", (name) => {
    const result = spawnSync(name, ["--version"], { encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(97)
    expect(result.stderr).toContain(`blocked in tests: real ${name} must never run`)
  })

  it("points os.tmpdir() at the file's own short root — every test temp folder lands inside it (in-40 L-6)", () => {
    // The wall makes one /tmp/mida-t-* root per file and points TMPDIR/TMP/TEMP inside it before
    // test code runs, so a suite that mkdtemps under os.tmpdir() and forgets the folder is still
    // cleaned when the file ends — the Sep 29 32-GB pile of orphaned mida-* folders cannot recur.
    expect(process.env.TMPDIR).toBe(tmpdir())
    expect(process.env.TMP).toBe(tmpdir())
    expect(process.env.TEMP).toBe(tmpdir())
    expect(tmpdir()).toMatch(/^\/tmp\/mida-t-/)
    // the root stays short so the unix socket paths tests build under it clear the 104-byte
    // macOS limit — a daemon socket under a home dir under this root sits at roughly half of it
    const socketPath = join(tmpdir(), "mida-e2e-XXXXXX", "midad.sock")
    expect(socketPath.length).toBeLessThan(104)
  })

  it("the wall's cleanup removes a root whole — nested folders and a socket file go with it (in-40 L-6)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mida-nested-"))
    const deep = join(root, "a", "b")
    mkdirSync(deep, { recursive: true })
    // a real unix socket file, not a stand-in — daemon tests leave these under the root
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(join(deep, "midad.sock"), () => resolve())
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    removeTestRoot(root)
    expect(existsSync(root)).toBe(false)
  })

  it("a cleanup that cannot remove its root reports to stderr instead of failing the file (in-40 L-6)", () => {
    // A leftover temp folder is housekeeping, not a test result: the injected remover throws the
    // way rmSync does on a stuck filesystem, and the cleanup must absorb it into one stderr line.
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    try {
      expect(() =>
        removeTestRoot(join(tmpdir(), "mida-stuck-"), () => {
          throw new Error("EBUSY: resource busy")
        }),
      ).not.toThrow()
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("mida-stuck-"))
    } finally {
      spy.mockRestore()
    }
  })
})
