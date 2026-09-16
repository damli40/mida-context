import type { IsolationDomain } from "@mida/protocol"
import { assertNonZeroKey, prfSalt } from "@mida/crypto"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"

/**
 * Deterministic stand-in for one WebAuthn PRF evaluation (§6.1): HMAC-SHA256(seed, domain salt), the same shape as
 * a real authenticator's PRF. There is deliberately no function that returns a global root; callers only ever get
 * one domain's output, and FakeVaultAuthority keeps even that private.
 */
export function fakePrfOutput(seed: Uint8Array, domain: IsolationDomain): Uint8Array {
  assertNonZeroKey(seed, "fake vault seed")
  return hmac(sha256, seed, prfSalt(domain))
}
