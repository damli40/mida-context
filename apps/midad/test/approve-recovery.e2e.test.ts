// UF-AP — Oct 2 live bug: `mida approve --all` sent a grant whose sponsored transaction landed
// on chain, but the sponsor's reply was lost to a timeout. The send seam then failed the whole
// approve AFTER the chain work was done: no `completeAccessRequest`, no `grants.json`, and the
// pending request was left behind. From then on `approve` answered "already approved on chain"
// while the agent's reads were refused CAPABILITY_DENIED forever.
//
// The fix: a second `approve` discovers the landed grant — by finding the transaction that
// emitted CapabilityGranted for the pending request's capabilities inside the request's
// validity window — rebuilds the exact AccessGrantResponse `approveGrant` would have returned,
// republishes the read keys, and completes the request through the unchanged SDK check. No
// second transaction is ever sent.
//
// The lost-reply seam: the vault's `approveGrant` is wrapped so it runs the real grant (which
// lands on chain) and then throws the timeout the send path saw, and `publishReaderWraps` is
// stubbed for that call — in the incident the send threw before approveGrant reached it. That
// is the smallest seam that lands the transaction without letting the post-send steps run —
// nothing inside skeleton.ts is faked, and `completeAccessRequest` still validates the rebuilt
// response against the chain.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hex } from "viem"
import { HttpRequestError } from "viem"
import { MidaError, encodeUint64, PERMISSION, namespaceId } from "@mida/protocol"
import type { AccessRequest } from "@mida/protocol"
import { increaseLocalTime, rpcTransportProbe } from "@mida/chain"
import { expandScopeInputs } from "@mida/grant-advisor"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  NAMESPACE,
  Runtime,
  approve,
  buildHandoff,
  expectedScopesFor,
  init,
  isRevoked,
  loadAgentIdentity,
  loadGrants,
  markWrapsOwed,
  ownerRefusalLine,
  readCheckpoints,
  repairReaderWraps,
  requestAccess,
  revoke,
  saveCheckpoint,
  saveGrants,
  grantResponseFromLogs,
  FACT_NAMESPACES,
} from "@mida/midad"
import type { ApprovePreview } from "@mida/midad"
import type { DecodedLog } from "@mida/chain"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const AGENTS = ["claude-code", "codex", "cursor", "devin", "zed", "kiro", "windsurf", "amp"] as const

/** The lost-reply seam, faithful to the Oct 2 incident: the sponsored send threw AFTER the
 * grant transaction was mined, so nothing past the send in approveGrant ran — including the
 * read-key publish at its tail. The test wraps `publishReaderWraps` to a no-op (the wraps the
 * real call sent are the ones recovery must republish) and `approveGrant` to throw the timeout
 * after the real call has landed the transaction. */
function loseReplyAfterSend(runtime: Runtime): () => void {
  const vault = runtime.vault as unknown as {
    approveGrant: (input: never) => Promise<unknown>
    publishReaderWraps: (input: never) => Promise<unknown>
  }
  const realApprove = vault.approveGrant.bind(runtime.vault) as (input: never) => Promise<unknown>
  const realWraps = vault.publishReaderWraps.bind(runtime.vault) as (input: never) => Promise<unknown>
  vault.publishReaderWraps = (async () => []) as never
  vault.approveGrant = (async (input: never) => {
    await realApprove(input)
    throw new Error("The request timed out.")
  }) as never
  return () => {
    ;(vault as { approveGrant: unknown }).approveGrant = realApprove
    ;(vault as { publishReaderWraps: unknown }).publishReaderWraps = realWraps
  }
}

const pendingRequest = (home: MidaHome, name: string): AccessRequest | undefined =>
  home.readJson<{ request: AccessRequest }>(`agents/${name}/pending-request.json`)?.request

const projectIdOf = (dir: string): string =>
  (JSON.parse(readFileSync(join(dir, ".mida", "project.json"), "utf8")) as { projectId: string }).projectId

const ownerNonce = (runtime: Runtime): Promise<number> =>
  runtime.chain.publicClient.getTransactionCount({ address: runtime.owner })

describe("an approval that landed on chain but was never recorded is finished by running approve again", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let workDir: string
  let runtime: Runtime

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ufap-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-ufap-proj-"))
    runtime = await Runtime.open(home, network)
    await init(runtime, [...AGENTS])
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("a grant whose reply was lost is recorded by the second approve, sending no transaction", async () => {
    await requestAccess(runtime, "codex")
    const requestId = pendingRequest(home, "codex")!.requestId

    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "codex", workDir)).rejects.toThrow(/timed out/i)
    restore()

    // The bug state: the grant is live on chain, this machine never recorded it.
    expect(home.has("agents/codex/pending-request.json")).toBe(true)
    expect(home.has("agents/codex/grants.json")).toBe(false)
    await expect(readCheckpoints(runtime, "codex", "projects.current")).rejects.toThrow()

    const nonceBefore = await ownerNonce(runtime)
    // The rebuilt response must still pass through the unchanged SDK check — a spy on the agent's
    // own completeAccessRequest proves a grant was recorded the only way grants ever are.
    const complete = vi.spyOn(runtime.agent("codex"), "completeAccessRequest")
    const result = await approve(runtime, "codex", workDir)
    expect(complete).toHaveBeenCalledTimes(1)
    complete.mockRestore()
    expect(await ownerNonce(runtime)).toBe(nonceBefore) // no second transaction was sent

    expect(result.completedEarlier).toBe(true)
    expect(result.transactionHash).toBeNull()

    // The grant is recorded; the pending request is consumed and removed.
    expect(home.has("agents/codex/pending-request.json")).toBe(false)
    expect(loadGrants(home, "codex").some((grant) => grant.requestId === requestId)).toBe(true)

    // The agent works: it can save, read and build a handoff — the read keys were republished.
    const projectId = projectIdOf(workDir)
    const saved = await saveCheckpoint(runtime, "codex", {
      projectId,
      sessionId: "s-ufap",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "codex", eventId: "cp-ufap-1" }),
    })
    const read = await readCheckpoints(runtime, "codex", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
    const handoff = await buildHandoff(runtime, { agent: "codex", cwd: workDir, authorNames: {}, sessionId: "s-ufap-2" })
    expect(handoff.kind).not.toBe("refused")
  }, 300_000)

  it("a third approve is an ordinary already-approved — no recovery flags", async () => {
    const result = await approve(runtime, "codex", workDir)
    expect(result.completedEarlier).toBeUndefined()
    expect(result.unrecorded).toBeUndefined()
    expect(result.transactionHash).toBeNull()
  }, 300_000)

  it("an agent approved normally never takes the recovery path — no CapabilityGranted log scan", async () => {
    await requestAccess(runtime, "claude-code")
    const getLogs = vi.spyOn(runtime.chain.publicClient, "getLogs")
    // reader.now is the recovery's first chain read (the liveness window for the candidate
    // capabilities); a normal approve never calls it — hasAuthority answers without it.
    const now = vi.spyOn(runtime.reader, "now")
    try {
      const result = await approve(runtime, "claude-code", workDir)
      expect(result.completedEarlier).toBeUndefined()
      expect(result.transactionHash).not.toBeNull()
      // The normal path must never scan grant history: no getLogs call asks for CapabilityGranted.
      const grantedScans = getLogs.mock.calls.filter(
        (call) => (call[0] as { event?: { name?: string } }).event?.name === "CapabilityGranted",
      )
      expect(grantedScans).toHaveLength(0)
      expect(now).not.toHaveBeenCalled()
    } finally {
      getLogs.mockRestore()
      now.mockRestore()
    }
  }, 300_000)

  it("a pending request whose grant transaction cannot be found reports unrecorded, and writes nothing", async () => {
    // cursor was approved normally, then the home was "restored without its grant": both files
    // gone, the chain still approving it. A fresh stored request with a validity window that
    // ended before the grant was mined is the cannot-find case — the scan bounds itself to the
    // request's own window and the real transaction sits outside it.
    await requestAccess(runtime, "cursor")
    const first = await approve(runtime, "cursor", workDir)
    expect(first.transactionHash).not.toBeNull()
    home.remove("agents/cursor/grants.json")
    const request = await runtime.agent("cursor").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
    })
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const stale: AccessRequest = {
      ...request,
      issuedAt: encodeUint64(chainNow - 3_600n),
      requestExpiresAt: encodeUint64(chainNow - 3_300n),
    }
    home.writeSecretJson(`requests/cursor/${request.requestId.toLowerCase()}.json`, stale)
    home.writeSecretJson("agents/cursor/pending-request.json", { request: stale })

    const nonceBefore = await ownerNonce(runtime)
    const result = await approve(runtime, "cursor", workDir)
    expect(await ownerNonce(runtime)).toBe(nonceBefore)
    expect(result.unrecorded).toBe(true)
    expect(result.completedEarlier).toBeUndefined()
    expect(home.has("agents/cursor/grants.json")).toBe(false)
    home.remove("agents/cursor/pending-request.json")
  }, 300_000)

  it("a home restored without its grant and no request reports unrecorded, and nothing is written", async () => {
    // The end state of the last test: cursor is approved on chain, grants.json is gone, no
    // pending request exists — the plainest "approved but never recorded here" there is.
    expect(home.has("agents/cursor/grants.json")).toBe(false)
    expect(home.has("agents/cursor/pending-request.json")).toBe(false)
    const nonceBefore = await ownerNonce(runtime)
    const result = await approve(runtime, "cursor", workDir)
    expect(await ownerNonce(runtime)).toBe(nonceBefore)
    expect(result.unrecorded).toBe(true)
    expect(result.completedEarlier).toBeUndefined()
    expect(home.has("agents/cursor/grants.json")).toBe(false)
  }, 300_000)

  it("a rebuilt response naming a capability the request never got is rejected by the SDK check", async () => {
    // The recovery must go through completeAccessRequest, never write grants.json itself: a
    // response built the same way but naming a foreign capability id is refused by the chain
    // read inside the unchanged SDK validation.
    const request = await runtime.agent("devin").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
    })
    const wrongLog = {
      args: {
        capabilityId: `0x${"ee".repeat(32)}`,
        agentId: request.agentId,
        owner: runtime.owner,
        namespaceId: request.scopes[0]!.namespaceId,
        permissions: request.scopes[0]!.permissions,
        provenancePolicy: request.scopes[0]!.provenancePolicy,
        expiresAt: 0n,
      },
      transactionHash: `0x${"dd".repeat(32)}` as Hex,
      blockNumber: 1n,
      logIndex: 0,
      transactionIndex: 0,
    } satisfies DecodedLog
    const forged = grantResponseFromLogs(request, runtime.owner, [wrongLog])
    await expect(runtime.agent("devin").completeAccessRequest(request, forged)).rejects.toThrow()
  }, 300_000)

  // UF-APR 2: the grant the recovery finds must be THIS request's. A second pending request for
  // the same scopes must not adopt the earlier grant's logs — their request hash differs.
  it("a grant that covers the scopes but came from another request is not this request's recovery", async () => {
    await requestAccess(runtime, "devin")
    await approve(runtime, "devin", workDir)
    const grantsBefore = loadGrants(home, "devin").length

    // A second pending request over the very same scopes — a different requestId and a
    // different request hash from the grant that already landed.
    const second = await runtime.agent("devin").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
    })
    home.writeSecretJson(`requests/devin/${second.requestId.toLowerCase()}.json`, second)
    home.writeSecretJson("agents/devin/pending-request.json", { request: second })

    const nonceBefore = await ownerNonce(runtime)
    const result = await approve(runtime, "devin", workDir)
    expect(await ownerNonce(runtime)).toBe(nonceBefore)
    // The earlier grant's request hash is not this request's: no completedEarlier, no second
    // grant entry — the answer is the ordinary already-approved one, and the record is untouched.
    expect(result.completedEarlier).toBeUndefined()
    expect(result.unrecorded).toBeUndefined()
    expect(loadGrants(home, "devin")).toHaveLength(grantsBefore)
    home.remove("agents/devin/pending-request.json")
  }, 300_000)

  // UF-APR 3: recovery may list the folder it ran in, but only behind the same typed project
  // question the ordinary already-approved answer asks.
  it("a recovered approval asks the project question, and a decline leaves the folder unlisted", async () => {
    const folderA = mkdtempSync(join(tmpdir(), "mida-ufapr-a-"))
    const folderB = mkdtempSync(join(tmpdir(), "mida-ufapr-b-"))
    await requestAccess(runtime, "zed")
    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "zed", folderA)).rejects.toThrow(/timed out/i)
    restore()
    expect(home.has("agents/zed/pending-request.json")).toBe(true)
    expect(home.has("agents/zed/grants.json")).toBe(false)

    const asks: ApprovePreview[] = []
    const confirm = async (preview: ApprovePreview) => {
      asks.push(preview)
      return false
    }
    await expect(approve(runtime, "zed", folderB, confirm)).rejects.toMatchObject({ code: "not-approved" })

    // Exactly one question, and it is the typed project question for folder B — never a grant
    // question, since recovery sends nothing to decide on.
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: "project", agent: "zed", projectId: projectIdOf(folderB) })

    // The grant was already on chain, so it is recorded; the declined folder is not listed.
    expect(home.has("agents/zed/pending-request.json")).toBe(false)
    expect(loadGrants(home, "zed").length).toBe(1)
    const listed = home.readJson<{ entries: { agent: string; projectId: string }[] }>("approved-projects.json")
    expect(listed?.entries.some((e) => e.agent === "zed" && e.projectId === projectIdOf(folderB)) ?? false).toBe(false)
  }, 300_000)

  // UF-APR 4: a chain read that throws during recovery is a coded refusal, not "not found" —
  // nothing is written, and a retry finishes the approval.
  it("a chain read that fails during recovery rejects approval-check-failed and writes nothing", async () => {
    await requestAccess(runtime, "kiro")
    const requestId = pendingRequest(home, "kiro")!.requestId
    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "kiro")).rejects.toThrow(/timed out/i)
    restore()

    const getBlock = vi.spyOn(runtime.chain.publicClient, "getBlock").mockRejectedValue(new Error("the RPC is down"))
    try {
      await expect(approve(runtime, "kiro")).rejects.toMatchObject({ code: "approval-check-failed" })
    } finally {
      getBlock.mockRestore()
    }

    // Nothing was written: the pending request survives and no grant was recorded.
    expect(pendingRequest(home, "kiro")!.requestId).toBe(requestId)
    expect(home.has("agents/kiro/grants.json")).toBe(false)

    const result = await approve(runtime, "kiro")
    expect(result.completedEarlier).toBe(true)
    expect(loadGrants(home, "kiro").some((grant) => grant.requestId === requestId)).toBe(true)
  }, 300_000)

  // UF-APR 5: the unrecorded answer looks at live recorded capabilities across ALL saved
  // grants — two grants that each cover part of the approval count together.
  it("an agent approved in two grants stays recorded — coverage is across every saved grant", async () => {
    const scopes = expectedScopesFor("project_assistance")
    // First request asks for one scope only, second for the rest — two grants on disk.
    const first = await runtime.agent("windsurf").createAccessRequest({
      purposeId: "project_assistance",
      scopes: scopes.slice(0, 1),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
    })
    home.writeSecretJson(`requests/windsurf/${first.requestId.toLowerCase()}.json`, first)
    home.writeSecretJson("agents/windsurf/pending-request.json", { request: first })
    await approve(runtime, "windsurf")
    const second = await runtime.agent("windsurf").createAccessRequest({
      purposeId: "project_assistance",
      scopes,
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
    })
    home.writeSecretJson(`requests/windsurf/${second.requestId.toLowerCase()}.json`, second)
    home.writeSecretJson("agents/windsurf/pending-request.json", { request: second })
    await approve(runtime, "windsurf")
    expect(loadGrants(home, "windsurf").length).toBe(2)

    const result = await approve(runtime, "windsurf", workDir)
    expect(result.unrecorded).toBeUndefined()
    expect(result.completedEarlier).toBeUndefined()
  }, 300_000)

  it("a grant left from before a revoke does not cover the approval that replaced it", async () => {
    await requestAccess(runtime, "amp")
    await approve(runtime, "amp")
    expect(loadGrants(home, "amp").length).toBe(1)
    await revoke(runtime, "amp")

    // A fresh request lands on chain but its reply is lost — the old grant stays on disk but
    // every capability id in it is dead now.
    await requestAccess(runtime, "amp")
    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "amp")).rejects.toThrow(/timed out/i)
    restore()

    // Keep recovery from finishing it: the stored request's validity window is moved into the
    // past, so the landed transaction sits outside the scan — the unrecorded answer must stand.
    const request = pendingRequest(home, "amp")!
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const stale: AccessRequest = {
      ...request,
      issuedAt: encodeUint64(chainNow - 3_600n),
      requestExpiresAt: encodeUint64(chainNow - 3_300n),
    }
    home.writeSecretJson(`requests/amp/${request.requestId.toLowerCase()}.json`, stale)
    home.writeSecretJson("agents/amp/pending-request.json", { request: stale })

    const result = await approve(runtime, "amp", workDir)
    expect(result.unrecorded).toBe(true)
    expect(result.completedEarlier).toBeUndefined()
    // The only grant on disk is still the dead one from before the revoke.
    expect(loadGrants(home, "amp").length).toBe(1)
    home.remove("agents/amp/pending-request.json")
  }, 300_000)

  // UF-APR2 Gap B: on the already-approved path the chain read that decides `unrecorded` runs
  // BEFORE the folder row is written. A read that throws must reject coded with nothing
  // written, not list the folder and then fail anyway.
  it("an already-approved approve whose chain read fails rejects approval-check-failed and writes nothing", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr2-b-"))
    const entries = () => home.readJson<{ entries: { agent: string; projectId: string }[] }>("approved-projects.json")?.entries ?? []
    const before = entries()

    // codex is approved and recorded, no pending request: approve takes the already-approved
    // path. Its first reader.getCapability call is liveCapabilityIdsOf, the read the finding
    // names; failing it once is that read throwing.
    const getCapability = vi.spyOn(runtime.reader, "getCapability").mockRejectedValueOnce(new Error("the RPC is down"))
    try {
      await expect(approve(runtime, "codex", folder)).rejects.toMatchObject({ code: "approval-check-failed" })
    } finally {
      getCapability.mockRestore()
    }
    expect(entries()).toEqual(before)
  }, 300_000)

  // UF-APR2 Gap A: only the SDK's own refusal codes mean "not this request's grant". A plain
  // Error, a rate limit here, is a check that never ran: approval-check-failed, nothing
  // written, and the next approve still finishes the landed grant.
  it("a 429 thrown by the SDK check during recovery rejects approval-check-failed, then finishes", async () => {
    await init(runtime, ["wraith"])
    await requestAccess(runtime, "wraith")
    const requestId = pendingRequest(home, "wraith")!.requestId
    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "wraith")).rejects.toThrow(/timed out/i)
    restore()
    expect(home.has("agents/wraith/grants.json")).toBe(false)

    const complete = vi.spyOn(runtime.agent("wraith"), "completeAccessRequest").mockRejectedValueOnce(new Error("429 Too Many Requests"))
    try {
      await expect(approve(runtime, "wraith")).rejects.toMatchObject({ code: "approval-check-failed" })
    } finally {
      complete.mockRestore()
    }
    expect(home.has("agents/wraith/grants.json")).toBe(false)
    expect(pendingRequest(home, "wraith")!.requestId).toBe(requestId)

    const result = await approve(runtime, "wraith")
    expect(result.completedEarlier).toBe(true)
    expect(loadGrants(home, "wraith").some((grant) => grant.requestId === requestId)).toBe(true)
  }, 300_000)

  // UF-APR2: re-running init re-grants assistant. The fresh grant must not leave behind the
  // revoked marker an earlier revoke wrote, or reads stay refused against a live grant.
  it("init after a revoke re-grants assistant and removes its revoked marker", async () => {
    await init(runtime, ["assistant"])
    await revoke(runtime, "assistant")
    expect(home.has("agents/assistant/revoked.json")).toBe(true)

    await init(runtime, ["assistant"])
    expect(home.has("agents/assistant/revoked.json")).toBe(false)
    // assistant is a general assistant: it reads its own READ scopes, never project context.
    const read = await runtime.agent("assistant").readWithStatus(runtime.owner, "profile.skills")
    expect(read.objects).toBeDefined()
  }, 300_000)
})

// UF-APR 1: the lost first approve may have replaced an expired read key, which invalidates
// every other reader's wraps. Recovery cannot tell whether it did, so after republishing the
// recovered agent's wraps it re-sends the new key to every approved reader over the recovered
// READ namespaces — the same pass the normal path runs after a rotation.
describe("recovery re-sends the new read key to every approved reader, not just the recovered agent", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let workDir: string
  let runtime: Runtime

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ufapr-")))
    workDir = mkdtempSync(join(tmpdir(), "mida-ufapr-proj-"))
    runtime = await Runtime.open(home, network)
    // agent-x and agent-y are registered up front: once a test below has moved the chain's
    // clock, init can no longer run (the API refuses a fresh manifest as "in the future").
    await init(runtime, ["claude-code", "codex", "agent-x", "agent-y"])
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  it("a recovered renewal repairs the reader whose wraps the rotation invalidated", async () => {
    // claude-code is approved first and saves a checkpoint — the row it must still be able to
    // read after codex's grant renews under a replaced key.
    await requestAccess(runtime, "claude-code")
    await approve(runtime, "claude-code", workDir)
    const projectId = projectIdOf(workDir)
    const saved = await saveCheckpoint(runtime, "claude-code", {
      projectId,
      sessionId: "s-ufapr",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "claude-code", eventId: "cp-ufapr-y" }),
    })

    // codex is approved with a one-day grant, so its READ grant dies while claude-code's
    // thirty-day one is still live — the asymmetry the incident needs.
    const short = await runtime.agent("codex").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
    })
    home.writeSecretJson(`requests/codex/${short.requestId.toLowerCase()}.json`, short)
    home.writeSecretJson("agents/codex/pending-request.json", { request: short })
    await approve(runtime, "codex")

    // Two days on the local chain's clock: codex's grant has expired — which closed the write
    // epoch — and claude-code's has not.
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)

    // codex asks again; this approve rotates the dead reader's epoch, lands the grant, and
    // loses the reply — claude-code's wraps are for the old epoch now.
    await requestAccess(runtime, "codex")
    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "codex")).rejects.toThrow(/timed out/i)
    restore()

    const result = await approve(runtime, "codex")
    expect(result.completedEarlier).toBe(true)

    // A checkpoint saved under the new epoch is unreadable to a reader whose wraps were never
    // re-sent: recovery had to publish the new key to claude-code too, not only to codex.
    const own = await saveCheckpoint(runtime, "codex", {
      projectId,
      sessionId: "s-ufapr-x",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "codex", eventId: "cp-ufapr-x" }),
    })
    const read = await readCheckpoints(runtime, "claude-code", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
    expect(read.checkpoints.some((cp) => cp.contextId === own.contextId)).toBe(true)
    expect((await readCheckpoints(runtime, "codex", projectId)).checkpoints.some((cp) => cp.contextId === own.contextId)).toBe(true)
  }, 600_000)

  // UF-APR2-1: the same lockout on the ORDINARY send path. The first approve of a renewal
  // replaces the expired read key and then dies before the grant is sent; the second approve
  // finds nothing to rotate, so only an unconditional re-send reaches the other readers.
  it("a renewal whose first try rotated the key and died before the grant send still repairs every reader", async () => {
    const projectId = "proj-ufapr2-1"

    // agent-y holds the ordinary thirty-day grant; agent-x a one-day grant that dies first.
    // The earlier test already moved the chain's clock, so the short expiry is measured off
    // the chain's time, not the wall clock.
    await requestAccess(runtime, "agent-y")
    await approve(runtime, "agent-y")
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const short = await runtime.agent("agent-x").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: chainNow + 24n * 60n * 60n,
    })
    home.writeSecretJson(`requests/agent-x/${short.requestId.toLowerCase()}.json`, short)
    home.writeSecretJson("agents/agent-x/pending-request.json", { request: short })
    await approve(runtime, "agent-x")

    // Two days on the local chain's clock: agent-x's grant expired and closed the write
    // epochs; agent-y's has not.
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)

    // agent-x asks again; this approve rotates the expired epochs and then dies BEFORE the
    // grant is sent; the wrapped approveGrant throws without calling through, so the
    // replacement keys exist but no grant landed.
    await requestAccess(runtime, "agent-x")
    const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
    const realApprove = vault.approveGrant.bind(runtime.vault)
    vault.approveGrant = (async () => {
      throw new Error("The request timed out.")
    }) as never
    await expect(approve(runtime, "agent-x")).rejects.toThrow(/timed out/i)
    vault.approveGrant = realApprove as never
    expect(home.has("agents/agent-x/pending-request.json")).toBe(true)

    // The retry is an ordinary send: nothing to rotate, the grant lands, and the key must
    // still reach agent-y.
    const result = await approve(runtime, "agent-x")
    expect(result.transactionHash).not.toBeNull()
    expect(result.completedEarlier).toBeUndefined()

    const saved = await saveCheckpoint(runtime, "agent-x", {
      projectId,
      sessionId: "s-ufapr2-x",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-x", eventId: "cp-ufapr2-x" }),
    })
    // agent-y reads the new-epoch row only if the second approve re-sent the key it never got.
    const readY = await readCheckpoints(runtime, "agent-y", projectId)
    expect(readY.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
    const readX = await readCheckpoints(runtime, "agent-x", projectId)
    expect(readX.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
  }, 600_000)
})

// UF-APR3: after the grant lands on chain, a failure at any later step must be finishable by
// running `mida approve <name>` once more, and every line printed on the way must be true. The
// key re-send used to run after saveGrants but BEFORE the revoked marker and pending request
// were removed and before the folder was listed, with no guard: one 429 in its authority loop
// threw out of approve and stranded an approval the chain had already accepted, with
// pending-request.json left behind so no later command could finish it.
describe("a failed step after the grant lands keeps the approval finishable", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  const lines: string[] = []

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ufapr3-")))
    runtime = await Runtime.open(home, network)
    // Every agent is registered up front: once a test below moves the chain's clock, init can
    // no longer run (the API refuses a fresh manifest as "in the future").
    await init(runtime, ["agent-x", "agent-y", "agent-r1", "agent-r2", "agent-a4", "agent-w1", "agent-p1", "agent-p2", "agent-p3", "agent-d2a", "agent-d2b", "agent-d3", "agent-d4", "agent-d4r", "codex", "cursor", "devin"])
    runtime.progress = (line: string) => lines.push(line)
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  // One RPC failure at the re-send's authority check: completeAccessRequest has already run, so
  // the first hasAuthority the reader is asked for afterwards is the re-send's own target
  // enumeration. The rest of approve must survive it.
  const failFirstResendCheck = (name: string): (() => void) => {
    const agent = runtime.agent(name)
    const realComplete = agent.completeAccessRequest.bind(agent)
    let completed = false
    const complete = vi.spyOn(agent, "completeAccessRequest").mockImplementation(async (request, response) => {
      const grant = await realComplete(request, response)
      completed = true
      return grant
    })
    const realHas = runtime.reader.hasAuthority.bind(runtime.reader)
    let thrown = false
    const has = vi.spyOn(runtime.reader, "hasAuthority").mockImplementation(async (...args: Parameters<typeof realHas>) => {
      if (completed && !thrown) {
        thrown = true
        throw new Error("HTTP request failed. Status: 429")
      }
      return realHas(...args)
    })
    return () => {
      complete.mockRestore()
      has.mockRestore()
    }
  }

  const approvedEntries = () =>
    home.readJson<{ entries: { agent: string; projectId: string }[] }>("approved-projects.json")?.entries ?? []

  // The checkpoint agent-x seals to the fresh epoch in the first test: the repair proofs after
  // it have to show agent-y reading exactly this row.
  let a1ContextId: Hex | undefined

  // UF-APR3 A4: one approve sends each namespace key to each reader at most once. approveGrant
  // already publishes the new agent's wraps, so the repair pass owes the key only to the OTHER
  // readers, and the "sending the new key to N agents" line may only run when a send is owed.
  // These two tests run FIRST in the describe, while no test has moved the chain clock, so no
  // expired grant can pull a rotation (and its sends) into the count.
  const watchPublishes = () => {
    const realPublish = runtime.vault.publishReaderWraps.bind(runtime.vault)
    const sent: { agentId: Hex; namespaceId: Hex }[] = []
    const spy = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input) => {
      sent.push({ agentId: input.agentId, namespaceId: input.namespaceId })
      return realPublish(input)
    })
    return { sent, restore: () => spy.mockRestore() }
  }

  it("an approve sends each reader each key at most once, and counts only real sends", async () => {
    // The reviewer's measured case: three agents already approved, then a fourth approves.
    for (const name of ["agent-p1", "agent-p2", "agent-p3"]) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }
    const watch = watchPublishes()
    lines.length = 0
    try {
      await requestAccess(runtime, "agent-a4")
      await approve(runtime, "agent-a4")
    } finally {
      watch.restore()
    }
    // No reader sees the same namespace key twice across approveGrant and the repair pass.
    const keys = watch.sent.map((s) => `${s.agentId.toLowerCase()}/${s.namespaceId.toLowerCase()}`)
    expect(new Set(keys).size).toBe(keys.length)
    // agent-a4 was sent each of the three project_assistance READ namespaces exactly once, by
    // approveGrant alone; the repair pass owes it nothing.
    const a4Id = loadAgentIdentity(home, "agent-a4")!.agentId.toLowerCase()
    expect(watch.sent.filter((s) => s.agentId.toLowerCase() === a4Id).length).toBe(3)
    // The repair pass sends to the three earlier readers once each: 9 sends there, 12 total.
    const otherReaders = new Set(watch.sent.filter((s) => s.agentId.toLowerCase() !== a4Id).map((s) => s.agentId.toLowerCase()))
    expect(otherReaders.size).toBe(3)
    expect(watch.sent.length).toBe(12)
    // UF-APR4: this run rotated nothing, so the pass is re-sending the CURRENT key — the line
    // must not claim a new key exists when none was minted.
    expect(lines).toContain("re-sending the read key to 3 agents…")
  }, 600_000)

  it("an approve that owes no read key prints no sending line", async () => {
    // agent-w1 asks for CREATE only on projects.current: no READ capability goes out,
    // approveGrant publishes no wrap, and the repair pass has no namespaces at all.
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const request = await runtime.agent("agent-w1").createAccessRequest({
      purposeId: "project_assistance",
      scopes: [{ namespace: "projects.current", permissions: PERMISSION.CREATE }],
      capabilityExpiresAt: chainNow + 24n * 60n * 60n,
    })
    home.writeSecretJson(`requests/agent-w1/${request.requestId.toLowerCase()}.json`, request)
    home.writeSecretJson("agents/agent-w1/pending-request.json", { request })
    const watch = watchPublishes()
    lines.length = 0
    try {
      await approve(runtime, "agent-w1")
    } finally {
      watch.restore()
    }
    expect(watch.sent.length).toBe(0)
    expect(lines.some((line) => line.startsWith("sending the new key to") || line.startsWith("re-sending the read key to"))).toBe(false)
  }, 600_000)

  it("a re-send that dies after the grant lands prints a note, keeps the approval, and cleans up", async () => {
    const projectId = "proj-ufapr3-a1"
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr3-a1-"))
    // agent-y is the established reader; agent-x gets the one-day grant that expires first.
    await requestAccess(runtime, "agent-y")
    await approve(runtime, "agent-y")
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const short = await runtime.agent("agent-x").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: chainNow + 24n * 60n * 60n,
    })
    home.writeSecretJson(`requests/agent-x/${short.requestId.toLowerCase()}.json`, short)
    home.writeSecretJson("agents/agent-x/pending-request.json", { request: short })
    await approve(runtime, "agent-x", folder)

    // The one-day grant dies and closes the write epochs; the renewal rotates them.
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)
    await requestAccess(runtime, "agent-x")

    const restore = failFirstResendCheck("agent-x")
    lines.length = 0
    let result
    try {
      result = await approve(runtime, "agent-x", folder)
    } finally {
      restore()
    }

    // The approval SUCCEEDED: the re-send's 429 is a note, not a refusal, and the note names the
    // one command that finishes the send.
    expect(result.transactionHash).not.toBeNull()
    expect(lines).toContain(
      "note: agent-x is approved, but Mida could not send the key to the other agents: HTTP request failed. Status: 429 — run `mida approve agent-x` again to finish",
    )
    // The consumed request and any stale marker are gone even though the send died.
    expect(home.has("agents/agent-x/pending-request.json")).toBe(false)
    expect(home.has("agents/agent-x/revoked.json")).toBe(false)
    expect(loadGrants(home, "agent-x").length).toBeGreaterThan(0)
    // UF-APR4 D1: the re-send died, so the owed-keys marker it wrote ahead of the send remains —
    // it is what makes the next already-approved approve run the pass.
    expect(home.has("wraps-owed.json")).toBe(true)
    // The folder row was written too.
    expect(approvedEntries().some((e) => e.agent === "agent-x" && e.projectId === projectIdOf(folder))).toBe(true)

    // The note was true: the send really did not happen. A checkpoint sealed to the new epoch
    // is still locked for agent-y.
    const saved = await saveCheckpoint(runtime, "agent-x", {
      projectId,
      sessionId: "s-ufapr3-a1",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-x", eventId: "cp-ufapr3-a1" }),
    })
    a1ContextId = saved.contextId
    await expect(readCheckpoints(runtime, "agent-y", projectId)).rejects.toThrow(/NO_EPOCH_WRAP|no reader wrap/)
    // UF-APR4 D1: the note's own command finishes the send — the first already-approved approve
    // sees the marker, runs the pass, and clears it. Nothing rotated in this run, so the line
    // says the pass re-sent the current key.
    lines.length = 0
    await expect(approve(runtime, "agent-x")).rejects.toThrow(/already approved/)
    expect(lines.some((line) => line.startsWith("re-sending the read key to "))).toBe(true)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  // UF-APR4 D1: once the marker is settled the already-approved answer is quiet — a second
  // approve sends nothing and prints no sending line. The repair itself was proven by the
  // previous test's approve.
  it("approving the already-approved agent again sends nothing — the marker was settled", async () => {
    lines.length = 0
    const watch = watchPublishes()
    try {
      await expect(approve(runtime, "agent-x")).rejects.toThrow(/already approved/)
    } finally {
      watch.restore()
    }
    expect(watch.sent.length).toBe(0)
    expect(lines.some((line) => line.startsWith("sending the new key to ") || line.startsWith("re-sending the read key to "))).toBe(false)
    expect(home.has("wraps-owed.json")).toBe(false)
    // agent-y got its key from the repair pass in the previous test and can read.
    const read = await readCheckpoints(runtime, "agent-y", "proj-ufapr3-a1")
    expect(read.checkpoints.some((cp) => cp.contextId === a1ContextId)).toBe(true)
  }, 600_000)

  it("a revoked-then-approved agent whose re-send dies loses the revoked marker and can save", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr3-b2-"))
    await requestAccess(runtime, "codex")
    await approve(runtime, "codex")
    await revoke(runtime, "codex")
    expect(home.has("agents/codex/revoked.json")).toBe(true)
    await requestAccess(runtime, "codex")

    const restore = failFirstResendCheck("codex")
    lines.length = 0
    let result
    try {
      result = await approve(runtime, "codex", folder)
    } finally {
      restore()
    }

    expect(result.transactionHash).not.toBeNull()
    expect(
      lines.some(
        (line) =>
          line.startsWith("note: codex is approved, but Mida could not send the key to the other agents:") &&
          line.endsWith("run `mida approve codex` again to finish"),
      ),
    ).toBe(true)
    // The marker must not survive beside a live grant: the MCP save check reads exactly this file.
    expect(home.has("agents/codex/revoked.json")).toBe(false)
    expect(home.has("agents/codex/pending-request.json")).toBe(false)
    expect(isRevoked(home, "codex")).toBe(false)

    // An MCP save is not refused as revoked: codex's own wraps came from the grant itself.
    const saved = await saveCheckpoint(runtime, "codex", {
      projectId: "proj-ufapr3-b2",
      sessionId: "s-ufapr3-b2",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "codex", eventId: "cp-ufapr3-b2" }),
    })
    expect(saved.contextId).toMatch(/^0x/)
  }, 600_000)

  it("a folder listing that fails after the grant lands is written by the next approve", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr3-list-"))
    await requestAccess(runtime, "cursor")

    // The signed list cannot be read once, so approveProject refuses instead of rewriting it.
    const realRead = home.readJson.bind(home)
    let failed = false
    const readJson = vi.spyOn(home, "readJson")
    readJson.mockImplementation(((relativePath: string) => {
      if (relativePath === "approved-projects.json" && !failed) {
        failed = true
        throw new Error("EACCES: permission denied")
      }
      return realRead(relativePath)
    }) as never)
    let listErr: unknown
    try {
      listErr = await approve(runtime, "cursor", folder).then(
        (result) => ({ result }),
        (e: unknown) => ({ err: e }),
      )
    } finally {
      readJson.mockRestore()
    }
    // UF-APR4: the row failed but the grant landed — the error says the agent IS approved and
    // names the retry that adds the folder, never the bare list error.
    expect(listErr).toMatchObject({ err: { code: "approved-unlisted" } })
    expect(ownerRefusalLine("approve", "cursor", (listErr as { err: unknown }).err)).toBe(
      "cursor is approved, but the approved-projects list could not be read — check the file's permissions, then run `mida approve cursor` here again to add this folder",
    )

    // The grant is recorded and the request is gone; only the folder row is missing.
    expect(home.has("agents/cursor/pending-request.json")).toBe(false)
    expect(loadGrants(home, "cursor").length).toBe(1)
    expect(approvedEntries().some((e) => e.agent === "cursor" && e.projectId === projectIdOf(folder))).toBe(false)

    // The next approve finds the agent already approved and writes the row this time.
    const result = await approve(runtime, "cursor", folder)
    expect(result.projectId).toBe(projectIdOf(folder))
    expect(approvedEntries().some((e) => e.agent === "cursor" && e.projectId === projectIdOf(folder))).toBe(true)
  }, 600_000)

  // UF-APR3 A2: a receipt read that fails during recovery is the CHECK failing, not proof the
  // transaction was not this request's grant. It must surface as approval-check-failed with
  // nothing written, and the retry on a healthy RPC finishes the landed approval.
  it("a receipt read that fails during recovery rejects approval-check-failed and writes nothing", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr3-rcpt-"))
    await requestAccess(runtime, "devin")
    const requestId = pendingRequest(home, "devin")!.requestId
    const restore = loseReplyAfterSend(runtime)
    await expect(approve(runtime, "devin", folder)).rejects.toThrow(/timed out/i)
    restore()
    expect(home.has("agents/devin/pending-request.json")).toBe(true)
    expect(home.has("agents/devin/grants.json")).toBe(false)

    // Every receipt read fails on the wire; the grant itself is live and findable.
    const realFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, initOptions?: RequestInit) => {
      const body = typeof initOptions?.body === "string" ? initOptions.body : ""
      if (body.includes("eth_getTransactionReceipt")) throw new TypeError("fetch failed")
      return realFetch(input, initOptions)
    })
    const outcome = await approve(runtime, "devin", folder).then(
      (ok) => ({ ok }),
      (err: unknown) => ({ err }),
    )
    fetchSpy.mockRestore()

    expect(outcome).toMatchObject({ err: { code: "approval-check-failed" } })
    // Nothing was changed: no grant recorded, the pending request survives, no folder row.
    expect(home.has("agents/devin/grants.json")).toBe(false)
    expect(pendingRequest(home, "devin")!.requestId).toBe(requestId)
    expect(approvedEntries().some((e) => e.agent === "devin")).toBe(false)
    // The line the CLI prints for this refusal is literally true here.
    expect(ownerRefusalLine("approve", "devin", (outcome as { err: unknown }).err)).toContain("Nothing was changed")

    const result = await approve(runtime, "devin", folder)
    expect(result.completedEarlier).toBe(true)
    expect(loadGrants(home, "devin").some((grant) => grant.requestId === requestId)).toBe(true)
    expect(approvedEntries().some((e) => e.agent === "devin" && e.projectId === projectIdOf(folder))).toBe(true)
  }, 600_000)

  // UF-APR3 A3: a send that failed for ONE reader is recorded as a per-agent note that names
  // the reader and the command that repairs it, and running that command actually repairs.
  const shortGrant = async (name: string): Promise<void> => {
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const request = await runtime.agent(name).createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: chainNow + 24n * 60n * 60n,
    })
    home.writeSecretJson(`requests/${name}/${request.requestId.toLowerCase()}.json`, request)
    home.writeSecretJson(`agents/${name}/pending-request.json`, { request })
  }

  const failSendTo = async (agentName: string, run: () => Promise<unknown>): Promise<void> => {
    const targetId = loadAgentIdentity(home, agentName)!.agentId
    const realWraps = runtime.vault.publishReaderWraps.bind(runtime.vault)
    const wraps = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input: { agentId: Hex; namespaceId: Hex }) => {
      if (input.agentId.toLowerCase() === targetId.toLowerCase()) throw new Error("store unreachable")
      return realWraps(input)
    })
    try {
      await run()
    } finally {
      wraps.mockRestore()
    }
  }

  it("a send that failed for one reader is finished by approving the reader the note named", async () => {
    const projectId = "proj-ufapr3-r1"
    await shortGrant("agent-r1")
    await approve(runtime, "agent-r1")
    // The one-day grant dies and closes the write epochs; the renewal rotates them.
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)
    await requestAccess(runtime, "agent-r1")

    lines.length = 0
    let result
    await failSendTo("agent-y", async () => {
      result = await approve(runtime, "agent-r1")
    })
    // The pass kept going for every other reader; the note names the one it could not reach.
    expect(result!.transactionHash).not.toBeNull()
    expect(lines).toContain("note: could not send the new key to agent-y: store unreachable — run `mida approve agent-y`")

    const saved = await saveCheckpoint(runtime, "agent-r1", {
      projectId,
      sessionId: "s-ufapr3-r1",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-r1", eventId: "cp-ufapr3-r1" }),
    })
    await expect(readCheckpoints(runtime, "agent-y", projectId)).rejects.toThrow(/NO_EPOCH_WRAP|no reader wrap/)

    // The note's own command repairs it: approve still answers already-approved, but its repair
    // pass ran first and handed agent-y the current key.
    await expect(approve(runtime, "agent-y")).rejects.toThrow(/already approved/)
    const read = await readCheckpoints(runtime, "agent-y", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
  }, 600_000)

  it("a send that failed for one reader is also finished by approving any other approved agent", async () => {
    const projectId = "proj-ufapr3-r2"
    await shortGrant("agent-r2")
    await approve(runtime, "agent-r2")
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)
    await requestAccess(runtime, "agent-r2")

    lines.length = 0
    await failSendTo("cursor", async () => {
      await approve(runtime, "agent-r2")
    })
    expect(lines).toContain("note: could not send the new key to cursor: store unreachable — run `mida approve cursor`")

    const saved = await saveCheckpoint(runtime, "agent-r2", {
      projectId,
      sessionId: "s-ufapr3-r2",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-r2", eventId: "cp-ufapr3-r2" }),
    })
    await expect(readCheckpoints(runtime, "cursor", projectId)).rejects.toThrow(/NO_EPOCH_WRAP|no reader wrap/)

    // Approving an unrelated approved agent re-runs the same repair pass over its granted READ
    // namespaces, and cursor is a reader of them, so cursor is healed.
    await expect(approve(runtime, "agent-x")).rejects.toThrow(/already approved/)
    const read = await readCheckpoints(runtime, "cursor", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
  }, 600_000)

  // UF-APR4 D1: the wraps-owed.json marker is what makes "already approved" cheap. No marker and
  // nothing missing must mean zero key sends and no sending line — APR3 re-sent every read key
  // on every already-approved run (the reviewer's 11 sends and 136 RPC requests for one approve).
  it("an already-approved approve with no owed-keys marker sends nothing and prints no sending line", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr4-quiet-"))
    home.remove("wraps-owed.json")
    const watch = watchPublishes()
    lines.length = 0
    rpcTransportProbe.reset()
    let result
    try {
      result = await approve(runtime, "codex", folder)
    } finally {
      watch.restore()
    }
    console.log(`[uf-apr4-d1] already-approved approve, no marker: publishes=${watch.sent.length} rpcRequests=${rpcTransportProbe.sentAt.length}`)
    expect(result.transactionHash).toBeNull()
    expect(result.projectId).toBe(projectIdOf(folder))
    expect(watch.sent.length).toBe(0)
    expect(lines.some((line) => line.startsWith("sending the new key to") || line.startsWith("re-sending the read key to"))).toBe(false)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  // A failed send inside ANY re-send pass — here revoke's — leaves the marker; the approve the
  // note names then runs the pass and clears it once every send lands.
  it("a failed send leaves the owed-keys marker, and approving the named reader repairs it and clears it", async () => {
    const projectId = "proj-ufapr4-d1"
    // Revoking agent-p3 rotates the live READ namespaces, so the repair pass owes agent-y the
    // new key — and the send to agent-y fails.
    let revokeResult: Awaited<ReturnType<typeof revoke>> | undefined
    await failSendTo("agent-y", async () => {
      revokeResult = await revoke(runtime, "agent-p3")
    })
    expect(revokeResult!.failed.some((failure) => failure.name === "agent-y")).toBe(true)
    const marker = home.readJson<{ owedSince?: unknown }>("wraps-owed.json")
    expect(typeof marker?.owedSince).toBe("string")
    expect(Number.isNaN(Date.parse(marker!.owedSince as string))).toBe(false)

    // The debt is real: a checkpoint sealed to the new epoch is locked for agent-y.
    const saved = await saveCheckpoint(runtime, "codex", {
      projectId,
      sessionId: "s-ufapr4-d1",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "codex", eventId: "cp-ufapr4-d1" }),
    })
    await expect(readCheckpoints(runtime, "agent-y", projectId)).rejects.toThrow(/NO_EPOCH_WRAP|no reader wrap/)

    // `mida approve agent-y` answers already-approved, but the marker runs the re-send first —
    // agent-y gets the key and the marker is cleared.
    await expect(approve(runtime, "agent-y")).rejects.toThrow(/already approved/)
    expect(home.has("wraps-owed.json")).toBe(false)
    const read = await readCheckpoints(runtime, "agent-y", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
  }, 600_000)

  // UF-APR4 D2: a file removal that fails right after the grant lands leaves a used-up request
  // behind. The next approve must see that the chain already granted every scope the request
  // asked for, clean the stale files, and answer already-approved — never "no pending request",
  // which is the answer that looped the owner through `mida request` and back.
  it("a failed revoked-marker removal after the grant lands is finished by one more approve", async () => {
    const projectId = "proj-ufapr4-d2a"
    // agent-d2a is revoked, then re-requests — so the re-approval has a revoked.json to remove.
    await requestAccess(runtime, "agent-d2a")
    await approve(runtime, "agent-d2a")
    await revoke(runtime, "agent-d2a")
    expect(isRevoked(home, "agent-d2a")).toBe(true)
    await requestAccess(runtime, "agent-d2a")

    const realRemove = home.remove.bind(home)
    let thrown = false
    const rm = vi.spyOn(home, "remove").mockImplementation((path: string) => {
      if (path === "agents/agent-d2a/revoked.json" && !thrown) {
        thrown = true
        throw Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" })
      }
      return realRemove(path)
    })
    lines.length = 0
    let first
    try {
      // UF-APR5 F3: the removal failure is a note naming the retry, never a bare error — the
      // approve resolves because the grant is live and recorded.
      first = await approve(runtime, "agent-d2a")
    } finally {
      rm.mockRestore()
    }
    expect(first!.transactionHash).not.toBeNull()
    expect(lines).toContain(
      "note: agent-d2a is approved, but Mida could not remove an old file: EBUSY: resource busy or locked, unlink — run `mida approve agent-d2a` again to finish",
    )
    // The grant landed and was recorded; only the revoked marker survived — the request file was
    // cleaned by the same pass, and the re-send settled the keys the grant owed.
    expect(loadGrants(home, "agent-d2a").length).toBeGreaterThan(0)
    expect(home.has("agents/agent-d2a/pending-request.json")).toBe(false)
    expect(isRevoked(home, "agent-d2a")).toBe(true)
    expect(home.has("wraps-owed.json")).toBe(false)

    // One more approve finishes it, exactly as the note says: the chain approves the agent, so no
    // transaction goes out — the run clears the surviving revoked marker and answers
    // already-approved, never "no pending request".
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    try {
      await expect(approve(runtime, "agent-d2a")).rejects.toThrow(/already approved/)
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
    expect(isRevoked(home, "agent-d2a")).toBe(false)
    expect(home.has("wraps-owed.json")).toBe(false)
    // `mida request` agrees the approval is done — and an MCP save is not refused "revoked".
    await expect(requestAccess(runtime, "agent-d2a")).rejects.toThrow(/already approved|pending request/)
    const saved = await saveCheckpoint(runtime, "agent-d2a", {
      projectId,
      sessionId: "s-ufapr4-d2a",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-d2a", eventId: "cp-ufapr4-d2a" }),
    })
    expect(saved.contextId).toBeTruthy()
  }, 600_000)

  it("a failed pending-request removal after the grant lands is finished by one more approve", async () => {
    const projectId = "proj-ufapr4-d2b"
    await requestAccess(runtime, "agent-d2b")
    const realRemove = home.remove.bind(home)
    let thrown = false
    const rm = vi.spyOn(home, "remove").mockImplementation((path: string) => {
      if (path === "agents/agent-d2b/pending-request.json" && !thrown) {
        thrown = true
        throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" })
      }
      return realRemove(path)
    })
    lines.length = 0
    let first
    try {
      // UF-APR5 F3: same rule — the failed removal is a note, and the approval resolves.
      first = await approve(runtime, "agent-d2b")
    } finally {
      rm.mockRestore()
    }
    expect(first!.transactionHash).not.toBeNull()
    expect(lines).toContain(
      "note: agent-d2b is approved, but Mida could not remove an old file: EPERM: operation not permitted, unlink — run `mida approve agent-d2b` again to finish",
    )
    expect(loadGrants(home, "agent-d2b").length).toBeGreaterThan(0)
    // The one file whose removal died survived; the retry has real cleanup to finish.
    expect(home.has("agents/agent-d2b/pending-request.json")).toBe(true)

    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    try {
      await expect(approve(runtime, "agent-d2b")).rejects.toThrow(/already approved/)
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
    expect(home.has("agents/agent-d2b/pending-request.json")).toBe(false)
    // The owed-keys marker the dead run left was settled by this run's pass.
    expect(home.has("wraps-owed.json")).toBe(false)
    const saved = await saveCheckpoint(runtime, "agent-d2b", {
      projectId,
      sessionId: "s-ufapr4-d2b",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-d2b", eventId: "cp-ufapr4-d2b" }),
    })
    expect(saved.contextId).toBeTruthy()
  }, 600_000)

  // UF-APR4 D3: the grant transaction can land while its CONFIRMATION never comes back — the
  // receipt read inside completeAccessRequest dies against a dead RPC. That is not "nothing was
  // sent": the grant is live on Monad. The line must say the grant went out and name the retry
  // that finishes it, and the retry must finish it without sending again.
  it("a grant that was sent but not confirmed says so, and the retry finishes it", async () => {
    await requestAccess(runtime, "agent-d3")
    const requestId = pendingRequest(home, "agent-d3")!.requestId

    // The seam: the grant send runs for real and lands; the SDK check is what dies. The thrown
    // error is the shape a dead RPC produces for eth_getTransactionReceipt.
    const agent = runtime.agent("agent-d3")
    const confirmed = vi.spyOn(agent, "completeAccessRequest").mockRejectedValue(
      new HttpRequestError({ url: env.rpcUrl, details: "fetch failed" }),
    )
    let first: unknown
    try {
      first = await approve(runtime, "agent-d3").then(
        (result) => ({ result }),
        (err: unknown) => ({ err }),
      )
    } finally {
      confirmed.mockRestore()
    }

    const line = ownerRefusalLine("approve", "agent-d3", (first as { err: unknown }).err)
    expect(line).toContain("the grant for agent-d3 was sent to Monad, but Mida could not confirm it:")
    expect(line).toContain("run `mida approve agent-d3` again to finish; it sends nothing new if the grant landed")
    // The one thing this line may never claim while the grant is live on chain.
    expect(line).not.toContain("nothing was sent")

    // The send really did land and was never recorded: the request stays pending and unconsumed,
    // so the retry can find the transaction on chain and finish the approval through the same
    // SDK check — it sends no second grant.
    expect(home.has("agents/agent-d3/pending-request.json")).toBe(true)
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    let second
    try {
      second = await approve(runtime, "agent-d3")
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
    expect(second.completedEarlier).toBe(true)
    expect(second.transactionHash).toBeNull()
    expect(loadGrants(home, "agent-d3").some((grant) => grant.requestId === requestId)).toBe(true)
    expect(home.has("agents/agent-d3/pending-request.json")).toBe(false)
  }, 600_000)

  // UF-APR4 D4: a renewal rotates the namespaces' keys, the grant lands, and THEN the folder
  // listing throws. The rotated keys are owed to every other reader — the listing error must not
  // skip the re-send, and the line must say the agent IS approved, not print only the list error.
  it("a folder listing that fails after a rotating grant still sends the keys and says the agent is approved", async () => {
    const projectId = "proj-ufapr4-d4"
    const folder = mkdtempSync(join(tmpdir(), "mida-ufapr4-d4-"))
    // agent-d4r is the other reader the rotated keys are owed to; it is approved here so the
    // test stands alone under a -t filter.
    await requestAccess(runtime, "agent-d4r")
    await approve(runtime, "agent-d4r")
    await shortGrant("agent-d4")
    await approve(runtime, "agent-d4")
    // The one-day grant dies and closes the write epochs; the renewal rotates them.
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)
    await requestAccess(runtime, "agent-d4")

    // The seam: the approved-projects read dies once, inside approveProject, after the grant
    // has landed.
    const realRead = home.readJson.bind(home)
    let failed = false
    const readJson = vi.spyOn(home, "readJson").mockImplementation(((relativePath: string) => {
      if (relativePath === "approved-projects.json" && !failed) {
        failed = true
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
      }
      return realRead(relativePath)
    }) as never)
    lines.length = 0
    let first: unknown
    try {
      first = await approve(runtime, "agent-d4", folder).then(
        (result) => ({ result }),
        (err: unknown) => ({ err }),
      )
    } finally {
      readJson.mockRestore()
    }

    const err = (first as { err?: unknown }).err
    expect(err).toBeDefined()
    const line = ownerRefusalLine("approve", "agent-d4", err)
    expect(line).toBe(
      "agent-d4 is approved, but the approved-projects list could not be read — check the file's permissions, then run `mida approve agent-d4` here again to add this folder",
    )
    // The grant is recorded; only the folder row is missing.
    expect(loadGrants(home, "agent-d4").length).toBeGreaterThan(0)
    expect(approvedEntries().some((e) => e.agent === "agent-d4" && e.projectId === projectIdOf(folder))).toBe(false)

    // The re-send ran anyway: agent-d4r holds the new-epoch keys the renewal minted, so it can
    // read a checkpoint sealed under them.
    const saved = await saveCheckpoint(runtime, "agent-d4", {
      projectId,
      sessionId: "s-ufapr4-d4",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-d4", eventId: "cp-ufapr4-d4" }),
    })
    const read = await readCheckpoints(runtime, "agent-d4r", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)

    // The named retry adds the folder row once the list is readable again.
    const second = await approve(runtime, "agent-d4", folder)
    expect(second.transactionHash).toBeNull()
    expect(approvedEntries().some((e) => e.agent === "agent-d4" && e.projectId === projectIdOf(folder))).toBe(true)
  }, 600_000)

})

// UF-APR5 F1: wraps-owed.json records WHICH namespaces still owe key sends, and only a repair
// pass that covered every still-owed namespace settles it. The reviewer's case: a revoke rotated
// every namespace and the re-sends to `assistant` and `agent-a` both died — `mida approve
// assistant` then ran a pass over only the two fact areas assistant reads, cleared the marker
// anyway, and `mida approve agent-a` sent nothing, leaving agent-a at NO_EPOCH_WRAP with no
// command that repaired it.
describe("the keys-owed marker names the areas still owed", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  const lines: string[] = []

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ufapr5-")))
    runtime = await Runtime.open(home, network)
    await init(runtime, ["assistant", "agent-a", "agent-b", "agent-v"])
    runtime.progress = (line: string) => lines.push(line)
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  const idOf = (name: string): string => loadAgentIdentity(home, name)!.agentId.toLowerCase()
  const nsProject = namespaceId(NAMESPACE)
  const factIds = FACT_NAMESPACES.map((ns) => namespaceId(ns))
  const markerOf = () => home.readJson<{ owedSince?: string; namespaces?: string[] }>("wraps-owed.json")

  const watchPublishes = () => {
    const realPublish = runtime.vault.publishReaderWraps.bind(runtime.vault)
    const sent: { agentId: Hex; namespaceId: Hex }[] = []
    const spy = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input) => {
      sent.push({ agentId: input.agentId, namespaceId: input.namespaceId })
      return realPublish(input)
    })
    return { sent, restore: () => spy.mockRestore() }
  }

  it("a revoke's failed sends to a fact-only reader stay owed until a pass covers them — and the pass repairs every reader of the owed areas", async () => {
    const projectId = "proj-ufapr5-f1"
    for (const name of ["agent-a", "agent-b", "agent-v"]) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }
    home.remove("wraps-owed.json")

    // The revoke's own grant rotation is real; only the re-send to these two readers dies.
    const failing = new Set([idOf("agent-a"), idOf("assistant")])
    const realWraps = runtime.vault.publishReaderWraps.bind(runtime.vault)
    const wraps = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input: { agentId: Hex; namespaceId: Hex }) => {
      if (failing.has(input.agentId.toLowerCase())) throw new Error("store unreachable")
      return realWraps(input)
    })
    let revoked: Awaited<ReturnType<typeof revoke>>
    try {
      revoked = await revoke(runtime, "agent-v")
    } finally {
      wraps.mockRestore()
    }
    expect(revoked!.failed.map((f) => f.name).sort()).toEqual(["agent-a", "assistant"])

    // The marker names exactly the namespaces the rotated keys are owed for — all three.
    const marker = markerOf()
    expect(marker).toBeDefined()
    expect(new Set((marker!.namespaces ?? []).map((id) => id.toLowerCase()))).toEqual(
      new Set([nsProject, ...factIds].map((id) => id.toLowerCase())),
    )

    // agent-b got the new-epoch keys and can write; agent-a — a reader of the checkpoint area —
    // holds only the dead epoch's wraps.
    const saved = await saveCheckpoint(runtime, "agent-b", {
      projectId,
      sessionId: "s-ufapr5-f1",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-b", eventId: "cp-ufapr5-f1" }),
    })
    await expect(readCheckpoints(runtime, "agent-a", projectId)).rejects.toThrow(/NO_EPOCH_WRAP|no reader wrap|refused|denied/i)

    // The note's command: `mida approve assistant`. Assistant reads only the fact areas — but the
    // pass must cover what the MARKER owes, so agent-a's checkpoint key goes out too.
    const watch = watchPublishes()
    try {
      await expect(approve(runtime, "assistant")).rejects.toThrow(/already approved/)
    } finally {
      watch.restore()
    }
    expect(
      watch.sent.some(
        (s) => s.agentId.toLowerCase() === idOf("agent-a") && s.namespaceId.toLowerCase() === nsProject.toLowerCase(),
      ),
    ).toBe(true)
    // Every owed namespace was covered cleanly — the marker is gone.
    expect(home.has("wraps-owed.json")).toBe(false)

    // `mida approve agent-a` is the ordinary quiet answer now: no marker, no sends.
    const watch2 = watchPublishes()
    try {
      await expect(approve(runtime, "agent-a")).rejects.toThrow(/already approved/)
    } finally {
      watch2.restore()
    }
    expect(watch2.sent).toHaveLength(0)

    // And agent-a can read what the new epoch sealed.
    const read = await readCheckpoints(runtime, "agent-a", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)
  }, 900_000)

  it("a repair pass over a subset of the owed namespaces leaves the rest in the marker", async () => {
    home.writeSecretJson("wraps-owed.json", { owedSince: new Date().toISOString(), namespaces: [nsProject, factIds[0]] })
    const repair = await repairReaderWraps(runtime, [factIds[0]!])
    expect(repair.failed).toEqual([])
    // The fact area was covered and settled; the checkpoint area the pass never touched stays owed.
    expect(markerOf()?.namespaces?.map((id) => id.toLowerCase())).toEqual([nsProject.toLowerCase()])
    // The leftover debt is what the next owed pass pays down — and the file only leaves once
    // nothing is owed.
    await expect(approve(runtime, "agent-b")).rejects.toThrow(/already approved/)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  it("a marker in the old shape owes every reader namespace", async () => {
    home.writeSecretJson("wraps-owed.json", { owedSince: new Date().toISOString() })
    const watch = watchPublishes()
    try {
      await expect(approve(runtime, "agent-b")).rejects.toThrow(/already approved/)
    } finally {
      watch.restore()
    }
    const covered = new Set(watch.sent.map((s) => s.namespaceId.toLowerCase()))
    expect(covered.has(nsProject.toLowerCase())).toBe(true)
    for (const id of factIds) expect(covered.has(id.toLowerCase())).toBe(true)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  it("a marker delete that fails after a clean pass still reports the sends as done", async () => {
    home.writeSecretJson("wraps-owed.json", { owedSince: new Date().toISOString(), namespaces: [nsProject] })
    const realRemove = home.remove.bind(home)
    const rm = vi.spyOn(home, "remove").mockImplementation((path: string) => {
      if (path === "wraps-owed.json") throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" })
      return realRemove(path)
    })
    const watch = watchPublishes()
    lines.length = 0
    let out: { ok?: unknown; err?: Error }
    try {
      out = await approve(runtime, "agent-b").then(
        (result) => ({ ok: result }),
        (err: unknown) => ({ err: err as Error }),
      )
    } finally {
      watch.restore()
      rm.mockRestore()
    }
    // The sends all went out and the answer is the ordinary already-approved — the failed marker
    // cleanup is a leftover file, not a failed send.
    expect(watch.sent.length).toBeGreaterThan(0)
    expect(out.err?.message).toMatch(/already approved/)
    expect(lines.some((line) => line.includes("could not send the key"))).toBe(false)
    // The marker stayed on disk; the next approve's pass clears it for real.
    expect(home.has("wraps-owed.json")).toBe(true)
    await expect(approve(runtime, "agent-b")).rejects.toThrow(/already approved/)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  it("debt a second process records mid-pass is merged, never overwritten", async () => {
    const staleStamp = "2026-09-01T00:00:00.000Z"
    home.writeSecretJson("wraps-owed.json", { owedSince: staleStamp, namespaces: [nsProject] })
    // A second command writes debt for a fact area while this pass's sends are in flight — the
    // settle at the end must leave that namespace on the marker.
    const realWraps = runtime.vault.publishReaderWraps.bind(runtime.vault)
    let marked = false
    const spy = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input) => {
      const out = await realWraps(input)
      if (!marked) {
        marked = true
        markWrapsOwed(home, [factIds[0]!])
      }
      return out
    })
    try {
      const repair = await repairReaderWraps(runtime, [nsProject])
      expect(repair.failed).toEqual([])
    } finally {
      spy.mockRestore()
    }
    const marker = markerOf()
    expect(marker?.owedSince).toBe(staleStamp)
    expect(marker?.namespaces?.map((id) => id.toLowerCase())).toEqual([factIds[0]!.toLowerCase()])
    home.remove("wraps-owed.json")
  }, 600_000)
})

// UF-APR5 F2/F3/F4: a grant that landed on chain while approveGrant was still finishing must say
// so — never "nothing was sent" — and name the retry that finishes it. The same finishable rule
// covers a stale-file removal that fails after the grant is recorded, and a pending request whose
// store record was already consumed.
describe("a grant that landed but never finished keeps a truthful line", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  let runtime: Runtime
  const lines: string[] = []

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-ufapr5b-")))
    runtime = await Runtime.open(home, network)
    // Every agent is registered up front: once a test below moves the chain's clock, init can
    // no longer run.
    await init(runtime, ["agent-f2a", "agent-f2b", "agent-f3a", "agent-f4a", "agent-g1", "agent-g2", "agent-g3"])
    runtime.progress = (line: string) => lines.push(line)
  }, 600_000)

  afterAll(async () => {
    await runtime?.close()
    await env?.stop()
  })

  const nsProject = namespaceId(NAMESPACE)
  const factIds = FACT_NAMESPACES.map((ns) => namespaceId(ns))

  it("an own-key publish that dies inside approveGrant after the grant lands says the grant landed, and one approve finishes it", async () => {
    await requestAccess(runtime, "agent-f2a")
    const requestId = pendingRequest(home, "agent-f2a")!.requestId

    // The reviewer's seam: the grant transaction lands, then the FIRST own-key publish hits a
    // dropped connection — approveGrant never returns.
    const realWraps = runtime.vault.publishReaderWraps.bind(runtime.vault)
    let thrown = false
    const spy = vi.spyOn(runtime.vault, "publishReaderWraps").mockImplementation(async (input: { agentId: Hex; namespaceId: Hex }) => {
      if (!thrown) {
        thrown = true
        throw new HttpRequestError({ url: env.rpcUrl, details: "fetch failed" })
      }
      return realWraps(input)
    })
    let first: { ok?: unknown; err?: Error & { code?: string } }
    try {
      first = await approve(runtime, "agent-f2a").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err: err as Error & { code?: string } }),
      )
    } finally {
      spy.mockRestore()
    }

    const err = first!.err!
    expect(err.code).toBe("grant-landed-unfinished")
    const line = ownerRefusalLine("approve", "agent-f2a", err)
    expect(line).toContain("the grant for agent-f2a landed on Monad, but Mida could not finish setting it up:")
    expect(line).toContain("run `mida approve agent-f2a` again to finish; it sends no new grant")
    expect(line).not.toContain("nothing was sent")

    // The grant is live on chain, nothing was recorded, and the owed-keys marker names the
    // areas the agent's own wraps are owed for — the three READ namespaces the grant minted.
    expect(loadGrants(home, "agent-f2a")).toEqual([])
    const marker = home.readJson<{ namespaces?: string[] }>("wraps-owed.json")
    expect(new Set((marker?.namespaces ?? []).map((id) => id.toLowerCase()))).toEqual(
      new Set([nsProject, ...factIds].map((id) => id.toLowerCase())),
    )

    // The retry finishes the approval: it finds the grant on chain and sends no second one.
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    let second
    try {
      second = await approve(runtime, "agent-f2a")
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
    expect(second!.completedEarlier).toBe(true)
    expect(second!.transactionHash).toBeNull()
    expect(loadGrants(home, "agent-f2a").some((grant) => grant.requestId === requestId)).toBe(true)
    expect(home.has("agents/agent-f2a/pending-request.json")).toBe(false)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  it("an error marked as before the send keeps its own 'nothing was sent' line", async () => {
    await requestAccess(runtime, "agent-f2b")
    // The chain write layer marks a send it knows never left with sent === false — the shape a
    // gas-estimate or balance failure carries out of sendContract.
    const unsent = Object.assign(new MidaError("SEND_TIMEOUT", "nothing was sent: run the same command again"), { sent: false })
    const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
    const realApprove = vault.approveGrant.bind(runtime.vault)
    vault.approveGrant = (async () => {
      throw unsent
    }) as never
    let first: { ok?: unknown; err?: unknown }
    try {
      first = await approve(runtime, "agent-f2b").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      )
    } finally {
      vault.approveGrant = realApprove
    }
    // Untouched, unwrapped — today that is exactly what a dry wallet or a timed-out estimate says.
    expect(first!.err).toBe(unsent)
    expect(ownerRefusalLine("approve", "agent-f2b", first!.err)).toBe("nothing was sent: run the same command again")
    expect(home.has("agents/agent-f2b/pending-request.json")).toBe(true)

    // A request-validation refusal keeps its code the same way — an expired request's honest
    // answer is `mida request`, not "the grant could not be confirmed".
    const expired = new MidaError("REQUEST_EXPIRED", "request is outside its validity window")
    vault.approveGrant = (async () => {
      throw expired
    }) as never
    let again: { ok?: unknown; err?: unknown }
    try {
      again = await approve(runtime, "agent-f2b").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      )
    } finally {
      vault.approveGrant = realApprove
    }
    expect(again!.err).toBe(expired)
    expect(ownerRefusalLine("approve", "agent-f2b", again!.err)).toContain("request has expired")
    // agent-f2b still has a live pending request and no grant — clean state for nothing owed.
    expect(home.has("agents/agent-f2b/pending-request.json")).toBe(true)
    expect(loadGrants(home, "agent-f2b")).toEqual([])
    home.remove("wraps-owed.json")
  }, 600_000)

  // UF-APR5 F3: removing the consumed request file fails AFTER the grant is recorded — an EPERM,
  // the Windows case. The approval still resolves, prints the note naming the retry, and the
  // agent can already read; one more approve finishes the cleanup.
  it("a stale-file removal that fails after the grant lands prints the note and one approve finishes it", async () => {
    const projectId = "proj-ufapr5-f3"
    await requestAccess(runtime, "agent-f3a")
    const realRemove = home.remove.bind(home)
    const spy = vi.spyOn(home, "remove").mockImplementation((file: string) => {
      if (file === "agents/agent-f3a/pending-request.json") throw new Error("EPERM: operation not permitted, unlink")
      return realRemove(file)
    })
    const linesBefore = lines.length
    let first
    try {
      first = await approve(runtime, "agent-f3a")
    } finally {
      spy.mockRestore()
    }

    // The grant is recorded and the approve RESOLVED — the failure became a note, not a bare
    // "refused: EPERM".
    expect(first!.transactionHash).not.toBeNull()
    expect(loadGrants(home, "agent-f3a").length).toBe(1)
    const note = lines.slice(linesBefore).find((line) => line.includes("could not remove an old file"))
    expect(note).toBe(
      "note: agent-f3a is approved, but Mida could not remove an old file: EPERM: operation not permitted, unlink — run `mida approve agent-f3a` again to finish",
    )
    // The stale file stayed behind — the retry has real work to finish.
    expect(home.has("agents/agent-f3a/pending-request.json")).toBe(true)

    // Approved means approved: the agent reads its own checkpoint already.
    const saved = await saveCheckpoint(runtime, "agent-f3a", {
      projectId,
      sessionId: "s-ufapr5-f3",
      continuesSession: null,
      compiledBy: "test",
      checkpoint: sampleCheckpoint({ agent: "agent-f3a", eventId: "cp-ufapr5-f3" }),
    })
    const read = await readCheckpoints(runtime, "agent-f3a", projectId)
    expect(read.checkpoints.some((cp) => cp.contextId === saved.contextId)).toBe(true)

    // The retry does what the note says: the store record is consumed and the chain approves the
    // agent, so it removes the stale file and answers already-approved — nothing new is sent.
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    try {
      await expect(approve(runtime, "agent-f3a")).rejects.toMatchObject({ code: "already-approved" })
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
    expect(home.has("agents/agent-f3a/pending-request.json")).toBe(false)
    expect(home.has("wraps-owed.json")).toBe(false)
  }, 600_000)

  // UF-APR5 F4: the store record for a request can be consumed while only PART of the grant it
  // produced still lives — an early partial approval renewed once, then its short half died.
  // approve used to answer "no pending request" while `mida request` answered "already approved",
  // an endless loop. The shared used-up verdict now drops the stale file and the upgrade path
  // renews exactly the missing scopes inside the same approve run.
  it("a partly expired grant renews on one `approve`", async () => {
    const identity = loadAgentIdentity(home, "agent-f4a")!
    // First approval: projects.current only, one day — the shape an early partial grant leaves.
    const chainNow = (await runtime.chain.publicClient.getBlock()).timestamp
    const partialInputs = expectedScopesFor("project_assistance").filter((scope) => scope.namespace === "projects.current")
    const req0 = await runtime.agent("agent-f4a").createAccessRequest({
      purposeId: "project_assistance",
      scopes: partialInputs,
      capabilityExpiresAt: chainNow + 24n * 60n * 60n,
    })
    const partial = await runtime.vault.approveGrant({
      accessRequest: req0,
      manifest: identity.manifest,
      selection: { kind: "custom", scopes: expandScopeInputs(partialInputs), expiresAt: chainNow + 24n * 60n * 60n },
    })
    await runtime.agent("agent-f4a").completeAccessRequest(req0, partial.response)
    saveGrants(home, "agent-f4a", [...runtime.agent("agent-f4a").grants])

    // The full request is then approved for seven days: the chain mints the two fact scopes it
    // was still missing, and the request file is consumed and removed — the file the test puts
    // back below is the leftover a failed cleanup leaves.
    const chainNow2 = (await runtime.chain.publicClient.getBlock()).timestamp
    const full = await runtime.agent("agent-f4a").createAccessRequest({
      purposeId: "project_assistance",
      scopes: expectedScopesFor("project_assistance"),
      capabilityExpiresAt: chainNow2 + 7n * 24n * 60n * 60n,
    })
    home.writeSecretJson(`requests/agent-f4a/${full.requestId.toLowerCase()}.json`, full)
    home.writeSecretJson("agents/agent-f4a/pending-request.json", { request: full })
    await approve(runtime, "agent-f4a")
    expect(home.has("agents/agent-f4a/pending-request.json")).toBe(false)

    // Two days on the chain clock: the one-day projects.current grant is dead, the seven-day
    // fact scopes are live — and the consumed request file is back on disk.
    await increaseLocalTime(env.rpcUrl, 2n * 24n * 60n * 60n)
    home.writeSecretJson("agents/agent-f4a/pending-request.json", { request: full })

    // One approve renews the expired scope: the stale file goes, the upgrade path signs a
    // request for exactly the missing projects.current scope, and the grant goes out in the
    // same run — `mida request` is never part of the loop.
    const result = await approve(runtime, "agent-f4a")
    expect(result.transactionHash).not.toBeNull()
    expect(home.has("agents/agent-f4a/pending-request.json")).toBe(false)

    // Nothing is left missing: the next approve is the ordinary already-approved answer and
    // sends nothing.
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    try {
      await expect(approve(runtime, "agent-f4a")).rejects.toThrow(/already approved/)
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
  }, 600_000)

  // UF-APR6 G1: the reads approveGrant runs BEFORE the grant transaction (the chain clock, the
  // agent record, the owner's history and the grant nonce) can die on a dropped connection.
  // Nothing was sent then -- the owner nonce does not move -- so the honest line is the
  // chain-busy one, never "the grant was sent".
  it("a chain read that dies before the grant send says nothing was sent, and the retry grants", async () => {
    await requestAccess(runtime, "agent-g1")
    const nonceBefore = await ownerNonce(runtime)
    const client = runtime.ownerChain.publicClient as unknown as { readContract: (args: { functionName: string }) => Promise<unknown> }
    const real = client.readContract.bind(client)
    let dropped = false
    const spy = vi.spyOn(client, "readContract").mockImplementation(async (args: { functionName: string }) => {
      if (!dropped && args.functionName === "grantNonce") {
        dropped = true
        throw new HttpRequestError({ url: env.rpcUrl, details: "fetch failed" })
      }
      return real(args)
    })
    let first: { ok?: unknown; err?: Error & { code?: string } }
    try {
      first = await approve(runtime, "agent-g1").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err: err as Error & { code?: string } }),
      )
    } finally {
      spy.mockRestore()
    }

    expect(dropped).toBe(true)
    // Nothing was sent: the owner nonce never moved and the printed line says so.
    expect(await ownerNonce(runtime)).toBe(nonceBefore)
    const line = ownerRefusalLine("approve", "agent-g1", first!.err)
    expect(line).toBe("Monad is busy right now — nothing was sent or decided; wait a moment and run the same command again")
    expect(line).not.toContain("was sent to Monad")

    // One more approve grants normally: the nonce moves exactly once, the grant is recorded.
    const second = await approve(runtime, "agent-g1")
    expect(second.transactionHash).not.toBeNull()
    expect(await ownerNonce(runtime)).toBe(nonceBefore + 1)
    expect(loadGrants(home, "agent-g1").length).toBe(1)
    expect(home.has("agents/agent-g1/pending-request.json")).toBe(false)
  }, 600_000)

  // UF-APR6 G2: a send that timed out after going out -- SEND_TIMEOUT carrying a hash, or
  // SPONSOR_PENDING where the sponsor accepted but never confirmed -- already carries the honest
  // advice ("don't run the command again until `mida doctor` shows the result"). When the chain
  // check finds nothing landed, wrapping it as "the grant was sent ... run `mida approve` again"
  // prints a second instruction that disagrees with the first.
  it("a send that timed out after going out keeps its own advice when nothing landed", async () => {
    await requestAccess(runtime, "agent-g2")
    const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
    const realApprove = vault.approveGrant.bind(runtime.vault)
    const timeout = new MidaError(
      "SEND_TIMEOUT",
      "sent as 0xabc0000000000000000000000000000000000000000000000000000000000001, not confirmed yet. Wait a minute, then run `mida doctor`. Don't run the command again until it shows the result, or it may be sent twice.",
    )
    vault.approveGrant = (async () => {
      throw timeout
    }) as never
    let first: { ok?: unknown; err?: unknown }
    try {
      first = await approve(runtime, "agent-g2").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      )
    } finally {
      vault.approveGrant = realApprove
    }

    // Rethrown unwrapped -- the same error object -- so the timeout's own advice is the only line.
    expect(first!.err).toBe(timeout)
    expect(ownerRefusalLine("approve", "agent-g2", first!.err)).toBe(
      "sent as 0xabc0000000000000000000000000000000000000000000000000000000000001, not confirmed yet. Wait a minute, then run `mida doctor`. Don't run the command again until it shows the result, or it may be sent twice.",
    )
    home.remove("wraps-owed.json")

    // SPONSOR_PENDING is the same shape: accepted by the sponsor, never confirmed; its own line
    // says a re-run is safe because it asks the chain first -- never two instructions at once.
    const pending = new MidaError("SPONSOR_PENDING", "the bundler accepted the operation but the receipt never arrived")
    vault.approveGrant = (async () => {
      throw pending
    }) as never
    let second: { ok?: unknown; err?: unknown }
    try {
      second = await approve(runtime, "agent-g2").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      )
    } finally {
      vault.approveGrant = realApprove
    }
    expect(second!.err).toBe(pending)
    const pendingLine = ownerRefusalLine("approve", "agent-g2", second!.err)
    expect(pendingLine).toBe(
      "the sponsored operation was accepted and may still land — run the same command again in a minute — it will tell you if it already went through; nothing was sent from your wallet",
    )
    home.remove("wraps-owed.json")
  }, 600_000)

  // UF-APR6 G3: the leftover used-up request whose scopes ALL expired while another scope is
  // still live -- the two fact scopes granted for a day beside a seven-day projects.current.
  // F4 covered part-live (some of the request's own scopes live on); here NONE of them does,
  // yet the agent is not unapproved: approve answering "no pending request" while `mida request`
  // answered "already approved" is the same loop. The verdict renews on the live capability.
  it("a leftover request whose scopes all expired renews while another scope is still live", async () => {
    const day = 24n * 60n * 60n
    const identity = loadAgentIdentity(home, "agent-g3")!
    const grantFor = async (inputs: ReturnType<typeof expectedScopesFor>, life: bigint): Promise<AccessRequest> => {
      const now = (await runtime.chain.publicClient.getBlock()).timestamp
      const req = await runtime.agent("agent-g3").createAccessRequest({
        purposeId: "project_assistance",
        scopes: inputs,
        capabilityExpiresAt: now + life,
      })
      const approval = await runtime.vault.approveGrant({
        accessRequest: req,
        manifest: identity.manifest,
        selection: { kind: "custom", scopes: expandScopeInputs(inputs), expiresAt: now + life },
      })
      await runtime.agent("agent-g3").completeAccessRequest(req, approval.response)
      saveGrants(home, "agent-g3", [...runtime.agent("agent-g3").grants])
      return req
    }
    // projects.current for a week; the two fact scopes for a day -- the leftover request below.
    const projInputs = expectedScopesFor("project_assistance").filter((scope) => scope.namespace === "projects.current")
    const factInputs = expectedScopesFor("project_assistance").filter((scope) => scope.namespace !== "projects.current")
    await grantFor(projInputs, 7n * day)
    const leftover = await grantFor(factInputs, 1n * day)

    // Two days on the chain clock: every scope the leftover request asked for is dead, and
    // projects.current -- a scope that request never covered -- is live. The consumed request
    // file is back on disk the way a failed cleanup leaves it.
    await increaseLocalTime(env.rpcUrl, 2n * day)
    home.writeSecretJson("agents/agent-g3/pending-request.json", { request: leftover })

    // One approve renews: the stale file goes, the upgrade path signs a request for exactly the
    // two expired fact scopes, and the grant goes out in the same run -- `mida request` is never
    // part of the loop.
    const result = await approve(runtime, "agent-g3")
    expect(result.transactionHash).not.toBeNull()
    expect(home.has("agents/agent-g3/pending-request.json")).toBe(false)

    // No loop: nothing is left missing, so the next approve is the ordinary already-approved
    // answer and sends nothing.
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    try {
      await expect(approve(runtime, "agent-g3")).rejects.toThrow(/already approved/)
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
  }, 600_000)
})
