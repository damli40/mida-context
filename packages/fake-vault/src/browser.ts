/**
 * The browser-safe surface of @mida/fake-vault. fake-vault.ts itself imports the @mida/chain
 * barrel (which can reach node-only modules), so this entry exports only the pure helpers and
 * re-exports the authority's public types — `export type` is erased at build time, keeping the
 * heavy module out of the browser graph. The passkey authority in apps/owner-page implements
 * the VaultAuthority interface against these types.
 */
export { fakePrfOutput } from "./prf.js"
export { assertionToWire } from "./webauthn.js"
export type { VaultAssertionMetadata, WebAuthnAssertionWire } from "./webauthn.js"
export type { VaultContextApi } from "./ports.js"
export type {
  FakeVaultConfig,
  GrantApproval,
  GrantRequest,
  GrantSelection,
  RevokeApproval,
  RevokeRequest,
  VaultAuthority,
} from "./fake-vault.js"
export { toAccessRequestStruct } from "./fake-vault.js"
