# Mida — a setup keeps its contract, and `mida migrate` moves it

Date: 2026-09-22 · Status: design, approved section by section in chat; revised the same day after
review (manifest, prepare → commit → verify, sealed envelope; decisions 7-8) · awaiting Dami's
final review · Nothing in this file is built yet.

Fixes issue-register rows **CHAIN-07, 08, 09, 10, 11** (`docs/issue-register.md` §1E). Adds
benchmark checks **E6** and **H6** (§3 of that file).

**Where to look:** §1 is what went wrong on Sep 22 and why it will happen again. §3 is the one rule
that fixes most of it. §5 is `mida migrate`, step by step. §8 is every way it fails. §11 lists what
is not proven yet.

---

## 1. The problem

A Mida setup (a "home" folder, `~/.mida` by default) is tied to one copy of the Mida contracts on
Monad testnet. The contracts cannot be upgraded in place. When something baked into them has to
change, a fresh copy is deployed at a new address. That happened on Sep 22 (`e3fe607`): the
passkey website address `midacontext.xyz` is fixed at deploy time, so moving off the placeholder
`vault.mida.xyz` meant a new contract, `0xabbd…`, replacing `0xf07d…`.

Every setup made before that day still lives on `0xf07d…`. Its approvals, facts and checkpoints
are all there. Nothing moved them. And Mida's parts disagree about which contract a setup uses:

| Part | Where it gets the contract | What it said on Sep 22 about `~/.mida` |
|---|---|---|
| background service, drainer, hooks, `doctor` | the setup's saved `network.json` → `0xf07d…` | "claude-code approved" (true: 3 live approvals) |
| `mida approve` / `revoke` / `init` / `remember` | the code's built-in newest record → `0xabbd…` | "no pending request — run `mida request` first" (true there: 0 approvals) |
| `mida request` / `read` | whatever the running service loaded at startup | `refused: ERROR` |

Each answer was true for its own contract. None named the contract, so the owner had no way to
tell which to believe. That is the bug class the register is built around: nothing crashed, every
test passed, and the messages pointed the wrong way.

Four more things turned up while tracing it:

- **The store has the same split (CHAIN-11).** `~/.mida` saved no store address. The background
  service reads that as "use the local store on disk" (`~/.mida/data`, 16 objects). The `mida`
  command and `doctor` read it as "use the hosted store". `doctor` reported
  `store: store.midacontext.xyz (default)` while every checkpoint was on disk.
- **Re-running `init` overwrites the saved contract (CHAIN-08)** with the built-in one, without
  checking. The setup's data stays on the old contract and silently drops out of view.
- **`request` hid its error (CHAIN-09).** An unrecognised chain error has no code, and agent
  commands have no `MIDA_DEBUG` path.
- **The service for `~/.mida` ran stale code (CHAIN-10)**: from the old `~/Desktop/mida-context`
  checkout since Sep 21, while the command ran from `mida-context-live`. Nothing compares them.

**It will happen again.** Making the contracts "immutable" does not prevent it. They already are,
and that is why a settings change needs a new address. Any future fix to the contracts means a new
address and the same old-setup/new-contract situation.

## 2. Decisions (Dami, Sep 22)

1. A setup keeps the contract it was made on. The code's newest contract is used only for a brand
   new setup. Moving is deliberate, through `mida migrate`.
2. `migrate` moves **everything**: owner, agents, approvals, approved folders, and every record the
   owner has on the old contract, in every context area, with its version history and links. Not a
   fixed list of areas (§5.1).
3. `migrate` works **in place** in the same folder, and switches the saved contract **last**.
4. Reading old data: **option 1 now**. Read it from the local store, which is what `~/.mida` uses.
   **Option 2** (migrate before repointing the hosted store) goes into the redeploy checklist (§9).
   **Option 3** (one hosted store serving several contracts, old ones read-only) is a separate spec,
   built only if hosted setups with real data exist before the next redeploy.
5. The store and sponsor follow the same "saved choice wins" rule as the contract.
6. An outdated background service is replaced automatically.
7. **Migration is transport, not a new event. LOCKED (Dami, Sep 22).** Migration metadata is
   orthogonal to semantic provenance. A migrated `USER_ASSERTED` record stays `USER_ASSERTED`; no
   record is relabelled `IMPORTED`. A **sealed migration envelope** inside the encrypted record
   carries an envelope `version`, the original contract, record ID, on-chain commitment, author and
   `createdAt`, and `migratedAt` (§5.3). Readers render the original author and time plus "moved on
   [date]". **No public per-record migration receipts in v0.** Accepted limit: only a reader who can
   decrypt the record sees that it is a copy.
8. **The migration is driven by a manifest of every source record, and every write is prepare →
   commit → verify** (review, Sep 22; §5.1-5.2). Verification is per record, never by counts.

## 3. One rule for which contract and services a setup uses (CHAIN-07, 08, 11)

One function, `resolveNetwork(home, env)`, in `apps/midad/src/network.ts`. Every entry point calls
it: the `mida` command (all commands), `daemon-main`, `drain-main`, `doctor`, and the SDK's
`connectAgent` (packages/sdk/src/connect.ts:283-289, which already prefers `network.json`). The
copies of this logic in `daemon-main.ts:16`, `drain-main.ts:20-34`, `doctor.ts:92-100` and
`doctor.ts:165-175` are deleted.

The rule:

1. **The setup has a saved `network.json`: use its contract.** The built-in record is ignored.
2. **No saved `network.json`** (a brand-new setup): use the built-in newest record, or the folder in
   `MIDA_DEPLOYMENTS_DIR` if set.
3. **`MIDA_DEPLOYMENTS_DIR` names a different contract than the saved one:** refuse and name both
   addresses. Never silently pick.
4. **The built-in newest contract differs from the saved one:** run on the saved contract, and have
   every owner command and `doctor` print one line:
   `this setup is on contract 0xf07d…; this version of Mida ships 0xabbd… — run \`mida migrate\` to move`.
5. **Store and sponsor:** the saved value wins. **No store saved means the local store**, everywhere,
   because that is what the service already does and where the data is. `MIDA_STORAGE_URL` /
   `MIDA_SPONSOR_URL` may still override one command. `doctor` reports the store the service
   actually uses, and says where the value came from.
6. **`init` on an existing setup never rewrites the contract.** If the saved contract differs from
   the built-in one, `init` refuses and points to `mida migrate`. Only `migrate` may change it.

The RPC address and the funder key still come from the environment. They do not decide which
contract, and they are not stored.

## 4. `request` names its failure (CHAIN-09)

1. `toMidaError` (packages/chain/src/registry.ts:59-63) wraps any chain error it cannot decode as
   `MidaError("CHAIN_CALL_FAILED")`, keeping the original as `cause`. A known revert keeps its
   current code.
2. `CHAIN_CALL_FAILED` prints: `the chain call failed — this setup's contract is 0xf07d…; run with
   MIDA_DEBUG=1 to see why`. Both refusal paths (`runCliWithRuntime` and `ownerRefusalLine` in
   cli.ts) get the line.
3. The `MIDA_DEBUG=1` detail line moves into one helper, `debugLine(error)`, used by both paths: the
   error's name and first lines, hex of 40+ characters masked as `<hex>`, at most 6 lines and 900
   characters. For agent commands the CLI sends `debug: true` in the `/cli` body and the service
   returns the line with the others.
4. Unchanged: normal output never echoes a deeper error message, and logs keep the code only (H5).
5. After this, `refused: ERROR` cannot be printed. A test asserts no path produces it.

## 5. `mida migrate` (software-key setups)

Run in a real terminal, like `approve` (the same terminal check). Revised after review (Sep 22):
the plan is built on a **manifest** of every source record, and every write follows
**prepare → commit → verify**.

### 5.1 Two rules every step obeys

**Schema-independent.** `migrate` never lists context areas in code. It enumerates every record the
owner has on the old contract from the chain's own log: `ContextRegistered`, `ContextSuperseded` and
`EvidenceRegistered`, all indexed by owner (ContextRegistry.sol:88-96), scanned from the owner's
first block (`owner/start-block.json`, as CHAIN-01's fix does). An area added next year migrates with
no code change.

**Prepare → commit → verify, for every external write.** Every ID Mida creates on chain comes from a
random value: an agent's salt (packages/fake-vault/src/agents.ts:59), a record's nonce
(packages/sdk/src/agent.ts:485). If that value is created and sent in one go, a crash after sending
and before recording leaves an orphan, and the re-run creates a second one. So:

1. **Prepare**: generate the random value (and, for an agent, its keys), compute the ID it will
   produce (packages/protocol/src/ids.ts:21-55), and write both to `migrate/state.json` before
   anything is sent. Secret parts go in 0600 files (check D6).
2. **Commit**: send exactly the prepared value.
3. **Verify**: read the new contract and confirm the prepared ID exists. Only then mark the item done.

A re-run finds the prepared value, checks whether its ID is already on chain, and either marks it
done or sends it. It never generates a new one for an item that already has a prepared value. This
needs one SDK change: `provisionAgent`, `MidaAgent#write` and the owner write path accept a
caller-supplied salt or nonce (optional; default behaviour unchanged).

### 5.2 The manifest

Built in step 3 and kept in `migrate/state.json`. It is the correctness condition, not a diagnostic.
It holds no plaintext. One entry per source record:

| Field | Meaning |
|---|---|
| `sourceId` | the record's ID on the old contract |
| `sourceCommitment` | the record's on-chain `manifestHash` on the old contract |
| `namespace`, `authorId`, `authorName` | where it lives and who wrote it (name from `authorNamesFor`; the owner for facts) |
| `provenanceSource` | its on-chain label, copied unchanged |
| `createdAt` | original time: the payload's own for checkpoints, the on-chain record's for facts |
| `lineageId`, `version`, `parentId` | its place in a version history (`ContextSuperseded`) |
| `relations` | the other records it points at (`supports` / `derived_from` / `confirmed_from`) |
| `fingerprint` | HMAC-SHA256 of the decrypted, canonical payload, keyed by a random per-migration key kept in the 0600 state file (a plain hash of a short fact could be guessed) |
| `preparedNonce`, `targetId` | from 5.1, filled in step 5 |
| `status` | `pending` / `sent` / `verified` / `skipped:<reason>` |

The source contract has no content address that survives the move: IDs are nonce-based and
contract-bound (ids.ts:35-55), and re-encryption produces new ciphertext. So the fingerprint is
computed by `migrate` from the decrypted content, on both sides.

### 5.3 The migration envelope

Every migrated record carries, inside its encrypted payload, next to the original content:

```
migration:
  version: 1
  originalChainId: 10143
  originalContract: 0xf07d…            # the old ContextRegistry
  originalRecordId: 0x…                # sourceId
  originalCommitment: 0x…              # the old record's on-chain manifestHash
  originalAuthor: 0x…                  # old on-chain author ID (agent ID, or the owner marker)
  originalCreatedAt: 2026-09-18T…      # as in the manifest
  migratedAt: 2026-09-25T…
```

The on-chain provenance label is the original one (decision 7). Readers that show provenance
(handoff, `read`, the MCP `read` tool) print "(moved <date>)" after the original attribution.

**What `originalCommitment` lets Mida check.** Anyone who can decrypt the migrated record can read
`originalRecordId` from the old contract and confirm its on-chain commitment equals
`originalCommitment`. That proves the claimed source exists and was committed exactly so. It holds as
long as the old contract is readable. It does **not** by itself prove the migrated content equals the
source content. That second check needs the old ciphertext, and it runs once, in step 6, while the
local store still has it.

### 5.4 Steps

**Preview, then `yes`:**
`this setup is on 0xf07d…; it will move to 0xabbd…: 1 owner, 3 agents, 5 approvals, 4 approved
folders, N records in K areas (F facts, C checkpoints, V superseded versions, E evidence records);
gas paid by sponsor.midacontext.xyz`. Counts come from the manifest. Anything but `yes` stops with
nothing changed.

1. **Pause capture.** Write `migrate/in-progress` and stop this setup's service. While the marker
   exists, `inject-main`, `mcp-main` and `ensureDaemon` do not start a service. Hooks keep queuing to
   `queue/` on disk; those sessions save to the new contract after the switch.
2. **Back up** `network.json`, `agents/`, `approved-projects.json` and `state/` to
   `migrate/backup-<ISO date>/`. The old contract is never written to, so backup + old contract is a
   complete undo.
3. **Build the manifest from the old side.** Start a local store on `~/.mida/data` for the old
   contract. Enumerate every record (5.1). Decrypt each with the owner's keys (see §11: to be proven
   for areas no local agent reads). Fill every manifest field. Plaintext stays in memory. A re-run
   rebuilds the source half the same way, because the old side does not change, and keeps the
   prepared/target half already on disk.
4. **Set up the new side, prepare → commit → verify:**
   - owner key and context areas: `init`'s chain-first steps (skeleton.ts:145-159) against the new
     contract, for **every area that has a record in the manifest**, not a fixed list
   - each agent: prepared identity (keys + salt + computed agent ID) persisted, then registered,
     then confirmed. `init`'s "identity file exists, skip" shortcut (skeleton.ts:183) is not used.
     The mapping `oldAgentId → newAgentId` goes into the manifest.
   - approvals: each agent gets exactly the scopes it holds live on the old contract, via an access
     request Mida signs with the prepared agent key (skeleton.ts:383-389). The owner sees `approve`'s
     preview, one `yes` per agent.
5. **Copy every record, in dependency order**: roots before their superseding versions (by
   `version`), and any record before the records that point at it. For each: prepare nonce and target
   ID → write the original payload plus envelope (5.3), under the original provenance label, by the
   new identity of its original author (the owner for owner-authored records), with its `relations`
   rewritten old ID → new ID from the manifest → verify on chain. Supersedes are replayed as
   supersedes of the new root, so each version history keeps its shape. A record whose author is not
   set up on this machine is `skipped:unknown-author` and listed. **No "same text already exists"
   check**: identity is the manifest entry, never text.
6. **Verify every entry, before anything switches.** For each manifest entry that is not skipped:
   the target record exists on the new contract; decrypting it gives the same fingerprint; its label,
   namespace, author mapping, version position and rewritten relations match; its envelope names the
   right source, and `originalCommitment` equals the old contract's on-chain value for
   `originalRecordId`. Also: no record exists on the new contract under this owner that the manifest
   does not account for. Counts are printed as a summary only. Any mismatch stops here with the setup
   unchanged and lists each failing `sourceId`. A final handoff built from the new side is compared
   with the old one as a smoke test, not as the proof.
7. **Switch, the only step that changes how the setup behaves:**
   - move the prepared agent identities into `agents/` (old ones stay in the backup)
   - delete what belongs only to the old contract: `agents/*/grants.json` (rewritten by step 4),
     `pending-request.json`, `revoked.json`, `revoke-pending.json`, `requests/`,
     `state/saved-ids.json`. `approved-projects.json` stays unchanged: its signature covers no
     contract address (projects.ts:42-47).
   - write `network.json` with the new contract, the old one under `previous`, plus `migratedAt`
     and the path of the kept manifest (`migrate/manifest-<date>.json`, fingerprints and IDs only)
   - remove `migrate/in-progress`, start the service, print
     `moved N records to 0xabbd…. Undo with \`mida migrate --undo\`.`

`state/history/*` and `owner/start-block.json` check their own contract and ignore a mismatch
(skeleton.ts:290, keys.ts:158). They need no step.

**`mida migrate --undo`** restores the newest backup, restarts the service, and says which contract
the setup is on. It refuses if no backup exists. Records already written to the new contract stay
there, unused; a later `migrate` reuses them through the kept manifest instead of writing them again.

## 6. An outdated background service is replaced (CHAIN-10)

1. `/health` (daemon.ts:234) adds `codeRoot` (the absolute folder the service's code runs from) and
   `codeCommit` (that folder's `git rev-parse HEAD` at startup, or `"unknown"`).
2. `ensureDaemon` compares them with the command's own before every use.
3. On a mismatch: `POST /shutdown` (new; the service finishes its current save and exits; the queue
   is on disk), wait up to 10 s, start a fresh service from the command's code, then run the
   command. Print: `restarted the Mida service (it was running code from <root> @ <commit>)`.
4. The old service does not exit in 10 s: refuse, naming both folders, the process ID and how to stop it.
5. `doctor`: `midad runs <root> @ <commit>; this command runs the same` (or the mismatch).

Limit: uncommitted edits in the same folder count as the same code. The npm package will carry a
version number instead.

## 7. Files touched

New: `apps/midad/src/network.ts` (`resolveNetwork`), `apps/midad/src/migrate.ts`,
`apps/midad/src/debug-line.ts`. Changed: `cli.ts` (network resolution, `migrate` command, debug
path, mismatch line), `daemon-main.ts`, `drain-main.ts`, `doctor.ts`, `daemon.ts` (`/health`
fields, `/shutdown`, `debug` in `/cli`), `control.ts` (`ensureDaemon` comparison, `migrating`
marker), `inject-main.ts`, `mcp-main.ts`, `skeleton.ts` (`init` refusal), `testnet.ts`,
`packages/chain/src/registry.ts` (`toMidaError`), `packages/sdk/src/connect.ts`,
`packages/sdk/src/agent.ts` and `packages/fake-vault/src/agents.ts` (optional caller-supplied nonce /
salt, §5.1), the owner write path used by `remember`, the checkpoint and fact payload readers
(`packages/checkpoint`, `handoff.ts`, `remember.ts`, MCP `read`) to carry and render the envelope.
New: `apps/midad/src/migrate-manifest.ts` (enumeration, fingerprints, dependency order).
No contract changes.

## 8. How it fails, and what happens

| Situation | What happens |
|---|---|
| Passkey setup | refused: `migrate supports software-key setups only in this version` |
| Already on the target contract | `already on 0xabbd… — nothing to move` |
| Old store unreadable (e.g. `home-hosted`, whose store now serves the new contract) | says so, offers to move access only; a second `yes` is required |
| Sponsor does not serve the target contract and the wallets cannot pay | refused before step 1, naming the address to fund and the amount |
| Crash after a transaction is sent but before it is recorded | the prepared salt / nonce is already on disk; the re-run computes its ID, finds it on chain, marks it done. No orphan agent, no duplicate record |
| Crash before anything is prepared | the re-run prepares fresh values; nothing was sent, so nothing is orphaned |
| Verify finds any entry wrong (missing, wrong fingerprint, wrong label, wrong relation, wrong envelope, commitment mismatch) or an unaccounted record on the new contract | stops before the switch; setup unchanged; lists each failing `sourceId` and why |
| Hook fires mid-migration | queued on disk; saved to the new contract after the switch |
| A record's author is not set up here | `skipped:unknown-author`, listed by author ID and count; the preview shows it before `yes` |
| A record points at a record that was skipped | it is skipped too (`skipped:dangling-relation`), and listed; never written with a broken link |
| An area on the old contract has no owner key to decrypt it | stops at step 3 before anything is written, naming the area |
| `--undo` with no backup | refused |
| Old service will not stop | refused before step 2, naming the process |

## 9. Redeploy checklist (option 2), to go in `docs/quickstart.md`

1. Deploy the new contracts. Record the old deployment under `docs/evidence/` as done on Sep 22.
2. Before repointing the hosted store or sponsor, run `mida migrate` on every setup whose data
   lives behind them.
3. Then repoint the store and sponsor.
4. Run `doctor` on every setup: each must name the new contract.

## 10. Testing

- **E6 (new):** a setup made on deployment X, with code whose built-in record is Y. Every entry point
  reads X or refuses naming both. Re-running `init` leaves `network.json` byte-identical. With no
  store saved, service, command and `doctor` all name the local store.
- **H5 (extended):** an undecodable chain error comes out as `CHAIN_CALL_FAILED`. No path prints
  `refused: ERROR`. `MIDA_DEBUG=1 mida request` prints exactly one masked `debug:` line.
- **H6 (new):** service started from folder A, command run from folder B. The service is replaced
  before the command runs. Queue job count is unchanged.
- **Migrate end to end** on a local chain with two deployments, with a source seeded to include: a
  fact in an area `remember` does not use today, a superseded version history (v1→v3), a record with
  a `derived_from` link, two facts with identical text, and a record by an agent not set up locally.
  Pass = every non-skipped manifest entry verifies individually; the identical-text facts both
  arrive; versions and links keep their shape; handoff content, approved folders and fact order
  match; readers print "moved on [date]" and the original author and time.
- **Verification catches substitution:** tamper the destination (drop one record and add an
  unrelated one, keeping the count equal; or add extras so the count exceeds the source). Step 6
  must fail and name the missing `sourceId`.
- **Envelope check:** for every migrated record, `originalCommitment` equals the old contract's
  on-chain commitment for `originalRecordId`; a forged envelope fails.
- **H1 (extended):** kill `migrate` between prepare and commit, and between commit and verify, for an
  agent registration, a fact and a checkpoint. Re-run. Zero orphan agents, zero duplicate records.
  `--undo` restores a working old setup.
- **Testnet (T):** one real run on a **copy** of `~/.mida` (`cp -R` to a new `MIDA_HOME`) before the
  real one.

## 11. Not proven yet

- The hosted store's database may still hold the old objects (unverified). Only option 3 needs it.
- `saveCheckpoint` accepting a payload with an old `createdAt` and passing the store's checks
  (clock-skew limits, if any) has not been run. First thing the plan tests.
- The sponsor accepting operations from freshly registered agent accounts on the new contract is
  assumed from its policy (sponsor-worker/src/policy.ts:431), not run.
- Whether `approve`'s preview can take several agents in one confirmation, or needs one `yes` per
  agent, is a plan-time choice. One per agent is the safe default.
- **The owner can decrypt every area it owns**, including areas no local agent reads. Believed from
  how areas are initialised (the owner creates each area's key), not checked. If false, step 3 needs
  a different read path. Second thing the plan tests.
- **The checkpoint schema accepts the envelope.** `packages/checkpoint/src/schema.ts` validates
  fields strictly (schema.ts:109). The envelope may need to sit beside the checkpoint in the sealed
  object rather than inside it. Plan-time choice; either way it is inside the ciphertext.
- **Enumerating by owner from the log** is assumed to return every record, including evidence
  records and supersedes. The event shapes are read (ContextRegistry.sol:88-96); a full owner
  enumeration has not been run. Its cost grows with the owner's age (CHAIN-03).
- **Caller-supplied nonce and salt** change two SDK signatures. Other callers keep the random
  default; no protocol or contract change is needed, because the IDs are already computed from these
  values (ids.ts:21-55).

## 12. Out of scope

Passkey setups. Reading through the hosted store (option 3). Anything written to or deleted from
the old contract. Moving settings out of the contracts' deploy-time values so they can change
without a redeploy, which is a contract redesign to consider before the final freeze.

**Workaround until this ships:** run owner commands on `~/.mida` with
`MIDA_DEPLOYMENTS_DIR=~/mida-live/deployments-sep17` (holds the Sep 17 record, which matches
`network.json`).
