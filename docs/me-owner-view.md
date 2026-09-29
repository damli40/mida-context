# `/me` — the owner view: operator notes

**What this document is.** A plain-language runbook for `app.midacontext.xyz/me` — the page where
an owner signs in with their passkey and sees every agent that can read their context, every recent
record and who wrote it. Written for someone who has never
read the contracts. It covers what each number on the page is *claimed* to be and where it comes
from, how to deploy and keep alive the index the page prefers to read, and what the page cannot
show you.

**The one-sentence version.** `/me` asks a public index (a pre-computed list of everything our
contracts have ever emitted) for the fast answer, then double-checks every grant and record against
Monad itself — so the page can be slow to load, and anything it could not verify says so out loud
instead of looking confirmed.

**Read-only in this build.** `/me` shows who can read your context but never revokes — for that,
run `mida revoke <agent>` in the terminal (or use the passkey revoke page it links to). Review
found a browser revoke could strand the other agents without the rotated key when the repair step
lived only in page memory, so the action stays in the terminal, where the re-key is guaranteed to
run.

---

## 1. What the page shows, and where each number comes from

A quick vocabulary pass, then the table.

- **The chain (Monad)** is the authority. Grants, revocations and record anchors are events our two
  contracts emitted; nothing off-chain can overrule them.
- **The index** is our Envio deployment (`apps/indexer`). It scans those events once and answers
  instantly over GraphQL. **It informs, it never decides** — the page treats it as a fast hint and
  re-checks the important claims on chain.
- **The store** is the hosted service that holds the actual encrypted records. The index knows a
  record *exists*; only the store holds its ciphertext.
- **A passkey** is the owner's Face ID / fingerprint credential. The page derives the owner's
  identity and decryption keys from it in the browser; nothing secret leaves the device.

| What you see | Where it comes from first | Checked against | If the source fails |
|---|---|---|---|
| Your address (the header) | Derived in the browser from your passkey | The owner key registered on chain | Sign-in refuses — the page never guesses |
| The list of agents and their grants | The index | **Every grant is re-read on chain** before it may say "Can read" — revoked and expired grants cannot slip through a stale index | Chain logs (slower; the badge says "from chain logs") |
| An agent's name | Its manifest, fetched from the store | — | The shortened agent id — never blank |
| The records list and their text | The store's two lanes: records that went on chain directly, and saves waiting inside shared batches | Direct rows: re-read on `ContextRegistry`. Batched rows: a Merkle proof checked against the batch's root on chain — **never** `ContextRegistry` (batched saves are not in it) | "not on Monad — unverified" when the chain answered and disagreed; "could not check Monad just now" when the check itself never ran (a dead RPC, or a batched save whose author nobody could name). If every store listing fails, the section reads "could not load records from the store" — never an empty-list claim; a partial list shows "list incomplete — the store ran out of chain reads; reload" and hides the counts |
| "You said" vs "&lt;agent&gt; inferred" | The record's provenance field (the contract only accepts "the user said this" when the owner signed it) | The decrypted record must agree — a mismatch flags the row: "the record's own label disagrees with Monad" | "Source unknown" — that includes every row the chain did not confirm, so a batched save still in the queue shows no provenance claim at all |
| How a record reached Monad ("direct" / "batched" / "pending") | The store's own lists: which lane it filed the save under, and for batched saves the Merkle proof it serves with each one | The proof is checked against the batch's root on the deployment's `BatchAnchor` contract — a store that advertises a different batch contract is named ("the store serves a different batch contract") and its batched rows read unverified | "pending" is the store's queue position; a failed or partial store list hides the pending count rather than guessing it |
| The summary counts | The index, labelled "per the index" | — | Hidden entirely when the index is down or a list came back partial — a partial list never produces a confident count |
| "≈ N s behind Monad" | The index's own progress report (`_meta`: how far the source chain has moved vs how far the index has processed it), converted at Monad's ~0.4 s cadence | — | Past 150 blocks (~60 s) the badge flags the index stale; an index that cannot report progress reads "index unavailable", and no configured index URL at all reads "index not configured" |
| "Batching is on" | The store's own status answer | — | "unknown" |
| "blocked at the store · revoke pending on Monad" | The store's active deny list — a revoke cuts store access the moment it is confirmed in the terminal, before the chain transaction lands | — | This row can never read "Can read" |

Two rules hold across the whole table: **every figure names where it came from**, and **a row the
page could not verify says so** instead of looking complete. If a source fails, you see a labelled
gap — never an empty page and never a silent guess.

## 2. The index underneath, and the cron that keeps it alive

`/me` is the first feature that actually reads `apps/indexer`, so the index only earns its keep if
it is deployed and stays deployed. Two facts about Envio Cloud's free "Development" plan drive
everything below:

1. A deployment lives **at most 30 days**.
2. It is **deleted after 7 days with no queries**.

The second is why the owner-page Worker carries a cron trigger (`[triggers] crons =
["17 6 * * *"]` in `apps/owner-page/wrangler.toml`): once a day at 06:17 UTC, Cloudflare calls the
Worker's `scheduled()` handler, which POSTs one tiny query — `{ GlobalStats(limit: 1) { lastBlock }
}` — to the configured index URL. That single request resets the 7-day idle clock. The ping
swallows every error on purpose: a missed day is harmless, a retried failure is not, and the cron
is not a health check.

Two honest caveats about the keep-alive:

- It only runs where it is deployed: the Worker must have the trigger **and** `INDEX_GRAPHQL_URL`
  set. Until then nothing is pinging anything.
- It cannot rescue a deployment already deleted — if the index dies, redeploy it (below) and point
  `INDEX_GRAPHQL_URL` at the new URL. The page keeps working in the meantime: it falls back to
  reading chain logs and says so on the badge.

## 3. Deploying the index to Envio Cloud

The full steps live in `apps/indexer/README.md` ("Deploy to Envio's hosted service"). Short version:

1. Push this repo to GitHub.
2. On envio.dev, add an indexer from the repo: root directory `apps/indexer`, config file
   `config.yaml`, deployment branch `envio`. No API token is needed on Envio Cloud.
3. Check that `apps/indexer/src/our-operators.ts` lists every operator address we have used
   (see the README's warning: an address missing from it makes our own agents count as
   "outside", inflating the traction number). Envio Cloud's free plan has no environment
   variables, which is why the list is committed.
4. Push the commit to index to the `envio` branch. Envio builds, indexes from `start_block`, and
   gives you a public GraphQL endpoint of the form
   `https://indexer.dev.hyperindex.xyz/<deployment-id>/v1/graphql`. No API key is needed to query.
   If the URL Envio gives you is on a different host, `/me` reports "not allowed" until that host
   is added to `connect-src` in `apps/owner-page/src/headers.ts` and the Worker is redeployed.
5. Point the owner page at it: set the Worker's `INDEX_GRAPHQL_URL` variable to that URL (a plain
   variable — `[vars]` in `wrangler.toml` or the Cloudflare dashboard; it is served to the page at
   `/me/config.json`, so it is **not** a secret).

**Timing — this is the part to get right.** Judging runs Oct 14–27. The 30-day clock means:

- **Deploy no earlier than Sep 28.** Sep 28 + 30 days = Oct 28 — one day past the end of judging.
  Earlier is strictly worse.
- **Re-deploy around Oct 20** anyway (a fresh 30-day window, cheap insurance against anything that
  went stale), and **re-deploy before day 30 of any deployment** if judging runs late.
- After **every** re-deploy, update `INDEX_GRAPHQL_URL` — the deployment id in the URL path
  changes, and the old URL stops answering.

## 4. Two things to prove on the first deploy

These are unverified assumptions, stated in the spec as risks. Check both on the very first deploy,
before relying on the index:

1. **Our tool versions.** We pin `envio 3.11.0`, pnpm 12.4.1 and Node 25. Envio's docs name older
   requirements and do not say whether v3 deploys cleanly — the first deploy is the test. If the
   hosted build rejects our versions, the fallback is self-hosting (Envio's Docker Compose example:
   Postgres + Hasura; needs a HyperSync API token). A self-hosted index lives on a different origin,
   and the page's Content Security Policy only allows `indexer.dev.hyperindex.xyz` — so self-hosting
   also means adding the new origin to `connect-src` in `apps/owner-page/src/headers.ts` and
   redeploying the Worker, or the browser refuses the page's requests to it.
2. **CORS.** Envio does not document whether its hosted endpoint answers browser cross-origin
   requests. From a session on `app.midacontext.xyz`, confirm the response carries an
   `Access-Control-Allow-Origin` header that lets the page read it. If it does not, the page cannot
   reach the index at all — it will run on chain logs forever, and self-hosting (where CORS is ours
   to set) becomes the fix.

## 5. Known limits — what the page cannot tell you

- **It only sees records the store holds.** A save whose upload never reached the store cannot
  appear on the page — the store is the list of records. Read "Recent records" as "records held by
  the store", never "everything ever saved".
- **Decryption is paged.** The newest 20 records are decrypted first; older ones wait behind "Show
  20 more". Opening records costs real work in the browser, so the page does not try to open all of
  them at once.
- **The CSP allows a shared origin, not just our index.** `indexer.dev.hyperindex.xyz` hosts every
  Envio dev deployment, and a Content Security Policy can only allow an origin, not a path — so the
  page's `connect-src` technically permits any deployment on that host. Acceptable for a read-only
  public index, but it is a wider allowance than "our index only", and we say so rather than hide
  it.
- **"Can read" is the chain's answer, not the index's.** A grant the index calls live but the chain
  calls dead shows as "Revoked — the index disagrees with the chain" (or "Expired or revoked on
  Monad" when the chain clock itself could not be read). An expired grant reads "Expired",
  unflagged — the index never tracks expiry, so there is no disagreement to flag. And a grant
  whose chain read never returned shows "Unverified — could not check Monad just now": that is
  Monad failing to answer, not the index disagreeing.
- **"Records saved" counts versions, not distinct records.** The index's `Owner.records` field
  increments once per record *version* written on chain, so a record saved three times moves the
  tile by three. Read it as "writes the chain has seen", not "how many records exist".
- **A revoke shown as "pending on Monad" is already effective at the store.** The moment the passkey
  confirms, the store refuses that agent — the chain transaction only makes it permanent.
