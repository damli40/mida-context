import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, NEEDS_TERMINAL_LINE, runCli } from "@mida/midad"
import type { Network } from "@mida/midad"

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
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return answers.shift() ?? "" },
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
