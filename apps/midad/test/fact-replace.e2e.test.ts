import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { Hex } from "@mida/protocol"
import {
  MidaHome, Runtime, approve, buildHandoff, factShortId, init, ownerOnlyLine,
  readOwnerFacts, remember, requestAccess, runCli, runCliWithRuntime, saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 120_000

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

/**
 * in-4 I9 — the scenario the adversarial probes ran by hand (zz-probe-current), now asserted:
 * the owner says Python, then replaces it with TypeScript through
 * `mida remember --replaces <short-id>`. The chain's supersede path records new-replaces-old —
 * the old record stays anchored as history — and every fact surface agrees on what follows:
 * the handoff lists only the current fact, `mida read --as` lists both with the old one marked
 * "(replaced by <short-id> on <date>)", and a target the owner cannot name exactly is refused
 * before anything is signed.
 */
describe("mida remember --replaces on local Anvil (in-4 I9)", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  let workDir: string

  beforeAll(async () => {
    env = await localEnvironment()
    // a shared store, not the per-home embedded one: `runCli` opens its own Runtime per call, and
    // two runtimes over one home only agree when the API lives outside the home's lock
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-replace-")))
    runtime = await Runtime.open(home, network)
    workDir = join(mkdtempSync(join(tmpdir(), "mida-replace-work-")), "work")
    mark(workDir, "proj-replace")
    await init(runtime, ["claude-code", "codex", "assistant"])
    await requestAccess(runtime, "claude-code")
    await approve(runtime, "claude-code", workDir)
    await requestAccess(runtime, "codex")
    await approve(runtime, "codex")
  }, STEP_TIMEOUT * 4)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  const ownerCli = (argv: string[]) => {
    const lines: string[] = []
    const asked: string[] = []
    const run = runCli(argv, {
      home,
      network,
      print: (line) => lines.push(line),
      prompt: async (question) => {
        asked.push(question)
        return "yes"
      },
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })
    return { run, lines, asked }
  }

  it("replaces Python with TypeScript: chain supersede, handoff shows only the new fact, read --as marks the old one", async () => {
    const python = await remember(runtime, "I prefer Python")
    expect(python.kind).toBe("remembered")
    if (python.kind !== "remembered") return
    const pythonShort = factShortId(python.contextId)

    const { run, lines, asked } = ownerCli(["remember", "--replaces", pythonShort, "I prefer TypeScript now"])
    expect(await run).toBe(0)
    // the same typed-yes rule as plain remember — nothing signs without it
    expect(asked).toEqual(["Type yes to remember: "])
    const rememberedLine = lines.find((line) => line.startsWith("remembered "))!
    expect(rememberedLine).toBeDefined()
    const tsId = `0x${rememberedLine.slice("remembered 0x".length, "remembered 0x".length + 64)}` as Hex
    const tsShort = factShortId(tsId)

    // the chain itself recorded new-replaces-old: same lineage, the old record as parent, v2
    const tsRecord = await runtime.reader.getRecord(tsId)
    const pyRecord = await runtime.reader.getRecord(python.contextId)
    expect(tsRecord).not.toBeNull()
    expect(tsRecord!.parentId).toBe(python.contextId)
    expect(tsRecord!.lineageId).toBe(pyRecord!.lineageId)
    expect(tsRecord!.version).toBe(2)
    const replacedOn = `${new Date(Number(tsRecord!.createdAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`

    // current facts: only the lineage head
    const current = await readOwnerFacts(runtime, "codex")
    expect(current.map((fact) => fact.text)).toContain("I prefer TypeScript now")
    expect(current.map((fact) => fact.text)).not.toContain("I prefer Python")

    // history: both, the old one annotated with the child's short id and chain date
    const history = await readOwnerFacts(runtime, "codex", { history: true })
    const old = history.find((fact) => fact.text === "I prefer Python")!
    expect(old.replacedBy).toBeDefined()
    expect(old.replacedBy!.contextId).toBe(tsId)
    expect(old.replacedBy!.assertedAt).toBe(new Date(Number(tsRecord!.createdAt) * 1000).toISOString())

    // a checkpoint is what turns buildHandoff's empty answer into a handoff
    await saveCheckpoint(runtime, "claude-code", {
      projectId: "proj-replace",
      sessionId: "s-replace",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ eventId: "cp-replace-01", objective: "hand off after a replace", nextAction: "read it" }),
    })
    const handoff = await buildHandoff(runtime, { agent: "claude-code", cwd: workDir, authorNames: {} })
    expect(handoff.kind).toBe("handoff")
    if (handoff.kind !== "handoff") return
    expect(handoff.text).toContain("I prefer TypeScript now")
    expect(handoff.text).not.toContain("I prefer Python")
    const tsFact = history.find((fact) => fact.text === "I prefer TypeScript now")!
    expect(handoff.text).toContain(`- stated by you: I prefer TypeScript now (id ${tsShort}, ${tsFact.assertedAt.slice(0, 16).replace("T", " ")} UTC)`)

    // `mida read --as` keeps every fact — the replaced one carries its marker
    const readLines: string[] = []
    expect(await runCliWithRuntime(["read", "--as", "assistant"], runtime, (line) => readLines.push(line))).toBe(0)
    const pyLine = readLines.find((line) => line.includes("I prefer Python"))!
    const tsLine = readLines.find((line) => line.includes("I prefer TypeScript now"))!
    expect(pyLine).toBeDefined()
    expect(tsLine).toBeDefined()
    expect(pyLine).toContain(`(id ${pythonShort},`)
    expect(pyLine).toContain(`(replaced by ${tsShort} on ${replacedOn})`)
    expect(tsLine).toContain(`(id ${tsShort},`)
    expect(tsLine).not.toContain("replaced by")

    // the agent name only decides the lens, not the history: another agent's read --as
    // shows the same annotated list
    const agentReadLines: string[] = []
    expect(await runCliWithRuntime(["read", "--as", "claude-code"], runtime, (line) => agentReadLines.push(line))).toBe(0)
    expect(agentReadLines.find((line) => line.includes("I prefer Python"))).toContain(`(replaced by ${tsShort} on ${replacedOn})`)
  }, STEP_TIMEOUT * 3)

  it("an id that names no fact refuses before the ask — and a fact already replaced refuses too", async () => {
    const unknown = ownerCli(["remember", "--replaces", "deadbeef", "I prefer Rust now"])
    expect(await unknown.run).toBe(1)
    expect(unknown.lines.some((line) => line.startsWith("refused: unknown-fact-id"))).toBe(true)
    expect(unknown.asked).toEqual([]) // refused before any "Type yes"

    // the Python fact from the first test is history now — replacing IT again refuses cleanly
    const python = (await readOwnerFacts(runtime, "codex", { history: true })).find((fact) => fact.text === "I prefer Python")!
    const stale = ownerCli(["remember", "--replaces", factShortId(python.contextId), "I prefer Go now"])
    expect(await stale.run).toBe(1)
    expect(stale.lines.some((line) => line.startsWith("refused: fact-already-replaced"))).toBe(true)
    expect(stale.asked).toEqual([])

    // and the supersede really is the same owner gate: inside an agent it is an owner command
    const agentLines: string[] = []
    expect(await runCliWithRuntime(["remember", "--replaces", "abcd1234", "sneaky fact"], runtime, (line) => agentLines.push(line))).toBe(2)
    expect(agentLines).toEqual([ownerOnlyLine("remember")])
    // and without a real terminal it never reaches the prompt either
    const ttyLines: string[] = []
    expect(
      await runCli(["remember", "--replaces", "abcd1234", "sneaky fact"], {
        home,
        network,
        print: (line) => ttyLines.push(line),
        prompt: async () => "yes",
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    ).toBe(2)
  }, STEP_TIMEOUT)
})
