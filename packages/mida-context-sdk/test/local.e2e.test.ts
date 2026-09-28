import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  MidaHome,
  NAMESPACE,
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
      await init(runtime, ["codex", "cursor", "windsurf", "aider"])
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

  it("whatsNew() quiets a delivered note for this session — a second Mida still sees it as new", async () => {
    // in-18 B4 (probe zz-rvint-sdk-whatsnew-seen inverted): the SDK used to send no session id,
    // so the daemon had no seen set to consult and the same foreign save came back "new" on every
    // call forever. Now each Mida instance is a session (`sdk-<agent>-<hex>`): the delivered note's
    // ids are recorded under state/lastseen/<sessionId>.json exactly as the MCP adapter records them.
    const mida = new Mida({ agent: "codex", project: workDir, home: home.root })
    const first = await mida.whatsNew()
    expect(first.kind).toBe("updates")
    expect(first.text).toContain("cursor")
    // the delivered note was recorded — the same save is quiet on the very next call
    const second = await mida.whatsNew()
    expect(second).toEqual({ kind: "none", text: "Mida: nothing new since the last check." })
    // a second Mida instance is a SECOND session — what the first consumed is still new to it
    const other = new Mida({ agent: "codex", project: workDir, home: home.root })
    const fresh = await other.whatsNew()
    expect(fresh.kind).toBe("updates")
    expect(fresh.text).toContain("cursor")
    // a NEW foreign save is new again to the session that already went quiet
    const runtime = await Runtime.open(home, { ...network, storageUrl: env.apiBaseUrl })
    try {
      await saveCheckpoint(runtime, "cursor", checkpointFor("cursor", "cp-cursor-2"))
    } finally {
      await runtime.close()
    }
    // the same reseed the daemon does on a real session start: a codex /handoff refreshes its copy
    const seed = await callDaemon(home, "/handoff", { agent: "codex", cwd: workDir }, { timeoutMs: 30_000 })
    expect(seed.status).toBe(200)
    const third = await mida.whatsNew()
    expect(third.kind).toBe("updates")
    expect(third.text).toContain("cursor")
  }, STEP_TIMEOUT * 2)

  it("requestAccess() files the request where `mida approve` looks for it", async () => {
    const mida = new Mida({ agent: "aider", project: workDir, home: home.root })
    const result = await mida.requestAccess()
    expect(result.requestId).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.nextStep).toBe("run `mida approve aider` in a terminal")
    // the file the owner's `mida approve aider` reads
    expect(home.has("agents/aider/pending-request.json")).toBe(true)
    // and the owner path accepts exactly this request — the SDK carries no approve call; the
    // agent cannot approve itself, the filing only becomes access when the owner approves
    const runtime = await Runtime.open(home, { ...network, storageUrl: env.apiBaseUrl })
    try {
      await approve(runtime, "aider", workDir)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("requestAccess() on an approved agent answers already-approved; a missing identity answers no-identity", async () => {
    const codex = new Mida({ agent: "codex", project: workDir, home: home.root })
    const approved = await codex.requestAccess().catch((error) => error)
    expect(isMidaSdkError(approved, "already-approved")).toBe(true)
    const ghost = await new Mida({ agent: "ghost", project: workDir, home: home.root }).requestAccess().catch((error) => error)
    expect(isMidaSdkError(ghost, "no-identity")).toBe(true)
  }, STEP_TIMEOUT)

  it("verify() answers valid for a context() item exactly as the service served it", async () => {
    const mida = new Mida({ agent: "codex", project: workDir, home: home.root })
    const { items } = await mida.context({ namespace: NAMESPACE, limit: 10_000 })
    const item = items.find((entry) => entry.author.name === "cursor") ?? items[0]
    expect(item).toBeDefined()
    const verdict = await mida.verify(item!)
    expect(verdict.valid).toBe(true)
    expect(verdict.checks.map((check) => [check.name, check.ok])).toEqual([
      ["commitment", true],
      ["author", true],
      ["grant-at-write", true],
    ])
  }, STEP_TIMEOUT)

  it("verify() fails the named check on a tampered item — and every check on a made-up record", async () => {
    const mida = new Mida({ agent: "codex", project: workDir, home: home.root })
    const { items } = await mida.context({ namespace: NAMESPACE, limit: 10_000 })
    const item = items[0]!
    // a changed commitment: the record is real, the claim is not — commitment is what fails
    const tampered = { ...item, proof: { ...item.proof, manifestHash: `0x${"ab".repeat(32)}` as const } }
    const tamperedVerdict = await mida.verify(tampered)
    expect(tamperedVerdict.valid).toBe(false)
    expect(tamperedVerdict.checks.find((check) => check.name === "commitment")?.ok).toBe(false)
    expect(tamperedVerdict.checks.find((check) => check.name === "author")?.ok).toBe(true)
    expect(tamperedVerdict.checks.find((check) => check.name === "grant-at-write")?.ok).toBe(true)
    // an id the registry never heard of: nothing can check out
    const madeUp = { ...item, proof: { ...item.proof, recordId: `0x${"00".repeat(32)}` as const } }
    const madeUpVerdict = await mida.verify(madeUp)
    expect(madeUpVerdict.valid).toBe(false)
    expect(madeUpVerdict.checks.every((check) => !check.ok)).toBe(true)
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
