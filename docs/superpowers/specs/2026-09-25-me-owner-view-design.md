# `/me` — the owner view (design spec)

Date: 2026-09-25 · Status: design approved by Dami (mockup `docs/design/me-mockup/`, approved Sep 25);
this written spec awaits Dami's read · Nothing here is built yet.

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

| Section | Primary source | Fallback when the index is down or behind | Verified against |
|---|---|---|---|
| Owner address | derived in the browser from the passkey PRF (`secrets.ts:53-74`) | — | `CapabilityRegistry.ownerP256Key` (`session.ts:114-129`) |
| Agents + grants | Envio `Grant` + `Agent` + `Revocation` by owner | none that can list: the chain has no "list agents for owner" read (`apps/api/src/chain-views.ts:58-218`). Show "agent list unavailable — index down" and the agents named in the owner's store records (authors), each verified on chain | each grant re-read on chain with `getCapability` / `isCapabilityValid` before it is shown as "Can read" |
| Agent names | the agent's manifest from the store, `getAgentManifest(bodyHash)` (unsigned public GET, `apps/api/src/client.ts:108-110`), hash from `readAgentRecord` | agent id, shortened | — |
| Records list + text | store `listObjects({owner, namespaceId})`, owner-signed, ciphertext inline (`client.ts:82-98`, `app.ts:369-421`) | same (the store, not the index, is the list of records) | each record's `getRecords` on `ContextRegistry` (Multicall3); a record the chain does not confirm is shown "not on Monad — unverified", never as saved |
| "You said" vs "<agent> inferred" | `provenanceSource` on chain (`ContextRecordView`, `chain-views.ts:22-40`) — `USER_ASSERTED`/`USER_CONFIRMED` → "You said", `AGENT_INFERRED` → "<author> inferred"; the index gains the same field (§6.2) | the chain read | the decrypted payload's `provenance.source` must agree; disagreement → row flagged |
| How it reached Monad | index `BatchedSave` (§6.2) for batched; `ContextRecord` for direct | chain logs `SaveAnchored` for the record's `contextId` in the batch block | pending = the store's batch list (`listBatchSaves`) for saves not yet anchored |
| Summary counts | derived from the rows above, never a separate counter | — | — |
| "N s behind Monad" | index `lastBlock` vs RPC `eth_blockNumber` | — | — |

## 4. Sign-in and decryption (Mera Part 2)

1. `/me` asks for the passkey once (Mera `getPasskeyPrfOutput`, rpId `app.midacontext.xyz`), derives
   `evmKey` + `ownerSeed` (`deriveOwnerSecrets`), and checks the derived address has an owner key on
   chain. The secrets live only in memory; `release()` on sign-out, tab hidden > 5 min, or page unload.
   Nothing is written to storage except the owner address (as today, `session.ts`).
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

## 5. Revoke from `/me`

Reuse `prepareRevoke` / `confirmRevoke` (`flows.ts:516-617`) with `owner` and `agentId` supplied by the
page's own verified row instead of a terminal link. Sends stay **sponsored-only** (`send.ts:6-40`: a
passkey owner holds 0 MON). The confirm panel shows the Global Constraints sentence
`This stops future reads through Mida. It does not erase what <agent> already read.` After the
transaction lands, the row flips to Revoked with its transaction; the page re-reads, it does not assume.
Known limit, stated in the page's help text: the terminal's local files learn of a browser revoke only
through the chain (reads are refused at once because every read checks the chain; `mida doctor` on that
machine may show the old state until its next chain check).

## 6. Changes outside the page

### 6.1 Owner-page Worker
- Route `/me` → `me.html` (`src/worker.ts:9-16`), a `me.ts` bundle built like the other flows
  (`scripts/build.mjs:37-73`, same `@mida/chain/browser` plugin).
- CSP `connect-src` adds the index's GraphQL origin (`src/headers.ts:5-8`); nothing else is added.

### 6.2 Indexer (`apps/indexer`)
- Set the real BatchAnchor address and start block (`config.yaml:67-69`: `0xe5dcf76B…a9E1`; deployed in
  block 65373284 — use 65373247, the deployment file's scan floor).
- New entity `BatchedSave { id = contextId, owner @index, namespaceId, batchId, position, block,
  txHash, agentId }` written from `SaveAnchored` (today the handlers only bump counters,
  `EventHandlers.ts:574-613`); `SaveRejected` rows likewise (with `reason`).
- `ContextRecord.provenanceSource` stored from the event (the handler drops it today,
  `EventHandlers.ts:453-498`).
- The GraphQL endpoint must allow the `app.midacontext.xyz` origin (CORS).

### 6.3 Hosting the index
Envio Cloud after the Sep 30 public push (`apps/indexer/README.md`). **Unverified:** that Envio Cloud /
HyperSync serves Monad **testnet** (their examples use mainnet 143). Check this first — if it does not,
the fallback column of §3 is what the page shows, and the Envio bounty needs another plan (§9).

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

## 8. Not in this build
Approve from `/me` (still the terminal's link flow); editing or deleting records; other owners; the
"Update any" chip beyond displaying it; notifications; any claim that `/me` is a security boundary
(the contract is).

## 9. Not proven yet / risks
- **Envio Cloud on Monad testnet** — unverified; decides whether the bounty stands (§6.3).
- **Store list completeness** — the store lists what it holds; a record whose upload never reached the
  store (the Sep 24 "177 never-anchored uploads" class) cannot appear. The page says "records held by
  the store", not "all your records".
- **Decrypt cost** — opening many records in the browser; start with the newest 20, "show more" pages.
- **The live owner page is a pre-Sep-24 build** (passkey domain `midacontext.xyz`, found by the Mera
  test); `/me` ships with the redeploy, and passkeys made on the old domain are not offered on the new one.
