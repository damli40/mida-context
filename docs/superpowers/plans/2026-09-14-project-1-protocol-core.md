# Mida Context Project 1 — Protocol Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mida Context protocol core and pass the §16 end-to-end scenario, first against local Anvil and then against Monad testnet, with no UI.

**Architecture:** A pnpm TypeScript monorepo holds pure packages (protocol types and IDs, crypto, storage, grant advisor), a viem chain adapter, a software FakeVault, an agent SDK, a thin Hono Context API, and a CLI harness. Two Foundry contracts hold authority: `CapabilityRegistry` (agents, owner P256 keys, grants, revocation, read epochs and their public keys) and `ContextRegistry` (records, provenance, lineage). Every cross-layer identifier is computed identically in TypeScript and Solidity and cross-checked by fixed test vectors.

**Tech Stack:** Node ≥22, pnpm 12.4.1, TypeScript 5.9.3, Vitest 4.1.11, fast-check 4.9.0, viem 2.56.3, ox 1.7.4, @noble/curves|hashes|ciphers 2.4.0, canonicalize 4.0.0, Hono 4.13.7, Foundry 1.8.1, Solidity 0.8.28, webauthn-sol v1.0.0.

**Spec:** `docs/superpowers/specs/2026-09-14-project-1-protocol-core-design.md` (commit `155c8c0` or later). Section numbers written §N refer to that file. When this plan and the spec disagree, the spec wins: stop and report the conflict.

## How this plan is split

The plan is stored in five part files. Execute them in order. Each task lists the exact interfaces it consumes from earlier tasks.

| Part | File | Tasks |
|---|---|---|
| A | `2026-09-14-project-1-part-a-foundation.md` | 1–5: repo scaffold, `@mida/protocol` |
| B | `2026-09-14-project-1-part-b-crypto-storage.md` | 6–9: `@mida/crypto`, `@mida/storage` |
| C | `2026-09-14-project-1-part-c-grant-advisor.md` | 10–13: `@mida/grant-advisor` |
| D | `2026-09-14-project-1-part-d-contracts.md` | 14–20: Foundry contracts |
| E | `2026-09-14-project-1-part-e-integration.md` | 21–28: chain adapter, FakeVault, API, SDK, CLI, Monad testnet, review gate |

Parts B, C and D depend only on Part A and may run in parallel, with one exception: Task 14 also needs the policy vector file written by Task 10. Part E depends on all of them.

## Global Constraints

Every task implicitly includes this section.

- Solidity exactly `0.8.28`. Foundry `1.8.1`, installed with `foundryup --install 1.8.1`.
- `webauthn-sol` pinned to tag `v1.0.0` (commit `619f20a`), installed with `forge install base/webauthn-sol@v1.0.0`. Remappings: `webauthn-sol/=lib/webauthn-sol/src/` and `FreshCryptoLib/=lib/webauthn-sol/lib/FreshCryptoLib/solidity/src/`. `forge-std` pinned to `v1.16.2`.
- `contracts/foundry.toml` must set `evm_version = "osaka"` and `via_ir = true`. Without `osaka`, pinning solc 0.8.28 silently runs every test on prague, where every passkey check quietly uses the slow Solidity fallback. Without `via_ir`, the grant and access-request digests fail with "stack too deep". The P256 path tests (Task 15) exist to catch the first failure.
- Exact npm pins, no ranges: `@noble/curves 2.4.0`, `@noble/hashes 2.4.0`, `@noble/ciphers 2.4.0`, `ox 1.7.4`, `viem 2.56.3`, `canonicalize 4.0.0`, `typescript 5.9.3`, `vitest 4.1.11`, `fast-check 4.9.0`, `@types/node 22.20.1`, `tsx 4.23.13`, `hono 4.13.7`, `@hono/node-server 1.19.17`. Do not add any dependency version younger than seven days.
- pnpm `12.4.1` with a committed `pnpm-lock.yaml`. Every package is ESM (`"type": "module"`). Relative imports end in `.js`.
- Node engines `>=22`. `.nvmrc` contains `22`.
- Noble v2 import paths: `x25519` from `@noble/curves/ed25519.js`; `p256` from `@noble/curves/nist.js`; `xchacha20poly1305` from `@noble/ciphers/chacha.js`; `hkdf` from `@noble/hashes/hkdf.js`; `sha256` from `@noble/hashes/sha2.js`; `randomBytes`, `bytesToHex`, `hexToBytes`, `utf8ToBytes`, `concatBytes` from `@noble/hashes/utils.js`.
- Fixed-size hex values are lowercase, `0x`-prefixed and exactly the declared byte length. `uint64` and `bigint` values on the wire are base-10 strings with no sign and no leading zero except `"0"` (§8). Conversion happens only in `@mida/protocol`.
- Canonical JSON is RFC 8785 via `canonicalize`, then UTF-8 encoded.
- Chains: local Anvil chain ID `31337`. Monad testnet uses `monadTestnet` from `viem/chains` (chain ID `10143`). Never hand-write a Monad chain object.
- Vault RP ID for Project 1 is `vault.mida.xyz`; Vault origin is `https://vault.mida.xyz`.
- `eth_getLogs` is always chunked into windows of at most 100 blocks, regardless of provider.
- No secret, private key, PRF output, plaintext DEK or plaintext context value is committed or logged. `.env` files are gitignored.
- TDD is mandatory (§15): write the failing test, run it, see it fail for the intended reason, then implement.
- Commit messages end with the line `Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk`.

## File structure

```text
mida-context/
├── package.json                  root scripts: test, typecheck, test:contracts
├── pnpm-workspace.yaml
├── tsconfig.json                 one noEmit typecheck over every package and app
├── vitest.config.ts
├── .nvmrc  .gitignore  .env.example
├── packages/
│   ├── protocol/src/             pure types, wire encoding, IDs, errors
│   │   ├── errors.ts             MidaError and typed codes
│   │   ├── constants.ts          permission and provenance bits, enums, version strings
│   │   ├── types.ts              shared interfaces from §4, §8, §9, §13, §14
│   │   ├── wire.ts               uint64 strings, fixed hex, canonical JSON bytes
│   │   ├── namespaces.ts         frozen v1 tree, namespaceId, canonicalize, expand, isolation domain
│   │   ├── ids.ts                agentId, contextId, scopes, capabilityId, grantDigest, evidence, origins
│   │   ├── typed-data.ts         EIP-712 domains and types shared with Solidity
│   │   └── index.ts
│   ├── crypto/src/               derive.ts, payload.ts, wraps.ts, manifest.ts, index.ts
│   ├── storage/src/              storage.ts, memory.ts, fs.ts, index.ts
│   ├── grant-advisor/src/        policy.ts, manifest.ts, authority.ts, advise.ts, index.ts
│   ├── chain/src/                viem adapter: ABIs, network config, chunked logs, registry calls
│   ├── fake-vault/src/           FakeVaultAuthority and software WebAuthn assertions
│   └── sdk/src/                  MidaAgent, request signing, HTTP request auth
├── apps/
│   ├── api/src/                  Hono Context API
│   └── cli/src/                  local and testnet scenario harness
└── contracts/
    ├── foundry.toml  remappings.txt
    ├── src/
    │   ├── MidaTypes.sol         shared structs, constants, errors
    │   ├── NamespaceTree.sol     frozen v1 tree registered at construction
    │   ├── MidaWebAuthn.sol      RP-ID-hash check plus webauthn-sol call
    │   ├── CapabilityRegistry.sol
    │   └── ContextRegistry.sol
    ├── test/                     one Foundry test file per behaviour area
    └── script/Deploy.s.sol
```

## Task list

**Part A — Foundation**
1. Repo scaffold and toolchain pins
2. Errors, constants and shared types
3. Wire encoding and canonical JSON
4. Namespace tree v1
5. Deterministic identifiers, origins and EIP-712 type definitions

**Part B — Crypto and storage**
6. PRF domains, namespace secrets and epoch keypairs
7. Payload encryption with bound AAD
8. Epoch DEK wraps and reader epoch wraps
9. Object manifests and content-addressed storage

**Part C — Grant Advisor**
10. Protocol policy v1 and `POLICY_HASH_V1`
11. Agent capability manifests: validation, body hash, EIP-712 binding
12. Effective authority expansion and subset proofs
13. `adviseGrant` with fuzzed subset invariant

**Part D — Contracts**
14. Foundry workspace, `MidaTypes`, `NamespaceTree`, TS↔Solidity ID and policy-hash parity
15. `MidaWebAuthn` wrapper and the three P256 verification paths
16. `CapabilityRegistry`: agent registration, key rotation, manifest updates
17. `CapabilityRegistry`: owner P256 keys and `grantBatch`
18. `CapabilityRegistry`: read epochs, revocation with rotation, expiry, `isAuthorized`
19. `ContextRegistry`: roots, evidence, provenance rules
20. `ContextRegistry`: supersession, owner-controlled anchors, stale parents, concurrency

**Part E — Integration**
21. `@mida/chain`: ABIs, network config, chunked logs, owner history
22. `@mida/fake-vault`
23. Context API: request authentication, ordered authorization, deny overlay
24. Context API: objects, manifests, agent manifests, epoch wraps
25. `@mida/sdk`: `MidaAgent`
26. CLI scenario against local Anvil
27. Monad testnet deployment and scenario run
28. Completion gate and adversarial review

## Decisions this plan makes where the spec is silent

Each is binding for every task. Report any disagreement before implementing.

1. **ABI types for every hashed tuple.** The spec writes `abi.encode(...)` without types. The exact Solidity types are fixed in Task 5 and cross-checked against Solidity in Task 14.
2. **`cryptoVersion` inside AADs** is ABI-encoded as the `string` `"mida-crypto-v1"`, matching `ObjectManifest.cryptoVersion`.
3. **Implementation error codes** beyond §12.6 exist only for local validation: `INVALID_WIRE`, `PAYLOAD_TOO_LARGE`, `ZERO_KEY`, `AUTH_INVALID`, `REPLAY`, `REQUEST_EXPIRED`, `REQUEST_CONSUMED`, `RESPONSE_MISMATCH`, `NOT_FOUND`. They never replace a §12.6 code where one applies.
4. **Packages are consumed from source.** Each package's `exports` points at `./src/index.ts`. Vitest and tsx run TypeScript directly; there is no build step in Project 1.
5. **The API is Hono on Node.** Its persistent state is `FsStorage` plus JSON files under a data directory; there is no database in Project 1.

## Completion gate mapping (§19)

| Gate item | Proven by |
|---|---|
| Unit and property tests for canonicalization, expansion, manifests, subset invariants, derivation, encryption, wraps, storage, wire validation | Tasks 2–13 |
| Foundry adversarial tests | Tasks 14–20 |
| API ordered validation, chain-bounded authorization, local deny, wrap authorization | Tasks 23–24 |
| Full CLI scenario locally | Task 26 |
| Same scenario on Monad testnet | Task 27 |
| Fallback and native P256 paths distinguished with evidence | Tasks 15 and 27 |
| Adversarial review of the final diff | Task 28 |
