# BatchAnchor: checked, Merkle-batched anchoring for automatic checkpoint saves

Status: design approved in chat by Dami, Sep 24 2026. Branch: `batch-anchor` (cut from
`p0-m0-skeleton`). Merge deadline: Oct 5 2026. Nothing here changes the frozen pitch.

## 1. What this is, in one paragraph

Today every automatic checkpoint save is its own Monad transaction (~289,000 gas measured for one
agent-authored save, `docs/evidence/m0-local-anvil.json`), mostly spent storing a 17-field record.
BatchAnchor lets many saves share one transaction. Each save is still signed by its own agent, and
the contract still checks every save (signature, live grant, area, read epoch, parent) exactly as
`ContextRegistry` does. What changes is storage: accepted saves share one Merkle root (one hash
that proves every save inside it), plus one lineage pointer per save. The hosted store only
carries saves to the chain; it cannot forge, approve or reorder authority.

## 2. Goals and non-goals

Goals
- G1. Lower the gas charged per automatic checkpoint save, measured on Monad testnet against
  one-save-per-transaction.
- G2. A measured throughput statement for judges: "N saves anchored in M Monad transactions,
  queued-to-anchored p50/p95 of X/Y seconds", copied only from the evidence file (§9).
- G3. The same guarantees as today: author proven by the agent's own signature, authority checked
  live on chain, lineage enforced by the contract.

Non-goals
- Grants, revocations, owner-key changes, owner facts (`remember`) and evidence records: they stay
  on today's direct path, unchanged. This is the priority lane: nothing that changes authority
  waits in a batch.
- Moving batched saves with `mida migrate` (it refuses instead, §7.4).
- Batching for local-store / self-paid setups (they keep the direct path).
- Continuing a lineage that lives in `ContextRegistry` from a batched save.

## 3. Fixed rules (from the design agreement)

- R1. Keep the existing permission system. `BatchAnchor` reads `CapabilityRegistry`; it never
  writes to it. `ContextRegistry` and `CapabilityRegistry` are not redeployed; no migration.
- R2. BatchAnchor is only for automatic checkpoint saves.
- R3. Agents sign their own saves; the contract checks every signature, live grant, area and parent.
- R4. The contract COMPUTES the Merkle root itself, from the saves it accepted. It never accepts a
  root supplied by the batcher. Therefore a valid inclusion proof means "accepted", not merely
  "submitted". No acceptance bitmap.
- R5. Rejected saves are skipped with a reason; one bad save never reverts the batch.
- R6. Duplicate protection lives in the contract (§5.3).
- R7. Envio is for discovery and counting only; it never decides validity. BatchAnchor is the
  authority for every validity question.
- R8. Batching is OFF by default (§8).
- R9. Merge only when §10 is fully satisfied, including Dami's explicit yes.

## 4. Components

| Unit | Where | Job |
|---|---|---|
| `BatchAnchor.sol` | `contracts/src/` | checks each signed save, computes the accepted-only root, stores root + lineage heads, emits one log line per accepted save |
| Leaf + tree library | `packages/protocol` | one definition of the leaf hash and the Merkle tree (build + verify), shared by batcher, SDK and tests |
| SDK batched lane | `packages/sdk/src/agent.ts` | sign a save for batching; read + verify a batched save (five checks, §7.1) |
| Store endpoints | `apps/api` | accept a signed save (returns a signed QUEUED receipt); return a save's status + proof |
| Batcher | `apps/store-worker` (new Durable Object) | collect saves, fire on 256 saves or 2 s, submit, record results |
| Daemon lane switch + job states | `apps/midad` (drain, skeleton, doctor, cli) | choose lane, keep jobs open until a terminal state, surface REJECTED |
| Indexer | `apps/indexer` | count batched saves from BatchAnchor logs (display only) |

## 5. The contract: `BatchAnchor`

### 5.1 The signed save (the leaf)
The agent signs EIP-712 typed data over: chainId, BatchAnchor address, owner, namespaceId,
contextId, parentId (zero for a new lineage), lineagePolicy, kind, provenanceSource,
manifestHash, ciphertextCommitment, readEpoch, expiresAt, objectNonce. `contextId` uses the
existing `MidaHashing.contextId` rule with the BatchAnchor address in the contract slot, so a
batched id can never collide with a ContextRegistry id.

`leafHash` = a domain-separated hash of the signed struct hash and the signature. The exact
encoding is fixed in the plan and implemented once in Solidity and once in TS, with a shared
cross-language test vector.

### 5.2 `submitBatch(batchId, SignedSave[] saves)`
For each save, in order:
1. Recover the signer; `agentId = CAPABILITY_REGISTRY.agentIdOfSigner(signer)`; zero → reject
   `BAD_SIGNER`.
2. `isRegisteredNamespace(namespaceId)` else reject `BAD_AREA`.
3. Read epoch: same `requiredReadEpoch` / `isWriteEpochValid` rule as ContextRegistry else reject
   `BAD_EPOCH`.
4. Authority, checked NOW (at the block the batch lands): new lineage → `PERM_CREATE` via
   `hasAuthority`; replacement → `PERM_SUPERSEDE_OWN` (own lineage) or `PERM_SUPERSEDE_ANY`, same
   logic as `ContextRegistry._requireSupersedeAuthority`. Fails → reject `NO_AUTHORITY`. A save
   signed before a revocation but landing after it is rejected: the revocation wins. (A signing
   time chosen by the agent is never trusted; a compromised key could backdate it.)
5. Lineage: new lineage requires `LINEAGE_STANDARD` and `head[contextId] == 0` (else
   `ALREADY_ANCHORED`); replacement requires the parent to be its lineage's current head (else
   `STALE_PARENT`) and the same owner + namespace as the parent (else `PARENT_MISMATCH`).
6. Accept: move the lineage head to `contextId`, record what step 5 needs to find a record's
   lineage (the plan picks the cheapest correct layout and records its gas), set
   `hasBatchedSaves[owner] = true` on the owner's first accepted save, append `leafHash` to the
   in-memory accepted list, emit
   `SaveAnchored(owner indexed, namespaceId indexed, contextId indexed, lineageId, batchId, position, author, leafHash)`.
   Reject: emit `SaveRejected(batchId, index, reasonCode)`; nothing stored.

Then compute the Merkle root over the accepted leaves (positions 0..k-1 in acceptance order), store
`batches[batchId] = {root, acceptedCount, submitter, blockNumber}`, emit
`BatchAnchored(batchId, root, acceptedCount, rejectedCount)`.

`batchId` already used → revert `BATCH_EXISTS` (a retried submission executes nothing). A batch
with no accepted saves is still recorded (root = zero) so its id is spent.

### 5.3 Duplicates (R6)
- A repeated new-lineage save: `head[contextId] != 0` → `ALREADY_ANCHORED`.
- A repeated replacement: its parent is no longer the head → `STALE_PARENT`.
- Required contract tests prove both, inside one batch and across batches. If either cannot pass
  with the lineage pointer alone, add an `accepted[contextId]` map and record its gas.

### 5.4 Views
`batchRoot(batchId)`, `headOf(lineageId)`, the record→lineage lookup, `hasBatchedSaves(owner)`.

## 6. Save lifecycle

States: `QUEUED` → `SUBMITTED` → `ANCHORED` (terminal success) | `REJECTED` (terminal failure,
with reason).

1. The daemon's save (drain → `saveCheckpoint`) seals the checkpoint as today, uploads the
   ciphertext, and posts the signed save to the store.
2. The store checks the signature immediately (early reject), stores the ciphertext, and returns a
   receipt signed by the store: `{contextId, leafHash, batchSequence, receivedAt}`. The receipt
   proves "the store took responsibility", NOT "Monad accepted it".
3. The agent stops waiting at QUEUED; the drain job stays OPEN and follows the save until ANCHORED
   or REJECTED. A job is never marked done at QUEUED.
4. REJECTED (any reason) becomes a `mida doctor` PROBLEM naming the save and the reason, and the
   job's log line carries the reason code. Never silent.
5. A save stuck in QUEUED/SUBMITTED past a limit (default 10 minutes) is a doctor PROBLEM too.

Batcher timer: starts when the first save enters an empty batch and is never restarted by later
saves; the batch fires at 256 saves (or the measured cap, §9) or 2 seconds, whichever first. The
Durable Object alarm runs at least once, so submission is idempotent through `batchId`.

## 7. Readers

### 7.1 The next session's handoff (`skeleton.ts:readCheckpoints` → `agent.readWithStatus`)
For a batched checkpoint the store returns ciphertext, the signed save, batchId, position and the
Merkle proof. The SDK verifies all five and refuses on any failure:
1. the ciphertext hash equals the signed `ciphertextCommitment` (and the manifest hash, as today);
2. the proof reaches `BatchAnchor.batchRoot(batchId)`, read from the chain, never from the store;
3. accepted: implied by 2 under R4;
4. the signature recovers to a signer whose `agentIdOfSigner` is the claimed author;
5. still the latest: `headOf(lineageId) == contextId` for "current" reads.
The store can hide data or be down; it cannot forge data, authorship, acceptance or freshness.

### 7.2 Duplicate-save guard (`saveCheckpoint`)
The local saved-ids list and the receipt stay as optimizations; the contract (§5.3) is the guarantee.

### 7.3 Whole-history reader (`owner-read.ts`)
Scans `SaveAnchored` logs of BatchAnchor as well as ContextRegistry's logs, and verifies each
batched save through the §7.1 checks.

### 7.4 Migrate
Before anything else, `mida migrate` asks the chain `BatchAnchor.hasBatchedSaves(owner)`. `true` →
refuse with a plain line ("this setup has batched checkpoint saves; migrate cannot move them
yet"). If the call fails (network down, unreadable), migrate STOPS with that reason; it never
assumes "none". A deployment with no BatchAnchor address skips the check, because the switch (§8)
requires that address, so batching can never have been on.

### 7.5 Unchanged
`remember.ts` facts, grants, revokes, owner keys, evidence records.

## 8. The switch: off by default, and turning it on for a customer trial

Batching is used only when ALL of these hold; otherwise every save takes today's direct path:
- the setup's `network.json` has `batching: true`;
- its deployment names a `batchAnchor` address;
- it uses the hosted store (`storageUrl` set) and that store reports batching enabled;
- the store's server-side switch `BATCHING_ENABLED` is on.

Owner commands (typed by the owner in a real terminal, like `approve`):
- `mida batching on`: checks the conditions above and names any that fail; prints what changes
  ("automatic checkpoint saves will be anchored in shared batches; grants, revokes and facts are
  unaffected"); asks `yes`; writes `batching: true`; restarts the daemon.
- `mida batching off`: writes `batching: false`; saves already QUEUED still finish (their jobs stay
  open until ANCHORED/REJECTED).
- `mida doctor` prints the lane (`ok: checkpoint saves: batched via <host>` or
  `ok: checkpoint saves: one transaction each`) plus any stuck or REJECTED saves.

Kill switch for us: `BATCHING_ENABLED=false` on the store makes it refuse new batched saves with a
named code; clients then use the direct path for new saves. A trial can be ended for everyone
without touching any customer machine.

Trial runbook (written to `docs/` on merge):
1. We deploy BatchAnchor and the store (Dami runs both) and set `BATCHING_ENABLED=true`.
2. The trial user runs `mida batching on`, answers `yes`, then `mida doctor` and checks the lane line.
3. To stop: the user runs `mida batching off`, or we flip `BATCHING_ENABLED=false`.

## 9. Testing and the benchmark

Contract (Foundry): each reject reason (bad signer, revoked mid-batch, expired grant, wrong area,
wrong read epoch, stale parent, owner-controlled lineage, parent mismatch); both duplicate kinds
(§5.3); `BATCH_EXISTS`; the stored root equals a root recomputed from accepted leaves only;
`hasBatchedSaves` set on the first accepted save; gas snapshots per case and per batch size.

SDK, against a lying store: tampered ciphertext, forged proof, a rejected save presented with a
proof, forged signature, an old version presented as the latest. Each must be refused.

Batcher: timer starts at the first save into an empty batch and is never restarted; an alarm
firing twice submits nothing twice; a crash between sending and recording resumes cleanly; the
cap is enforced.

Cross-language: one leaf/tree test vector checked in both Solidity and TS.

End to end on a local chain: switch on → QUEUED → ANCHORED → the next session reads it; revoke
while queued → REJECTED → doctor PROBLEM; migrate refuses a setup with batched saves; switch off →
direct path.

Testnet benchmark, output `docs/evidence/batch-anchor-benchmark-<date>.json`:
- cost: the same checkpoint saves one-per-transaction vs batched; gas CHARGED per save (Monad bills
  the reserved gas limit); MON and USD at a stated price and date;
- throughput: saves submitted, Monad transactions used, rejected count, queued→anchored p50/p95;
- batch cap: set from the measured maximum saves per transaction under the transaction gas limit;
- run size: sized to available testnet MON after a small first run (the deployer held 3.68 MON on
  Sep 24; faucet top-ups may be needed).
No gas multiplier or throughput number appears anywhere (spec, README, pitch, demo) unless copied
from this file.

## 10. Merge conditions (all by Oct 5 2026, else the branch stays unmerged)

1. Every test in §9 and the complete existing suite pass.
2. The benchmark evidence file exists.
3. An Opus adversarial review of the whole branch is done and its findings are fixed or explicitly
   accepted by Dami.
4. Dami's explicit yes.

On merge, Dami runs: the BatchAnchor deploy (deployer key), the store-worker deploy (new Durable
Object binding, `BATCHING_ENABLED`, a batcher wallet funded by the deployer), the indexer config
update. The default stays off.

## 11. Known limits and open questions

- The Durable Object binding is new to the store worker (today: D1 + a 15-minute cron). The plan
  confirms the Cloudflare plan supports it.
- The batcher wallet pays all batch gas; it must be funded and watched.
- A batched lineage cannot continue a ContextRegistry lineage (§2).
- Decided by Amendment B: the handoff shows anchored plus verified pending saves.

## 12. Amendment A (Sep 24, approved by Dami)

1. **Batched record id includes the parent.** `contextId = keccak256(abi.encode("MIDA_BATCH_CONTEXT_V1", chainId, batchAnchor, owner, agentId, namespaceId, parentId, objectNonce))`. With the plain rule, an agent that reuses a nonce inside one lineage could mint a later save with the same id as an earlier one. Binding the parent makes ids unique without a per-save "seen" map (~22,000 gas per save saved): a parent can have at most one accepted child, because accepting a child moves the head off the parent.
2. **One storage word per lineage (`headCommit`).** The contract stores `headCommit[lineageId] = keccak256(abi.encode(headContextId, owner, namespaceId, rootAuthor, version))` instead of record fields. A replacement save carries (and signs) `lineageId`, `parentVersion` and `rootAuthor`; the contract checks the commit. Spec §5.2 `PARENT_MISMATCH` folds into `STALE_PARENT`.
3. **Log line fields.** `SaveAnchored` indexes `owner`, `contextId`, `batchId` (not `namespaceId`), so a batch's saves can be fetched by batch id to rebuild proofs.
4. **Batched ciphertext lives in the store's batch table, not `objects`.** The `objects` sweep deletes uploads that never anchor in ContextRegistry; batched saves never do.
5. **Checkpoint shape is fixed.** Batched saves are CONTEXT records, `lineagePolicy = STANDARD`, `provenanceSource = AGENT_INFERRED` (what `saveCheckpoint` sends today); anything else is rejected `BAD_SHAPE`.

## 13. Amendment B (Sep 24, from Dami)

1. **Next-session handoff = anchored context + verified pending context.**
2. **Verified pending** = every check that does not need the anchor: ciphertext and manifest match the signed commitments; the signature recovers to a registered agent (`agentIdOfSigner != 0`) that is the claimed author; that agent holds a live CREATE grant with INFERENCE for the area, read from the chain at read time. Missing only: inclusion, acceptance, freshness.
3. **Pending is usable immediately, clearly marked `PENDING_ANCHOR`, never described as final.** The injected handoff text for such an item says "PENDING_ANCHOR: not yet anchored on Monad; may still be rejected".
4. **An explicit agent switch triggers an immediate batch flush.** When the reading agent differs from the author of any pending save in the handoff (e.g. Claude saved, Codex starts), the reader first calls the store's flush, waits up to 3 seconds for those saves to anchor, then reads. Whatever is still pending is shown marked. Flush is authenticated, skipped when the queue is empty, and limited to once per 10 seconds per signer.
5. **Blockchain = eventual canonical settlement and audit.** A pending save that is later REJECTED stops appearing in handoffs and is reported by `mida doctor` (Task 7).
