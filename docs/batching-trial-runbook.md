# Batched checkpoint saves — trial runbook

**What this document is.** A plain-language guide to the batched checkpoint lane: how to turn it
on for a trial, how to turn it off instantly, how to read what `mida doctor` says about it, and
how to run the cost benchmark on Monad testnet. Written for someone who has never read the
contracts.

**The one-sentence version.** Normally every automatic checkpoint save is its own Monad
transaction. With batching on, saves are signed locally and handed to the hosted store, which
packs many saves into one shared transaction. The BatchAnchor contract still checks every save on
its own — signature, live grant, area, epoch, parent — and can reject individual saves inside a
shared batch. Everything else (grants, revokes, facts, owner keys) is unchanged.

---

## 1. Turning batching on for a trial — three steps

Batching is off by default and only runs when **all four** of these hold:

1. The setup's `network.json` says `batching: true` (the `mida batching on` command writes this).
2. The deployment file names a `batchAnchor` contract address.
3. The setup uses the hosted store (`storageUrl` is set), and that store answers that it has
   batching enabled for the same anchor.
4. The store's server-side switch `BATCHING_ENABLED` is on.

The trial steps:

1. **We deploy** the BatchAnchor contract and the store (Dami runs both) and set
   `BATCHING_ENABLED=true` on the store.
2. **The trial user runs** `mida batching on`. The command first checks the four conditions above
   and names any that fail — nothing is switched if a check fails. It prints what changes
   ("automatic checkpoint saves will be anchored in shared batches; grants, revokes and facts are
   unaffected"), asks for `yes`, writes `batching: true` into `network.json`, and restarts the
   daemon.
3. **Verify with** `mida doctor` — read the lane line (below).

To stop the trial, either side can act: the user runs `mida batching off`, or we flip
`BATCHING_ENABLED=false` on the store (see §2). Saves already queued still finish — they are
either anchored or reported rejected; nothing is silently dropped.

## 2. The kill switch (our side, no customer action needed)

Setting `BATCHING_ENABLED=false` on the store ends the trial for everyone at once: the store
refuses new batched saves with the named error `BATCHING_DISABLED`, and every client falls back
to the direct path — one transaction per save — for new saves. No customer machine needs to be
touched, restarted or upgraded. Turning it back on is the same flag flipped back.

## 3. Reading `mida doctor`

The lane line tells you which path automatic checkpoint saves are taking **right now**:

- `ok: checkpoint saves: batched via <host>` — saves are going to the named store's queue and
  being anchored in shared batches.
- `ok: checkpoint saves: one transaction each` — the direct path; every save is its own
  transaction. This is the normal answer when batching is off, and also what you should see again
  after `mida batching off` or a kill-switch flip.

Below the lane line, doctor lists any batched saves that are stuck or were rejected by the
contract — a rejected save shows up here with its reason code (the table in §5).

## 4. What `PENDING_ANCHOR` means

A batched save that has been saved and checked but not yet written to Monad shows the marker
`PENDING_ANCHOR`. In plain terms: the signature, the bytes and the grant were all verified, the
store has accepted it into the queue, and the only thing missing is the shared transaction that
anchors it on-chain.

A pending save is **usable** — a fresh session can read it and continue from it — but it is never
final. Until the batch lands, the contract can still reject it (for example if the grant was
revoked between queueing and submission). If that happens the save stops appearing in handoffs
and doctor reports it as a problem. In handoff text a pending save is always labelled
"PENDING_ANCHOR: not yet anchored on Monad; may still be rejected" — never described as final.

## 5. Rejection codes, in plain language

When the contract refuses a save inside a batch it emits a reason code. Here is what each one
means:

| Code | Name | Plain meaning |
|---|---|---|
| 1 | `BAD_SIGNER` | The signature doesn't check out, or the signing key belongs to no registered agent — the contract can't tell who wrote this save. |
| 2 | `BAD_SHAPE` | The save isn't the fixed checkpoint shape — missing content commitments, a record kind that isn't allowed, lineage fields that don't belong, or provenance that isn't agent-written. |
| 3 | `BAD_AREA` | The save targets a context area (namespace) that isn't registered on-chain. |
| 4 | `BAD_EPOCH` | The save was signed against a read epoch that isn't current, or the current epoch no longer accepts writes — typically an epoch rotated between signing and submission. |
| 5 | `NO_AUTHORITY` | The signing agent's grant doesn't cover the save: starting a lineage needs a live create-with-inference grant; replacing a save needs supersede rights on that lineage. A revoked agent's queued saves land here. |
| 6 | `ALREADY_ANCHORED` | The save starts a lineage that already exists on-chain — this exact lineage was anchored before, so nothing new is written. |
| 7 | `STALE_PARENT` | A replacement save whose parent is no longer the latest in its lineage — another save already continued it, so this one's base is out of date. |

Checks run in a fixed order — signer, shape, area, authority, epoch, then lineage — so a save
failing more than one check reports the first failure only (for example a revoked save on a stale
epoch reports `NO_AUTHORITY`, not `BAD_EPOCH`).

## 6. Running the testnet benchmark (Dami)

The benchmark script is `scripts/bench-batch-anchor.mts`. It was written and unit-tested but
**never executed against testnet** — the first real run is this one. It spends real testnet MON
from the deployer key, so run the small one first.

In Terminal, from the repo root, with `.env` carrying `DEPLOYER_PRIVATE_KEY` (funded) and
`MONAD_TESTNET_RPC`, and `contracts/deployments/10143.json` naming a `batchAnchor` (the deploy in
step 1 above, plus `pnpm run deployments:gen`):

```
node --env-file=.env --import tsx scripts/bench-batch-anchor.mts --price-usd <MON price> --saves 20 --batch 20
```

- `--price-usd` is required — the evidence file ties every wei figure to the stated MON price and
  the run date, so the numbers can be converted to USD later without guessing what price applied.
- `--saves` sets how many signed saves the batched phase anchors (the direct phase always runs at
  most 20, since it is one transaction per save). `--batch` is how many saves go into each shared
  transaction when the script submits them itself, capped at 432: Monad refuses any transaction
  over 30,000,000 gas, the submit path's own ceiling budgets 28,000,000, and the Sep 24 sweep's
  lowest measured per-save cost was 61,457 gas
  (docs/evidence/batch-anchor-sweep-2026-09-24.json) — floor(28,000,000 × 0.95 / 61,457) = 432.
  A real store applies the same rule itself —
  its batcher sizes each batch by a gas budget learned from real receipts, not a fixed count.
  `--agents` sets how many throwaway agents split the saves.
- Before spending anything, the script checks the deployer balance against its own estimate and
  refuses — printing both numbers — if it isn't enough.
- `--store <url>` switches the batched phase from the script's own submissions to a real store:
  saves are posted to the store's queue, the store's batcher packs and submits them, and the
  script measures how long queued→anchored takes. Run it against a store only this benchmark is
  posting to.

The run writes `docs/evidence/batch-anchor-benchmark-<date>.json`. That file is the only place
benchmark numbers live — per-save charged cost and gas used in both lanes, transaction counts,
rejected count, the largest observed batch, and (with `--store`) latency percentiles. Nothing in
this runbook states a number on purpose: quote only what the evidence file reports after a real
run.

## 7. Known limits

**A batch id can be stolen.** The batch id sits in the pending transaction while it waits in the
mempool, and the contract is immutable — no code change can hide it. Anyone watching can land a
batch under that id first; our send then either fails its simulation with `BatchExists` or lands
a transaction that reverts on chain — and Monad bills the full gas limit of the reverted
transaction either way. The rows are not lost: the store probes the id on chain, finds the foreign
batch, and logs `batch.id-taken` (with the foreign submitter when the send reverted) before
requeueing the saves under a fresh id. A single occurrence is noise; **repeated `batch.id-taken`
lines mean someone is actively racing the store** — treat that as an incident and consider pausing
the lane (`BATCHING_ENABLED=false`) rather than paying full gas on doomed sends.
