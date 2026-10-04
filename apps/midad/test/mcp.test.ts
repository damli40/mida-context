import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { AGENT_NAME, MidaHome, MCP_TOOLS, READ_NAMESPACES, createMidaMcpServer, foreignClientReplayReason, loadAgentIdentity, parseMcpArgs, readSeen, socketPathFor, startupCheck } from "@mida/midad"
import type { McpServerDeps } from "@mida/midad"
import { OVERSIZE_NOTE_LEAD, renderHandoffReport } from "@mida/checkpoint"
import type { MergedHandoff } from "@mida/checkpoint"
import { OVERSIZE_NOTE_LEAD as LEAF_OVERSIZE_NOTE_LEAD } from "../src/hook-output.js"
import { queuedSavesNote } from "../src/handoff.js"

const BIN_MIDA_MCP = fileURLToPath(new URL("../../../bin/mida-mcp", import.meta.url))
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url))

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const tsxLoader = join(repo, "node_modules/tsx/dist/loader.mjs")
const mcpMainPath = join(repo, "apps/midad/src/mcp-main.ts")

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-mcp-")))
const projectDir = () => mkdtempSync(join(tmpdir(), "mida-mcp-project-"))

/**
 * The environment a spawned mida-mcp entry sees. DEVIN_PROJECT_DIR is removed: when these
 * tests run under Devin they inherit it, and the foreign-client guard would then refuse every
 * non-devin --as for a reason the test never stated — the variable reaches a child only when
 * the test names it.
 */
const spawnEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  if (extra.DEVIN_PROJECT_DIR === undefined) delete env.DEVIN_PROJECT_DIR
  return env
}

/**
 * A socket server the test controls, same shape as inject.test.ts's fake — plus routing per path
 * and a record of what the adapter sent. A route value is the JSON body to answer, a function of
 * the parsed request body, or `{ silent: true }` for a daemon that accepts but never answers.
 */
type Route =
  | Record<string, unknown>
  | { silent: true }
  // `raw` answers 200 with a body that is not JSON; `hangup` drops the connection unanswered
  | { raw: string }
  | { hangup: true }
  | ((body: Record<string, unknown> | undefined) => unknown)

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
        if (typeof route === "object" && route !== null && "hangup" in route) {
          socket.destroy()
          return
        }
        const payload = typeof route === "object" && route !== null && "raw" in route && typeof route.raw === "string"
          ? route.raw
          : JSON.stringify(typeof route === "function" ? route(body) : route)
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`)
      })
    })
    s.once("error", rej)
    s.listen(socketPathFor(dir)!, () =>
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
const DEGRADED_SLOW = "Mida: could not load context (daemon-slow) — working without it"

describe("mida-mcp args", () => {
  it("no --as parses with the agent unset — the startup gate, not the parser, refuses it", () => {
    const parsed = parseMcpArgs([])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.args.agent).toBeUndefined()
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

  it("accepts any registered-agent-shaped name for --as", () => {
    const r = parseMcpArgs(["--as", "chatgpt", "--project", "/tmp/p"])
    expect(r).toEqual({ ok: true, args: { agent: "chatgpt", project: "/tmp/p", projectGiven: true } })
  })

  it("refuses names outside the agent-name rule", () => {
    for (const bad of ["../owner", "Assistant", "a/b", "a b", ".", "..", "x".repeat(65), "codex\n"]) {
      const r = parseMcpArgs(["--as", bad])
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^bad agent name/)
    }
  })

  it("refuses --as or --project given twice, even with the same value", () => {
    expect(parseMcpArgs(["--as", "assistant", "--as", "codex"])).toEqual({ ok: false, error: "--as given twice" })
    expect(parseMcpArgs(["--as", "assistant", "--as", "assistant"])).toEqual({ ok: false, error: "--as given twice" })
    expect(parseMcpArgs(["--project", "/a", "--project", "/b"])).toEqual({ ok: false, error: "--project given twice" })
  })

  it("refuses the --flag=value form rather than guessing", () => {
    expect(parseMcpArgs(["--as=codex"])).toEqual({ ok: false, error: "unknown flag: --as=codex" })
  })

  it("marks whether --project was given", () => {
    const r = parseMcpArgs([])
    expect(r.ok && r.args.projectGiven).toBe(false)
    expect(r.ok && r.args.agent).toBeUndefined()
    const given = parseMcpArgs(["--as", "cursor", "--project", "/tmp/p"])
    expect(given.ok && given.args.projectGiven).toBe(true)
  })

  it("uses the same name rule as the key store", () => {
    for (const name of ["assistant", "claude-code", "codex", "chatgpt", "a-1"]) expect(AGENT_NAME.test(name)).toBe(true)
    for (const name of ["A", "a_b", "a.b", ""]) expect(AGENT_NAME.test(name)).toBe(false)
  })

  it("the three agent-name gates agree: 64 chars pass, 65 refuse (F9)", () => {
    // the MCP flag rule (mcp.ts AGENT_NAME)
    expect(AGENT_NAME.test("a".repeat(64))).toBe(true)
    expect(AGENT_NAME.test("a".repeat(65))).toBe(false)
    // the key store's rule (keys.ts NAME) — exercised through loadAgentIdentity
    expect(() => loadAgentIdentity(home(), "a".repeat(65))).toThrow("bad agent name")
    expect(loadAgentIdentity(home(), "a".repeat(64))).toBeUndefined() // a valid name that is simply absent
    // the read --as rule (cli.ts READ_AS_NAME) is covered in cli.test.ts's read suite
  })

  it("refuses an unknown flag, a missing value and a positional", () => {
    // a well-formed but unregistered name ("bogus") now parses — the startup check refuses it
    for (const argv of [["--verbose"], ["-x"], ["--as"], ["--project"], ["positional"], ["--as", "codex", "--extra", "y"]]) {
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
        env: spawnEnv({ MIDA_HOME: home().root }),
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
    // the marker makes this a real home, but the empty network.json means no usable daemon —
    // the spawned midad dies on it and the server must still come up. it only gets that far
    // when the startup gate passes: a registered identity and a marked project
    const dir = home()
    dir.writeSecretJson("network.json", {})
    mkdirSync(join(dir.root, "agents", "codex"), { recursive: true })
    writeFileSync(join(dir.root, "agents", "codex", "identity.json"), "{}")
    const project = projectDir()
    mkdirSync(join(project, ".mida"))
    writeFileSync(join(project, ".mida", "project.json"), JSON.stringify({ projectId: "p1" }))
    const res = await new Promise<{ status: number | null; stderr: string }>((done, reject) => {
      const child = spawn(BIN_MIDA_MCP, ["--as", "codex", "--project", project], {
        env: spawnEnv({ MIDA_HOME: dir.root }),
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

  it("MIDA_INNER=1 — inside Mida's own summariser run the entry exits 0 and writes nothing, before it even parses args", async () => {
    // even a flag that would otherwise exit 2 is not looked at: the guard comes first
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(BIN_MIDA_MCP, ["--bogus"], {
        env: spawnEnv({ MIDA_HOME: home().root, MIDA_INNER: "1" }),
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
      child.stdin.end()
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe("")
    expect(res.stderr).toBe("")
  }, 20_000)
})

describe("mida-mcp startup gate", () => {
  // a real home so the spawned entry reaches the gate — the marker check (G11) refuses a
  // folder that exists but has no network.json before startupCheck is even consulted
  const makeHome = () => {
    const dir = new MidaHome(mkdtempSync(join(tmpdir(), "mida-gate-")))
    dir.writeSecretJson("network.json", {})
    return dir
  }
  const makeProject = () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-proj-"))
    mkdirSync(join(dir, ".mida"))
    writeFileSync(join(dir, ".mida", "project.json"), JSON.stringify({ projectId: "p1" }))
    return dir
  }
  const register = (home: MidaHome, agent: string) => {
    mkdirSync(join(home.root, "agents", agent), { recursive: true })
    writeFileSync(join(home.root, "agents", agent, "identity.json"), "{}")
  }

  it("refuses a launch with no --as at all, listing the identities this home knows (I2)", () => {
    const home = makeHome()
    register(home, "codex")
    register(home, "claude-desktop")
    const r = startupCheck(home, { agent: undefined, project: makeProject(), projectGiven: true })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain("--as")
      expect(r.error).toContain("claude-desktop")
      expect(r.error).toContain("codex")
      expect(r.error).toContain("mida install")
    }
  })

  it("an empty home still answers the missing --as — 'none yet', never a silent default", () => {
    const r = startupCheck(makeHome(), { agent: undefined, project: makeProject(), projectGiven: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("none yet")
  })

  it("refuses --as assistant even when the identity is registered — it can never hold a project approval (I2)", () => {
    const home = makeHome()
    register(home, "assistant")
    const r = startupCheck(home, { agent: "assistant", project: makeProject(), projectGiven: true })
    expect(r).toEqual({
      ok: false,
      error: "assistant is a general assistant and cannot read project context — run: mida install <client>",
    })
  })

  it("refuses an agent with no identity in this home, naming the home", () => {
    const home = makeHome()
    const r = startupCheck(home, { agent: "chatgpt", project: makeProject(), projectGiven: true })
    expect(r).toEqual({ ok: false, error: `no agent "chatgpt" is set up in the Mida home ${home.root} — check MIDA_HOME in this client's config` })
  })

  it("refuses a launch folder that is not a Mida project when --project was not given", () => {
    const home = makeHome()
    register(home, "codex")
    const r = startupCheck(home, { agent: "codex", project: "/", projectGiven: false })
    expect(r).toEqual({ ok: false, error: "/ is not a Mida project folder — start the server with --project <your project folder>" })
  })

  it("refuses an explicit --project that is not a Mida project either", () => {
    const home = makeHome()
    register(home, "codex")
    const dir = mkdtempSync(join(tmpdir(), "mida-noproj-"))
    const r = startupCheck(home, { agent: "codex", project: dir, projectGiven: true })
    expect(r).toEqual({ ok: false, error: `${dir} is not a Mida project folder — start the server with --project <your project folder>` })
  })

  it("a marker file that carries no projectId is refused like a missing marker (F9)", () => {
    // .mida/project.json exists but holds no project id — findProjectMarker returns
    // { projectId: null } for it, and a null id must not slip past the gate
    const home = makeHome()
    register(home, "codex")
    const dir = mkdtempSync(join(tmpdir(), "mida-nullid-"))
    mkdirSync(join(dir, ".mida"))
    writeFileSync(join(dir, ".mida", "project.json"), "{}")
    const r = startupCheck(home, { agent: "codex", project: dir, projectGiven: true })
    expect(r).toEqual({ ok: false, error: `${dir} is not a Mida project folder — start the server with --project <your project folder>` })
  })

  it("passes a registered client identity in a marked project", () => {
    const home = makeHome()
    register(home, "claude-desktop")
    expect(startupCheck(home, { agent: "claude-desktop", project: makeProject(), projectGiven: true })).toEqual({ ok: true, agent: "claude-desktop" })
  })

  it("never reads the identity file (existence only)", () => {
    const home = makeHome()
    register(home, "codex")
    chmodSync(join(home.root, "agents", "codex", "identity.json"), 0o000)
    expect(startupCheck(home, { agent: "codex", project: makeProject(), projectGiven: true })).toEqual({ ok: true, agent: "codex" })
  })

  // root ignores permission bits, so on a root run nothing can be "blocked" — the probe always sees the file
  it.skipIf(process.getuid?.() === 0)("a project folder the system refuses is the blocked line, not 'not a project'", () => {
    const home = makeHome()
    register(home, "codex")
    const parent = mkdtempSync(join(tmpdir(), "mida-blocked-"))
    const project = join(parent, "proj")
    mkdirSync(project)
    chmodSync(parent, 0o000)
    try {
      const r = startupCheck(home, { agent: "codex", project, projectGiven: true })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(`${project} could not be read (the system refused access). If it is under Desktop, Documents or Downloads, macOS blocks desktop apps from it — move Mida or the project out of those folders.`)
    } finally {
      chmodSync(parent, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)("an identity folder the system refuses is the blocked line, not 'no agent'", () => {
    const home = makeHome()
    register(home, "codex")
    const agentDir = join(home.root, "agents", "codex")
    chmodSync(agentDir, 0o000)
    try {
      const r = startupCheck(home, { agent: "codex", project: makeProject(), projectGiven: true })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(`${join(agentDir, "identity.json")} could not be read (the system refused access). If it is under Desktop, Documents or Downloads, macOS blocks desktop apps from it — move Mida or the project out of those folders.`)
    } finally {
      chmodSync(agentDir, 0o700)
    }
  })

  it("the real entry refuses a launch with no --as, naming the identities in this home (I2)", async () => {
    const home = makeHome()
    register(home, "codex")
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain("--as")
    expect(stderr).toContain("codex")
    expect(stderr).toContain("mida install")
    // the prefix is the entry's own — the message must not repeat it (G14)
    expect(stderr.match(/mida-mcp/g)).toHaveLength(1)
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })

  it("the real entry refuses --as assistant with the install-a-client line — never 'approve assistant' (I2)", async () => {
    const home = makeHome()
    register(home, "assistant") // registered, so 'no agent' cannot be the reason — the purpose is
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "assistant", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain("assistant is a general assistant and cannot read project context — run: mida install <client>")
    expect(stderr).not.toContain("approve")
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })

  it("refuses before spawning a daemon: the real entry exits 2, stdout empty, no socket", async () => {
    const home = makeHome() // empty home: no identity
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "nobody", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain(`no agent "nobody" is set up in the Mida home ${home.root}`)
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })

  // Devin imports other clients' MCP config and launches them under its own environment —
  // DEVIN_PROJECT_DIR is set on every process it spawns. A mida-mcp for cursor or
  // claude-desktop running there is a replay, not that client's session: it must exit before
  // the home is resolved or the daemon is touched, so nothing reads or saves under the wrong
  // identity (in-10 R-12). Same guard as the hook and inject entries (in-7 D1).
  it("under DEVIN_PROJECT_DIR the real entry refuses --as cursor: one stderr line, exit 2, no socket", async () => {
    const home = makeHome()
    register(home, "cursor") // registered and the project marked — the guard is the only refusal
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "cursor", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root, DEVIN_PROJECT_DIR: makeProject() }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.end() // if the guard missed, the live server would hold the process open
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr.trim().split("\n")).toHaveLength(1)
    expect(stderr).toContain("DEVIN_PROJECT_DIR")
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })

  it("under DEVIN_PROJECT_DIR the real entry refuses --as claude-desktop the same way", async () => {
    const home = makeHome()
    register(home, "claude-desktop")
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "claude-desktop", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root, DEVIN_PROJECT_DIR: makeProject() }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.end()
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr.trim().split("\n")).toHaveLength(1)
    expect(stderr).toContain("DEVIN_PROJECT_DIR")
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })

  // Devin imports Claude Code's user-scope MCP list too (Sep 26 live probe), so an installed
  // claude-code entry IS replayed inside Devin. That one stays off but does not error — an
  // MCP host shows a non-zero exit as a broken server, and Devin's import is expected traffic.
  it("under DEVIN_PROJECT_DIR the claude-code entry stays off quietly: its exact line, exit 0, no socket", async () => {
    const home = makeHome()
    register(home, "claude-code") // registered and the project marked — the guard is the only refusal
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "claude-code", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root, DEVIN_PROJECT_DIR: makeProject() }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.end() // if the guard missed, the live server would hold the process open
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      "mida-mcp: this is Claude Code's Mida server running inside Devin, so it stays off. Devin uses its own Mida server.\n",
    )
    expect(existsSync(join(home.root, "midad.sock"))).toBe(false)
  })

  it("under DEVIN_PROJECT_DIR --as devin passes the guard — the startup gate still decides", async () => {
    const home = makeHome() // devin is NOT registered: the refusal must come from the gate, not the guard
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "devin", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: home.root, DEVIN_PROJECT_DIR: makeProject() }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain(`no agent "devin" is set up in the Mida home ${home.root}`)
    expect(stderr).not.toContain("DEVIN_PROJECT_DIR")
  })

  it("a MIDA_HOME that does not exist is refused before a folder is created there (F6)", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "mida-nohome-")), "home")
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "codex", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: missing }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain(missing)
    expect(existsSync(missing)).toBe(false)
  }, 20_000)

  it("a MIDA_HOME that is a file is refused too — nothing is created or chmodded (F6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-homefile-"))
    const file = join(dir, "home")
    writeFileSync(file, "x")
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "codex", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: file }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stderr).toContain("is not a folder")
  }, 20_000)

  it("an existing folder that is not a Mida home is refused — no network.json, mode untouched (G11)", async () => {
    // mkdtemp lands 0700 already; widen it so the test can prove the refusal did not chmod
    const dir = mkdtempSync(join(tmpdir(), "mida-nothome-"))
    chmodSync(dir, 0o755)
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "codex", "--project", makeProject()], {
      env: spawnEnv({ MIDA_HOME: dir }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => (stdout += b))
    child.stderr.on("data", (b) => (stderr += b))
    const code = await new Promise((r) => child.on("exit", r))
    expect(code).toBe(2)
    expect(stdout).toBe("")
    expect(stderr).toContain("not a Mida home")
    expect(stderr).toContain(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o755)
  }, 20_000)

  // the launcher's node fallback only matters when a candidate path exists — /opt/homebrew, /usr/local, ~/.volta
  it.skipIf(
    !["/opt/homebrew/bin/node", "/usr/local/bin/node", join(process.env.HOME ?? "/nonexistent", ".volta/bin/node")].some((c) => existsSync(c)),
  )("the launcher finds node without it on PATH, so the refusal is Mida's, not node's", async () => {
    const dir = makeHome() // empty home: the startup gate must be the thing that answers
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(BIN_MIDA_MCP, ["--as", "nobody"], {
        env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin", MIDA_HOME: dir.root },
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
    expect(res.stderr).toBe(`mida-mcp: no agent "nobody" is set up in the Mida home ${dir.root} — check MIDA_HOME in this client's config\n`)
  }, 30_000)

  /** A fake `node` that answers --version with `ver` and reports which version ran on stderr. */
  const fakeNode = (binDir: string, ver: string) => {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, "node"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v${ver}"; exit 0; fi\necho "fake-node v${ver} ran" >&2\nexit 0\n`,
      { mode: 0o755 },
    )
  }

  it("a node too old for --import is refused with one line, not a cryptic tsx error (F9)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mida-oldnode-"))
    fakeNode(dir, "10.0.0")
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(BIN_MIDA_MCP, ["--as", "nobody"], {
        env: { HOME: mkdtempSync(join(tmpdir(), "mida-home-")), PATH: `${dir}:/usr/bin:/bin`, MIDA_HOME: makeHome().root },
        cwd: "/tmp",
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
      child.on("error", reject)
      child.on("exit", (code) => done({ status: code, stdout, stderr }))
    })
    expect(res.status).toBe(127)
    expect(res.stdout).toBe("")
    expect(res.stderr).toContain("too old")
    expect(res.stderr).toContain("v10.0.0")
  }, 30_000)

  // the nvm fallback only runs when PATH and the hardcoded candidates all miss — on a machine
  // where /opt/homebrew/bin/node (or the others) exists this test cannot observe the nvm path
  it.skipIf(
    ["/opt/homebrew/bin/node", "/usr/local/bin/node", join(process.env.HOME ?? "/nonexistent", ".volta/bin/node")].some((c) => existsSync(c)),
  )("the launcher picks the newest nvm node when PATH and the usual spots have none (F9)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "mida-nvm-"))
    fakeNode(join(homeDir, ".nvm", "versions", "node", "v18.19.0", "bin"), "18.19.0")
    fakeNode(join(homeDir, ".nvm", "versions", "node", "v22.1.0", "bin"), "22.1.0")
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(BIN_MIDA_MCP, ["--as", "nobody"], {
        env: { HOME: homeDir, PATH: "/usr/bin:/bin", MIDA_HOME: makeHome().root },
        cwd: "/tmp",
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
      child.on("error", reject)
      child.on("exit", (code) => done({ status: code, stdout, stderr }))
    })
    expect(res.status).toBe(0)
    expect(res.stderr).toBe("fake-node v22.1.0 ran\n")
  }, 30_000)
})

describe("mida-mcp — the parent-process wall of the foreign-client guard (in-13 M-8)", () => {
  // Live probe, Sep 26 — not verifiable from this repo: Devin starts the MCP servers it finds
  // in a project's .mcp.json AND .cursor/mcp.json and in Claude Code's user-level config, it
  // sets no DEVIN_PROJECT_DIR (or any marker of its own) on those children, and its initialize
  // names the generic rmcp library — but the MCP child's parent process is still the devin
  // binary (`ps -o comm= -p <ppid>` → /Users/you/.local/bin/devin). The env wall alone
  // cannot see that replay; the parent's basename can. The lookup is an injectable function —
  // a spawned child cannot be handed a fake parent, and these tests never spawn `ps` for
  // real, so the wall is exercised at the predicate every entry calls.
  it("a devin parent + --as cursor is refused", () => {
    expect(foreignClientReplayReason("cursor", {}, () => "devin")).toBe("the parent process is devin")
  })

  it("a devin parent + --as devin is served", () => {
    expect(foreignClientReplayReason("devin", {}, () => "devin")).toBeNull()
  })

  it("a Cursor parent + --as cursor is served", () => {
    expect(foreignClientReplayReason("cursor", {}, () => "Cursor")).toBeNull()
  })

  it("a failed parent lookup is served — a replay guard never decides on an unknown parent", () => {
    expect(foreignClientReplayReason("cursor", {}, () => undefined)).toBeNull()
  })

  it("DEVIN_PROJECT_DIR answers first — the parent is never asked once the env wall fires", () => {
    let asked = false
    const reason = foreignClientReplayReason("cursor", { DEVIN_PROJECT_DIR: "/w" }, () => {
      asked = true
      return "devin"
    })
    expect(reason).toBe("DEVIN_PROJECT_DIR is set")
    expect(asked).toBe(false)
  })

  it("--as devin never asks either — the lookup is lazy", () => {
    let asked = false
    const reason = foreignClientReplayReason("devin", {}, () => {
      asked = true
      return "devin"
    })
    expect(reason).toBeNull()
    expect(asked).toBe(false)
  })
})

/** The eleven field names mida_save accepts — the ten content fields plus the optional verbatim ask. */
const SAVE_FIELDS = [
  "objective",
  "progress",
  "decisions",
  "rejected",
  "constraints",
  "artifacts",
  "unresolvedIssue",
  "nextAction",
  "remainingPlan",
  "evidence",
  "originalRequest",
]
const CONTENT_FIELDS = SAVE_FIELDS.slice(0, 10)

/** A save-shaped argument set — every field present so a forged identity key would stand out. */
const SAVE_ARGS: Record<string, unknown> = {
  objective: "o",
  progress: [],
  decisions: [],
  rejected: [],
  constraints: [],
  artifacts: [],
  unresolvedIssue: null,
  nextAction: "n",
  remainingPlan: [],
  evidence: [],
  originalRequest: "the user's ask, word for word",
}

describe("mida-mcp tools against a fake daemon", () => {
  it("lists exactly the five stable tools, with the pinned input schemas", async () => {
    // an MCP client identity — the only kind mida_save signs for (AUTH-17)
    const { client, close } = await connect(deps(home(), { agent: "claude-desktop", daemonUp: false }))
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).toEqual(["mida_handoff", "mida_whats_new", "mida_read", "mida_status", "mida_save"])
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
      const save = listed.tools.find((t) => t.name === "mida_save")!
      const schema = save.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: unknown }
      // exactly the checkpoint's ten content fields plus the optional originalRequest — and nothing else:
      // no eventId, agent, source or createdAt to forge, no sessionId or projectId to steer
      expect(Object.keys(schema.properties).sort()).toEqual([...SAVE_FIELDS].sort())
      expect([...(schema.required ?? [])].sort()).toEqual([...CONTENT_FIELDS].sort())
      expect(schema.additionalProperties).toBe(false)
      // the description tells the model when to call it — the brief's two moments
      expect(save.description).toMatch(/asks? to save|asks? you to save|to save context|save context|hand off/i)
      expect(save.description).toMatch(/before .*finish/i)
    } finally {
      await close()
    }
  })

  // AUTH-17: a client that saves through hooks is never offered a save tool that can only refuse
  const toolsFor = async (agent: string): Promise<{ names: string[]; instructions: string | undefined }> => {
    const { client, close } = await connect(deps(home(), { agent, daemonUp: false }))
    try {
      return { names: (await client.listTools()).tools.map((t) => t.name), instructions: client.getInstructions() }
    } finally {
      await close()
    }
  }

  it("hook-saved clients and unknown names get the four read tools, no mida_save (AUTH-17)", async () => {
    for (const agent of ["claude-code", "codex", "assistant", ""]) {
      expect((await toolsFor(agent)).names).toEqual(["mida_handoff", "mida_whats_new", "mida_read", "mida_status"])
    }
  })

  it("claude-desktop and cursor still get all five tools (AUTH-17)", async () => {
    for (const agent of ["claude-desktop", "cursor"]) {
      expect((await toolsFor(agent)).names).toEqual(["mida_handoff", "mida_whats_new", "mida_read", "mida_status", "mida_save"])
    }
  })

  it("the server's instructions mention mida_save only to clients that get it (AUTH-17)", async () => {
    expect((await toolsFor("claude-code")).instructions).toBe(
      "Mida adapter over the local midad daemon. It can fetch the project handoff, the what's-new note, a namespace read and status. This server has no save tool: this client's saves come only from its Mida hooks, and only while they are installed. Owner operations stay absent: no approve, revoke, request or remember, because a model must never change who has access through MCP.",
    )
    // Codex ignores untrusted hooks, and doctor cannot see trust — the owner is told what to do (Fable review)
    expect((await toolsFor("codex")).instructions).toContain("Codex ignores them until you trust them: open codex, type /hooks, and trust the Mida entries.")
    expect((await toolsFor("claude-code")).instructions).not.toContain("mida doctor")
    // an identity with no hooks (a harness added with `mida add-agent`) is never told it saves
    const other = (await toolsFor("windsurf")).instructions
    expect(other).toBe(
      "Mida adapter over the local midad daemon. It can fetch the project handoff, the what's-new note, a namespace read and status. This server has no save tool for this client: mida_save signs only for claude-desktop and cursor. Owner operations stay absent: no approve, revoke, request or remember, because a model must never change who has access through MCP.",
    )
    expect(other).not.toContain("hooks")
    expect((await toolsFor("cursor")).instructions).toContain("it can save a checkpoint with mida_save")
  })

  it("mida_read's description says what each namespace returns (PROV-12)", () => {
    const read = MCP_TOOLS.find((t) => t.name === "mida_read")!
    expect(read.description).toBe(
      "Read one Mida context area through the daemon; you get the same output as `mida read --as <agent> <namespace>`. For profile.skills and preferences.communication you get the facts saved there that this agent may read (an area it has no access to says refused). For projects.current (the default) you get only each saved checkpoint's id and author, across every task; mida_handoff gives the content for the current task.",
    )
  })

  it("mida_save's description names the clients it serves (AUTH-17)", async () => {
    const save = MCP_TOOLS.find((t) => t.name === "mida_save")!
    expect(save.description).toBe(
      "Save a checkpoint of your work on this project so another approved agent can pick it up. Call it when the user asks to save context or hand off, and before you finish a task. Claude Desktop and Cursor get this tool; agents with Mida hooks, like Claude Code and Codex, save through those hooks instead. The daemon signs each save as this client's own identity after the owner's approval checks pass. A list holds at most 50 entries. One save per minute at most.",
    )
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
          : { kind: "updates", note: "Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):\n- codex: did the thing", updates: [{ agent: "codex", savedAt: "2026-09-22T10:01:00Z" }], seen: ["0xnew-ctx"] },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const first = await callText(client, "mida_whats_new")
        expect(first).toContain("did the thing")
        expect(readSeen(dir, "mcp-assistant-test1")).toEqual(new Set(["0xnew-ctx"]))
        const second = await callText(client, "mida_whats_new")
        expect(second).toBe("Mida: nothing new since the last check.")
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
        expect(await callText(client, "mida_whats_new")).toBe("Mida: codex's access was revoked by the owner. Mida shared nothing this time. Revoking stops future reads; it cannot recall what this agent already read.")
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new answers the busy-chain line for a chain-busy refusal (in-6 R4)", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "chain-busy" } })
    try {
      const { client, close } = await connect(deps(dir, { agent: "codex" }))
      try {
        expect(await callText(client, "mida_whats_new")).toBe(
          "Mida: Monad is busy right now — context not loaded; working without it (it tries again next session)",
        )
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_handoff returns the no-identity refusal's text verbatim", async () => {
    const dir = home()
    const text = 'Mida: no agent "assistant" is set up in this Mida home (/h). Nothing was shared.'
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "refused", reason: "no-identity", text } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_handoff")).toBe(text)
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new returns the no-identity line the daemon sent", async () => {
    const dir = home()
    const text = 'Mida: no agent "assistant" is set up in this Mida home (/h). Nothing was shared.'
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "no-identity", text } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_whats_new")).toBe(text)
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new answers the no-identity line for a reason-only refusal — the real /whatsnew shape", async () => {
    const dir = home()
    // buildWhatsNew's refused result carries reason only — the adapter reproduces the line,
    // naming the server's configured agent and the home the daemon is serving
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "no-identity" } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_whats_new")).toBe(
          `Mida: no agent "assistant" is set up in this Mida home (${dir.root}). Nothing was shared.`,
        )
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new returns the identity-unreadable text the daemon sent", async () => {
    const dir = home()
    const text = "Mida: assistant's identity in this Mida home (/h) exists but could not be read. Nothing was shared. Run `mida doctor`."
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "identity-unreadable", text } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_whats_new")).toBe(text)
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new answers the identity-unreadable line for a reason-only refusal — never 'not set up'", async () => {
    const dir = home()
    // same reason-only shape as no-identity — a file that exists but will not load must not
    // be reported as a missing agent
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "identity-unreadable" } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_whats_new")).toBe(
          `Mida: assistant's identity in this Mida home (${dir.root}) exists but could not be read. Nothing was shared. Run \`mida doctor\`.`,
        )
      } finally {
        await close()
      }
      expect(dir.has("state/lastseen/mcp-assistant-test1.json")).toBe(false)
    } finally {
      await fake.stop()
    }
  })

  it("mida_whats_new answers the install-a-client line for a general-assistance refusal — never 'approve assistant' (I2)", async () => {
    const dir = home()
    // a general-assistance identity can never hold a project approval, so the refusal must
    // point at `mida install`, not at an approve that can only loop
    const fake = await fakeDaemon(dir, { "/whatsnew": { kind: "refused", reason: "general-assistance" } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_whats_new")).toBe(
          "Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`.",
        )
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

  it("mida_read relays a migrated fact's (moved on <date>) marker verbatim — the marker is part of the daemon's line", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, {
      "/cli": { code: 0, lines: ["What you have told Mida about yourself", "  preferences.communication: answers in lowercase (moved on 2026-09-25)"] },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_read", { namespace: "preferences.communication" })
        expect(text).toContain("  preferences.communication: answers in lowercase (moved on 2026-09-25)")
      } finally {
        await close()
      }
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
    // the probe list is the agents registered in this home — the same set `listAgentNames` computes
    for (const name of ["claude-code", "codex", "assistant"]) {
      mkdirSync(join(dir.root, "agents", name), { recursive: true })
      writeFileSync(join(dir.root, "agents", name, "identity.json"), "{}")
    }
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
      // three /handoff probes — one per registered agent, sorted, none carrying a session
      const probes = fake.requests.filter((r) => r.path === "/handoff")
      expect(probes.map((r) => r.body?.agent)).toEqual(["assistant", "claude-code", "codex"])
      expect(probes.every((r) => r.body?.sessionId === undefined)).toBe(true)
    } finally {
      await fake.stop()
    }
  })

  // AUTH-16: a probe that did not come back in time is a slow daemon, not a missing one
  const statusWith = async (handoff: Route, over: Partial<McpServerDeps> = {}): Promise<string> => {
    const dir = home()
    mkdirSync(join(dir.root, "agents", "claude-code"), { recursive: true })
    writeFileSync(join(dir.root, "agents", "claude-code", "identity.json"), "{}")
    const fake = await fakeDaemon(dir, { "/health": HEALTH, "/handoff": handoff })
    try {
      const { client, close } = await connect(deps(dir, { agent: "claude-code", ...over }))
      try {
        return await callText(client, "mida_status")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  }

  it("mida_status: a probe that times out says approval was not checked, never 'no answer' (AUTH-16)", async () => {
    const text = await statusWith({ silent: true }, { statusProbeMs: 200 })
    expect(text).toContain("midad: answering")
    expect(text).not.toContain("no answer from the daemon")
    expect(text).toContain("claude-code: could not tell. Reading its context took over 0.2 s. Ask again in a moment.")
    expect(text).not.toContain("daemon is up")
  })

  it("mida_status: the production limit prints whole seconds, rounded down (AUTH-16)", async () => {
    const text = await statusWith({ silent: true }, { statusProbeMs: 1_000 })
    expect(text).toContain("claude-code: could not tell. Reading its context took over 1 s. Ask again in a moment.")
  })

  it("mida_status: the daemon's own read-slow refusal says approval was not checked (AUTH-16)", async () => {
    const text = await statusWith({ kind: "refused", reason: "read-slow", text: "x" })
    expect(text).not.toContain("cannot tell")
    expect(text).toContain("claude-code: could not tell. The daemon ran out of time reading its context; its approval may already have passed. Ask again in a moment.")
  })

  it("mida_status: a reply that is not JSON says it could not be read (AUTH-16)", async () => {
    const text = await statusWith({ raw: "<html>not json</html>" })
    expect(text).not.toContain("no answer from the daemon")
    expect(text).toContain("claude-code: could not tell. Mida could not read the daemon's reply.")
  })

  it("mida_status: a daemon that drops the probe unanswered still says 'no answer' (AUTH-16)", async () => {
    const text = await statusWith({ hangup: true })
    expect(text).toContain("claude-code: no answer from the daemon")
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

  it("mida_save posts {agent, cwd, fields} to /save and prints the daemon's saved line verbatim", async () => {
    const dir = home()
    const project = projectDir()
    const fake = await fakeDaemon(dir, {
      "/save": { kind: "saved", text: "Mida: checkpoint saved as claude-desktop (record 0xabcd…)." },
    })
    try {
      const { client, close } = await connect(deps(dir, { agent: "claude-desktop", project }))
      try {
        expect(await callText(client, "mida_save", SAVE_ARGS)).toBe("Mida: checkpoint saved as claude-desktop (record 0xabcd…).")
      } finally {
        await close()
      }
      const sent = fake.requests.filter((r) => r.path === "/save")
      expect(sent).toHaveLength(1)
      // the adapter contributes only who it is and where it runs — the model's fields go verbatim,
      // so a field the daemon does not know still reaches its validator and gets named
      expect(sent[0]!.body).toEqual({ agent: "claude-desktop", cwd: project, fields: SAVE_ARGS })
    } finally {
      await fake.stop()
    }
  })

  it("mida_save prints the daemon's refusal text verbatim — the rate-limit line and the field-name line alike", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, {
      "/save": (body) =>
        typeof body?.fields === "object" && body.fields !== null && "surprise" in (body.fields as Record<string, unknown>)
          ? { kind: "refused", reason: "invalid-shape", text: "Mida: these fields are not part of a checkpoint: surprise", fields: ["surprise"] }
          : { kind: "refused", reason: "rate-limited", text: "Mida: claude-desktop may save once per minute in a project — the next save is allowed in 60 s." },
    })
    try {
      const { client, close } = await connect(deps(dir, { agent: "claude-desktop" }))
      try {
        expect(await callText(client, "mida_save", SAVE_ARGS)).toBe(
          "Mida: claude-desktop may save once per minute in a project — the next save is allowed in 60 s.",
        )
        expect(await callText(client, "mida_save", { ...SAVE_ARGS, surprise: "x" })).toBe(
          "Mida: these fields are not part of a checkpoint: surprise",
        )
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
      for (const [name, args] of [
        ["mida_handoff", {}],
        ["mida_whats_new", {}],
        ["mida_read", {}],
        ["mida_status", {}],
        ["mida_save", SAVE_ARGS],
      ] as const) {
        const text = await callText(client, name, args)
        expect(text).toBe(DEGRADED)
        expect(text).not.toMatch(/^\s+at\s/m)
        expect(text).not.toContain("node:internal")
      }
    } finally {
      await close()
    }
  })

  it("a health probe that times out answers daemon-slow — the daemon is there, just not answering", async () => {
    const dir = home()
    // accepts the connection and stays silent: unreachable is down, silent-but-connected is slow
    const fake = await fakeDaemon(dir, { "/health": { silent: true } })
    try {
      const { client, close } = await connect(deps(dir, { daemonUp: false }))
      try {
        expect(await callText(client, "mida_handoff")).toBe(DEGRADED_SLOW)
        expect(await callText(client, "mida_status")).toBe(DEGRADED_SLOW)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("a handoff the connected daemon never answers is daemon-slow, while a dead socket is down", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/health": HEALTH, "/handoff": { silent: true } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        // ~8 s — the real HANDOFF_TIMEOUT_MS, and still the slow line, never down
        expect(await callText(client, "mida_handoff")).toBe(DEGRADED_SLOW)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
    // no listener at all — the down half of the pair
    const { client, close } = await connect(deps(home()))
    try {
      expect(await callText(client, "mida_handoff")).toBe(DEGRADED)
    } finally {
      await close()
    }
  })

  it("a daemon that comes up after the boot window is discovered — the flag is not latched", async () => {
    // ensureDaemon waited 4 s at start and gave up, but the daemon answers now: the next tool
    // call re-probes /health once and serves the real answer, not a stale degraded line
    const dir = home()
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": { kind: "empty", text: "Mida: connected. Nothing has been saved for this project yet.", seen: [] },
    })
    try {
      const d = deps(dir, { daemonUp: false })
      const { client, close } = await connect(d)
      try {
        expect(await callText(client, "mida_handoff")).toBe("Mida: connected. Nothing has been saved for this project yet.")
        expect(d.daemonUp).toBe(true)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
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
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff" }, "/cli": { lines: "nope" }, "/save": { kind: "saved" } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_handoff")).toBe("Mida: could not load context (bad-reply) — working without it")
        expect(await callText(client, "mida_read")).toBe("Mida: could not load context (bad-reply) — working without it")
        expect(await callText(client, "mida_save", SAVE_ARGS)).toBe("Mida: could not load context (bad-reply) — working without it")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("an 8 001-char handoff comes back whole — the handoff cap is 40,000, not the tools' 8,000 (UF-I)", async () => {
    const dir = home()
    const big = "x".repeat(8_001)
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: big, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_handoff")).toBe(big)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("a 12,000-char handoff ending in the END line comes back unchanged (UF-I)", async () => {
    const dir = home()
    const big = `${"x".repeat(12_000)}\n\n=== END MIDA HANDOFF DATA ===`
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: big, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_handoff")).toBe(big)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("a handoff over 40,000 chars keeps its END line and says where the reply was cut (UF-I)", async () => {
    const dir = home()
    const big = `${"x".repeat(41_000)}\n\n=== END MIDA HANDOFF DATA ===`
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: big, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_handoff")
        expect(text.length).toBeLessThanOrEqual(40_000)
        // kept text, then …, then the cut line, a blank line, then the closing fence
        expect(text.endsWith("…\n(Mida cut this reply at 40,000 characters. Text after this point is missing.)\n\n=== END MIDA HANDOFF DATA ===")).toBe(true)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("a handoff over 40,000 chars with no END line is cut plainly, at 40,000 (UF-I)", async () => {
    const dir = home()
    const big = "x".repeat(41_000)
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: big, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_handoff")
        expect(text).toBe(`${"x".repeat(39_999)}…`)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("the 40,000 cut never splits a surrogate pair — an emoji at the cut point stays whole or goes (UF-N)", async () => {
    const dir = home()
    // the cut lands between the emoji's two UTF-16 halves: 39,998 chars + a 2-unit emoji
    const big = `${"x".repeat(39_998)}😀${"y".repeat(100)}`
    expect(big.length).toBeGreaterThan(40_000)
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: big, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_handoff")
        // one unit fewer was kept, so no lone surrogate sits before the …
        expect(text).toBe(`${"x".repeat(39_998)}…`)
        const beforeEllipsis = text.charCodeAt(text.length - 2)
        expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdfff).toBe(false)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("the 8,000 tool cap never splits a surrogate pair either — capText keeps the emoji whole or drops it (UF-N2)", async () => {
    const dir = home()
    // the cut lands between the emoji's two UTF-16 halves: 7,998 chars + a 2-unit emoji
    const big = `${"x".repeat(7_998)}😀${"y".repeat(100)}`
    expect(big.length).toBeGreaterThan(8_000)
    const fake = await fakeDaemon(dir, { "/health": HEALTH, "/cli": { code: 0, lines: [big] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_read")
        expect(text).toBe(`${"x".repeat(7_998)}…`)
        const before = text.charCodeAt(text.length - 2)
        expect(before >= 0xd800 && before <= 0xdfff).toBe(false)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("the fenced 40,000 cut never splits a surrogate pair either — the branch real handoffs take (UF-N2)", async () => {
    const dir = home()
    // every real handoff carries the END fence, so its cap runs the fenced branch, not the
    // plain cut the UF-N test above exercises. The kept text ends at `keep` units before the
    // appended tail — pad so that index lands between the emoji's two UTF-16 halves.
    const fence = "=== END MIDA HANDOFF DATA ==="
    const tail = `…\n${CUT_LINE}\n\n${fence}`
    const keep = 40_000 - tail.length
    const head = "MIDA HANDOFF\n=== BEGIN MIDA HANDOFF DATA ===\n"
    const rendered = `${head}${"x".repeat(keep - 1 - head.length)}😀${"y".repeat(1_000)}\n\n${fence}`
    expect(rendered.length).toBeGreaterThan(40_000)
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: rendered, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        const text = await callText(client, "mida_handoff")
        expect(text.length).toBeLessThanOrEqual(40_000)
        expect(text.endsWith(tail)).toBe(true)
        const ellipsisAt = text.indexOf("…")
        const before = text.charCodeAt(ellipsisAt - 1)
        expect(before >= 0xd800 && before <= 0xdfff).toBe(false)
        expect(text).not.toContain("😀")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  // UF-K (replaces the UF-J single-sentence swap): the fixtures come from the REAL renderer —
  // a hand-typed preamble would stay green through a renderer reword and let a false claim back.
  // renderHandoffReport produces the daemon's reply; the oversized inputs cross the 40,000 reply
  // cap because rule lines are never dropped to fit.
  const CUT_LINE = "(Mida cut this reply at 40,000 characters. Text after this point is missing.)"
  // the one line the cut swaps in for whatever the over-target note claimed
  const REPLY_CUT_NOTE =
    "Mida note: this handoff is longer than its size target, and this reply was cut at 40,000 characters, so entries near the end are missing."
  const BEGIN_FENCE = "=== BEGIN MIDA HANDOFF DATA ==="
  /** 50 never-dropped rule lines that alone push the render past the 40,000-char reply cap. */
  const BIG_CONSTRAINTS = Array.from({ length: 50 }, (_, i) => `constraint ${i} ${"c".repeat(880)}`)

  const mergedOf = (over: Partial<MergedHandoff> = {}): MergedHandoff => ({
    headSessionId: "s1",
    savedAt: "2026-09-21T10:00:00.000Z",
    originalRequest: "do the thing",
    objective: "finish it",
    remainingPlan: ["step 1"],
    unresolvedIssue: null,
    nextAction: "run the tests",
    decisions: [],
    rejected: [],
    constraints: [],
    artifacts: [],
    progress: [],
    provenance: [],
    otherSessions: [],
    missingEarlierSession: false,
    carriedForwardFromEarlierSave: false,
    ...over,
  })

  /** Serve `rendered` as the /handoff answer and return what the caller actually receives. */
  const cappedReply = async (rendered: string) => {
    const dir = home()
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: rendered, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        return await callText(client, "mida_handoff")
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  }

  it("the leaf constant the adapter rewrites against is the renderer's own lead (UF-K)", () => {
    // the mcp import graph may not reach @mida/*, so hook-output.ts carries the same literal —
    // this pins the two copies together
    expect(LEAF_OVERSIZE_NOTE_LEAD).toBe(OVERSIZE_NOTE_LEAD)
  })

  it("a cut reply's 'Nothing was left out' claim is replaced by the reply-was-cut line (UF-K)", async () => {
    const rendered = renderHandoffReport(mergedOf({ constraints: BIG_CONSTRAINTS })).text
    // the fixture really carried the false claim the defect was about
    expect(rendered).toContain(`${OVERSIZE_NOTE_LEAD} No constraint, decision or rejected approach was left out to shorten it. Nothing was left out.`)
    expect(rendered.length).toBeGreaterThan(40_000)
    const text = await cappedReply(rendered)
    expect(text.length).toBeLessThanOrEqual(40_000)
    const preamble = text.slice(0, text.indexOf(BEGIN_FENCE))
    expect(preamble).toContain(REPLY_CUT_NOTE)
    expect(preamble).not.toContain("Nothing was left out")
    expect(preamble).not.toContain("No constraint, decision or rejected approach was left out")
    // one note line, not the old claim plus the truth
    expect(preamble.split("\n").filter((l) => l.startsWith("Mida note: this handoff is longer than its size target"))).toHaveLength(1)
    expect(text.endsWith(`…\n${CUT_LINE}\n\n=== END MIDA HANDOFF DATA ===`)).toBe(true)
  })

  it("a cut reply whose note named left-out saves gets the same replacement line (UF-K)", async () => {
    // rules keep the text over target; the per-save lines are history, so the renderer drops
    // the two oldest and its note ends " Left out: 2 earlier saves."
    const merged = mergedOf({
      constraints: BIG_CONSTRAINTS,
      provenance: Array.from({ length: 3 }, (_, i) => ({
        agent: `a${i}`,
        authorId: `0x${String(i).padStart(64, "0")}`,
        createdAt: "2026-09-21T10:00:00.000Z",
        contextId: `0x${String(i + 1).padStart(64, "0")}`,
        compiledBy: "test",
      })),
    })
    const rendered = renderHandoffReport(merged).text
    expect(rendered).toContain(" Left out: 2 earlier saves.")
    const text = await cappedReply(rendered)
    expect(text.length).toBeLessThanOrEqual(40_000)
    const preamble = text.slice(0, text.indexOf(BEGIN_FENCE))
    expect(preamble).toContain(REPLY_CUT_NOTE)
    expect(preamble).not.toContain("Left out:")
    expect(preamble).not.toContain("Nothing was left out")
  })

  /** A rendered handoff padded to exactly `target` chars — the request field renders verbatim. */
  const renderSized = (constraintCount: number, target: number) => {
    const constraints = Array.from({ length: constraintCount }, (_, i) => `constraint ${i} ${"c".repeat(880)}`)
    const first = renderHandoffReport(mergedOf({ constraints })).text
    const pad = target - first.length
    if (pad < 0) throw new Error(`fixture overshoots ${target}: ${first.length}`)
    const text = renderHandoffReport(mergedOf({ constraints, originalRequest: `do the thing${"x".repeat(pad)}` })).text
    if (text.length !== target) throw new Error(`padded to ${text.length}, wanted ${target}`)
    return text
  }

  const END_COUNT = (text: string) => text.split("=== END MIDA HANDOFF DATA ===").length - 1

  it("a reply just over the cap takes the short form: the lead alone, no cut claim, one END line (UF-L)", async () => {
    // 40,001 and 40,050: the long note's tail clause is the only excess — shrinking it to the
    // lead alone brings the reply under the cap, so nothing is cut and nothing may say it was
    for (const target of [40_001, 40_050]) {
      const rendered = renderSized(43, target)
      expect(rendered).toContain(`${OVERSIZE_NOTE_LEAD} No constraint, decision or rejected approach was left out to shorten it. Nothing was left out.`)
      const text = await cappedReply(rendered)
      expect(text.length).toBeLessThanOrEqual(40_000)
      expect(END_COUNT(text)).toBe(1)
      expect(text).not.toContain("was cut")
      expect(text).not.toContain("Text after this point is missing")
      // the note survives as the lead alone — still true: the handoff WAS over its target
      expect(text.split("\n")).toContain(OVERSIZE_NOTE_LEAD)
      // and every rule is still there — nothing was removed
      expect(text).toContain("constraint 0 ")
      expect(text).toContain("constraint 42 ")
    }
  })

  it("a reply the short form cannot save takes the cut form: cut note, one END line, under the cap (UF-L)", async () => {
    const rendered = renderSized(50, 60_000)
    const text = await cappedReply(rendered)
    expect(text.length).toBeLessThanOrEqual(40_000)
    expect(text.length).toBeLessThan(rendered.length)
    expect(END_COUNT(text)).toBe(1)
    const preamble = text.slice(0, text.indexOf(BEGIN_FENCE))
    expect(preamble).toContain(REPLY_CUT_NOTE)
    expect(text.endsWith(`…\n${CUT_LINE}\n\n=== END MIDA HANDOFF DATA ===`)).toBe(true)
  })

  it("a cut reply keeps only the text before the END line, one END total — and something is always removed (UF-L)", async () => {
    // synthetic on purpose: a real render ends AT the END line, so only a hand-shaped reply can
    // put text after it — the cap must still answer with one END line and a real cut
    const rendered = `MIDA HANDOFF header\n${BEGIN_FENCE}\n${"a".repeat(20_000)}\n\n=== END MIDA HANDOFF DATA ===\n${"junk ".repeat(9_000)}`
    expect(rendered.length).toBeGreaterThan(40_000)
    const text = await cappedReply(rendered)
    expect(END_COUNT(text)).toBe(1)
    expect(text).not.toContain("junk")
    // the reply says it was cut — so the kept text really ends at least one char early:
    // the last kept char is 'a', then the … tail, with the cut line and exactly one fence
    expect(text.endsWith(`a\n…\n${CUT_LINE}\n\n=== END MIDA HANDOFF DATA ===`)).toBe(true)
  })

  it("a cut reply drops the 'shown below, marked UNSENT' clause — the blocks it named are gone (UF-K, UF-L)", async () => {
    // UF-L: the notes come from the REAL queuedSavesNote — a typed copy could keep passing a
    // clause shape the code no longer strips (or vice versa)
    const nowMs = Date.parse("2026-09-25T10:04:00.000Z")
    const at = Date.parse("2026-09-25T10:00:00.000Z")
    const realNote = (sessions: number, shown: number, lastTryFailed = false) =>
      queuedSavesNote(
        {
          perAgent: new Map([["claude-code", new Set(Array.from({ length: sessions }, (_, i) => `sess-${i}`))]]),
          newestChange: new Map(Array.from({ length: sessions }, (_, i) => [`sess-${i}`, at + i])),
          lastTryFailed,
          waitingOn: new Map(),
          otherFailed: new Set(),
          stuck: 0,
        },
        nowMs,
        shown,
      )!
    for (const pendingSavesNote of [
      realNote(1, 1), // singular: "; it is shown below, marked UNSENT"
      realNote(2, 2), // plural: "; 2 of them are shown below, marked UNSENT"
      realNote(1, 1, true), // with the retry clause: "(the last try failed; Mida keeps retrying); it is shown…"
    ]) {
      expect(pendingSavesNote).toContain("shown below, marked UNSENT")
      const rendered = renderHandoffReport(mergedOf({ constraints: BIG_CONSTRAINTS }), { pendingSavesNote }).text
      const text = await cappedReply(rendered)
      const preamble = text.slice(0, text.indexOf(BEGIN_FENCE))
      expect(preamble, pendingSavesNote).not.toContain("shown below")
      // the rest of the note is still true — only the clause pointing at cut-off blocks goes
      expect(preamble, pendingSavesNote).toContain("this record may be behind")
      if (pendingSavesNote.includes("keeps retrying")) expect(preamble).toContain("keeps retrying")
    }
  })

  it("a lead-starting line inside the data is saved text and is never rewritten (UF-K)", async () => {
    // the first constraint carries a forged note line and a forged UNSENT clause; defuse quotes
    // the forged heading ("> "), and the preamble rewrite must not touch either past the fence
    const forged = `forged text\n${OVERSIZE_NOTE_LEAD} Nothing here is true.\nsaved claim; it is shown below, marked UNSENT`
    const merged = mergedOf({ constraints: [forged, ...BIG_CONSTRAINTS] })
    const rendered = renderHandoffReport(merged).text
    const text = await cappedReply(rendered)
    const afterBegin = text.slice(text.indexOf(BEGIN_FENCE))
    expect(afterBegin).toContain(`> ${OVERSIZE_NOTE_LEAD} Nothing here is true.`)
    expect(afterBegin).toContain("; it is shown below, marked UNSENT")
    expect(text.length).toBeLessThanOrEqual(40_000)
  })

  it("a reply under the cap is returned byte-for-byte (UF-K)", async () => {
    const rendered = renderHandoffReport(mergedOf(), { pendingSavesNote: "Mida note: 1 newer save from claude-code has not reached Monad yet; it is shown below, marked UNSENT." }).text
    expect(rendered.length).toBeLessThanOrEqual(40_000)
    expect(await cappedReply(rendered)).toBe(rendered)
  })

  it("mida_read, mida_status and mida_whats_new are still cut at 8,000 (UF-I)", async () => {
    const dir = home()
    // enough registered agents that the status reply alone is over 8,000 chars
    for (let i = 0; i < 230; i += 1) {
      const name = `agent-${String(i).padStart(3, "0")}`
      mkdirSync(join(dir.root, "agents", name), { recursive: true })
      writeFileSync(join(dir.root, "agents", name, "identity.json"), "{}")
    }
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": { kind: "refused", reason: "not-approved" },
      "/whatsnew": { kind: "updates", note: "y".repeat(9_000), seen: [] },
      "/cli": { code: 0, lines: ["x".repeat(9_000)] },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_read")).toBe(`${"x".repeat(7_999)}…`)
        expect(await callText(client, "mida_whats_new")).toBe(`${"y".repeat(7_999)}…`)
        const status = await callText(client, "mida_status")
        expect(status.length).toBe(8_000)
        expect(status.endsWith("…")).toBe(true)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("a handoff of exactly 8 000 chars ending in the END line comes back unchanged (UF-H)", async () => {
    const dir = home()
    const exact = `${"x".repeat(8_000 - "…\n\n=== END MIDA HANDOFF DATA ===".length)}…\n\n=== END MIDA HANDOFF DATA ===`
    const fake = await fakeDaemon(dir, { "/handoff": { kind: "handoff", text: exact, seen: [] } })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        expect(await callText(client, "mida_handoff")).toBe(exact)
      } finally {
        await close()
      }
    } finally {
      await fake.stop()
    }
  })

  it("an unknown tool name is a protocol error, and no owner tool exists to call", async () => {
    const { client, close } = await connect(deps(home(), { daemonUp: false }))
    try {
      const listed = await client.listTools()
      // mida_save is the one write the owner decided MCP clients may have; every operation that
      // changes WHO has access stays absent — no tool to approve, revoke, request or remember
      for (const name of ["remember", "approve", "revoke", "request", "mida_approve", "mida_revoke", "mida_remember", "mida_request"]) {
        expect(listed.tools.some((t) => t.name === name)).toBe(false)
      }
      await expect(client.callTool({ name: "mida_approve", arguments: {} })).rejects.toThrow()
      await expect(client.callTool({ name: "mida_revoke", arguments: {} })).rejects.toThrow()
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

  it("only ever sends read routes and the one save route to the daemon — every tool, every namespace", async () => {
    const dir = home()
    const project = projectDir()
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": { kind: "empty", text: "Mida: connected. Nothing has been saved for this project yet.", seen: [] },
      "/whatsnew": { kind: "none" },
      "/cli": { code: 0, lines: ["projects.current: read 0 object(s)"] },
      "/save": { kind: "saved", text: "Mida: checkpoint saved." },
    })
    try {
      const { client, close } = await connect(deps(dir, { project }))
      try {
        await callText(client, "mida_handoff")
        await callText(client, "mida_whats_new")
        await callText(client, "mida_status")
        for (const namespace of READ_NAMESPACES) await callText(client, "mida_read", { namespace })
        await callText(client, "mida_save", SAVE_ARGS)
      } finally {
        await close()
      }
      // the daemon's socket also accepts /kick, /shutdown and /cli argv like `request` or
      // `approve` — the adapter's restraint is what keeps it to reads plus this one gated write,
      // so every recorded request is pinned, not just the ones a test happened to look at
      expect(fake.requests.length).toBeGreaterThan(0)
      for (const req of fake.requests) {
        expect(["/health", "/handoff", "/whatsnew", "/cli", "/save"]).toContain(req.path)
        if (req.path === "/cli") expect((req.body?.argv as string[]).slice(0, 3)).toEqual(["read", "--as", "assistant"])
        // the save body is exactly {agent, cwd, fields} — no sessionId, no projectId, nothing else
        if (req.path === "/save") {
          expect(Object.keys(req.body ?? {}).sort()).toEqual(["agent", "cwd", "fields"])
          expect(Object.keys((req.body?.fields ?? {}) as Record<string, unknown>).sort()).toEqual([...SAVE_FIELDS].sort())
        }
      }
      expect(fake.requests.some((r) => r.path === "/save")).toBe(true)
    } finally {
      await fake.stop()
    }
  })

  it("no tool schema carries an identity, home or project field", async () => {
    // an MCP client identity, so the list includes mida_save — the one write tool (AUTH-17 review)
    const { client, close } = await connect(deps(home(), { agent: "claude-desktop", daemonUp: false }))
    try {
      const { tools } = await client.listTools()
      for (const tool of tools) {
        const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})
        for (const p of props) expect(p).not.toMatch(/^(as|agent|identity|home|project|cwd|mida_home)$/i)
      }
    } finally {
      await close()
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
    /(^|\/)(keys|skeleton|runtime|cli|remember|projects|drain|drain-main|daemon|daemon-main|doctor|install|testnet|api-server|request-store|checkpoint-payload|hook-main|inject-main|whatsnew|handoff|mcp-save)\.ts$|owner-link/

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
    const signingCall = /(privateKey|privateKeyToAccount|signMessage|signTypedData|loadOrCreateOwnerSecrets|loadAgentIdentity|loadGrants)\s*\(/
    // a leaf module must not import a workspace package either — @mida/* is how key material
    // would arrive from outside the walked relative graph
    const signingImport = /from\s+["'](viem|ethers|@noble\/curves|@noble\/secp256k1|@mida\/)/
    for (const file of graph) {
      const text = readFileSync(file, "utf8")
      expect(signingCall.test(text), `${file} calls a signing primitive`).toBe(false)
      expect(signingImport.test(text), `${file} imports a signing-capable package`).toBe(false)
    }
  })
})
