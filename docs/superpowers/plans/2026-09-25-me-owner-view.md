# `/me` Owner View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo the implementer is **Devin CLI** (one brief per task in `.devin/briefs/`), Claude verifies each task, and ONE Opus subagent reviews the batch.

**Goal:** Ship `app.midacontext.xyz/me`: sign in with the passkey, see every agent and its grants, recent records with who wrote them and how they reached Monad, and revoke an agent with the passkey — every figure naming its source.

**Architecture:** A new page in the existing owner-page Cloudflare Worker (plain HTML/CSS + one esbuild IIFE bundle, strict CSP). Pure decision logic lives in `src/me/model.ts` (fully unit-tested); data gathering in `src/me/sources.ts` (Envio GraphQL first, chain logs + the encrypted store as fallback, every row re-verified on chain); sign-in/decrypt in `src/me/session.ts`; rendering in `src/me/page.ts` (textContent only); revoke in `src/me/revoke.ts` reusing `prepareRevoke`/`confirmRevoke`. The indexer gains a per-save `BatchedSave` entity and `ContextRecord.provenanceSource`.

**Tech Stack:** TypeScript, esbuild (IIFE), Cloudflare Workers static assets, Vitest, viem, Envio HyperIndex 3.11.0, Mera (`@category-labs/mera`) passkey PRF.

**Spec:** `docs/superpowers/specs/2026-09-25-me-owner-view-design.md` (revision 1, approved Sep 25). **Mockup:** `docs/design/me-mockup/` (approved Sep 25). Executors read both.

## Global Constraints

- Branch `me-owner-view`, cut by Claude from `p0-m0-skeleton` AFTER the clients branch merges, with branch `owner-home` (`bbaa972`, the home page) merged in first. Devin never cuts or merges branches.
- No contract change. Do not edit `contracts/src/**` or `contracts/deployments/**`.
- CSP stays `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://testnet-rpc.monad.xyz https://store.midacontext.xyz https://sponsor.midacontext.xyz` plus exactly ONE new origin: `https://indexer.dev.hyperindex.xyz`. No inline scripts or styles, no other origins.
- Rendering: `textContent` only — never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`. A transaction link is built only from a value matching `/^0x[0-9a-f]{64}$/`.
- Secrets: derive namespace secrets right after sign-in, then `release()` the owner seed; keep only `evmKey` for signing store reads; on `pagehide`, sign-out, or the tab hidden > 5 min release everything and remove decrypted text from the page. Nothing written to storage except the owner address.
- Chip mapping: Read = `PERMISSION.READ` (1), Write = `CREATE` (2), Update own = `SUPERSEDE_OWN` (4); a fourth chip "Update any" only when `SUPERSEDE_ANY` (8) is held.
- Provenance: `USER_ASSERTED` (1) / `USER_CONFIRMED` (2) → "You said"; `AGENT_INFERRED` (3) → "<agent> inferred"; a pending batched row → "<agent> claimed"; anything else → "Source unknown".
- Disclosure strings, verbatim: `This stops future reads through Mida. It does not erase what <agent> already read.` and `Revoking stops future reads. It cannot recall what an agent already read.`
- Every figure names its source; a row that could not be verified says so ("not on Monad — unverified", "list incomplete — the store ran out of chain reads; reload", "blocked at the store · revoke pending on Monad"). Never an empty page when a source fails.
- Build/test commands: `pnpm typecheck`; `pnpm exec vitest run <file> --testTimeout 600000 --teardownTimeout 5000`; `pnpm --filter @mida/indexer codegen` after any `schema.graphql` / `config.yaml` change.

## Review Focus

1. **Revoke must keep the other agents reading:** revoking one agent rotates the area key; every other agent verified with live READ must get the new key (`publishReaderWraps`) — pinned in Task 6.
2. **Batched records are records:** a row from `listBatchSaves` is never checked against ContextRegistry and never shown as "not on Monad" when its batch is anchored — pinned in Task 3.
3. **A short list is not a complete list:** `partial: true` from either store list shows the incomplete banner and hides counts — pinned in Tasks 3 and 5.
4. **Untrusted text stays text:** an agent name or record body containing HTML renders literally — pinned in Task 5.
5. **The index is not the authority:** a grant the index calls live but the chain calls invalid shows as the chain says, flagged — pinned in Task 3.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/indexer/config.yaml`, `schema.graphql`, `src/EventHandlers.ts`, `test/batch-anchor.test.ts`, `test/handlers.test.ts` | Task 1: BatchAnchor address, `BatchedSave`, `provenanceSource` |
| `apps/owner-page/src/me/model.ts` + `test/me-model.test.ts` | Task 2: pure decisions (chips, badges, row state, lag, readers, links) |
| `apps/owner-page/src/me/sources.ts` + `test/me-sources.test.ts` | Task 3: gather + verify (index, chain, store) behind injectable ports |
| `apps/owner-page/src/me/session.ts` + `test/me-session.test.ts` | Task 4: passkey sign-in, key derivation, decrypt, release |
| `apps/owner-page/public/me.html`, `public/me.css`, `src/me/page.ts`, `src/worker.ts`, `src/headers.ts`, `scripts/build.mjs`, tests | Task 5: the page, route, CSP, bundle, config endpoint |
| `apps/owner-page/src/me/revoke.ts` + `test/me-revoke.test.ts` | Task 6: revoke without a terminal link |
| `apps/owner-page/src/worker.ts` (scheduled), `wrangler.toml`, `docs/me-owner-view.md` | Task 7: index keep-alive + operator doc |

---

### Task 1: Indexer — real BatchAnchor, per-save rows, provenance

**Files:** Modify `apps/indexer/config.yaml:67-69`, `apps/indexer/schema.graphql`, `apps/indexer/src/EventHandlers.ts:453-498` and the `SaveAnchored` handler (~`:574-588`); Test `apps/indexer/test/batch-anchor.test.ts`, `apps/indexer/test/handlers.test.ts`.

**Interfaces — Produces:** GraphQL entity `BatchedSave { id (=contextId), owner, namespaceId, batchId, position, lineageId, version, agentId, block, txHash }`; field `ContextRecord.provenanceSource: Int!`.

- [ ] **Step 1: Failing tests.** In `test/batch-anchor.test.ts` add (uses the file's existing `saveAnchored`, `run`, `newIndexer` helpers):

```ts
it("writes one BatchedSave per anchored save, keyed by contextId", async () => {
  const indexer = newIndexer()
  await run(indexer, [saveAnchored({ tx: 1, block: B, contextId: bytes32(0x5001) }), saveAnchored({ tx: 1, block: B, logIndex: 1, contextId: bytes32(0x5002) })])
  const row = await indexer.BatchedSave.get(bytes32(0x5001))
  expect(row).toMatchObject({ owner: OWNER, batchId: BATCH, namespaceId: bytes32(0x5001), agentId: bytes32(0x4001), position: 0, version: 1, block: B, txHash: txHash(1) })
  expect(await indexer.BatchedSave.get(bytes32(0x5002))).toBeDefined()
})
it("a replayed SaveAnchored does not duplicate or overwrite the BatchedSave", async () => {
  const indexer = newIndexer()
  const e = saveAnchored({ tx: 1, block: B })
  await run(indexer, [e, e])
  expect((await indexer.Owner.get(OWNER))?.batchedSaves).toBe(1)
})
```

  In `test/handlers.test.ts`, add a `ContextRegistered` case whose record has `provenanceSource: 1n` and assert `ContextRecord.provenanceSource === 1`. (Match the file's existing fixture helper; `test/helpers.ts:97` already carries `provenanceSource: 0n`.)

- [ ] **Step 2: Run, expect FAIL** (`BatchedSave` undefined / field missing): `pnpm exec vitest run apps/indexer/test/batch-anchor.test.ts apps/indexer/test/handlers.test.ts --testTimeout 600000 --teardownTimeout 5000`.
- [ ] **Step 3: Implement.**
  - `config.yaml`: BatchAnchor `address: "0xe5dcf76b1109906a16587cd2fe02c1e6f4a7a9e1"`; if the contract entry has its own start block use `65373247` (the deployment file's `batchAnchorBlock`), otherwise leave the network `start_block` as is. Keep the comment style; delete "set on merge".
  - `schema.graphql`: add
    ```graphql
    type BatchedSave {
      id: ID!
      owner: String! @index
      namespaceId: String!
      batchId: String!
      position: Int!
      lineageId: String!
      version: Int!
      agentId: String!
      block: Int!
      txHash: String!
    }
    ```
    and `provenanceSource: Int!` on `ContextRecord`.
  - `EventHandlers.ts` ContextRegistered: add `provenanceSource: Number(record.provenanceSource),` to the `ContextRecord.set({...})` object.
  - SaveAnchored handler, after the `ensureOwner` line and before the counters (never mutate an entity returned by `get()` — README §"edit safely"):
    ```ts
    const contextId = lc(event.params.contextId)
    if (!(await context.BatchedSave.get(contextId))) {
      context.BatchedSave.set({
        id: contextId,
        owner,
        namespaceId: lc(event.params.namespaceId),
        batchId: lc(event.params.batchId),
        position: Number(event.params.position),
        lineageId: lc(event.params.lineageId),
        version: Number(event.params.version),
        agentId: lc(event.params.author),
        block: event.block.number,
        txHash: lc(event.transaction.hash),
      })
    }
    ```
    Do NOT add a per-save entity for `SaveRejected` — it carries only `(batchId, index, reason)` (`contracts/src/BatchAnchor.sol:71`).
  - `pnpm --filter @mida/indexer codegen`, commit the regenerated `.envio/types.d.ts`.
- [ ] **Step 4: Run, expect PASS** (same command) and `pnpm exec vitest run apps/indexer --testTimeout 600000 --teardownTimeout 5000` all green.
- [ ] **Step 5: Commit** `feat(indexer): BatchedSave per anchored save, ContextRecord.provenanceSource, real BatchAnchor address` (explicit paths).

---

### Task 2: Pure model — what each row says

**Files:** Create `apps/owner-page/src/me/model.ts`, `apps/owner-page/test/me-model.test.ts`.

**Interfaces — Produces** (used by Tasks 3, 5, 6):

```ts
export type Hex = `0x${string}`
export interface Chips { read: boolean; write: boolean; updateOwn: boolean; updateAny: boolean }
export type Lane = "direct" | "batched"
export type AnchorState = "anchored" | "pending" | "unverified"
export type Badge = { kind: "you" | "agent" | "claimed" | "unknown"; text: string }
export function chipsFor(permissions: number): Chips
export function provenanceBadge(input: { source: number | null; authorName: string; lane: Lane; state: AnchorState }): Badge
export function isTxHash(value: unknown): value is Hex
export function lagText(indexTimestampSec: number | null, chainTimestampSec: number): { text: string; stale: boolean }
export function readersAfterRevoke(agents: readonly { agentId: Hex; readLive: boolean }[], revoking: Hex): Hex[]
export interface GrantTruth { indexSaysLive: boolean; chainSaysValid: boolean | null }
export function grantStatus(t: GrantTruth): { label: "Can read" | "Revoked" | "Expired or revoked on Monad" | "Unverified"; flagged: boolean }
```

- [ ] **Step 1: Failing tests** `test/me-model.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { chipsFor, grantStatus, isTxHash, lagText, provenanceBadge, readersAfterRevoke } from "../src/me/model.js"

describe("chipsFor", () => {
  it("maps contract bits to the three chips and the rare fourth", () => {
    expect(chipsFor(1 | 2 | 4)).toEqual({ read: true, write: true, updateOwn: true, updateAny: false })
    expect(chipsFor(1)).toEqual({ read: true, write: false, updateOwn: false, updateAny: false })
    expect(chipsFor(8).updateAny).toBe(true)
  })
})
describe("provenanceBadge", () => {
  it("only owner-written sources say You said", () => {
    expect(provenanceBadge({ source: 1, authorName: "claude-code", lane: "direct", state: "anchored" })).toEqual({ kind: "you", text: "You said" })
    expect(provenanceBadge({ source: 2, authorName: "x", lane: "direct", state: "anchored" }).kind).toBe("you")
    expect(provenanceBadge({ source: 3, authorName: "codex", lane: "direct", state: "anchored" })).toEqual({ kind: "agent", text: "codex inferred" })
  })
  it("a pending batched save is only a claim", () => {
    expect(provenanceBadge({ source: 3, authorName: "codex", lane: "batched", state: "pending" })).toEqual({ kind: "claimed", text: "codex claimed" })
  })
  it("anything else is unknown, never You said", () => {
    expect(provenanceBadge({ source: 4, authorName: "codex", lane: "direct", state: "anchored" }).kind).toBe("unknown")
    expect(provenanceBadge({ source: null, authorName: "codex", lane: "direct", state: "anchored" }).kind).toBe("unknown")
  })
})
describe("isTxHash", () => {
  it("accepts only 32-byte lowercase hex", () => {
    expect(isTxHash("0x" + "a".repeat(64))).toBe(true)
    expect(isTxHash("0x" + "A".repeat(64))).toBe(false)
    expect(isTxHash("javascript:alert(1)")).toBe(false)
    expect(isTxHash("0x" + "a".repeat(63))).toBe(false)
  })
})
describe("lagText", () => {
  it("reports seconds behind and flags > 60 s", () => {
    expect(lagText(1000, 1009)).toEqual({ text: "9 s behind Monad", stale: false })
    expect(lagText(1000, 1100).stale).toBe(true)
    expect(lagText(null, 1100)).toEqual({ text: "index unavailable", stale: true })
  })
})
describe("readersAfterRevoke", () => {
  it("every other agent with live READ, never the revoked one", () => {
    const a = ("0x" + "1".repeat(64)) as `0x${string}`, b = ("0x" + "2".repeat(64)) as `0x${string}`, c = ("0x" + "3".repeat(64)) as `0x${string}`
    expect(readersAfterRevoke([{ agentId: a, readLive: true }, { agentId: b, readLive: true }, { agentId: c, readLive: false }], a)).toEqual([b])
  })
})
describe("grantStatus", () => {
  it("the chain wins over the index", () => {
    expect(grantStatus({ indexSaysLive: true, chainSaysValid: true })).toEqual({ label: "Can read", flagged: false })
    expect(grantStatus({ indexSaysLive: true, chainSaysValid: false })).toEqual({ label: "Expired or revoked on Monad", flagged: true })
    expect(grantStatus({ indexSaysLive: false, chainSaysValid: false })).toEqual({ label: "Revoked", flagged: false })
    expect(grantStatus({ indexSaysLive: true, chainSaysValid: null })).toEqual({ label: "Unverified", flagged: true })
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** `src/me/model.ts`:

```ts
export type Hex = `0x${string}`
export interface Chips { read: boolean; write: boolean; updateOwn: boolean; updateAny: boolean }
export type Lane = "direct" | "batched"
export type AnchorState = "anchored" | "pending" | "unverified"
export type Badge = { kind: "you" | "agent" | "claimed" | "unknown"; text: string }

// Bit values are PERMISSION in packages/protocol/src/constants.ts:1 — duplicated here on purpose so
// the model has no imports and stays trivially testable; the test pins them.
export function chipsFor(permissions: number): Chips {
  return { read: (permissions & 1) !== 0, write: (permissions & 2) !== 0, updateOwn: (permissions & 4) !== 0, updateAny: (permissions & 8) !== 0 }
}

// PROVENANCE_SOURCE (constants.ts:25-28). The contract accepts 1/2 only from the owner
// (ContextRegistry.sol:130-132), and BatchAnchor accepts only 3 (BatchAnchor.sol:127).
export function provenanceBadge(i: { source: number | null; authorName: string; lane: Lane; state: AnchorState }): Badge {
  if (i.lane === "batched" && i.state === "pending") return { kind: "claimed", text: `${i.authorName} claimed` }
  if (i.source === 1 || i.source === 2) return { kind: "you", text: "You said" }
  if (i.source === 3) return { kind: "agent", text: `${i.authorName} inferred` }
  return { kind: "unknown", text: "Source unknown" }
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value)
}

export function lagText(indexTimestampSec: number | null, chainTimestampSec: number): { text: string; stale: boolean } {
  if (indexTimestampSec === null) return { text: "index unavailable", stale: true }
  const behind = Math.max(0, chainTimestampSec - indexTimestampSec)
  return { text: `${behind} s behind Monad`, stale: behind > 60 }
}

export function readersAfterRevoke(agents: readonly { agentId: Hex; readLive: boolean }[], revoking: Hex): Hex[] {
  const r = revoking.toLowerCase()
  return agents.filter((a) => a.readLive && a.agentId.toLowerCase() !== r).map((a) => a.agentId)
}

export interface GrantTruth { indexSaysLive: boolean; chainSaysValid: boolean | null }
export function grantStatus(t: GrantTruth): { label: "Can read" | "Revoked" | "Expired or revoked on Monad" | "Unverified"; flagged: boolean } {
  if (t.chainSaysValid === null) return { label: "Unverified", flagged: true }
  if (t.chainSaysValid) return { label: "Can read", flagged: !t.indexSaysLive }
  return t.indexSaysLive ? { label: "Expired or revoked on Monad", flagged: true } : { label: "Revoked", flagged: false }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(owner-page): /me model — chips, provenance badges, grant truth, revoke readers`.

---

### Task 3: Sources — gather and verify

**Files:** Create `apps/owner-page/src/me/sources.ts`, `apps/owner-page/test/me-sources.test.ts`.

**Interfaces — Consumes:** Task 2 (`grantStatus`, `provenanceBadge`, `Lane`, `AnchorState`, `lagText`). `ContextApiClient` (`apps/api/src/client.ts`: `listObjects` → `{objects, partial}` `:80`; `listBatchSaves` → `{items: BatchedReadItem[], partial}` `:167`, item states `"QUEUED" | "SUBMITTED" | "ANCHORED"` `:217`; `listRevocations(state)` `:248`; `batchStatus()` `:250`; `getAgentManifest(bodyHash)` `:111-113`); `RegistryReader` (`apps/api/src/chain-views.ts`: `getRecords`, `getCapability`, `activeCapabilityIds`); `readAgentRecord` (core.ts re-export); `batchLeafHash`, `batchSaveStructHash`, `verifyMerkleProof` (`packages/protocol/src/batch.ts:66,96,149`).

**Produces:**
```ts
export interface MePorts {
  index: { query<T>(gql: string, vars: Record<string, unknown>): Promise<T> } | null // null = no index configured
  store: Pick<ContextApiRoutes, "listObjects" | "listBatchSaves" | "listRevocations" | "batchStatus" | "getAgentManifest">
  chain: { isCapabilityValid(capabilityId: Hex): Promise<boolean>; getRecords(ids: Hex[]): Promise<(ContextRecordView | null)[]>; batchRoot(batchId: Hex): Promise<Hex | null>; ownerGrantLogs(owner: Address): Promise<GrantLog[]>; latestTimestamp(): Promise<number> }
}
export interface GrantLog { kind: "granted" | "revoked"; agentId: Hex; capabilityId: Hex | null; namespaceId: Hex | null; permissions: number | null; block: number; txHash: Hex } // one decoded CapabilityGranted / AgentRevoked log
export interface AgentRow { agentId: Hex; name: string; grants: { namespaceId: Hex; area: string; permissions: number; capabilityId: Hex; status: ReturnType<typeof grantStatus>; approvedTx: Hex | null }[]; revokedTx: Hex | null; blockedAtStore: boolean; readLive: boolean }
export interface RecordRow { contextId: Hex; namespaceId: Hex; area: string; readEpoch: bigint; lane: Lane; state: AnchorState; authorId: Hex; authorName: string; source: number | null; tx: Hex | null; batchId: Hex | null; ciphertext: Hex; manifest: unknown; createdAt: number }
export interface MeData { owner: Address; agents: AgentRow[]; records: RecordRow[]; incomplete: string[]; source: "index" | "chain-logs"; lag: { text: string; stale: boolean }; batchingOn: boolean | null; counts: { records: number; youSaid: number; pending: number } | null }
export async function loadMe(owner: Address, ports: MePorts): Promise<MeData>
```

Rules the implementation must follow (each has a test below):
1. **Agents:** index query first (`Grant` + `Agent` + `Revocation` by `owner`); if `ports.index` is null or the query throws, `ownerGrantLogs(owner)` (`eth_getLogs` on `CapabilityGranted` / `AgentRevoked` with the owner topic, via the existing `ownerHistory`/log helpers) and `source = "chain-logs"`. Every grant's status comes from `grantStatus({ indexSaysLive, chainSaysValid: await chain.isCapabilityValid(capabilityId) })` (a throw → `null`). Names: `getAgentManifest(manifestHash)` → `name`; on failure the shortened agent id. `blockedAtStore` = an ACTIVE `listRevocations("active")` intent names the agent; such a row shows "blocked at the store · revoke pending on Monad", never "Can read". `readLive` = any grant with READ whose status label is "Can read" and not blockedAtStore.
2. **Records:** for each area (distinct `namespaceId` from the index, else the three `OWNER_NAMESPACES` `flows.ts:68`): `listObjects` (lane "direct") ∪ `listBatchSaves` (lane "batched"). Direct rows: `getRecords` on ContextRegistry → anchored if the record matches, else "unverified". **Batched rows are never checked against ContextRegistry.** A batched item in state `ANCHORED` with `batchId`+`proof`: recompute the leaf (`batchLeafHash({contextId, agentId, lineageId, version, structHash: batchSaveStructHash(message)})`) and `verifyMerkleProof(leaf, proof, await chain.batchRoot(batchId))` → "anchored", else "unverified"; `QUEUED`/`SUBMITTED` → "pending". Any list with `partial: true` pushes `"list incomplete — the store ran out of chain reads; reload"` onto `incomplete`.
3. **Counts:** from the index (`Owner.records + Owner.batchedSaves`, count of `ContextRecord` with `provenanceSource ∈ {1,2}`); `null` when the index is unavailable or `incomplete` is non-empty.
4. **Lag:** `lagText(GlobalStats.lastTimestamp, await chain.latestTimestamp())`.

- [ ] **Step 1: Failing tests** `test/me-sources.test.ts` with an in-memory `MePorts` fake (build fixtures from `test/helpers.ts` patterns). Minimum cases:
  - a batched ANCHORED item with a valid proof → `state: "anchored"`, `lane: "batched"`, and `chain.getRecords` was **never called with its contextId**;
  - a batched QUEUED item → `state: "pending"`;
  - a direct object with no chain record → `state: "unverified"`;
  - `listBatchSaves` returns `partial: true` → `incomplete` contains the banner text and `counts` is `null`;
  - index says a grant is live, `isCapabilityValid` says false → `status.label === "Expired or revoked on Monad"`, `flagged: true`, `readLive: false`;
  - an active store deny for agent X → X `blockedAtStore: true`, `readLive: false`;
  - `index.query` throws → `source === "chain-logs"` and agents still listed from `ownerGrantLogs`;
  - a manifest fetch failure → name is the shortened id, never empty.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `loadMe` following rules 1–4 exactly; GraphQL documents as exported string constants (`AGENTS_QUERY`, `COUNTS_QUERY`, `BATCHED_QUERY`) so Task 5 can reuse them; a 6 s `AbortSignal.timeout` on every index call.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(owner-page): /me sources — index first, chain-log fallback, both record lanes verified on their own proofs`.

---

### Task 4: Session — passkey sign-in, keys, decrypt

**Files:** Create `apps/owner-page/src/me/session.ts`, `apps/owner-page/test/me-session.test.ts`.

**Interfaces — Consumes:** the owner flows' passkey + secrets helpers re-exported by `src/owner/core.ts` (`deriveOwnerSecrets` `secrets.ts:53-74`, the WebAuthn/Mera PRF helper in `webauthn.ts`), `deriveNamespaceSecret`, `deriveEpochKeyPair`, `fakePrfOutput`, `namespaceById`; `openContextObject` from `@mida/crypto` (`packages/crypto/src/object.ts:98-118`); the owner-key check in `src/owner/session.ts:114-129`.
**Produces:**
```ts
export interface MeSession { owner: Address; signer: LocalAccount; open(row: { namespaceId: Hex; readEpoch: bigint; manifest: unknown; ciphertext: Hex; contextId: Hex }): { ok: true; text: string } | { ok: false }; end(): void }
export async function signIn(env: FlowEnvironment, namespaces: readonly Hex[]): Promise<MeSession>
```
- [ ] **Step 1: Failing tests:** (a) `signIn` derives namespace secrets for the given areas and then calls `release()` on the owner secrets before returning (spy via `env.onSecrets`, as `flows.test.ts` does); (b) `open` decrypts a fixture sealed with a known owner seed (reuse the sealing helper `flows.test.ts` / `owner-authority.test.ts` use) and returns the text; (c) a wrong-seed fixture → `{ ok: false }`; (d) after `end()`, `open` returns `{ ok: false }` and the kept key material is zeroed; (e) a derived address with no owner key on chain → throws `MidaError` naming it.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Derive epoch key pairs lazily per `(namespaceId, readEpoch)` from the namespace secrets (`deriveEpochKeyPair(secret, epoch)`, as `authority.ts:200-204`); keep namespace secrets + the `evmKey`-backed account only; `end()` zeroes every kept `Uint8Array`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(owner-page): /me session — one passkey touch, seed released at once, in-browser decrypt`.

---

### Task 5: The page, route, CSP, bundle

**Files:** Create `apps/owner-page/public/me.html`, `public/me.css` (from `docs/design/me-mockup/me.html` + `me.css`: drop the mockup banner and the "Folder:" line; keep the grants-chip markup), `src/me/page.ts`; Modify `src/worker.ts:9-16` (route `/me`, `/me/`), `src/headers.ts:5-8` (one origin), `scripts/build.mjs:60-73` (a `me.ts` IIFE bundle with the same `@mida/chain/browser` plugin); Test `test/worker.test.ts`, `test/headers.test.ts`, `test/bundle.test.ts`, new `test/me-page.test.ts`.

**Interfaces — Consumes:** Tasks 2–4. **Config:** the page reads the index URL from `GET /me/config.json` served by the Worker from env var `INDEX_GRAPHQL_URL` (not baked into the bundle — a re-deployed index changes the path).

- [ ] **Step 1: Failing tests:**
  - `worker.test.ts`: `/me` and `/me/` → `me.html`; `/me/config.json` → `{ "indexUrl": <env value> }`, and `{ "indexUrl": null }` when unset.
  - `headers.test.ts`: the CSP string equals the Global Constraints value exactly (one new origin, nothing else).
  - `bundle.test.ts`: `me.js` has zero `node:` imports / `require(` (extend the existing scan to the new bundle).
  - `me-page.test.ts`: render through a pure builder `renderMe(data, doc): HTMLElement` against vitest's `jsdom` environment (add `// @vitest-environment jsdom` at the top of the file; if `jsdom` is not already a devDependency of the owner-page package, add it at the version the repo lockfile already resolves, else ask in the report) and assert: an agent named `<img src=x onerror=alert(1)>` renders as literal text and no `img` element exists; a record body `<b>x</b>` renders literally; a tx value that is not a 32-byte hash renders no link; `incomplete` non-empty → the banner is present and the summary counts are absent; `blockedAtStore` → the row reads "blocked at the store · revoke pending on Monad".
  - A guard test that reads every file under `src/me/` and fails on `innerHTML|outerHTML|insertAdjacentHTML|document.write`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `page.ts`: fetch config → `signIn` (button "Sign in with passkey") → `loadMe` → `renderMe` with `document.createElement` + `textContent`; source badge from `data.source` + `data.lag`; chips from `chipsFor`; badges from `provenanceBadge`; decrypted text via `session.open(row)`, newest 20 first with "Show 20 more"; `pagehide` / hidden > 5 min → `session.end()` and remove every decrypted-text node. Worker route + config endpoint + CSP + build entry.
- [ ] **Step 4: Run, expect PASS**, plus the owner-page build script and `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(owner-page): /me page — route, CSP origin, bundle, textContent-only rendering`.

---

### Task 6: Revoke from `/me`

**Files:** Create `apps/owner-page/src/me/revoke.ts`, `test/me-revoke.test.ts`; Modify `src/me/page.ts` (confirm panel wiring).

**Interfaces — Consumes:** `buildOwnerLink` / `parseOwnerLink` (`packages/protocol/src/owner-link.ts:327,370`, re-exported by `core.ts`), `prepareRevoke` / `confirmRevoke` (`src/owner/flows.ts:516,539`), `readersAfterRevoke` (Task 2), `AgentRow.readLive` (Task 3).
**Produces:** `export async function revokeFromMe(env: FlowEnvironment, input: { signedInOwner: Address; agentId: Hex; agents: readonly AgentRow[] }): Promise<FlowResult>`.

- [ ] **Step 1: Failing tests** (fake env as `flows.test.ts` builds it):
  - the built request has `owner === signedInOwner` (never a row value), `agentId`, and `readers` equal to `readersAfterRevoke(agents, agentId)`;
  - with two surviving READ agents and one rotated area, `publishReaderWraps` is called exactly once per survivor for that area, and never for the revoked agent or an agent without READ;
  - no `entries` in the request → `confirmRevoke` completes without a project-list signature (assert the reduced-list signer returns `undefined` for a request with no entries; if it throws, make it return `undefined`);
  - a `SponsorPending` result → status "pending", and the page shows "blocked at the store · revoke pending on Monad" for that agent;
  - the confirm panel text equals `This stops future reads through Mida. It does not erase what <name> already read.`
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:** `buildOwnerLink({ origin: location.origin, flow: "revoke", req: { chainId: Number(env.deployment.chainId), owner: signedInOwner, agentId, readers }, nonce: <16 hex chars from crypto.getRandomValues> })` → `parseOwnerLink(<the url's fragment>, "revoke")` → `prepareRevoke(env, link)` → `confirmRevoke(env, link, prep)`. No `port` (there is no terminal to return to). After a success, re-run `loadMe` — never flip the row locally.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(owner-page): revoke from /me — surviving agents re-keyed, signed-in owner only`.

---

### Task 7: Keep the index alive + operator doc

**Files:** Modify `apps/owner-page/src/worker.ts` (a `scheduled` handler), the owner-page `wrangler.toml` (`[triggers] crons = ["17 6 * * *"]`); Create `docs/me-owner-view.md`; Test `test/worker.test.ts`.
- [ ] **Step 1: Failing test:** `scheduled()` with `INDEX_GRAPHQL_URL` set POSTs one tiny query (`{ GlobalStats(limit: 1) { lastBlock } }`) and swallows errors; with it unset, does nothing.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5:** `docs/me-owner-view.md` (plain language): what `/me` shows and where each number comes from (spec §3's table), the Envio Cloud deploy steps (`apps/indexer/README.md`), deploy no earlier than Sep 28, re-deploy around Oct 20 and update `INDEX_GRAPHQL_URL`, the two things to prove on the first deploy (our tool versions; the `Access-Control-Allow-Origin` header seen from `app.midacontext.xyz`), and the known limits (store-held records only; newest 20 decrypted first; `indexer.dev.hyperindex.xyz` is a shared origin).
- [ ] **Step 6: Commit** `feat(owner-page): daily index keep-alive; docs: /me operator notes`.

---

## After the tasks (Claude, not Devin)
1. Verify each task (its tests + reading the diff), then `pnpm typecheck` and the full `pnpm test` on a clean copy.
2. ONE Opus adversarial review of the branch, **including the architecture diagram check** (Dami's standing rule): add the owner view + Envio index to `docs/architecture/mida-architecture.excalidraw` with /excalidraw, re-export light/dark SVG.
3. Merge to `p0-m0-skeleton`; Dami deploys the owner page from `mida-context-live` (this also replaces the stale pre-Sep-24 owner page), then the index to Envio Cloud (Sep 28+), sets `INDEX_GRAPHQL_URL`, and checks CORS from the live page.
4. Mera Part 2 on a passkey setup: sign in on a fresh browser profile → same owner, records decrypt → revoke → a fresh read is refused. Recorded.
