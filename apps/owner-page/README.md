# Mida owner page — one passkey is the whole account

Mida's owner — the person who approves and revokes what agents may read — used to keep three
secrets in files on disk: a wallet key, a seed the context-area keys come from, and a P-256 key.
This app replaces all three with **one passkey**. No key file, no MON in the browser (a gas
sponsor pays), no owner server (the hosted store holds the ciphertext). The terminal opens one of
three pages; the page does the work; the terminal reads the result.

- `/signup` — creates the passkey, registers its P-256 key on chain, opens the three context areas.
- `/approve` — an agent's signed request arrives in the link fragment; the page checks it, shows
  what the agent is asking for, and one passkey touch signs the grant.
- `/revoke` — shows what the agent can read today (from the chain, not from the link), and one
  touch ends it and locks the old keys out of what it already saved.

## What the page can and cannot do

**Can:** derive the owner's wallet and seed from the passkey's PRF output, register the passkey's
public key, approve or revoke grants, publish fresh key wraps to surviving agents, sign the
project-list entry — all sponsored, all in one touch per action.

**Cannot:** pay for a transaction itself (a passkey owner holds no MON — a sponsor refusal means
"try again later"), rotate the registered P-256 key (a different ceremony, out of scope), or
recover anything. **The passkey IS the account: lose it and you lose this owner.** Its platform
sync — iCloud Keychain, Google Password Manager, 1Password — is the backup.

## What it stores

`localStorage` holds three public values and nothing else: the credential id, the passkey's
public point, and the owner address. Derived secrets live in memory for the length of one action;
they are **never intentionally persisted, released from application references after the
operation, with a best-effort overwrite of mutable buffers** — JavaScript cannot promise more.

## The pairing code

Every page shows `Only approve if this code matches your terminal:` followed by three words and
two digits, derived from `sha256("mida.pair.v1" ‖ the exact request bytes)`. The terminal computed
the same code from the same bytes. If it does not match, close the tab — a lookalike link cannot
borrow the real page.

## The three failure messages and what causes each

- **"This passkey was saved somewhere that cannot hold Mida's secret…"** — the passkey answered
  without PRF output (e.g. saved to a local Chrome profile). Delete it; create it in iCloud
  Keychain, Google Password Manager or 1Password. Nothing is sent.
- **"This passkey belongs to a different Mida owner (0x…) than the one your terminal is using
  (0x…)"** — a different passkey derives a different owner. Checked right after the touch, before
  any send. Use the passkey you signed up with.
- **"The gas sponsor did not pay: …"** — the sponsor refused. Nothing else was sent and the page
  has no self-pay fallback. If the sponsor accepted but did not confirm in time, the page says
  **pending** with the operation hash — check it, never resend.

## Terminal ↔ page contract

`PROTOCOL.md` in this directory is the wire spec the terminal round implements: the link
fragment, the request object, the pairing code, the sanitised result, and the
`http://127.0.0.1:<port>/mida-return` navigation.

## Build

```sh
node apps/owner-page/scripts/build.mjs   # produces dist/ — no network needed
pnpm typecheck && pnpm exec vitest run apps/owner-page/test
```

`wrangler deploy` is run by the maintainer, not the implementer.

## NOT RUN — what the tests do not cover

- **No real passkey, browser or chain has run these flows.** Vitest drives them against fakes: a
  `navigator.credentials` that signs whatever challenge it is handed, a fake sponsor, a fake
  store, a fake chain reader. The device check (`/check`) is the only flow proven on hardware.
- **The rpId mismatch is live in the checked-in deployment:** `10143.json` pins
  `vault.mida.xyz` while the page serves at `app.midacontext.xyz`. Browsers refuse a ceremony
  whose rpId is not a suffix of the page's host — the pages detect this and explain it before
  any prompt, so nothing works end-to-end until the deployment rpId and the serving host agree.

## The device check (`/check`)

The original device-check page still lives at `/check` — it answers whether a given device and
browser can do what the flows need (PRF output, ES256, a signature Monad's P256 precompile
accepts, one prompt per click), reporting PASS / FAIL / UNKNOWN per line with a JSON report that
contains public values only.

## Layout

- `public/*.html`, `public/owner.css`, `public/check.*` — the pages; no inline scripts or styles, no third-party origins.
- `src/owner/` — the owner logic: `secrets.ts` (frozen PRF→key derivation), `webauthn.ts` (the one-touch ceremonies), `send.ts` (sponsored-only writes), `authority.ts` (`PasskeyVaultAuthority`), `pairing.ts`, `link.ts` (the wire contract), `session.ts` (storage + owner checks), `flows.ts` (the three flows), `page.ts` + `signup.ts`/`approve.ts`/`revoke.ts` (the DOM layer).
- `src/check/` — the device check, unchanged.
- `src/worker.ts` + `src/headers.ts` — routes and the CSP on every response.
- `test/` — vitest; the flows run end to end against fakes, no browser needed.
