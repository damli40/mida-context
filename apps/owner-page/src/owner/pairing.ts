/**
 * The pairing code lives in `@mida/protocol` (src/owner-link.ts) — one implementation shared by
 * this page and the terminal, so the two sides can never drift. This file is only the old import
 * path, kept so existing imports keep working.
 */
export { PAIRING_WORDS, pairingCode } from "@mida/protocol"
