// Usage: node mcp-hello.mjs <path to claude_desktop_config.json>
// Starts mida-claude-desktop's command + args + env from the config and sends one MCP initialize.
// Passes when a JSON-RPC reply with result.serverInfo arrives within 20 seconds.
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"

const config = JSON.parse(readFileSync(process.argv[2], "utf8"))
const entry = config.mcpServers["mida-claude-desktop"]
const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ["pipe", "pipe", "inherit"] })
const timer = setTimeout(() => {
  console.error("no initialize reply within 20 s")
  child.kill()
  process.exit(1)
}, 20_000)
let buffer = ""
child.stdout.setEncoding("utf8")
child.stdout.on("data", (text) => {
  buffer += text
  for (const line of buffer.split("\n")) {
    try {
      const message = JSON.parse(line)
      if (message.id === 1 && message.result?.serverInfo) {
        console.log(`initialize ok: ${JSON.stringify(message.result.serverInfo)}`)
        clearTimeout(timer)
        child.kill()
        process.exit(0)
      }
    } catch {
      // an incomplete line: wait for more
    }
  }
})
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "windows-ci", version: "0" } } })}\n`,
)
