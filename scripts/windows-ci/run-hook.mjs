// Usage: node run-hook.mjs claude-code|codex <projectDir>
// claude-code: reads %USERPROFILE%\.claude\settings.json and runs the SessionStart entry's command
// with its args and no shell (Claude Code's exec form). codex: reads the SessionStart command line
// from %USERPROFILE%\.codex\config.toml and runs it the way Codex does: cmd.exe /C "<line>".
// Prints the hook's stdout; exits with the hook's exit code.
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const [agent, project] = process.argv.slice(2)
const payload = JSON.stringify({ session_id: `ci-${agent}-${Date.now()}`, cwd: project, hook_event_name: "SessionStart", source: "startup" })
let result
if (agent === "claude-code") {
  const settings = JSON.parse(readFileSync(join(process.env.USERPROFILE, ".claude", "settings.json"), "utf8"))
  const hook = settings.hooks.SessionStart[0].hooks[0]
  result = spawnSync(hook.command, hook.args ?? [], { input: payload, encoding: "utf8", cwd: project })
} else {
  const toml = readFileSync(join(process.env.USERPROFILE, ".codex", "config.toml"), "utf8")
  const start = toml.indexOf("[[hooks.SessionStart.hooks]]")
  const match = /^command = "((?:[^"\\]|\\.)*)"$/m.exec(toml.slice(start))
  const line = match[1].replace(/\\(["\\])/g, "$1")
  result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/C", `"${line}"`], {
    input: payload,
    encoding: "utf8",
    cwd: project,
    windowsVerbatimArguments: true,
  })
}
process.stdout.write(result.stdout ?? "")
process.stderr.write(result.stderr ?? "")
process.exit(result.status ?? 1)
