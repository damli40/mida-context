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

import { zeroHash } from "viem"
import { PERMISSION, PROVENANCE_POLICY } from "@mida/protocol"
import type { BatchSaveRow } from "./batch-store.js"
import type { RegistryReader } from "./chain-views.js"
import type { DenyOverlay } from "./deny-overlay.js"

/** One row's answer at send time: submit it, keep it HELD, or mark it dead. */
export type BatchGateVerdict = "send" | "hold" | "reject"

export interface BatchRowGate {
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
