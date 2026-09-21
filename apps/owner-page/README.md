# Mida owner page — passkey device check

A single static page plus a tiny Worker that serves it. It is **a device check, not the product**:
it answers four questions that only a real passkey on the real domain can answer, before we build
the owner-facing approval page that replaces Mida's file-held keys.

The page registers a throwaway passkey on `midacontext.xyz` and then exercises it, reporting each
answer as PASS / FAIL / UNKNOWN with one plain sentence. A **Copy report** button exports the
answers as JSON — public values only.

## What it answers, and why each answer matters

| Line | The question | Why the real design needs it |
|---|---|---|
| a | Is this a secure context with WebAuthn? | Passkeys only exist on HTTPS origins. |
| b | Does the passkey return its secret bytes (PRF)? | Mida derives the vault key from the WebAuthn PRF output — no PRF, no vault. When this fails the page says exactly how to fix it: save the passkey to Google Password Manager, iCloud Keychain or 1Password, not the local Chrome profile. |
| c | Is the key ES256 (−7)? | The contract verifies P-256 ECDSA only. An RS256 (−257) passkey can never produce a signature the contract accepts. |
| d | Was the credential's public key captured (x, y)? | The contract needs the P-256 point registered once at setup. Mera discards it; our custom client captures it from `response.getPublicKey()`. |
| e | Does an assertion **over our challenge** verify in the browser? | Mera signs its own random challenge and throws the assertion away. The page substitutes a fixed fake 32-byte challenge and checks the signature, the `sha256("midacontext.xyz")` rpId hash and the user-verified flag itself — the same checks the contract applies. |
| f | Does the same signature verify **on Monad**? | One read-only `eth_call` to the P256 precompile at `0x…0100` proves the chain's verifier accepts what the authenticator produces. No transaction, no wallet, no gas. |
| g | How many prompts does one click cause? | The product needs exactly one touch per approval. Mera runs a silent fallback assertion on devices that don't evaluate PRF at create time — this counts it. |
| h | Do two ceremonies derive the same secret? | If PRF output isn't deterministic the vault can't be reopened. Only a 4-byte fingerprint of `sha256(prfOutput)` is ever shown — the secret never appears. |
| i | What does the page see of browser, OS, authenticator? | The report a reviewer sends back needs to name the device it ran on. |

## How a reviewer deploys it

```sh
node apps/owner-page/scripts/build.mjs   # produces apps/owner-page/dist/ — no network needed
cd apps/owner-page
wrangler deploy                        # the implementer does NOT run this
```

Then uncomment the route in `wrangler.toml` so the page is served under `midacontext.xyz`, and
open `https://midacontext.xyz/check` on the device being checked.

## A localhost run is not evidence

A passkey is scoped to a relying-party ID. The page registers for `midacontext.xyz`; served on
`localhost` (or a `*.workers.dev` URL) the browser either refuses the ceremony or creates a
passkey bound to the wrong domain. **Only a run on `https://midacontext.xyz` answers the four
questions.** Localhost is fine for looking at the layout — the checklist will say so itself.

## Layout

- `public/check.html`, `public/check.css` — the page (no inline scripts or styles, no third-party origins, no analytics, no CDN fonts).
- `src/check/` — the page logic, each piece unit-tested without a browser: SPKI → (x, y), DER signature → low-s (r, s) via the exact `packages/protocol` helper, the authenticator-data parser, the precompile input builder, the custom Mera `WebAuthnClient` that captures what Mera discards, and the report sanitiser that refuses secret-looking keys.
- `src/worker.ts` + `src/headers.ts` — serves `dist/` through the assets binding and sets the CSP/Referrer-Policy/nosniff/Permissions-Policy/no-store headers on every response.
- `scripts/build.mjs` — esbuild → `dist/` (gitignored).
- `test/` — vitest; synthetic vectors generated in-test with `@noble/curves`, including the real Mera `createPasskeyWithPrfOutput`/`getPasskeyPrfOutput` driven against a fake `navigator.credentials`.
