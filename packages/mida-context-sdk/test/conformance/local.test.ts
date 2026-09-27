import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { CompileInput, CompileResult } from "@mida/compiler"
import {
  MidaHome,
  NAMESPACE,
  Runtime,
  approve,
  init,
  requestAccess,
  revoke,
  startDaemon,
} from "@mida/midad"
import { Mida } from "../../src/index.js"
import { conformanceSuite } from "./suite.js"
import type { ConformanceSetup } from "./suite.js"

const PROJECT_ID = "proj-conformance-local"
const WRITER = "conf-writer"

const compile = async (input: CompileInput): Promise<CompileResult> => ({
  ok: true,
  checkpoint: {
    eventId: input.eventId,
    agent: input.agent,
    source: "agent-tool",
    createdAt: new Date().toISOString(),
    objective: "stub",
    originalRequest: null,
    progress: [],
    decisions: [],
    rejected: [],
    constraints: [],
    artifacts: [],
    unresolvedIssue: null,
    nextAction: "stub",
    remainingPlan: [],
    evidence: [],
  },
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

/**
 * The `local` transport against a real midad on local Anvil — the writer is provisioned and
 * approved exactly as `mida init`/`request`/`approve` would leave it, the batching lane is on
 * so rapid writes queue honestly, and the revoke goes through the owner runtime.
 */
conformanceSuite("local", async (): Promise<ConformanceSetup> => {
  const env = await localEnvironment({ batching: { waitMs: 200 } })
  const network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund, storageUrl: env.apiBaseUrl }
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-conformance-")))
  const workDir = mkdtempSync(join(tmpdir(), "mida-conformance-work-"))
  mkdirSync(join(workDir, ".mida"))
  writeFileSync(join(workDir, ".mida", "project.json"), JSON.stringify({ projectId: PROJECT_ID }))

  let seedId = "" as `0x${string}`
  const runtime = await Runtime.open(home, { ...network })
  try {
    await init(runtime, [WRITER])
    await requestAccess(runtime, WRITER)
    await approve(runtime, WRITER, workDir)
    // the supersede target — a direct-lane write, anchored before the suite opens
    const seed = await runtime
      .agent(WRITER)
      .create(runtime.owner, NAMESPACE, { value: { note: "seed" }, kind: "INFERENCE", source: "AGENT_INFERRED" })
    seedId = seed.contextId
  } finally {
    await runtime.close()
  }
  // `mida batching on` — rapid writes take the 60/minute lane and land pending
  home.writeSecretJson("network.json", {
    ...(home.readJson("network.json") as Record<string, unknown>),
    storageUrl: env.apiBaseUrl,
    batching: true,
  })
  const daemon = await startDaemon({
    home,
    network,
    compile,
    now: () => Date.now(),
    log: () => {},
    drainDeps: { homeDir: mkdtempSync(join(tmpdir(), "mida-conformance-userhome-")) },
    tickMs: 30_000,
  })
  return {
    namespace: NAMESPACE,
    writer: WRITER,
    seed: { id: seedId },
    client: (agent) => new Mida({ agent, project: workDir, home: home.root }),
    revoke: async (agent) => {
      const owner = await Runtime.open(home, { ...network })
      try {
        await revoke(owner, agent)
      } finally {
        await owner.close()
      }
    },
    close: async () => {
      await daemon.close()
      await env.stop()
    },
  }
})
