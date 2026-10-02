import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  NEEDS_TERMINAL_LINE,
  ServiceRuntime,
  USAGE,
  listAgentNames,
  loadAgentIdentity,
  ownerOnlyLine,
  runCli,
  runCliWithRuntime,
} from "@mida/midad"
import type { Network } from "@mida/midad"

/**
 * `mida add-agent <name>` — provisions a project-context identity for an agent that is not one
 * of the tools init or install already knows. An owner command like approve: real terminal,
 * typed yes, and the new agent requests/approves like any other once it exists.
 */
describe("mida add-agent", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let projectDir: string
  const lines: string[] = []

  const run = (...argv: string[]) =>
    runCli(argv, {
      home,
      network,
      cwd: projectDir,
      print: (line) => lines.push(line),
      prompt: async () => "yes",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-addagent-")))
    projectDir = mkdtempSync(join(tmpdir(), "mida-addagent-proj-"))
    expect(await run("init")).toBe(0)
  }, 600_000)

  afterAll(async () => {
    await env?.stop()
  })

  it("refuses a missing argument, a built-in name and a malformed name — before any prompt", async () => {
    const start = lines.length
    expect(await run("add-agent")).toBe(2)
    for (const name of ["codex", "claude-code", "assistant", "devin", "cursor", "claude-desktop"]) {
      expect(await run("add-agent", name)).toBe(1)
      expect(lines.at(-1)).toContain(`${name} is a built-in agent`)
    }
    for (const name of ["Capital", "-leading-dash", "with_underscore", "with space", "x".repeat(41), ""]) {
      expect(await run("add-agent", name)).toBe(1)
      expect(lines.at(-1)).toContain("agent names match")
    }
    // nothing was provisioned for any of them — no new identity files appeared
    expect(listAgentNames(home).sort()).toEqual(["assistant", "claude-code", "codex"])
    void start
  }, 120_000)

  it("provisions a new identity only after a typed yes", async () => {
    const asked: string[] = []
    let answer = "no"
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        cwd: projectDir,
        print: (line) => lines.push(line),
        prompt: async (question) => {
          asked.push(question)
          return answer
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    expect(await run2("add-agent", "my-sdk-agent")).toBe(1)
    expect(asked).toEqual(["Type yes to add my-sdk-agent: "])
    expect(lines).toContain("not approved")
    // the owner declined — no identity, no chain row
    expect(home.has("agents/my-sdk-agent/identity.json")).toBe(false)
    answer = "yes"
    expect(await run2("add-agent", "my-sdk-agent")).toBe(0)
    const identity = loadAgentIdentity(home, "my-sdk-agent")
    expect(identity?.purposeId).toBe("project_assistance")
    expect(lines.at(-1)).toContain("my-sdk-agent")
  }, 300_000)

  it("refuses a name that already has an identity", async () => {
    expect(await run("add-agent", "my-sdk-agent")).toBe(1)
    expect(lines.at(-1)).toContain("already")
  }, 120_000)

  it("the new agent requests and approves like any other", async () => {
    expect(await run("request", "my-sdk-agent")).toBe(0)
    expect(await run("approve", "my-sdk-agent")).toBe(0)
  }, 300_000)

  it("never runs without a real terminal and never through the daemon socket", async () => {
    const refused: string[] = []
    expect(
      await runCli(["add-agent", "other-agent"], {
        home,
        network,
        print: (line) => refused.push(line),
        prompt: async () => "yes",
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    ).toBe(2)
    expect(refused).toContain(NEEDS_TERMINAL_LINE)
    // the socket route accepts the word but the service runtime refuses it like every owner command
    const session = await ServiceRuntime.open(home, network)
    try {
      const socketLines: string[] = []
      expect(await runCliWithRuntime(["add-agent", "other-agent"], session, (line) => socketLines.push(line))).toBe(2)
      expect(socketLines).toEqual([ownerOnlyLine("add-agent")])
    } finally {
      await session.close()
    }
    expect(home.has("agents/other-agent/identity.json")).toBe(false)
  }, 120_000)

  it("keeps usage honest", () => {
    expect(USAGE).toContain("add-agent")
  })
})
