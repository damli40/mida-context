/** The one domain a real passkey can be scoped to. A passkey created on localhost proves nothing. */
export const RP_ID = "midacontext.xyz"
export const RP_NAME = "Mida device check"

/**
 * The challenge the page asks the authenticator to sign instead of the random one Mera generates.
 * Mera picks its own challenge and never inspects the assertion, so the custom client substitutes
 * this fixed, clearly fake value and captures the signature itself. 32 bytes of ASCII.
 */
export const TEST_CHALLENGE = new TextEncoder().encode("MIDA-TEST-CHALLENGE-DO-NOT-USE!!")

/** RIP-7212 / EIP-7951 secp256r1 verifier precompile, the same address MidaWebAuthn checks on Monad. */
export const P256_PRECOMPILE = "0x0000000000000000000000000000000000000100"

/** Read-only JSON-RPC endpoint for the one `eth_call` the page makes. No transaction, no wallet. */
export const MONAD_TESTNET_RPC = "https://testnet-rpc.monad.xyz"

export const COSE_ES256 = -7
export const COSE_RS256 = -257

export const FLAG_UP = 0x01
export const FLAG_UV = 0x04
export const FLAG_AT = 0x40
export const FLAG_ED = 0x80
