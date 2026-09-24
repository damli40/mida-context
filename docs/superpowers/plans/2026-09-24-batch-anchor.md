# BatchAnchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo the implementer is Devin CLI: each task below becomes one brief in `.devin/briefs/ba-task-N.md`, and Claude verifies each commit before the next task starts.

**Goal:** Let many automatic checkpoint saves share one Monad transaction while the contract still checks every save's agent signature, live grant, area, read epoch and parent, storing one Merkle root per batch and one lineage word per save.

**Architecture:** A new `BatchAnchor` contract sits beside the existing registries and only reads `CapabilityRegistry`. Agents sign each save (EIP-712). The hosted store queues signed saves and a batcher submits them; the contract checks each save, computes the Merkle root over the accepted saves only, and emits one log line per save. Readers verify anchored saves five ways against the chain (never trusting the store) and may also use verified pending saves, clearly marked `PENDING_ANCHOR`. Switching agents (Claude → Codex) flushes the batch at once. Batching is off by default and switched on per setup with `mida batching on`.

**Tech Stack:** Solidity 0.8.28 (Foundry, `network = "monad"` gas rules, via_ir), TypeScript (viem, Hono, vitest), Cloudflare Workers (D1 + a Durable Object alarm), Envio indexer.

**Spec:** `docs/superpowers/specs/2026-09-24-batch-anchor-design.md` (approved Sep 24 2026), plus Amendments A and B below (written into the spec in Task 0).

## Global Constraints

- Branch `batch-anchor`, cut from `p0-m0-skeleton`. Nothing merges to `p0-m0-skeleton` unless spec §10 is fully met (complete suite, benchmark evidence file, Opus adversarial review, Dami's explicit yes) by Oct 5 2026.
- `ContextRegistry.sol` and `CapabilityRegistry.sol` (and every file they import) are NOT modified. BatchAnchor only calls `ICapabilityRegistry` views.
- Batching is OFF by default. With no `batching: true` in `network.json`, every code path behaves exactly as on `p0-m0-skeleton` (existing tests must pass unchanged).
- Only automatic checkpoint saves (`saveCheckpoint`) use the batch lane. Facts (`remember`), grants, revokes, owner keys, evidence: untouched.
- The contract computes the Merkle root itself from accepted saves; it never accepts a root from the caller. A valid inclusion proof means "accepted".
- A pending save is never described as final: every place it surfaces carries `PENDING_ANCHOR` and "not yet anchored; may still be rejected".
- Envio never decides validity.
- No gas multiplier or throughput number is written anywhere unless copied from `docs/evidence/batch-anchor-benchmark-<date>.json`.
- Devin rules (every brief carries them): never run testnet, `bin/mida`, `pnpm mida`, wrangler, real agents or real models; never open `.env`; never read or write `~/.mida*`; never stage `docs/evidence/m0-local-anvil.json`, `spikes/`, `brand/`, `apps/owner-page/**`; stage by explicit path; one plain shell command per call; files only via the file-editing tool.
- Commits: one per task, message given in the task. Recount test totals from the runner summary line; never estimate.

## Amendment A to the spec (Dami approves before Task 1 starts)

1. **Batched record id includes the parent.** `contextId = keccak256(abi.encode("MIDA_BATCH_CONTEXT_V1", chainId, batchAnchor, owner, agentId, namespaceId, parentId, objectNonce))`. With the plain rule, an agent that reuses a nonce inside one lineage could mint a later save with the same id as an earlier one. Binding the parent makes ids unique without a per-save "seen" map (~22,000 gas per save saved): a parent can have at most one accepted child, because accepting a child moves the head off the parent.
2. **One storage word per lineage (`headCommit`).** The contract stores `headCommit[lineageId] = keccak256(abi.encode(headContextId, owner, namespaceId, rootAuthor, version))` instead of record fields. A replacement save carries (and signs) `lineageId`, `parentVersion` and `rootAuthor`; the contract checks the commit. Spec §5.2 `PARENT_MISMATCH` folds into `STALE_PARENT`.
3. **Log line fields.** `SaveAnchored` indexes `owner`, `contextId`, `batchId` (not `namespaceId`), so a batch's saves can be fetched by batch id to rebuild proofs.
4. **Batched ciphertext lives in the store's batch table, not `objects`.** The `objects` sweep deletes uploads that never anchor in ContextRegistry; batched saves never do.
5. **Checkpoint shape is fixed.** Batched saves are CONTEXT records, `lineagePolicy = STANDARD`, `provenanceSource = AGENT_INFERRED` (what `saveCheckpoint` sends today); anything else is rejected `BAD_SHAPE`.

## Amendment B to the spec (from Dami, Sep 24; replaces spec §11's "handoff reads only ANCHORED")

1. **Next-session handoff = anchored context + verified pending context.**
2. **Verified pending** = every check that does not need the anchor: ciphertext and manifest match the signed commitments; the signature recovers to a registered agent (`agentIdOfSigner != 0`) that is the claimed author; that agent holds a live CREATE grant with INFERENCE for the area, read from the chain at read time. Missing only: inclusion, acceptance, freshness.
3. **Pending is usable immediately, clearly marked `PENDING_ANCHOR`, never described as final.** The injected handoff text for such an item says "PENDING_ANCHOR: not yet anchored on Monad; may still be rejected".
4. **An explicit agent switch triggers an immediate batch flush.** When the reading agent differs from the author of any pending save in the handoff (e.g. Claude saved, Codex starts), the reader first calls the store's flush, waits up to 3 seconds for those saves to anchor, then reads. Whatever is still pending is shown marked. Flush is authenticated, skipped when the queue is empty, and limited to once per 10 seconds per signer.
5. **Blockchain = eventual canonical settlement and audit.** A pending save that is later REJECTED stops appearing in handoffs and is reported by `mida doctor` (Task 7).

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `contracts/src/BatchAnchor.sol` | Create | the checked batch contract |
| `contracts/src/BatchMerkle.sol` | Create | commutative Merkle root/verify library (Solidity) |
| `contracts/script/DeployBatchAnchor.s.sol` | Create | deploy BatchAnchor beside an existing deployment; add `batchAnchor` + `batchAnchorBlock` to `deployments/<chainId>.json` |
| `contracts/test/BatchAnchor.t.sol` | Create | every accept/reject rule, duplicates, idempotence, root |
| `contracts/test/BatchAnchorGas.t.sol` | Create | gas snapshots (per batch size, direct vs batched) |
| `contracts/test/BatchParity.t.sol` | Create | Solidity == TS for digest, contextId, leaf, head commit, root |
| `contracts/test/utils/BatchFixtures.sol` | Create | build + sign batched saves in tests |
| `packages/protocol/src/batch.ts` | Create | typed data, contextId, leaf, headCommit, Merkle build/proof/verify |
| `packages/protocol/src/index.ts` | Modify | export `./batch.js` |
| `packages/protocol/scripts/export-vectors.ts` | Modify | also write `contracts/test/vectors/batch-v1.json` |
| `packages/chain/src/deployment.ts` | Modify | optional `batchAnchor`, `batchAnchorBlock` |
| `packages/chain/src/local.ts` | Modify | `deployLocal` also runs DeployBatchAnchor |
| `packages/chain/src/abis.ts` | Regenerate | `batchAnchorAbi` via `pnpm chain:abis` |
| `apps/api/src/batch-store.ts` | Create | batch rows (fs impl + interface), states |
| `apps/api/src/batch-routes.ts` | Create | status, submit, get, list (anchored + pending), flush |
| `apps/api/src/batcher.ts` | Create | runtime-agnostic batcher: timer rule, flush, submit, resolve, proofs |
| `apps/api/src/app.ts` | Modify | mount batch routes when `options.batching` is set |
| `apps/api/src/client.ts` | Modify | client methods for the batch routes |
| `apps/store-worker/src/batch-coordinator.ts` | Create | Durable Object wrapper (alarm) around `Batcher` |
| `apps/store-worker/src/d1.ts` | Modify | `D1BatchStore` |
| `apps/store-worker/schema.sql` | Modify | `batch_saves`, `batch_meta` tables |
| `apps/store-worker/src/worker.ts` | Modify | env fields, DO export, route wiring |
| `apps/store-worker/wrangler.toml` | Modify | DO binding + migration, `BATCH_ANCHOR`, `BATCHING_ENABLED` |
| `apps/cli/src/environment.ts` | Modify | Node batcher for local e2e |
| `packages/sdk/src/batched.ts` | Create | `signBatchSave`, `verifyBatchedItem` (5 checks), `verifyPendingItem` |
| `packages/sdk/src/agent.ts` | Modify | `createBatched`, `readBatchedWithStatus` |
| `apps/midad/src/batching.ts` | Create | lane decision, pending-anchor ledger, follow-up pass |
| `apps/midad/src/skeleton.ts` | Modify | `saveCheckpoint` batched branch; `readCheckpoints` merges anchored + pending, flush on switch |
| `apps/midad/src/handoff.ts` | Modify | render `PENDING_ANCHOR` items |
| `apps/midad/src/drain.ts` | Modify | follow-up pass each drain; `queued` outcome |
| `apps/midad/src/doctor.ts` | Modify | lane line, stuck/rejected PROBLEMs |
| `apps/midad/src/cli.ts` | Modify | `mida batching on|off` |
| `apps/midad/src/network.ts` | Modify | `batching?: boolean` in `SavedNetwork` |
| `apps/midad/src/owner-read.ts` | Modify | also scan `SaveAnchored` |
| `apps/midad/src/migrate.ts` | Modify | fail-closed `hasBatchedSaves` guard |
| `apps/indexer/config.yaml`, `schema.graphql`, `src/EventHandlers.ts`, `abi/BatchAnchor.json` | Modify/Create | count batched saves/batches |
| `apps/midad/test/batch.e2e.test.ts` | Create | end to end on a local chain |
| `scripts/bench-batch-anchor.ts` | Create | testnet benchmark (run by Dami only) |
| `docs/batching-trial-runbook.md` | Create | switching batching on for a trial |

---

### Task 0: Branch and spec amendments (Claude)

**Files:** Modify `docs/superpowers/specs/2026-09-24-batch-anchor-design.md` (append "## 12. Amendment A" and "## 13. Amendment B" verbatim from this plan; in §11 replace the last bullet with "Decided by Amendment B: the handoff shows anchored plus verified pending saves.").

Done by Claude after the running Devin task (c-task-2) is committed and Dami approves Amendment A.

- [ ] **Step 1:** `git -C ~/Desktop/mida-context switch -c batch-anchor p0-m0-skeleton`
- [ ] **Step 2:** Append the amendments to the spec.
- [ ] **Step 3:** `git add docs/superpowers/specs/2026-09-24-batch-anchor-design.md docs/superpowers/plans/2026-09-24-batch-anchor.md` then `git commit -m "docs(batch-anchor): spec amendments A+B and implementation plan"`

---

### Task 1: TS batch primitives (typed data, ids, leaf, Merkle) + vectors

**Files:**
- Create: `packages/protocol/src/batch.ts`, `packages/protocol/test/batch.test.ts`, `contracts/test/vectors/batch-v1.json` (generated)
- Modify: `packages/protocol/src/index.ts`, `packages/protocol/scripts/export-vectors.ts`

**Interfaces — Produces** (used by Tasks 2, 4, 5, 6, 7, 8):
- `BATCH_REJECT = { BAD_SIGNER: 1, BAD_SHAPE: 2, BAD_AREA: 3, BAD_EPOCH: 4, NO_AUTHORITY: 5, ALREADY_ANCHORED: 6, STALE_PARENT: 7 } as const`
- `interface BatchSaveMessage { owner: Address; namespaceId: Hex; objectNonce: Hex; lineageId: Hex; parentId: Hex; parentVersion: number; rootAuthor: Hex; manifestHash: Hex; ciphertextCommitment: Hex; readEpoch: bigint; expiresAt: bigint; kind: number; provenanceSource: number }`
- `batchSaveTypedData(input: { chainId: bigint; batchAnchor: Address; message: BatchSaveMessage })`, `batchSaveDigest(same): Hex`, `batchSaveStructHash(message): Hex`, `BATCH_SAVE_TYPEHASH`
- `batchContextId(input: { chainId: bigint; batchAnchor: Address; owner: Address; agentId: Hex; namespaceId: Hex; parentId: Hex; objectNonce: Hex }): Hex`
- `batchLeafHash(input: { contextId: Hex; agentId: Hex; lineageId: Hex; version: number; structHash: Hex }): Hex`
- `headCommit(input: { contextId: Hex; owner: Address; namespaceId: Hex; rootAuthor: Hex; version: number }): Hex`
- `merkleRoot(leaves: readonly Hex[]): Hex` (zeroHash for empty), `merkleProof(leaves, index): Hex[]`, `verifyMerkleProof(leaf, proof, root): boolean`

- [ ] **Step 1: Write the failing test** `packages/protocol/test/batch.test.ts`

```ts
import { describe, expect, it } from "vitest"
import { keccak256, toHex, zeroHash } from "viem"
import {
  batchContextId, batchLeafHash, batchSaveStructHash, headCommit, merkleProof, merkleRoot, verifyMerkleProof,
} from "../src/batch.js"

const leaves = Array.from({ length: 7 }, (_, i) => keccak256(toHex(`leaf-${i}`)))

describe("merkle", () => {
  it("empty root is zero, single root is the leaf", () => {
    expect(merkleRoot([])).toBe(zeroHash)
    expect(merkleRoot([leaves[0]!])).toBe(leaves[0])
  })
  it("every proof verifies for sizes 1..7, and a wrong leaf fails", () => {
    for (let n = 1; n <= 7; n += 1) {
      const set = leaves.slice(0, n)
      const root = merkleRoot(set)
      set.forEach((leaf, i) => expect(verifyMerkleProof(leaf, merkleProof(set, i), root)).toBe(true))
      expect(verifyMerkleProof(keccak256(toHex("outsider")), merkleProof(set, 0), root)).toBe(false)
    }
  })
})

describe("ids", () => {
  const base = {
    chainId: 10143n, batchAnchor: "0x1111111111111111111111111111111111111111" as const,
    owner: "0x2222222222222222222222222222222222222222" as const, agentId: keccak256(toHex("agent")),
    namespaceId: keccak256(toHex("ns")), objectNonce: keccak256(toHex("nonce")),
  }
  it("the parent changes the id (nonce reuse cannot collide)", () => {
    expect(batchContextId({ ...base, parentId: zeroHash })).not.toBe(batchContextId({ ...base, parentId: keccak256(toHex("p")) }))
  })
  it("leaf and headCommit are deterministic and field-sensitive", () => {
    const message = {
      owner: base.owner, namespaceId: base.namespaceId, objectNonce: base.objectNonce, lineageId: zeroHash,
      parentId: zeroHash, parentVersion: 0, rootAuthor: zeroHash, manifestHash: keccak256(toHex("m")),
      ciphertextCommitment: keccak256(toHex("c")), readEpoch: 1n, expiresAt: 0n, kind: 5, provenanceSource: 3,
    }
    const structHash = batchSaveStructHash(message)
    const contextId = batchContextId({ ...base, parentId: zeroHash })
    const leaf = (version: number) => batchLeafHash({ contextId, agentId: base.agentId, lineageId: contextId, version, structHash })
    expect(leaf(1)).toBe(leaf(1))
    expect(leaf(1)).not.toBe(leaf(2))
    const commit = (version: number) => headCommit({ contextId, owner: base.owner, namespaceId: base.namespaceId, rootAuthor: base.agentId, version })
    expect(commit(1)).not.toBe(commit(2))
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (module not found): `pnpm exec vitest run packages/protocol/test/batch.test.ts --testTimeout 600000 --teardownTimeout 5000`

- [ ] **Step 3: Implement** `packages/protocol/src/batch.ts`

```ts
import { concat, encodeAbiParameters, hashTypedData, keccak256, zeroHash } from "viem"
import type { Address, Hex } from "./types.js"
import { midaDomain } from "./typed-data.js"

/** Why the contract skipped a save (SaveRejected.reason). Mirrors BatchAnchor.sol. */
export const BATCH_REJECT = {
  BAD_SIGNER: 1, BAD_SHAPE: 2, BAD_AREA: 3, BAD_EPOCH: 4, NO_AUTHORITY: 5, ALREADY_ANCHORED: 6, STALE_PARENT: 7,
} as const
export type BatchRejectReason = keyof typeof BATCH_REJECT

export const BATCH_ANCHOR_DOMAIN_NAME = "Mida Batch Anchor"

export const BATCH_SAVE_TYPES = {
  MidaBatchSaveV1: [
    { name: "owner", type: "address" },
    { name: "namespaceId", type: "bytes32" },
    { name: "objectNonce", type: "bytes32" },
    { name: "lineageId", type: "bytes32" },
    { name: "parentId", type: "bytes32" },
    { name: "parentVersion", type: "uint32" },
    { name: "rootAuthor", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "ciphertextCommitment", type: "bytes32" },
    { name: "readEpoch", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "kind", type: "uint8" },
    { name: "provenanceSource", type: "uint8" },
  ],
} as const

/** What an agent signs for one batched save. A new lineage has lineageId = parentId = rootAuthor = 0, parentVersion = 0. */
export interface BatchSaveMessage {
  owner: Address
  namespaceId: Hex
  objectNonce: Hex
  lineageId: Hex
  parentId: Hex
  parentVersion: number
  rootAuthor: Hex
  manifestHash: Hex
  ciphertextCommitment: Hex
  readEpoch: bigint
  expiresAt: bigint
  kind: number
  provenanceSource: number
}

export function batchSaveTypedData(input: { chainId: bigint; batchAnchor: Address; message: BatchSaveMessage }) {
  return {
    domain: midaDomain(BATCH_ANCHOR_DOMAIN_NAME, input.chainId, input.batchAnchor),
    types: BATCH_SAVE_TYPES,
    primaryType: "MidaBatchSaveV1" as const,
    message: input.message,
  }
}

export function batchSaveDigest(input: { chainId: bigint; batchAnchor: Address; message: BatchSaveMessage }): Hex {
  return hashTypedData(batchSaveTypedData(input))
}

const TYPE_STRING =
  "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
export const BATCH_SAVE_TYPEHASH = keccak256(new TextEncoder().encode(TYPE_STRING))

/** The EIP-712 struct hash (not the digest); it is what the leaf binds. */
export function batchSaveStructHash(m: BatchSaveMessage): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint8" },
      ],
      [
        BATCH_SAVE_TYPEHASH, m.owner, m.namespaceId, m.objectNonce, m.lineageId, m.parentId, m.parentVersion,
        m.rootAuthor, m.manifestHash, m.ciphertextCommitment, m.readEpoch, m.expiresAt, m.kind, m.provenanceSource,
      ],
    ),
  )
}

export function batchContextId(i: {
  chainId: bigint; batchAnchor: Address; owner: Address; agentId: Hex; namespaceId: Hex; parentId: Hex; objectNonce: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      ],
      ["MIDA_BATCH_CONTEXT_V1", i.chainId, i.batchAnchor, i.owner, i.agentId, i.namespaceId, i.parentId, i.objectNonce],
    ),
  )
}

export function batchLeafHash(i: { contextId: Hex; agentId: Hex; lineageId: Hex; version: number; structHash: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }],
      ["MIDA_BATCH_LEAF_V1", i.contextId, i.agentId, i.lineageId, i.version, i.structHash],
    ),
  )
}

export function headCommit(i: { contextId: Hex; owner: Address; namespaceId: Hex; rootAuthor: Hex; version: number }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }],
      [i.contextId, i.owner, i.namespaceId, i.rootAuthor, i.version],
    ),
  )
}

/** Commutative pair hash: keccak256(min || max). Same as BatchMerkle.sol. */
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]))
}

/** Levels bottom-up; an odd last node is carried up unchanged. */
function levels(leaves: readonly Hex[]): Hex[][] {
  const out: Hex[][] = [leaves.slice()]
  while (out[out.length - 1]!.length > 1) {
    const level = out[out.length - 1]!
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!)
    out.push(next)
  }
  return out
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return zeroHash
  const all = levels(leaves)
  return all[all.length - 1]![0]!
}

export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new RangeError(`merkleProof: index ${index} out of range`)
  const proof: Hex[] = []
  let i = index
  for (const level of levels(leaves).slice(0, -1)) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1
    if (sibling < level.length) proof.push(level[sibling]!)
    i = Math.floor(i / 2)
  }
  return proof
}

export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let node = leaf
  for (const sibling of proof) node = hashPair(node, sibling)
  return node.toLowerCase() === root.toLowerCase()
}
```

- [ ] **Step 4: Export and vectors.** Add `export * from "./batch.js"` to `packages/protocol/src/index.ts`. In `export-vectors.ts`, after the existing `writeFileSync(out, …)`, write `contracts/test/vectors/batch-v1.json` with fixed inputs (`chainId 10143`, `batchAnchor 0x1111…1111`, `owner 0x2222…2222`, `agentId keccak256("agent")`, `namespaceId keccak256("ns")`, `objectNonce keccak256("nonce")`, `parentId 0x0`, the message from the test) and outputs `typehash`, `structHash`, `digest`, `contextId`, `leafHash` (lineageId = contextId, version 1), `headCommit` (rootAuthor = agentId, version 1), `leaves` (`keccak256("leaf-0")`…`"leaf-4"`) and their `root`. Run the vectors script through its package script (`grep -n "export-vectors" package.json packages/protocol/package.json`); if none exists add `"vectors": "tsx scripts/export-vectors.ts"` to `packages/protocol/package.json` and run `pnpm --filter @mida/protocol vectors`.
- [ ] **Step 5: Run tests PASS**, `pnpm typecheck`.
- [ ] **Step 6: Commit** `git add packages/protocol/src/batch.ts packages/protocol/src/index.ts packages/protocol/test/batch.test.ts packages/protocol/scripts/export-vectors.ts packages/protocol/package.json contracts/test/vectors/batch-v1.json` then `git commit -m "feat(protocol): batched-save typed data, ids, leaf and Merkle primitives with vectors"`

---

### Task 2: `BatchAnchor.sol` + `BatchMerkle.sol` + rule tests + parity

**Files:**
- Create: `contracts/src/BatchMerkle.sol`, `contracts/src/BatchAnchor.sol`, `contracts/test/utils/BatchFixtures.sol`, `contracts/test/BatchAnchor.t.sol`, `contracts/test/BatchParity.t.sol`

**Interfaces:**
- Consumes: `ICapabilityRegistry` views, `SignatureRecovery.recover`, `MidaHashing.domainSeparator/typedDigest`, `MidaTypes.sol` constants, `test/vectors/batch-v1.json`.
- Produces (Tasks 3–10):
  - `struct BatchAnchor.SignedSave { address owner; bytes32 namespaceId; bytes32 objectNonce; bytes32 lineageId; bytes32 parentId; uint32 parentVersion; bytes32 rootAuthor; bytes32 manifestHash; bytes32 ciphertextCommitment; uint64 readEpoch; uint64 expiresAt; uint8 kind; uint8 provenanceSource; bytes signature; }`
  - `submitBatch(bytes32 batchId, SignedSave[] calldata saves) returns (bytes32 root, uint32 acceptedCount)`
  - views `batchOf(bytes32) returns (bytes32 root, uint64 blockNumber, uint32 acceptedCount)`, `headCommitOf(bytes32) returns (bytes32)`, `hasBatchedSaves(address) returns (bool)`, `CAPABILITY_REGISTRY()`, `MAX_BATCH()`
  - events `SaveAnchored(address indexed owner, bytes32 indexed contextId, bytes32 indexed batchId, bytes32 namespaceId, bytes32 lineageId, uint32 version, bytes32 author, uint32 position, bytes32 leafHash)`, `SaveRejected(bytes32 indexed batchId, uint32 index, uint8 reason)`, `BatchAnchored(bytes32 indexed batchId, bytes32 root, uint32 acceptedCount, uint32 rejectedCount, address submitter)`
  - errors `ZeroRegistry()`, `EmptyBatch()`, `BatchTooLarge(uint256 size)`, `BatchExists(bytes32 batchId)`

- [ ] **Step 1: `BatchMerkle.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Commutative Merkle tree, identical to packages/protocol/src/batch.ts: pair = keccak256(min || max),
///         an odd last node is carried up unchanged, the root of one leaf is the leaf, of none is zero.
library BatchMerkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Overwrites `nodes` in place.
    function root(bytes32[] memory nodes, uint256 count) internal pure returns (bytes32) {
        if (count == 0) return bytes32(0);
        while (count > 1) {
            uint256 next = 0;
            for (uint256 i = 0; i < count; i += 2) {
                nodes[next] = i + 1 < count ? hashPair(nodes[i], nodes[i + 1]) : nodes[i];
                next++;
            }
            count = next;
        }
        return nodes[0];
    }

    function verify(bytes32 leaf, bytes32[] memory proof, bytes32 expectedRoot) internal pure returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) node = hashPair(node, proof[i]);
        return node == expectedRoot;
    }
}
```

- [ ] **Step 2: `BatchAnchor.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    KIND_MAX, KIND_NONE, PERM_CREATE, PERM_SUPERSEDE_ANY, PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE,
    SOURCE_AGENT_INFERRED
} from "./MidaTypes.sol";
import {ICapabilityRegistry} from "./ICapabilityRegistry.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {SignatureRecovery} from "./SignatureRecovery.sol";
import {BatchMerkle} from "./BatchMerkle.sol";

/// @notice Checked, Merkle-batched anchoring for automatic checkpoint saves (spec 2026-09-24 + Amendment A).
///         Every save is signed by its agent and checked like ContextRegistry checks a write: signer, shape,
///         area, read epoch, live authority, lineage. Accepted saves share one root the contract computes
///         itself, so a valid proof means "accepted". Reads CapabilityRegistry; never writes it.
contract BatchAnchor {
    struct SignedSave {
        address owner;
        bytes32 namespaceId;
        bytes32 objectNonce;
        bytes32 lineageId;
        bytes32 parentId;
        uint32 parentVersion;
        bytes32 rootAuthor;
        bytes32 manifestHash;
        bytes32 ciphertextCommitment;
        uint64 readEpoch;
        uint64 expiresAt;
        uint8 kind;
        uint8 provenanceSource;
        bytes signature;
    }

    struct Batch {
        bytes32 root;
        uint64 blockNumber;
        uint32 acceptedCount;
    }

    uint8 internal constant BAD_SIGNER = 1;
    uint8 internal constant BAD_SHAPE = 2;
    uint8 internal constant BAD_AREA = 3;
    uint8 internal constant BAD_EPOCH = 4;
    uint8 internal constant NO_AUTHORITY = 5;
    uint8 internal constant ALREADY_ANCHORED = 6;
    uint8 internal constant STALE_PARENT = 7;

    uint256 public constant MAX_BATCH = 1024;
    string internal constant DOMAIN_NAME = "Mida Batch Anchor";
    bytes32 internal constant BATCH_SAVE_TYPEHASH = keccak256(
        "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
    );

    error ZeroRegistry();
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error BatchExists(bytes32 batchId);

    event SaveAnchored(
        address indexed owner,
        bytes32 indexed contextId,
        bytes32 indexed batchId,
        bytes32 namespaceId,
        bytes32 lineageId,
        uint32 version,
        bytes32 author,
        uint32 position,
        bytes32 leafHash
    );
    event SaveRejected(bytes32 indexed batchId, uint32 index, uint8 reason);
    event BatchAnchored(bytes32 indexed batchId, bytes32 root, uint32 acceptedCount, uint32 rejectedCount, address submitter);

    ICapabilityRegistry public immutable CAPABILITY_REGISTRY;
    bytes32 internal immutable DOMAIN_SEPARATOR;

    mapping(bytes32 lineageId => bytes32) private _headCommit;
    mapping(bytes32 batchId => Batch) private _batches;
    mapping(address owner => bool) public hasBatchedSaves;

    constructor(ICapabilityRegistry capabilityRegistry) {
        if (address(capabilityRegistry) == address(0)) revert ZeroRegistry();
        CAPABILITY_REGISTRY = capabilityRegistry;
        DOMAIN_SEPARATOR = MidaHashing.domainSeparator(DOMAIN_NAME, block.chainid, address(this));
    }

    function batchOf(bytes32 batchId) external view returns (bytes32 root, uint64 blockNumber, uint32 acceptedCount) {
        Batch storage b = _batches[batchId];
        return (b.root, b.blockNumber, b.acceptedCount);
    }

    function headCommitOf(bytes32 lineageId) external view returns (bytes32) {
        return _headCommit[lineageId];
    }

    function submitBatch(bytes32 batchId, SignedSave[] calldata saves) external returns (bytes32 root, uint32 acceptedCount) {
        if (saves.length == 0) revert EmptyBatch();
        if (saves.length > MAX_BATCH) revert BatchTooLarge(saves.length);
        if (_batches[batchId].blockNumber != 0) revert BatchExists(batchId);

        bytes32[] memory accepted = new bytes32[](saves.length);
        uint32 rejected = 0;
        for (uint256 i = 0; i < saves.length; i++) {
            (uint8 reason, bytes32 leaf) = _checkAndApply(batchId, acceptedCount, saves[i]);
            if (reason != 0) {
                emit SaveRejected(batchId, uint32(i), reason);
                rejected++;
            } else {
                accepted[acceptedCount] = leaf;
                acceptedCount++;
            }
        }
        root = BatchMerkle.root(accepted, acceptedCount);
        _batches[batchId] = Batch({root: root, blockNumber: uint64(block.number), acceptedCount: acceptedCount});
        emit BatchAnchored(batchId, root, acceptedCount, rejected, msg.sender);
    }

    /// @dev Returns (0, leaf) on accept after writing state; (reason, 0) on reject with no state written.
    function _checkAndApply(bytes32 batchId, uint32 position, SignedSave calldata s) private returns (uint8, bytes32) {
        bytes32 structHash = _structHash(s);
        address signer = SignatureRecovery.recover(MidaHashing.typedDigest(DOMAIN_SEPARATOR, structHash), s.signature);
        if (signer == address(0)) return (BAD_SIGNER, 0);
        bytes32 agentId = CAPABILITY_REGISTRY.agentIdOfSigner(signer);
        if (agentId == bytes32(0)) return (BAD_SIGNER, 0);

        if (
            s.owner == address(0) || s.kind == KIND_NONE || s.kind > KIND_MAX || s.provenanceSource != SOURCE_AGENT_INFERRED
                || s.manifestHash == bytes32(0) || s.ciphertextCommitment == bytes32(0)
        ) return (BAD_SHAPE, 0);
        if (!CAPABILITY_REGISTRY.isRegisteredNamespace(s.namespaceId)) return (BAD_AREA, 0);

        uint64 required = CAPABILITY_REGISTRY.requiredReadEpoch(s.owner, s.namespaceId);
        if (s.readEpoch != required || !CAPABILITY_REGISTRY.isWriteEpochValid(s.owner, s.namespaceId, required)) {
            return (BAD_EPOCH, 0);
        }

        bytes32 contextId = keccak256(
            abi.encode(
                string("MIDA_BATCH_CONTEXT_V1"), block.chainid, address(this), s.owner, agentId, s.namespaceId, s.parentId,
                s.objectNonce
            )
        );

        bytes32 lineageId;
        bytes32 rootAuthor;
        uint32 version;
        if (s.parentId == bytes32(0)) {
            if (s.lineageId != bytes32(0) || s.parentVersion != 0 || s.rootAuthor != bytes32(0)) return (BAD_SHAPE, 0);
            if (!CAPABILITY_REGISTRY.hasAuthority(s.owner, agentId, s.namespaceId, PERM_CREATE, PROV_ALLOW_INFERENCE)) {
                return (NO_AUTHORITY, 0);
            }
            lineageId = contextId;
            rootAuthor = agentId;
            version = 1;
            if (_headCommit[lineageId] != bytes32(0)) return (ALREADY_ANCHORED, 0);
        } else {
            lineageId = s.lineageId;
            rootAuthor = s.rootAuthor;
            if (s.parentVersion == 0 || s.parentVersion == type(uint32).max) return (BAD_SHAPE, 0);
            bytes32 expected = keccak256(abi.encode(s.parentId, s.owner, s.namespaceId, rootAuthor, s.parentVersion));
            if (_headCommit[lineageId] != expected) return (STALE_PARENT, 0);
            bool allowed = rootAuthor == agentId
                && CAPABILITY_REGISTRY.hasAuthority(s.owner, agentId, s.namespaceId, PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE);
            if (!allowed) {
                allowed =
                    CAPABILITY_REGISTRY.hasAuthority(s.owner, agentId, s.namespaceId, PERM_SUPERSEDE_ANY, PROV_ALLOW_INFERENCE);
            }
            if (!allowed) return (NO_AUTHORITY, 0);
            version = s.parentVersion + 1;
        }

        _headCommit[lineageId] = keccak256(abi.encode(contextId, s.owner, s.namespaceId, rootAuthor, version));
        if (!hasBatchedSaves[s.owner]) hasBatchedSaves[s.owner] = true;
        bytes32 leaf = keccak256(abi.encode(string("MIDA_BATCH_LEAF_V1"), contextId, agentId, lineageId, version, structHash));
        emit SaveAnchored(s.owner, contextId, batchId, s.namespaceId, lineageId, version, agentId, position, leaf);
        return (0, leaf);
    }

    function _structHash(SignedSave calldata s) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                BATCH_SAVE_TYPEHASH, s.owner, s.namespaceId, s.objectNonce, s.lineageId, s.parentId, s.parentVersion,
                s.rootAuthor, s.manifestHash, s.ciphertextCommitment, s.readEpoch, s.expiresAt, s.kind, s.provenanceSource
            )
        );
    }
}
```

If the compiler reports "stack too deep" despite `via_ir`, split the new-lineage and replacement branches into two private functions returning `(uint8 reason, bytes32 lineageId, bytes32 rootAuthor, uint32 version)`; behaviour must not change.

- [ ] **Step 3: `BatchFixtures.sol`** (extends the existing `ContextFixtures`, reusing `_deployContexts`, `_ownerWithKey`, `_register`, `_initEpoch`, `_grantExact`, `_scope`, `_ns`, `_sign`)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SOURCE_AGENT_INFERRED} from "../../src/MidaTypes.sol";
import {BatchAnchor} from "../../src/BatchAnchor.sol";
import {ICapabilityRegistry} from "../../src/ICapabilityRegistry.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {ContextFixtures} from "./ContextFixtures.sol";

abstract contract BatchFixtures is ContextFixtures {
    BatchAnchor internal anchor;
    uint8 internal constant EPISODE = 5;
    bytes32 internal constant TYPEHASH = keccak256(
        "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
    );

    function _deployAnchor() internal {
        _deployContexts();
        anchor = new BatchAnchor(ICapabilityRegistry(address(registry)));
    }

    function _structHash(BatchAnchor.SignedSave memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH, s.owner, s.namespaceId, s.objectNonce, s.lineageId, s.parentId, s.parentVersion, s.rootAuthor,
                s.manifestHash, s.ciphertextCommitment, s.readEpoch, s.expiresAt, s.kind, s.provenanceSource
            )
        );
    }

    function _signSave(BatchAnchor.SignedSave memory s, uint256 key) internal view returns (BatchAnchor.SignedSave memory) {
        bytes32 digest = MidaHashing.typedDigest(
            MidaHashing.domainSeparator("Mida Batch Anchor", block.chainid, address(anchor)), _structHash(s)
        );
        s.signature = _sign(key, digest);
        return s;
    }

    function _unsignedRoot(address owner, bytes32 namespaceId, string memory nonceLabel)
        internal
        view
        returns (BatchAnchor.SignedSave memory s)
    {
        s.owner = owner;
        s.namespaceId = namespaceId;
        s.objectNonce = keccak256(bytes(nonceLabel));
        s.manifestHash = keccak256(abi.encode(nonceLabel, "manifest"));
        s.ciphertextCommitment = sha256(abi.encode(nonceLabel, "ciphertext"));
        s.readEpoch = registry.requiredReadEpoch(owner, namespaceId);
        s.kind = EPISODE;
        s.provenanceSource = SOURCE_AGENT_INFERRED;
    }

    function _rootSave(address owner, string memory namespaceName, string memory nonceLabel, uint256 key)
        internal
        view
        returns (BatchAnchor.SignedSave memory)
    {
        return _signSave(_unsignedRoot(owner, _ns(namespaceName), nonceLabel), key);
    }

    function _contextIdOf(BatchAnchor.SignedSave memory s, bytes32 agentId) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                string("MIDA_BATCH_CONTEXT_V1"), block.chainid, address(anchor), s.owner, agentId, s.namespaceId, s.parentId,
                s.objectNonce
            )
        );
    }

    function _childOf(
        BatchAnchor.SignedSave memory parent,
        bytes32 parentAgentId,
        uint32 parentVersion,
        bytes32 lineageId,
        bytes32 rootAuthor,
        string memory nonceLabel,
        uint256 key
    ) internal view returns (BatchAnchor.SignedSave memory s) {
        s = _unsignedRoot(parent.owner, parent.namespaceId, nonceLabel);
        s.parentId = _contextIdOf(parent, parentAgentId);
        s.lineageId = lineageId;
        s.parentVersion = parentVersion;
        s.rootAuthor = rootAuthor;
        return _signSave(s, key);
    }

    function _oneSave(BatchAnchor.SignedSave memory s) internal pure returns (BatchAnchor.SignedSave[] memory list) {
        list = new BatchAnchor.SignedSave[](1);
        list[0] = s;
    }
}
```

- [ ] **Step 4: Rule tests** `contracts/test/BatchAnchor.t.sol`. Setup mirrors `ContextRoots.t.sol`: `_deployAnchor()`, `alice = _ownerWithKey("alice")`, `writer = _register(registry, "agent-w")`, `other = _register(registry, "agent-o")`, `third = _register(registry, "agent-t")`, `_initEpoch(alice, "goals.career")`; grant `writer` `PERM_CREATE | PERM_SUPERSEDE_OWN` with `PROV_ALLOW_INFERENCE`; `other` only `PERM_READ`; `third` `PERM_SUPERSEDE_OWN` with `PROV_ALLOW_INFERENCE`. One test per row, each asserting the event (`vm.expectEmit`) and state:

| Test | Arrange | Expect |
|---|---|---|
| `test_acceptsRootAndStoresOneRoot` | one valid root save | code below |
| `test_rejectsBadSignature` | save signed by an unregistered key (`makeAddrAndKey("stranger")`) | `SaveRejected(id,0,1)`; root 0 |
| `test_rejectsMalformedSignature` | 64-byte signature | reason 1 |
| `test_rejectsWrongKindOrSource` | `kind = 0`; separately `provenanceSource = SOURCE_IMPORTED` (re-signed) | reason 2 each |
| `test_rejectsUnknownArea` | `namespaceId = keccak256("nope")` (re-signed) | reason 3 |
| `test_rejectsStaleReadEpoch` | rotate the epoch with the same fixture ContextRoots uses for its epoch tests, submit the old `readEpoch` | reason 4 |
| `test_rejectsNoGrant` | save signed by `other` | code below |
| `test_rejectsRevokedMidBatch` | two saves from `writer` signed first; revoke `writer`'s capability (Revocations fixture) before `submitBatch` | both reason 5; `batchOf(id).blockNumber != 0`, root 0 |
| `test_rejectsExpiredGrant` | grant with expiry; `vm.warp` past it | reason 5 |
| `test_duplicateRootSameBatch` | same save twice in one batch | first accepted, second reason 6 |
| `test_duplicateRootAcrossBatches` | accepted in batch A, resent in batch B | reason 6 in B |
| `test_nonceReuseInLineageCannotCollide` | root R (nonce n), child C1 (nonce n2, parent R), child C2 (nonce n, parent C1) | all accepted, 3 distinct contextIds, head commit is C2 version 3 |
| `test_replacementAccepted` | root R, then `_childOf(R, writerId, 1, R_id, writerId, "c1", writerKey)` | accepted, `SaveAnchored.version == 2`, head commit `(c1Id, alice, ns, writerId, 2)` |
| `test_replacementStaleParent` | R, child C1 accepted, then another child of R | reason 7 |
| `test_replacementWrongVersionOrOwner` | child claiming `parentVersion = 2`; separately owner `bob` | reason 7 each |
| `test_replacementOfOtherAuthorNeedsAny` | root by `writer`; child signed by `third` (only SUPERSEDE_OWN) | reason 5; then grant `third` `PERM_SUPERSEDE_ANY` + INFERENCE → accepted |
| `test_partialBatchRootIsAcceptedOnly` | 5 saves, #1 and #3 invalid | root equals `BatchMerkle.root([leaf0, leaf2, leaf4], 3)` computed in the test; positions 0,1,2 |
| `test_batchIdReuseReverts` | submit same id twice | `BatchExists(id)` |
| `test_emptyAndOversize` | `[]`; `MAX_BATCH + 1` saves | `EmptyBatch()`; `BatchTooLarge(1025)` |
| `test_allRejectedSpendsId` | 2 invalid saves | recorded with root 0; resubmit reverts `BatchExists` |
| `test_anyoneCanSubmitButCannotForge` | `vm.prank(makeAddr("courier"))` submits a valid save | accepted, `SaveAnchored.author == writer.agentId` |

```solidity
function test_acceptsRootAndStoresOneRoot() public {
    BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-1", writer.signerKey);
    bytes32 id = keccak256("batch-1");
    (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
    assertEq(accepted, 1);
    bytes32 contextId = _contextIdOf(s, writer.agentId);
    bytes32 leaf = keccak256(
        abi.encode(string("MIDA_BATCH_LEAF_V1"), contextId, writer.agentId, contextId, uint32(1), _structHash(s))
    );
    assertEq(root, leaf);
    (bytes32 stored,, uint32 count) = anchor.batchOf(id);
    assertEq(stored, leaf);
    assertEq(count, 1);
    assertEq(
        anchor.headCommitOf(contextId),
        keccak256(abi.encode(contextId, alice.owner, s.namespaceId, writer.agentId, uint32(1)))
    );
    assertTrue(anchor.hasBatchedSaves(alice.owner));
}

function test_rejectsNoGrant() public {
    BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-x", other.signerKey);
    bytes32 id = keccak256("batch-x");
    vm.expectEmit(true, false, false, true, address(anchor));
    emit BatchAnchor.SaveRejected(id, 0, 5);
    (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
    assertEq(accepted, 0);
    assertEq(root, bytes32(0));
    assertFalse(anchor.hasBatchedSaves(alice.owner));
}
```

- [ ] **Step 5: `BatchParity.t.sol`**: read `test/vectors/batch-v1.json`; assert typehash, struct hash, digest (domain `"Mida Batch Anchor"`, chainId 10143, the vector's `batchAnchor`), contextId formula, leaf formula, head commit and `BatchMerkle.root(leaves, 5)` all equal the vector values.
- [ ] **Step 6: Run** `forge test --root contracts --match-path "test/Batch*"` (all pass), then `forge test --root contracts` (existing contract tests unchanged).
- [ ] **Step 7: Commit** `git add contracts/src/BatchMerkle.sol contracts/src/BatchAnchor.sol contracts/test/utils/BatchFixtures.sol contracts/test/BatchAnchor.t.sol contracts/test/BatchParity.t.sol` then `git commit -m "feat(contracts): BatchAnchor, agent-signed and contract-checked saves under an accepted-only Merkle root"`

---

### Task 3: Gas snapshots, deploy script, deployment record, ABI, local deploy

**Files:**
- Create: `contracts/test/BatchAnchorGas.t.sol`, `contracts/script/DeployBatchAnchor.s.sol`
- Modify: `packages/chain/src/deployment.ts`, `packages/chain/src/local.ts`, regenerate `packages/chain/src/abis.ts`, tests in `packages/chain/test/deployment.test.ts`

**Interfaces — Produces:** `Deployment.batchAnchor?: Address`, `Deployment.batchAnchorBlock?: bigint`; `batchAnchorAbi` from `@mida/chain`; `deployLocal()` returns a `Deployment` with `batchAnchor` set.

- [ ] **Step 1: Gas test.** `BatchAnchorGas.t.sol` extends `BatchFixtures`; for `n` in `[1, 8, 32, 128, 256]` build `n` valid root saves from `writer` (nonces `cp-<i>`), measure `gasleft()` around `submitBatch`, `emit log_named_uint(string.concat("batch_", vm.toString(n), "_per_save"), used / n)`. Also measure one `contexts.register` of an equivalent agent root (`_contextInput(alice.owner, writer.agentId, "goals.career", "direct-1", EPISODE, SOURCE_AGENT_INFERRED)` via `_submit(writer.signer, alice.owner, input)`) and log `direct_per_save`. Assert only that each batch accepted all `n`. These are local estimates for sizing; the evidence file uses testnet numbers (Task 11).
- [ ] **Step 2: Deploy script** `DeployBatchAnchor.s.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BatchAnchor} from "../src/BatchAnchor.sol";
import {ICapabilityRegistry} from "../src/ICapabilityRegistry.sol";

/// @notice Deploys BatchAnchor beside an EXISTING deployment (never redeploys the registries) and adds
///         batchAnchor + batchAnchorBlock to deployments/<chainId>.json, keeping every other key.
contract DeployBatchAnchor is Script {
    function run() external returns (BatchAnchor anchor) {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        address capabilityRegistry = vm.parseJsonAddress(vm.readFile(path), ".capabilityRegistry");
        uint256 deploymentBlock = block.number;

        vm.startBroadcast();
        anchor = new BatchAnchor(ICapabilityRegistry(capabilityRegistry));
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(anchor)), path, ".batchAnchor");
        vm.writeJson(vm.toString(deploymentBlock), path, ".batchAnchorBlock");
        console2.log("BatchAnchor", address(anchor));
    }
}
```

If `vm.writeJson(value, path, key)` cannot add a new key in this Foundry version, re-serialize every existing key the way `Deploy.s.sol` does, plus the two new ones.
- [ ] **Step 3: Deployment type.** Add `batchAnchor?: Address` and `batchAnchorBlock?: bigint` to `Deployment`; in `parseDeployment` parse each only when present (with the file's existing `address()`/`integer()` helpers) and refuse one without the other: `wire("batchAnchor and batchAnchorBlock go together")`. Tests: JSON without them parses exactly as before; with both parses; with one refuses.
- [ ] **Step 4: Local deploy.** In `deployLocal` (`packages/chain/src/local.ts` L98), after `Deploy.s.sol`, run `DeployBatchAnchor.s.sol` against the same RPC and key, then re-read the deployment file.
- [ ] **Step 5: ABI.** `forge build --root contracts`, `pnpm chain:abis`; if `packages/chain/scripts/gen-abis.mjs` lists contracts explicitly, add `BatchAnchor`. Confirm `batchAnchorAbi` is exported.
- [ ] **Step 6: Run** `forge test --root contracts --match-path test/BatchAnchorGas.t.sol -vv` (copy the logged numbers into `DEVIN-REPORT-BA.md`), `pnpm exec vitest run packages/chain --testTimeout 600000 --teardownTimeout 5000`, `pnpm typecheck`.
- [ ] **Step 7: Commit** `git add contracts/test/BatchAnchorGas.t.sol contracts/script/DeployBatchAnchor.s.sol packages/chain/src/deployment.ts packages/chain/src/local.ts packages/chain/src/abis.ts packages/chain/scripts/gen-abis.mjs packages/chain/test/deployment.test.ts` then `git commit -m "feat(chain): deploy BatchAnchor beside existing registries; optional batchAnchor in deployments; gas snapshots"`

---

### Task 4: SDK — sign batched saves; verify anchored (5 checks) and pending items

**Files:**
- Create: `packages/sdk/src/batched.ts`, `packages/sdk/test/batched.test.ts`
- Modify: `packages/sdk/src/agent.ts`, `packages/sdk/src/index.ts`, `apps/api/src/client.ts` (client methods only; routes come in Task 5)

**Interfaces:**
- Consumes: Task 1 primitives; `batchAnchorAbi`; `Deployment.batchAnchor`; `sealContextObject` / `openContextObject` as `#write` (agent.ts L715-719) and `readObject` (L371-383) use them.
- Produces:
  - `interface BatchedSaveWire { message: { …BatchSaveMessage, readEpoch: string, expiresAt: string }; signature: Hex; manifest: ObjectManifest; ciphertext: Hex }`
  - `type BatchedItemState = "QUEUED" | "SUBMITTED" | "ANCHORED"`
  - `interface BatchedReadItem { state: BatchedItemState; save: BatchedSaveWire; contextId: Hex; receivedAt: number; batchId?: Hex; position?: number; lineageId?: Hex; version?: number; proof?: Hex[] }` (anchor fields present only when `ANCHORED`)
  - `interface BatchReceipt { contextId: Hex; receivedAt: number; sequence: string; signature: Hex }`
  - `signBatchSave(input: { account: LocalAccount; chainId: bigint; batchAnchor: Address; message: BatchSaveMessage }): Promise<Hex>`
  - `verifyBatchedItem(input: { item: BatchedReadItem; chainId: bigint; deployment: Deployment; client: PublicClient; requireLatest: boolean }): Promise<{ ok: true; agentId: Hex } | { ok: false; reason: "ciphertext" | "manifest" | "signature" | "author" | "unknown-batch" | "proof" | "stale" | "not-anchored" }>`
  - `verifyPendingItem(input: { item: BatchedReadItem; chainId: bigint; deployment: Deployment; client: PublicClient }): Promise<{ ok: true; agentId: Hex } | { ok: false; reason: "ciphertext" | "manifest" | "signature" | "author" | "no-authority" | "not-pending" }>`
  - `MidaAgent.createBatched(owner: Address, namespace: string, input: CreateContextInput): Promise<{ contextId: Hex; state: "QUEUED"; receipt: BatchReceipt }>`
  - `MidaAgent.readBatchedWithStatus(owner: Address, namespace: string): Promise<{ anchored: ContextObject[]; pending: (ContextObject & { anchor: "PENDING_ANCHOR"; authorAgentId: Hex })[]; skipped: { contextId: Hex; reason: string }[]; partial: boolean }>`
  - client: `batchStatus()`, `postBatchSave(body: BatchedSaveWire)`, `getBatchSave(contextId: Hex)`, `listBatchSaves(input: { owner: Address; namespaceId: Hex })` (returns `{ items: BatchedReadItem[]; partial: boolean }`), `flushBatch()` (returns `{ flushed: boolean; reason?: "empty" | "rate-limited" }`)

`verifyBatchedItem` (anchored), in order, first failure wins:
1. `sha256(ciphertext) == message.ciphertextCommitment` else `"ciphertext"`; manifest hash equals `message.manifestHash` and the manifest's ciphertext hash equals the commitment, else `"manifest"`.
2. Recover the signer from `batchSaveDigest`; `agentIdOfSigner(signer)` on CapabilityRegistry non-zero, else `"signature"`.
3. `batchContextId(...)` with the recovered agentId must equal `item.contextId`, else `"author"`.
4. `state !== "ANCHORED"` → `"not-anchored"`. `batchOf(batchId)` on BatchAnchor: `blockNumber == 0` → `"unknown-batch"`; `verifyMerkleProof(batchLeafHash({ contextId, agentId, lineageId, version, structHash }), proof, root)` false → `"proof"` (acceptance implied, R4).
5. `requireLatest` → `headCommitOf(lineageId) == headCommit({ contextId, owner, namespaceId, rootAuthor: version === 1 ? agentId : message.rootAuthor, version })` else `"stale"`.

`verifyPendingItem` (Amendment B.2): `state` must be QUEUED or SUBMITTED (else `"not-pending"`); checks 1–3 as above; then `hasAuthority(owner, agentId, namespaceId, PERM_CREATE, PROV_ALLOW_INFERENCE)` on CapabilityRegistry read now, else `"no-authority"` (a revoked agent's pending save never reaches a handoff).

Every chain read goes to BatchAnchor/CapabilityRegistry through `client`, never through the store.

- [ ] **Step 1: Failing tests** `packages/sdk/test/batched.test.ts` with `localEnvironment()` (Anvil + both deploy scripts). Reuse the agent/grant setup of the smallest existing SDK e2e test (`grep -rln "localEnvironment" packages/sdk/test`). Submit valid saves straight to BatchAnchor from a test wallet, then:
  - anchored, honest → ok
  - one ciphertext byte flipped → `"ciphertext"`
  - one proof element replaced → `"proof"`
  - a save the contract REJECTED (NO_AUTHORITY) given an accepted neighbour's proof → `"proof"`
  - signature from another key → `"signature"`
  - after a replacement landed, `requireLatest: true` → `"stale"`, `false` → ok
  - unknown batchId → `"unknown-batch"`
  - pending honest (never submitted) → ok
  - pending after the agent's grant is revoked → `"no-authority"`
  - pending with flipped ciphertext → `"ciphertext"`
  - pending item presented with `state: "ANCHORED"` and no proof to `verifyBatchedItem` → `"not-anchored"` or `"unknown-batch"`, never ok
- [ ] **Step 2: FAIL. Step 3: implement `batched.ts`** (sha256 the way `#write` hashes ciphertext; `recoverTypedDataAddress` from viem).
- [ ] **Step 4: `createBatched`**: seal exactly as `#write` does with `expectedParentId = zeroHash`; build the message (lineage/parent/rootAuthor zero, parentVersion 0, readEpoch from the source `#write` uses, `kind`/`provenanceSource` via the existing maps); sign with the agent's chain account; `this.#api.postBatchSave(...)`; return the receipt. No `sendContract`.
- [ ] **Step 5: `readBatchedWithStatus`**: `this.#api.listBatchSaves(...)`; ANCHORED items → `verifyBatchedItem(requireLatest: true)`; QUEUED/SUBMITTED → `verifyPendingItem`; decrypt passing items as `readObject` does; failures into `skipped`.
- [ ] **Step 6: PASS; `pnpm typecheck`; `pnpm exec vitest run packages/sdk` (existing unchanged).**
- [ ] **Step 7: Commit** `git add packages/sdk/src/batched.ts packages/sdk/src/agent.ts packages/sdk/src/index.ts packages/sdk/test/batched.test.ts apps/api/src/client.ts` then `git commit -m "feat(sdk): sign batched saves; verify anchored saves (five checks) and pending saves against the chain"`

---

### Task 5: Store — batch rows, routes, receipts, flush (Node + D1)

**Files:**
- Create: `apps/api/src/batch-store.ts`, `apps/api/src/batch-routes.ts`, `apps/api/test/batch-routes.test.ts`, `apps/store-worker/test/batch-store.test.ts`
- Modify: `apps/api/src/app.ts` (`ContextApiOptions.batching?: BatchingOptions`; mount when set), `apps/store-worker/schema.sql`, `apps/store-worker/src/d1.ts`

**Interfaces — Produces:**
- `type BatchSaveState = "QUEUED" | "SUBMITTED" | "ANCHORED" | "REJECTED"`
- `interface BatchSaveRow { contextId: Hex; owner: Address; namespaceId: Hex; signer: Address; save: BatchedSaveWire; state: BatchSaveState; reason: string | null; batchId: Hex | null; position: number | null; lineageId: Hex | null; version: number | null; proof: Hex[] | null; receivedAt: number; anchoredAt: number | null }`
- `interface BatchStore { insert(row: BatchSaveRow): Promise<"inserted" | "exists">; get(contextId: Hex): Promise<BatchSaveRow | null>; listForReader(owner: Address, namespaceId: Hex): Promise<BatchSaveRow[]> /* QUEUED, SUBMITTED, ANCHORED; never REJECTED */; takeQueued(limit: number, batchId: Hex): Promise<BatchSaveRow[]> /* atomically QUEUED → SUBMITTED */; markAnchored(contextId: Hex, f: { batchId: Hex; position: number; lineageId: Hex; version: number; proof: Hex[]; anchoredAt: number }): Promise<void>; markRejected(contextId: Hex, reason: string): Promise<void>; requeue(batchId: Hex): Promise<number>; nextSequence(): Promise<bigint>; countQueued(): Promise<number>; lastFlush(signer: Address): Promise<number | null>; setLastFlush(signer: Address, atMs: number): Promise<void> }`
- `interface BatchingOptions { enabled: boolean; batchAnchor: Address; store: BatchStore; receiptAccount: LocalAccount; notify: () => void; flush: () => Promise<void>; now?: () => number }`
- Receipt signature: `receiptAccount.signMessage({ message: { raw: keccak256(encodeAbiParameters([string, bytes32, uint256, uint256], ["MIDA_BATCH_RECEIPT_V1", contextId, receivedAt, sequence])) } })`
- Routes (signed with the existing `x-mida-*` request auth except status):
  - `GET /batch/status` → `{ enabled: boolean; batchAnchor: Address }` (public)
  - `POST /batch/saves` body `BatchedSaveWire` → `201 { state: "QUEUED", receipt }`; `409 ALREADY_QUEUED`; `503 BATCHING_DISABLED`; `400` codes: `SIGNER_MISMATCH` (save signature not from the request signer), `NOT_AN_AGENT` (`agentIdOfSigner == 0`), `COMMITMENT_MISMATCH` (ciphertext/manifest), `BAD_SHAPE` (provenance not AGENT_INFERRED, kind 0, non-zero parent fields for a new lineage), `TOO_LARGE` (same size limit as `PUT /objects`). On success calls `notify()`.
  - `GET /batch/saves/:contextId` → `{ state, reason, item?: BatchedReadItem }`; caller must be the owner, the uploading signer, or an agent with READ on the namespace (reuse the authorization `GET /objects` uses).
  - `GET /batch/saves?owner=&namespaceId=` → `{ items: BatchedReadItem[] }` from `listForReader` (anchored AND pending, each with its `state`), same authorization as `GET /objects`.
  - `POST /batch/flush` (signed by any registered agent signer or the owner) → if `countQueued() == 0` → `200 { flushed: false, reason: "empty" }`; if the signer flushed less than 10 s ago → `200 { flushed: false, reason: "rate-limited" }`; else `setLastFlush`, `await flush()`, `200 { flushed: true }`.

- [ ] **Step 1: Failing tests** `apps/api/test/batch-routes.test.ts` (construct like `routes.test.ts` L139 with `batching` options and a fake reader whose `agentIdOfSigner` knows the test signer). Cases: disabled → 503; valid → 201 + receipt recovering to the receipt account + `notify` called once; repeat → 409; each 400 code; stranger GET → 403; GET before anchoring → QUEUED, no anchor fields; after `markAnchored` → anchor fields; list returns QUEUED and ANCHORED rows but not REJECTED; flush empty → `"empty"`; flush twice within 10 s → second `"rate-limited"`; flush after 10 s (injected `now`) → `flushed: true` and `flush` called.
- [ ] **Step 2: FAIL. Step 3: implement** `batch-store.ts` (`FsBatchStore` under `dataDir/batch/`: one JSON file per row, `meta.json` for sequence and flush times; `takeQueued` under an in-process mutex) and `batch-routes.ts`; mount in `app.ts` only when `options.batching` is set. Ciphertext stays with the row (Amendment A.4), never in `objects`.
- [ ] **Step 4: D1.** Append to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS batch_saves (
  context_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  signer TEXT NOT NULL,
  save_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED','SUBMITTED','ANCHORED','REJECTED')),
  reason TEXT,
  batch_id TEXT,
  position INTEGER,
  lineage_id TEXT,
  version INTEGER,
  proof_json TEXT,
  received_at INTEGER NOT NULL,
  anchored_at INTEGER
);
CREATE INDEX IF NOT EXISTS batch_saves_state ON batch_saves (state, received_at);
CREATE INDEX IF NOT EXISTS batch_saves_owner_ns ON batch_saves (owner, namespace_id, state);
CREATE INDEX IF NOT EXISTS batch_saves_batch ON batch_saves (batch_id);
CREATE TABLE IF NOT EXISTS batch_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

`D1BatchStore` in `d1.ts`: `takeQueued` is one statement, `UPDATE batch_saves SET state='SUBMITTED', batch_id=?1 WHERE context_id IN (SELECT context_id FROM batch_saves WHERE state='QUEUED' ORDER BY received_at LIMIT ?2) RETURNING *`, so two alarm runs can never take the same row; `nextSequence` is one `INSERT … ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`; flush times are `batch_meta` keys `flush:<signer>`. Tests in `apps/store-worker/test/batch-store.test.ts` use the `D1Like` fake from `sweep.test.ts`.
- [ ] **Step 5: Run** both files, `pnpm exec vitest run apps/api`, `pnpm exec vitest run apps/store-worker`, `pnpm typecheck`.
- [ ] **Step 6: Commit** `git add apps/api/src/batch-store.ts apps/api/src/batch-routes.ts apps/api/src/app.ts apps/api/test/batch-routes.test.ts apps/store-worker/schema.sql apps/store-worker/src/d1.ts apps/store-worker/test/batch-store.test.ts` then `git commit -m "feat(store): batched-save queue, routes, signed QUEUED receipts and rate-limited flush (off unless enabled)"`

---

### Task 6: The batcher + Durable Object + Node wiring

**Files:**
- Create: `apps/api/src/batcher.ts`, `apps/api/test/batcher.test.ts`, `apps/store-worker/src/batch-coordinator.ts`, `apps/store-worker/test/batch-coordinator.test.ts`
- Modify: `apps/store-worker/src/worker.ts`, `apps/store-worker/wrangler.toml`, `apps/cli/src/environment.ts`

**Interfaces:**
- Consumes: `BatchStore`, `batchAnchorAbi`, `merkleRoot/merkleProof`, `BATCH_REJECT`, `sendContract`, `getLogsChunked`.
- Produces:
  - `interface BatcherTimer { set(atMs: number): Promise<void> | void; clear(): Promise<void> | void; pending(): Promise<boolean> | boolean }`
  - `interface BatcherChain { submit(batchId: Hex, saves: BatchedSaveWire[]): Promise<{ transactionHash: Hex } | { exists: true }>; anchoredLogs(batchId: Hex): Promise<{ contextId: Hex; position: number; lineageId: Hex; version: number; leafHash: Hex }[]>; rejectedLogs(batchId: Hex): Promise<{ index: number; reason: number }[]>; batchOf(batchId: Hex): Promise<{ root: Hex; blockNumber: bigint }>; findAnchoring(contextId: Hex): Promise<Hex | null> }`
  - `class Batcher { constructor(o: { store: BatchStore; chain: BatcherChain; timer: BatcherTimer; now: () => number; cap: number; waitMs: number; submitter: Address; log?: (r: Record<string, unknown>) => void }); notify(): Promise<void>; flush(): Promise<void>; run(): Promise<{ batchId: Hex; accepted: number; rejected: number } | null>; resolve(batchId: Hex): Promise<void>; recover(): Promise<void> }`
  - `createBatcherChain(input: { rpcUrl: string; deployment: Deployment; account: LocalAccount }): BatcherChain`

Rules the tests pin:
1. `notify()`: `countQueued() >= cap` → `run()` now; else if no timer pending → `timer.set(now() + waitMs)`. A pending timer is never moved.
2. `flush()`: clear the timer and `run()` now (Amendment B.4). Rows keep their order.
3. `run()`: `batchId = keccak256(encodeAbiParameters([address, uint256], [submitter, nextSequence()]))`; `takeQueued(cap, batchId)`; none → clear timer, return null; submit in the rows' `receivedAt` order (a row's index in the call is its position in `SaveRejected`); then `resolve(batchId)`; rows still QUEUED → set the timer again.
4. `submit` → `{ exists: true }` (BatchExists after a crash between send and record) → `resolve(batchId)`; the contract guarantees nothing executes twice.
5. `resolve(batchId)`: anchored logs ordered by position; rebuild `merkleRoot(leaves)` and REQUIRE equality with `batchOf(batchId).root` (else throw `ROOT_MISMATCH`, leave rows SUBMITTED); mark each accepted row ANCHORED with `merkleProof(leaves, position)`; map `rejectedLogs` indices back to the submitted rows and mark REJECTED with the `BATCH_REJECT` name; a row rejected `ALREADY_ANCHORED` → `findAnchoring(contextId)`; found → rebuild that batch's leaves and mark ANCHORED with its proof; not found → REJECTED.
6. `recover()` (on start): every SUBMITTED batch → `resolve` if `batchOf(batchId).blockNumber != 0`, else `requeue(batchId)`.
7. Submit errors other than BatchExists → `requeue(batchId)`, log, set the timer again.

- [ ] **Step 1: Failing tests** `apps/api/test/batcher.test.ts` with an in-memory `BatchStore`, a fake chain that simulates the contract (scripted accept/reject; root via Task 1 `merkleRoot`) and a manual timer: first save sets the timer once; ten more saves in the window do not move it; cap triggers an immediate run; `flush()` runs immediately with one queued save; crash after submit (simulate by throwing after the fake records the batch) then `run()`/`recover()` → `{ exists: true }` path, one batch, no duplicate states; partial batch → REJECTED names correct and every accepted proof verifies with `verifyMerkleProof`; logs that disagree with the root → `ROOT_MISMATCH`, rows stay SUBMITTED; ALREADY_ANCHORED resolved through `findAnchoring`; transient submit error → rows QUEUED, timer set; `recover()` requeues SUBMITTED rows of a batch the chain never recorded.
- [ ] **Step 2: FAIL. Step 3: implement `batcher.ts`** including `createBatcherChain` (`sendContract` with `functionName: "submitBatch"`; map a `BatchExists` revert to `{ exists: true }` with the same revert-name walk `toMidaError` uses; logs via `getLogsChunked` from `deployment.batchAnchorBlock`; `findAnchoring` filters `SaveAnchored` by the indexed `contextId`).
- [ ] **Step 4: Durable Object** `batch-coordinator.ts`: `export class BatchCoordinator` with `fetch()` routes `/notify` → `notify()`, `/flush` → `flush()`; `alarm()` → `run()`; timer maps to `this.ctx.storage.setAlarm/deleteAlarm/getAlarm`; the constructor runs `recover()` once under `ctx.blockConcurrencyWhile`. `worker.ts`: new env fields `BATCH_ANCHOR`, `BATCHING_ENABLED`, `BATCHER_PRIVATE_KEY` (secret), `RECEIPT_PRIVATE_KEY` (secret), `BATCH_COORDINATOR` (DO namespace); batch routes get `enabled: env.BATCHING_ENABLED === "true"`, `notify`/`flush` call the single DO instance (`idFromName("batcher")`); export `BatchCoordinator`. `wrangler.toml`: `[[durable_objects.bindings]] name = "BATCH_COORDINATOR" class_name = "BatchCoordinator"`, `[[migrations]] tag = "batch-v1" new_sqlite_classes = ["BatchCoordinator"]`, vars `BATCH_ANCHOR = "REPLACE_WITH_BATCH_ANCHOR"`, `BATCHING_ENABLED = "false"`. Test the timer mapping with a fake `ctx.storage` (alarm set once, never moved; flush deletes it and runs).
- [ ] **Step 5: Node wiring**: `apps/cli/src/environment.ts` `startApiServer` builds a `Batcher` (timer = `setTimeout`, `waitMs` option default 2000, 200 in tests; submitter = the funded Anvil key already used there) when the deployment has `batchAnchor`, and passes `batching` options with `enabled: true`.
- [ ] **Step 6: Run** new tests, `pnpm exec vitest run apps/api`, `pnpm exec vitest run apps/store-worker`, `pnpm typecheck`.
- [ ] **Step 7: Commit** `git add apps/api/src/batcher.ts apps/api/test/batcher.test.ts apps/store-worker/src/batch-coordinator.ts apps/store-worker/test/batch-coordinator.test.ts apps/store-worker/src/worker.ts apps/store-worker/wrangler.toml apps/cli/src/environment.ts` then `git commit -m "feat(store): batcher with a fixed 2s window, flush, idempotent submit, proofs only from a root that matches the chain"`

---

### Task 7: Daemon — lane switch, batched checkpoint save, pending ledger, doctor, `mida batching on|off`

**Files:**
- Create: `apps/midad/src/batching.ts`, `apps/midad/test/batching.test.ts`
- Modify: `apps/midad/src/network.ts` (`SavedNetwork.batching?: boolean`, L79-84), `apps/midad/src/skeleton.ts` (`saveCheckpoint`, L539), `apps/midad/src/drain.ts`, `apps/midad/src/doctor.ts`, `apps/midad/src/cli.ts`

**Interfaces — Produces:**
- `type Lane = { kind: "batched"; storeUrl: string; batchAnchor: Address } | { kind: "direct"; why: "switch-off" | "no-batch-anchor" | "local-store" | "store-disabled" | "store-unreachable" }`
- `decideLane(input: { saved: SavedNetwork | undefined; deployment: Deployment; storageUrl: string | undefined; status: () => Promise<{ enabled: boolean; batchAnchor: Address } | null> }): Promise<Lane>`
- ledgers: `state/batch-pending.json` `{ entries: { contextId: Hex; eventId: string; sessionId: string; agent: string; queuedAt: string; state: "QUEUED" | "SUBMITTED" }[] }`; `state/batch-rejected.json` `{ entries: { contextId: Hex; eventId: string; sessionId: string; agent: string; reason: string; at: string }[] }`
- `followPendingAnchors(runtime: ServiceRuntime, log: (r: Record<string, unknown>) => void): Promise<{ anchored: number; rejected: number; waiting: number }>`
- `saveCheckpoint` return gains `batched?: { state: "QUEUED"; receipt: BatchReceipt }` (existing fields unchanged; `transactionHash: null` when batched)

Behaviour:
1. `decideLane` → `direct` unless ALL hold: `saved.batching === true`; `deployment.batchAnchor` set; `storageUrl` set; `status()` returns `enabled: true` with the same `batchAnchor`. A status error → `direct` / `store-unreachable` (the save still happens directly, and the drain log line says `lane: "direct", laneWhy: "store-unreachable"`).
2. `saveCheckpoint`: after the duplicate check (L561-566), batched lane → `agent.createBatched(...)` with the same arguments as `agent.create` (L568-573); `recordSavedId`; append a pending entry; return `{ contextId, transactionHash: null, milliseconds, duplicate: false, batched: { state: "QUEUED", receipt } }`. When the lane is batched the duplicate check also looks at `readBatchedWithStatus` (anchored + pending).
3. `drain.ts`: after a batched save the capture job is removed as after a direct save (the save is now owned by the pending ledger) and the log line is `outcome: "queued"`, `contextId`, `lane: "batched"`. At the end of every `drainPass`, `followPendingAnchors`: `getBatchSave` per entry; ANCHORED → remove, log `outcome: "saved"`, `lane: "batched"`, `batchId`; REJECTED → move to the rejected ledger, log `outcome: "failed"`, `reason: "batch-rejected:<REASON>"`; else update `state`; a status error leaves the entry untouched (never dropped).
4. Doctor check `"batching"` after `"queue"` (doctor.ts L673-682): first line is the lane (`ok: checkpoint saves: batched via <host>` / `ok: checkpoint saves: one transaction each`); each rejected entry → `PROBLEM: a checkpoint save was rejected on chain (<reason>, session <sessionId>) — it was not anchored; check the agent's approval with \`mida doctor\``; pending older than 10 minutes → `PROBLEM: <n> checkpoint save(s) waiting to anchor for over 10 minutes — check the store at <host>`; pending younger → `note: <n> checkpoint save(s) pending anchor (PENDING_ANCHOR)`.
5. `mida batching on|off`: add `"batching"` to `CLI_COMMANDS`, `OWNER_COMMANDS`, `TERMINAL_COMMANDS` (cli.ts L45-52); a branch in `runOwnerCommand` before the trailing `revoke` else. `on`: compute the lane as if `batching: true`; still `direct` → print `batching cannot be turned on: <why in plain words>` and return 1; else print `automatic checkpoint saves will be anchored in shared batches via <host>; grants, revokes and facts are unaffected; saves are usable at once and marked PENDING_ANCHOR until anchored`, `await drain()`, prompt `Type yes to turn batching on: `, write `batching: true` preserving every other `network.json` field, kick the daemon (as approve does). `off`: write `batching: false`, print `batching is off; saves already queued will still finish`. Anything else → usage.

- [ ] **Step 1: Failing tests** (fake runtime + fake api): each `decideLane` condition and `why`; status failure → direct; `followPendingAnchors` ANCHORED/REJECTED/unchanged/error paths and log lines; doctor lines with an injected clock; `batching on` refusal line; `on` keeps `rpcUrl`, `deployment`, `storageUrl`, `sponsorUrl` identical; `off`; `batching` absent → direct (existing behaviour).
- [ ] **Step 2: FAIL → implement → PASS.** Then every existing midad test file that touches `saveCheckpoint`, drain, doctor or cli, one by one (`ls apps/midad/test`), and `pnpm typecheck`.
- [ ] **Step 3: Commit** `git add apps/midad/src/batching.ts apps/midad/src/network.ts apps/midad/src/skeleton.ts apps/midad/src/drain.ts apps/midad/src/doctor.ts apps/midad/src/cli.ts apps/midad/test/batching.test.ts` then `git commit -m "feat(midad): batched checkpoint lane behind \`mida batching on\`; saves stay owned until ANCHORED or REJECTED"`

---

### Task 8: Readers — handoff with anchored + verified pending, flush on agent switch, history scan, migrate guard

**Files:**
- Modify: `apps/midad/src/skeleton.ts` (`readCheckpoints`, L610), `apps/midad/src/handoff.ts` (render the marker), `apps/midad/src/owner-read.ts` (`readOwnerUniverse`, L75), `apps/midad/src/migrate.ts`
- Test: `apps/midad/test/batch-readers.test.ts`

**Interfaces:**
- Consumes: `readBatchedWithStatus`, `flushBatch`, `batchAnchorAbi`, `getLogsChunked`.
- Produces: `StoredCheckpoint` gains `anchor: "ANCHORED" | "PENDING_ANCHOR"` (direct saves are `"ANCHORED"`); `readCheckpoints` also accepts `options?: { flushWaitMs?: number }` (default 3000); `readOwnerUniverse` items gain `lane: "direct" | "batched"`; migrate refusal codes `batched-saves-present`, `batched-check-failed`.

Behaviour:
1. `readCheckpoints(runtime, name, projectId)`: when `deployment.batchAnchor` is set (regardless of the switch; saves may exist from a past trial), call `readBatchedWithStatus(owner, NAMESPACE)`.
2. **Flush on agent switch (Amendment B.4):** if any pending item's `authorAgentId` differs from the reading agent's id, call `flushBatch()` (ignore `empty`/`rate-limited`), then re-read every 250 ms until those items are ANCHORED or `flushWaitMs` has passed. Never wait when every pending item is the reader's own.
3. Merge anchored (`anchor: "ANCHORED"`) and verified pending (`anchor: "PENDING_ANCHOR"`) with direct checkpoints, sorted by the key the function already sorts on; verification failures count into `skipped`; `partial` is true if any source is partial.
4. `handoff.ts`: a `PENDING_ANCHOR` checkpoint is rendered with the line `PENDING_ANCHOR: not yet anchored on Monad; may still be rejected` directly above its content. No other wording anywhere may call it saved, final or verified on chain.
5. `readOwnerUniverse`: when `deployment.batchAnchor` is set, also `getLogsChunked` over `SaveAnchored` with `args: { owner: runtime.owner }`, `fromBlock: deployment.batchAnchorBlock`, same `maxRange` and `onProgress`; each log becomes a `lane: "batched"` item (contextId, lineageId, version, batchId, author).
6. `migrate`: right after resolving the source network, if `source.batchAnchor` is set, read `hasBatchedSaves(owner)` on chain. `true` → print `this setup has batched checkpoint saves; migrate cannot move them yet` and refuse `batched-saves-present`; a failed read → print `could not check for batched saves; migrate stops rather than guess` (plus the masked detail under `MIDA_DEBUG=1`) and refuse `batched-check-failed`; no `batchAnchor` → skip.

- [ ] **Step 1: Failing tests** `apps/midad/test/batch-readers.test.ts` (fake api + fake chain client): anchored item merged as ANCHORED; tampered anchored item skipped; pending item from the SAME agent returned as PENDING_ANCHOR with no flush call; pending item from ANOTHER agent → `flushBatch` called once, and when the fake anchors it within the wait it comes back ANCHORED, otherwise PENDING_ANCHOR after `flushWaitMs` (use 300 in the test); a pending item whose agent was revoked is skipped; handoff text contains the exact `PENDING_ANCHOR` line for pending items only; `readOwnerUniverse` returns batched items from a fake log client; migrate refuses on `true`, refuses on a thrown read, proceeds when `batchAnchor` is absent (helpers from `apps/midad/test/helpers-migrate.ts`).
- [ ] **Step 2: FAIL → implement → PASS.** Then each migrate test file one by one (`migrate-manifest`, `migrate-steps.e2e`, `migrate-verify.e2e`, `migrate.e2e`, `migration-envelope`), the owner-read, skeleton and handoff test files, `pnpm typecheck`.
- [ ] **Step 3: Commit** `git add apps/midad/src/skeleton.ts apps/midad/src/handoff.ts apps/midad/src/owner-read.ts apps/midad/src/migrate.ts apps/midad/test/batch-readers.test.ts` then `git commit -m "feat(midad): handoff shows anchored plus verified PENDING_ANCHOR saves, flushes on agent switch; migrate refuses fail-closed"`

---

### Task 9: Indexer counts

**Files:** Modify `apps/indexer/config.yaml` (contract `BatchAnchor`, address `0x0000000000000000000000000000000000000000` with comment `# set on merge from contracts/deployments/10143.json batchAnchor`, events `SaveAnchored`, `SaveRejected`, `BatchAnchored`), create `apps/indexer/abi/BatchAnchor.json` (from `contracts/out/BatchAnchor.sol/BatchAnchor.json` `.abi`), modify `apps/indexer/schema.graphql` (entity `BatchStats { id: ID!, batches: Int!, anchoredSaves: Int!, rejectedSaves: Int! }`), `apps/indexer/src/EventHandlers.ts` (increment; per-owner `batchedSaves` on the existing owner entity if one exists), tests in the indexer's existing test location (`ls apps/indexer/test`).

Envio only counts; nothing in `apps/midad` or `packages/sdk` reads it (R7).

- [ ] Tests FAIL → implement → PASS with the indexer's own test command → commit `git add apps/indexer/config.yaml apps/indexer/abi/BatchAnchor.json apps/indexer/schema.graphql apps/indexer/src/EventHandlers.ts apps/indexer/test` then `git commit -m "feat(indexer): count batched saves and batches (display only)"`

---

### Task 10: End to end on a local chain

**Files:** Create `apps/midad/test/batch.e2e.test.ts` (uses `localEnvironment()` with the Node batcher, `waitMs` 200).

Scenarios, one `it` each:
1. Switch on → a checkpoint save returns QUEUED → an immediate `readCheckpoints` by the SAME agent returns it as `PENDING_ANCHOR` with verified content → within 5 s `followPendingAnchors` reports it anchored → `readCheckpoints` returns it as `ANCHORED`.
2. Claude-agent saves; Codex-agent reads within the window → the flush fires, and the checkpoint arrives `ANCHORED` inside the 3 s wait (assert one batch transaction happened before the read returned).
3. Revoke the agent while its save is QUEUED (pause the timer, revoke, release) → REJECTED `NO_AUTHORITY` → it no longer appears in `readCheckpoints` → the doctor `"batching"` check prints the PROBLEM line.
4. `mida migrate` on this home refuses `batched-saves-present`.
5. Switch off → the next save is a direct ContextRegistry save (`transactionHash` non-null, `anchor: "ANCHORED"`).
6. `batching` absent from `network.json` → direct lane; `hasBatchedSaves(owner)` stays false.
7. Twenty saves from two agents inside one window → one batch transaction, twenty ANCHORED, every proof verifies.

- [ ] Write → run `pnpm exec vitest run apps/midad/test/batch.e2e.test.ts --testTimeout 600000 --teardownTimeout 5000` → full suite `pnpm test` (report exact totals) → commit `git add apps/midad/test/batch.e2e.test.ts` then `git commit -m "test(e2e): batched checkpoint lane end to end on a local chain"`

---

### Task 11: Testnet benchmark script and trial runbook (script written by Devin, run by Dami)

**Files:** Create `scripts/bench-batch-anchor.ts`, `scripts/bench-batch-anchor.test.ts` (pure helpers: percentiles, per-save division, evidence JSON shape), `docs/batching-trial-runbook.md`.

The script (Devin never runs it against testnet):
- Inputs: `MONAD_TESTNET_RPC`, `DEPLOYER_PRIVATE_KEY`, deployment `10143.json` (must have `batchAnchor`), `--saves <n>`, `--batch <size>`, `--agents <k>`, `--price-usd <MON price>` (required; recorded with the date), optional `--store <url>`.
- Setup: `k` throwaway agents under a throwaway owner (reuse `apps/cli` scenario helpers), CREATE + INFERENCE on one namespace, funded by the deployer.
- Direct phase: `min(n, 20)` checkpoint-shaped saves via `ContextRegistry.register`, one per transaction.
- Batched phase: `n` signed saves via `submitBatch` in batches of `--batch`.
- Per transaction: `gasUsed`, `gasLimit`, `effectiveGasPrice`; "charged" = `gasLimit × effectiveGasPrice` (Monad bills the reserved limit). With `--store`, queued→anchored latency p50/p95 through the real store.
- Writes `docs/evidence/batch-anchor-benchmark-<YYYY-MM-DD>.json`: `{ date, chainId, batchAnchor, contextRegistry, monPriceUsd, direct: { saves, txs, chargedWeiPerSave, gasUsedPerSave }, batched: { saves, txs, batchSize, chargedWeiPerSave, gasUsedPerSave, rejected, latencyMs?: { p50, p95 } }, maxSavesPerTxObserved, notes }`.
- Refuses to start when the deployer balance is below its own estimate (from a one-batch probe), printing both numbers.

Runbook: the three-step trial switch (spec §8), the kill switch, how to read the doctor lane line, what `PENDING_ANCHOR` means, and one plain line per rejection code.

- [ ] Helper tests FAIL → implement → PASS → `pnpm typecheck` → commit `git add scripts/bench-batch-anchor.ts scripts/bench-batch-anchor.test.ts docs/batching-trial-runbook.md` then `git commit -m "chore(bench): testnet batch-anchor benchmark script and trial runbook"`

---

### Task 12: Gates before merge (Claude + Dami, not Devin)

- [ ] Dami deploys BatchAnchor on testnet in Terminal.app: `forge script contracts/script/DeployBatchAnchor.s.sol --root contracts --rpc-url "$MONAD_TESTNET_RPC" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"`, then `pnpm run deployments:gen`; commit `contracts/deployments/10143.json` and `packages/chain/src/deployments.generated.ts` on the branch.
- [ ] Dami runs a small benchmark (`--saves 20 --batch 20`), then one sized to the MON available; the evidence file is committed.
- [ ] Claude writes the judge line only from the evidence file.
- [ ] One Opus adversarial review of the whole branch, told to make it fail: forged proofs, reordered logs, alarm double-fire, flush spam, revoke races against pending saves, nonce reuse, a pending save shown as final anywhere, migrate on a network error, switch-off mid-queue. Findings fixed or explicitly accepted by Dami.
- [ ] `pnpm test` and `forge test --root contracts` green at the branch head; totals copied from the runner output.
- [ ] Dami's explicit yes → merge `batch-anchor` into `p0-m0-skeleton`. Then Dami deploys the store worker (DO binding, `BATCHING_ENABLED=false` at first, `BATCHER_PRIVATE_KEY` and `RECEIPT_PRIVATE_KEY` secrets, batcher wallet funded) and the indexer config with the real address. Default stays off.

---

## Self-review

- Spec coverage: R1 (constraints, Task 3 deploy beside), R2 (Task 7, `saveCheckpoint` only), R3 (Task 2), R4 (Task 2 in-contract root; Task 6 `ROOT_MISMATCH`), R5 (Task 2), R6 (Task 2 duplicate and nonce-reuse rows), R7 (Task 9), R8 (Task 7 `decideLane`), R9 (Task 12). §5.2 → Task 2 table. §6 states and fixed timer → Tasks 5–7. §7.1 five checks → Task 4. §7.3 → Task 8. §7.4 fail-closed → Task 8. §8 switch, kill switch, runbook → Tasks 6, 7, 11. §9 → Tasks 2–11. §10 → Task 12. §11: DO binding (Task 6; Dami confirms the Cloudflare plan at deploy); the QUEUED-in-handoff question is decided by Amendment B (Tasks 4, 5, 8, 10).
- Amendment B coverage: B.1/B.3 → Task 8 merge + handoff line; B.2 → Task 4 `verifyPendingItem`; B.4 → Task 5 `/batch/flush` (auth, empty skip, 10 s limit), Task 6 `flush()`, Task 8 switch detection, Task 10 scenario 2; B.5 → Task 7 doctor, Task 10 scenario 3.
- Names used identically across tasks: `BatchSaveMessage`, `BatchedSaveWire`, `BatchedReadItem`, `BatchedItemState`, `BatchReceipt`, `BatchStore`, `BatchSaveRow`, `BatchingOptions`, `Batcher`, `BatcherChain`, `BatcherTimer`, `createBatcherChain`, `Lane`, `decideLane`, `followPendingAnchors`, `verifyBatchedItem`, `verifyPendingItem`, `createBatched`, `readBatchedWithStatus`, `flushBatch`, `batchAnchorAbi`, `Deployment.batchAnchor` / `batchAnchorBlock`, `StoredCheckpoint.anchor`.
- Risk to watch first: `hasAuthority` cost on Monad (cold reads ~4x Ethereum's) likely dominates per-save gas; Task 3's gas test shows it locally before any testnet spend.
