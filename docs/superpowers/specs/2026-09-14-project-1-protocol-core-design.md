# Mida Context v0 — Project 1 Protocol Core Design

**Status:** Approved design; executable specification awaiting written review  
**Date:** 2026-09-14  
**Repository:** `/Users/you/Desktop/mida-context`  
**Product:** Passkey-native, user-owned context for AI agents  
**Project 1 exit:** Alice creates encrypted context, grants Agent A, A reads, Agent B is denied, Alice revokes A and rotates the read epoch, A is denied future context, and a CREATE-only Agent C can write without reading existing context—all against Monad testnet without a UI.

## 1. Purpose

Mida Context lets a person teach one AI something and selectively make that context available to other AI agents. The protocol separates four concerns:

1. **Monad authorization:** who owns context, which agent may perform which operation, and whether authority remains valid.
2. **User-owned encryption:** the user’s passkey-derived secrets are the root of read authority; Mida has no master decryption key.
3. **Encrypted storage:** storage providers hold content-addressed ciphertext, not plaintext.
4. **Provenance:** every context record states who created it, how it was derived, and how it relates to earlier records.

Project 1 proves these protocol assumptions with a software `FakeVaultAuthority`. Real Mera/WebAuthn, browser recovery, popup handoff, materialized current state, subscriptions, and reference applications belong to later projects.

## 2. Project 1 scope

### 2.1 Build now

- A pnpm TypeScript monorepo and Foundry contracts.
- `@mida/protocol`: canonical types, identifiers, namespace rules, error codes, and encodings.
- `@mida/crypto`: namespace derivation, asymmetric read epochs, XChaCha20-Poly1305 payload encryption, and X25519 wraps.
- `CapabilityRegistry`: owner P256 keys, global agent identities, exact capabilities, grant replay protection, revocation, expiry deadlines, and read-epoch generations.
- `ContextRegistry`: namespace epoch public keys, immutable evidence/context records, provenance enforcement, lineage policy, latest pointers, and stale-parent protection.
- `MemoryStorage` and `FsStorage` behind `ContextStorage`.
- A minimal Context API that stores ciphertext, immutable manifests, and reader-epoch wraps while enforcing current chain authorization.
- `FakeVaultAuthority` using software P256 and deterministic fake PRF-domain outputs.
- An agent/server SDK for access requests, capability verification, read, create, and supersede.
- A CLI integration harness and Monad testnet smoke test.

### 2.2 Explicitly deferred

- Real Mera/WebAuthn PRF and passkey recovery: Project 2.
- Browser Vault, popup/redirect handoff, and React component: Project 2.
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

## 4. Trust and authority boundaries

### 4.1 Owner

The owner is the Mera-derived delegated account address. Every owner contract operation must enter from execution by that account, so the registries observe `msg.sender == owner`. Gas sponsorship alone does not establish owner identity; a relayer calling a registry directly is the relayer and is rejected.

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
  active: boolean
}
```

- The signer authenticates requests and contract writes.
- The X25519 encryption key receives wrapped read-epoch private keys.
- The operator submits registration, but the proposed signing key must sign an EIP-712 registration binding the operator, agent ID, signer, encryption key/version, callback origin hash, chain, and registry.
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

The maximum depth is two segments. The deployment registers each node and its parent. Roots have parent `bytes32(0)`.

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

Explicit revocation/scope reduction executes an atomic owner-account batch:

```text
invalidate capability or increment agent epoch
→ advance required read epoch
→ publish new epoch public key
```

At expiry there is no automatic transaction. The expired capability immediately fails authorization, and the old epoch immediately stops accepting new records because its deadline is no longer in the future. The owner must publish the next epoch public key to resume writes.

The next epoch’s deadline is recomputed from remaining active READ capabilities. Project 1 permits at most 32 active exact capabilities per `(owner, namespaceId)` so this scan is bounded. Revoked and expired entries may be compacted during rotation.

Distribution of the new private epoch key is off-chain and follows the transaction. Remaining readers may temporarily fail to read new-epoch objects until their new reader wraps are published. This is an availability reduction, not an authorization failure.

### 7.4 Forward-only limitation

- Existing historical reads still require a currently valid chain capability when using Mida services.
- Expiry or revocation cannot remove an epoch private key or plaintext already disclosed.
- No new record can use an obsolete or write-expired epoch.
- A reader holding epoch 7 may independently decrypt epoch-7 ciphertext it already has or later obtains.
- It cannot decrypt epoch-8 objects unless it receives epoch 8’s private key.

## 8. Cryptographic objects

Project 1 uses `@noble/curves`, `@noble/hashes`, and `@noble/ciphers`. It does not implement cryptographic primitives.

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
interface ContextPayload {
  v: 1
  value: string | Record<string, unknown>
  kind: ContextKind
  provenance: {
    source: ProvenanceSource
    extractionConfidence?: number
    evidenceIds?: Hex[]
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
- Register global agent signing/encryption identities and callback origin hashes.
- Rotate agent signing/encryption keys under operator authority.
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

The WebAuthn challenge is the 32-byte `grantDigest`:

```text
grantDigest = keccak256(
  abi.encode(
    "MIDA_GRANT_V1",
    chainId,
    CapabilityRegistry address,
    owner,
    agentId,
    keccak256(abi.encode(sorted exact GrantScope[])),
    issuedAt,
    expiresAt,
    grantNonce[owner]
  )
)
```

`GrantScope` contains `namespaceId`, `permissions`, and `provenancePolicy`. For sorted scope index `i`, the stored identifier is:

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

The signed `issuedAt` must satisfy `issuedAt <= block.timestamp` and `block.timestamp - issuedAt <= 300 seconds`. Stored issuance time is always `block.timestamp`, so calldata cannot forge record chronology.

A grant succeeds only if:

1. `msg.sender == owner`;
2. the agent and all exact namespaces are registered and active;
3. scopes are sorted, unique, and non-empty;
4. permissions and provenance bits contain no unknown bits;
5. `expiresAt == 0 || expiresAt > block.timestamp`;
6. active-capability limits are not exceeded: at most 32 per `(owner, namespaceId)` and 64 per `(owner, agentId)`;
7. every READ scope’s current epoch is initialized and still writable;
8. the WebAuthn assertion has type `webauthn.get`, contains the exact `grantDigest` challenge, matches the configured Vault origin/RP ID, and has both User Presence and User Verification flags set;
9. the P256 signature verifies against the owner’s registered key;
10. the registry reads and then increments `grantNonce[owner]`;
11. every READ scope captures the namespace’s current `readEpoch` as `grantedAtReadEpoch` and lowers its write deadline when this grant expires sooner.

A zero authenticator signature counter is accepted because synced passkeys may not provide a useful monotonic counter. The contract does not treat the counter as replay protection; `grantNonce` provides replay protection.

Project 1 uses `webauthn-sol`: default Anvil proves its Solidity fallback; a pinned Foundry release running Anvil with Odyssey mode proves the local P256 precompile path; Monad testnet proves Monad’s native P256 path. The same FakeVault assertion payload is used for all paths. If the pinned Anvil release cannot expose the native path, Project 1 is blocked until the tool version is corrected rather than silently treating fallback coverage as native coverage.

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

```solidity
revoke(bytes32 capabilityId)
revokeAgent(bytes32 agentId)
advanceExpiredReadEpoch(bytes32 namespaceId) returns (uint64 newEpoch)
requiredReadEpoch(address owner, bytes32 namespaceId) view returns (uint64)
isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) view returns (bool)
```

- `revoke` requires `msg.sender == capability.owner`.
- `revokeAgent` requires owner authority, increments `agentEpoch[owner][agentId]`, and advances every exact namespace for which that agent had active READ. At most 64 owner-agent capabilities are scanned.
- Plain owner authority is sufficient because these operations reduce privilege.
- If ended authority included READ, the registry increments `requiredReadEpoch[owner][namespaceId]` exactly once for that owner transaction, even when multiple ended capabilities cover the same namespace.
- A scope reduction is represented as revocation plus a narrower new grant and therefore follows the same rule.
- Context registration fails until `ContextRegistry` has a public key for the required epoch.
- The owner-account batch combines revocation/epoch invalidation with publication of the next public key. Calling revocation alone remains safe but leaves writes blocked until key publication.

When the write deadline expires without a transaction, `isWriteEpochValid` returns false. The owner calls `advanceExpiredReadEpoch` only when the old deadline is non-zero and `block.timestamp >= writeDeadline`. It increments the required epoch and recomputes the next deadline from remaining live exact READ capabilities. The same owner-account batch publishes that epoch’s public key in ContextRegistry.

### 10.7 Events

```text
P256KeyRegistered
NamespaceRegistered
AgentRegistered
AgentSigningKeyRotated
AgentEncryptionKeyRotated
AgentOriginChanged
CapabilityGranted
CapabilityRevoked
AgentRevoked
ReadEpochRequired
```

Events include indexed owner/agent/namespace identifiers needed by an off-chain indexer.

## 11. ContextRegistry

### 11.1 Namespace epoch keys

```solidity
setNamespaceEpochKey(bytes32 namespaceId, uint64 readEpoch, bytes32 publicKey)
```

Only the owner account may publish its namespace key. The namespace must be registered, `publicKey` must be non-zero, `readEpoch` must equal `CapabilityRegistry.requiredReadEpoch(msg.sender, namespaceId)`, and that owner/namespace/epoch tuple must not already have a key. Epoch 1 is initialized through this same function. Published epoch keys are immutable; rotation appends the next key rather than replacing history.

The contract does not know the owner’s namespace secret and cannot prove the public key was derived correctly. Recovery depends on the owner/Vault publishing the deterministic key specified in Section 7; the FakeVault recovery test detects a mismatch in Project 1.

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
6. verifies `readEpoch` equals the current required epoch, its public key is registered, and its write deadline remains valid;
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
- `USER_CONFIRMED` requires owner authorship and a non-zero evidence commitment to the proposal or evidence being confirmed.
- Agents can never submit either value.
- `AGENT_INFERRED` requires agent authorship, CREATE/supersession authority, and `ALLOW_INFERENCE`; an owner-authored record cannot label itself agent-inferred.
- `IMPORTED` requires `ALLOW_IMPORTED` for an agent and a non-zero `evidenceCommitment` revealing at least one registered evidence-record ID when decrypted.
- `EXTERNAL_ATTESTATION` requires `ALLOW_EXTERNAL_ATTESTATION` for an agent and a non-zero `evidenceCommitment` revealing at least one registered evidence-record ID when decrypted.
- Owner imports/attestations also require a non-zero evidence commitment.
- The contract can enforce only that the commitment is non-zero. The SDK/API verifies revealed IDs exist and recompute the commitment; it cannot prove the encrypted evidence semantically supports the claim.
- The contract does not interpret extraction confidence or claim truth; those remain encrypted payload semantics.

Evidence IDs are canonicalized off-chain as sorted unique `bytes32` values:

```text
evidenceCommitment = keccak256(
  abi.encode("MIDA_EVIDENCE_V1", canonicalEvidenceIds)
)
```

A public observer can verify only that the writer committed to an evidence set. An authorized reader can decrypt the IDs, recompute the commitment, and verify the revealed set.

A user-confirmed successor may edit an agent proposal. It need not contain identical plaintext. `confirmed-from` means that the new owner-authored claim acknowledges the proposal in its evidence and/or parent relation; it does not mean byte equality.

### 11.9 Expiry semantics

A context `expiresAt` controls semantic freshness and default retrieval. It does not delete ciphertext, revoke keys, or make previously disclosed plaintext unknowable. This is separate from capability expiry and read-epoch write deadlines.

### 11.10 Events

```text
NamespaceEpochKeySet
ContextRegistered
ContextSuperseded
EvidenceRegistered
```

## 12. Minimal Context API

The Project 1 API is a thin storage and authorization service, not a trusted decryptor.

```text
PUT  /objects
GET  /objects?owner=&namespaceId=
POST /epoch-wraps
GET  /epoch-wraps?owner=&namespaceId=&readEpoch=&agentId=&agentKeyVersion=
GET  /manifests/:contextId
```

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

### 12.5 Typed failures

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
  callbackOrigin: string
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
  owner: Address
  agentId: Hex
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
  callbackOriginHash = keccak256(UTF8(canonicalOrigin))
  scopesHash         = keccak256(abi.encode(sorted RequestedScope[]))
  issuedAt
  requestExpiresAt
  capabilityExpiresAt
```

The Vault verifies the signature against the current registered agent signer and requires `callbackOriginHash` to equal the registered value. The CLI does not open a browser, but it still exercises the exact signature and origin checks.

`AccessGrantResponse` carries no authority of its own and contains no key material. Its capability and transaction identifiers are hints that must be checked against Monad.

### 13.3 Request completion

`createAccessRequest` persists the original request by `requestId` until `requestExpiresAt` and marks it consumed only after successful completion. Even in the CLI flow, `completeAccessRequest` verifies the response against that original stored request:

- request ID, nonce, agent ID, chain, and registry match;
- every granted namespace was requested;
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
- uses a software P256 key to create valid WebAuthn-shaped grant assertions;
- submits owner-account grant and revoke/rotation batches;
- creates and publishes reader-epoch wraps only after chain authorization exists;
- never gives namespace secrets or epoch private keys directly to the app boundary;
- returns only grant receipts, owner identity, and transaction hashes.

Project 1 server agent signing and X25519 private keys may use environment-held test secrets. Production deployments should choose managed secret storage, hardware security modules, or multiparty custody according to their custody and threat model; environment-held keys are a reference implementation choice, not a protocol custody recommendation.

## 14. Adversarial test matrix

Every behavior below must first exist as a failing test, fail for the intended reason, and only then receive implementation.

| Area | Test | Required result |
|---|---|---|
| Namespace | canonicalize `Goals.Career` | `goals.career` |
| Namespace | repeated separator or unknown node | `INVALID_NAMESPACE` |
| Namespace | caller invents a parent/path | no such input exists; forged scope rejected |
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
| Capability | grant signed for wrong chain or registry | rejected |
| Capability | grant signed without user-verification flag | rejected |
| Capability | live session tries to overwrite registered P256 key | rejected |
| Capability | P256 rotation lacks old-key assertion | rejected |
| Capability | broaden response beyond request | completion rejected |
| Capability | user narrows requested permissions | completion accepted |
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
| Evidence | duplicate evidence IDs canonicalized | one sorted unique commitment |
| Lineage | same current parent superseded twice | second gets `STALE_PARENT` |
| Lineage | caller forges version/lineage/author | fields absent or recomputed; forgery rejected |
| Concurrency | independent roots/lineages created concurrently | both succeed |
| API | forged or expired capability | denied |
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

## 15. Mandatory end-to-end scenario

The CLI harness must execute this sequence against local contracts and then Monad testnet:

```text
1. Alice registers owner P256 and initial goals.career epoch-1 public key.
2. Alice creates encrypted goals.career context under epoch 1.
3. Alice grants Agent A exact READ goals.career.
4. FakeVault publishes the epoch-1 private key wrapped to Agent A’s registered key/version.
5. Agent A verifies manifest/ciphertext commitments, unwraps, and decrypts.
6. Agent B has no grant and receives CAPABILITY_DENIED.
7. Agent C receives exact CREATE goals.career without READ.
8. Agent C uses only the public epoch key to create a new encrypted lineage.
9. Agent C cannot fetch a reader wrap or decrypt Alice’s existing object.
10. Alice atomically revokes Agent A and advances goals.career to epoch 2 with its public key.
11. Agent C writes a new object under epoch 2.
12. Agent A’s chain read fails and its epoch-1 private key cannot decrypt the epoch-2 object.
13. A remaining authorized reader receives an epoch-2 wrap and continues normally.
```

Success requires assertions at every denial and cryptographic boundary. Console output alone is not proof.

## 16. Deployment and configuration

- Solidity: `0.8.28`.
- Contract tests and deployment: Foundry.
- TypeScript runtime: Node.js 22 LTS.
- Package manager: pnpm with a committed lockfile.
- EVM client: viem.
- Contracts use deterministic CREATE2 deployment where convenient, but SDK configuration pins addresses per network. Matching addresses across networks are not required.
- Monad mainnet chain ID is `143`.
- Monad testnet chain ID is `10143`; the default public RPC is `https://testnet-rpc.monad.xyz`. These values are pinned in checked-in network configuration and were verified from Monad’s official testnet documentation on 2026-09-14.
- Monad’s P256 verifier is EIP-7951 at `0x0100`, accepts 160 bytes `(hash, r, s, qx, qy)`, returns 32-byte `1` on success, and costs 6,900 gas according to Monad’s official precompile documentation on 2026-09-14.
- P256/WebAuthn verification still goes through the selected audited verifier abstraction rather than custom JSON parsing or curve code.
- No secret, private key, PRF output, plaintext DEK, or plaintext context value may be committed to Git or logged.

## 17. Security invariants

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

## 18. Completion gate

Project 1 passes only when:

- unit and property tests cover canonicalization, derivation, encryption, wraps, storage, and wire validation;
- Foundry adversarial tests cover grants, replay, exact scopes, provenance, anchors, evidence, expiry, epoch rotation, and stale parents;
- API integration tests prove authorization is checked for reads and reader-wrap publication;
- the complete CLI scenario passes locally;
- the same scenario passes against deployed Monad testnet contracts;
- local fallback and native P256 verification paths are distinguished and evidenced;
- the final diff receives adversarial review focused on cross-layer authorization and deployment differences.

Passing Project 1 proves the protocol core and its seams. It does not claim that browser passkey recovery, low-latency subscriptions, compiler provenance, dispersed storage, or the consumer demo already exist.
