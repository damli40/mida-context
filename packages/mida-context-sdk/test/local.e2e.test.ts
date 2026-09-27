import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  MidaHome,
  Runtime,
  approve,
  callDaemon,
  init,
  requestAccess,
  revoke,
  saveCheckpoint,
  startDaemon,
} from "@mida/midad"
import type { DaemonHandle, Network } from "@mida/midad"
import { Mida, isMidaSdkError } from "../src/index.js"
import type { StatusAnswer } from "../src/index.js"

const STEP_TIMEOUT = 60_000
const PROJECT_ID = "proj-sdk-e2e"

/** A complete, valid checkpoint envelope for seeding the handoff — built here, not trusted. */
const checkpointFor = (agent: string, eventId: string) => ({
  projectId: PROJECT_ID,
  sessionId: `sess-${agent}`,
  continuesSession: null,
  compiledBy: agent,
  checkpoint: {
    eventId,
    agent,
    source: "agent-tool" as const,
    createdAt: new Date(1_760_000_000_000).toISOString(),
    objective: "ship the sdk",
    originalRequest: null,
    progress: [`saved by ${agent}`],
    decisions: [],
    rejected: [],
    constraints: [],
    artifacts: [],
    unresolvedIssue: null,
    nextAction: "keep going",
    remainingPlan: [],
    evidence: [],
  },
})

/**
 * handoff(), whatsNew() and status() end to end: a real midad on local Anvil, the same socket
 * routes mida_handoff / mida_whats_new / mida_status call — the SDK's answers must carry the
 * same text the adapter prints, byte for byte where the route supplies it.
 */
describe("local transport against a real midad on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let workDir: string
  let daemon: DaemonHandle | undefined
  let fakeNow = 1_760_000_000_000

  const compile = async (input: CompileInput): Promise<CompileResult> => ({
    ok: true,
    checkpoint: checkpointFor(input.agent, input.eventId).checkpoint,
    compiledBy: "stub",
    droppedKeys: [],
    trimmed: [],
    attempts: 1,
    retried: 0,
    format: "claude-jsonl",
    messagesKept: 1,
    messagesTotal: 1,
    charsSent: 0,
    modelMs: 0,
  })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-sdk-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-sdk-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))

    const runtime = await Runtime.open(home, { ...network, storageUrl: env.apiBaseUrl })
    try {
      await init(runtime, ["codex", "cursor", "windsurf"])
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      await requestAccess(runtime, "cursor")
      await approve(runtime, "cursor", workDir)
      // one checkpoint authored by cursor — codex's whats-new will see it as foreign
      await saveCheckpoint(runtime, "cursor", checkpointFor("cursor", "cp-cursor-1"))
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network,
      compile,
      now: () => fakeNow,
      log: () => {},
      drainDeps: { homeDir: mkdtempSync(join(tmpdir(), "mida-userhome-")) },
      tickMs: 30_000,
    })
    // cursor's handoff seeds the daemon's memory copies, so codex's whats-new can notice the save
    const seed = await callDaemon(home, "/handoff", { agent: "cursor", cwd: workDir }, { timeoutMs: 30_000 })
    expect(seed.status).toBe(200)
  }, STEP_TIMEOUT * 6)

  afterAll(async () => {
    await daemon?.close()
    await env?.stop()
  })

  it("handoff() returns the same text mida_handoff prints for the same agent and folder", async () => {
    const mida = new Mida({ agent: "codex", project: workDir, home: home.root })
    const answer = await mida.handoff()
    const raw = await callDaemon(home, "/handoff", { agent: "codex", cwd: workDir }, { timeoutMs: 30_000 })
    expect(raw.status).toBe(200)
    const body = raw.body as { kind?: unknown; text?: unknown }
    expect(answer.kind).toBe(body.kind)
    // byte for byte — the model-facing text is the route's, the SDK changes nothing
    expect(answer.text).toBe(body.text)
    expect(answer.text.length).toBeGreaterThan(0)
  }, STEP_TIMEOUT)

  it("whatsNew() reports cursor's save — the same note mida_whats_new prints", async () => {
    const mida = new Mida({ agent: "codex", project: workDir, home: home.root })
    const answer = await mida.whatsNew()
    const raw = await callDaemon(home, "/whatsnew", { agent: "codex", cwd: workDir }, { timeoutMs: 30_000 })
    expect(raw.status).toBe(200)
    const body = raw.body as { kind?: unknown; note?: unknown }
    expect(body.kind).toBe("updates")
    // the note embeds relative time ("4 s ago") — two calls a second apart differ, so parity is
    // checked with the age digits normalised: same words, same order, same content
    const ageless = (text: string) => text.replace(/\d+ (s|min|h|d) ago|just now/g, "A while ago")
    expect(answer.kind).toBe("updates")
    expect(ageless(answer.text)).toBe(ageless(String(body.note)))
    expect(answer.text).toContain("cursor")
  }, STEP_TIMEOUT)

  it("a never-approved agent's handoff throws the not-approved code", async () => {
    const mida = new Mida({ agent: "windsurf", project: workDir, home: home.root })
    const thrown = await mida.handoff().catch((error) => error)
    expect(isMidaSdkError(thrown, "not-approved")).toBe(true)
  }, STEP_TIMEOUT)

  it("whatsNew() on nothing new carries the line mida_whats_new prints", async () => {
    // windsurf is approved now — its copy has never been seeded, so the answer is a certain none
    const runtime = await Runtime.open(home, { ...network, storageUrl: env.apiBaseUrl })
    try {
      await requestAccess(runtime, "windsurf")
      await approve(runtime, "windsurf", workDir)
    } finally {
      await runtime.close()
    }
    const mida = new Mida({ agent: "windsurf", project: workDir, home: home.root })
    const answer = await mida.whatsNew()
    const raw = await callDaemon(home, "/whatsnew", { agent: "windsurf", cwd: workDir }, { timeoutMs: 30_000 })
    const body = raw.body as { kind?: unknown }
    expect(body.kind).toBe("none")
    // and the SDK prints the same "nothing new" line mida_whats_new prints, not an empty answer
    expect(answer).toEqual({ kind: "none", text: "Mida: nothing new since the last check." })
  }, STEP_TIMEOUT)

  it("status() reports the service and this agent's verdict in mida_status's own words", async () => {
    const mida = new Mida({ agent: "codex", project: workDir, home: home.root })
    const answer = await mida.status()
    expect(answer.up).toBe(true)
    expect(answer.agent).toEqual({ name: "codex", verdict: "approved" })
    const lines = answer.text.split("\n")
    // the service line is mida_status's own format — pid, uptime, queue, socket folder
    expect(lines[0]).toMatch(/^midad: answering — pid \d+, up since \d{4}-/)
    expect(lines[1]).toBe("codex: approved for this folder")
  }, STEP_TIMEOUT)

  it("status() names a never-approved and (after the owner revokes) a revoked agent plainly", async () => {
    const mida = new Mida({ agent: "cursor", project: workDir, home: home.root })
    const runtime = await Runtime.open(home, { ...network, storageUrl: env.apiBaseUrl })
    try {
      await revoke(runtime, "cursor")
    } finally {
      await runtime.close()
    }
    const answer: StatusAnswer = await mida.status()
    expect(answer.up).toBe(true)
    expect(answer.agent?.verdict).toBe("revoked")
    expect(answer.text).toContain("cursor: access revoked by the owner")
    // and a refused call is a typed error, never a successful empty answer
    const thrown = await mida.handoff().catch((error) => error)
    expect(isMidaSdkError(thrown, "revoked")).toBe(true)
  }, STEP_TIMEOUT)

  it("status() from a folder that is no Mida project says so — no verdict, just the folder line", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mida-sdk-notproject-"))
    const mida = new Mida({ agent: "codex", project: elsewhere, home: home.root })
    const answer = await mida.status()
    expect(answer.up).toBe(true)
    // the same folder line mida_status prints — the refusal is about the folder, not the agent
    expect(answer.text).toContain("this folder is not a Mida project — no .mida marker found")
    expect(answer.agent?.verdict).toBe("unknown")
    expect(answer.text).not.toContain("codex:")
  }, STEP_TIMEOUT)
})
