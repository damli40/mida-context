import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome, Runtime, approve, authorNamesFor, buildHandoff, checkProject, init,
  linkProject, readCheckpoints, requestAccess, saveCheckpoint,
} from "@mida/midad"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const STEP_TIMEOUT = 120_000

/**
 * lk-1 — `mida link` makes one project live in two folders: a checkpoint an approved agent saved
 * under the project in folder A is the handoff that agent receives when it opens folder B. The
 * link itself is a filesystem + signed-list operation only — the owner's transaction count on
 * the chain must not move, and the store's record count must not either: nothing is copied.
 */
describe("mida link — a handoff saved in A is the handoff read in B (lk-1)", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  let dirA: string
  let dirB: string
  let projectId: string

  const ownerTxCount = () => runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })
  const recordCount = async () => (await readCheckpoints(runtime, "claude-code", projectId)).checkpoints.length

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-link-e2e-")))
    runtime = await Runtime.open(home, network)
    dirA = mkdtempSync(join(tmpdir(), "mida-link-e2e-a-"))
    dirB = mkdtempSync(join(tmpdir(), "mida-link-e2e-b-"))

    await init(runtime, ["claude-code", "codex"])
    await requestAccess(runtime, "claude-code")
    // approve in A: the chain grant plus the signed project row for folder A
    const approval = await approve(runtime, "claude-code", dirA)
    projectId = approval.projectId!
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("B joins A's project with no transaction and no copied records, and the agent reads A's handoff there", async () => {
    // before the link, B is just a folder — the gate has nothing to check
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirB })).toEqual({ ok: false, reason: "not-a-project" })

    // claude-code saves a checkpoint under the project, in A, through the real store path
    await saveCheckpoint(runtime, "claude-code", {
      projectId,
      sessionId: "s-link",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({
        eventId: "cp-link-01",
        objective: "link keeps one project in two folders",
        originalRequest: "prove lk-1 end to end",
        nextAction: "read this handoff in B",
      }),
    })
    const recordsBefore = await recordCount()

    // the link — the owner's chain transaction count must not move
    const txBefore = await ownerTxCount()
    const linked = await linkProject(runtime, { projectId, dir: dirB })
    expect(await ownerTxCount()).toBe(txBefore)
    expect(linked.added).toEqual(["claude-code"])

    // the gate in B now answers ok for the approved agent — and still refuses the unapproved one
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirB })).toMatchObject({ ok: true })
    expect(await checkProject(runtime, { agent: "codex", cwd: dirB })).toEqual({ ok: false, reason: "not-approved" })

    // the invariant: the handoff the agent receives in B is the one saved in A — the same
    // function the daemon's /handoff route builds, and nothing was copied to get it there
    const result = await buildHandoff(runtime, { agent: "claude-code", cwd: dirB, authorNames: authorNamesFor(runtime) })
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain("link keeps one project in two folders")
    expect(await recordCount()).toBe(recordsBefore)

    // and the same handoff is still served from A itself — linking moved nothing
    const fromA = await buildHandoff(runtime, { agent: "claude-code", cwd: dirA, authorNames: authorNamesFor(runtime) })
    expect(fromA.kind).toBe("handoff")
    if (fromA.kind !== "handoff") return
    expect(fromA.text).toContain("link keeps one project in two folders")
  }, STEP_TIMEOUT)
})
