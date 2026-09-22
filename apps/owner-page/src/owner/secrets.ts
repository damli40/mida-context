import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import { assertNonZeroKey, hexOf } from "@mida/crypto"
import { MidaError } from "@mida/protocol"
import type { Address } from "@mida/protocol"

/**
 * The one WebAuthn PRF salt every owner ceremony evaluates. FROZEN once shipped: the passkey's
 * PRF output is the root of every owner secret below, so changing this salt — or the HKDF labels
 * — orphans every owner that already signed up. The known-answer test pins all three constants
 * and both outputs; a change there is a deliberate owner-migration event, never a refactor.
 */
export const OWNER_PRF_SALT: Uint8Array = sha256(utf8ToBytes("mida.owner.prf.v1"))

/** HKDF-SHA256 info labels — same freeze rule as the salt. */
const OWNER_EVM_INFO = utf8ToBytes("mida.owner.evm.v1")
const OWNER_SEED_INFO = utf8ToBytes("mida.owner.seed.v1")

/** HKDF extract salt: empty (the PRF output is already a uniform 32-byte key). */
const OWNER_HKDF_SALT = new Uint8Array(0)

/**
 * What one passkey ceremony unlocks for the length of one action: the secp256k1 wallet key (the
 * owner address the contracts see as msg.sender, the signer of store requests and project-list
 * entries) and the 32-byte owner seed that namespace secrets derive from, exactly as the seed
 * file fed `fakePrfOutput` in the CLI's FakeVaultAuthority.
 *
 * These buffers are never intentionally persisted — not to storage, the URL, the DOM or a log —
 * and `release()` overwrites them in place and marks the object dead. That is a best-effort
 * overwrite of mutable buffers, not a guaranteed wipe: the JS runtime may copy memory, and the
 * derived viem account holds its own internal key copy that only GC can reclaim.
 */
export interface OwnerSecrets {
  /** secp256k1 private key bytes — HKDF(prf, info "mida.owner.evm.v1"). */
  readonly evmKey: Uint8Array
  /** The owner seed — HKDF(prf, info "mida.owner.seed.v1") — the input fakePrfOutput expects. */
  readonly ownerSeed: Uint8Array
  /** True after release() ran; an OwnerSecrets past release must not be used. */
  readonly released: boolean
  /** Best-effort overwrite of both buffers; idempotent. */
  release(): void
}

/**
 * PRF output → the two owner secrets. CONSUMES the input: the prfOutput buffer is overwritten in
 * place before this returns, so after the call the only secret bytes the application can reach
 * are the two buffers on the returned object. 32 non-zero bytes in, two frozen-label derivations
 * out — anything else throws before touching the input.
 */
export function deriveOwnerSecrets(prfOutput: Uint8Array): OwnerSecrets {
  assertNonZeroKey(prfOutput, "passkey PRF output")
  const evmKey = hkdf(sha256, prfOutput, OWNER_HKDF_SALT, OWNER_EVM_INFO, 32)
  const ownerSeed = hkdf(sha256, prfOutput, OWNER_HKDF_SALT, OWNER_SEED_INFO, 32)
  prfOutput.fill(0)
  assertNonZeroKey(evmKey, "derived owner EVM key")
  assertNonZeroKey(ownerSeed, "derived owner seed")
  let released = false
  return {
    evmKey,
    ownerSeed,
    get released() {
      return released
    },
    release() {
      if (released) return
      evmKey.fill(0)
      ownerSeed.fill(0)
      released = true
    },
  }
}

/**
 * The viem account over the derived EVM key. The account keeps its own copy of the key material
 * internally — `release()` on the secrets drops our buffers and the caller drops the account
 * reference, but nothing can reach inside viem to overwrite its copy. Per the wording rule this
 * is "released from application references", not wiped.
 */
export function ownerAccount(secrets: OwnerSecrets): LocalAccount {
  if (secrets.released) throw new MidaError("AUTH_INVALID", "owner secrets were already released")
  return privateKeyToAccount(hexOf(secrets.evmKey))
}

/** The owner address a passkey maps to — the wrong-owner check compares this to the link's owner. */
export function ownerAddressOf(secrets: OwnerSecrets): Address {
  return ownerAccount(secrets).address.toLowerCase() as Address
}

/** "0x1234…abcd" for the wrong-owner message — a hint for the eye, never an authority. */
export function shortAddress(address: Address | string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}
