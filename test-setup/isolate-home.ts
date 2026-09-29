/**
 * The test wall (in-28b). Registered as a vitest `setupFiles` entry in the root config, it
 * runs before any test code in every test file — per file evaluation, so each file gets its
 * own fresh folder even when a worker runs several.
 *
 * Two things it guarantees:
 *
 * 1. No test touches the real home. HOME/USERPROFILE and every per-tool home variable the
 *    agent CLIs or Mida read point at a fresh mkdtemp folder — overwriting whatever the
 *    shell outside happened to export. `os.homedir()` answers the temp folder; only
 *    `os.userInfo().homedir` still names the account's real one, which is how
 *    isolation.test.ts proves the wall.
 *
 * 2. No test runs a real `claude`, `codex` or `devin`. Three stub scripts sit at the front
 *    of PATH: they print "blocked in tests: real <name> must never run" and exit 97 — a
 *    deliberate non-ENOENT, so a code path that forgot to inject its spawner fails the test
 *    loudly instead of editing the owner's real ~/.claude.json or ~/.codex/config.toml
 *    (the in-28 incident).
 *
 * What must still reach the real machine is named below and only there: the foundry
 * toolchain the chain tests deploy with, and a git identity so temp repos can commit.
 * The wall is never loosened to fix a failing test — the env belongs here.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { delimiter, join } from "node:path"

const fakeHome = mkdtempSync(join(tmpdir(), "mida-test-home-"))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

// Per-tool homes, each a real-looking subfolder of the fake home. Values are overwritten,
// not respected — an inherited CODEX_HOME pointing at the owner's real Codex folder is
// exactly the leak this wall exists to stop.
const subfolders: Record<string, string> = {
  CODEX_HOME: ".codex",
  CLAUDE_CONFIG_DIR: ".claude",
  XDG_CONFIG_HOME: ".config",
  MIDA_HOME: ".mida",
}
for (const [name, dir] of Object.entries(subfolders)) {
  const path = join(fakeHome, dir)
  mkdirSync(path, { recursive: true })
  process.env[name] = path
}

const stubBin = join(fakeHome, "bin")
mkdirSync(stubBin, { recursive: true })
for (const name of ["claude", "codex", "devin"]) {
  writeFileSync(
    join(stubBin, name),
    `#!/bin/sh\necho "blocked in tests: real ${name} must never run" >&2\nexit 97\n`,
    { mode: 0o755 },
  )
}
process.env.PATH = `${stubBin}${delimiter}${process.env.PATH ?? ""}`

// Tests that build git repos in temp folders need an identity; the real global and system
// git configs stay unread so nothing else leaks in either direction.
process.env.GIT_AUTHOR_NAME = "Mida Test"
process.env.GIT_AUTHOR_EMAIL = "test@example.invalid"
process.env.GIT_COMMITTER_NAME = "Mida Test"
process.env.GIT_COMMITTER_EMAIL = "test@example.invalid"
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"

// `packages/chain` resolves anvil/forge as `${homedir()}/.foundry/bin` unless FOUNDRY_BIN is
// set — under the wall that points into the temp folder and the binaries vanish. The env
// override exists for exactly this; the real path is taken from the account record
// (userInfo ignores $HOME), so no other code path is handed the real home.
if (process.env.FOUNDRY_BIN === undefined) {
  const foundryBin = join(userInfo().homedir, ".foundry", "bin")
  if (existsSync(join(foundryBin, "anvil"))) process.env.FOUNDRY_BIN = foundryBin
}
