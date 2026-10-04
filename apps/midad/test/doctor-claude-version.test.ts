// UF-014B: the REAL `claude --version` probe (no injected claudeVersion), driven through a fake
// `claude.exe` on an injected PATH with platform win32. On this Mac resolveBinary(win32) looks
// for claude.com/.exe/.bat/.cmd in PATH folders and cross-spawn runs the file directly, so a
// shebang script named claude.exe stands in for the binary. The real claude never runs.
import { afterAll, describe, expect, it } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, installClaudeCode, runDoctor } from "@mida/midad"

const dirs: string[] = []
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mida-doctor-claude-version-"))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A PATH folder holding an executable script of the given name that runs the shell body. */
const fakeBin = (name: string, body: string): string => {
  const bin = join(dir(), "bin")
  mkdirSync(bin)
  const file = join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return bin
}

/** A PATH folder holding a fake claude.exe that runs the given shell body. */
const fakeClaude = (body: string): string => fakeBin("claude.exe", body)

const doctorLines = async (pathValue: string, opts: { cwd?: string; platform?: NodeJS.Platform } = {}): Promise<string[]> => {
  const settings = join(dir(), "settings.json")
  installClaudeCode(settings)
  const lines: string[] = []
  await runDoctor({
    home: new MidaHome(join(dir(), "home")),
    print: (line) => lines.push(line),
    env: { PATH: pathValue },
    platform: opts.platform ?? "win32",
    daemonProbeMs: 50,
    settings: { "claude-code": settings },
    claudeUserConfig: join(dir(), "no-user-config.json"),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  })
  return lines
}

const versionLine = (lines: string[]) => lines.find((line) => line.includes("skips the hooks"))

describe("the real claude --version probe (UF-014B)", () => {
  it("parses the real output shape '2.1.138 (Claude Code)' with CRLF", async () => {
    const lines = await doctorLines(fakeClaude(`printf '2.1.138 (Claude Code)\\r\\n'`))
    expect(versionLine(lines)).toBe(
      "PROBLEM: Claude Code 2.1.138 skips the hooks Mida writes on Windows (they need 2.1.139 or later) — update Claude Code, then run `mida doctor` again",
    )
  })

  it("a pre-release 2.1.140-beta.1 reads as 2.1.140: no line", async () => {
    const lines = await doctorLines(fakeClaude(`echo '2.1.140-beta.1 (Claude Code)'`))
    expect(versionLine(lines)).toBeUndefined()
  })

  it("leading text before the version still parses", async () => {
    const lines = await doctorLines(fakeClaude(`echo 'Claude Code v2.1.100'`))
    expect(versionLine(lines)?.includes("Claude Code 2.1.100 skips")).toBe(true)
  })

  it("a version printed on stderr only is still read", async () => {
    const lines = await doctorLines(fakeClaude(`echo '2.1.1 (Claude Code)' 1>&2`))
    expect(versionLine(lines)?.includes("Claude Code 2.1.1 skips")).toBe(true)
  })

  it("a Node deprecation warning on stderr does not outrank the version on stdout", async () => {
    const lines = await doctorLines(fakeClaude(`echo '(node:1) Warning: Node.js 18.0.0 is deprecated' 1>&2; echo '2.1.138 (Claude Code)'`))
    expect(versionLine(lines)?.includes("Claude Code 2.1.138 skips")).toBe(true)
  })

  it("a claude that hangs with a grandchild holding stdout returns inside the 5 s cap (shim shape)", async () => {
    // `sleep 30` is a grandchild (not exec'd), the shape of a .cmd shim whose node.exe outlives
    // the killed cmd.exe — spawnSync must not wait for the inherited pipe to close
    const started = Date.now()
    const lines = await doctorLines(fakeClaude(`/bin/sleep 30; echo '2.1.0 (Claude Code)'`))
    const elapsed = Date.now() - started
    expect(versionLine(lines)).toBeUndefined()
    expect(elapsed).toBeLessThan(9_000)
  }, 60_000)

  it("a claude.exe planted in the current folder, not on PATH, never runs", async () => {
    const marker = join(dir(), "marker")
    const cwd = fakeClaude(`echo '1.0.0 (Claude Code)'; echo ran > "${marker}"`)
    const emptyPath = join(dir(), "empty")
    mkdirSync(emptyPath)
    const lines = await doctorLines(emptyPath, { cwd })
    expect(versionLine(lines)).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
  })

  it("a claude that exits non-zero with no version earns no line", async () => {
    const lines = await doctorLines(fakeClaude(`echo 'error: cannot start' 1>&2; exit 1`))
    expect(versionLine(lines)).toBeUndefined()
  })

  it("darwin runs no probe at all: a resolvable claude still never runs", async () => {
    const marker = join(dir(), "marker")
    const bin = fakeBin("claude", `echo ran > "${marker}"; echo '1.0.0 (Claude Code)'`)
    const lines = await doctorLines(bin, { platform: "darwin" })
    expect(versionLine(lines)).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
  })
})
