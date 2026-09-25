import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseError } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, NEEDS_TERMINAL_LINE, Runtime, USAGE, approveProject, loadAgentIdentity, loadOrCreateOwnerSecrets, loadOwnerAddress, ownerCommandNotice, ownerRefusalLine, runCli, runCliWithRuntime, FileAccessRequestStore, saveAgentIdentity } from "@mida/midad"
import type { Network, ResolvedNetwork, ServiceRuntime } from "@mida/midad"
import { accessRequestTypedData, encodeUint64 } from "@mida/protocol"
import type { AccessRequest, Hex } from "@mida/protocol"

describe("the crude mida command", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  const lines: string[] = []
  // the prompt dep stands in for a human typing at the terminal — every approve here answers yes —
  // and the terminal deps stand in for the real TTY the owner commands refuse to run without
  const run = (...argv: string[]) =>
    runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-")))
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("rejects an unknown command, an unknown agent and a missing project with exit code 2", async () => {
    expect(await run("frobnicate")).toBe(2)
    expect(await run("approve", "cursor")).toBe(2)
    expect(await run("read", "codex")).toBe(2)
  })

  it("walks the whole demo: init, approve both, save, read, revoke, refused", async () => {
    expect(await run("init")).toBe(0)
    expect(await run("request", "claude-code")).toBe(0)
    expect(await run("approve", "claude-code")).toBe(0)
    expect(await run("save-demo", "claude-code", "proj-1")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(1)
    expect(await run("request", "codex")).toBe(0)
    expect(await run("approve", "codex")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(await run("revoke", "claude-code")).toBe(0)
    expect(await run("read", "claude-code", "proj-1")).toBe(1)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(lines.some((line) => line.includes("CAPABILITY_REVOKED"))).toBe(true)
  }, 300_000)

  it("kicks the daemon after a successful approve and revoke so the service notices, and never otherwise", async () => {
    const kicks: string[] = []
    const kick = () => (kicks.push("x"), Promise.resolve())
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: () => {}, kickDaemon: kick, prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    // request grants nothing by itself — no kick
    expect(await run2("request", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(1)
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(2)
    // a command that fails does not kick: claude-code has no pending request now
    expect(await run2("approve", "claude-code")).toBe(1)
    expect(kicks).toHaveLength(2)
    // undo the revoke so the last test's home still has a live agent
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve prints the ask and the advice, waits for 'yes', and signs nothing without it", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const answers: string[] = []
    const printedBeforeAsk: (string | undefined)[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); printedBeforeAsk.push(lines.at(-1)); return answers.shift() ?? "" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code is live from the tests above; a fresh ask needs a revoked agent first
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    answers.push("no")
    expect(await run2("approve", "claude-code")).toBe(1)
    // the owner saw the request, the advisor's read on it, and the question — then declined
    expect(lines.some((line) => line.includes("claude-code is asking for"))).toBe(true)
    expect(lines.some((line) => line.includes("grant advisor"))).toBe(true)
    expect(asked).toEqual(["Type yes to approve: "])
    // the disclosure is the last thing printed before the ask: plain text now, no recall later
    expect(printedBeforeAsk[0]).toBe("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
    expect(lines).toContain("not approved")
    // nothing was signed: the pending request is still there, waiting
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)
    // an explicit yes signs
    answers.push("yes")
    expect(await run2("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve, revoke and remember refuse when there is no real terminal; init is exempt", async () => {
    const refusals: string[] = []
    const noStdin = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => refusals.push(line), prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true })
    const noStdout = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => refusals.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: false })
    expect(await noStdin("approve", "claude-code")).toBe(2)
    expect(await noStdin("revoke", "claude-code")).toBe(2)
    expect(await noStdin("remember", "a fact")).toBe(2)
    expect(await noStdout("approve", "claude-code")).toBe(2)
    expect(refusals.filter((line) => line === NEEDS_TERMINAL_LINE)).toHaveLength(4)
    // init changes no agent's access, so it may run without a terminal
    expect(await noStdin("init")).toBe(0)
  }, 300_000)

  it("the yes-prompt drains whatever was already buffered before it asks, then waits for a fresh answer (R4-10)", async () => {
    const order: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: () => {},
        drainInput: async () => { order.push("drain") },
        prompt: async () => { order.push("prompt"); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a fresh ask needs a revoked-then-requested agent
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    // the drain ran before the question was printed — input pasted while approve ran is dropped
    expect(order).toEqual(["drain", "prompt"])
  }, 300_000)

  it("install claude-desktop registers its own identity, files the pending request and writes the client config (I1)", async () => {
    const lines: string[] = []
    const work = mkdtempSync(join(tmpdir(), "mida-desktop-work-"))
    mkdirSync(join(work, ".mida"))
    writeFileSync(join(work, ".mida", "project.json"), JSON.stringify({ projectId: "p-desktop" }))
    const config = join(mkdtempSync(join(tmpdir(), "mida-desktop-cfg-")), "claude_desktop_config.json")
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
        cwd: work, claudeDesktopConfig: config,
      })
    expect(await run2("install", "claude-desktop")).toBe(0)
    // the identity is the client's own — a project-context agent, never `assistant`
    const identity = loadAgentIdentity(home, "claude-desktop")
    expect(identity?.name).toBe("claude-desktop")
    expect(identity?.purposeId).not.toBe("general_assistance")
    // the pending request is what `mida approve claude-desktop` in this folder completes
    expect(home.has("agents/claude-desktop/pending-request.json")).toBe(true)
    const entry = JSON.parse(readFileSync(config, "utf8")).mcpServers["mida-claude-desktop"]
    expect(entry.args).toEqual(["--as", "claude-desktop", "--project", work])
    expect(entry.env).toEqual({ MIDA_HOME: home.root })
    expect(lines).toContain("next: run `mida approve claude-desktop` in this folder")
    // a re-run is a no-op: same file, no new identity, no second request
    expect(await run2("install", "claude-desktop")).toBe(0)
    expect(lines.filter((line) => line === "already installed")).toHaveLength(1)
    // the registered client name is a real approve target even though it is not a built-in agent
    expect(await run2("approve", "claude-desktop")).toBe(0)
    expect(lines.some((line) => line.startsWith("approved claude-desktop"))).toBe(true)
  }, 300_000)

  it("install cursor writes <cwd>/.cursor/mcp.json with ${workspaceFolder} and its own identity (I1)", async () => {
    const lines: string[] = []
    const work = mkdtempSync(join(tmpdir(), "mida-cursor-work-"))
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true, cwd: work,
      })
    expect(await run2("install", "cursor")).toBe(0)
    const entry = JSON.parse(readFileSync(join(work, ".cursor", "mcp.json"), "utf8")).mcpServers["mida-cursor"]
    expect(entry.args).toEqual(["--as", "cursor", "--project", "${workspaceFolder}"])
    expect(entry.env).toEqual({ MIDA_HOME: home.root })
    expect(loadAgentIdentity(home, "cursor")?.name).toBe("cursor")
    expect(lines).toContain("next: run `mida approve cursor` in this folder")
  }, 300_000)

  it("install <client> asks for a real terminal like approve, a non-client is usage, the daemon refuses it", async () => {
    const out: string[] = []
    expect(await runCli(["install", "cursor"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true,
      cwd: mkdtempSync(join(tmpdir(), "mida-cursor-work-")),
    })).toBe(2)
    expect(out).toEqual([NEEDS_TERMINAL_LINE])
    // there is no chatgpt client — the ChatGPT desktop app is the Codex app and runs as `codex`
    expect(await run("install", "chatgpt")).toBe(2)
    expect(lines.at(-1)).toBe(USAGE)
    // through the daemon's /cli route it is refused like every owner command
    const refused: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["install", "cursor"], stub, (line) => refused.push(line))).toBe(2)
    expect(refused[0]).toContain("mida install")
  })

  it("MIDA_DEBUG=1 prints a masked debug line on failure; unset prints nothing extra (R4-8)", async () => {
    const hex = `0x${"ab".repeat(40)}`
    const failingPrompt = async () => {
      throw new Error(`execution reverted: ${hex} with more data`)
    }
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => out.push(line),
        drainInput: async () => {},
        prompt: failingPrompt,
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code was approved by the test above — a fresh ask needs it revoked and re-requested
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    const prev = process.env.MIDA_DEBUG
    try {
      process.env.MIDA_DEBUG = "1"
      out.length = 0
      expect(await run2("approve", "claude-code")).toBe(1)
      const debug = out.find((line) => line.startsWith("debug:"))
      expect(debug).toBeDefined()
      expect(debug).toContain("<hex>")
      expect(debug).not.toContain(hex)
      expect(out.some((line) => line.startsWith("refused:"))).toBe(true)
      delete process.env.MIDA_DEBUG
      out.length = 0
      expect(await run2("approve", "claude-code")).toBe(1)
      expect(out.every((line) => !line.startsWith("debug:"))).toBe(true)
      expect(out.join("\n")).not.toContain(hex)
    } finally {
      if (prev === undefined) delete process.env.MIDA_DEBUG
      else process.env.MIDA_DEBUG = prev
    }
    // restore: the pending request is still waiting — approve it for real
    expect(await run("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("remember names the context area before the ask and after the write, and waits for a typed yes (R5-3)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const order: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network,
        print: (line) => {
          lines.push(line)
          if (line.startsWith("area:")) order.push("area")
        },
        prompt: async (question) => {
          asked.push(question)
          order.push("prompt")
          return "yes"
        },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await run2("remember", "prefers short answers")).toBe(0)
    // the owner saw WHERE the fact will live before being asked to confirm, and again after it landed
    expect(lines).toContain("area: preferences.communication (agents with READ on this area will see it)")
    expect(asked).toEqual(["Type yes to remember: "])
    expect(lines.at(-1)).toMatch(/^remembered 0x[0-9a-f]{64} in preferences\.communication$/)
    expect(order).toEqual(["area", "prompt", "area"])
  }, 300_000)

  it("an answer other than yes stores nothing (R5-3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "no", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("remember", "should never be stored")).toBe(1)
    expect(lines).toContain("area: preferences.communication (agents with READ on this area will see it)")
    expect(lines.some((line) => line.startsWith("remembered "))).toBe(false)
    // and the declined fact is really not there to read back
    lines.length = 0
    expect(await run2("read", "--as", "claude-code")).toBe(0)
    expect(lines.join("\n")).not.toContain("should never be stored")
  }, 300_000)

  it("mida read labels every item with the context area it lives in (R5-3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    // a fact from the remember test above, labelled with its area
    expect(await run2("read", "--as", "claude-code")).toBe(0)
    expect(lines).toContain("  preferences.communication: prefers short answers")
    // checkpoints carry their area too — resolved from the record's namespace id
    expect(await run2("save-demo", "claude-code", "proj-areas")).toBe(0)
    lines.length = 0
    expect(await run2("read", "claude-code", "proj-areas")).toBe(0)
    expect(lines.some((line) => /^  projects\.current: 0x[0-9a-f]{64} written by /.test(line))).toBe(true)
  }, 300_000)

  it("a namespace id the tree cannot name prints its first ten characters, never nothing (R5-3)", async () => {
    const { namespaceLabel } = await import("@mida/midad")
    const { namespaceId } = await import("@mida/protocol")
    expect(namespaceLabel(namespaceId("projects.current"))).toBe("projects.current")
    const foreign = `0x${"f1".repeat(32)}`
    expect(namespaceLabel(foreign)).toBe("0xf1f1f1f1…")
  })

  it("a refused wrap for one agent never hides the landed revoke — chain line first, then per-agent key lines (M3-D4)", async () => {
    // The Sep-22 incident: a revoke that failed after staging its deny left codex store-blocked,
    // and the NEXT revoke's repair pass aborted on codex's refused wrap — assistant never got the
    // new key and the printed line read "refused" for a revoke that had succeeded on chain.
    const runtime = await Runtime.open(home, network)
    try {
      const codexId = loadAgentIdentity(home, "codex")!.agentId
      await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId: codexId })
    } finally {
      await runtime.close()
    }

    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => out.push(line),
        progress: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    // the chain revoke succeeds — the exit code says so even though one wrap is refused
    expect(await run2("revoke", "claude-code")).toBe(0)
    // the chain answer leads: before any per-agent key line, and it is not "refused"
    const chainLine = out.findIndex((line) => line.startsWith("revoked claude-code on chain"))
    expect(chainLine).toBeGreaterThanOrEqual(0)
    expect(out[chainLine]).toMatch(/— tx 0x[0-9a-f]{64}/)
    // right after the tx line: what revoking does and does not do (T7)
    expect(out[chainLine + 1]).toBe("This stops future reads through Mida. It does not erase what claude-code already read.")
    // assistant got the new key; codex's refused wrap names its fix — and nothing calls the whole
    // revoke refused
    expect(out).toContain("new read key sent to assistant")
    const failedLine = out.find((line) => line.startsWith("could not send the new key to codex:"))
    expect(failedLine).toBeDefined()
    expect(failedLine).toContain("run `mida approve codex`")
    expect(out.every((line) => !line.startsWith("refused:"))).toBe(true)
    for (const keyLine of ["new read key sent to assistant", failedLine!]) {
      expect(out.indexOf(keyLine)).toBeGreaterThan(chainLine)
    }

    // cleanup, by the command the line itself names: approve clears the stale deny
    expect(await run2("approve", "codex")).toBe(1) // already-approved answer — the deny is gone first
    expect(out.some((line) => line === "cleared a stale block at the store left by a failed revoke")).toBe(true)
    // and claude-code's revoke really did land — reads stay refused
    expect(await run2("read", "claude-code", "proj-1")).toBe(1)
  }, 300_000)

  it("an already-approved approve says what the folder listing did — never 'run the command you just ran' (M3-D4)", async () => {
    // The Sep-22 incident's second lie: approve answered "already approved — to use THIS folder,
    // run mida approve codex here", naming the very command that was just run. Now the line says
    // whether the folder's list row was added or was already there.
    const dir = mkdtempSync(join(tmpdir(), "mida-proj-"))
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        cwd: dir,
        print: (line) => out.push(line),
        progress: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    expect(await run2("approve", "codex")).toBe(0)
    expect(out).toContain("codex is already approved on chain. This folder is now approved for codex too (no transaction).")
    out.length = 0
    expect(await run2("approve", "codex")).toBe(0)
    expect(out).toContain("codex is already approved on chain. This folder was already approved for codex.")
    // and neither answer tells the owner to re-run the command they just ran
    expect(out.every((line) => !line.includes("run `mida approve codex` here"))).toBe(true)
  }, 300_000)

  it("migrate is an owner command: a real terminal is required and the daemon socket refuses it", async () => {
    const out: string[] = []
    const noTty = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => out.push(line), prompt: async () => "yes",
        stdinIsTTY: false, stdoutIsTTY: true, env: {}, migrateTarget: env.deployment, startService: () => {},
      })
    expect(await noTty("migrate")).toBe(2)
    expect(await noTty("migrate", "--undo")).toBe(2)
    expect(out.filter((line) => line === NEEDS_TERMINAL_LINE)).toHaveLength(2)
    // through the daemon's /cli route it is refused like every owner command
    const refused: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["migrate"], stub, (line) => refused.push(line))).toBe(2)
    expect(refused[0]).toContain("mida migrate")
    expect(await runCliWithRuntime(["migrate", "--undo"], stub, () => {})).toBe(2)
    // a flag it does not know is usage, not a half-run
    expect(await run("migrate", "--sideways")).toBe(2)
  })

  it("mida migrate says there is nothing to move when the saved contract is already the target", async () => {
    const out: string[] = []
    const code = await runCli(["migrate"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      env: {}, migrateTarget: env.deployment, startService: () => {},
    })
    expect(code).toBe(0)
    expect(out.join("\n")).toContain("nothing to move")
  }, 300_000)

  it("mida migrate --undo refuses when no backup exists", async () => {
    const out: string[] = []
    const code = await runCli(["migrate", "--undo"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      env: {}, migrateTarget: env.deployment, startService: () => {},
    })
    expect(code).toBe(1)
    expect(out.join("\n").toLowerCase()).toContain("backup")
  }, 300_000)

  it("a mismatched setup tells migrate what it is moving — never 'run mida migrate' — while other commands keep the old notice", () => {
    const resolved = {
      network: {}, saved: true, contractSource: "network.json", builtIn: {},
      mismatch: {
        saved: "0xaaaa00000000000000000000000000000000aa",
        builtIn: "0xbbbb00000000000000000000000000000000bb",
      },
      storage: { url: undefined, source: "local" },
      sponsor: { url: undefined, source: "local" },
    } as unknown as ResolvedNetwork
    const move = ownerCommandNotice(resolved, "migrate")
    expect(move).toBe("moving this setup from contract 0xaaaa… to 0xbbbb…")
    expect(move).not.toContain("mida migrate")
    // every other owner command still hears the pointer to migrate
    const other = ownerCommandNotice(resolved, "approve")
    expect(other).toContain("run `mida migrate`")
    // and a setup that matches the built-in contract hears nothing at all
    expect(ownerCommandNotice({ ...resolved, mismatch: undefined } as ResolvedNetwork, "migrate")).toBeUndefined()
  })

  it("approve --all lists every pending request, asks once, and approves each (I3)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // two pending: claude-code is still revoked from the revoke test above, so a request files
    // a fresh one; cursor's pending request is the one `mida install cursor` left behind
    expect(await run2("request", "claude-code")).toBe(0)
    expect(home.has("agents/cursor/pending-request.json")).toBe(true)
    expect(await run2("approve", "--all")).toBe(0)
    // one list, then the single shared ask — never a per-agent prompt
    expect(asked).toEqual(["Type yes to approve all: "])
    expect(lines.filter((line) => line.endsWith("is asking for:")).length).toBe(2)
    expect(lines.filter((line) => line.startsWith("It will see this context as plain text.")).length).toBe(1)
    expect(lines.some((line) => line.startsWith("approved claude-code"))).toBe(true)
    expect(lines.some((line) => line.startsWith("approved cursor"))).toBe(true)
    expect(lines.at(-1)).toBe("approved: claude-code, cursor")
    // both pending files are consumed — nothing waits anymore
    expect(home.has("agents/claude-code/pending-request.json")).toBe(false)
    expect(home.has("agents/cursor/pending-request.json")).toBe(false)
    // and the nothing-pending answer is honest: exit 0, no prompt at all
    asked.length = 0
    expect(await run2("approve", "--all")).toBe(0)
    expect(asked).toHaveLength(0)
    expect(lines.at(-1)).toBe("nothing to approve — no agent has a pending request")
  }, 300_000)

  it("approve --all with anything but yes approves nobody (I3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "no",
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a fresh pending request for a revoked agent — claude-code was approved above, so revoke first
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "--all")).toBe(1)
    expect(lines).toContain("not approved")
    expect(lines.some((line) => line.startsWith("approved claude-code"))).toBe(false)
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)
    // restore: a yes approves it for real
    expect(await run("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve --all continues past a failing agent — the summary names both (I3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // codex real-pending (it is live, so revoke+request); cursor gets a stale file whose
    // requestId the store never held — approve refuses it with no-pending-request
    expect(await run2("revoke", "codex")).toBe(0)
    expect(await run2("request", "codex")).toBe(0)
    home.writeSecretJson("agents/cursor/pending-request.json", {
      request: {
        requestId: `0x${"ab".repeat(32)}`,
        scopes: [{ namespaceId: `0x${"11".repeat(32)}`, permissions: 1, provenancePolicy: 0 }],
        capabilityExpiresAt: "1999999999",
      },
    })
    expect(await run2("approve", "--all")).toBe(1)
    expect(lines.some((line) => line.startsWith("approved codex"))).toBe(true)
    expect(lines).toContain("cursor has no pending request — run `mida request cursor` first")
    expect(lines.at(-1)).toBe("approved: codex; failed: cursor (no-pending-request)")
    expect(home.has("agents/codex/pending-request.json")).toBe(false)
    home.remove("agents/cursor/pending-request.json")
  }, 300_000)

  it("approve --all runs the grant advisor per agent and never sends an expired request", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a real pending request for claude-code — then its validity window is moved into the past
    // and it is re-signed with the agent's own signer key, so the advisor's freshness check is
    // the only thing that refuses it
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    const identity = loadAgentIdentity(home, "claude-code")!
    const original = home.readJson<{ request: AccessRequest }>("agents/claude-code/pending-request.json")!.request
    const { agentSignature: _dropped, ...unsigned } = original
    const now = BigInt(Math.floor(Date.now() / 1000))
    const stale = {
      ...unsigned,
      requestId: `0x${"ee".repeat(32)}` as Hex,
      issuedAt: encodeUint64(now - 400n),
      requestExpiresAt: encodeUint64(now - 300n),
    }
    const expired = { ...stale, agentSignature: await privateKeyToAccount(identity.signerPrivateKey).signTypedData(accessRequestTypedData(stale)) }
    await new FileAccessRequestStore(home, "claude-code").save(expired)
    home.writeSecretJson("agents/claude-code/pending-request.json", { request: expired })

    // the expired request is named and excluded BEFORE the ask — no prompt, nothing signed
    expect(await run2("approve", "--all")).toBe(1)
    expect(asked).toHaveLength(0)
    expect(lines.some((line) => line.includes("claude-code") && line.includes("has expired") && line.includes("`mida request claude-code`"))).toBe(true)
    expect(lines.at(-1)).toBe("approved: none; failed: claude-code (REQUEST_EXPIRED)")
    // and the stale request still waits — nothing consumed it
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)

    // a fresh request passes the advisor; its verdict is part of the one combined list
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "--all")).toBe(0)
    expect(lines.some((line) => line.startsWith("grant advisor:"))).toBe(true)
    expect(lines.at(-1)).toBe("approved: claude-code")
  }, 300_000)

  it("a partial approve --all still kicks the daemon — one agent's grant landed", async () => {
    const kicks: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: () => {}, kickDaemon: () => kicks.push("x"),
        prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code re-requested for a real approval; cursor's stale file fails the store lookup
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    home.writeSecretJson("agents/cursor/pending-request.json", {
      request: {
        requestId: `0x${"cd".repeat(32)}`,
        scopes: [{ namespaceId: `0x${"11".repeat(32)}`, permissions: 1, provenancePolicy: 0 }],
        capabilityExpiresAt: "1999999999",
      },
    })
    kicks.length = 0
    expect(await run2("approve", "--all")).toBe(1)
    // claude-code's approve landed, so the daemon was poked even though the batch exits 1
    expect(kicks).toHaveLength(1)
    home.remove("agents/cursor/pending-request.json")
  }, 300_000)

  it("revoke --all lists every approved agent, asks once, and revokes each (I4)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    let lastBeforeAsk: string | undefined
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); lastBeforeAsk = lines.at(-1); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // every agent that still holds an approval: the four project agents above plus assistant,
    // whose general-assistance grant init sent at the start of this file
    expect(await run2("revoke", "--all")).toBe(0)
    expect(asked).toEqual(["Type yes to revoke all: "])
    for (const name of ["assistant", "claude-code", "claude-desktop", "codex", "cursor"]) {
      expect(lines).toContain(`${name} holds an approval`)
      expect(lines.some((line) => line.startsWith(`revoked ${name} on chain`))).toBe(true)
      expect(lines).toContain(`This stops future reads through Mida. It does not erase what ${name} already read.`)
    }
    // the whole list printed before the single ask — nothing was revoked sight-unseen
    expect(lastBeforeAsk).toBe("cursor holds an approval")
    expect(lines.at(-1)).toBe("revoked: assistant, claude-code, claude-desktop, codex, cursor")
    // and a revocation is real: claude-code's read is refused now
    expect(await run2("read", "claude-code", "proj-1")).toBe(1)
    // a second run finds nobody approved — exit 0, no prompt at all
    asked.length = 0
    expect(await run2("revoke", "--all")).toBe(0)
    expect(asked).toHaveLength(0)
    expect(lines.at(-1)).toBe("nothing to revoke — no agent in this Mida home holds an approval")
  }, 300_000)

  it("revoke --all with anything but yes revokes nobody (I4)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        // yes to a single agent's own ask; the batch question is the one this test declines
        prompt: async (question) => { asked.push(question); return question === "Type yes to revoke all: " ? "no" : "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // re-approve one agent so the list is not empty — everything was revoked above
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    asked.length = 0
    expect(await run2("revoke", "--all")).toBe(1)
    expect(asked).toEqual(["Type yes to revoke all: "])
    expect(lines).toContain("claude-code holds an approval")
    expect(lines).toContain("not revoked")
    expect(lines.some((line) => line.startsWith("revoked "))).toBe(false)
    // still really approved: no marker, and the read still goes through
    expect(home.has("agents/claude-code/revoked.json")).toBe(false)
    expect(await run2("read", "claude-code", "proj-1")).toBe(0)
    // restore the all-revoked state the next test builds on
    expect(await run2("revoke", "claude-code")).toBe(0)
  }, 300_000)

  it("revoke --all continues past a failing agent — the summary names both (I4)", async () => {
    const lines: string[] = []
    const kicks: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        kickDaemon: () => kicks.push("x"),
        prompt: async (question) => {
          // cursor's records vanish between the batch's list and its turn — the batch must survive it
          if (question === "Type yes to revoke all: ") {
            for (const file of ["identity.json", "signer.json", "grants.json"]) home.remove(`agents/cursor/${file}`)
          }
          return "yes"
        },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // codex is really approved again; cursor is listed off the grants.json its revoke left —
    // clearing the marker is exactly what `mida approve` does when it re-grants
    expect(await run2("request", "codex")).toBe(0)
    expect(await run2("approve", "codex")).toBe(0)
    home.remove("agents/cursor/revoked.json")
    kicks.length = 0
    expect(await run2("revoke", "--all")).toBe(1)
    expect(lines.some((line) => line.startsWith("revoked codex on chain"))).toBe(true)
    expect(lines).toContain("cursor is not set up on this machine — run `mida init` first")
    expect(lines.at(-1)).toBe("revoked: codex; failed: cursor (agent-unidentified)")
    // codex's revoke really landed even though cursor's failed — marker written, daemon poked
    expect(home.has("agents/codex/revoked.json")).toBe(true)
    expect(kicks).toHaveLength(1)
  }, 300_000)

  it("revoke --all scans every agents folder — a stray grant is listed, an expired grant is not, a broken identity is named", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    const owner = loadOwnerAddress(home)!
    const grant = (agentId: Hex, expiresAt: string) => [
      {
        owner,
        agentId,
        requestId: `0x${"33".repeat(32)}`,
        capabilities: [
          {
            namespaceId: `0x${"55".repeat(32)}`,
            permissions: 1,
            provenancePolicy: 0,
            expiresAt,
            capabilityId: `0x${"66".repeat(32)}`,
            transactionHash: `0x${"77".repeat(32)}`,
          },
        ],
      },
    ]
    // stray: no identity.json at all — grants.json alone must still put it on the list
    home.writeSecretJson("agents/stray/grants.json", grant(`0x${"44".repeat(32)}` as Hex, "0"))
    // stale: a loadable identity, but its only grant record expired long ago — not an approval
    saveAgentIdentity(home, {
      name: "stale",
      agentId: `0x${"88".repeat(32)}` as Hex,
      signerPrivateKey: `0x${"99".repeat(32)}` as Hex,
      encryptionPrivateKey: `0x${"aa".repeat(32)}` as Hex,
      encryptionPublicKey: `0x${"bb".repeat(32)}` as Hex,
      callbackOrigin: "https://stale.mida.example",
      purposeId: "project_assistance",
      manifest: {} as never,
      manifestHash: `0x${"cc".repeat(32)}` as Hex,
    })
    home.writeSecretJson("agents/stale/grants.json", grant(`0x${"88".repeat(32)}` as Hex, "1700000000"))
    // cursor's folder survives the earlier test empty — an agent whose identity cannot be loaded
    // is reported by name, never silently dropped from the scan
    expect(home.has("agents/cursor/identity.json")).toBe(false)

    expect(await run2("revoke", "--all")).toBe(1)
    expect(lines).toContain("stray holds an approval")
    expect(lines).not.toContain("stale holds an approval")
    expect(lines).toContain("cursor is not set up on this machine — run `mida init` first")
    expect(asked).toEqual(["Type yes to revoke all: "])
    // stray's listed grant turns out to hold nothing on chain — reported, not counted as revoked
    expect(lines).toContain("stray: nothing to revoke")
    expect(lines.at(-1)).toBe("revoked: none; failed: cursor (agent-unidentified)")
    home.remove("agents/stray/grants.json")
    home.remove("agents/stray/revoked.json")
    home.remove("agents/stale/grants.json")
    home.remove("agents/stale/identity.json")
  }, 300_000)

  it("never prints a secret: no output line contains any key stored in the home folder", () => {
    const secrets: string[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder)) {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== "data") walk(full)
        } else if (/secrets|signer|identity/.test(entry)) {
          const text = readFileSync(full, "utf8")
          for (const match of text.matchAll(/"(?:privateKey|seed|p256PrivateKey|signerPrivateKey|encryptionPrivateKey)":\s*"(0x[0-9a-f]{64})"/g)) secrets.push(match[1]!)
        }
      }
    }
    walk(home.root)
    expect(secrets.length).toBeGreaterThanOrEqual(8)
    const output = lines.join("\n")
    for (const secret of secrets) expect(output.includes(secret)).toBe(false)
  })
})

/**
 * CHAIN-09 — the Sep 22 incident: `mida request claude-code` printed `refused: ERROR` and nothing
 * else because the chain call had failed with an error Mida did not recognise. Now a chain error
 * names the setup's contract and the flag that shows why; a debug context appends the masked line.
 */
describe("named refusals on agent commands (CHAIN-09)", () => {
  const REGISTRY = "0xf07d000000000000000000000000000000000042"
  const stubRuntime = (thrown: unknown) =>
    ({
      home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-refusal-"))),
      chain: { deployment: { capabilityRegistry: REGISTRY } },
      agent: () => {
        throw thrown
      },
    }) as unknown as ServiceRuntime

  it("a chain error prints the contract line, never refused: ERROR", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new BaseError("boom")), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      "the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why",
    ])
    expect(lines.join("\n")).not.toContain("ERROR")
  })

  it("a non-chain error is refused: UNEXPECTED, never refused: ERROR", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new Error("weird")), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual(["refused: UNEXPECTED"])
  })

  it("with debug on, the catch also prints exactly one masked debug: line", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["request", "claude-code"],
      stubRuntime(new BaseError("boom")),
      (line) => lines.push(line),
      { debug: true },
    )
    expect(code).toBe(1)
    expect(lines.filter((line) => line.startsWith("debug:"))).toHaveLength(1)
    expect(lines[0]).toBe("the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why")
    expect(lines[1]).toBe("debug: BaseError | boom")
  })

  it("without debug there is no debug: line and no error message", async () => {
    const lines: string[] = []
    await runCliWithRuntime(["request", "claude-code"], stubRuntime(new BaseError("a secret reason")), (line) => lines.push(line), {
      debug: false,
    })
    expect(lines.every((line) => !line.startsWith("debug:"))).toBe(true)
    expect(lines.join("\n")).not.toContain("a secret reason")
  })

  it("mida read --as <unregistered> prints the no-identity line, not a bare code", async () => {
    const stub = stubRuntime(new Error("unreached"))
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "ghost", "projects.current"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([`Mida: no agent "ghost" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
    expect(lines.every((line) => !line.startsWith("refused:"))).toBe(true)
  })

  it("mida read --as <corrupt identity> says the file exists but cannot be read — never 'not set up'", async () => {
    const stub = stubRuntime(new Error("unreached"))
    mkdirSync(join(stub.home.root, "agents", "corrupt"), { recursive: true })
    writeFileSync(join(stub.home.root, "agents", "corrupt", "identity.json"), "not json")
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "corrupt", "projects.current"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      `Mida: corrupt's identity in this Mida home (${stub.home.root}) exists but could not be read. Nothing was shared. Run \`mida doctor\`.`,
    ])
  })

  it("an agent name that cannot be an identity is still usage — never read under it", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "a b"], stubRuntime(new Error("unreached")), (line) => lines.push(line))
    expect(code).toBe(2)
    expect(lines).toEqual([USAGE])
  })

  it("the read --as name rule matches the MCP and key-store cap: 65 chars is usage, 64 proceeds (F9)", async () => {
    const stub = stubRuntime(new Error("unreached"))
    const lines: string[] = []
    const over = await runCliWithRuntime(["read", "--as", "a".repeat(65), "projects.current"], stub, (line) => lines.push(line))
    expect(over).toBe(2)
    expect(lines).toEqual([USAGE])
    lines.length = 0
    const at = await runCliWithRuntime(["read", "--as", "a".repeat(64), "projects.current"], stub, (line) => lines.push(line))
    // 64 chars is a legal name that is simply unregistered — the identity gate answers, not usage
    expect(at).toBe(1)
    expect(lines).toEqual([`Mida: no agent "${"a".repeat(64)}" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
  })

  it("a read whose agent's identity is gone prints the same no-identity line", async () => {
    const notSetup = Object.assign(new Error("gone"), { code: "agent-not-setup" })
    const stub = stubRuntime(notSetup)
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "codex", "p1"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([`Mida: no agent "codex" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
  })

  /** A loadable identity file — the fields loadAgentIdentity checks, nothing more. */
  const writeIdentity = (home: MidaHome, name: string, purposeId = "project_assistance") => {
    const key = `0x${"ab".repeat(32)}`
    mkdirSync(join(home.root, "agents", name), { recursive: true })
    writeFileSync(
      join(home.root, "agents", name, "identity.json"),
      JSON.stringify({
        name,
        agentId: key,
        signerPrivateKey: key,
        encryptionPrivateKey: key,
        encryptionPublicKey: key,
        manifestHash: key,
        callbackOrigin: "http://localhost",
        purposeId,
        manifest: {},
      }),
    )
  }
  /** A folder carrying a project marker with the given id. */
  const markedFolder = (projectId: string) => {
    const dir = mkdtempSync(join(tmpdir(), "mida-f7-proj-"))
    mkdirSync(join(dir, ".mida"))
    writeFileSync(join(dir, ".mida", "project.json"), JSON.stringify({ projectId }))
    return dir
  }

  it("read --as projects.current refuses when this folder is not approved for the agent (F7)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-f7-")))
    writeIdentity(home, "reader")
    // the stub carries no store or reader: if the refusal were skipped, readCheckpoints would
    // throw and the catch would print "refused: …" — the assertion would fail loudly
    const stub = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as ServiceRuntime
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["read", "--as", "reader", "projects.current"],
      stub,
      (line) => lines.push(line),
      { cwd: markedFolder("p1") },
    )
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("an approval for a different folder does not open this folder's checkpoint list (F7)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-f7-")))
    writeIdentity(home, "reader")
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const stub = { home, owner } as unknown as ServiceRuntime
    // approve the agent on one folder…
    const approved = mkdtempSync(join(tmpdir(), "mida-f7-approved-"))
    await approveProject(stub as unknown as Runtime, { agent: "reader", cwd: approved })
    const marker = JSON.parse(readFileSync(join(approved, ".mida", "project.json"), "utf8")) as { projectId: string }
    // …then read from a different folder that carries the same project id — folder-mismatch
    const other = markedFolder(marker.projectId)
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["read", "--as", "reader", "projects.current"],
      stub,
      (line) => lines.push(line),
      { cwd: other },
    )
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: reader is not approved for this project — run `mida approve reader` in this folder."])
  })

  it("read --as assistant projects.current names the real fix, never request+approve assistant (G8)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g8-")))
    writeIdentity(home, "assistant", "general_assistance")
    const stub = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as ServiceRuntime
    const lines: string[] = []
    // a folder with no .mida marker anywhere — the "make it one" hint must not loop the owner
    // into approving an identity that can never hold a project row
    const code = await runCliWithRuntime(
      ["read", "--as", "assistant", "projects.current"],
      stub,
      (line) => lines.push(line),
      { cwd: mkdtempSync(join(tmpdir(), "mida-g8-unmarked-")) },
    )
    expect(lines).toEqual(["Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`."])
    expect(code).toBe(0)
  })

  it("request assistant answers the general-assistant line — never 'run mida approve assistant' (G8)", async () => {
    const already = Object.assign(new Error("already approved"), { code: "already-approved" })
    // the chain answers "nothing live" so the request reaches the already-approved throw
    const stub = Object.assign(stubRuntime(already), { reader: { activeCapabilityIds: async () => [] } })
    writeIdentity(stub.home, "assistant", "general_assistance")
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "assistant"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual(["Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`."])
  })

  it("ownerRefusalLine's already-approved arm names the real fix for assistant too (G8)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-g8-")))
    writeIdentity(home, "assistant", "general_assistance")
    const already = Object.assign(new Error("already approved"), { code: "already-approved" })
    expect(ownerRefusalLine("request", "assistant", already, undefined, undefined, home)).toBe(
      "Mida: assistant is a general assistant and cannot read project context — run `mida install <client>`.",
    )
    // a real project-context agent keeps the approve hint
    writeIdentity(home, "codex")
    expect(ownerRefusalLine("request", "codex", already, undefined, undefined, home)).toBe(
      "codex is already approved on chain. To use it in THIS folder, run `mida approve codex` here (no transaction, nothing to pay).",
    )
  })
})
