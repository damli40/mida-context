# `/me`, the owner view: operator notes

**What this document is.** A plain-language runbook for `app.midacontext.xyz/me`, the page where an
owner signs in with their passkey and sees their recent records and who wrote them. Written for
someone who has never read the contracts. It covers what each thing on the page is claimed to be,
where it comes from, and what the page cannot show you.

**The one-sentence version.** `/me` reads your record list from the store, then checks every record
against Monad itself, so the page can be slow to load, and anything it could not verify says so
instead of looking confirmed.

**It does not list your agents yet.** The page says so in place of the list: "This page does not
list your agents yet. Run mida doctor in your terminal to see the agents approved on that machine." Listing
agents and their grants needs a lookup of everything the contracts have emitted. A browser cannot
build that by itself (a scan from the deployment block was measured at about 39,000 requests against
a public RPC that allows about 500 inside the page's time budget), and no such lookup is deployed.

**Read-only in this build.** `/me` never revokes. Run `mida revoke <agent>` in the terminal. Review
found a browser revoke could strand the other agents without the rotated key when the repair step
lived only in page memory, so the action stays in the terminal, where the re-key is guaranteed to
run.

---

## 1. What the page shows, and where each part comes from

A quick vocabulary pass, then the table.

- **The chain (Monad)** is the authority. Grants, revocations and record anchors are events our
  contracts emitted; nothing off-chain can overrule them.
- **The store** is the hosted service that holds the encrypted records. It is the list of records;
  the chain is the check on that list.
- **A passkey** is the owner's Face ID / fingerprint credential. The page derives the owner's
  identity and decryption keys from it in the browser; nothing secret leaves the device.

| What you see | Where it comes from first | Checked against | If the source fails |
|---|---|---|---|
| Your address (the header) | Derived in the browser from your passkey | The owner key registered on chain | Sign-in refuses; the page never guesses |
| The header badge | Fixed text: "Records come from the store and are checked on Monad" | Nothing to check: it names the page's method, not a result | The text stays; the dot beside it turns to its warning colour when a list was incomplete or the store did not answer |
| The list of agents and their grants | Not shown yet | Nothing | The page says it does not list agents and points to `mida doctor` |
| An agent's name beside a record | Its manifest, fetched from the store | Nothing | The shortened agent id, never blank |
| The records list and their text | The store's two lanes: records that went on chain directly, and saves waiting inside shared batches | Direct rows: re-read on `ContextRegistry`. Batched rows: a Merkle proof checked against the batch's root on chain, **never** `ContextRegistry` (batched saves are not in it) | "not on Monad — unverified" when the chain answered and disagreed; "could not check Monad just now" when the check itself never ran (a dead RPC, or a batched save whose author nobody could name). If every store listing fails, the section reads "could not load records from the store", never an empty-list claim; a partial list shows "list incomplete — the store ran out of chain reads; reload" and hides the counts |
| A record's anchor ("direct · anchored on Monad", "batch · anchored on Monad") | The lane the store filed the save under | The same chain check as the row above | The page shows no transaction link: it has no source for transaction hashes |
| "You said" vs "&lt;agent&gt; inferred" | The record's provenance field (the contract only accepts "the user said this" when the owner signed it) | The decrypted record must agree; a mismatch flags the row: "the record's own label disagrees with Monad" | "Source unknown". That includes every row the chain did not confirm, so a batched save still in the queue shows no provenance claim at all |
| How a record reached Monad ("direct" / "batched" / "pending") | The store's own lists: which lane it filed the save under, and for batched saves the Merkle proof it serves with each one | The proof is checked against the batch's root on the deployment's `BatchAnchor` contract. A store that advertises a different batch contract is named ("the store serves a different batch contract") and its batched rows read unverified | "pending" is the store's queue position; a failed or partial store list hides the pending count rather than guessing it |
| The record counts | Counted from the records the store returned, each re-checked against Monad | The same per-record checks | Hidden when a list came back partial: "Figures hidden — the record list is incomplete." |
| "Batching is on for this setup." | The store's own status answer | Nothing | "Batching state unknown — the store did not answer." |
| "Blocked — author denied or no longer authorized" on a record | The store's active deny list, or a grant Monad already refuses | Nothing more: a revoke cuts store access the moment it is confirmed in the terminal, before the chain transaction lands | The row never reads as pending |

Two rules hold across the whole table: **every figure names where it came from**, and **a row the
page could not verify says so** instead of looking complete. If a source fails, you see a labelled
gap, never an empty page and never a silent guess.

## 2. Known limits: what the page cannot tell you

- **It does not list agents.** Who can read your context, each agent's grants and the links to
  grant and revoke transactions are not on the page. `mida doctor` in the terminal lists the
  agents approved on that machine's setup, not every agent an owner approved elsewhere.
- **It only sees records the store holds.** A save whose upload never reached the store cannot
  appear on the page: the store is the list of records. Read "Recent records" as "records held by
  the store", never "everything ever saved".
- **No transaction links.** An anchored record reads "anchored on Monad" with its lane. The check
  ran against the chain, but the page has no source for the transaction hash.
- **Decryption is paged.** The newest 20 records are decrypted first; older ones wait behind "Show
  20 more". Opening records costs real work in the browser, so the page does not try to open all of
  them at once.
- **A revoke takes effect at the store before the chain.** Once a revoke is confirmed in the
  terminal, the store refuses that agent; the chain transaction makes it permanent. A record that
  agent wrote then reads "Blocked — author denied or no longer authorized".
