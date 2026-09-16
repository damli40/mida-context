import type { Address, Hex, ObjectManifest, ReaderEpochWrap } from "@mida/protocol"

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
  requestRevocationDeny(target: { capabilityId: Hex } | { owner: Address; agentId: Hex }): Promise<{ intentId: Hex }>
}
