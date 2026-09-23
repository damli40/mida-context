import { evidenceCommitment } from "@mida/protocol"
import type { Hex, RecordReference } from "@mida/protocol"
import { approve, init, loadAgentIdentity, remember, requestAccess, revoke, saveCheckpoint } from "@mida/midad"
import type { Runtime } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

/**
 * The record set every `mida migrate` task (3, 5, 6, 7) exercises: an agent checkpoint, two owner
 * facts with identical text, a fact superseded v1→v2→v3, records in `goals.personal` — a namespace
 * no local agent is ever granted READ on — an owner evidence record, a record whose references
 * point at it, then a revoke (which rotates the read epoch on every namespace the agent could
 * read) and a fact written under the new epoch. Ten records across four namespaces, spanning
 * read epochs 1 and 2.
 */
export interface MigrateSeed {
  agentId: Hex
  checkpointId: Hex
  identicalText: string
  identicalFactIds: readonly [Hex, Hex]
  supersedeIds: readonly [Hex, Hex, Hex]
  privateNamespace: "goals.personal"
  privateGoalId: Hex
  evidenceId: Hex
  referrerId: Hex
  references: readonly RecordReference[]
  postRotationId: Hex
  allIds: readonly Hex[]
}

/** Writes the whole universe against an already-open Runtime on a fresh home. */
export async function seedMigrateUniverse(runtime: Runtime): Promise<MigrateSeed> {
  await init(runtime, ["claude-code"])
  await requestAccess(runtime, "claude-code")
  await approve(runtime, "claude-code")
  const agentId = loadAgentIdentity(runtime.home, "claude-code")!.agentId

  // An agent-authored checkpoint — the one record in the set the owner did not write itself.
  const checkpoint = await saveCheckpoint(runtime, "claude-code", {
    projectId: "proj-migrate",
    sessionId: "s1",
    continuesSession: null,
    compiledBy: "helpers-migrate",
    checkpoint: sampleCheckpoint({ eventId: "cp-migrate-01", objective: "prove owner reads everything" }),
  })

  // Two owner facts carrying IDENTICAL text — record identity is the contextId, never the payload.
  const identicalText = "the owner prefers plain language"
  const factA = await remember(runtime, identicalText)
  const factB = await remember(runtime, identicalText)
  if (factA.kind !== "remembered" || factB.kind !== "remembered") {
    throw new Error("seeding the identical facts was refused")
  }

  // A fact superseded v1 → v2 → v3, in the other fact namespace (profile.skills).
  const supersedeIds: Hex[] = []
  let parent: Hex | undefined
  for (const text of ["skill v1", "skill v2", "skill v3"]) {
    const written = await runtime.vault.createOwnerContext({
      namespace: "profile.skills",
      payload: { v: 1, value: { text }, kind: "FACT", provenance: { source: "USER_ASSERTED" }, tags: ["migrate-seed"] },
      ...(parent === undefined ? {} : { expectedParentId: parent }),
    })
    supersedeIds.push(written.contextId)
    parent = written.contextId
  }

  // A namespace no agent ever reads: the owner opens it and writes into it directly.
  const privateNamespace = "goals.personal" as const
  await runtime.vault.initializeNamespace(privateNamespace)
  const privateGoal = await runtime.vault.createOwnerContext({
    namespace: privateNamespace,
    payload: { v: 1, value: { text: "a goal no agent can see" }, kind: "GOAL", provenance: { source: "USER_ASSERTED" }, tags: ["migrate-seed"] },
  })

  // An owner evidence record — the only non-CONTEXT record type.
  const evidence = await runtime.vault.createOwnerContext({
    namespace: privateNamespace,
    recordType: "EVIDENCE",
    payload: { v: 1, value: "supporting document", kind: "NONE", provenance: { source: "NONE" }, tags: ["migrate-seed"] },
  })

  // A record whose provenance.references point at the evidence — the link lives only in the payload.
  const references: RecordReference[] = [{ relation: "confirmed_from", recordId: evidence.contextId }]
  const referrer = await runtime.vault.createOwnerContext({
    namespace: privateNamespace,
    payload: {
      v: 1,
      value: { text: "a goal confirmed by the evidence" },
      kind: "GOAL",
      provenance: { source: "USER_CONFIRMED", references },
      tags: ["migrate-seed"],
    },
    evidenceCommitment: evidenceCommitment(references),
  })

  // Revoking the agent rotates the read epoch on every namespace it could read; the next fact
  // is sealed under epoch 2 while everything above stays under epoch 1.
  await revoke(runtime, "claude-code")
  const postRotation = await remember(runtime, "written after the rotation")
  if (postRotation.kind !== "remembered") throw new Error("seeding the post-rotation fact was refused")

  const identicalFactIds = [factA.contextId, factB.contextId] as const
  const allIds = [
    checkpoint.contextId,
    ...identicalFactIds,
    ...supersedeIds,
    privateGoal.contextId,
    evidence.contextId,
    referrer.contextId,
    postRotation.contextId,
  ]
  return {
    agentId,
    checkpointId: checkpoint.contextId,
    identicalText,
    identicalFactIds,
    supersedeIds: supersedeIds as unknown as readonly [Hex, Hex, Hex],
    privateNamespace,
    privateGoalId: privateGoal.contextId,
    evidenceId: evidence.contextId,
    referrerId: referrer.contextId,
    references,
    postRotationId: postRotation.contextId,
    allIds,
  }
}
