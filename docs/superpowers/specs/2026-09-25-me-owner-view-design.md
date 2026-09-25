# `/me` — the owner view (design spec)

Date: 2026-09-25 · Status: design approved by Dami (mockup `docs/design/me-mockup/`, approved Sep 25);
this written spec awaits Dami's read · Nothing here is built yet.

**Revision 1 (Sep 25, after a Fable adversarial review):** fixes two blockers — revoke from `/me` would
have cut every surviving agent off from new keys (B1, §5), and batched records would have shown as
"not on Monad" (B2, §3) — plus nine should-fixes, each marked **[R1]** where it changed the text.

**Where to look:** §1 is what the page is for. §3 is where every number on the page comes from — the
part most likely to be wrong. §6 is what must change outside the page. §9 is what is not proven.

---

## 1. What it is and why

`app.midacontext.xyz/me` is the one place an owner sees, in a browser, **who can read their context,
who wrote each record, and how each save reached Monad** — and can revoke an agent with their passkey.
Today the owner page never discovers anything on its own: it only acts on a link the terminal builds
(`apps/owner-page/src/owner/page.ts:41-47`, `link.ts`). `/me` is the first page that reads the owner's
whole state.

It also carries two hackathon obligations:
- **Envio bounty** — "the index must actually drive a feature" (Monad Metropolis bounty page). `/me`
  is the first user-facing reader of `apps/indexer` (no code anywhere queries it today).
- **Mera Part 2** — sign in on a fresh browser with the passkey; the page derives the same owner and the
  same context key from it (the non-wallet use of the PRF secret) and decrypts the owner's records.

The home page (`owner-home` branch, `bbaa972`) links its "Sign in with passkey" button to `/me`; the
two ship together.

## 2. Screens (as approved)

Exactly the mockup: header (owner address derived from the passkey; a source badge naming where the
data came from and how far behind Monad it is), summary tiles, **Agents and their access** (per agent a
"Grants" block: one row per area with three aligned pill chips — Read · Write · Update own — filled when
granted, dashed when not; approved/revoked date with its transaction; Revoke button → confirm panel with
the disclosure sentence and "Confirm with passkey"), **Recent records, and who wrote them** ("You said"
vs "<agent> inferred", when, how it reached Monad), **How your saves reach Monad** (direct / batched /
pending counts). Plain HTML/CSS/JS served by the owner-page Worker under the existing strict CSP;
system font; no entry animation; light and dark; phone width.

Chip mapping (what the contract enforces): Read = `READ`, Write = `CREATE`, Update own =
`SUPERSEDE_OWN` (`packages/protocol` permission bits). An agent holding `SUPERSEDE_ANY` shows a fourth
chip "Update any"; none of Mida's own agents is granted it by default.

## 3. Where every number comes from (the part to review hardest)

Rule: **every figure on the page names its source**, and a row the page could not verify says so
instead of looking complete.

**[R1] Which areas the page reads:** the distinct `namespaceId`s the index has for this owner (fallback:
the three owner areas `OWNER_NAMESPACES`, `flows.ts:68`), not a hard-coded list. **Not shown (no source
exists off the terminal):** the approved project folder per agent, and free-text agent descriptions —
the manifest carries only `name` and `purposes` (`packages/protocol/src/types.ts:203`). The mockup's
"Folder: mida-context" line is dropped. An agent with several grants shows its earliest approval and
latest change, each with its tx.

| Section | Primary source | Fallback when the index is down or behind | Verified against |
|---|---|---|---|
| Owner address | derived in the browser from the passkey PRF (`secrets.ts:53-74`) | — | `CapabilityRegistry.ownerP256Key` (`session.ts:114-129`) |
| Agents + grants | Envio `Grant` + `Agent` + `Revocation` by owner | **[R1]** chain logs: `eth_getLogs` on `CapabilityGranted` / `AgentRevoked` filtered by the owner topic (`owner` is indexed; midad already scans this way, `packages/chain/src/history.ts`, `apps/midad/src/owner-read.ts`), labelled "from chain logs". (Contract views alone cannot list, `chain-views.ts:58-218`.) | each grant re-read on chain with `isCapabilityValid` (covers revoked, expired and agent-epoch, `CapabilityStore.sol:48-52`) before "Can read" |
| Agent names | the agent's manifest from the store, `getAgentManifest(bodyHash)` (unsigned public GET, `apps/api/src/client.ts:111-113`), hash from `readAgentRecord` | agent id, shortened | — |
| Records list + text | **[R1] two lanes, unioned** (as midad's `owner-read.ts:285-295` does): direct records from store `listObjects({owner, namespaceId})` (`client.ts:80-99`) and batched records from store `listBatchSaves` (`client.ts:167-172`); ciphertext inline; owner-signed | same (the store, not the index, is the list of records) | direct rows: `getRecords` on `ContextRegistry`. **Batched rows never touch ContextRegistry** (`EventHandlers.ts:552-554`) — verify them against index `BatchedSave` or the `SaveAnchored` log plus the store's Merkle proof, NEVER ContextRegistry. A row neither lane can confirm shows "not on Monad — unverified". **If either list returns `partial: true`** (`app.ts:406-408`), show "list incomplete — the store ran out of chain reads; reload" and do not show counts derived from it. |
| "You said" vs "<agent> inferred" | `provenanceSource` on chain (`ContextRecordView`, `chain-views.ts:22-40`) — `USER_ASSERTED`/`USER_CONFIRMED` → "You said" (the contract only accepts those when `msg.sender == owner`, `ContextRegistry.sol:130-132, 185-196`), `AGENT_INFERRED` → "<author> inferred"; **every batched row is agent-inferred by contract rule** (`BatchAnchor.sol:127`); the index gains the field (§6.2) | the chain read | the decrypted payload's `provenance.source` must agree; disagreement → row flagged. A **pending** batched row's provenance is the agent's claim, not yet contract-checked — labelled "claimed" |
| How it reached Monad | index `BatchedSave` (§6.2) for batched; `ContextRecord` for direct | chain logs `SaveAnchored` for the record's `contextId` in the batch block | pending = the store's batch list (`listBatchSaves`) for saves not yet anchored |
| Summary counts | **[R1]** from the index (`Owner.records + Owner.batchedSaves`; count of `provenanceSource ∈ {1,2}`), labelled "per the index at block N" — NOT from the displayed rows, which are paged (newest 20) | chain-log counts, labelled; hidden if unavailable | — |
| "N s behind Monad" | **[R1]** index `GlobalStats.lastTimestamp` vs the latest block's timestamp (a block count is not seconds) | — | — |
| "Batching is on" | store `batchStatus()` (`client.ts:151`) | "unknown" | — |
| Store-side deny (revoke pending on chain) | **[R1]** store `listRevocations("active")` (`client.ts:143`): a revoke stages a store deny before the chain tx (`authority.ts:333, 365`) and keeps it if the sponsor is still pending (`authority.ts:389`) | — | shown as "blocked at the store · revoke pending on Monad", never as "Can read" |

## 4. Sign-in and decryption (Mera Part 2)

1. `/me` asks for the passkey once (Mera `getPasskeyPrfOutput`, rpId `app.midacontext.xyz`), derives
   `evmKey` + `ownerSeed` (`deriveOwnerSecrets`), and checks the derived address has an owner key on
   chain. **[R1] Shortest possible lifetime** (today's flows hold secrets "for the length of one action",
   `secrets.ts:26-34`): derive the needed namespace secrets immediately, then `release()` the owner seed;
   keep only `evmKey` in memory for signing store reads (viem keeps its own copy that cannot be wiped,
   `secrets.ts:76-80` — stated, not hidden). On `pagehide`, sign-out, or the tab hidden > 5 min: release
   everything and **clear decrypted text from the page**. Revoke asks for the passkey again
   (`flows.ts:550-557`). Nothing is written to storage except the owner address (as today).
2. Owner reads to the store are signed with the derived account (EIP-712 `MidaHttpRequestV1`,
   `client.ts:44-63`); the store allows an owner to read their own objects with no capability
   (`app.ts:376`).
3. Decrypt in the browser, exactly as the owner flows already do (`authority.ts:200-204`):
   `deriveNamespaceSecret(fakePrfOutput(ownerSeed, domain), namespaceId)` → `deriveEpochKeyPair(secret,
   epoch)` → `openContextObject` (`packages/crypto/src/object.ts:98-118`). All browser-safe
   (`@mida/crypto`, `@mida/fake-vault/browser`); the bundle test (`test/bundle.test.ts:15-40`) must stay
   at zero `node:` imports.
4. A record that fails to decrypt shows "could not be opened with this passkey" — never blank, never
   a guess.
5. **[R1] Rendering rule (XSS):** agent manifest names are chosen by the agent's operator and record
   text is written by agents — both are untrusted. Render with `textContent` only (the existing pages
   never use `innerHTML`); a transaction link is built only from a value matching `/^0x[0-9a-f]{64}$/`.

## 5. Revoke from `/me`

Reuse `prepareRevoke` / `confirmRevoke` (`flows.ts:516-617`). **[R1]** They take a link request, so `/me`
builds a real `OwnerLinkRequest` in the page with the protocol helpers: `chainId`, `owner` = **the
address derived at sign-in** (never a field from a row — that is what `assertExpectedOwner`,
`flows.ts:561`, re-checks), `agentId` from the verified row, and the challenge/nonce/requestHash the
helpers produce (`flows.ts:70, 553`).

**[R1] BLOCKER fixed — surviving agents must get the new key.** A revoke rotates the area's key, and
`confirmRevoke` re-sends it only to the agents in `req.readers` (`flows.ts:579-587`), which the terminal
fills today (`apps/midad/src/owner-link/flows.ts:816`). `/me` must fill `readers` with **every other
agent the page verified as holding live READ** on chain, or every other agent silently loses the
ability to read new records while the page still says "Can read". Sends stay **sponsored-only** (`send.ts:6-40`: a
passkey owner holds 0 MON). The confirm panel shows the Global Constraints sentence
`This stops future reads through Mida. It does not erase what <agent> already read.` After the
transaction lands, the row flips to Revoked with its transaction; the page re-reads, it does not assume.
If the sponsor is still pending, the store deny is already in place (`authority.ts:389`): the row
shows "blocked at the store · revoke pending on Monad", not "Can read" (§3).
Known limit, stated in the page's help text: the terminal's local files learn of a browser revoke only
through the chain (reads are refused at once because every read checks the chain; `mida doctor` on that
machine may show the old state until its next chain check).

## 6. Changes outside the page

### 6.1 Owner-page Worker
- Route `/me` → `me.html` (`src/worker.ts:9-16`), a `me.ts` bundle built like the other flows
  (`scripts/build.mjs:37-73`, same `@mida/chain/browser` plugin).
- CSP `connect-src` adds the index's GraphQL origin (`src/headers.ts:5-8`); nothing else is added.
  Note: `indexer.dev.hyperindex.xyz` is shared by every Envio dev deployment (ids are in the path, CSP
  is per origin), so the allowance is wider than our index — acceptable for a read-only public index;
  stated, not hidden.
- **[R1]** The index URL is Worker configuration (an env var served to the page), not baked into the
  bundle — a redeploy of the index changes the deployment id in the path.

### 6.2 Indexer (`apps/indexer`)
- Set the real BatchAnchor address and start block (`config.yaml:67-69`: `0xe5dcf76B…a9E1`; deployed in
  block 65373284 — use 65373247, the deployment file's scan floor).
- New entity `BatchedSave { id = contextId, owner @index, namespaceId, batchId, position, block,
  txHash, agentId }` written from `SaveAnchored` (today the handlers only bump counters,
  `EventHandlers.ts:574-613`). **[R1] No per-save rejected entity:** `SaveRejected` carries only
  `(batchId, index, reason)` (`BatchAnchor.sol:71`) — no contextId or owner. Rejections are read from the
  store (`GET /batch/saves/:contextId`, state `REJECTED`, `batch-routes.ts:376`).
- `ContextRecord.provenanceSource` stored from the event (the handler drops it today,
  `EventHandlers.ts:453-498`).
- The GraphQL endpoint must allow the `app.midacontext.xyz` origin (CORS).

### 6.3 Hosting the index (researched Sep 25; sources in the session log)
- **Monad testnet is supported.** Envio's chain page: "Chain ID: 10143 … HyperSync Endpoint:
  https://monad-testnet.hypersync.xyz … Support Level: First-class support across HyperIndex, HyperSync,
  and HyperRPC" (docs.envio.dev/docs/HyperIndex/monad-testnet → envio.dev/chains/monad-testnet), with a
  "Deploy … on Envio Cloud" button.
- **Envio Cloud free "Development" plan:** 30-day maximum life, deleted after 7 days with no queries,
  soft limits 100,000 events / 5 GB (docs.envio.dev hosted-service-billing). ⇒ deploy no earlier than
  **Sep 28** so it lives through judging (Oct 14–27). **[R1]** Sep 28 + 30 days = Oct 28, one day past
  judging — re-deploy around Oct 20. Keep it alive with an **automated** query (a Cron Trigger on the
  owner-page Worker pinging the endpoint daily), not by hand. Re-deploy before
  day 30 if judging runs late.
- **Deploy:** GitHub App, push-to-deploy from a chosen branch (docs.envio.dev hosted-service-deployment).
  Endpoint: `https://indexer.dev.hyperindex.xyz/<deployment-id>/v1/graphql`; no API key to query.
- **Unverified, test on the first deploy:** (1) our versions — `envio 3.11.0`, `pnpm 12.4.1`, Node 25 —
  against the docs' stated requirements (HyperIndex ≥2.21.5, "2.29.x unsupported", pnpm 10.32.0,
  Node ≥24; v3 is not mentioned either way); (2) **CORS** — Envio does not document it; Hasura's
  default allows all origins, and Envio's opt-in IP/domain whitelist is a separate mechanism. Check the
  `Access-Control-Allow-Origin` header from `app.midacontext.xyz` before building the page against it.
- **Fallback if Envio Cloud fails:** self-host (Envio's Docker Compose example: Postgres + Hasura; a
  HyperSync API token is required when self-hosting) — more work, but CORS is then ours to set.

## 7. Tests (each fails first)
- Worker: `/me` route + CSP string includes exactly the one new origin.
- Bundle: zero `node:` imports in `me.js`.
- Data layer (pure functions over fixtures): grant bits → chips; provenance → badge; a record absent on
  chain → "unverified"; an index row the chain contradicts → flagged, not shown as live; index down →
  the fallback message, not an empty page.
- Decrypt: a fixture record sealed with a known owner seed opens; a wrong seed → the "could not be
  opened" row.
- Revoke: the panel carries the exact disclosure string; confirm calls `confirmRevoke` with the row's
  owner/agentId; a failed send leaves the row "Can read" with the error shown.
- Indexer: `BatchedSave` and `provenanceSource` written from fixture events.
- **[R1]** A batched row → "batched", never "not on Monad"; a direct row → "direct".
- **[R1]** Revoke re-sends the new key to every surviving READ agent (`publishReaderWraps` called once
  per survivor per rotated area) and to none that lost READ.
- **[R1]** `partial: true` from either store list → the "list incomplete" banner, counts hidden.
- **[R1]** An active store deny → "blocked at the store · revoke pending on Monad".
- **[R1]** An agent named `<img src=x onerror=alert(1)>` and a record whose text is HTML render as
  literal text; a malformed tx hash renders no link.
- **[R1]** An index behind by > 60 s → the badge says so; a grant the index calls live but the chain
  calls invalid → shown as the chain says, flagged.

## 8. Not in this build
Approve from `/me` (still the terminal's link flow); editing or deleting records; other owners; the
"Update any" chip beyond displaying it; notifications; any claim that `/me` is a security boundary
(the contract is).

## 9. Not proven yet / risks
- **Envio Cloud on Monad testnet** — the chain is supported (§6.3); our tool versions and CORS are not yet proven — a test deploy decides.
- **Store list completeness** — the store lists what it holds; a record whose upload never reached the
  store (the Sep 24 "177 never-anchored uploads" class) cannot appear. The page says "records held by
  the store", not "all your records".
- **Decrypt cost** — opening many records in the browser; start with the newest 20, "show more" pages.
- **The live owner page is a pre-Sep-24 build** (passkey domain `midacontext.xyz`, found by the Mera
  test); `/me` ships with the redeploy, and passkeys made on the old domain are not offered on the new one.
