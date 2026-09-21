// Group E — authority. From docs/issue-register.md §3:
//   E1 a revoked agent's read and write are refused — asserted on the server's
//      refusal response and the chain's validity view, never a local flag
//   E2 a double approve throws and mints nothing; a CREATE-only grant blocks
//      requestAccess exactly like a full one
//   E3 an expired grant can be re-approved
//   E4 revoke A → re-approve A → revoke B: A keeps new saves and one damaged
//      identity file cannot block B's revocation
//   E5 a missing or mismatched identity resolves to the RIGHT agent's loss —
//      the signer's chain mapping decides, not the file that claimed a name
//   E6 events queued before approval are never saved after approval
//   E7 a forged author claim is replaced by the on-chain author and flagged
//   E8 general-assistance reads preferences.communication and is refused
//      projects.current
// Every assertion reads the chain, the server, or the injected text.

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { PERMISSION, PROVENANCE_POLICY, namespaceId } from "@mida/protocol"
import { increaseLocalTime } from "@mida/chain"
import type { Hex } from "@mida/protocol"
import {
  AGENT_PERMISSIONS, NAMESPACE, PURPOSE_ID, Runtime, approve, approveProject, authorNamesFor,
  buildHandoff, drainOnce, enqueue, init, isCapabilityLive, loadAgentIdentity, loadGrants,
  loadOrCreateSignerKey, readCheckpoints, remember, repairReaderWraps, requestAccess, revoke,
  saveAgentIdentity, saveCheckpoint, saveGrants, attemptNamespaceRead,
} from "../../apps/midad/src/index.js"
import {
  assistantText, benchChain, benchDir, benchHome, mark, sampleCheckpoint, stubCompile,
  userLine, writeTranscript,
} from "../lib/env.js"
import { runGroup } from "../lib/checks.js"

const NAMESPACE_ID = namespaceId(NAMESPACE)
const chain = await benchChain()
const dir = benchDir("e")
const home = benchHome("e")
const homeDir = join(dir, "user-home")
const runtime = await Runtime.open(home, chain.network)
await init(runtime, [
  "claude-code", "codex", "assistant", "doomed-agent", "agent-a", "agent-b",
  "latecomer", "writer", "shorty", "agentx", "agenty", "lost",
])
await requestAccess(runtime, "claude-code")
await approve(runtime, "claude-code")

const grantsOf = (name: string) => runtime.agent(name).grants.flatMap((g) => g.capabilities.map((c) => c.capabilityId))
const liveCount = async (name: string) =>
  (await Promise.all(grantsOf(name).map((id) => isCapabilityLive(runtime.ownerChain, id)))).filter(Boolean).length
const hasRead = (name: string) =>
  runtime.reader.hasAuthority(runtime.owner, runtime.agent(name).agentId, NAMESPACE_ID, PERMISSION.READ, 0)

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

// E1 — red if a revoked agent keeps reading or writing: the API server must
// refuse, and every granted capability must read invalid on-chain.
async function e1() {
  await requestAccess(runtime, "doomed-agent")
  await approve(runtime, "doomed-agent")
  const started = Date.now()
  await revoke(runtime, "doomed-agent")
  const refusalMs = Date.now() - started
  const live = await liveCount("doomed-agent")
  const readAttempt = await attemptNamespaceRead(runtime, "doomed-agent", NAMESPACE)
  const writeCode = await throwCode(() =>
    runtime.agent("doomed-agent").create(runtime.owner, NAMESPACE, {
      value: { type: "mida.checkpoint.v1", projectId: "p-e1", sessionId: "e1", continuesSession: null, compiledBy: "bench", checkpoint: sampleCheckpoint({ eventId: "ev-e1-01" }) },
      kind: "EPISODE",
      source: "AGENT_INFERRED",
    }),
  )
  return {
    pass:
      live === 0 &&
      (await hasRead("doomed-agent")) === false &&
      readAttempt.ok === false &&
      (readAttempt as { code?: string }).code === "CAPABILITY_REVOKED" &&
      (writeCode === "CAPABILITY_REVOKED" || writeCode === "CAPABILITY_DENIED"),
    value: { liveCaps: live, readCode: readAttempt.ok ? "ok" : (readAttempt as { code: string }).code, writeCode },
    limit: null,
    detail: { refusalMs },
  }
}

// E2 — red if a second approve sends another transaction, or if a CREATE-only
// grant lets requestAccess pretend nothing is live.
async function e2() {
  const claudeCaps = (await runtime.reader.activeCapabilityIds(runtime.owner, runtime.agent("claude-code").agentId)).length
  const doubleCode = await throwCode(() => approve(runtime, "claude-code"))
  const claudeCapsAfter = (await runtime.reader.activeCapabilityIds(runtime.owner, runtime.agent("claude-code").agentId)).length

  // a CREATE-only grant, minted straight through the vault like an old approval
  const writer = runtime.agent("writer")
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60)
  const request = await writer.createAccessRequest({
    purposeId: PURPOSE_ID,
    scopes: [{ namespace: NAMESPACE, permissions: PERMISSION.CREATE, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    capabilityExpiresAt: expiresAt,
  })
  const approval = await runtime.vault.approveGrant({
    accessRequest: request,
    manifest: loadAgentIdentity(home, "writer")!.manifest,
    selection: { kind: "custom", scopes: request.scopes, expiresAt },
  })
  await writer.completeAccessRequest(request, approval.response)
  saveGrants(home, "writer", [...writer.grants])
  const requestAgain = await throwCode(() => requestAccess(runtime, "writer"))
  const canRead = await runtime.reader.hasAuthority(runtime.owner, writer.agentId, NAMESPACE_ID, PERMISSION.READ, 0)
  const canCreate = await runtime.reader.hasAuthority(runtime.owner, writer.agentId, NAMESPACE_ID, PERMISSION.CREATE, 0)
  return {
    pass:
      doubleCode === "already-approved" &&
      claudeCapsAfter === claudeCaps &&
      requestAgain === "already-approved" &&
      canRead === false &&
      canCreate === true,
    value: { doubleCode, capsBefore: claudeCaps, capsAfter: claudeCapsAfter, requestAgain, canRead, canCreate },
    limit: null,
  }
}

// E3 — red if an expired grant leaves the agent permanently unapprovable: the
// raw stored id list is not proof of approval — re-approval must mint a fresh
// live grant.
async function e3() {
  const shorty = runtime.agent("shorty")
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 45)
  const request = await shorty.createAccessRequest({
    purposeId: PURPOSE_ID,
    scopes: [{ namespace: NAMESPACE, permissions: AGENT_PERMISSIONS, provenancePolicy: PROVENANCE_POLICY.ALLOW_INFERENCE }],
    capabilityExpiresAt: expiresAt,
  })
  const approval = await runtime.vault.approveGrant({
    accessRequest: request,
    manifest: loadAgentIdentity(home, "shorty")!.manifest,
    selection: { kind: "custom", scopes: request.scopes, expiresAt },
  })
  await shorty.completeAccessRequest(request, approval.response)
  saveGrants(home, "shorty", [...shorty.grants])
  const liveBefore = await liveCount("shorty")
  await increaseLocalTime(chain.network.rpcUrl, 300n)
  const expired = (await hasRead("shorty")) === false
  await requestAccess(runtime, "shorty")
  await approve(runtime, "shorty")
  const liveAfter = await liveCount("shorty")
  return {
    pass: liveBefore > 0 && expired && liveAfter > 0 && (await hasRead("shorty")),
    value: { liveBefore, expired, liveAfter },
    limit: null,
  }
}

// E4 — red if re-approving a revoked agent fails, if one damaged identity file
// blocks another agent's revocation, or if the re-approved agent loses saves.
async function e4() {
  await requestAccess(runtime, "agent-a")
  await approve(runtime, "agent-a")
  await requestAccess(runtime, "agent-b")
  await approve(runtime, "agent-b")
  await revoke(runtime, "agent-a")
  await requestAccess(runtime, "agent-a")
  await approve(runtime, "agent-a")
  const identityA = loadAgentIdentity(home, "agent-a")
  await saveCheckpoint(runtime, "agent-a", {
    projectId: "p-e4", sessionId: "e4", continuesSession: null, compiledBy: "bench",
    checkpoint: sampleCheckpoint({ eventId: "ev-e4-01", progress: ["saved after re-approval"] }),
  })
  // one damaged identity file must not make the rewrap loop die for everyone else
  home.writeSecretJson("agents/agent-a/identity.json", { bogus: true })
  const revokeB = await throwCode(() => revoke(runtime, "agent-b"))
  if (identityA !== undefined) saveAgentIdentity(home, identityA)
  const bLive = await liveCount("agent-b")
  const aLive = await liveCount("agent-a")
  // the restored identity heals on the next repair pass; agent-a keeps writing
  await repairReaderWraps(runtime)
  const saveB = await throwCode(() =>
    saveCheckpoint(runtime, "agent-a", {
      projectId: "p-e4", sessionId: "e4", continuesSession: null, compiledBy: "bench",
      checkpoint: sampleCheckpoint({ eventId: "ev-e4-02", progress: ["saved after b revoke"] }),
    }),
  )
  const read = await readCheckpoints(runtime, "agent-a", "p-e4")
  return {
    pass: revokeB === null && bLive === 0 && aLive > 0 && saveB === null && read.checkpoints.length === 2,
    value: { revokeB, bLive, aLive, saveB, aRecords: read.checkpoints.length },
    limit: null,
  }
}

// E5 — red if a mismatched or missing identity file revokes the WRONG agent or
// revokes nobody: the signer's chain mapping decides who loses access.
async function e5() {
  await requestAccess(runtime, "agentx")
  await approve(runtime, "agentx")
  await requestAccess(runtime, "agenty")
  await approve(runtime, "agenty")
  await requestAccess(runtime, "lost")
  await approve(runtime, "lost")
  const xId = runtime.agent("agentx").agentId
  const yId = runtime.agent("agenty").agentId
  const lostId = runtime.agent("lost").agentId

  // hand-copied folder: agentx's grants + agenty's signer, no identity — the
  // chain's signer mapping must revoke agenty, not the name the grants file claims
  home.writeSecretJson("agents/mixup/grants.json", loadGrants(home, "agentx"))
  home.writeSecretJson("agents/mixup/signer.json", { signerPrivateKey: loadOrCreateSignerKey(home, "agenty") })
  await revoke(runtime, "mixup")
  const yRead = await runtime.reader.hasAuthority(runtime.owner, yId, NAMESPACE_ID, PERMISSION.READ, 0)
  const xRead = await runtime.reader.hasAuthority(runtime.owner, xId, NAMESPACE_ID, PERMISSION.READ, 0)

  // a missing identity resolves through the signer mapping to the right loss
  home.remove("agents/lost/identity.json")
  await revoke(runtime, "lost")
  const lostRead = await runtime.reader.hasAuthority(runtime.owner, lostId, NAMESPACE_ID, PERMISSION.READ, 0)
  return {
    pass: yRead === false && xRead === true && lostRead === false && home.has("agents/mixup/revoked.json"),
    value: { revokedCorrectAgent: yRead === false && xRead === true, missingIdentityRevoked: lostRead === false },
    limit: null,
  }
}

// E6 — red if events queued before the owner approved the agent ever reach the
// chain: the drain drops them permanently, and a post-approval event is the
// only record that may exist.
async function e6() {
  const e6dir = join(dir, "work-e6")
  mark(e6dir, "p-e6")
  // the drain only opens transcripts of agents with a known transcript folder, so the
  // queued jobs name claude-code: it is chain-approved from setup, and "approval" here is
  // the project row — approve(cwd) adds it without minting a second grant
  const pre = writeTranscript(homeDir, "proj", "e6-pre.jsonl", [userLine("queued before approval")])
  enqueue(home, { agent: "claude-code", event: "PostToolUse", sessionId: "e6-pre", transcriptPath: pre, cwd: e6dir, error: null })
  const compile = stubCompile([])
  await drainOnce({ home, runtime, compile, homeDir })
  await approve(runtime, "claude-code", e6dir)
  const post = writeTranscript(homeDir, "proj", "e6-post.jsonl", [userLine("queued after approval"), assistantText("post step")])
  enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "e6-post", transcriptPath: post, cwd: e6dir, error: null })
  await drainOnce({ home, runtime, compile, homeDir })
  const read = await readCheckpoints(runtime, "claude-code", "p-e6")
  return {
    pass: read.checkpoints.length === 1 && read.checkpoints[0]!.sessionId === "e6-post",
    value: { stored: read.checkpoints.length, sessions: read.checkpoints.map((c) => c.sessionId) },
    limit: null,
  }
}

// E7 — red if the injected text trusts the checkpoint's own agent claim: the
// on-chain author must name the real saver, and the claim appears only as a quote.
async function e7() {
  const e7dir = join(dir, "work-e7")
  mkdirSync(e7dir, { recursive: true })
  const { approval: codexApproval } = await approveProject(runtime, { agent: "codex", cwd: e7dir })
  await requestAccess(runtime, "codex")
  await approve(runtime, "codex")
  await approveProject(runtime, { agent: "claude-code", cwd: e7dir })
  await saveCheckpoint(runtime, "codex", {
    projectId: codexApproval.projectId, sessionId: "e7", continuesSession: null, compiledBy: "bench",
    checkpoint: sampleCheckpoint({
      eventId: "ev-e7-01", agent: "claude-code", progress: ["forged author work"], remainingPlan: ["continue"],
    }),
  })
  const hand = await buildHandoff(runtime, { agent: "claude-code", cwd: e7dir, authorNames: authorNamesFor(runtime) })
  if (hand.kind !== "handoff") throw new Error(`handoff-${hand.kind}`)
  const text = hand.text
  const onChainAuthor = text.includes("codex (on-chain author")
  const claimFlagged = text.includes('claims "claude-code"')
  return { pass: onChainAuthor && claimFlagged, value: { onChainAuthor, claimFlagged }, limit: null }
}

// E8 — red if the least-context agent can read the project namespace, or if it
// loses the owner-fact namespace its policy grant covers.
async function e8() {
  const written = await remember(runtime, "the owner prefers terse answers")
  if (written.kind !== "remembered") throw new Error("remember-refused")
  const facts = await attemptNamespaceRead(runtime, "assistant", "preferences.communication")
  const projects = await attemptNamespaceRead(runtime, "assistant", "projects.current")
  return {
    pass:
      facts.ok === true &&
      (facts as { objects: number }).objects >= 1 &&
      projects.ok === false &&
      (projects as { code: string }).code === "CAPABILITY_DENIED",
    value: { facts: facts.ok, factsObjects: facts.ok ? (facts as { objects: number }).objects : 0, projectsCode: projects.ok ? "ok" : (projects as { code: string }).code },
    limit: null,
  }
}

try {
  await runGroup([
    { id: "E1", run: e1 },
    { id: "E2", run: e2 },
    { id: "E3", run: e3 },
    { id: "E4", run: e4 },
    { id: "E5", run: e5 },
    { id: "E6", run: e6 },
    { id: "E7", run: e7 },
    { id: "E8", run: e8 },
  ])
} finally {
  await runtime.close()
  await chain.env.stop()
}
