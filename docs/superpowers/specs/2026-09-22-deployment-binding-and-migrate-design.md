# Mida — a setup keeps its contract, and `mida migrate` moves it

Date: 2026-09-22 · Status: design, approved section by section in chat; awaiting Dami's review of
this file · Nothing in this file is built yet.

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
2. `migrate` moves **everything**: owner, agents, approvals, approved folders, remembered facts and
   every session checkpoint.
3. `migrate` works **in place** in the same folder, and switches the saved contract **last**.
4. Reading old data: **option 1 now**. Read it from the local store, which is what `~/.mida` uses.
   **Option 2** (migrate before repointing the hosted store) goes into the redeploy checklist (§9).
   **Option 3** (one hosted store serving several contracts, old ones read-only) is a separate spec,
   built only if hosted setups with real data exist before the next redeploy.
5. The store and sponsor follow the same "saved choice wins" rule as the contract.
6. An outdated background service is replaced automatically.

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

Run in a real terminal, like `approve` (the same terminal check). Every step checks the new
contract before acting, so a crash and a re-run continue where it stopped. Progress lives in
`migrate/state.json` (step reached, target contract, counts). It never holds decrypted text.

**Preview, then `yes`:**
`this setup is on 0xf07d…; it will move to 0xabbd…: 1 owner, 3 agents, 5 approvals, 4 approved
folders, N facts, M checkpoints; gas paid by sponsor.midacontext.xyz`. Anything other than `yes`
stops the command with nothing changed.

**Steps:**

1. **Pause capture.** Write `migrate/in-progress` and stop this setup's service. While the marker
   exists, `inject-main`, `mcp-main` and `ensureDaemon` do not start a service. The hooks keep
   queuing to `queue/` on disk, so sessions are saved to the new contract after the switch.
2. **Back up** `network.json`, `agents/`, `approved-projects.json` and `state/` to
   `migrate/backup-<ISO date>/`. The old contract is never written to, so this backup plus the old
   contract is a complete undo.
3. **Read the old side, in memory only.** Start a local store on `~/.mida/data` for the old
   contract. Read every checkpoint through an agent holding READ on `projects.current`
   (`readCheckpoints`, skeleton.ts:525), and every fact through an agent holding READ on
   `preferences.communication` and `profile.skills` (`readOwnerFacts`, remember.ts:134). Map each
   checkpoint's on-chain author ID to an agent name with `authorNamesFor`. A re-run reads again,
   which is safe because the old side does not change.
4. **Set up the new side:**
   - owner key and context areas: `init`'s existing chain-first steps (skeleton.ts:145-159), run
     against the new contract
   - each agent: **registered fresh**, into `migrate/agents-new/<name>/`. Its on-chain ID will be
     new, because the ID is computed from the contract address and a random salt
     (AgentRegistry.sol:66, packages/protocol/src/ids.ts:21-33). `init`'s "identity file exists,
     skip" shortcut (skeleton.ts:183) is **not** used.
   - approvals: each agent gets exactly the scopes it holds live on the old contract. Mida signs the
     agent's access request itself, because the agent keys are local (skeleton.ts:383-389). The owner
     sees the same preview as `approve`.
5. **Copy the data:**
   - **Facts**, oldest first, so their relative order survives. `readOwnerFacts` orders by the
     on-chain time, which will be the migration time. Before each write, skip it if the same text is
     already in the same area on the new contract. A plain `remember` has no such check.
   - **Checkpoints**, each re-saved by the **new identity of the agent that wrote it**, with its
     original payload and original `createdAt`. Handoffs order by that field (packages/checkpoint/
     src/merge.ts:45), so order survives. `saveCheckpoint`'s existing check by event ID skips any
     already moved. A checkpoint whose writer is not set up on this machine is skipped and listed.
6. **Verify, before anything switches.** Per agent and per area: count on the new contract ≥ count
   read from the old one. Build one real handoff from the new side and compare its request and
   decisions with the old side's. Any shortfall stops the command here with the setup unchanged,
   and prints what is missing.
7. **Switch, the only step that changes how the setup behaves:**
   - move `migrate/agents-new/*` into `agents/`, replacing the old identity files, which stay in the backup
   - delete what belongs only to the old contract: `agents/*/grants.json` (rewritten by step 4),
     `pending-request.json`, `revoked.json`, `revoke-pending.json`, `requests/`,
     `state/saved-ids.json`. `approved-projects.json` stays unchanged, because its signature covers
     no contract address (projects.ts:42-47).
   - write `network.json` with the new contract, and the old one under `previous`, with `migratedAt`
   - remove `migrate/in-progress`, start the service, and print
     `moved to 0xabbd…. Undo with \`mida migrate --undo\`.`

`state/history/*` and `owner/start-block.json` check their own contract and ignore a mismatch
(skeleton.ts:290, keys.ts:158). They need no step.

**`mida migrate --undo`** restores the newest backup, stops and restarts the service, and says which
contract the setup is on now. It refuses if no backup exists.

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
`packages/chain/src/registry.ts` (`toMidaError`), `packages/sdk/src/connect.ts`. No contract changes.

## 8. How it fails, and what happens

| Situation | What happens |
|---|---|
| Passkey setup | refused: `migrate supports software-key setups only in this version` |
| Already on the target contract | `already on 0xabbd… — nothing to move` |
| Old store unreadable (e.g. `home-hosted`, whose store now serves the new contract) | says so, offers to move access only; a second `yes` is required |
| Sponsor does not serve the target contract and the wallets cannot pay | refused before step 1, naming the address to fund and the amount |
| Crash at any step | re-run continues; nothing is written twice (checked on the new contract each time) |
| Verify finds a shortfall | stops before the switch; setup unchanged; prints per-agent / per-area gaps |
| Hook fires mid-migration | queued on disk; saved to the new contract after the switch |
| A checkpoint's writer is not set up here | skipped, listed by author ID and count |
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
- **Migrate end to end** on a local chain with two deployments: handoff content, approved folders
  and fact order match before and after.
- **H1 (extended):** kill `migrate` at each step boundary, re-run, and check for zero duplicate
  facts, checkpoints or registrations. `--undo` restores a working old setup.
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

## 12. Out of scope

Passkey setups. Reading through the hosted store (option 3). Anything written to or deleted from
the old contract. Moving settings out of the contracts' deploy-time values so they can change
without a redeploy, which is a contract redesign to consider before the final freeze.

**Workaround until this ships:** run owner commands on `~/.mida` with
`MIDA_DEPLOYMENTS_DIR=~/mida-live/deployments-sep17` (holds the Sep 17 record, which matches
`network.json`).
