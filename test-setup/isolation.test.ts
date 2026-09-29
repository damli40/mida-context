import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { homedir, tmpdir, userInfo } from "node:os"
import { sep } from "node:path"

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
})
