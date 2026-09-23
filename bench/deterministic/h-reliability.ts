// Group H — reliability. From docs/issue-register.md §3:
//   H1 kill at each stage boundary (init, approve, revoke, save): re-running the
//      same command converges with no duplicate transaction — the owner nonce
//      on chain is the witness, never a local flag
//   H2 chain error during save: retried later with NO new model call; no double
//      registration; a second open of the held home fails cleanly
//   H3 oversize checkpoints (the 122 KB case; constraints already at 50; emoji
//      text): saved within the byte cap measured on the real payload, request
//      and plan intact, nothing silently deleted
//   H4 model hangs with child processes: killed at the timeout, no process left
//   H5 every failure path writes a distinct stable code; no log line contains
//      transcript text, a path, or an error message
// G1/G2 are the hero continuation checks — they need real agents, so they are
// emitted as skips here to keep the gap visible in the table.

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import type { AbiEvent } from "viem"
import { capabilityRegistryAbi, contextRegistryAbi, deployLocal, getLogsChunked } from "@mida/chain"
import { compileCheckpoint } from "../../packages/compiler/src/index.js"
import {
  MAX_VALUE_BYTES, Runtime, approve, approveProject, drainOnce,
  enqueue, init, loadOrCreateOperatorSecrets, loadOwnerAddress, migrate, migrateUndo,
  readCheckpoints, requestAccess, revoke, saveCheckpoint, wrapCheckpoint,
} from "../../apps/midad/src/index.js"
import type { DrainDeps, Manifest, MidaHome, MigrateDeps } from "../../apps/midad/src/index.js"
import { seedMigrateUniverse } from "../../apps/midad/test/helpers-migrate.js"
import {
  STUB_MODEL, assistantText, benchChain, benchDir, benchHome, mark,
  sampleCheckpoint, stubCompile, userLine, writeTranscript,
} from "../lib/env.js"
import { runGroup } from "../lib/checks.js"

const T0 = Date.parse("2026-09-21T10:00:00.000Z")
const chain = await benchChain()
const dir = benchDir("h")
const home = benchHome("h")
const homeDir = join(dir, "user-home")
const runtime = await Runtime.open(home, chain.network)
const txCount = () => runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })

const throwCode = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return code
    return error instanceof Error && /already approved/.test(error.message) ? "already-approved" : "threw"
  }
}

// H1 — red if re-running a stage mints a second transaction: a kill between
// stages must leave the re-run a no-op on chain. The nonce is read from the
// chain itself.
async function h1() {
  await init(runtime, ["conv"])
  const afterInit = await txCount()
  await init(runtime, ["conv"])
  const initConverged = (await txCount()) === afterInit

  await requestAccess(runtime, "conv")
  await approve(runtime, "conv")
  const afterApprove = await txCount()
  const doubleApprove = await throwCode(() => approve(runtime, "conv"))
  const approveConverged = (await txCount()) === afterApprove

  await revoke(runtime, "conv")
  const afterRevoke = await txCount()
  const secondRevoke = await revoke(runtime, "conv")
  const revokeConverged = (await txCount()) === afterRevoke && secondRevoke.transactionHashes.length === 0

  // re-approve so the save leg has a live grant
  await requestAccess(runtime, "conv")
  await approve(runtime, "conv")
  const cwd = join(dir, "work-h1")
  mkdirSync(cwd, { recursive: true })
  const { approval } = await approveProject(runtime, { agent: "conv", cwd })
  const input = {
    projectId: approval.projectId, sessionId: "h1", continuesSession: null, compiledBy: "bench",
    checkpoint: sampleCheckpoint({ eventId: "ev-h1-0001", progress: ["one"] }),
  }
  const first = await saveCheckpoint(runtime, "conv", input)
  const afterSave = await txCount()
  const retry = await saveCheckpoint(runtime, "conv", input)
  const saveConverged =
    (await txCount()) === afterSave &&
    retry.duplicate === true &&
    retry.transactionHash === null &&
    retry.contextId === first.contextId

  // H1 extension (spec §10): `mida migrate` killed between PREPARE and COMMIT, and between
  // COMMIT and VERIFY — for an agent registration, a fact and a checkpoint. The re-run must
  // converge with zero orphan agents and zero duplicate records, both counted from the TARGET
  // contract's logs, and --undo must restore a working old setup. Each case gets its own home
  // (its own owner, operator and seed) on the one shared target deployment — the migrate leg
  // switches a home's network.json, so it can never share the group home.
  const migrateTarget = await deployLocal({ rpcUrl: chain.network.rpcUrl })
  const MIGRATED_AT = "2026-09-23T12:00:00.000Z"
  const AGENT_REGISTERED = capabilityRegistryAbi.find((e) => e.type === "event" && e.name === "AgentRegistered") as AbiEvent
  const CONTEXT_REGISTERED = contextRegistryAbi.find((e) => e.type === "event" && e.name === "ContextRegistered") as AbiEvent

  const runMigrate = (mhome: MidaHome, over: Partial<MigrateDeps> = {}) =>
    migrate({
      home: mhome,
      env: {},
      confirm: async () => true,
      print: () => {},
      now: () => new Date(MIGRATED_AT),
      target: migrateTarget,
      startService: () => {},
      ...over,
    }).then(
      (result) => result,
      (error: unknown) => {
        if ((error as { code?: unknown })?.code === "migrate-stopped") return { stopped: true as const }
        throw error
      },
    )

  const migrateCase = async (name: string, crashes: Partial<MigrateDeps>[], undo: boolean): Promise<boolean> => {
    const mhome = benchHome(`h1mig-${name}`)
    const mrt = await Runtime.open(mhome, chain.network)
    try {
      await seedMigrateUniverse(mrt)
    } finally {
      await mrt.close()
    }
    const owner = loadOwnerAddress(mhome)!
    const operator = privateKeyToAccount(loadOrCreateOperatorSecrets(mhome).privateKey).address
    for (const crash of crashes) {
      const crashed = await runMigrate(mhome, crash)
      if (!("stopped" in crashed)) return false // the injected crash must actually stop the run
    }
    let moved: { outcome: string; lines: string[] } | undefined
    for (let attempt = 0; attempt < 60 && moved === undefined; attempt += 1) {
      const result = await runMigrate(mhome)
      if ("outcome" in result) moved = result
    }
    if (moved?.outcome !== "moved") return false
    const manifest = mhome.readJson<{ manifest: Manifest }>("migrate/state.json")!.manifest
    const head = await runtime.ownerChain.publicClient.getBlockNumber()
    const registrations = await getLogsChunked(runtime.ownerChain.publicClient, {
      address: migrateTarget.capabilityRegistry,
      event: AGENT_REGISTERED,
      args: { operator },
      fromBlock: migrateTarget.deploymentBlock,
      toBlock: head,
    })
    const contexts = await getLogsChunked(runtime.ownerChain.publicClient, {
      address: migrateTarget.contextRegistry,
      event: CONTEXT_REGISTERED,
      args: { owner },
      fromBlock: migrateTarget.deploymentBlock,
      toBlock: head,
    })
    const expectedAgents = new Set(Object.values(manifest.agentMap).map((map) => map.newAgentId!.toLowerCase()))
    const expectedIds = new Set(manifest.entries.map((entry) => entry.targetId!.toLowerCase()))
    const gotIds = new Set(contexts.map((log) => (log.args as { contextId: `0x${string}` }).contextId.toLowerCase()))
    const converged =
      registrations.length === expectedAgents.size &&
      registrations.every((log) => expectedAgents.has((log.args as { agentId: `0x${string}` }).agentId.toLowerCase())) &&
      contexts.length === expectedIds.size &&
      gotIds.size === expectedIds.size &&
      [...gotIds].every((id) => expectedIds.has(id))
    if (!converged) return false
    if (!undo) return true
    const undone = await migrateUndo({
      home: mhome, env: {}, print: () => {}, now: () => new Date(MIGRATED_AT), startService: () => {},
    })
    const net = mhome.readJson<{ deployment: { contextRegistry: string } }>("network.json")!
    return (
      undone.outcome === "restored" &&
      net.deployment.contextRegistry.toLowerCase() === chain.network.deployment.contextRegistry.toLowerCase()
    )
  }

  const migrateCrashes: { name: string; crashes: Partial<MigrateDeps>[]; undo?: boolean }[] = [
    { name: "agent-prepare-commit", crashes: [{ stopAfter: "agents" }] },
    { name: "agent-commit-verify", crashes: [{ throwAfterSend: { kind: "agent", nth: 1 } }] },
    { name: "checkpoint-prepare-commit", crashes: [{ stopAfter: "records" }], undo: true },
    { name: "checkpoint-commit-verify", crashes: [{ throwAfterSend: { kind: "record", nth: 1 } }] },
    { name: "fact-prepare-commit", crashes: [{ stopAfter: "records" }, { stopAfter: "records" }] },
    { name: "fact-commit-verify", crashes: [{ throwAfterSend: { kind: "record", nth: 2 } }] },
  ]
  const migrateCrash: { name: string; ok: boolean }[] = []
  for (const c of migrateCrashes) {
    migrateCrash.push({ name: c.name, ok: await migrateCase(c.name, c.crashes, c.undo === true) })
  }
  const migrateConverged = migrateCrash.every((c) => c.ok)

  return {
    pass: initConverged && approveConverged && revokeConverged && saveConverged && migrateConverged,
    value: { initConverged, approveConverged, revokeConverged, saveConverged, doubleApprove, migrateCrash },
    limit: null,
  }
}

// H2 — red if a chain blip during save buys a second model call or a second
// registration. The compiled envelope is cached on the job's event id: the
// retry must reuse it. Also red if opening the held home deadlocks.
async function h2() {
  const cwd = join(dir, "work-h2")
  mkdirSync(cwd, { recursive: true })
  // the drain refuses agents with no known transcript folder, so the save leg needs a
  // real agent name — claude-code gets its own grant here; conv's story stays in h1
  await init(runtime, ["claude-code"])
  await requestAccess(runtime, "claude-code")
  await approve(runtime, "claude-code")
  const { approval } = await approveProject(runtime, { agent: "claude-code", cwd })
  const transcript = writeTranscript(homeDir, "proj", "h2.jsonl", [userLine("h2 request"), assistantText("h2 step")])

  const compileCalls: unknown[] = []
  let saveAttempts = 0
  const save: DrainDeps["save"] = async (rt, name, input) => {
    saveAttempts += 1
    if (saveAttempts === 1) throw new Error("rpc unreachable") // the blip — message must stay out of the log
    return saveCheckpoint(rt, name, input)
  }
  const compile = stubCompile(compileCalls)

  enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "h2", transcriptPath: transcript, cwd, error: null }, () => new Date(T0))
  const d1 = await drainOnce({ home, runtime, compile, save, homeDir, now: () => new Date(T0) })
  // backoff(1) = 120 s: the retry drains once it is due
  const d2 = await drainOnce({ home, runtime, compile, save, homeDir, now: () => new Date(T0 + 121_000) })
  const read = await readCheckpoints(runtime, "claude-code", approval.projectId)

  // CAP-21: while this runtime holds the home, a CLI-side open must fail fast, not hang
  const contention = await throwCode(() => Runtime.open(home, chain.network, { lockWaitMs: 300, lockStepMs: 50 }))
  const drainStillWorks = (await drainOnce({ home, runtime, compile, save, homeDir, now: () => new Date(T0 + 122_000) })).failed === 0

  return {
    pass:
      d1.failed === 1 &&
      d2.saved === 1 &&
      compileCalls.length === 1 &&
      read.checkpoints.length === 1 &&
      contention !== null &&
      drainStillWorks,
    value: { compileCalls: compileCalls.length, saveAttempts, stored: read.checkpoints.length, contention, drainStillWorks },
    limit: null,
  }
}

// H3 — red if a realistic oversized checkpoint is refused, if the byte cap is
// measured on characters instead of bytes, or if the shrink silently deletes a
// real constraint. The envelope is saved through the real chain path — the
// server sees the exact bytes.
async function h3() {
  const cwd = join(dir, "work-h3")
  mkdirSync(cwd, { recursive: true })
  const { approval } = await approveProject(runtime, { agent: "conv", cwd })
  const cases: { name: string; bytesOk: boolean; requestOk: boolean; planOk: boolean; constraintsOk: boolean; noteOk: boolean; savedOk: boolean }[] = []

  const check = async (name: string, checkpoint: ReturnType<typeof sampleCheckpoint>) => {
    const input = {
      projectId: approval.projectId, sessionId: `h3-${name}`, continuesSession: null, compiledBy: "bench",
      checkpoint,
    }
    const wrapped = wrapCheckpoint(input)
    const bytes = Buffer.byteLength(JSON.stringify(wrapped))
    const requestOk = wrapped.checkpoint.originalRequest === checkpoint.originalRequest
    const planOk = JSON.stringify(wrapped.checkpoint.remainingPlan) === JSON.stringify(checkpoint.remainingPlan)
    const constraintsOk = checkpoint.constraints.every((c) => wrapped.checkpoint.constraints.includes(c))
    const noteOk =
      wrapped.checkpoint.constraints.some((c) => c.includes("(Mida:")) ||
      (wrapped.checkpoint.unresolvedIssue ?? "").includes("(Mida:")
    const saved = await saveCheckpoint(runtime, "conv", { ...input, checkpoint: wrapped.checkpoint })
    const read = await readCheckpoints(runtime, "conv", approval.projectId)
    const back = read.checkpoints.find((c) => c.contextId === saved.contextId)
    const savedOk = back !== undefined && back.checkpoint.originalRequest === checkpoint.originalRequest
    cases.push({ name, bytesOk: bytes <= MAX_VALUE_BYTES, requestOk, planOk, constraintsOk, noteOk, savedOk })
  }

  // CAP-02's shape: 50 decisions + 50 rejected + 50 plan items + a 6,000-char request —
  // far larger than the value cap, so wrap must shrink, not refuse.
  await check("cap02", sampleCheckpoint({
    eventId: "ev-h3-cap02", originalRequest: `build the thing ${"r".repeat(5_950)}`,
    objective: "cap02 objective", nextAction: "cap02 next",
    progress: Array.from({ length: 50 }, (_, i) => `progress ${i} ${"p".repeat(1_800)}`),
    decisions: Array.from({ length: 50 }, (_, i) => ({ decision: `d${i} ${"d".repeat(900)}`, rationale: `r${i} ${"r".repeat(900)}` })),
    rejected: Array.from({ length: 50 }, (_, i) => ({ approach: `rejected ${i} ${"x".repeat(1_800)}`, why: `w${i} ${"y".repeat(1_800)}` })),
    constraints: ["keep it simple"],
    remainingPlan: Array.from({ length: 50 }, (_, i) => `plan ${i} ${"q".repeat(150)}`),
  }))

  // CAP-18: constraints already at the 50-item limit — the Mida note must move
  // to unresolvedIssue rather than evicting a real constraint
  const full = Array.from({ length: 50 }, (_, i) => `real constraint ${i}`)
  await check("constraints50", sampleCheckpoint({
    eventId: "ev-h3-con50", originalRequest: "request", objective: "o", nextAction: "n",
    progress: Array.from({ length: 50 }, (_, i) => `progress ${i} ${"p".repeat(1_800)}`),
    decisions: Array.from({ length: 50 }, (_, i) => ({ decision: `d${i} ${"d".repeat(900)}`, rationale: `r${i}` })),
    constraints: full, remainingPlan: ["one step"],
  }))

  // multi-byte text: the cap counts UTF-8 bytes, not characters
  await check("emoji", sampleCheckpoint({
    eventId: "ev-h3-emoji", originalRequest: "fix the parser", objective: "o", nextAction: "n",
    progress: Array.from({ length: 50 }, (_, i) => `étape ${i} ${"🚀".repeat(900)}`),
    constraints: ["no emoji in output"], remainingPlan: ["finish"],
  }))

  const allOk = cases.every((c) => c.bytesOk && c.requestOk && c.planOk && c.constraintsOk && c.noteOk && c.savedOk)
  return { pass: allOk, value: cases, limit: MAX_VALUE_BYTES, unit: "bytes" }
}

// H4 — red if a hung model survives its timeout, or if killing it leaves a
// grandchild holding the output pipe alive. The stub writes both pids to a
// file; every pid must be gone afterwards (ESRCH = no such process).
async function h4() {
  const transcript = writeTranscript(homeDir, "proj", "h4.jsonl", [userLine("h4 request")])
  const pidFile = join(dir, "h4-pids.json")
  const cwd = join(dir, "work-h4")
  mkdirSync(cwd, { recursive: true })
  const result = await compileCheckpoint({
    transcriptPath: transcript, agent: "conv", eventId: "ev-h4-0001", cwd, homeDir,
    model: { argv: [process.execPath, STUB_MODEL, "hang", pidFile], label: "hang-model", timeoutMs: 2_500 },
    attempts: 1, backoffMs: [1], sleep: async () => {},
  })
  const alive = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40; i += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    return true
  }
  if (!existsSync(pidFile)) return { pass: false, value: "no-pid-file", limit: null }
  const { pid, child } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child: number }
  const modelGone = !(await alive(pid))
  const grandchildGone = !(await alive(child))
  return {
    pass: result.ok === false && modelGone && grandchildGone,
    value: { compileOk: result.ok, reason: result.ok ? "ok" : result.reason, modelGone, grandchildGone },
    limit: null,
  }
}

// H5 — red if two different failures share one reason, if a reason is not a
// stable code, or if the log ever carries transcript text, a filesystem path,
// or an error.message. The canary sentence sits inside the transcripts that
// fail — its absence proves the drain reads files without logging contents.
async function h5() {
  const h5home = benchHome("h5")
  const h5dir = benchDir("h5home")
  const h5homeDir = join(h5dir, "user-home")
  const cwd = join(h5dir, "work-h5")
  mkdirSync(cwd, { recursive: true })
  mark(cwd, "p-h5")
  const CANARY = "CANARY_SENTENCE_9917"

  const goodTranscript = writeTranscript(h5homeDir, "proj", "ok.jsonl", [userLine(`${CANARY} good transcript`), assistantText("step")])
  const failTranscript = writeTranscript(h5homeDir, "proj", "modelfail.jsonl", [userLine(`${CANARY} model fails here`), assistantText("step")])
  const weirdTranscript = writeTranscript(h5homeDir, "proj", "weird.jsonl", [{ totally: "not-claude", canary: CANARY }])

  const jobs = [
    { agent: "claude-code", event: "Stop" as const, sessionId: "h5-path", transcriptPath: "/etc/hosts", cwd, error: null },
    { agent: "claude-code", event: "Stop" as const, sessionId: "h5-format", transcriptPath: weirdTranscript, cwd, error: null },
    { agent: "ghost-agent", event: "Stop" as const, sessionId: "h5-ghost", transcriptPath: goodTranscript, cwd, error: null },
    { agent: "claude-code", event: "Stop" as const, sessionId: "h5-noproj", transcriptPath: goodTranscript, cwd: join(h5dir, "no-marker"), error: null },
    { agent: "claude-code", event: "Stop" as const, sessionId: "h5-model", transcriptPath: failTranscript, cwd, error: null },
    { agent: "claude-code", event: "Stop" as const, sessionId: "h5-save", transcriptPath: goodTranscript, cwd, error: null },
  ]
  for (const job of jobs) enqueue(h5home, job, () => new Date(T0))

  const compile = stubCompile([], (input) =>
    input.transcriptPath.endsWith("modelfail.jsonl")
      ? { ok: false as const, reason: "model-failed" as const, detail: "exit 1", attempts: 1 }
      : {
          ok: true as const,
          checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
          compiledBy: "stub", droppedKeys: [], trimmed: [], attempts: 1,
          format: "claude-jsonl" as const, messagesKept: 1, messagesTotal: 1, charsSent: 0, modelMs: 0,
        },
  )
  const save: DrainDeps["save"] = async () => {
    throw new Error("rpc unreachable")
  }
  const drain = () =>
    drainOnce({
      home: h5home, compile, save, homeDir: h5homeDir,
      open: async () => ({ close: async () => {} }) as never,
      isApproved: async (agent) => agent !== "ghost-agent",
      checkProject: async (input) =>
        input.cwd === cwd
          ? { ok: true as const, approval: { agent: input.agent, projectId: "p-h5", root: cwd, approvedAt: "2026-09-21T00:00:00.000Z" } }
          : { ok: false as const, reason: "not-a-project" as const },
      now: () => new Date(T0),
    })
  await drain()

  const logFile = h5home.path("logs/drain.jsonl")
  const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : ""
  const reasons = new Set(
    text.split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as { reason?: string }).reason).filter((r): r is string => typeof r === "string"),
  )
  const stableCodes = [...reasons].every((r) => /^[a-z][a-z0-9-]+$/.test(r))
  const leaks =
    text.includes(CANARY) ||
    text.includes(goodTranscript) ||
    text.includes(h5dir) ||
    text.includes("rpc unreachable") ||
    text.includes("Error:")
  return {
    pass: reasons.size >= 4 && stableCodes && !leaks,
    value: { distinctReasons: reasons.size, reasons: [...reasons].sort(), stableCodes, leaked: leaks },
    limit: null,
  }
}

try {
  await runGroup([
    { id: "H1", run: h1 },
    { id: "H2", run: h2 },
    { id: "H3", run: h3 },
    { id: "H4", run: h4 },
    { id: "H5", run: h5 },
    { id: "G1", skipped: "needs-real-agents" },
    { id: "G2", skipped: "needs-real-agents" },
  ])
} finally {
  await runtime.close()
  await chain.env.stop()
}
