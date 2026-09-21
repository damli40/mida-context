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
