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
import type { ContextReadResult, DaemonHandle, Network, RememberSaveResult } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000
const PROJECT_ID = "proj-remember-e2e"

/** The reply body the daemon's /remember route answers with. */
const rememberReply = async (home: MidaHome, body: Record<string, unknown>): Promise<RememberSaveResult> => {
  const reply = await callDaemon(home, "/remember", body, { timeoutMs: 45_000 })
  expect(reply.status).toBe(200)
  return reply.body as RememberSaveResult
}

const contextReply = async (home: MidaHome, body: Record<string, unknown>): Promise<ContextReadResult> => {
  const reply = await callDaemon(home, "/context", body, { timeoutMs: 45_000 })
  expect(reply.status).toBe(200)
  return reply.body as ContextReadResult
}

/**
 * The /remember route end to end: a real midad on local Anvil, a real store and batcher, real
 * signed writes. `codex` holds the project grant on the work folder; `cursor` is approved on the
 * same folder (so a foreign supersede reaches the chain's own refusal); `windsurf` is
 * provisioned but never approved; `ghost` was never provisioned.
 */
describe("/remember against a real midad on local Anvil", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let workDir: string
  let otherDir: string
  let daemon: DaemonHandle | undefined
  let fakeNow = 1_760_000_000_000

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

  /** A record written straight through the SDK — bypasses the route's own rate window. */
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

  const readItem = async (contextId: string) => {
    const result = await contextReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, limit: 200_000 })
    if (result.kind !== "context") throw new Error(`expected context, got ${result.kind}`)
    return result.items.find((item) => item.id === contextId)
  }

  beforeAll(async () => {
    env = await localEnvironment({ batching: { waitMs: 200 } })
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-remember-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-remember-work-"))
    mkdirSync(join(workDir, ".mida"))
    writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))
    otherDir = mkdtempSync(join(tmpdir(), "mida-remember-other-"))
    mkdirSync(join(otherDir, ".mida"))
    writeFileSync(join(otherDir, ".mida", "project.json"), JSON.stringify({ projectId: "proj-remember-other" }))

    const runtime = await ownerRuntime()
    try {
      await init(runtime, ["codex", "cursor", "windsurf"])
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      await requestAccess(runtime, "cursor")
      await approve(runtime, "cursor", workDir)
    } finally {
      await runtime.close()
    }
    // `mida batching on` — the batched lane's switch lives in network.json, and the hosted
    // store's address goes beside it so laneForSave can find batching for this contract
    home.writeSecretJson("network.json", {
      ...(home.readJson("network.json") as Record<string, unknown>),
      storageUrl: env.apiBaseUrl,
      batching: true,
    })
    daemon = await startDaemon({
      home,
      network,
      compile,
      now: () => fakeNow,
      log: () => {},
      drainDeps: { homeDir: mkdtempSync(join(tmpdir(), "mida-userhome-")) },
      tickMs: 30_000,
    })
  }, STEP_TIMEOUT * 6)

  afterAll(async () => {
    await daemon?.close()
    await env?.stop()
  })

  it("(a) a note on the batching lane answers pending, then anchors", async () => {
    env.batcher!.pauseTimer()
    let saved: RememberSaveResult
    try {
      saved = await rememberReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, content: "the sdk remember note" })
      expect(saved).toMatchObject({ kind: "saved", state: "pending", lane: "batched" })
      if (saved.kind !== "saved") return
      const pending = await readItem(saved.id)
      expect(pending, "the queued save is missing from the context read").toBeDefined()
      expect(pending!.state).toBe("pending")
    } finally {
      env.batcher!.resumeTimer()
    }
    if (saved!.kind !== "saved") return
    // the batcher anchors within a few seconds — poll until the read sees the placement
    const deadline = Date.now() + 15_000
    for (;;) {
      const item = await readItem(saved.id)
      if (item?.state === "anchored") break
      expect(Date.now(), "the batched save never anchored").toBeLessThan(deadline)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }, STEP_TIMEOUT)

  it("(b) object content, kind and references round-trip through /context", async () => {
    const anchor = await write("the record this one supports")
    const saved = await rememberReply(home, {
      agent: "codex",
      cwd: workDir,
      namespace: NAMESPACE,
      content: { decision: "use the batch lane", why: "cost" },
      kind: "DECISION",
      references: [{ relation: "supports", recordId: anchor.contextId }],
    })
    expect(saved.kind).toBe("saved")
    if (saved.kind !== "saved") return
    const item = await readItem(saved.id)
    expect(item, "the record is missing from the context read").toBeDefined()
    expect(item!.kind).toBe("DECISION")
    expect(item!.content).toEqual({ decision: "use the batch lane", why: "cost" })
    expect(item!.references).toEqual([{ relation: "supports", recordId: anchor.contextId }])
    expect(item!.author.id).toBe(loadAgentIdentity(home, "codex")!.agentId)
    expect(item!.source).toBe("AGENT_INFERRED")
  }, STEP_TIMEOUT)

  it("(c) supersedes takes the direct lane and retires the parent — then the second write in the minute is rate-limited", async () => {
    const base = await write("superseded at the base")
    const first = await rememberReply(home, {
      agent: "codex",
      cwd: workDir,
      namespace: NAMESPACE,
      content: "superseded to version two",
      supersedes: base.contextId,
    })
    expect(first).toMatchObject({ kind: "saved", state: "anchored", lane: "direct" })
    // the parent is superseded — it drops out of the lineage-head read
    expect(await readItem(base.contextId)).toBeUndefined()
    expect((await readItem(first.kind === "saved" ? first.id : ""))?.content).toBe("superseded to version two")
    // the direct lane admits one write a minute per agent — a second supersede names the lane
    const second = await rememberReply(home, {
      agent: "codex",
      cwd: workDir,
      namespace: NAMESPACE,
      content: "superseded to version three",
      supersedes: first.kind === "saved" ? first.id : base.contextId,
    })
    expect(second).toMatchObject({ kind: "refused", reason: "rate-limited", lane: "direct" })
  }, STEP_TIMEOUT)

  it("(d) superseding another agent's record reaches the chain's own refusal", async () => {
    const foreign = await write("a codex record")
    const result = await rememberReply(home, {
      agent: "cursor",
      cwd: workDir,
      namespace: NAMESPACE,
      content: "cursor's rewrite",
      supersedes: foreign.contextId,
    })
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
  }, STEP_TIMEOUT)

  it("(e) a fact namespace with a read-only grant says read-only — not not-approved", async () => {
    const result = await rememberReply(home, {
      agent: "codex",
      cwd: workDir,
      namespace: "profile.skills",
      content: "knows typescript",
    })
    expect(result).toMatchObject({ kind: "refused", reason: "read-only" })
  }, STEP_TIMEOUT)

  it("(f) never-approved and unprovisioned agents refuse; so does a folder the owner never approved", async () => {
    expect(await rememberReply(home, { agent: "windsurf", cwd: workDir, namespace: NAMESPACE, content: "x" })).toMatchObject({
      kind: "refused",
      reason: "not-approved",
    })
    expect(await rememberReply(home, { agent: "ghost", cwd: workDir, namespace: NAMESPACE, content: "x" })).toMatchObject({
      kind: "refused",
      reason: "no-identity",
    })
    expect(await rememberReply(home, { agent: "codex", cwd: otherDir, namespace: NAMESPACE, content: "x" })).toMatchObject({
      kind: "refused",
      reason: "not-approved",
    })
  }, STEP_TIMEOUT)

  it("(g) a revoked agent cannot write — the marker wins even mid-request", async () => {
    const runtime = await ownerRuntime()
    try {
      await revoke(runtime, "codex")
    } finally {
      await runtime.close()
    }
    const result = await rememberReply(home, { agent: "codex", cwd: workDir, namespace: NAMESPACE, content: "after the revoke" })
    expect(result).toMatchObject({ kind: "refused", reason: "revoked" })
  }, STEP_TIMEOUT)
})
