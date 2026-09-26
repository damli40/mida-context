// in-3 (I5): the batcher's per-row authority gate. The deny overlay is the only component that
// knows a revoke is coming — Monad has not seen it yet — so nothing past store admission was
// consulting it, and a save queued before the owner staged the revoke anchored inside the
// pending window. The gate answers one question per row, at send time and on every held-row
// re-check: may this save's author write RIGHT NOW, counting both the deny overlay and Monad?
//
//   deny active                       → "hold"   (the revoke may still land or be cancelled)
//   deny inactive, no live authority  → "reject" (the contract could only reject it NO_AUTHORITY)
//   deny inactive, authority live     → "send"
//
// "reject" never fires while a deny is active — a pending revoke is not a landed one, and the
// row must survive a cancellation. The authority computation is the exact one POST /batch/saves
// admission runs (batch-routes.ts), so a row's release answer is the answer the contract would
// give it on-chain.
//
// in-11 R-9: the check opens on the overlay's LOCAL list, not the chain — an owner with no active
// intent answers "send" without a single Monad read, and the contract remains the authority
// decider it always was. The chain work below only ever runs for an owner a pending deny could
// actually cover.

import { zeroHash } from "viem"
import { PERMISSION, PROVENANCE_POLICY } from "@mida/protocol"
import type { BatchSaveRow } from "./batch-store.js"
import type { RegistryReader } from "./chain-views.js"
import type { DenyOverlay } from "./deny-overlay.js"

/** One row's answer at send time: submit it, keep it HELD, or mark it dead. */
export type BatchGateVerdict = "send" | "hold" | "reject"

export interface BatchRowGate {
  /**
   * One row's verdict. The batcher memoizes calls within a pass keyed on the fields a verdict
   * may read — owner, signer, namespaceId, save.message.parentId, save.message.rootAuthor — so
   * an implementation must not answer from anything else (in-11 R-9).
   */
  check(row: BatchSaveRow): Promise<BatchGateVerdict>
}

/**
 * The store's own deny overlay plus live Monad authority, sharing the DenyOverlay instance the
 * HTTP routes use so a deny staged or cancelled through the API is exactly what the next tick
 * sees. Injected per-row because the knowledge lives beside the queue, not inside the signer.
 */
export function createBatchDenyGate(input: { reader: RegistryReader; overlay: DenyOverlay }): BatchRowGate {
  const { reader, overlay } = input
  return {
    async check(row: BatchSaveRow): Promise<BatchGateVerdict> {
      // The gate exists for the pending-deny window only: with no active intent for this owner
      // the overlay holds nothing that could hold the row, and Monad itself decides authority
      // on submit — spending chain reads here would only burn the hosted invocation's bounded
      // read budget on rows that were never in doubt (in-11 R-9). A deny for another owner is
      // equally out of scope.
      const ownerDenied = (await overlay.list()).some(
        (intent) => intent.state === "active" && intent.owner === row.owner.toLowerCase(),
      )
      if (!ownerDenied) return "send"
      const agentId = await reader.agentIdOfSigner(row.signer)
      // The signer no longer resolves to an agent — the contract derives its author the same way,
      // so this save could only ever come back rejected; refusing to send is the same answer.
      if (agentId === null) return "reject"
      // Landed revocations anchor their intents before the deny question is asked, so a hold ends
      // the moment Monad proves the revoke — not on some later reconciliation pass.
      await overlay.reconcileOwner(reader, row.owner)
      if (await overlay.deniesRelationship(reader, { owner: row.owner, agentId, namespaceId: row.namespaceId })) return "hold"
      const message = row.save.message
      const hasAuthority = (permission: number): Promise<boolean> =>
        reader.hasAuthority(row.owner, agentId, row.namespaceId, permission, PROVENANCE_POLICY.ALLOW_INFERENCE)
      const allowed =
        message.parentId === zeroHash
          ? await hasAuthority(PERMISSION.CREATE)
          : (message.rootAuthor.toLowerCase() === agentId.toLowerCase() && (await hasAuthority(PERMISSION.SUPERSEDE_OWN))) ||
            (await hasAuthority(PERMISSION.SUPERSEDE_ANY))
      return allowed ? "send" : "reject"
    },
  }
}
