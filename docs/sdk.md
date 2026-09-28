# `@mida-context/sdk` — the agent-facing Mida SDK

The Mida SDK is how an app or agent asks a user's Mida for context. One class — `Mida` — seven
calls. Every call goes to the Mida service (midad) on this machine, which applies the grants the
user signed, so an SDK app can never see, sign or write more than the owner approved. The SDK
holds no chain keys and signs nothing itself.

```ts
import { Mida } from "@mida-context/sdk"

const mida = new Mida({ agent: "my-agent" })
```

## Install

```bash
npm i @mida-context/sdk
```

Requires Node 22+ and the `mida` CLI (package `mida-context`) on the same machine — the CLI is
what provisions agents (`mida install <client>` for the built-in coding tools, `mida add-agent
<name>` for anything else), signs grants (`mida approve <agent>`), revokes them (`mida revoke
<agent>`), and keeps midad running.

## The handle

```ts
new Mida({
  agent: "my-agent",           // a provisioned agent name — the name `mida approve` signed for
  transport: "local",          // optional; the only transport today (see Transports below)
  project: "/path/to/folder",  // optional; what counts as "this project". Default: process.cwd()
  task: "migration",           // optional; a task name handed to handoff()/whatsNew() unchanged
  home: "/path/to/.mida",      // optional; default $MIDA_HOME, else ~/.mida
})
```

`agent` must be a provisioned identity — 1–40 lowercase letters, digits or dashes. A bad name,
a bad transport or a non-absolute `home` is refused at construction with `invalid-option`,
before anything touches the service.

## The seven calls

### `status()` — is the service up, and what would this agent get?

```ts
const status = await mida.status()
// → { up: boolean, text: string, service?: {...}, agent?: { name, verdict } }
```

Always answers — it is the one call that never throws on a down service. `text` is the same two
lines the `mida_status` adapter prints: the service line, then this agent's verdict for this
folder (`approved` / `not-approved` / `revoked` / `general-assistance` / `unknown`).

### `requestAccess()` — file the request the owner completes

```ts
const request = await mida.requestAccess()
// → { requestId, nextStep: "run `mida approve my-agent` in a terminal" }
```

Files the access request where `mida approve <agent>` looks for it. Approval is the owner's
terminal step — an agent can never approve itself, and this SDK carries no approve call. On an
already-approved agent the call refuses `already-approved`.

### `context(input)` — read what the grants allow

```ts
const { items, cursor, overLimit } = await mida.context({ namespace: "projects.current", limit: 8192 })
```

`context()` is deterministic — it takes `namespace` **or** `namespaces`, a byte `limit`, an
optional ISO `since`, and a `cursor` from an earlier call. There is no `query` parameter and no
ranking by meaning: the order is the chain's, most-recently-anchored first, lineage heads only
(a superseded record never appears — its newest replacement does, with its real author).

Each `ContextItem` carries:

```ts
{
  id, namespace, kind, content,                  // content counts toward the byte limit
  author: { name, id },                          // the author the CHAIN recorded, not the payload's claim
  source,                                        // agent writes are always "AGENT_INFERRED"
  writtenAt,                                     // chain stamp; store's received stamp while pending
  state: "anchored" | "pending",
  superseded: false,                             // heads only — never "current", never a flag
  references,
  proof: { manifestHash, recordId },             // what verify() checks against
}
```

`limit` is **bytes of content** and records are never cut in half — a single record larger than
`limit` is returned alone with `overLimit: true`, never hidden and never truncated. `cursor`
non-null means more items remain; pass it back as `cursor` to continue. `partial: true` means
the store's own list was incomplete — the items shown verified, but the list may not be whole.

### `remember(input)` — write one memory

```ts
const saved = await mida.remember({ namespace: "projects.current", content: { note: "user prefers pnpm" } })
// → { id, state: "anchored" | "pending" }
```

`namespace` is required — there is no `auto` in phase 1. `content` is a string or a JSON
object. `kind` defaults to `INFERENCE`; `references` links the record to others;
`supersedes` names an earlier record **of this agent's own** lineage to replace (the
SUPERSEDE_OWN path — superseding another agent's record is refused).

Every write is recorded `AGENT_INFERRED`. The provenance is the service's to stamp, never the
caller's — asking for a `USER_*` source is refused before anything is signed. `state` is
`anchored` on the direct save lane and `pending` on the batching lane (Monad has not anchored
it yet — it still reads back and still carries its proof fields).

### `verify(item)` — check one item against the chain

```ts
const verdict = await mida.verify(item)
// → { valid, checks: [{ name, ok, detail }] }
```

Three checks, each reported by name: `commitment` (the registry record carries exactly this
manifest), `author` (the chain recorded this author), `grant-at-write` (a record exists at all —
Monad only anchors writes made under a live grant, so anchoring *is* the grant proof). A
tampered item comes back `valid: false` with the failing check named.

### `handoff()` — the session-start text

```ts
const handoff = await mida.handoff()
// → { kind: "handoff" | "empty", text }
```

The text `mida_handoff` would inject for this agent and folder, byte for byte — the checkpoint
summary a fresh agent reads to continue someone else's work. Refusals throw; they never come
back as text.

### `whatsNew()` — what changed since this agent last looked

```ts
const news = await mida.whatsNew()
// → { kind: "updates" | "none", text }
```

The same answer `mida_whats_new` gives — saves by *other* approved agents since this one's
context was last read. Each `Mida` instance is its own session (`sdk-<agent>-<hex>`): a note
already delivered to it goes quiet on the next call, while a second instance still sees the
same save as new. The seen set lives in `state/lastseen/` under the Mida home — the same
records the hooks and the MCP adapter keep.

## The product test

This is what the SDK exists to prove. Agent A works on a task while Mida saves compact
checkpoints. A is interrupted. The user opens a fresh Agent B — a different tool, a different
model — approves it, and types only "Continue." B calls `handoff()` and gets the objective, the
progress, the decisions and why, the constraints, the open issue and the next step — written by
A, attributed to A by the chain. The user revokes A live; A's `context()` call throws `revoked`
while B keeps working.

Every property that demo leans on is a contract the SDK enforces, not a convention: authorship
comes from the chain record, reads refuse `not-approved`/`revoked` instead of silently
returning empty, writes are always `AGENT_INFERRED`, and supersession means a reader sees the
newest version only — with its real author, whoever that was.

*Status: RUN on local Anvil — `packages/mida-context-sdk/test/example.e2e.test.ts` runs
`examples/sdk-basic.ts` unmodified against a real midad (approved-agent walkthrough,
unapproved-agent request path, service-down exit); `test/local.e2e.test.ts` covers the calls
end to end including live revoke; `test/conformance/` runs the transport-agnostic scenario.
`pnpm check:publish` runs and type-checks a consumer installed from the packed tarball. NOT RUN
on the live testnet.*

## What the SDK deliberately does not do

- **No `query`, no ranking by meaning.** `context()` is deterministic — namespace(s), bytes,
  order. Retrieval ranking is the application's problem, on top of this read.
- **No approve call.** An agent can request; only the owner approves, in a terminal, by name.
- **No provenance games.** `remember()` is always `AGENT_INFERRED`; items carry
  `superseded: false` and no `confidence` field.
- **No `auto` namespace.** The caller names the area the memory belongs to.
- **No key handling.** `requestAccess` and `verify` read the agent's identity files the way the
  CLI does; everything else is a socket call. The SDK never signs.
- **No `direct` transport yet.** `transport: "direct"` throws `transport-unavailable` — it
  arrives with Sign in with Mida (phase 2).

## Errors

Every failure is one `MidaSdkError` with a `code` and one plain sentence that says what did
**not** happen — no provider URL, key or raw upstream message ever appears in it.

```ts
import { isMidaSdkError } from "@mida-context/sdk"

try {
  await mida.context({ namespace: "projects.current", limit: 4096 })
} catch (error) {
  if (isMidaSdkError(error, "revoked")) { /* the owner pulled this agent's access */ }
}
```

The codes the SDK raises itself: `invalid-option` (a bad argument — nothing was sent),
`transport-unavailable` (a transport that does not exist yet), `service-unavailable` (midad is
not answering — *"run any `mida` command to start it"*), `service-refused` (the service refused
for a reason this build does not name — see `error.serviceReason`), `failed`.

Every other code is the service's refusal reason passed through verbatim, so a caller keys on
exactly what midad said: `not-approved`, `revoked`, `revoke-pending`, `already-approved`,
`not-a-project`, `folder-mismatch`, `no-identity`, `identity-unreadable`, `general-assistance`,
`read-only`, `rate-limited`, `invalid-shape`, `invalid-content`, `invalid-namespace`,
`too-large`, `not-found`, `partial-read`, `list-tampered`, `list-unreadable`, `check-failed`,
`bad-agent`, `bad-input`, `chain-busy`, `chain-misconfigured`, `rpc-auth`,
`store-misconfigured`, `store-rpc-auth`. On `rate-limited`, `error.lane` names the lane
(`"direct"` or `"batched"`).

## Limits

- **`context()` `limit`** counts bytes of item content; records are whole or absent. A record
  bigger than the budget comes back alone with `overLimit: true`.
- **`remember()` rate**: 1 accepted write per minute per agent on the direct lane, 60 per
  minute on the batching lane — enforced service-side, so two SDK clients for the same agent
  share the window. The refusal is `rate-limited` and names the lane.
- **Grants gate everything.** An agent that was never approved gets `not-approved`; a revoked
  one gets `revoked`; a general assistant gets `general-assistance` — never an empty list.
- **`task`** is accepted on the constructor and passed to `handoff()`/`whatsNew()` unchanged —
  both calls are scoped to that named task (`"main"` when none is given): the handoff continues
  that task's thread, and the what's-new note reports that task's saves in detail with other
  tasks collapsed to a summary line. `context()` is task-agnostic — it returns records from
  every task together, and each checkpoint item carries `task` naming the thread it came from.
  Core calls (`context`, `remember`) take no task.
- **Timeout**: each call fails rather than hanging — `service-unavailable`, never an exception
  the caller cannot name.
