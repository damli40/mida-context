import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MidaHome, MCP_TOOLS, createMidaMcpServer, parseMcpArgs, readSeen, socketPathFor } from "@mida/midad"
import type { McpServerDeps } from "@mida/midad"

const BIN_MIDA_MCP = fileURLToPath(new URL("../../../bin/mida-mcp", import.meta.url))
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url))

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-mcp-")))
const projectDir = () => mkdtempSync(join(tmpdir(), "mida-mcp-project-"))

/**
 * A socket server the test controls, same shape as inject.test.ts's fake — plus routing per path
 * and a record of what the adapter sent. A route value is the JSON body to answer, a function of
 * the parsed request body, or `{ silent: true }` for a daemon that accepts but never answers.
 */
type Route = Record<string, unknown> | { silent: true } | ((body: Record<string, unknown> | undefined) => unknown)

const fakeDaemon = (dir: MidaHome, routes: Record<string, Route>) =>
  new Promise<{ requests: { path: string; body: Record<string, unknown> | undefined }[]; stop(): Promise<void> }>((res, rej) => {
    const requests: { path: string; body: Record<string, unknown> | undefined }[] = []
    const sockets = new Set<Socket>()
    const s = createServer((socket: Socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {})
      socket.on("data", (data) => {
        const head = data.toString("utf8")
        const path = head.split(" ")[1] ?? ""
        const rawBody = head.slice(head.indexOf("\r\n\r\n") + 4)
        let body: Record<string, unknown> | undefined
        try {
          body = rawBody === "" ? undefined : (JSON.parse(rawBody) as Record<string, unknown>)
        } catch {
          body = undefined
        }
        requests.push({ path, body })
        const route = routes[path]
        if (route === undefined || (typeof route === "object" && route !== null && "silent" in route)) return
        const answer = typeof route === "function" ? route(body) : route
        const payload = JSON.stringify(answer)
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`)
      })
    })
    s.once("error", rej)
    s.listen(socketPathFor(dir), () =>
      res({
        requests,
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            s.close(() => done())
          }),
      }),
    )
  })

const HEALTH = { ok: true, pid: 4242, startedAt: "2026-09-22T10:00:00.000Z", queueDepth: 0 }

/** A connected (client, server) pair over the SDK's in-memory transport. */
const connect = async (deps: McpServerDeps) => {
  const server = createMidaMcpServer(deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "mcp-test", version: "0" })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

const callText = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const res = await client.callTool({ name, arguments: args })
  const content = res.content as { type: string; text?: string }[]
  expect(content).toHaveLength(1)
  expect(content[0]!.type).toBe("text")
  return content[0]!.text!
}

const deps = (dir: MidaHome, over: Partial<McpServerDeps> = {}): McpServerDeps => ({
  home: dir,
  agent: "assistant",
  project: projectDir(),
  sessionId: "mcp-assistant-test1",
  daemonUp: true,
  ...over,
})

const DEGRADED = "Mida: could not load context (daemon-down) — working without it"

describe("mida-mcp args", () => {
  it("defaults to assistant and the process cwd", () => {
    const parsed = parseMcpArgs([])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.args.agent).toBe("assistant")
      expect(parsed.args.project).toBe(process.cwd())
    }
  })

  it("accepts --as and --project in either order; --project resolves to an absolute path", () => {
    const parsed = parseMcpArgs(["--project", ".", "--as", "codex"])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.args.agent).toBe("codex")
      expect(parsed.args.project).toBe(process.cwd())
    }
    expect(parseMcpArgs(["--as", "claude-code"])).toMatchObject({ ok: true, args: { agent: "claude-code" } })
  })

  it("refuses an unknown agent, an unknown flag, a missing value and a positional", () => {
    for (const argv of [["--as", "bogus"], ["--verbose"], ["-x"], ["--as"], ["--project"], ["positional"], ["--as", "codex", "--extra", "y"]]) {
      const parsed = parseMcpArgs(argv)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).not.toBe("")
    }
  })

  it("the real launcher refuses a bad flag on stderr with exit 2 and keeps stdout clean", async () => {
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      // bin/mida-mcp pins the tsx loader absolutely, so a client may launch it from any cwd —
      // /tmp stands in for wherever an MCP host happens to run it from
      const child = spawn(BIN_MIDA_MCP, ["--bogus"], {
        env: { ...process.env, MIDA_HOME: home().root },
        cwd: "/tmp",
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8")
      })
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8")
      })
      child.on("error", reject)
      child.on("exit", (code) => done({ status: code, stdout, stderr }))
    })
    expect(res.status).toBe(2)
    expect(res.stdout).toBe("")
    expect(res.stderr).toContain("usage: mida-mcp")
  }, 20_000)

  it("the real entry starts and stays alive on stdio even with no daemon to reach", async () => {
    // a home with no network.json can never have a daemon — the server must still come up
    const res = await new Promise<{ status: number | null; stderr: string }>((done, reject) => {
      const child = spawn(BIN_MIDA_MCP, ["--as", "codex"], {
        env: { ...process.env, MIDA_HOME: home().root },
        cwd: "/tmp",
      })
      let stderr = ""
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8")
      })
      child.on("error", reject)
      child.on("exit", (code) => done({ status: code, stderr }))
      // the MCP host holds stdin open for the server's life; closing it is the polite shutdown
      child.stdin.end()
    })
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("")
  }, 20_000)
})

describe("mida-mcp tools against a fake daemon", () => {
  it("lists exactly the four stable tools, with the pinned input schemas", async () => {
    const { client, close } = await connect(deps(home(), { daemonUp: false }))
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).toEqual(["mida_handoff", "mida_whats_new", "mida_read", "mida_status"])
      expect(listed.tools.map((t) => t.inputSchema)).toEqual(MCP_TOOLS.map((t) => t.inputSchema))
      const read = listed.tools.find((t) => t.name === "mida_read")!
      expect(read.inputSchema).toEqual({
        type: "object",
        properties: {
          namespace: {
            type: "string",
            enum: ["projects.current", "profile.skills", "preferences.communication"],
            description: "The context area to read; default projects.current.",
          },
        },
        additionalProperties: false,
      })
    } finally {
      await close()
    }
  })

  it("mida_handoff sends the hook's body and returns the daemon's text verbatim", async () => {
    const dir = home()
    const project = projectDir()
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": { kind: "handoff", text: "CTX-BODY", checkpoints: 2, facts: 1, seen: ["0xcovered-1", "0xcovered-2"] },
    })
    try {
      const { client, close } = await connect(deps(dir, { agent: "codex", project }))
      try {
        expect(await callText(client, "mida_handoff")).toBe("CTX-BODY")
      } finally {
        await close()
      }
      const sent = fake.requests.filter((r) => r.path === "/handoff")
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body).toEqual({ agent: "codex", cwd: project, sessionId: "mcp-assistant-test1" })
      // the covered ids seeded the session's seen set, like the hook's writeSeen
      expect(readSeen(dir, "mcp-assistant-test1")).toEqual(new Set(["0xcovered-1", "0xcovered-2"]))
    } finally {
      await fake.stop()
    }
  })

  it("mida_handoff says plainly when the agent is not approved — the hook's line, and no seen baseline", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, {
      "/handoff": {
        kind: "refused",
        reason: "not-approved",
        text: "Mida: codex is not approved for this project — run `mida approve codex` in this folder.",
      },
    })
    try {
      const { client, close } = await connect(deps(dir, { agent: "codex" }))
      try {
        const text = await callText(client, "mida_handoff")
        expect(text).toBe("Mida: codex is not approved for this project — run `mida approve codex` in this folder.")
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new returns the note, records the seen ids, and a delivered note is not repeated", async () => {
    const dir = home()
    // the fake behaves like the daemon: ids already in the session's seen set are not offered again
    const fake = await fakeDaemon(dir, {
      "/whatsnew": (body) =>
        readSeen(dir, typeof body?.sessionId === "string" ? body.sessionId : undefined).has("0xnew-ctx")
          ? { kind: "none" }
          : { kind: "updates", note: "Mida update since you last checked:\n- codex: did the thing", updates: [{ agent: "codex", savedAt: "2026-09-22T10:01:00Z" }], seen: ["0xnew-ctx"] },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const first = await callText(client, "mida_whats_new")
        expect(first).toContain("did the thing")
        expect(readSeen(dir, "mcp-assistant-test1")).toEqual(new Set(["0xnew-ctx"]))
        const second = await callText(client, "mida_whats_new")
        expect(second).toBe("Mida: nothing new from other agents since this session started.")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new surfaces a refusal plainly and writes nothing", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "revoked" } })
    try {
      const { client, close } = await connect(deps(dir, { agent: "codex" }))
      try {
        expect(await callText(client, "mida_whats_new")).toBe("Mida: codex's access was revoked by the owner. Nothing was shared.")
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_read sends ['read','--as',agent,namespace] with the server's own cwd and prints the CLI's lines", async () => {
    const dir = home()
    const project = projectDir()
    const fake = await fakeDaemon(dir, {
      "/cli": { code: 0, lines: ["What you have told Mida about yourself", "  profile.skills: typescript"] },
    })
    try {
      const { client, close } = await connect(deps(dir, { agent: "codex", project }))
      try {
        const text = await callText(client, "mida_read", { namespace: "profile.skills" })
        expect(text).toBe("What you have told Mida about yourself\n  profile.skills: typescript")
      } finally {
        await close()
      }
      const sent = fake.requests.filter((r) => r.path === "/cli")
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body).toEqual({ argv: ["read", "--as", "codex", "profile.skills"], cwd: project })
    } finally {
      await fake.stop()
    }
  })

  it("mida_read defaults to projects.current and refuses a namespace outside the three", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/cli": { code: 0, lines: ["projects.current: read 2 object(s)"] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_read")).toBe("projects.current: read 2 object(s)")
        expect(fake.requests.at(-1)!.body).toMatchObject({ argv: ["read", "--as", "assistant", "projects.current"] })
        expect(await callText(client, "mida_read", { namespace: "nope" })).toBe(
          "refused: namespace must be one of projects.current, profile.skills, preferences.communication",
        )
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("mida_status prints health plus one line per agent's verdict — no hex, no home path", async () => {
    const dir = home()
    const secret = `0x${"ab".repeat(32)}` // a 64-hex the daemon's answer carries — it must never surface
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": (body) => {
        const agent = body?.agent
        if (agent === "claude-code") return { kind: "handoff", text: `context ${secret} ${dir.root}/agents/`, checkpoints: 1 }
        if (agent === "codex") return { kind: "refused", reason: "not-approved", text: "Mida: codex is not approved for this project" }
        return { kind: "refused", reason: "revoked", text: "Mida: revoked" }
      },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_status")
        expect(text).toContain("midad: answering — pid 4242")
        expect(text).toContain("claude-code: approved for this folder")
        expect(text).toContain("codex: not approved for this folder")
        expect(text).toContain("assistant: access revoked by the owner")
        expect(text).not.toMatch(/[0-9a-f]{64}/)
        expect(text).not.toContain(secret)
        // no path under the home — only the socket directory's own name may appear
        expect(text).not.toContain(dir.root)
        expect(text).toContain("socket in")
      } finally {
        await close()
      }
      // three /handoff probes — one per provisioned agent, none carrying a session
      const probes = fake.requests.filter((r) => r.path === "/handoff")
      expect(probes.map((r) => r.body?.agent)).toEqual(["claude-code", "codex", "assistant"])
      expect(probes.every((r) => r.body?.sessionId === undefined)).toBe(true)
    } finally {
      await fake.stop()
    }
  })

  it("mida_status says so when the folder is not a Mida project at all", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": { kind: "refused", reason: "not-a-project", text: "x" },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_status")
        expect(text).toContain("this folder is not a Mida project")
        expect(text).not.toContain("approved for this folder")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("every tool answers the degraded line when the daemon could not start — no stack, no protocol error", async () => {
    const { client, close } = await connect(deps(home(), { daemonUp: false }))
    try {
      for (const name of ["mida_handoff", "mida_whats_new", "mida_read", "mida_status"]) {
        const text = await callText(client, name)
        expect(text).toBe(DEGRADED)
        expect(text).not.toMatch(/^\s+at\s/m)
        expect(text).not.toContain("node:internal")
      }
    } finally {
      await close()
    }
  })

  it("a daemon that stops answering mid-run still gets the degraded line, not a stack", async () => {
    const dir = home()
    // daemonUp was true at start — the socket then died (no listener at all)
    const { client, close } = await connect(deps(dir))
    try {
      expect(await callText(client, "mida_handoff")).toBe(DEGRADED)
      expect(await callText(client, "mida_status")).toBe(DEGRADED)
      expect(await callText(client, "mida_read")).toBe(DEGRADED)
      const text = await callText(client, "mida_whats_new")
      expect(text).toBe(DEGRADED)
      // the give-up is logged the way the prompt hook logs it, so doctor can count it
      const log = readFileSync(dir.path("logs/hook.jsonl"), "utf8")
      expect(log).toContain("whatsnew-timeout")
    } finally {
      await close()
    }
  })

  it("a malformed daemon answer is a bad-reply degraded line, never a stack", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff" }, "/cli": { lines: "nope" } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_handoff")).toBe("Mida: could not load context (bad-reply) — working without it")
        expect(await callText(client, "mida_read")).toBe("Mida: could not load context (bad-reply) — working without it")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("an 8 001-char answer is cut to 8 000 with the same … marker the hooks use", async () => {
    const dir = home()
    const big = "x".repeat(8_001)
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: big, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_handoff")
        expect(text.length).toBe(8_000)
        expect(text).toBe(`${"x".repeat(7_999)}…`)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("an unknown tool name is a protocol error, and no write or owner tool exists to call", async () => {
    const { client, close } = await connect(deps(home(), { daemonUp: false }))
    try {
      const listed = await client.listTools()
      for (const name of ["save", "remember", "approve", "revoke", "mida_save", "mida_approve"]) {
        expect(listed.tools.some((t) => t.name === name)).toBe(false)
      }
      await expect(client.callTool({ name: "mida_save", arguments: {} })).rejects.toThrow()
    } finally {
      await close()
    }
  })

  it("the adapter only ever sends `read` argv to /cli — owner commands stay the daemon's refusal", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/cli": { code: 2, lines: ["This changes who has access, so it only runs in your own terminal: mida approve"] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        for (const ns of ["projects.current", "profile.skills", "preferences.communication"]) {
          await callText(client, "mida_read", { namespace: ns })
        }
        const sent = fake.requests.filter((r) => r.path === "/cli")
        expect(sent).toHaveLength(3)
        expect(sent.every((r) => Array.isArray(r.body?.argv) && (r.body.argv as string[])[0] === "read")).toBe(true)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })
})

describe("mida-mcp import graph", () => {
  /**
   * The entry's whole transitive import set, walked from source (the same graph esbuild bundles).
   * The adapter is a socket client only: it must never reach a module that loads keys or can
   * sign — keys.ts, skeleton.ts, runtime.ts and everything that depends on them.
   */
  const FORBIDDEN =
    /(^|\/)(keys|skeleton|runtime|cli|remember|projects|drain|drain-main|daemon|daemon-main|doctor|install|testnet|api-server|request-store|checkpoint-payload|hook-main|inject-main|whatsnew|handoff)\.ts$|owner-link/

  const reachableFrom = (entry: string): Set<string> => {
    const found = new Set<string>()
    const stack = [resolve(SRC_DIR, entry)]
    while (stack.length > 0) {
      const file = stack.pop()!
      if (found.has(file)) continue
      found.add(file)
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        let target = resolve(dirname(file), match[1]!)
        if (target.endsWith(".js")) target = `${target.slice(0, -3)}.ts`
        if (existsSync(target)) stack.push(target)
      }
    }
    return found
  }

  it("mcp-main.ts reaches no module that holds keys or can sign", () => {
    const graph = reachableFrom("mcp-main.ts")
    // sanity: the walk really walked — the leaf modules the adapter is allowed to use are there
    for (const expected of ["mcp.ts", "control.ts", "home.ts", "hook-output.ts", "seen.ts", "queue.ts", "log.ts", "hook.ts", "sibling.ts"]) {
      expect([...graph].some((f) => f.endsWith(`/${expected}`))).toBe(true)
    }
    const leaked = [...graph].filter((f) => FORBIDDEN.test(f))
    expect(leaked).toEqual([])
  })

  it("no file in the entry's graph calls a signing function or imports a signing library", () => {
    const graph = reachableFrom("mcp-main.ts")
    // call sites, not mentions — queue.ts has a comment naming loadAgentIdentity to say it must
    // never reach it, and that comment is exactly what this test enforces
    const signingCall = /(privateKey|signMessage|signTypedData|loadOrCreateOwnerSecrets|loadAgentIdentity|loadGrants)\s*\(/
    const signingImport = /from\s+["'](viem|ethers|@noble\/curves|@noble\/secp256k1|@mida\/checkpoint|@mida\/owner)/
    for (const file of graph) {
      const text = readFileSync(file, "utf8")
      expect(signingCall.test(text), `${file} calls a signing primitive`).toBe(false)
      expect(signingImport.test(text), `${file} imports a signing library`).toBe(false)
    }
  })
})
