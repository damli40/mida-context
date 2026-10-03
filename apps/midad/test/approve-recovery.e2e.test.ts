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
import { encodeUint64, PERMISSION } from "@mida/protocol"
import type { AccessRequest } from "@mida/protocol"
import { increaseLocalTime, rpcTransportProbe } from "@mida/chain"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import {
  MidaHome,
  Runtime,
  approve,
  buildHandoff,
  expectedScopesFor,
  init,
  isRevoked,
  loadAgentIdentity,
  loadGrants,
  ownerRefusalLine,
  readCheckpoints,
  requestAccess,
  revoke,
  saveCheckpoint,
  grantResponseFromLogs,
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
    try {
      await expect(approve(runtime, "agent-d2a")).rejects.toThrow(/EBUSY/)
    } finally {
      rm.mockRestore()
    }
    // The grant landed and was recorded; only the cleanup died — the request is used up, the
    // revoked marker and the pending request both survived, and the keys are still owed.
    expect(loadGrants(home, "agent-d2a").length).toBeGreaterThan(0)
    expect(home.has("agents/agent-d2a/pending-request.json")).toBe(true)
    expect(isRevoked(home, "agent-d2a")).toBe(true)
    expect(home.has("wraps-owed.json")).toBe(true)

    // One more approve finishes it. The chain check sees the request's grant already live, so no
    // transaction goes out and no "no pending request" refusal loops the owner back to request.
    const noGrant = vi.spyOn(runtime.vault, "approveGrant")
    try {
      await expect(approve(runtime, "agent-d2a")).rejects.toThrow(/already approved/)
    } finally {
      noGrant.mockRestore()
    }
    expect(noGrant).not.toHaveBeenCalled()
    expect(home.has("agents/agent-d2a/pending-request.json")).toBe(false)
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
    try {
      await expect(approve(runtime, "agent-d2b")).rejects.toThrow(/EPERM/)
    } finally {
      rm.mockRestore()
    }
    expect(loadGrants(home, "agent-d2b").length).toBeGreaterThan(0)
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
