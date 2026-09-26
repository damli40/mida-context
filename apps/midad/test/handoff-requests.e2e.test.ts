import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readScopeProbe, rpcTransportProbe } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome, Runtime, approve, callDaemon, init, requestAccess, saveCheckpoint,
  startDaemon, startPersistentApi,
} from "@mida/midad"
import type { DaemonHandle, HandoffResult, Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 60_000

const mark = (folder: string, projectId: string) => {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

/**
 * The R2 measurement: how many HTTP requests one session-start handoff costs on the local chain
 * with three saved checkpoints. The daemon runs in-process, so rpcTransportProbe counts every
 * chain call the handoff makes — the project check, the capability questions and the read. The
 * local chain carries no Multicall3, so every call must still resolve one by one (the fallback
 * proof) and the printed count is what the report compares before/after enabling batching.
 */
describe("the RPC request count of one session-start handoff (in-6 R2)", () => {
  let env: ScenarioEnvironment
  let apiServer: { baseUrl: string; close(): Promise<void> }
  let home: MidaHome
  let daemon: DaemonHandle | undefined
  let workDir: string

  beforeAll(async () => {
    env = await localEnvironment()
    const network: Network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    apiServer = await startPersistentApi({ rpcUrl: env.rpcUrl, deployment: env.deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-reqcount-data-")) })
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-reqcount-e2e-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-reqcount-work-"))
    mark(workDir, "proj-reqcount")
    const runtime = await Runtime.open(home, { ...network, storageUrl: apiServer.baseUrl })
    try {
      await init(runtime, ["claude-code", "codex"])
      await requestAccess(runtime, "claude-code")
      await approve(runtime, "claude-code", workDir)
      await requestAccess(runtime, "codex")
      await approve(runtime, "codex", workDir)
      for (const [sessionId, eventId] of [["sess-a", "cp-rc-01"], ["sess-b", "cp-rc-02"], ["sess-c", "cp-rc-03"]] as const) {
        await saveCheckpoint(runtime, "claude-code", {
          projectId: "proj-reqcount",
          sessionId,
          continuesSession: null,
          compiledBy: "test",
          checkpoint: sampleCheckpoint({ eventId, agent: "claude-code", objective: `o-${sessionId}` }),
        })
      }
    } finally {
      await runtime.close()
    }
    daemon = await startDaemon({
      home,
      network: { ...network, storageUrl: apiServer.baseUrl },
      compile: async () => { throw new Error("no saves in this test") },
      now: () => Date.now(),
      log: () => {},
      tickMs: 60_000,
    })
  }, STEP_TIMEOUT * 4)

  afterAll(async () => {
    await daemon?.close()
    await apiServer?.close()
    await env?.stop()
  }, 120_000)

  it("one handoff resolves with 3 checkpoints, and its request count is recorded", async () => {
    rpcTransportProbe.reset()
    readScopeProbe.reset()
    const result = (await callDaemon(home, "/handoff", { agent: "codex", cwd: workDir }, { timeoutMs: STEP_TIMEOUT })).body as HandoffResult
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.checkpoints).toBe(3)
    const count = rpcTransportProbe.sentAt.length
    console.log(
      `in-6 R2 / in-9 R5: one session-start handoff made ${count} HTTP request(s) on the local chain ` +
        `(read scope: ${readScopeProbe.hits} shared calls, ${readScopeProbe.misses} new questions)`,
    )
    // in-9 R-5: one operation asks each distinct question once. The repeated capability,
    // agent-record and block lookups (~30 of ~47 requests before the fix) collapse to one
    // wire call apiece; what remains is the per-object record reads and the capability gate.
    expect(count).toBeLessThanOrEqual(30)
  }, STEP_TIMEOUT)
})
