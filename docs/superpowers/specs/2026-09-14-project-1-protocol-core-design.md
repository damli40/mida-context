# Mida Context v0 — Project 1 Protocol Core Design

**Status:** Approved design; executable specification awaiting written review  
**Date:** 2026-09-14  
**Repository:** `/Users/you/Desktop/mida-context`  
**Product:** Passkey-native, user-owned context for AI agents  
**Project 1 exit:** Alice creates encrypted context, grants Agent A, A reads, Agent B is denied, Alice revokes A and rotates the read epoch, A is denied future context, and a CREATE-only Agent C can write without reading existing context—all against Monad testnet without a UI.

## 1. Purpose

Mida Context lets a person teach one AI something and selectively make that context available to other AI agents. The protocol separates five concerns:

1. **Monad authorization:** who owns context, which agent may perform which operation, and whether authority remains valid.
2. **Grant minimization:** agents declare and request authority, deterministic policy recommends a narrower subset, and the user chooses the final requested subset.
3. **User-owned encryption:** the user’s passkey-derived secrets are the root of read authority; Mida has no master decryption key.
4. **Encrypted storage:** storage providers hold content-addressed ciphertext, not plaintext.
5. **Provenance:** every context record states who created it, how it was derived, and how it relates to earlier records.

Project 1 proves these protocol assumptions with a software `FakeVaultAuthority`. Real Mera/WebAuthn, browser recovery, popup handoff, materialized current state, subscriptions, and reference applications belong to later projects.

## 2. Project 1 scope

### 2.1 Build now

- A pnpm TypeScript monorepo and Foundry contracts.
- `@mida/protocol`: canonical types, identifiers, namespace rules, error codes, and encodings.
- `@mida/crypto`: namespace derivation, asymmetric read epochs, XChaCha20-Poly1305 payload encryption, and X25519 wraps.
- `@mida/grant-advisor`: signed agent manifests, immutable sensitivity/purpose policy, authority expansion, deterministic narrowing, warnings, and subset proofs.
- `CapabilityRegistry`: owner P256 keys, global agent identities and manifest commitments, exact capabilities, grant replay protection, request/final-subset enforcement, revocation, expiry deadlines, read-epoch generations, and namespace epoch public keys.
- `ContextRegistry`: immutable evidence/context records, provenance enforcement, lineage policy, latest pointers, and stale-parent protection. It reads epoch validity from `CapabilityRegistry` and holds no epoch key state of its own.
- `MemoryStorage` and `FsStorage` behind `ContextStorage`.
- A minimal Context API that stores ciphertext, immutable manifests, and reader-epoch wraps while enforcing current chain authorization.
- `FakeVaultAuthority` using software P256 and deterministic fake PRF-domain outputs.
- An agent/server SDK for access requests, capability verification, read, create, and supersede.
- A CLI integration harness and Monad testnet smoke test.

### 2.2 Explicitly deferred

- Real Mera/WebAuthn PRF and passkey recovery: Project 2.
- Browser Vault, popup/redirect handoff, Grant Advisor consent UI, progressive-grant UX, optional warning explanations, and React component: Project 2.
- Pending/anchored/retracted subscriptions and `CurrentContext` materializer: Project 2.
- Compiler, deterministic extraction validator, `confirm`, and `explain`: Project 3.
- Dynamic, ERC-8004, Envio, replication, erasure coding, IPFS, and third-party integration kit: Project 4.
- Retroactive deletion of plaintext or keys already disclosed to an agent: non-goal.
- Custom namespaces: not supported in v0.
- Arbitrary provenance ontologies or automatic contradiction resolution: non-goals.

## 3. Implementation principles

Mida borrows systems ideas from QMDB, FAFO, and SVID. These are design inspirations, not claims that Mida reuses LayerZero software.

### 3.1 QMDB-inspired state separation

Project 1 stores append-only `ContextRecord`s and only the canonical lineage head required for conflict detection. It does not implement the Project 2 materialized read model.

### 3.2 FAFO-inspired concurrency

Independent object creation uses random precomputed nonces, not a global object counter. Independent lineages can update concurrently. Two attempts to supersede the same current parent cannot both succeed; the second reverts with `STALE_PARENT`.

### 3.3 SVID-inspired availability boundary

Project 1 stores encrypted blobs through a content-addressed interface and verifies the full ciphertext hash on retrieval. It does not replicate or erasure-code blobs. Those remain replaceable storage implementations later.

### 3.4 External protocol precedents

Vana validates three boundaries used here: scopes are first-class grant objects; grants are EIP-712 signed with expiry and nonce; and its Context Gateway can deny a revoked grant immediately while on-chain state becomes the durable record. Mida adopts the narrow version of that split:

```text
Monad                 canonical authority and settlement
Context API           immediate fail-closed enforcement
```

The API may deny sooner than chain confirmation, but it can never authorize anything Monad does not currently authorize. Unlike Vana’s current Personal Server path, Mida’s Context API is not a persistent plaintext decryptor; agents receive cryptographic access to scoped encrypted state.

Ethereum Attestation Service validates keeping the public record small: its attestation record carries identity, expiry/revocation, a reference UID, and schema-encoded data, while schema definitions are separate. Mida similarly keeps evolving payload semantics off-chain and encrypted.

Mida does not copy EAS `refUID` literally. `parentId` remains the contract-enforced supersession predecessor because stale-parent conflict detection depends on that meaning. Generic `derived-from`, `confirmed-from`, and supporting-evidence references live as typed encrypted payload references committed by `evidenceCommitment`.

Sources verified 2026-09-14:

- `https://docs.vana.org/protocol-reference/grants-permissions`
- `https://docs.vana.org/protocol-reference/personal-servers`
- `https://docs.vana.org/protocol-reference/storage-encryption`
- `https://github.com/ethereum-attestation-service/eas-docs-site/blob/main/docs/tutorials/make-an-attestation.md`
- `https://raw.githubusercontent.com/ethereum-attestation-service/eas-docs-site/main/docs/tutorials/create-a-schema.md`

## 4. Trust and authority boundaries

### 4.1 Owner

The owner is the Mera-derived account address. Per Monad's Mera docs (verified 2026-09-14, `https://docs.monad.xyz/guides/mera`), Mera accounts are plain EOAs ("regular EOAs. There is nothing to deploy"), not EIP-7702 delegated accounts, and the SDK is `@category-labs/mera`. Every owner contract operation must enter from execution by that account, so the registries observe `msg.sender == owner`. Gas sponsorship alone does not establish owner identity; a relayer calling a registry directly is the relayer and is rejected.

Because the owner is a plain EOA, every "revoke + advance epoch + publish next key" transition in this document is one call to one contract, not a wallet-level batched transaction and not a cross-contract call. A cross-contract path (`CapabilityRegistry` calling into `ContextRegistry`) would fail the `msg.sender == owner` check because the inner call's sender is the registry, not the owner. Read-epoch public keys therefore live in `CapabilityRegistry`, next to the required epoch, write deadline, and READ-capability endings that decide when they must change (Section 10.6). EIP-7702 batching is not assumed. The owner EOA needs testnet MON from `https://faucet.monad.xyz` for gas.

### 4.2 Vault

The Vault is the only component permitted to derive passkey-controlled namespace secrets. Project 1 defines:

```ts
interface VaultAuthority {
  deriveNamespaceSecret(namespaceId: Hex): Promise<Uint8Array>
  approveGrant(request: GrantRequest): Promise<GrantApproval>
  approveRevocation(request: RevokeRequest): Promise<RevokeApproval>
}
```

It must not expose a global root. `FakeVaultAuthority` implements this boundary with test secrets. Project 2 replaces it with `MeraWebAuthnVaultAuthority` without changing protocol objects.

### 4.3 Agent identities

An agent has separate signing and encryption identities:

```ts
interface AgentRecord {
  agentId: Hex
  operator: Address
  signer: Address
  encryptionPublicKey: Hex
  encryptionKeyVersion: number
  callbackOriginHash: Hex
  capabilityManifestHash: Hex
  capabilityManifestVersion: number
  active: boolean
}
```

- The signer authenticates requests and contract writes.
- The X25519 encryption key receives wrapped read-epoch private keys.
- The operator submits registration, but the proposed signing key must sign an EIP-712 registration binding the operator, agent ID, signer, encryption key/version, callback origin hash, capability-manifest hash/version, chain, and registry.
- A signer may resolve to only one active agent ID.
- Signing-key rotation requires both operator authority and an EIP-712 acceptance signature from the new signer.
- Encryption-key rotation requires operator authority, increments `encryptionKeyVersion`, and emits `AgentEncryptionKeyRotated`.
- Recipient wraps identify both `agentId` and `encryptionKeyVersion`.
- An old recipient wrap is not valid for a new key version.

Project 1 uses a stable registry-bound identity:

```text
agentId = keccak256(
  abi.encode(
    "MIDA_AGENT_V1",
    chainId,
    CapabilityRegistry address,
    operator,
    random bytes32 agentSalt
  )
)
```

The signer is a rotatable attribute and therefore cannot be part of the stable ID. ERC-8004 mapping is deferred.

Callback origins are canonicalized as an HTTPS origin with lowercase hostname, no path/query/fragment, and an explicit port only when non-default. `http://localhost:<port>` is permitted only in local development. The registry stores `keccak256(UTF8(canonicalOrigin))`.

## 5. Canonical namespaces

### 5.1 Canonicalization

A canonical namespace:

- is lowercase;
- uses `.` as its separator;
- contains only segments matching `[a-z0-9_]+`;
- has no empty segment;
- has no leading or trailing separator.

Input is trimmed and lowercased before validation. `Goals.Career` becomes `goals.career`. Invalid characters, repeated separators, and unknown namespaces fail with `INVALID_NAMESPACE`.

The identifier is:

```text
namespaceId = keccak256(
  abi.encode("MIDA_NAMESPACE_V1", canonicalNamespace)
)
```

Using ABI encoding, rather than string concatenation, prevents ambiguous boundaries.

### 5.2 Frozen v1 tree

```text
profile
├── profile.identity
└── profile.skills

goals
├── goals.career
├── goals.learning
└── goals.personal

preferences
├── preferences.communication
├── preferences.tools
└── preferences.work

projects
├── projects.current
└── projects.past

decisions
├── decisions.career
└── decisions.projects

credentials
financial
└── financial.preferences
relationships
private
```

The maximum depth is two segments. Contract construction registers each node and its parent; roots have parent `bytes32(0)`. Namespace-tree version 1 is immutable after deployment: there is no external namespace-registration function. Adding, removing, or re-parenting a node requires a new namespace-tree/protocol version, so an existing parent grant can never silently acquire a future child.

### 5.3 Parent scopes are request shorthand

A request may use a parent such as `projects`, but capabilities are stored for exact registered namespaces. Before P256 approval, the Vault expands a parent to the parent plus every registered descendant:

```text
projects
→ projects
→ projects.current
→ projects.past
```

The user sees the expanded set. The signed grant binds the sorted exact namespace IDs. `CapabilityRegistry.grantBatch` verifies that every ID is registered and rejects duplicate or unsorted input.

This v0 choice keeps expiry and read-epoch rotation independently enforceable per namespace. No contract function accepts a caller-provided ancestry path. `parentNamespace` remains protocol state and supports verified expansion/querying, but authorization checks use exact stored capabilities.

## 6. Passkey derivation boundary

Project 1 does not implement real WebAuthn PRF. It freezes the derivation inputs that Project 2 must reproduce.

### 6.1 Isolation domains

```text
account        Mera account derivation only

general        profile.*, goals.*, preferences.*, projects.*,
               decisions.*, credentials
financial      financial.*
relationships  relationships.*
private        private.*
```

The context PRF salts are exactly:

```text
SHA256(UTF8("mida/context/prf/general/v1"))
SHA256(UTF8("mida/context/prf/financial/v1"))
SHA256(UTF8("mida/context/prf/relationships/v1"))
SHA256(UTF8("mida/context/prf/private/v1"))
```

The Mera account domain uses Mera’s account derivation and is never reused as context key material.

### 6.2 Namespace secret

For a namespace assigned to domain `D`:

```text
namespaceSecret = HKDF-SHA256(
  ikm  = PRF_D,
  salt = namespaceId,
  info = UTF8("mida/context/namespace-secret/v1"),
  len  = 32
)
```

A namespace cannot move to another isolation domain within protocol version 1.

Secrets are never intentionally persisted. Mutable buffers are overwritten where practical and application references are released at session end. JavaScript does not guarantee memory zeroization.

## 7. Asymmetric read epochs

### 7.1 Why epochs are asymmetric

A symmetric namespace key would force a CREATE-only agent to possess the same key readers use, silently turning CREATE into READ. Mida instead derives an X25519 keypair for every namespace read epoch:

```text
epochSeed = HKDF-SHA256(
  ikm  = namespaceSecret,
  salt = uint64be(readEpoch),
  info = UTF8("mida/context/read-epoch/x25519/v1"),
  len  = 32
)

readEpochPrivateKey = X25519 private key derived from epochSeed
readEpochPublicKey  = X25519 public key(readEpochPrivateKey)
```

The audited library performs X25519 scalar handling; Mida does not implement curve arithmetic. Every X25519 operation rejects an all-zero public key or all-zero shared secret before HKDF.

- CREATE authority exposes only the public epoch key.
- READ authority receives the private epoch key wrapped to the agent’s X25519 public key.
- An object DEK is wrapped once to the active epoch public key.
- One reader-epoch wrap unlocks all authorized objects in that epoch.

### 7.2 Epoch state

For every `(owner, namespaceId)`, protocol state includes:

```ts
interface ReadEpochState {
  readEpoch: bigint
  publicKey: Hex
  writeDeadline: bigint
}
```

`writeDeadline == 0` means no active expiring READ capability limits the epoch. Otherwise it is the earliest `expiresAt` among active READ capabilities for that exact namespace and epoch.

Frozen invariant:

> A namespace epoch may accept new writes only while its write deadline is strictly in the future; once the earliest active READ grant expires, writes fail closed until the owner rotates the read epoch.

Precisely:

```text
writeDeadline == 0                      → epoch may accept writes
block.timestamp < writeDeadline         → epoch may accept writes
block.timestamp >= writeDeadline        → EPOCH_ROTATION_REQUIRED
submitted epoch != current readEpoch    → EPOCH_STALE
```

### 7.3 Security transitions

Any operation that ends READ authority requires an epoch transition for every affected exact namespace:

- individual READ capability revocation;
- agent-wide revocation;
- READ-to-CREATE-only scope reduction;
- namespace removal;
- expiry.

Explicit revocation/scope reduction executes one owner transaction into a single `CapabilityRegistry` function (`revokeAndRotate` or `revokeAgentAndRotate`, Section 10.6) that performs all three steps atomically:

```text
invalidate capability or increment agent epoch
→ advance required read epoch
→ publish new epoch public key
```

At expiry there is no automatic transaction. The expired capability immediately fails authorization, and the old epoch immediately stops accepting new records because its deadline is no longer in the future. The owner must call `rotateExpiredEpoch` with the next epoch public key to resume writes.

The next epoch’s deadline is recomputed from remaining active READ capabilities. Project 1 permits at most 32 active exact capabilities per `(owner, namespaceId)` so this scan is bounded. Revoked and expired entries may be compacted during rotation.

Distribution of the new private epoch key is off-chain and follows the transaction. Remaining readers may temporarily fail to read new-epoch objects until their new reader wraps are published. This is an availability reduction, not an authorization failure.

### 7.4 Forward-only limitation

- Existing historical reads still require a currently valid chain capability when using Mida services.
- Expiry or revocation cannot remove an epoch private key or plaintext already disclosed.
- No new record can use an obsolete or write-expired epoch.
- A reader holding epoch 7 may independently decrypt epoch-7 ciphertext it already has or later obtains.
- It cannot decrypt epoch-8 objects unless it receives epoch 8’s private key.

## 8. Cryptographic objects

Project 1 uses `@noble/curves`, `@noble/hashes`, and `@noble/ciphers` (all 2.4.0 as of 2026-09-14). It does not implement cryptographic primitives. Pinned import paths for v2: `x25519` from `@noble/curves/ed25519.js`, `p256` from `@noble/curves/nist.js` (there is no `p256.js` subpath export in v2), `xchacha20poly1305` from `@noble/ciphers/chacha.js`, `hkdf` from `@noble/hashes/hkdf.js`, `sha256` from `@noble/hashes/sha2.js`. `@noble/curves` x25519 already throws on low-order public keys and on an all-zero shared point; Mida keeps its own explicit all-zero check as defense in depth. RFC 8785 canonicalization uses the `canonicalize` package (4.0.0). FakeVault constructs WebAuthn-shaped metadata and the exact authenticator signing digest with `ox` 1.7.4 `WebAuthnP256.getSignPayload`, signs that digest with its software `@noble/curves` P256 private key, normalizes `s` to low-s, and checks parity with `WebAuthnP256.verify`; `WebAuthnP256.sign` is reserved for real browser credentials and viem has no `signWebAuthn` export. Exact pins are listed in Section 17; a release younger than seven days is not pinned.

Canonical JSON wire objects encode `uint64` and `bigint` values as base-10 strings with no sign or leading zero, except the value `"0"`. Runtime APIs may expose `bigint`, but conversion to and from the canonical wire representation happens only in `@mida/protocol`. Fixed-size hexadecimal values are lowercase, `0x`-prefixed, and exactly the declared byte length.

### 8.1 Precomputed object identity

Every writer generates a random 32-byte `objectNonce`. No global object nonce is used.

```text
authorId = bytes32(0) for the owner
         = agentId for a registered agent signer

contextId = keccak256(
  abi.encode(
    "MIDA_CONTEXT_OBJECT_V1",
    chainId,
    ContextRegistry address,
    owner,
    authorId,
    namespaceId,
    objectNonce
  )
)
```

All fields are known before encryption. The contract resolves `owner` and `authorId`, recomputes the ID, and rejects an existing ID. Random identity preserves concurrent writes to unrelated lineages.

### 8.2 Payload encryption

```ts
type RecordRelation = "supports" | "derived_from" | "confirmed_from"

interface RecordReference {
  relation: RecordRelation
  recordId: Hex
}

interface ContextPayload {
  v: 1
  value: string | Record<string, unknown>
  kind: ContextKind
  provenance: {
    source: ProvenanceSource
    extractionConfidence?: number
    references?: RecordReference[]
    sourceHash?: Hex
    sourceUri?: string
    retrievedAt?: number
    note?: string
  }
  tags?: string[]
}
```

The payload is RFC 8785 canonical JSON encoded as UTF-8 and capped at 65,536 bytes before encryption.

Encryption:

```text
DEK        = secure random 32 bytes
nonce      = secure random 24 bytes
ciphertext = XChaCha20-Poly1305(DEK).encrypt(payloadBytes, nonce, payloadAAD)
```

`payloadAAD` is:

```text
abi.encode(
  "MIDA_CONTEXT_PAYLOAD_V1",
  chainId,
  ContextRegistry address,
  contextId,
  namespaceId,
  readEpoch,
  cryptoVersion
)
```

### 8.3 Object DEK wrap to epoch

```ts
interface EpochDEKWrap {
  v: 1
  contextId: Hex
  namespaceId: Hex
  readEpoch: string // canonical base-10 uint64
  ephemeralPublicKey: Hex // bytes32
  nonce: Hex // bytes24
  wrappedDek: Hex
}
```

The writer creates an ephemeral X25519 keypair, performs X25519 with the active epoch public key, and derives:

```text
KEK = HKDF-SHA256(
  ikm  = sharedSecret,
  salt = contextId,
  info = UTF8("mida/context/epoch-dek-wrap/v1"),
  len  = 32
)
```

The wrapped-DEK AAD is:

```text
abi.encode(
  "MIDA_EPOCH_DEK_WRAP_V1",
  chainId,
  ContextRegistry address,
  contextId,
  namespaceId,
  readEpoch,
  cryptoVersion
)
```

### 8.4 Reader epoch wrap

```ts
interface ReaderEpochWrap {
  v: 1
  owner: Address
  namespaceId: Hex
  readEpoch: string // canonical base-10 uint64
  agentId: Hex
  agentKeyVersion: number
  ephemeralPublicKey: Hex // bytes32
  nonce: Hex // bytes24
  wrappedEpochPrivateKey: Hex
  createdAt: string // canonical base-10 Unix seconds
}
```

The Vault creates an ephemeral X25519 keypair, performs X25519 with the registered agent encryption public key, and derives:

```text
KEK = HKDF-SHA256(
  ikm  = sharedSecret,
  salt = namespaceId,
  info = UTF8("mida/context/reader-epoch-wrap/v1"),
  len  = 32
)
```

The reader-wrap AAD is:

```text
abi.encode(
  "MIDA_READER_EPOCH_WRAP_V1",
  chainId,
  CapabilityRegistry address,
  owner,
  namespaceId,
  readEpoch,
  agentId,
  agentKeyVersion,
  cryptoVersion
)
```

The Context API accepts this wrap only when the owner request is authenticated, the agent key/version exactly matches `AgentRecord`, and the agent has active exact READ authority for the namespace.

## 9. Immutable manifest and content-addressed storage

### 9.1 Object manifest

```ts
interface ObjectManifest {
  v: 1
  contextId: Hex
  ciphertextHash: Hex
  ciphertextSize: number
  payloadNonce: Hex // bytes24
  cryptoVersion: "mida-crypto-v1"
  readEpoch: string // canonical base-10 uint64
  epochDekWrap: EpochDEKWrap
}
```

`ObjectManifest` contains the immutable object-to-epoch DEK wrap because it is created with the object and never changes. It never contains reader-specific epoch-private-key wraps or provider locations. It is RFC 8785 canonicalized, UTF-8 encoded, then committed as:

```text
manifestHash = keccak256(canonicalManifestBytes)
ciphertextHash = SHA256(ciphertextBytes)
```

Changing a recipient does not mutate the manifest. Storage hints are untrusted, mutable, and excluded from all protocol commitments.

### 9.2 Storage interface

```ts
interface StorageRef {
  provider: "memory" | "fs" | "mida-api" | "s3" | "ipfs"
  locator: string
}

interface ContextStorage {
  put(blob: Uint8Array): Promise<StorageRef[]>
  get(hash: Hex, hints?: StorageRef[]): Promise<Uint8Array>
}
```

Every `get` implementation must compute SHA-256 over returned bytes and fail with `CONTENT_HASH_MISMATCH` before returning mismatched content.

Project 1 implements only `MemoryStorage` and `FsStorage`. R2, replication, erasure coding, and IPFS are later implementations. Erasure coding must encrypt first, hash the full ciphertext, split it, reconstruct from any threshold, verify the full hash, and only then decrypt; it does not change this interface or any protocol identifier.

## 10. CapabilityRegistry

### 10.1 Responsibilities

- Register owner P256 keys.
- Register protocol-standard namespace ancestry.
- Register global agent signing/encryption identities, callback origin hashes, and capability-manifest body hash/version.
- Rotate agent signing/encryption keys and monotonically update signed capability-manifest commitments under operator authority.
- Grant exact namespace capabilities after P256 verification.
- Enforce contract-owned grant nonces.
- Revoke individual capabilities.
- Increment per-owner/per-agent epochs for global revocation.
- Track bounded active capabilities per exact namespace.
- Track the required read-epoch generation and its write deadline.
- Answer exact authorization and epoch-write-validity queries.

Initial `registerP256Key(qx, qy)` is allowed only when the owner has no key and requires `msg.sender == owner`. It can never overwrite an existing key. `rotateP256Key(newQx, newQy, auth)` requires `msg.sender == owner` plus a WebAuthn assertion from the old registered P256 key over:

```text
keccak256(abi.encode(
  "MIDA_ROTATE_P256_V1",
  chainId,
  CapabilityRegistry address,
  owner,
  newQx,
  newQy,
  p256RotationNonce[owner]
))
```

The nonce is contract-controlled and increments after successful verification. Recovery from a lost P256 credential is intentionally deferred to the Project 2 recovery-policy design; a live delegated session cannot silently replace the grant-authorizing key.

### 10.2 Permissions and provenance policy

```text
READ            = 1
CREATE          = 2
SUPERSEDE_OWN   = 4
SUPERSEDE_ANY   = 8

ALLOW_INFERENCE            = 1
ALLOW_IMPORTED             = 2
ALLOW_EXTERNAL_ATTESTATION = 4
```

`CREATE` does not imply `READ`. `SUPERSEDE_OWN` permits superseding only lineages authored by the same agent. `SUPERSEDE_ANY` permits superseding another author’s standard lineage but never an owner-controlled lineage.

### 10.3 Capability

```solidity
struct Capability {
    address owner;
    bytes32 agentId;
    bytes32 namespaceId;
    uint8 permissions;
    uint8 provenancePolicy;
    uint64 issuedAt;
    uint64 expiresAt;
    uint64 agentEpoch;
    uint64 grantedAtReadEpoch;
    bool revoked;
}
```

- `expiresAt == 0` means no time expiry.
- A capability is valid only when not revoked, not expired, its captured `agentEpoch` equals the current owner-agent epoch, and its namespace is registered.
- `grantedAtReadEpoch` is audit metadata recording the epoch current when READ was granted. It is not compared with the namespace’s current epoch: remaining readers keep valid capabilities across rotations and receive a new private-epoch wrap.
- In v0, exact READ authority covers all retained history in that exact namespace. While the capability remains valid, the Vault may publish wraps for any historical epoch needed by returned objects and for the current epoch. Every service fetch still rechecks current capability validity.

### 10.4 Grant authorization

The registry owns grant replay state:

```solidity
mapping(address owner => uint256 nonce) public grantNonce;
```

`grantBatch` receives the agent-signed `AccessRequest`, its sorted exact requested scopes, and the sorted exact final `GrantScope[]`. The registry recomputes the EIP-712 `requestHash`, verifies it against the agent’s current signer, and proves each final namespace/permission/provenance bit is contained by the request.

The WebAuthn challenge is the 32-byte `grantDigest`:

```text
grantDigest = keccak256(
  abi.encode(
    "MIDA_GRANT_V1",
    chainId,
    CapabilityRegistry address,
    owner,
    agentId,
    requestHash,
    capabilityManifestHash,
    capabilityManifestVersion,
    keccak256(UTF8("mida-grant-policy-v1")),
    keccak256(UTF8("mida-namespace-tree-v1")),
    keccak256(abi.encode(sorted exact final GrantScope[])),
    expiresAt,
    grantNonce[owner]
  )
)
```

`GrantScope` contains `namespaceId`, `permissions`, and `provenancePolicy`. `AccessRequest.issuedAt` must satisfy `issuedAt <= block.timestamp`, `block.timestamp < requestExpiresAt`, and `requestExpiresAt - issuedAt <= 600 seconds`. For sorted final scope index `i`, the stored identifier is:

```text
capabilityId = keccak256(abi.encode(
  "MIDA_CAPABILITY_V1",
  owner,
  agentId,
  grantNonceUsed,
  i,
  namespaceId,
  permissions,
  provenancePolicy,
  expiresAt
))
```

Stored capability issuance time is always `block.timestamp`, so request calldata cannot forge record chronology.

A grant succeeds only if:

1. `msg.sender == owner`;
2. the agent is active and its request signature resolves to its current registered signer;
3. request manifest hash/version equal the current `AgentRecord` values;
4. request policy/tree versions equal the immutable supported v1 constants;
5. requested and final scopes are sorted, unique, non-empty, and contain only registered exact namespaces and known bits;
6. effective final namespace/permission/provenance authority is a subset of the signed request;
7. final expiry is no later than the request and satisfies `expiresAt == 0 || expiresAt > block.timestamp`; any final HIGH namespace additionally requires `expiresAt <= block.timestamp + 24 hours` and forbids zero/unbounded expiry;
8. active-capability limits are not exceeded: at most 32 per `(owner, namespaceId)` and 64 per `(owner, agentId)`;
9. every final READ scope’s current epoch is initialized and still writable;
10. the WebAuthn assertion has type `webauthn.get`, contains the exact `grantDigest` challenge, has both User Presence and User Verification flags set, and carries `authenticatorData[0:32] == SHA256(configured Vault RP ID)`; the RP-ID-hash comparison is performed by Mida's wrapper, not by `webauthn-sol`, and `clientDataJSON.origin` is not independently checked on-chain (see the boundary note after this list);
11. the P256 signature verifies against the owner’s registered key;
12. the registry reads and then increments `grantNonce[owner]`;
13. every final READ scope captures the namespace’s current `readEpoch` as `grantedAtReadEpoch` and lowers its write deadline when this grant expires sooner.

A zero authenticator signature counter is accepted because synced passkeys may not provide a useful monotonic counter. The contract does not treat the counter as replay protection; `grantNonce` provides replay protection.

Project 1 uses `webauthn-sol` v1.0.0 (commit `619f20a`; `forge install base/webauthn-sol@v1.0.0`; it is a Foundry dependency, not an npm package). Its `verify(challenge, requireUserVerification, auth, qx, qy)` takes a caller-supplied `requireUserVerification` bool; Mida always passes `true`. Verified 2026-09-14 from `src/WebAuthn.sol`: it checks `webauthn.get`, the challenge, User Presence, User Verification when requested, rejects `s > n/2`, calls the precompile at `address(0x100)`, requires non-empty return data decoding to `1` (EIP-7951-compatible), and falls back to FreshCryptoLib otherwise.

The library's own comments state what it does **not** verify: `clientDataJSON.origin`, `topOrigin`, the `rpIdHash` in `authenticatorData`, and the signature counter. The v0 verification boundary is therefore split across three layers:

```text
Mida wrapper          authenticatorData[0:32] == SHA256(configured Vault RP ID)
webauthn-sol          verify(challenge, true, auth, qx, qy)
browser/authenticator enforces the sole Vault RP ID and origin at assertion time
```

`clientDataJSON.origin` is not independently checked on-chain in v0. The contract binds the RP-ID hash; the origin binding rests on the browser refusing to produce an assertion for that RP ID from any other origin. This is a documented v0 limitation, not an oversight, and Project 2's Vault hardening must not weaken it.

Low-s: EIP-7951 accepts any `0 < s < n` and its security section says applications needing non-malleability must add the check themselves. `webauthn-sol` adds it by rejecting `s > n/2`. Every Mida assertion adapter normalizes `s` to low-s before contract submission because the selected library requires it, not because the precompile does. This includes both FakeVault in Project 1 and real authenticator assertions in Project 2; normalizing only the fake path would make valid high-s passkey assertions fail intermittently.

Three verification paths are exercised with the same FakeVault assertion payload:

- Anvil with `--hardfork` set to a pre-Osaka fork (for example `prague`) proves the Solidity fallback.
- Anvil at its default hardfork (Osaka, current Foundry ≥ 1.7.0) exposes P256VERIFY at `0x100` natively and proves the local precompile path. The earlier `--odyssey` flag no longer exists in current Foundry and must not be referenced.
- Monad testnet proves Monad’s native path. Confirmed live on 2026-09-14: an `eth_call` to `0x0100` with a valid 160-byte `(hash, r, s, qx, qy)` returned `0x…01` on both testnet (chain 10143) and mainnet (chain 143); a tampered `qy` returned empty data.

If a local Anvil build cannot expose the native path, Project 1 is blocked until the tool version is corrected rather than silently treating fallback coverage as native coverage.

### 10.5 Authorization

```solidity
isAuthorized(
    address owner,
    bytes32 agentId,
    bytes32 namespaceId,
    uint8 permission
) external view returns (bool);
```

The query accepts one exact registered namespace and one permission. No caller-supplied path exists. It resolves the current agent signer, checks capability validity, and returns true only if an exact capability contains the requested bit.

### 10.6 Revocation and required epoch advancement

The required epoch defaults to 1 for an owner/namespace with no stored epoch counter.

Read-epoch public keys are stored in `CapabilityRegistry`, keyed by `(owner, namespaceId, readEpoch)`, because this contract already owns the required epoch, the write deadline, and the READ-capability endings that force rotation. Keeping key publication in the same contract lets one owner EOA transaction perform revocation and rotation atomically without any cross-contract call that would change `msg.sender`.

```solidity
struct EpochRotation { bytes32 namespaceId; bytes32 newEpochPublicKey; }

initializeReadEpoch(bytes32 namespaceId, bytes32 publicKey)
revoke(bytes32 capabilityId)
revokeAndRotate(bytes32 capabilityId, bytes32 newEpochPublicKey)
revokeAgentAndRotate(bytes32 agentId, EpochRotation[] calldata rotations)
rotateExpiredEpoch(bytes32 namespaceId, bytes32 newEpochPublicKey)
requiredReadEpoch(address owner, bytes32 namespaceId) view returns (uint64)
epochPublicKey(address owner, bytes32 namespaceId, uint64 epoch) view returns (bytes32)
isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) view returns (bool)
```

- Every function above requires `msg.sender == owner` (for `revoke*`, the capability’s owner). Plain owner authority is sufficient because these operations reduce privilege or only publish a public key.
- `initializeReadEpoch` publishes epoch 1 for a registered namespace that has no key yet. `publicKey` must be non-zero. Published keys are immutable; rotation appends the next key rather than replacing history.
- `revoke` (no rotation) is permitted only for capabilities whose permissions do not include READ. It rejects an active READ capability so a caller cannot end READ authority without rotating; `revokeAndRotate` is the only path for that.
- `revokeAndRotate` invalidates the capability, increments `requiredReadEpoch[owner][namespaceId]`, stores `newEpochPublicKey` under the new epoch, and recomputes the write deadline from remaining live exact READ capabilities, all in one call.
- `revokeAgentAndRotate` increments `agentEpoch[owner][agentId]` and then requires that `rotations` cover exactly the set of unique namespaces in which that agent held active READ: every such namespace must appear once with a non-zero key, and no namespace outside that set may appear. Missing, duplicate, or extra entries revert. At most 64 owner-agent capabilities are scanned.
- If ended authority included READ, the registry increments `requiredReadEpoch[owner][namespaceId]` exactly once for that owner transaction, even when multiple ended capabilities cover the same namespace.
- A scope reduction is represented as `revokeAndRotate` plus a narrower new grant and therefore follows the same rule.
- `rotateExpiredEpoch` is callable only when the current deadline is non-zero and `block.timestamp >= writeDeadline`. It increments the required epoch, stores the new key, and recomputes the next deadline from remaining live exact READ capabilities.
- `ContextRegistry` never stores epoch keys. Context registration reads `requiredReadEpoch`, `epochPublicKey`, and `isWriteEpochValid` from `CapabilityRegistry` and fails until the required epoch has a published key.

### 10.7 Events

```text
P256KeyRegistered
NamespaceRegistered
AgentRegistered
AgentSigningKeyRotated
AgentEncryptionKeyRotated
AgentOriginChanged
AgentCapabilityManifestUpdated
CapabilityGranted
CapabilityRevoked
AgentRevoked
ReadEpochRequired
NamespaceEpochKeySet
```

Events include indexed owner/agent/namespace identifiers needed by an off-chain indexer. `CapabilityGranted` also emits `requestHash`, capability-manifest hash/version, policy/tree version hashes, and the final exact capability ID so the consent context can be audited without expanding the stored `Capability` struct.

## 11. ContextRegistry

### 11.1 Namespace epoch keys

`ContextRegistry` holds no epoch key state. Epoch public keys are published and rotated in `CapabilityRegistry` (Section 10.6) so that revocation and key publication happen in one owner transaction. `ContextRegistry` is constructed with the `CapabilityRegistry` address and, on every registration, reads `requiredReadEpoch`, `epochPublicKey`, and `isWriteEpochValid` from it.

Neither contract knows the owner’s namespace secret and neither can prove the public key was derived correctly. Recovery depends on the owner/Vault publishing the deterministic key specified in Section 7; the FakeVault recovery test detects a mismatch in Project 1.

### 11.2 Record enums

```text
RecordType:       CONTEXT | EVIDENCE
LineagePolicy:    STANDARD | OWNER_CONTROLLED
ContextKind:      NONE | FACT | PREFERENCE | GOAL | DECISION | EPISODE |
                  INFERENCE | CREDENTIAL | OPEN_LOOP
ProvenanceSource: NONE | USER_ASSERTED | USER_CONFIRMED | AGENT_INFERRED |
                  IMPORTED | EXTERNAL_ATTESTATION
```

### 11.3 Caller input and stored record

Callers submit only fields they cannot be safely derived by the contract:

```solidity
struct ContextInput {
    bytes32 contextId;
    bytes32 objectNonce;
    bytes32 namespaceId;
    bytes32 expectedParentId;
    bytes32 manifestHash;
    bytes32 ciphertextCommitment;
    bytes32 evidenceCommitment;
    uint64 readEpoch;
    uint64 expiresAt;
    uint8 recordType;
    uint8 lineagePolicy;
    uint8 kind;
    uint8 provenanceSource;
}
```

The stored record adds contract-derived:

```solidity
struct ContextRecord {
    bytes32 contextId;
    address owner;
    bytes32 author;
    bytes32 namespaceId;
    bytes32 lineageId;
    bytes32 parentId;
    bytes32 manifestHash;
    bytes32 ciphertextCommitment;
    bytes32 evidenceCommitment;
    uint64 readEpoch;
    uint64 createdAt;
    uint64 expiresAt;
    uint32 version;
    uint8 recordType;
    uint8 lineagePolicy;
    uint8 kind;
    uint8 provenanceSource;
}
```

`ciphertextCommitment` is SHA-256 ciphertext hash represented as `bytes32`; `manifestHash` and evidence commitments use Keccak-256.

### 11.4 Registration rules

The entry point is:

```solidity
register(address owner, ContextInput[] calldata inputs)
```

For an owner call, `owner` must equal `msg.sender`. For an agent call, the contract resolves `msg.sender` to one active `agentId` and checks that agent’s capability for the explicit `owner`. One agent may serve multiple owners, so owner cannot be inferred from the signer alone. The owner argument selects an authorization relationship; it is never copied into storage without those checks.

For every input, the contract:

1. resolves whether `msg.sender` is the stated owner or a registered active agent signer;
2. validates the explicit `owner` as described above rather than accepting an owner field inside `ContextInput`;
3. derives `author = bytes32(0)` for owner or the resolved `agentId`;
4. recomputes `contextId` from chain, registry, owner, author, namespace, and `objectNonce`;
5. rejects duplicate IDs and unknown namespaces;
6. verifies, by reading `CapabilityRegistry`, that `readEpoch` equals the current required epoch, its public key is published, and its write deadline remains valid;
7. checks the writer’s exact capability for CREATE or supersession;
8. derives `createdAt = block.timestamp`, lineage, parent, and version;
9. applies record, provenance, evidence, and lineage rules;
10. updates the canonical latest pointer only for context lineages.

Batch registration is supported, but each element is independently validated and the transaction is atomic.

### 11.5 New context lineage

A root context has:

```text
expectedParentId = 0
lineageId        = contextId
parentId         = 0
version          = 1
```

An agent needs CREATE. The owner needs no capability.

An owner may choose `OWNER_CONTROLLED`. An agent may only create `STANDARD` lineages. Owner-controlled status cannot later be removed.

### 11.6 Supersession

A superseding input names `expectedParentId`. The contract requires:

```text
expectedParentId exists
latest[parent.lineageId] == expectedParentId
same owner
same namespace
recordType == CONTEXT
readEpoch is current and writable
```

It derives:

```text
lineageId = parent.lineageId
parentId  = expectedParentId
version   = parent.version + 1
```

If the lineage advanced, the call reverts `STALE_PARENT`. There is no global lock, so unrelated lineages remain independent.

Agent rules:

- `SUPERSEDE_OWN` works only when the lineage root author is that agent.
- `SUPERSEDE_ANY` can supersede another author’s `STANDARD` lineage.
- No agent may supersede `OWNER_CONTROLLED`, even with `SUPERSEDE_ANY`.
- An agent may create a separate proposal lineage whose encrypted evidence references an anchor; the contract enforces the proposal’s authorship and commitment but cannot inspect encrypted evidence IDs.

### 11.7 Evidence

An evidence record:

- is immutable;
- requires `expectedParentId == 0`;
- has no lineage head and cannot be superseded;
- requires `LineagePolicy.STANDARD`, `ContextKind.NONE`, and `ProvenanceSource.NONE`;
- records supplier/source details such as artifact hash, URI, and retrieval time only inside its encrypted payload;
- may be referenced by encrypted evidence IDs in a context payload.

A context record requires non-`NONE` kind and provenance source. This keeps “an immutable artifact exists” separate from “this semantic claim came from that artifact.”

Attempts to supersede evidence revert `EVIDENCE_IMMUTABLE`.

### 11.8 Provenance enforcement

- `USER_ASSERTED` requires owner authorship.
- `USER_CONFIRMED` requires owner authorship and a non-zero evidence commitment; the SDK requires at least one `confirmed_from` reference.
- Agents can never submit either value.
- `AGENT_INFERRED` requires agent authorship, CREATE/supersession authority, and `ALLOW_INFERENCE`; an owner-authored record cannot label itself agent-inferred.
- `IMPORTED` requires `ALLOW_IMPORTED` for an agent and a non-zero `evidenceCommitment` revealing at least one registered evidence-record ID when decrypted.
- `EXTERNAL_ATTESTATION` requires `ALLOW_EXTERNAL_ATTESTATION` for an agent and a non-zero `evidenceCommitment` revealing at least one registered evidence-record ID when decrypted.
- Owner imports/attestations also require a non-zero evidence commitment.
- The contract can enforce only that the commitment is non-zero. The SDK/API verifies revealed typed references exist and recompute the commitment; it cannot prove the encrypted evidence semantically supports the claim.
- The contract does not interpret extraction confidence or claim truth; those remain encrypted payload semantics.

Payload references are canonicalized off-chain by mapping relation strings to fixed codes (`supports = 1`, `derived_from = 2`, `confirmed_from = 3`), sorting by `(relationCode, recordId)`, and removing duplicate pairs:

```text
evidenceCommitment = keccak256(
  abi.encode(
    "MIDA_EVIDENCE_V1",
    canonical RecordReference[]
  )
)
```

The commitment binds both record IDs and their claimed semantic relations. A public observer can verify only that the writer committed to a reference set. An authorized reader can decrypt the typed references, recompute the commitment, and verify the revealed set. The SDK additionally verifies that every referenced record exists under the same owner; the contract cannot inspect encrypted references.

`parentId` is not one of these generic semantic references. For context lineages it means only “the canonical record this version supersedes,” and the contract enforces it through `expectedParentId` and the latest pointer. Evidence records have `parentId == 0`.

A user-confirmed successor may edit an agent proposal. It need not contain identical plaintext. A `confirmed_from` reference means the new owner-authored claim acknowledges the proposal; it does not mean byte equality or replace the contract’s supersession rules.

### 11.9 Expiry semantics

A context `expiresAt` controls semantic freshness and default retrieval. It does not delete ciphertext, revoke keys, or make previously disclosed plaintext unknowable. This is separate from capability expiry and read-epoch write deadlines.

### 11.10 Events

```text
ContextRegistered
ContextSuperseded
EvidenceRegistered
```

`NamespaceEpochKeySet` is emitted by `CapabilityRegistry`, not here.

## 12. Minimal Context API

The Project 1 API is a thin storage and authorization service, not a trusted decryptor.

```text
PUT  /objects
GET  /objects?owner=&namespaceId=
PUT  /agent-manifests
GET  /agent-manifests/:bodyHash
POST /epoch-wraps
GET  /epoch-wraps?owner=&namespaceId=&readEpoch=&agentId=&agentKeyVersion=
GET  /manifests/:contextId
POST /revocations
POST /revocations/:id/cancel
```

Effective API authority is always the intersection:

```text
effectiveAllowed = currentlyAllowedByMonad AND NOT localDeny
```

A positive cache entry or pending grant can never make `currentlyAllowedByMonad` true. An owner-authenticated revocation intent may add `localDeny` before the chain transaction confirms, making access fail immediately. The deny remains if the transaction fails or is reorganized out; only the matching on-chain revocation or a fresh P256-approved cancellation removes it. This off-chain layer can reduce availability but cannot broaden authority.

### 12.1 Authentication

Owner and agent requests use EIP-712 signatures over:

```text
EIP-712 domain:
  name              = "Mida Context API"
  version           = "1"
  chainId           = configured Monad chain
  verifyingContract = configured CapabilityRegistry

MidaHttpRequestV1:
  signer
  methodHash        = keccak256(UTF8(uppercase method))
  targetHash        = keccak256(UTF8(canonical path + sorted query))
  bodyHash          = keccak256(raw request body bytes)
  timestamp
  nonce
```

`nonce` is a random `bytes32`. The API accepts `abs(serverTime - timestamp) <= 60 seconds` and rejects a repeated `(signer, nonce)` during that window. Empty bodies use `keccak256("")`. It recovers the current registered agent signer or exact owner account before performing authorization. Browser transport remains Project 2, but Project 1 freezes and tests this service-authentication format.

For every agent operation, the API validates in this normative fail-closed order and stops at the first failure:

```text
1. authenticate request signature and recover agent signer
2. resolve active agent identity
3. load the exact capability; require it exists
4. reject local deny, on-chain revocation, or agent-epoch mismatch
5. reject capability expiry (`expiresAt != 0 && now >= expiresAt`)
6. require exact namespace match
7. require the requested permission bit
8. require current registered agent signing/encryption key versions where relevant
```

The final epoch check is operation-specific:

- **Read:** the object epoch must be a registered current or historical epoch, and the returned reader wrap must match the requesting agent and encryption-key version. The current epoch’s write deadline does not block historical reads.
- **Create/supersede:** the submitted epoch must equal the current required epoch and `isWriteEpochValid` must be true.
- **Publish reader wrap:** the target epoch must be registered, and the currently active READ capability must still exist.

This distinction matters: an expired write deadline closes new writes, but it does not independently revoke a different reader whose capability remains valid.

### 12.2 Object upload

The API:

1. verifies owner or agent request identity;
2. loads the immutable manifest and checks its canonical hash;
3. checks ciphertext bytes against `ciphertextHash` and size;
4. checks `contextId`, namespace, and `readEpoch` correspondence;
5. checks that the submitted epoch is current and writable through the registries;
6. for agents, checks CREATE or applicable supersession authority;
7. stores ciphertext and manifest as pending upload data;
8. requires eventual matching Monad registration before serving it as anchored context.

Project 1 does not expose pending subscriptions. Failed registration data may be garbage-collected.

### 12.3 Object read

Before returning an object, manifest, or location hint to an agent, the API checks current exact READ authorization. It returns only objects in the authorized namespace and only the requesting agent’s matching reader-epoch wrap. It never treats possession of a historical wrap as current protocol authority.

### 12.4 Reader-epoch wrap publication

`POST /epoch-wraps` accepts a wrap only when:

1. the publishing request is authenticated as the owner;
2. the namespace and read epoch exist;
3. the recipient agent and encryption key version exactly match the registry;
4. the recipient has active exact READ authority for that namespace; the wrap may target the current epoch or a historical epoch that exists for a retained object;
5. for a current-epoch wrap, the epoch equals the registry’s current required epoch; for a historical wrap, the epoch key was previously registered for the same owner and namespace;
6. all wrap metadata and lengths are valid.

Owner authentication alone is insufficient. The API cannot grant access independently.

### 12.5 Fast revocation deny overlay

`POST /revocations` is owner-authenticated and names either one capability ID or one `(owner, agentId)` relationship. After verifying the target exists, the API records a unique revocation-intent ID and denies matching requests before returning success. The owner then submits the canonical Monad revoke/rotation transaction.

The overlay has only three transitions:

```text
active deny → anchored       matching Monad revocation observed
active deny → active deny    transaction failed, missing, or reorged out
active deny → cancelled      fresh owner P256-approved cancellation
```

Cancelling a deny restores authority and therefore uses stronger authorization than creating one. The Vault signs an assertion over:

```text
keccak256(abi.encode(
  "MIDA_CANCEL_FAST_REVOKE_V1",
  chainId,
  CapabilityRegistry address,
  owner,
  revocationIntentId,
  apiCancellationNonce,
  expiresAt
))
```

The API owns and consumes `apiCancellationNonce`, requires User Verification, and accepts the assertion only before its five-minute `expiresAt`. A delegated session signature alone cannot cancel a deny. There is no timeout that silently removes a deny. Capability expiry needs no overlay because both Monad authorization and API checks use the signed absolute `expiresAt`.

### 12.6 Typed failures

```text
CAPABILITY_DENIED
CAPABILITY_EXPIRED
CAPABILITY_REVOKED
EPOCH_ROTATION_REQUIRED
EPOCH_STALE
NO_EPOCH_WRAP
WRAP_KEY_VERSION_MISMATCH
MANIFEST_MISMATCH
CONTENT_HASH_MISMATCH
COMMITMENT_MISMATCH
DECRYPT_FAILED
INVALID_NAMESPACE
STALE_PARENT
EVIDENCE_IMMUTABLE
PROVENANCE_FORBIDDEN
ANCHOR_OWNER_ONLY
```

## 13. Project 1 SDK and FakeVault

### 13.1 Agent SDK surface

```ts
class MidaAgent {
  createAccessRequest(input: AccessRequestInput): Promise<AccessRequest>
  completeAccessRequest(request: AccessRequest, response: AccessGrantResponse): Promise<Grant>
  read(owner: Address, namespace: string): Promise<ContextObject[]>
  create(owner: Address, namespace: string, input: CreateContextInput): Promise<ContextObject>
  supersede(owner: Address, parentId: Hex, input: SupersedeContextInput): Promise<ContextObject>
  propose(owner: Address, namespace: string, input: ProposalInput): Promise<ContextObject>
}
```

`propose` always emits `AGENT_INFERRED`. No agent SDK function can emit `USER_ASSERTED` or `USER_CONFIRMED`.

### 13.2 Access request wire format

The Project 1 CLI uses the same EIP-712 request object that Project 2 will transport through a popup:

```ts
interface RequestedScope {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
}

interface AccessRequest {
  v: 1
  chainId: string
  capabilityRegistry: Address
  requestId: Hex
  nonce: Hex
  agentId: Hex
  purposeId: PurposeId
  callbackOrigin: string
  manifestHash: Hex
  manifestVersion: number
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  scopes: RequestedScope[]
  issuedAt: string
  requestExpiresAt: string
  capabilityExpiresAt: string // "0" means no capability expiry
  agentSignature: Hex
}

interface GrantedCapability {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: string
  capabilityId: Hex
  transactionHash: Hex
}

interface AccessGrantResponse {
  v: 1
  chainId: string
  capabilityRegistry: Address
  requestId: Hex
  nonce: Hex
  requestHash: Hex
  owner: Address
  agentId: Hex
  manifestHash: Hex
  manifestVersion: number
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  capabilities: GrantedCapability[]
}
```

`createAccessRequest` canonicalizes builder-supplied namespace strings and expands parent scopes through the frozen tree before signing. `requestId` and `nonce` are independent random `bytes32` values. Exact scopes are sorted by `namespaceId` and unique. `issuedAt <= now < requestExpiresAt`, and `requestExpiresAt - issuedAt` may not exceed 600 seconds. `capabilityExpiresAt` is the requested grant expiry and is separate from request-message validity.

The agent signs:

```text
EIP-712 domain:
  name              = "Mida Context"
  version           = "1"
  chainId           = request.chainId
  verifyingContract = request.capabilityRegistry

MidaAccessRequestV1:
  requestId
  nonce
  agentId
  purposeIdHash      = keccak256(UTF8(purposeId))
  callbackOriginHash = keccak256(UTF8(canonicalOrigin))
  manifestHash
  manifestVersion
  policyVersionHash        = keccak256(UTF8(policyVersion))
  namespaceTreeVersionHash = keccak256(UTF8(namespaceTreeVersion))
  scopesHash         = keccak256(abi.encode(sorted exact RequestedScope[]))
  issuedAt
  requestExpiresAt
  capabilityExpiresAt
```

The Vault verifies the signature against the current registered agent signer and requires `callbackOriginHash` to equal the registered value. The CLI does not open a browser, but it still exercises the exact signature and origin checks.

`AccessGrantResponse` carries no authority of its own and contains no key material. Its capability and transaction identifiers are hints that must be checked against Monad.

### 13.3 Request completion

`createAccessRequest` persists the original request by `requestId` until `requestExpiresAt` and marks it consumed only after successful completion. Even in the CLI flow, `completeAccessRequest` verifies the response against that original stored request:

- request ID, nonce, request hash, agent ID, chain, and registry match;
- manifest hash/version and namespace-tree/policy versions match the evaluated request and current registry constants;
- every granted exact namespace was within the request’s effective expanded authority;
- every permission and provenance bit is a subset of what was requested;
- if requested `capabilityExpiresAt` is finite, every granted expiry is finite and no later; if requested value is `"0"`, the user may still narrow it to a finite expiry;
- every capability’s owner, agent, exact namespace, permissions, provenance policy, expiry, and transaction receipt match the response and original request;
- each capability exists and is currently valid on-chain;
- a successfully consumed `requestId` cannot be completed again.

The chain proves a capability exists. The original request proves it is the capability this app requested.

### 13.4 FakeVaultAuthority

The FakeVault:

- derives deterministic fake domain outputs from a test seed without modeling a global root API;
- derives namespace and epoch keypairs through the production crypto package;
- loads and verifies the current signed agent manifest;
- runs the deterministic Grant Advisor and accepts an explicit final effective-authority subset;
- uses a software P256 key to create valid WebAuthn-shaped assertions binding request, manifest, policy/tree versions, final authority, expiry, and nonce;
- submits owner-account grant and revoke/rotation batches;
- creates and publishes reader-epoch wraps only after chain authorization exists;
- never gives namespace secrets or epoch private keys directly to the app boundary;
- returns only grant receipts, owner identity, and transaction hashes.

Project 1 server agent signing and X25519 private keys may use environment-held test secrets. Production deployments should choose managed secret storage, hardware security modules, or multiparty custody according to their custody and threat model; environment-held keys are a reference implementation choice, not a protocol custody recommendation.

## 14. Grant Advisor

The Grant Advisor is a deterministic policy layer between an agent’s signed request and the owner’s final consent. It never creates authority:

```text
agent signed request
→ deterministic narrower recommendation
→ user accepts, narrows further, customizes within request, or denies
→ P256 approval over final exact authority
```

The governing principle is:

> Agents request access. Mida minimizes it. Users decide.

The authority roles are distinct:

```text
AgentCapabilityManifest   what the agent claims it may need across its features
signed AccessRequest      what the agent asks for right now
Mida policy               deterministic sensitivity and risk classification
user P256 approval        the final effective-authority subset actually granted
```

### 14.1 Agent Capability Manifest

Sensitivity is not agent-declared. The manifest contains only the agent’s identity, supported purposes, requested capabilities, and reasons.

```ts
type PurposeId =
  | "general_assistance"
  | "career_coaching"
  | "project_assistance"
  | "travel_planning"

interface PurposeDeclaration {
  id: PurposeId
  description: string
}

interface ScopeDeclaration {
  purposeId: PurposeId
  namespace: string
  permissions: Permission[]
  provenancePolicies?: ProvenancePolicy[]
  reason: string
}

interface AgentCapabilityManifestBody {
  v: 1
  agentId: Hex
  manifestVersion: number
  name: string
  purposes: PurposeDeclaration[]
  scopeDeclarations: ScopeDeclaration[]
  issuedAt: number
}

interface SignedAgentCapabilityManifest {
  manifest: AgentCapabilityManifestBody
  operatorSignature: Hex
}
```

The body is Unicode NFC-normalized, RFC 8785 canonicalized, UTF-8 encoded, and hashed:

```text
bodyHash = keccak256(canonicalManifestBodyBytes)
```

The registered operator signs only this fixed EIP-712 binding:

```text
EIP-712 domain:
  name              = "Mida Agent Capability Manifest"
  version           = "1"
  chainId           = configured chain
  verifyingContract = CapabilityRegistry

ManifestBinding:
  bytes32 bodyHash
  bytes32 agentId
  uint64  manifestVersion
```

Arrays and strings are encoded once by canonical body hashing; EIP-712 does not define a second representation of manifest contents.

The signed envelope is independently canonicalized and content-addressed:

```text
envelopeBytes = UTF8(RFC8785(SignedAgentCapabilityManifest))
envelopeHash  = SHA256(envelopeBytes)
```

`envelopeHash` addresses the actual stored envelope bytes but is not stored in `AgentRecord`. The public metadata service maintains:

```text
bodyHash → envelopeHash
envelopeHash → canonical signed envelope bytes
```

`GET /agent-manifests/:bodyHash` resolves the index and then verifies `SHA256(envelopeBytes) == envelopeHash`, recomputes the inner body hash, and verifies the operator signature. The body-hash index itself is not called content-addressed storage because the envelope bytes do not hash to `bodyHash`.

`AgentRecord` stores:

```text
capabilityManifestHash    = bodyHash
capabilityManifestVersion = manifestVersion
```

Version starts at 1 and increases by exactly one. Registration requires version 1. `updateAgentCapabilityManifest(agentId, bodyHash, version, operatorSignature)` requires the current operator, a valid signature over the exact typed binding, and the next version. The contract verifies the signed binding but cannot inspect the hashed JSON body; the API/Vault recomputes the body hash and verifies body `agentId` and version before use. The update emits `AgentCapabilityManifestUpdated`.

`issuedAt` must not be in the future and is informational chronology; currentness comes from the onchain hash/version, not age. Limits are deterministic: 1–80 UTF-8 bytes for `name`, 1–280 for each description/reason, at most 8 purposes, at most 32 scope declarations, no duplicate purpose IDs, and no duplicate `(purposeId, canonical namespace)` declarations. Every namespace and permission must be valid under protocol v1. Display text is untrusted, escaped by the UI, and never interpreted as policy instructions.

The Context API exposes:

```text
PUT /agent-manifests
GET /agent-manifests/:bodyHash
```

Upload may precede the registry transaction, but an envelope is current only when its body hash/version match `AgentRecord`. Missing, mutated, incorrectly signed, or stale envelopes fail closed.

### 14.2 Protocol-owned namespace sensitivity

```text
LOW
  preferences
  preferences.communication
  preferences.tools
  preferences.work
  profile.skills
  projects.current

MEDIUM
  profile
  profile.identity
  goals
  goals.career
  goals.learning
  goals.personal
  projects
  projects.past
  decisions
  decisions.career
  decisions.projects
  relationships

HIGH
  credentials
  financial
  financial.preferences
  private
```

A parent’s effective sensitivity is at least the highest sensitivity of every namespace it expands to. Sensitivity belongs to immutable policy version `mida-grant-policy-v1`; manifest claims cannot lower it. The canonical policy document is RFC 8785 hashed, and `CapabilityRegistry` exposes the matching `POLICY_HASH_V1` constant. Cross-language tests require the TypeScript policy hash and Solidity constant to match so UI and contract rules cannot silently drift.

Consent consequences belong to Project 2, but Project 1 freezes them:

```text
LOW       normal approval
MEDIUM    explicit justification
HIGH      warning + individual selection; never default-selected
```

No “select all” action may select HIGH authority.

### 14.3 Purpose policy

Every exact `(purposeId, namespaceId)` is one of:

```text
EXPECTED       eligible for default recommendation with permitted bits
ELEVATED       excluded by default; user may explicitly select
SUSPICIOUS     excluded with critical warning
UNCLASSIFIED   excluded because policy has no basis to recommend
```

The initial exact policy is:

| Purpose | Expected | Elevated | Suspicious |
|---|---|---|---|
| `general_assistance` | `preferences.communication:READ`, `profile.skills:READ` | `projects.current:READ` | every HIGH namespace |
| `career_coaching` | `profile.skills:READ`, `goals.career:READ|CREATE + ALLOW_INFERENCE`, `preferences.communication:READ` | `profile.identity:READ`, `projects.current:READ` | every HIGH namespace |
| `project_assistance` | `profile.skills:READ`, `projects.current:READ|CREATE|SUPERSEDE_OWN + ALLOW_INFERENCE`, `preferences.communication:READ` | `decisions.projects:CREATE + ALLOW_INFERENCE`, `goals.career:READ` | every HIGH namespace |
| `travel_planning` | `preferences:READ` after exact tree expansion | `profile.identity:READ` | every HIGH namespace |

Because travel uses generic `preferences` rather than a dedicated travel namespace, its recommendation emits `BROAD_PARENT_SCOPE` and lists `preferences`, `preferences.communication`, `preferences.tools`, and `preferences.work`. It must not label that bundle as travel-only data.

`SUPERSEDE_ANY` is never default-recommended, even if a future purpose table marks it expected. It requires explicit individual user selection, like HIGH authority. `SUPERSEDE_OWN` may be recommended where listed.

For expected CREATE or supersession entries, `ALLOW_INFERENCE` may be recommended only when both manifest and purpose policy declare it. `ALLOW_IMPORTED` and `ALLOW_EXTERNAL_ATTESTATION` are always ELEVATED in v1 and require explicit selection. Provenance-policy bits are effective authority and follow the same subset rules as permissions.

### 14.4 Duration policy

```text
LOW       recommendation cap: 30 days
MEDIUM    recommendation cap: 7 days
HIGH      final-selection cap: 24 hours
```

The recommended expiry is the earliest of the requested expiry and the strictest included sensitivity cap. Project 1 grants use one expiry per batch. If the user adds HIGH authority, the entire final batch is capped at 24 hours. Separate expiry groups are deferred.

### 14.5 Effective authority and narrowing

Policy never compares only namespace strings. It expands each parent against immutable namespace-tree v1 and represents authority as exact tuples:

```ts
interface EffectiveAuthority {
  namespaceId: Hex
  permission: Permission
  provenancePolicy?: ProvenancePolicy
}
```

For example, `preferences:READ` expands to exact READ authority over the parent and its three frozen children. Effective authority includes namespace, every permission bit, every provenance-policy bit, and expiry.

The invariants are:

```text
authority(recommended) ⊆ authority(requested)
authority(final)       ⊆ authority(requested)
recommended expiry     ≤ requested expiry
final expiry           ≤ requested expiry
```

A shorter expiry is narrower. For requested expiry 0 (unbounded), any finite expiry is narrower. A finite request can never become unbounded.

The package exposes one pure deterministic entry point:

```ts
interface OwnerAgentHistory {
  owner: Address
  agentId: Hex
  previouslyRevoked: boolean
  observedThroughBlock: bigint
}

interface GrantAdvisorInput {
  request: AccessRequest
  manifest: SignedAgentCapabilityManifest
  agentRecord: AgentRecord
  ownerHistory: OwnerAgentHistory
  now: bigint
}

function adviseGrant(input: GrantAdvisorInput): GrantAdvice
```

The chain adapter constructs `ownerHistory` from canonical `CapabilityRevoked` and `AgentRevoked` events for exactly `(owner, agentId)`. The pure Advisor verifies those identifiers match the request but does not accept global reputation or mutable access telemetry.

The Advisor algorithm is normative:

```text
1. verify current agent identity and manifest hash/version/signature
2. verify requested purpose is declared
3. expand requested and declared parents through immutable tree v1
4. derive sensitivity only from policy v1
5. classify every exact scope under the purpose policy
6. intersect requested permission/provenance bits with permitted bits
7. exclude ELEVATED, SUSPICIOUS, UNCLASSIFIED, HIGH, and SUPERSEDE_ANY by default
8. apply the strictest duration cap
9. compute warnings and risk
10. assert effective-authority subset before returning
```

Undeclared access remains user-overridable because the user is the final authority, but it is never recommended.

### 14.6 Advice result

```ts
interface ScopeWarning {
  code:
    | "SCOPE_NOT_DECLARED"
    | "SCOPE_UNCLASSIFIED"
    | "SCOPE_ELEVATED"
    | "SCOPE_SUSPICIOUS"
    | "HIGH_SENSITIVITY"
    | "BROAD_PARENT_SCOPE"
    | "SUPERSEDE_ANY_EXPLICIT"
    | "PERMISSION_NARROWED"
    | "PROVENANCE_POLICY_NARROWED"
    | "DURATION_NARROWED"
    | "PREVIOUSLY_REVOKED"
  namespaceId?: Hex
  relatedNamespaceIds?: Hex[]
  severity: "info" | "warning" | "critical"
  messageKey: string
}

interface GrantAdvice {
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  requestHash: Hex
  manifestHash: Hex
  manifestVersion: number
  recommended: RequestedScope[]
  recommendedExpiresAt: string
  warnings: ScopeWarning[]
  risk: "low" | "medium" | "high"
}
```

Risk is deterministic:

- LOW-only recommendation with no warnings is low.
- Any MEDIUM scope or warning makes risk at least medium.
- Any HIGH, suspicious, undeclared, or `PREVIOUSLY_REVOKED` condition is high.
- Identity, request, signature, manifest hash, or version failures return no advice and open no consent screen.

`PREVIOUSLY_REVOKED` means this owner previously revoked this exact agent identity, based only on canonical chain events. Revocation by another owner does not trigger it. Mutable access telemetry is never a reputation input, and a new agent identity can evade this limited history.

### 14.7 Request and P256 grant binding

`AccessRequest` binds `purposeId`, `manifestHash`, `manifestVersion`, `policyVersion`, `namespaceTreeVersion`, and the expanded exact requested authority. The agent signer signs the request.

The owner’s P256 challenge binds:

```text
keccak256(abi.encode(
  "MIDA_GRANT_V1",
  chainId,
  CapabilityRegistry address,
  owner,
  agentId,
  requestHash,
  manifestHash,
  manifestVersion,
  keccak256(UTF8("mida-grant-policy-v1")),
  keccak256(UTF8("mida-namespace-tree-v1")),
  keccak256(abi.encode(final exact GrantScope[])),
  expiresAt,
  grantNonce[owner]
))
```

`grantBatch` receives the agent-signed request and final exact scopes. It verifies the current agent signature, current manifest hash/version, supported tree/policy versions, effective-authority subset, final expiry narrowing, P256 assertion, and nonce. The contract does not require the final set to equal the recommendation because the user may override the Advisor. It does require the final set to remain within what the agent signed.

The contract rejects a submission whose request, manifest, policy/tree versions, final authority, expiry, or nonce differ from the P256-signed challenge. This prevents stale-state and post-signature substitution. It does not make a compromised Vault UI truthful: WebAuthn signs challenge bytes, not the human-readable scopes the page displayed. The security model therefore still requires the sole Vault origin to render the bound values correctly; Project 2 must harden that origin with a minimal dependency surface and strict content security policy.

### 14.8 Progressive grants and AI boundary

Progressive grants use another complete signed request and P256 approval when a later feature needs more authority. The protocol cannot prove when a human reached a feature; contextual timing is a Project 2 UX rule.

Project 1 returns deterministic warning codes and message keys. Project 2 may let a model rewrite those facts into plain language, but model output is never policy input, recommendation input, or authority. If deterministic evaluation fails, the Vault fails closed; it never falls back to raw scopes or model judgment.

Hard failures return no advice:

```text
MANIFEST_NOT_FOUND
MANIFEST_HASH_MISMATCH
MANIFEST_SIGNATURE_INVALID
MANIFEST_STALE
AGENT_ID_MISMATCH
PURPOSE_UNKNOWN
REQUEST_SIGNATURE_INVALID
NAMESPACE_TREE_VERSION_UNSUPPORTED
POLICY_VERSION_UNSUPPORTED
```

### 14.9 Design precedents

The Advisor adapts three verified practices without importing their authority models:

- Google OAuth recommends the narrowest necessary scope and distinguishes non-sensitive, sensitive, and restricted scopes.
- Android recommends contextual permission requests when a feature needs them, clear rationale, and graceful denial.
- Vana uses stable hierarchical scopes plus human-readable scope labels/descriptions in consent surfaces.

Sources verified 2026-09-14:

- `https://developers.google.com/workspace/guides/configure-oauth-consent`
- `https://developer.android.com/training/permissions/requesting`
- `https://docs.vana.org/protocol-reference/scopes-schemas`

## 15. Adversarial test matrix

Every behavior below must first exist as a failing test, fail for the intended reason, and only then receive implementation.

| Area | Test | Required result |
|---|---|---|
| Namespace | canonicalize `Goals.Career` | `goals.career` |
| Namespace | repeated separator or unknown node | `INVALID_NAMESPACE` |
| Namespace | caller invents a parent/path | no such input exists; forged scope rejected |
| Namespace | deployed v1 tree receives a new child | impossible; no mutation function exists |
| Advisor | mutate manifest body after signing | body-hash/signature verification fails |
| Advisor | use manifest envelope from another chain/registry | operator signature fails |
| Advisor | request references stale manifest version | hard failure; no advice/consent |
| Advisor | API maps body hash to wrong envelope bytes | envelope/body hash verification fails |
| Advisor | non-operator or skipped/replayed manifest version update | contract rejection |
| Advisor | parent scope is recommended | effective exact authority stays within frozen request expansion |
| Advisor | randomized request/property test | recommendation is always an effective-authority subset |
| Advisor | TypeScript and Solidity policy hashes | exact equality |
| Advisor | HIGH scope requested | excluded from default recommendation |
| Advisor | HIGH final grant exceeds 24 hours or is unbounded | contract rejection |
| Advisor | `SUPERSEDE_ANY` requested | excluded from default recommendation |
| Advisor | excessive permissions requested | recommendation contains only policy-permitted bits |
| Advisor | imported/attestation provenance requested | elevated and excluded by default |
| Advisor | excessive duration requested | recommendation expiry is narrowed |
| Advisor | undeclared scope requested | excluded with warning; user may explicitly select |
| Advisor | same owner previously revoked agent | `PREVIOUSLY_REVOKED`, high risk |
| Advisor | another owner revoked agent | no `PREVIOUSLY_REVOKED` warning |
| Advisor | caller attempts to supply model/explanation input | Advisor interface has no such input; deterministic output unchanged |
| Crypto | wrong namespace secret | AEAD unwrap/decrypt failure |
| Crypto | wrong read epoch | cannot unwrap object DEK |
| Crypto | all-zero X25519 public/shared secret | rejected before HKDF |
| Crypto | mutate ciphertext | hash or decrypt failure |
| Crypto | mutate manifest | Monad commitment mismatch |
| Crypto | transplant object wrap to another object | AAD failure |
| Crypto | transplant reader wrap to another agent/version | AAD failure |
| Isolation | general output used for financial | derived key differs and decrypt fails |
| CREATE | CREATE-only agent obtains epoch public key | new write succeeds |
| CREATE | CREATE-only agent requests epoch private wrap | rejected |
| CREATE | CREATE-only agent reads existing object | capability denied and decryption unavailable |
| READ | valid reader receives wrapped epoch private key | reads epoch object |
| READ | newly granted reader requests retained historical epoch | historical wrap allowed while capability is active |
| READ | remaining reader crosses an epoch rotation | capability stays valid; new wrap restores access |
| Capability | replay grant assertion | rejected by owner grant nonce |
| Capability | final exact authority exceeds signed request | contract rejection |
| Capability | wrong request/manifest/policy/tree hash in P256 challenge | contract rejection |
| Capability | manifest updates between request and grant | stale request rejected |
| Capability | grant signed for wrong chain or registry | rejected |
| Capability | grant signed without user-verification flag | rejected |
| Capability | assertion whose `authenticatorData[0:32]` is not the configured Vault RP-ID hash | rejected by the Mida wrapper |
| Capability | assertion with high-s signature | rejected by `webauthn-sol`; shared assertion adapter normalizes FakeVault and real WebAuthn signatures to low-s |
| Capability | assertion with a foreign `clientDataJSON.origin` but correct RP-ID hash | accepted on-chain; documented v0 limitation, origin is enforced by the browser |
| Capability | live session tries to overwrite registered P256 key | rejected |
| Capability | P256 rotation lacks old-key assertion | rejected |
| Capability | broaden response beyond request | completion rejected |
| Capability | user narrows requested permissions | completion accepted |
| Revocation | `revoke` called on an active READ capability | rejected; only `revokeAndRotate` may end READ |
| Revocation | `revokeAgentAndRotate` with a missing, duplicate, or extra namespace rotation | rejected |
| Revocation | `CapabilityRegistry` attempts to publish a key through `ContextRegistry` | no such function exists; keys live only in `CapabilityRegistry` |
| Revocation | revoke one reader | capability immediately fails |
| Revocation | write in old epoch after revoke | `EPOCH_STALE` or rotation required |
| Revocation | object written after rotation | old reader cannot decrypt |
| Revocation | agent-wide revocation | every old capability epoch fails |
| Revocation | previously disclosed epoch/plaintext | explicitly remains usable outside protocol |
| Expiry | READ grant expires | authorization fails |
| Expiry | write at exactly deadline | `EPOCH_ROTATION_REQUIRED` |
| Expiry | write after deadline | `EPOCH_ROTATION_REQUIRED` |
| Expiry | owner rotates after deadline | new writes resume in next epoch |
| Epoch | new short-lived reader lowers deadline | exact earlier deadline stored |
| Epoch | remaining reader lacks new wrap briefly | read fails `NO_EPOCH_WRAP`, not authorization |
| Identity | wrong agent encryption key version | wrap publication/read rejected |
| Identity | register an agent without signer acceptance proof | rejected |
| Identity | reuse one active signer for another agent ID | rejected |
| Identity | non-operator rotates agent key | rejected |
| Identity | signing-key rotation lacks new-signer proof | rejected |
| Provenance | agent submits `USER_ASSERTED` | rejected |
| Provenance | agent submits `USER_CONFIRMED` | rejected |
| Provenance | owner submits `USER_CONFIRMED` without evidence commitment | rejected |
| Provenance | owner labels a record `AGENT_INFERRED` | rejected |
| Provenance | imported/attested without evidence | rejected |
| Anchor | `SUPERSEDE_ANY` agent edits owner-controlled lineage | rejected |
| Anchor | agent creates separate proposal | accepted with inference policy |
| Evidence | supersede evidence | `EVIDENCE_IMMUTABLE` |
| Evidence | duplicate typed references canonicalized | one sorted unique-pair commitment |
| Evidence | mutate relation but keep record ID | commitment mismatch |
| Lineage | use generic reference as a supersession parent | does not change canonical head |
| Lineage | same current parent superseded twice | second gets `STALE_PARENT` |
| Lineage | caller forges version/lineage/author | fields absent or recomputed; forgery rejected |
| Concurrency | independent roots/lineages created concurrently | both succeed |
| API | forged or expired capability | denied |
| API | pending grant absent from Monad | denied; fast plane cannot broaden authority |
| API | owner posts revocation before chain confirmation | matching access denied immediately |
| API | revocation transaction fails or reorgs | deny remains until P256-approved cancellation |
| API | delegated owner session tries to cancel deny | rejected without fresh P256 approval |
| API | replay P256 deny-cancellation assertion | rejected by API nonce |
| API | expired epoch deadline with separately valid reader | historical read allowed; new write denied |
| API | replay signed HTTP nonce inside validity window | denied |
| API | owner-authenticated wrap without recipient capability | denied |
| API | obsolete read-epoch object upload | denied |
| Storage | provider returns bytes for wrong hash | `CONTENT_HASH_MISMATCH` |
| Recovery seam | same fake domain output in fresh process | same epoch key and successful decrypt |
| Recovery seam | different fake domain output | decrypt fails |
| P256 | software assertion on default Anvil fallback | grant verifies |
| P256 | same assertion through enabled local precompile | grant verifies |
| P256 | same assertion on Monad testnet | grant verifies |

Real same-passkey fresh-browser recovery is not claimed by Project 1; Project 1 proves only the deterministic derivation seam with fake PRF outputs.

## 16. Mandatory end-to-end scenario

The CLI harness must execute this sequence against local contracts and then Monad testnet:

```text
1. Alice registers owner P256 and initial goals.career epoch-1 public key.
2. Agents A, B, and C register signed capability manifests whose body hashes/versions are committed in AgentRecord.
3. Alice creates encrypted goals.career context under epoch 1.
4. Agent A signs a career_coaching request for READ goals.career plus unnecessary READ financial.
5. Grant Advisor recommends only READ goals.career, emits HIGH/suspicious warnings for financial, and proves effective-authority narrowing.
6. Alice uses the recommendation; P256 approval binds request, manifest, policy/tree versions, final exact READ goals.career, expiry, and grant nonce.
7. FakeVault publishes the epoch-1 private key wrapped to Agent A’s registered key/version.
8. Agent A verifies manifest/ciphertext commitments, unwraps, and decrypts.
9. Agent B has no grant and receives CAPABILITY_DENIED.
10. Agent C receives an advised exact CREATE goals.career grant without READ.
11. Agent C uses only the public epoch key to create a new encrypted lineage.
12. Agent C cannot fetch a reader wrap or decrypt Alice’s existing object.
13. Alice posts an owner-signed revocation intent; the Context API denies Agent A before chain confirmation.
14. Alice atomically revokes Agent A on Monad and advances goals.career to epoch 2 with its public key.
15. Agent C writes a new object under epoch 2.
16. Agent A’s chain read fails and its epoch-1 private key cannot decrypt the epoch-2 object.
17. A remaining authorized reader receives an epoch-2 wrap and continues normally.
```

Success requires assertions at every denial and cryptographic boundary. Console output alone is not proof.

## 17. Deployment and configuration

- Solidity: `0.8.28`.
- Contract tests and deployment: Foundry.
- TypeScript runtime: Node.js 22 LTS.
- Package manager: pnpm with a committed lockfile.
- EVM client: viem.
- Contracts use deterministic CREATE2 deployment where convenient, but SDK configuration pins addresses per network. Matching addresses across networks are not required.
- Monad mainnet chain ID is `143`.
- Monad testnet chain ID is `10143`; the default public RPC is `https://testnet-rpc.monad.xyz`. These values are pinned in checked-in network configuration and were verified from Monad’s official testnet documentation on 2026-09-14.
- Monad’s P256 verifier is EIP-7951 at `0x0100`, accepts 160 bytes `(hash, r, s, qx, qy)`, returns 32-byte `1` on success, and costs 6,900 gas according to Monad’s official precompile documentation on 2026-09-14. EIP-7951 accepts any `0 < s < n`; low-s is enforced by `webauthn-sol`, not the precompile (Section 10.4). Live-verified on both testnet and mainnet on 2026-09-14.
- viem ships `monadTestnet` (10143) and `monad` (143) in `viem/chains`; use them rather than hand-written chain objects.
- Exact dependency pins (verified 2026-09-14; nothing younger than seven days is pinned):

  ```text
  @noble/curves   2.4.0
  @noble/hashes   2.4.0
  @noble/ciphers  2.4.0
  ox              1.7.4
  viem            2.56.3
  canonicalize    4.0.0
  webauthn-sol    v1.0.0 (619f20a)
  Foundry         1.8.1 (built 2026-08-28; P256 precompile at 0x100 verified on this build)
  ```

  The execution plan must include an explicit pinned Foundry setup step (`foundryup --install 1.8.1`) so a fresh machine reproduces the same toolchain.
- Monad public RPC behaviour that affects the indexer/CLI: the default public RPC caps `eth_getLogs` at 100 blocks per request. This limit is provider-specific, so the implementation always chunks log queries into windows of at most 100 blocks regardless of provider. `eth_getTransactionByHash` returns `null` for mempool transactions. Official timing: 300 ms minimum block frequency, 600 ms full finality, state execution generally under 800 ms; do not present execution latency as finality. Testnet state was reset from genesis on 2025-12-16; the chain ID did not change.
- P256/WebAuthn verification still goes through the selected audited verifier abstraction rather than custom JSON parsing or curve code.
- No secret, private key, PRF output, plaintext DEK, or plaintext context value may be committed to Git or logged.

## 18. Security invariants

Project 1 is incomplete unless all of these hold:

1. No plaintext private context is written to Monad or persistent server logs.
2. No global PRF root crosses `VaultAuthority` or is intentionally persisted.
3. General, financial, relationships, and private PRF domains derive unrelated secrets.
4. CREATE does not imply READ.
5. Agents cannot manufacture `USER_ASSERTED` or `USER_CONFIRMED`.
6. Namespace ancestry and registration are protocol state, never caller assertions.
7. Owner, author, creation time, lineage, parent, and version are contract-derived or contract-verified.
8. Grant replay fails through a contract-controlled nonce.
9. Agent-wide revocation invalidates historical capabilities through an agent epoch.
10. Any ended READ authority prevents new writes under the disclosed epoch.
11. An epoch accepts writes only before its deadline, with strict `<` comparison.
12. Revocation and expiry are forward-only and never described as retroactive forgetting.
13. Ciphertext and manifest mutation are detected before decryption.
14. Recipient wraps are bound to exact object/namespace/epoch or owner/namespace/epoch/agent/key-version tuples.
15. Evidence is immutable; owner-controlled lineages cannot be superseded by agents.
16. Independent lineages do not share a global object nonce or lock.
17. A stale expected parent cannot become the canonical head.
18. Context API authorization cannot create authority absent from Monad.
19. Namespace-tree v1 and sensitivity/purpose policy v1 are protocol-owned and immutable for that version.
20. Agent manifests cannot declare or lower sensitivity.
21. Recommended effective authority is always a subset of the agent-signed requested effective authority.
22. Final effective authority is always a subset of the agent-signed requested effective authority and is enforced by the contract.
23. HIGH authority and `SUPERSEDE_ANY` are never default-recommended.
24. P256 grant approval binds request hash, current manifest hash/version, policy/tree versions, final exact authority, expiry, and contract nonce.

## 19. Completion gate

Project 1 passes only when:

- unit and property tests cover canonicalization, immutable authority expansion, manifest hashing/signing, Advisor subset invariants, derivation, encryption, wraps, storage, and wire validation;
- Foundry adversarial tests cover request/final subset enforcement, manifest/policy/tree grant binding, grants, replay, exact scopes, provenance, anchors, evidence, expiry, epoch rotation, and stale parents;
- API integration tests prove the normative validation order, chain-bounded authorization, immediate local deny, and authorization checks for reads and reader-wrap publication;
- the complete CLI scenario passes locally;
- the same scenario passes against deployed Monad testnet contracts;
- local fallback and native P256 verification paths are distinguished and evidenced;
- the final diff receives adversarial review focused on cross-layer authorization and deployment differences.

Passing Project 1 proves the protocol core and its seams. It does not claim that browser passkey recovery, low-latency subscriptions, compiler provenance, dispersed storage, or the consumer demo already exist.
