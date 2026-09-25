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
import { AGENT_NAME, MidaHome, MCP_TOOLS, READ_NAMESPACES, createMidaMcpServer, loadAgentIdentity, parseMcpArgs, readSeen, socketPathFor, startupCheck } from "@mida/midad"
import type { McpServerDeps } from "@mida/midad"

const BIN_MIDA_MCP = fileURLToPath(new URL("../../../bin/mida-mcp", import.meta.url))
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url))

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const tsxLoader = join(repo, "node_modules/tsx/dist/loader.mjs")
const mcpMainPath = join(repo, "apps/midad/src/mcp-main.ts")

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
        env: { ...process.env, MIDA_HOME: dir.root },
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
      env: { ...process.env, MIDA_HOME: home.root },
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
      env: { ...process.env, MIDA_HOME: home.root },
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
      env: { ...process.env, MIDA_HOME: home.root },
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

  it("a MIDA_HOME that does not exist is refused before a folder is created there (F6)", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "mida-nohome-")), "home")
    const child = spawn(process.execPath, ["--import", tsxLoader, mcpMainPath, "--as", "codex", "--project", makeProject()], {
      env: { ...process.env, MIDA_HOME: missing },
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
      env: { ...process.env, MIDA_HOME: file },
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
      env: { ...process.env, MIDA_HOME: dir },
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

  it("only ever sends read-shaped requests to the daemon — every tool, every namespace", async () => {
    const dir = home()
    const fake = await fakeDaemon(dir, {
      "/health": HEALTH,
      "/handoff": { kind: "empty", text: "Mida: connected. Nothing has been saved for this project yet.", seen: [] },
      "/whatsnew": { kind: "none" },
      "/cli": { code: 0, lines: ["projects.current: read 0 object(s)"] },
    })
    try {
      const { client, close } = await connect(deps(dir))
      try {
        await callText(client, "mida_handoff")
        await callText(client, "mida_whats_new")
        await callText(client, "mida_status")
        for (const namespace of READ_NAMESPACES) await callText(client, "mida_read", { namespace })
      } finally {
        await close()
      }
      // the daemon's socket also accepts /kick, /shutdown and /cli argv like `request` or
      // `save-demo` — the adapter's restraint is what keeps it read-only, so every recorded
      // request is pinned, not just the ones a test happened to look at
      expect(fake.requests.length).toBeGreaterThan(0)
      for (const req of fake.requests) {
        expect(["/health", "/handoff", "/whatsnew", "/cli"]).toContain(req.path)
        if (req.path === "/cli") expect((req.body?.argv as string[]).slice(0, 3)).toEqual(["read", "--as", "assistant"])
      }
    } finally {
      await fake.stop()
    }
  })

  it("no tool schema carries an identity, home or project field", async () => {
    const { client, close } = await connect(deps(home(), { daemonUp: false }))
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
