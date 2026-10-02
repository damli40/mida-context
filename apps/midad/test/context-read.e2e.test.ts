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
  loadAgentIdentity,
  requestAccess,
  revoke,
  startDaemon,
} from "@mida/midad"
import type { ContextReadResult, DaemonHandle, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const PROJECT_ID = "proj-ctxread-e2e"

/** The reply body the daemon's /context route answers with. */
const contextReply = async (home: MidaHome, body: Record<string, unknown>): Promise<ContextReadResult> => {
  const reply = await callDaemon(home, "/context", body, { timeoutMs: 45_000 })
  expect(reply.status).toBe(200)
  return reply.body as ContextReadResult
}

/**
 * The /context route end to end: a real midad on local Anvil, a real store, and real signed
 * writes through `MidaAgent.create`/`supersede`/`createBatched`. `codex` holds the ordinary
 * project grant; `cursor` is never approved; `ghost` is never even provisioned. The batch timer
 * is held while a pending save is read so "not yet anchored" is observable instead of racing it.
 */
describe("/context against a real midad on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let workDir: string
  let otherDir: string
  let daemon: DaemonHandle | undefined
  let fakeNow = 1_760_000_000_000
  let codexId: string

  const compile = async (input: CompileInput): Promise<CompileResult> => ({
    ok: true,
    checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
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

  const ownerRuntime = () => Runtime.open(home, { ...network, storageUrl: env.apiBaseUrl })

  const write = async (value: string) => {
    const runtime = await ownerRuntime()
    try {
      return await runtime
        .agent("codex")
        .create(runtime.owner, NAMESPACE, { value, kind: "INFERENCE", source: "AGENT_INFERRED" })
    } finally {
      await runtime.close()
    }
  }

  beforeAll(async () => {
    env = await localEnvironment({ batching: { waitMs: 200 } })
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctxread-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-ctxread-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))
    otherDir = mkdtempSync(join(tmpdir(), "mida-ctxread-other-"))
    mkdirSync(join(otherDir, ".mida"))
    writeFileSync(join(otherDir, ".mida", "project.json"), JSON.stringify({ projectId: "proj-ctxread-other" }))

    const runtime = await ownerRuntime()
    try {
      await init(runtime, ["codex", "cursor"])
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      codexId = loadAgentIdentity(home, "codex")!.agentId
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
  }, 600_000)

  afterAll(async () => {
    await daemon?.close()
    await env?.stop()
  })

  it("(a) written records come back as verified items — chain author, anchored state, proof — newest first", async () => {
    const first = await write("the first note")
    const second = await write("the second note")

    const result = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit: 100_000 })
    expect(result.kind).toBe("context")
    if (result.kind !== "context") return
    const found = result.items.filter((item) => item.id === first.contextId || item.id === second.contextId)
    expect(found.map((item) => item.id)).toEqual([second.contextId, first.contextId])
    const item = found[0]!
    expect(item.namespace).toBe(NAMESPACE)
    expect(item.kind).toBe("INFERENCE")
    expect(item.content).toBe("the second note")
    // authorship is the chain's record — the local name is resolved from the home's identities
    expect(item.author).toEqual({ name: "codex", id: codexId })
    expect(item.source).toBe("AGENT_INFERRED")
    expect(item.state).toBe("anchored")
    expect(item.superseded).toBe(false)
    expect(item.proof).toEqual({ manifestHash: second.manifestHash, recordId: second.contextId })
    expect(Date.parse(item.writtenAt)).toBeGreaterThan(0)
    expect(result.cursor).toBeNull()
  }, STEP_TIMEOUT)

  it("(b) a superseded record drops out — only the lineage head is returned", async () => {
    const base = await write("version one")
    await ownerRuntime().then(async (runtime) => {
      try {
        await runtime.agent("codex").supersede(runtime.owner, base.contextId, { value: "version two", kind: "INFERENCE", source: "AGENT_INFERRED" })
      } finally {
        await runtime.close()
      }
    })
    const result = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit: 100_000 })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.items.some((item) => item.content === "version one")).toBe(false)
    expect(result.items.some((item) => item.content === "version two")).toBe(true)
  }, STEP_TIMEOUT)

  it("(c) the byte limit pages with a cursor — whole records only, newest first", async () => {
    // every record so far is a short string; a 14-byte limit admits exactly one per page
    const limit = Buffer.byteLength("the second note")
    const first = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit })
    if (first.kind !== "context") throw new Error("expected context")
    expect(first.items).toHaveLength(1)
    expect(first.cursor).not.toBeNull()
    const seen = new Set(first.items.map((item) => item.id))
    let cursor = first.cursor
    while (cursor !== null) {
      const page = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit, cursor })
      if (page.kind !== "context") throw new Error("expected context")
      for (const item of page.items) expect(seen.has(item.id), `duplicate ${item.id}`).toBe(false)
      page.items.forEach((item) => seen.add(item.id))
      cursor = page.cursor
    }
    // first, second and version-two — the superseded v1 is already out of the list
    expect(seen.size).toBe(3)
  }, STEP_TIMEOUT)

  it("(d) a batched save waiting on the anchor is returned marked pending — then anchored", async () => {
    env.batcher!.pauseTimer()
    let contextId: string
    const runtime = await ownerRuntime()
    try {
      const saved = await runtime
        .agent("codex")
        .createBatched(runtime.owner, NAMESPACE, { value: "waiting on the batch", kind: "INFERENCE", source: "AGENT_INFERRED" })
      contextId = saved.contextId
    } finally {
      await runtime.close()
    }
    try {
      const result = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit: 100_000 })
      if (result.kind !== "context") throw new Error("expected context")
      const item = result.items.find((entry) => entry.id === contextId)
      expect(item, "the queued save is missing from the read").toBeDefined()
      expect(item!.state).toBe("pending")
      expect(Date.parse(item!.writtenAt)).toBeGreaterThan(0)
    } finally {
      env.batcher!.resumeTimer()
    }
  }, STEP_TIMEOUT)

  it("(e) a fact namespace reads on the grant alone — no folder row needed and none asked", async () => {
    // codex holds READ on profile.skills from the project_assistance grant — the read opens in a
    // folder the agent is NOT approved for, because the folder only gates projects.current
    const result = await contextReply(home, { agent: "codex", cwd: otherDir, namespace: "profile.skills", limit: 100_000 })
    expect(result.kind).toBe("context")
    // and a namespace the grant never covered refuses as not-approved, not as an empty list
    const denied = await contextReply(home, { agent: "codex", cwd: workDir, namespace: "private", limit: 100_000 })
    expect(denied).toMatchObject({ kind: "refused", reason: "not-approved" })
  }, STEP_TIMEOUT)

  it("(f) a never-approved agent and an unapproved folder refuse — never an empty list", async () => {
    const agent = await contextReply(home, { agent: "cursor", cwd: workDir, namespace: NAMESPACE, limit: 100_000 })
    expect(agent).toMatchObject({ kind: "refused", reason: "not-approved" })
    const folder = await contextReply(home, { agent: "codex", cwd: otherDir, namespace: NAMESPACE, limit: 100_000 })
    expect(folder).toMatchObject({ kind: "refused", reason: "not-approved" })
    const ghost = await contextReply(home, { agent: "ghost", cwd: workDir, namespace: NAMESPACE, limit: 100_000 })
    expect(ghost).toMatchObject({ kind: "refused", reason: "no-identity" })
  }, STEP_TIMEOUT)

  it("(g) several namespaces merge in the chain's order across a single read", async () => {
    const result = await contextReply(home, {
      agent: "codex",
      cwd: workDir,
      namespaces: [NAMESPACE, "profile.skills"],
      limit: 100_000,
    })
    if (result.kind !== "context") throw new Error("expected context")
    const project = result.items.filter((item) => item.namespace === NAMESPACE)
    expect(project.length).toBeGreaterThanOrEqual(4)
    // the merge is one ordering — writtenAt never goes backwards down the list
    const stamps = result.items.map((item) => Date.parse(item.writtenAt))
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)
  }, STEP_TIMEOUT)

  it("(h) a revoked agent is refused with revoked — the project row and keys still sit in the home", async () => {
    const runtime = await ownerRuntime()
    try {
      await revoke(runtime, "codex")
    } finally {
      await runtime.close()
    }
    const result = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit: 100_000 })
    expect(result).toMatchObject({ kind: "refused", reason: "revoked" })
  }, STEP_TIMEOUT)
})
