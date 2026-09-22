import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"
import type { WebAuthnAssertionWire } from "./webauthn.js"

/**
 * The only Context API calls the Vault makes. Defined here as a port so the Vault does not depend on the API
 * package; `ContextApiClient` (plan Task 24) implements it structurally, and the CLI (Task 26) wires the two.
 */
export interface VaultContextApi {
  putObject(upload: {
    owner: Address
    namespaceId: Hex
    objectNonce: Hex
    expectedParentId: Hex
    manifest: ObjectManifest
    ciphertext: Hex
  }): Promise<unknown>
  publishEpochWrap(wrap: ReaderEpochWrap): Promise<unknown>
  /**
   * §12.5: the deny is posted before the chain write — fail-closed. The response carries the one-time
   * cancellation nonce, so the caller that staged the deny can undo it when the send provably never
   * happened (M3-D4). The nonce is a cancellation ticket, not a secret that leaves the owner.
   */
  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }): Promise<{ intentId: Hex; cancellationNonce: string }>
  /**
   * Cancels an active deny. `assertion` is the owner passkey signature over `cancelFastRevokeDigest`
   * for this intent, nonce and expiry — the store verifies it exactly as `POST /revocations/:id/cancel` does.
   */
  cancelRevocation(intentId: Hex, input: { expiresAt: bigint; assertion: WebAuthnAssertionWire }): Promise<unknown>
}
