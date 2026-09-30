# Mida Context indexer — a public, checkable count of who uses Mida

**The problem this solves.** Monad Metropolis judges weigh traction, and the
judges define traction as *other teams building on Mida*. Saying "three teams integrated" in a
pitch is worth nothing if nobody can check it. The Monad testnet already holds the truth — every
agent registration, grant, revocation and context record is an event on our two contracts — but
verifying a claim by hand means scanning millions of blocks.

This Envio HyperIndex project does the scan once, keeps it current, and answers instantly through
a public GraphQL endpoint. A judge can paste a query and see the numbers themselves instead of
taking our word for them.

**It informs, it never decides.** No access decision anywhere in Mida may read this index.
Access is always decided by reading the chain directly. The index only *describes* what the
chain already recorded — it is a scoreboard, not a referee.

## What each number means — and what it does not mean

Everything below is derived only from public on-chain events. The chain stores commitments and
ids, never plaintext context, so the index never holds anything private.

| Number | What it counts | What it does NOT mean |
|---|---|---|
| `owners` | Distinct addresses that appeared as `owner` in any event | Not people. One team can be many addresses; one person can rotate wallets. Treat it as "distinct owner keys seen", an upper bound on teams |
| `agents` | Distinct `agentId`s ever registered | Not "agents still alive" — revoked agents stay in the count (`Agent.revokedByOwners` shows how many times an owner revoked them) |
| `operators` | Distinct addresses that registered at least one agent | Not teams either — a team may deploy several operator keys |
| `agentsByOutsideOperators` | Agents whose registering operator is **not** one of ours (`src/our-operators.ts`) | **This is the traction number.** It means "someone other than us pointed an agent at Mida". It does not prove they finished an integration — only that they registered on-chain |
| `grants` / `activeGrants` | Capability grants ever made / granted and **not revoked** | `activeGrants` does **not** subtract expired grants. The index has no clock: it stores `expiresAt` on each `Grant` and readers filter on it themselves. "Active" here means "still valid as far as the chain knows" |
| `capabilityRevocations` / `agentRevocations` | `CapabilityRevoked` events (one grant ended) / `AgentRevoked` events (every grant of that owner–agent pair ended at once) | A single `AgentRevoked` can end many grants; `activeGrants` drops by that many, not by one |
| `contextRecords` | `ContextRegistered` events with `recordType = 0` | Evidence writes emit *both* `ContextRegistered(recordType=1)` and `EvidenceRegistered`; type-1 records count in `evidenceRecords`, never here — no double counting |
| `evidenceRecords` | `EvidenceRegistered` events | — |
| `supersessions` | `ContextSuperseded` events (a record replaced by a newer version) | — |
| `lastBlock` / `lastTimestamp` | Highest block the index has processed | If this lags the chain tip, every count above is stale — check it first |

Per-entity detail: `Owner` (per-address grants/revocations/records + whether it ever registered a
P-256 passkey key), `Operator` (per-address agent count), `Agent` (operator, current signer,
manifest version, `isOutsideOperator` flag), `Grant` (owner, agent, namespace, permissions,
`expiresAt`, `grantedBlock`, `revokedBlock`/`revokedBy` once ended, `txHash`), `Revocation`,
`ContextRecord`, `Namespace`, and `TimelineEntry` — one row per owner-bearing event, the
per-owner audit trail.

## ⚠️ Our operator list — the one config value that changes the headline number

`agentsByOutsideOperators` counts agents whose registering operator is **not** one of ours. Our
operators are listed in `src/our-operators.ts`: the 8 addresses that registered agents on these
contracts before this repo went public, so all of them are ours (read from Monad on Sep 30, 2026).
The list lives in the repo because Envio Cloud's free plan has no environment variables, and
because it lets anyone check which agents we count as our own.

A new Mida home registers from a new operator address. Add that address to the file and
redeploy, or its agents count as outside. On a paid Envio plan, `ENVIO_OUR_OPERATORS` adds more
addresses to the committed list, and a local run also accepts `OUR_OPERATORS`:

```bash
ENVIO_OUR_OPERATORS=0xanotheroperator,0xyetanotheroperator
```

To recompute after changing it, re-index from `start_block` (drop the deployment's data and let
it resync — the count is derived state, not source truth).

## Run it locally

> **Not run as part of this build** — `envio dev` needs Docker (it launches Postgres + Hasura).
> These steps are verified against the docs and the installed envio 3.11.0 package, not executed.

```bash
pnpm install
pnpm --filter @mida/indexer codegen
cd apps/indexer && pnpm exec envio dev
```

`envio dev` indexes from `start_block` and serves GraphQL (default `http://localhost:8080`). It
reads Monad through the public RPC set in `config.yaml`, so it needs no `ENVIO_API_TOKEN`.

## Re-point after a contract redeploy

The contracts will be redeployed before the hackathon ends. Everything you need to change lives
in **one file**, `config.yaml`:

1. `chains[0].contracts[].address` — the two new addresses (lowercase; `address_format:
   lowercase` is set).
2. `chains[0].start_block` — the deploy block of the new contracts.
3. If the contract code changed, regenerate the ABIs: `pnpm --filter @mida/indexer export-abis`
   (reads `packages/chain/src/abis.ts`; `test/abi-freshness.test.ts` fails CI if the JSON
   drifts). Then `pnpm --filter @mida/indexer codegen`.

Nothing else hardcodes an address — handlers work purely in ids.

## Deploy to Envio's hosted service

> **Not run as part of this build** — needs the repo on GitHub and an Envio account.

1. Push this repo to GitHub.
2. On envio.dev, add an indexer from this repo. Set the root directory to `apps/indexer`, the
   config file to `config.yaml` (Envio reads it inside the root directory, so a path from the
   repo root fails with "Missing config"), and the deployment branch to `envio`. No API token
   is needed: `config.yaml` reads Monad through its public RPC, not HyperSync, which in Envio 3
   needs a token that Envio Cloud's free plan cannot hold. Envio checks a commit only when it
   arrives, so after changing these settings, push a new commit to `envio`.
3. Check that `src/our-operators.ts` lists every operator we have used (see the warning above).
4. Push the commit you want indexed to the `envio` branch. Each push to that branch starts a new
   deployment that re-indexes from `start_block`, and the free plan allows 3 deployments per
   indexer, so push there only when you mean to deploy.
5. Envio builds, indexes from `start_block`, and serves a public GraphQL endpoint — the URL a
   judge queries.

## Queries a judge can paste

Global headline numbers:

```graphql
{
  GlobalStats(where: { id: { _eq: "global" } }) {
    owners
    agents
    operators
    agentsByOutsideOperators
    grants
    activeGrants
    capabilityRevocations
    agentRevocations
    contextRecords
    evidenceRecords
    supersessions
    lastBlock
    lastTimestamp
  }
}
```

One owner's full timeline, newest first:

```graphql
{
  TimelineEntry(
    where: { owner: { _eq: "0xOWNERADDRESS" } }
    order_by: [{ block: desc }, { logIndex: desc }]
  ) {
    kind
    block
    logIndex
    timestamp
    txHash
    agentId
    namespaceId
    capabilityId
    contextId
  }
}
```

Agents registered by outside operators (the traction claim, checkable):

```graphql
{
  Agent(where: { isOutsideOperator: { _eq: true } }) {
    id
    operator
    registeredBlock
    revokedByOwners
    manifestVersion
  }
}
```

And to sanity-check `activeGrants` against expiry yourself:

```graphql
{
  Grant(where: { revokedBlock: { _is_null: true } }) {
    id
    owner
    agent
    expiresAt   # compare against now — the index does not subtract expired grants
  }
}
```

## How the handlers must be written (read before editing `src/EventHandlers.ts`)

These rules exist because each one is a silent miscount if you get it wrong:

- **Idempotency first.** Every handler writes a `ProcessedEvent` row keyed
  `${txHash}-${logIndex}` before anything else, and returns early if it exists. Indexing is
  at-least-once delivery — a reorg or restart re-sends logs, and without the marker every
  counter would drift upward on each replay.
- **Counters only move on new rows.** A second `AgentRegistered` for a known `agentId`, or a
  `CapabilityGranted` for a known `capabilityId`, records nothing new — so nothing increments.
- **Never mutate an entity returned by `context.X.get()`.** Envio runs every handler twice per
  event: a parallel *preload* pass that warms the cache (its `set()` calls are discarded), then
  the real pass. During preload, `get()` can return the actual stored object — so
  `stats.activeGrants += 1` on the returned object mutates live store state even though the
  preload's writes are thrown away. The result is counters that are wrong in ways no test of
  the real pass reveals. **Always copy first** (`{ ...fetched, field: n + 1 }`) and only reach
  the store through `set()`. Every handler in this file follows that rule; the test suite
  replays events to catch regressions.
- **`AgentRevoked` ends every grant of the pair.** The contract invalidates all of an
  (owner, agentId) pair's grants by bumping an epoch — it emits no per-grant events. The index
  keeps an `AgentGrantBook` row per pair listing its live `capabilityId`s; `AgentRevoked` walks
  that list, sets `revokedBlock`/`revokedBy: "agent"` on each still-open grant, and decrements
  `activeGrants` once **per grant**, not once per event.
- **A double-revoke is a no-op for counts.** `CapabilityRevoked` on an already-revoked grant
  still writes its `Revocation`/`TimelineEntry` rows (the event happened — the log must show
  it) but must not decrement `activeGrants` again.
- **Lowercase everything.** Addresses and ids are stored lowercase so `where` filters match
  regardless of input casing (`address_format: lowercase` in config.yaml does the same for
  emitted addresses).
- **The index has no clock.** Never write logic that treats `expiresAt < now` as revoked —
  there is no `now` in an indexer. Store `expiresAt`; let the reader filter.

## Tests

```bash
pnpm exec vitest run apps/indexer --testTimeout 20000 --teardownTimeout 5000
```

21 tests, fully offline — envio's `createTestIndexer()` loads the real `config.yaml`,
`schema.graphql` and handlers against an in-memory store, and the suite feeds it synthetic
events. Covered: each event produces the right rows; replayed events move no counters;
`AgentRevoked` drops `activeGrants` by three when three grants were open; outside vs own
operators; timeline ordering for two events in one block; and ABI freshness against
`packages/chain/src/abis.ts`.

## Layout

```
config.yaml          networks, contracts, events, start_block — the ONLY place addresses live
schema.graphql       the entities above
src/EventHandlers.ts all event handlers
abi/*.json           generated — `pnpm --filter @mida/indexer export-abis`
scripts/export-abis.mjs   writes abi/*.json from packages/chain/src/abis.ts
.envio/types.d.ts    committed codegen types so the root `pnpm typecheck` works offline
test/                vitest suite (no network, no Docker)
```

envio version pinned: **3.11.0** (published 2026-09-08).
