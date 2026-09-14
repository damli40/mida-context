# Project 1 Plan — Part D: Contracts (Tasks 14–20)

> Read `2026-09-14-project-1-protocol-core.md` first. Its Global Constraints and "Decisions" sections apply to every task here.
>
> Every Solidity file, test and script in this part was compiled and run in a scratch Foundry 1.8.1 project on 2026-09-14 before being written here. Copy code verbatim.
>
> All `forge` commands run from `contracts/` unless a step says otherwise.

## Part D decisions (binding, in addition to the index)

1. **Compiler pipeline.** `via_ir = true` with the optimizer on. The 13-field grant digest and 14-field access-request digest overflow the legacy code generator's stack. The IR build takes under two seconds.
2. **forge-std pin.** `v1.16.2`, the newest release older than seven days on 2026-09-14.
3. **Remappings are explicit.** webauthn-sol imports OpenZeppelin `Base64` and solady `LibString` from its own nested libraries. Auto-detection happens to work, but the plan pins all five lines so a fresh clone resolves identically.
4. **Policy hash constant.** `contracts/src/generated/PolicyHashV1.sol` is generated from `contracts/test/vectors/policy-v1.json`, which Part C Task 10 writes. `CapabilityRegistry` exposes it as `POLICY_HASH_V1`.
5. **Hashing lives in one library.** `MidaHashing` takes chain ID and registry address as parameters, so parity tests reproduce the TypeScript vectors exactly. Contracts pass `block.chainid` and `address(this)`.

---

### Task 14: Foundry workspace, `MidaTypes`, `NamespaceTree`, TS↔Solidity ID and policy-hash parity

**Depends on:** Task 5 (protocol ids and typed data). Step 8 additionally depends on Task 10. If Task 10 is not merged yet, complete Steps 1–7 and commit, then return for Steps 8–9.

**Files:**
- Create: `contracts/foundry.toml`, `contracts/remappings.txt`
- Create (by `forge install`): `.gitmodules`, `contracts/foundry.lock`, `contracts/lib/forge-std`, `contracts/lib/webauthn-sol`
- Create: `contracts/src/MidaTypes.sol`, `contracts/src/MidaHashing.sol`, `contracts/src/NamespaceTree.sol`
- Create: `contracts/script/gen-policy-hash.mjs`; generated `contracts/src/generated/PolicyHashV1.sol`
- Create: `packages/protocol/scripts/export-vectors.ts`; generated `contracts/test/vectors/ids-v1.json`
- Test: `contracts/test/Parity.t.sol`, `contracts/test/NamespaceTree.t.sol`
- Modify: root `package.json` scripts

**Interfaces:**
- Consumes (Task 5): `NAMESPACE_TREE_V1`, `namespaceId`, `agentId`, `contextId`, `sortScopes`, `scopesHash`, `capabilityId`, `grantDigest`, `canonicalReferences`, `evidenceCommitment`, `p256RotationDigest`, `hashString`, `originHash`, `accessRequestHash`, `manifestBindingTypedData`, `httpRequestTypedData`, `agentRegistrationTypedData`, `signerRotationTypedData`, type `UnsignedAccessRequest`.
- Consumes (Task 10): file `contracts/test/vectors/policy-v1.json` with shape `{ "policyHash": "0x<64 lowercase hex>" }`.
- Produces, file-level in `MidaTypes.sol`:
  - Constants: `PERM_READ = 1`, `PERM_CREATE = 2`, `PERM_SUPERSEDE_OWN = 4`, `PERM_SUPERSEDE_ANY = 8`, `KNOWN_PERMISSION_BITS = 15`, `PROV_ALLOW_INFERENCE = 1`, `PROV_ALLOW_IMPORTED = 2`, `PROV_ALLOW_EXTERNAL_ATTESTATION = 4`, `KNOWN_PROVENANCE_BITS = 7`, `RECORD_CONTEXT = 0`, `RECORD_EVIDENCE = 1`, `LINEAGE_STANDARD = 0`, `LINEAGE_OWNER_CONTROLLED = 1`, `KIND_NONE = 0`, `KIND_MAX = 8`, `SOURCE_NONE = 0` … `SOURCE_EXTERNAL_ATTESTATION = 5`, `MAX_ACTIVE_PER_NAMESPACE = 32`, `MAX_ACTIVE_PER_AGENT = 64`, `HIGH_MAX_DURATION = 24 hours`, `MAX_REQUEST_WINDOW = 600`, `POLICY_VERSION_HASH`, `NAMESPACE_TREE_VERSION_HASH`
  - Structs: `GrantScope { bytes32 namespaceId; uint8 permissions; uint8 provenancePolicy; }`, `EvidenceRef { uint8 relation; bytes32 recordId; }`, `AccessRequestInput`, `GrantDigestInput`, `AgentRegistration` (fields below)
  - Errors: `InvalidNamespace(bytes32)`, `CapabilityDenied()`, `EpochRotationRequired(bytes32,uint64)`, `EpochStale(bytes32,uint64,uint64)`, `StaleParent(bytes32,bytes32)`, `EvidenceImmutable(bytes32)`, `ProvenanceForbidden()`, `AnchorOwnerOnly()`
- Produces, `library MidaHashing` (all `internal pure`): `namespaceId(string)`, `agentId(uint256,address,address,bytes32)`, `contextId(uint256,address,address,bytes32,bytes32,bytes32)`, `scopesHash(GrantScope[])`, `capabilityId(address,bytes32,uint256,uint256,GrantScope,uint64)`, `grantDigest(GrantDigestInput)`, `evidenceCommitment(EvidenceRef[])`, `p256RotationDigest(uint256,address,address,uint256,uint256,uint256)`, `domainSeparator(string,uint256,address)`, `typedDigest(bytes32,bytes32)`, `accessRequestDigest(AccessRequestInput,uint256,address)`, `manifestBindingDigest(bytes32,bytes32,uint64,uint256,address)`, `httpRequestDigest(address,bytes32,bytes32,bytes32,uint64,bytes32,uint256,address)`, `agentRegistrationDigest(AgentRegistration,uint256,address)`, `signerRotationDigest(bytes32,address,uint64,uint256,address)`; string constants `DOMAIN_CAPABILITY_REGISTRY`, `DOMAIN_ACCESS_REQUEST`, `DOMAIN_MANIFEST`, `DOMAIN_HTTP_REQUEST`
- Produces, `abstract contract NamespaceTree`: `NAMESPACE_COUNT() → 22`, `isRegisteredNamespace(bytes32) public view returns (bool)`, `namespaceParent(bytes32) external view returns (bytes32)`, `isHighSensitivity(bytes32) public view returns (bool)`, internal `_requireNamespace(bytes32)`; event `NamespaceRegistered(bytes32 indexed namespaceId, bytes32 indexed parentId, string name, bool highSensitivity)`
- Produces, generated: `bytes32 constant MIDA_POLICY_DOCUMENT_HASH_V1` in `contracts/src/generated/PolicyHashV1.sol`
- Produces, root scripts: `pnpm vectors:ids`, `pnpm contracts:policy-hash`

- [ ] **Step 1: Create the Foundry project and install pinned dependencies**

From the repository root:
```bash
mkdir -p contracts/src contracts/test/vectors contracts/script
```

`contracts/foundry.toml`:
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc_version = "0.8.28"
evm_version = "osaka"
optimizer = true
optimizer_runs = 200
via_ir = true
fs_permissions = [
  { access = "read", path = "./test/vectors" },
  { access = "read-write", path = "./deployments" },
]

[fuzz]
runs = 256

[lint]
lint_on_build = false
```

`contracts/remappings.txt`:
```text
webauthn-sol/=lib/webauthn-sol/src/
FreshCryptoLib/=lib/webauthn-sol/lib/FreshCryptoLib/solidity/src/
openzeppelin-contracts/=lib/webauthn-sol/lib/openzeppelin-contracts/
solady/=lib/webauthn-sol/lib/solady/src/
forge-std/=lib/forge-std/src/
```

Run:
```bash
cd contracts
forge install foundry-rs/forge-std@v1.16.2
forge install base/webauthn-sol@v1.0.0
cat ../.gitmodules
cat foundry.lock
```
Expected: `Installed forge-std tag=v1.16.2@…` and `Installed webauthn-sol tag=v1.0.0@619f20ab0f074fef41066ee4ab24849a913263b2`. The repository-root `.gitmodules` lists `contracts/lib/forge-std` and `contracts/lib/webauthn-sol`. `contracts/foundry.lock` pins both tags. `forge install` runs inside the existing git repository and adds submodules relative to the repository root; that is correct.

- [ ] **Step 2: Add root scripts**

In the root `package.json` `"scripts"` object, add:
```json
    "vectors:ids": "tsx packages/protocol/scripts/export-vectors.ts",
    "contracts:policy-hash": "node contracts/script/gen-policy-hash.mjs"
```

- [ ] **Step 3: Write the vector export script and generate vectors**

`packages/protocol/scripts/export-vectors.ts`:
```ts
/**
 * Writes contracts/test/vectors/ids-v1.json: fixed-input vectors that Solidity parity tests
 * (plan Task 14) must reproduce byte for byte. Re-run after any change to ids.ts or typed-data.ts.
 * Usage: pnpm vectors:ids [outputPath]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { hashTypedData, keccak256, stringToBytes } from "viem"
import type { Address, Hex } from "viem"
import {
  NAMESPACE_TREE_V1,
  accessRequestHash,
  agentId,
  agentRegistrationTypedData,
  canonicalReferences,
  capabilityId,
  contextId,
  evidenceCommitment,
  grantDigest,
  hashString,
  httpRequestTypedData,
  manifestBindingTypedData,
  namespaceId,
  originHash,
  p256RotationDigest,
  scopesHash,
  signerRotationTypedData,
  sortScopes,
} from "../src/index.js"
import type { UnsignedAccessRequest } from "../src/index.js"

const out = process.argv[2] ?? fileURLToPath(new URL("../../../contracts/test/vectors/ids-v1.json", import.meta.url))

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY: Address = "0x1111111111111111111111111111111111111111"
const OWNER: Address = "0x2222222222222222222222222222222222222222"
const CONTEXT_REGISTRY: Address = "0x3333333333333333333333333333333333333333"
const OPERATOR: Address = "0x4444444444444444444444444444444444444444"
const SIGNER: Address = "0x5555555555555555555555555555555555555555"
const A32: Hex = `0x${"aa".repeat(32)}`
const B32: Hex = `0x${"bb".repeat(32)}`
const C32: Hex = `0x${"cc".repeat(32)}`
const D32: Hex = `0x${"dd".repeat(32)}`
const QX: Hex = `0x${"12".repeat(32)}`
const QY: Hex = `0x${"34".repeat(32)}`

const scopes = sortScopes([
  { namespaceId: namespaceId("goals.career"), permissions: 3, provenancePolicy: 1 },
  { namespaceId: namespaceId("financial"), permissions: 1, provenancePolicy: 0 },
  { namespaceId: namespaceId("projects.current"), permissions: 15, provenancePolicy: 7 },
])
const firstScope = scopes[0]!

const rawReferences = [
  { relation: "confirmed_from", recordId: A32 },
  { relation: "supports", recordId: C32 },
  { relation: "supports", recordId: B32 },
] as const
const references = canonicalReferences(rawReferences)

const request: UnsignedAccessRequest = {
  v: 1,
  chainId: CHAIN_ID.toString(),
  capabilityRegistry: CAPABILITY_REGISTRY,
  requestId: A32,
  nonce: B32,
  agentId: C32,
  purposeId: "career_coaching",
  callbackOrigin: "https://career.example",
  manifestHash: D32,
  manifestVersion: 1,
  policyVersion: "mida-grant-policy-v1",
  namespaceTreeVersion: "mida-namespace-tree-v1",
  scopes,
  issuedAt: "1000",
  requestExpiresAt: "1600",
  capabilityExpiresAt: "0",
}

const httpBody = stringToBytes("{}")
const http = httpRequestTypedData({
  chainId: CHAIN_ID,
  capabilityRegistry: CAPABILITY_REGISTRY,
  signer: OWNER,
  method: "post",
  target: "/objects",
  body: httpBody,
  timestamp: 1_700_000_000n,
  nonce: B32,
})

const vectors = {
  chainId: Number(CHAIN_ID),
  capabilityRegistry: CAPABILITY_REGISTRY,
  contextRegistry: CONTEXT_REGISTRY,
  owner: OWNER,
  operator: OPERATOR,
  signer: SIGNER,
  a32: A32,
  b32: B32,
  c32: C32,
  d32: D32,
  policyVersionHash: hashString("mida-grant-policy-v1"),
  namespaceTreeVersionHash: hashString("mida-namespace-tree-v1"),
  namespaceNames: NAMESPACE_TREE_V1.map((node) => node.name),
  namespaceIds: NAMESPACE_TREE_V1.map((node) => node.id),
  agentId: agentId({ chainId: CHAIN_ID, capabilityRegistry: CAPABILITY_REGISTRY, operator: OPERATOR, agentSalt: C32 }),
  contextId: contextId({
    chainId: CHAIN_ID,
    contextRegistry: CONTEXT_REGISTRY,
    owner: OWNER,
    authorId: A32,
    namespaceId: namespaceId("goals.career"),
    objectNonce: B32,
  }),
  scopeNamespaceIds: scopes.map((s) => s.namespaceId),
  scopePermissions: scopes.map((s) => s.permissions),
  scopeProvenancePolicies: scopes.map((s) => s.provenancePolicy),
  scopesHash: scopesHash(scopes),
  capabilityId: capabilityId({
    owner: OWNER,
    agentId: A32,
    grantNonce: 3n,
    index: 1n,
    namespaceId: firstScope.namespaceId,
    permissions: firstScope.permissions,
    provenancePolicy: firstScope.provenancePolicy,
    expiresAt: 86_400n,
  }),
  grantDigest: grantDigest({
    chainId: CHAIN_ID,
    capabilityRegistry: CAPABILITY_REGISTRY,
    owner: OWNER,
    agentId: A32,
    requestHash: B32,
    manifestHash: C32,
    manifestVersion: 2n,
    finalScopes: scopes,
    expiresAt: 7_000n,
    grantNonce: 9n,
  }),
  evidenceRelations: references.map((r) => r.relationCode),
  evidenceRecordIds: references.map((r) => r.recordId),
  evidenceCommitment: evidenceCommitment(rawReferences),
  p256Qx: QX,
  p256Qy: QY,
  p256RotationDigest: p256RotationDigest({
    chainId: CHAIN_ID,
    capabilityRegistry: CAPABILITY_REGISTRY,
    owner: OWNER,
    newQx: BigInt(QX),
    newQy: BigInt(QY),
    nonce: 4n,
  }),
  accessRequestPurposeIdHash: hashString(request.purposeId),
  accessRequestCallbackOriginHash: originHash(request.callbackOrigin),
  accessRequestDigest: accessRequestHash(request),
  manifestBindingDigest: hashTypedData(
    manifestBindingTypedData({ chainId: CHAIN_ID, capabilityRegistry: CAPABILITY_REGISTRY, bodyHash: A32, agentId: C32, manifestVersion: 3n }),
  ),
  httpMethodHash: http.message.methodHash,
  httpTargetHash: http.message.targetHash,
  httpBodyHash: keccak256(httpBody),
  httpRequestDigest: hashTypedData(http),
  agentRegistrationOriginHash: originHash("https://career.example"),
  agentRegistrationDigest: hashTypedData(
    agentRegistrationTypedData({
      chainId: CHAIN_ID,
      capabilityRegistry: CAPABILITY_REGISTRY,
      agentId: C32,
      operator: OPERATOR,
      signer: SIGNER,
      encryptionPublicKey: D32,
      encryptionKeyVersion: 1,
      callbackOriginHash: originHash("https://career.example"),
      capabilityManifestHash: A32,
      capabilityManifestVersion: 1n,
    }),
  ),
  signerRotationDigest: hashTypedData(
    signerRotationTypedData({ chainId: CHAIN_ID, capabilityRegistry: CAPABILITY_REGISTRY, agentId: C32, newSigner: SIGNER, rotationNonce: 5n }),
  ),
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`)
console.log(`wrote ${out}`)
```

Run from the repository root:
```bash
pnpm vectors:ids
```
Expected: `wrote …/contracts/test/vectors/ids-v1.json`. The file contains 22 `namespaceIds`, and `evidenceRelations` is `[1, 1, 3]`.

- [ ] **Step 4: Write the failing parity and namespace-tree tests**

`contracts/test/Parity.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {
    AccessRequestInput,
    AgentRegistration,
    EvidenceRef,
    GrantDigestInput,
    GrantScope,
    NAMESPACE_TREE_VERSION_HASH,
    POLICY_VERSION_HASH
} from "../src/MidaTypes.sol";
import {MidaHashing} from "../src/MidaHashing.sol";

/// @notice Every identifier and EIP-712 digest must equal the TypeScript vectors exported by
///         packages/protocol/scripts/export-vectors.ts. A failure here means the two layers drifted.
contract ParityTest is Test {
    string internal ids;

    function setUp() public {
        ids = vm.readFile("test/vectors/ids-v1.json");
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(ids, string.concat(".", key));
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(ids, string.concat(".", key));
    }

    function _chainId() internal view returns (uint256) {
        return vm.parseJsonUint(ids, ".chainId");
    }

    function _registry() internal view returns (address) {
        return _addr("capabilityRegistry");
    }

    function _scopes() internal view returns (GrantScope[] memory scopes) {
        bytes32[] memory namespaceIds = vm.parseJsonBytes32Array(ids, ".scopeNamespaceIds");
        uint256[] memory permissions = vm.parseJsonUintArray(ids, ".scopePermissions");
        uint256[] memory provenance = vm.parseJsonUintArray(ids, ".scopeProvenancePolicies");
        scopes = new GrantScope[](namespaceIds.length);
        for (uint256 i = 0; i < namespaceIds.length; i++) {
            scopes[i] = GrantScope(namespaceIds[i], uint8(permissions[i]), uint8(provenance[i]));
        }
    }

    function test_versionHashes() public view {
        assertEq(POLICY_VERSION_HASH, _b32("policyVersionHash"));
        assertEq(NAMESPACE_TREE_VERSION_HASH, _b32("namespaceTreeVersionHash"));
    }

    function test_namespaceIdsInTreeOrder() public view {
        string[] memory names = vm.parseJsonStringArray(ids, ".namespaceNames");
        bytes32[] memory expected = vm.parseJsonBytes32Array(ids, ".namespaceIds");
        assertEq(names.length, 22);
        assertEq(expected.length, 22);
        for (uint256 i = 0; i < names.length; i++) {
            assertEq(MidaHashing.namespaceId(names[i]), expected[i], names[i]);
        }
    }

    function test_agentId() public view {
        assertEq(MidaHashing.agentId(_chainId(), _registry(), _addr("operator"), _b32("c32")), _b32("agentId"));
    }

    function test_contextId() public view {
        bytes32 careerId = MidaHashing.namespaceId("goals.career");
        assertEq(
            MidaHashing.contextId(_chainId(), _addr("contextRegistry"), _addr("owner"), _b32("a32"), careerId, _b32("b32")),
            _b32("contextId")
        );
    }

    function test_scopesHash() public view {
        assertEq(MidaHashing.scopesHash(_scopes()), _b32("scopesHash"));
    }

    function test_capabilityId() public view {
        GrantScope memory first = _scopes()[0];
        assertEq(MidaHashing.capabilityId(_addr("owner"), _b32("a32"), 3, 1, first, 86_400), _b32("capabilityId"));
    }

    function test_grantDigest() public view {
        GrantDigestInput memory input = GrantDigestInput({
            chainId: _chainId(),
            capabilityRegistry: _registry(),
            owner: _addr("owner"),
            agentId: _b32("a32"),
            requestHash: _b32("b32"),
            manifestHash: _b32("c32"),
            manifestVersion: 2,
            scopesHash: MidaHashing.scopesHash(_scopes()),
            expiresAt: 7_000,
            grantNonce: 9
        });
        assertEq(MidaHashing.grantDigest(input), _b32("grantDigest"));
    }

    function test_evidenceCommitment() public view {
        uint256[] memory relations = vm.parseJsonUintArray(ids, ".evidenceRelations");
        bytes32[] memory recordIds = vm.parseJsonBytes32Array(ids, ".evidenceRecordIds");
        EvidenceRef[] memory refs = new EvidenceRef[](relations.length);
        for (uint256 i = 0; i < relations.length; i++) {
            refs[i] = EvidenceRef(uint8(relations[i]), recordIds[i]);
        }
        assertEq(MidaHashing.evidenceCommitment(refs), _b32("evidenceCommitment"));
    }

    function test_p256RotationDigest() public view {
        assertEq(
            MidaHashing.p256RotationDigest(
                _chainId(), _registry(), _addr("owner"), uint256(_b32("p256Qx")), uint256(_b32("p256Qy")), 4
            ),
            _b32("p256RotationDigest")
        );
    }

    function test_accessRequestDigest() public view {
        AccessRequestInput memory request;
        request.requestId = _b32("a32");
        request.nonce = _b32("b32");
        request.agentId = _b32("c32");
        request.purposeIdHash = keccak256("career_coaching");
        request.callbackOriginHash = keccak256("https://career.example");
        request.manifestHash = _b32("d32");
        request.manifestVersion = 1;
        request.policyVersionHash = POLICY_VERSION_HASH;
        request.namespaceTreeVersionHash = NAMESPACE_TREE_VERSION_HASH;
        request.issuedAt = 1000;
        request.requestExpiresAt = 1600;
        request.capabilityExpiresAt = 0;
        request.scopes = _scopes();
        assertEq(request.purposeIdHash, _b32("accessRequestPurposeIdHash"));
        assertEq(request.callbackOriginHash, _b32("accessRequestCallbackOriginHash"));
        assertEq(MidaHashing.accessRequestDigest(request, _chainId(), _registry()), _b32("accessRequestDigest"));
    }

    function test_manifestBindingDigest() public view {
        assertEq(
            MidaHashing.manifestBindingDigest(_b32("a32"), _b32("c32"), 3, _chainId(), _registry()),
            _b32("manifestBindingDigest")
        );
    }

    function test_httpRequestDigest() public view {
        assertEq(keccak256("POST"), _b32("httpMethodHash"));
        assertEq(keccak256("/objects"), _b32("httpTargetHash"));
        assertEq(keccak256("{}"), _b32("httpBodyHash"));
        assertEq(
            MidaHashing.httpRequestDigest(
                _addr("owner"),
                keccak256("POST"),
                keccak256("/objects"),
                keccak256("{}"),
                1_700_000_000,
                _b32("b32"),
                _chainId(),
                _registry()
            ),
            _b32("httpRequestDigest")
        );
    }

    function test_agentRegistrationDigest() public view {
        AgentRegistration memory registration = AgentRegistration({
            agentId: _b32("c32"),
            operator: _addr("operator"),
            signer: _addr("signer"),
            encryptionPublicKey: _b32("d32"),
            encryptionKeyVersion: 1,
            callbackOriginHash: _b32("agentRegistrationOriginHash"),
            capabilityManifestHash: _b32("a32"),
            capabilityManifestVersion: 1
        });
        assertEq(
            MidaHashing.agentRegistrationDigest(registration, _chainId(), _registry()), _b32("agentRegistrationDigest")
        );
    }

    function test_signerRotationDigest() public view {
        assertEq(
            MidaHashing.signerRotationDigest(_b32("c32"), _addr("signer"), 5, _chainId(), _registry()),
            _b32("signerRotationDigest")
        );
    }
}
```

`contracts/test/NamespaceTree.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {InvalidNamespace} from "../src/MidaTypes.sol";
import {MidaHashing} from "../src/MidaHashing.sol";
import {NamespaceTree} from "../src/NamespaceTree.sol";

contract TreeHarness is NamespaceTree {}

contract NamespaceTreeTest is Test {
    TreeHarness internal tree;

    function setUp() public {
        tree = new TreeHarness();
    }

    function _names() internal view returns (string[] memory) {
        return vm.parseJsonStringArray(vm.readFile("test/vectors/ids-v1.json"), ".namespaceNames");
    }

    function test_registersAll22NodesInTypeScriptOrder() public {
        vm.recordLogs();
        TreeHarness fresh = new TreeHarness();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        string[] memory names = _names();
        bytes32 topic = keccak256("NamespaceRegistered(bytes32,bytes32,string,bool)");
        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(fresh) || logs[i].topics[0] != topic) continue;
            assertEq(logs[i].topics[1], MidaHashing.namespaceId(names[seen]), names[seen]);
            seen++;
        }
        assertEq(seen, 22);
        assertEq(fresh.NAMESPACE_COUNT(), 22);
        for (uint256 i = 0; i < names.length; i++) {
            assertTrue(fresh.isRegisteredNamespace(MidaHashing.namespaceId(names[i])), names[i]);
        }
    }

    function test_parentsAreProtocolState() public view {
        assertEq(tree.namespaceParent(MidaHashing.namespaceId("profile")), bytes32(0));
        assertEq(tree.namespaceParent(MidaHashing.namespaceId("projects.past")), MidaHashing.namespaceId("projects"));
        assertEq(
            tree.namespaceParent(MidaHashing.namespaceId("financial.preferences")), MidaHashing.namespaceId("financial")
        );
    }

    function test_highSensitivitySetIsExactlyFourNodes() public view {
        string[] memory names = _names();
        uint256 high;
        for (uint256 i = 0; i < names.length; i++) {
            if (tree.isHighSensitivity(MidaHashing.namespaceId(names[i]))) high++;
        }
        assertEq(high, 4);
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("credentials")));
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("financial")));
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("financial.preferences")));
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("private")));
        assertFalse(tree.isHighSensitivity(MidaHashing.namespaceId("relationships")));
    }

    function test_unknownNamespaceReverts() public {
        bytes32 invented = MidaHashing.namespaceId("goals.career.secret");
        assertFalse(tree.isRegisteredNamespace(invented));
        vm.expectRevert(abi.encodeWithSelector(InvalidNamespace.selector, invented));
        tree.namespaceParent(invented);
    }

    /// @dev §15 "deployed v1 tree receives a new child": no mutation entry point exists.
    function test_noNamespaceRegistrationFunctionExists() public {
        (bool ok,) = address(tree).call(abi.encodeWithSignature("registerNamespace(string,bytes32)", "goals.side", bytes32(0)));
        assertFalse(ok);
        (ok,) = address(tree).call(abi.encodeWithSignature("registerNamespace(bytes32,bytes32)", bytes32(uint256(1)), bytes32(0)));
        assertFalse(ok);
    }
}
```

- [ ] **Step 5: Run to verify they fail**

Run: `forge test --match-path "test/{Parity,NamespaceTree}.t.sol"`
Expected: FAIL at compilation, because `src/MidaTypes.sol`, `src/MidaHashing.sol` and `src/NamespaceTree.sol` do not exist.

- [ ] **Step 6: Implement `MidaTypes.sol`**

`contracts/src/MidaTypes.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Protocol constants. Values mirror the TypeScript protocol package constants.ts (plan Task 2).
uint8 constant PERM_READ = 1;
uint8 constant PERM_CREATE = 2;
uint8 constant PERM_SUPERSEDE_OWN = 4;
uint8 constant PERM_SUPERSEDE_ANY = 8;
uint8 constant KNOWN_PERMISSION_BITS = 15;

uint8 constant PROV_ALLOW_INFERENCE = 1;
uint8 constant PROV_ALLOW_IMPORTED = 2;
uint8 constant PROV_ALLOW_EXTERNAL_ATTESTATION = 4;
uint8 constant KNOWN_PROVENANCE_BITS = 7;

uint8 constant RECORD_CONTEXT = 0;
uint8 constant RECORD_EVIDENCE = 1;

uint8 constant LINEAGE_STANDARD = 0;
uint8 constant LINEAGE_OWNER_CONTROLLED = 1;

uint8 constant KIND_NONE = 0;
uint8 constant KIND_MAX = 8;

uint8 constant SOURCE_NONE = 0;
uint8 constant SOURCE_USER_ASSERTED = 1;
uint8 constant SOURCE_USER_CONFIRMED = 2;
uint8 constant SOURCE_AGENT_INFERRED = 3;
uint8 constant SOURCE_IMPORTED = 4;
uint8 constant SOURCE_EXTERNAL_ATTESTATION = 5;

uint256 constant MAX_ACTIVE_PER_NAMESPACE = 32;
uint256 constant MAX_ACTIVE_PER_AGENT = 64;
uint64 constant HIGH_MAX_DURATION = 24 hours;
uint64 constant MAX_REQUEST_WINDOW = 600;

bytes32 constant POLICY_VERSION_HASH = keccak256("mida-grant-policy-v1");
bytes32 constant NAMESPACE_TREE_VERSION_HASH = keccak256("mida-namespace-tree-v1");

/// @dev Same fields and order as RequestedScope / GrantScope in the TypeScript protocol package.
struct GrantScope {
    bytes32 namespaceId;
    uint8 permissions;
    uint8 provenancePolicy;
}

/// @dev (relationCode, recordId) exactly as canonicalReferences() emits them.
struct EvidenceRef {
    uint8 relation;
    bytes32 recordId;
}

/// @dev Agent-signed access request submitted to grantBatch. Hash fields are computed off-chain
///      exactly as accessRequestTypedData() does; the contract recomputes scopesHash itself.
struct AccessRequestInput {
    bytes32 requestId;
    bytes32 nonce;
    bytes32 agentId;
    bytes32 purposeIdHash;
    bytes32 callbackOriginHash;
    bytes32 manifestHash;
    uint64 manifestVersion;
    bytes32 policyVersionHash;
    bytes32 namespaceTreeVersionHash;
    uint64 issuedAt;
    uint64 requestExpiresAt;
    uint64 capabilityExpiresAt;
    GrantScope[] scopes;
    bytes agentSignature;
}

struct GrantDigestInput {
    uint256 chainId;
    address capabilityRegistry;
    address owner;
    bytes32 agentId;
    bytes32 requestHash;
    bytes32 manifestHash;
    uint64 manifestVersion;
    bytes32 scopesHash;
    uint64 expiresAt;
    uint256 grantNonce;
}

struct AgentRegistration {
    bytes32 agentId;
    address operator;
    address signer;
    bytes32 encryptionPublicKey;
    uint32 encryptionKeyVersion;
    bytes32 callbackOriginHash;
    bytes32 capabilityManifestHash;
    uint64 capabilityManifestVersion;
}

// Custom errors. Names mirror spec §12.6 where one applies.
error InvalidNamespace(bytes32 namespaceId);
error CapabilityDenied();
error EpochRotationRequired(bytes32 namespaceId, uint64 epoch);
error EpochStale(bytes32 namespaceId, uint64 submitted, uint64 required);
error StaleParent(bytes32 expectedParentId, bytes32 currentHead);
error EvidenceImmutable(bytes32 parentId);
error ProvenanceForbidden();
error AnchorOwnerOnly();
```

NatSpec rule for every Solidity file in this part: never write `@` inside a `///` or `/** */` comment except as a real NatSpec tag. `@mida/protocol` in a doc comment fails compilation with `Documentation tag @mida/protocol. not valid`.

- [ ] **Step 7: Implement `MidaHashing.sol` and `NamespaceTree.sol`, then run**

`contracts/src/MidaHashing.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessRequestInput,
    AgentRegistration,
    EvidenceRef,
    GrantDigestInput,
    GrantScope,
    NAMESPACE_TREE_VERSION_HASH,
    POLICY_VERSION_HASH
} from "./MidaTypes.sol";

/// @notice Every identifier and digest shared with the TypeScript protocol package (plan Task 5).
///         Chain ID and registry address are parameters so parity tests can reproduce fixed vectors.
library MidaHashing {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ACCESS_REQUEST_TYPEHASH = keccak256(
        "MidaAccessRequestV1(bytes32 requestId,bytes32 nonce,bytes32 agentId,bytes32 purposeIdHash,bytes32 callbackOriginHash,bytes32 manifestHash,uint64 manifestVersion,bytes32 policyVersionHash,bytes32 namespaceTreeVersionHash,bytes32 scopesHash,uint64 issuedAt,uint64 requestExpiresAt,uint64 capabilityExpiresAt)"
    );
    bytes32 internal constant MANIFEST_BINDING_TYPEHASH =
        keccak256("ManifestBinding(bytes32 bodyHash,bytes32 agentId,uint64 manifestVersion)");
    bytes32 internal constant HTTP_REQUEST_TYPEHASH = keccak256(
        "MidaHttpRequestV1(address signer,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash,uint64 timestamp,bytes32 nonce)"
    );
    bytes32 internal constant AGENT_REGISTRATION_TYPEHASH = keccak256(
        "MidaAgentRegistrationV1(bytes32 agentId,address operator,address signer,bytes32 encryptionPublicKey,uint32 encryptionKeyVersion,bytes32 callbackOriginHash,bytes32 capabilityManifestHash,uint64 capabilityManifestVersion)"
    );
    bytes32 internal constant SIGNER_ROTATION_TYPEHASH =
        keccak256("MidaSignerRotationV1(bytes32 agentId,address newSigner,uint64 rotationNonce)");

    string internal constant DOMAIN_CAPABILITY_REGISTRY = "Mida Capability Registry";
    string internal constant DOMAIN_ACCESS_REQUEST = "Mida Context";
    string internal constant DOMAIN_MANIFEST = "Mida Agent Capability Manifest";
    string internal constant DOMAIN_HTTP_REQUEST = "Mida Context API";

    function namespaceId(string memory canonicalName) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("MIDA_NAMESPACE_V1"), canonicalName));
    }

    function agentId(uint256 chainId, address registry, address operator, bytes32 agentSalt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(string("MIDA_AGENT_V1"), chainId, registry, operator, agentSalt));
    }

    function contextId(
        uint256 chainId,
        address contextRegistry,
        address owner,
        bytes32 authorId,
        bytes32 namespaceId_,
        bytes32 objectNonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(string("MIDA_CONTEXT_OBJECT_V1"), chainId, contextRegistry, owner, authorId, namespaceId_, objectNonce)
        );
    }

    function scopesHash(GrantScope[] memory scopes) internal pure returns (bytes32) {
        return keccak256(abi.encode(scopes));
    }

    function capabilityId(
        address owner,
        bytes32 agentId_,
        uint256 grantNonce,
        uint256 index,
        GrantScope memory scope,
        uint64 expiresAt
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                string("MIDA_CAPABILITY_V1"),
                owner,
                agentId_,
                grantNonce,
                index,
                scope.namespaceId,
                scope.permissions,
                scope.provenancePolicy,
                expiresAt
            )
        );
    }

    function grantDigest(GrantDigestInput memory g) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                string("MIDA_GRANT_V1"),
                g.chainId,
                g.capabilityRegistry,
                g.owner,
                g.agentId,
                g.requestHash,
                g.manifestHash,
                g.manifestVersion,
                POLICY_VERSION_HASH,
                NAMESPACE_TREE_VERSION_HASH,
                g.scopesHash,
                g.expiresAt,
                g.grantNonce
            )
        );
    }

    function evidenceCommitment(EvidenceRef[] memory canonicalRefs) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("MIDA_EVIDENCE_V1"), canonicalRefs));
    }

    function p256RotationDigest(uint256 chainId, address registry, address owner, uint256 newQx, uint256 newQy, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(string("MIDA_ROTATE_P256_V1"), chainId, registry, owner, newQx, newQy, nonce));
    }

    function domainSeparator(string memory name, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), chainId, verifyingContract));
    }

    function typedDigest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    function accessRequestDigest(AccessRequestInput memory r, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ACCESS_REQUEST_TYPEHASH,
                r.requestId,
                r.nonce,
                r.agentId,
                r.purposeIdHash,
                r.callbackOriginHash,
                r.manifestHash,
                r.manifestVersion,
                r.policyVersionHash,
                r.namespaceTreeVersionHash,
                scopesHash(r.scopes),
                r.issuedAt,
                r.requestExpiresAt,
                r.capabilityExpiresAt
            )
        );
        return typedDigest(domainSeparator(DOMAIN_ACCESS_REQUEST, chainId, registry), structHash);
    }

    function manifestBindingDigest(bytes32 bodyHash, bytes32 agentId_, uint64 manifestVersion, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        return typedDigest(
            domainSeparator(DOMAIN_MANIFEST, chainId, registry),
            keccak256(abi.encode(MANIFEST_BINDING_TYPEHASH, bodyHash, agentId_, manifestVersion))
        );
    }

    function httpRequestDigest(
        address signer,
        bytes32 methodHash,
        bytes32 targetHash,
        bytes32 bodyHash,
        uint64 timestamp,
        bytes32 nonce,
        uint256 chainId,
        address registry
    ) internal pure returns (bytes32) {
        return typedDigest(
            domainSeparator(DOMAIN_HTTP_REQUEST, chainId, registry),
            keccak256(abi.encode(HTTP_REQUEST_TYPEHASH, signer, methodHash, targetHash, bodyHash, timestamp, nonce))
        );
    }

    function agentRegistrationDigest(AgentRegistration memory a, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        return typedDigest(
            domainSeparator(DOMAIN_CAPABILITY_REGISTRY, chainId, registry),
            keccak256(
                abi.encode(
                    AGENT_REGISTRATION_TYPEHASH,
                    a.agentId,
                    a.operator,
                    a.signer,
                    a.encryptionPublicKey,
                    a.encryptionKeyVersion,
                    a.callbackOriginHash,
                    a.capabilityManifestHash,
                    a.capabilityManifestVersion
                )
            )
        );
    }

    function signerRotationDigest(bytes32 agentId_, address newSigner, uint64 rotationNonce, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        return typedDigest(
            domainSeparator(DOMAIN_CAPABILITY_REGISTRY, chainId, registry),
            keccak256(abi.encode(SIGNER_ROTATION_TYPEHASH, agentId_, newSigner, rotationNonce))
        );
    }
}
```

`contracts/src/NamespaceTree.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvalidNamespace} from "./MidaTypes.sol";
import {MidaHashing} from "./MidaHashing.sol";

/// @notice Frozen namespace tree v1 (spec §5.2), registered in the constructor in the same order as
///         NAMESPACE_TREE_V1 in the TypeScript protocol package. No registration function exists
///         after deployment, so a parent grant can never silently acquire a future child.
abstract contract NamespaceTree {
    struct NamespaceInfo {
        bool registered;
        bool highSensitivity;
        bytes32 parentId;
    }

    uint256 public constant NAMESPACE_COUNT = 22;

    mapping(bytes32 namespaceId => NamespaceInfo) private _namespaces;

    event NamespaceRegistered(bytes32 indexed namespaceId, bytes32 indexed parentId, string name, bool highSensitivity);

    constructor() {
        _node("profile", "", false);
        _node("profile.identity", "profile", false);
        _node("profile.skills", "profile", false);
        _node("goals", "", false);
        _node("goals.career", "goals", false);
        _node("goals.learning", "goals", false);
        _node("goals.personal", "goals", false);
        _node("preferences", "", false);
        _node("preferences.communication", "preferences", false);
        _node("preferences.tools", "preferences", false);
        _node("preferences.work", "preferences", false);
        _node("projects", "", false);
        _node("projects.current", "projects", false);
        _node("projects.past", "projects", false);
        _node("decisions", "", false);
        _node("decisions.career", "decisions", false);
        _node("decisions.projects", "decisions", false);
        _node("credentials", "", true);
        _node("financial", "", true);
        _node("financial.preferences", "financial", true);
        _node("relationships", "", false);
        _node("private", "", true);
    }

    function isRegisteredNamespace(bytes32 namespaceId) public view returns (bool) {
        return _namespaces[namespaceId].registered;
    }

    function namespaceParent(bytes32 namespaceId) external view returns (bytes32) {
        _requireNamespace(namespaceId);
        return _namespaces[namespaceId].parentId;
    }

    /// @dev HIGH set from spec §14.2: credentials, financial, financial.preferences, private.
    function isHighSensitivity(bytes32 namespaceId) public view returns (bool) {
        _requireNamespace(namespaceId);
        return _namespaces[namespaceId].highSensitivity;
    }

    function _requireNamespace(bytes32 namespaceId) internal view {
        if (!_namespaces[namespaceId].registered) revert InvalidNamespace(namespaceId);
    }

    function _node(string memory name, string memory parent, bool high) private {
        bytes32 id = MidaHashing.namespaceId(name);
        bytes32 parentId = bytes(parent).length == 0 ? bytes32(0) : MidaHashing.namespaceId(parent);
        if (parentId != bytes32(0)) _requireNamespace(parentId);
        _namespaces[id] = NamespaceInfo({registered: true, highSensitivity: high, parentId: parentId});
        emit NamespaceRegistered(id, parentId, name, high);
    }
}
```

Run: `forge test --match-path "test/{Parity,NamespaceTree}.t.sol"`
Expected: `Suite result: ok. 14 passed` for `ParityTest` and `Suite result: ok. 5 passed` for `NamespaceTreeTest`. If any parity test fails, the Solidity ABI types or field order differ from Part A Task 5. Fix the Solidity; never edit `ids-v1.json` by hand.

Commit:
```bash
cd ..
git add .gitmodules contracts/foundry.toml contracts/foundry.lock contracts/remappings.txt contracts/lib contracts/src contracts/test contracts/script package.json packages/protocol/scripts
git commit -m "feat(contracts): foundry workspace, shared types, hashing library and frozen namespace tree

Solidity identifiers and EIP-712 digests are checked against TypeScript vectors.

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

- [ ] **Step 8: Generate the policy-hash constant and add its parity test** *(requires Task 10)*

Run from the repository root:
```bash
test -f contracts/test/vectors/policy-v1.json || pnpm tsx packages/grant-advisor/scripts/export-policy-vector.ts
```
Expected: `contracts/test/vectors/policy-v1.json` exists and contains `{ "policyHash": "0x…" }`. If `packages/grant-advisor/scripts/export-policy-vector.ts` does not exist, Task 10 is not done: stop here.

First add the failing test. Append this import to `contracts/test/Parity.t.sol` below the `MidaHashing` import:
```solidity
import {MIDA_POLICY_DOCUMENT_HASH_V1} from "../src/generated/PolicyHashV1.sol";
```
and add this function inside `ParityTest`:
```solidity
    function test_policyHashMatchesGrantAdvisorExport() public view {
        string memory policy = vm.readFile("test/vectors/policy-v1.json");
        assertEq(MIDA_POLICY_DOCUMENT_HASH_V1, vm.parseJsonBytes32(policy, ".policyHash"));
    }
```

Run: `cd contracts && forge test --match-contract ParityTest`
Expected: FAIL at compilation, because `src/generated/PolicyHashV1.sol` does not exist.

`contracts/script/gen-policy-hash.mjs`:
```js
// Regenerates src/generated/PolicyHashV1.sol from test/vectors/policy-v1.json.
// The JSON is written by packages/grant-advisor/scripts/export-policy-vector.ts (plan Task 10).
// Usage (from the repository root): pnpm contracts:policy-hash
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"

const { policyHash } = JSON.parse(readFileSync(new URL("../test/vectors/policy-v1.json", import.meta.url), "utf8"))
if (!/^0x[0-9a-f]{64}$/.test(policyHash)) {
  throw new Error(`policy-v1.json policyHash must be lowercase 0x bytes32, got ${policyHash}`)
}
const source = `// SPDX-License-Identifier: MIT
// GENERATED by contracts/script/gen-policy-hash.mjs from test/vectors/policy-v1.json. Do not edit by hand.
pragma solidity 0.8.28;

/// @dev keccak256 of the RFC 8785 canonical mida-grant-policy-v1 document (spec §14.2).
bytes32 constant MIDA_POLICY_DOCUMENT_HASH_V1 = ${policyHash};
`
mkdirSync(new URL("../src/generated/", import.meta.url), { recursive: true })
writeFileSync(new URL("../src/generated/PolicyHashV1.sol", import.meta.url), source)
console.log(`PolicyHashV1.sol <- ${policyHash}`)
```

Run from the repository root:
```bash
pnpm contracts:policy-hash
cd contracts && forge test --match-contract ParityTest
```
Expected: `PolicyHashV1.sol <- 0x…` then `Suite result: ok. 15 passed`.

- [ ] **Step 9: Commit**

```bash
cd ..
git add contracts/script/gen-policy-hash.mjs contracts/src/generated contracts/test/Parity.t.sol contracts/test/vectors/policy-v1.json
git commit -m "feat(contracts): generated POLICY_HASH_V1 constant with TS parity check

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 15: `MidaWebAuthn` wrapper and the three P256 verification paths

**Depends on:** Task 14.

**Why `evm_version = "osaka"` matters here.** Pinning `solc_version = "0.8.28"` without an `evm_version` makes forge run tests on the newest fork that compiler knows (prague). Prague has no P256 precompile, so every test would silently take the FreshCryptoLib path. Task 14's `foundry.toml` sets `evm_version = "osaka"` for this reason, and this task's path tests fail loudly if it is missing.

**Files:**
- Create: `contracts/src/MidaWebAuthn.sol`
- Create: `contracts/test/utils/WebAuthnSigner.sol`
- Create: `packages/protocol/scripts/export-webauthn-fixture.ts`; generated `contracts/test/vectors/webauthn-v1.json`
- Test: `contracts/test/MidaWebAuthn.t.sol`, `contracts/test/P256Paths.t.sol`
- Modify: `packages/protocol/package.json` (devDependency `ox`), root `package.json` scripts

**Interfaces:**
- Consumes: nothing from Solidity beyond Task 14's project; `webauthn-sol` `WebAuthn.WebAuthnAuth { bytes authenticatorData; string clientDataJSON; uint256 challengeIndex; uint256 typeIndex; uint256 r; uint256 s; }` and `WebAuthn.verify(bytes challenge, bool requireUV, WebAuthnAuth auth, uint256 x, uint256 y)`.
- Produces, `abstract contract MidaWebAuthn`:
  - `constructor(string memory rpId)`; error `EmptyRpId()`
  - `VAULT_RP_ID_HASH() external view returns (bytes32)` — `sha256(bytes(rpId))`
  - `vaultRpId() external view returns (string)`
  - `_verifyVaultAssertion(bytes32 challenge, WebAuthn.WebAuthnAuth memory auth, uint256 qx, uint256 qy) internal view returns (bool)` — false if `authenticatorData.length < 37` or `bytes32(authenticatorData) != VAULT_RP_ID_HASH`; otherwise `WebAuthn.verify(abi.encode(challenge), true, auth, qx, qy)`
- Produces, test library `WebAuthnSigner`: `P256_N`, `FLAGS_UP_UV = 0x05`, `FLAGS_UP_ONLY = 0x01`, `VAULT_RP_ID = "vault.mida.xyz"`, `VAULT_ORIGIN = "https://vault.mida.xyz"`, `publicKey(uint256) returns (uint256 qx, uint256 qy)`, `clientDataJSON(bytes32, string) returns (string)`, `authenticatorData(string rpId, bytes1 flags) returns (bytes)`, `sign(uint256 privateKey, bytes32 challenge) returns (WebAuthn.WebAuthnAuth)`, `signWith(uint256, bytes32, string rpId, string origin, bytes1 flags) returns (WebAuthn.WebAuthnAuth)`
- Produces, test contract `WebAuthnHarness is MidaWebAuthn` with `verify(bytes32, WebAuthn.WebAuthnAuth, uint256, uint256) external view returns (bool)`
- Produces, root script `pnpm vectors:webauthn`

- [ ] **Step 1: Add the fixture tooling**

In `packages/protocol/package.json`, add:
```json
  "devDependencies": {
    "ox": "1.7.4"
  }
```
In the root `package.json` `"scripts"`, add:
```json
    "vectors:webauthn": "tsx packages/protocol/scripts/export-webauthn-fixture.ts"
```
Run: `pnpm install`

`packages/protocol/scripts/export-webauthn-fixture.ts`:
```ts
/**
 * Writes contracts/test/vectors/webauthn-v1.json: one WebAuthn assertion produced by ox exactly as
 * FakeVault will produce it (plan Task 22). Solidity tests (plan Task 15) verify it through
 * MidaWebAuthn on both the native P256 precompile and the FreshCryptoLib fallback.
 * The private key is a fixed test value; ECDSA signing is deterministic (RFC 6979), so output is stable.
 * Usage: pnpm vectors:webauthn [outputPath]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { P256, WebAuthnP256 } from "ox"
import type { Hex } from "ox"

const out = process.argv[2] ?? fileURLToPath(new URL("../../../contracts/test/vectors/webauthn-v1.json", import.meta.url))

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const TEST_PRIVATE_KEY: Hex.Hex = `0x${"4d".repeat(32)}`
const RP_ID = "vault.mida.xyz"
const ORIGIN = "https://vault.mida.xyz"
const CHALLENGE: Hex.Hex = `0x${"ab".repeat(32)}`

const toBytes32 = (value: bigint): Hex.Hex => `0x${value.toString(16).padStart(64, "0")}`

const publicKey = P256.getPublicKey({ privateKey: TEST_PRIVATE_KEY })
const { metadata, payload } = WebAuthnP256.getSignPayload({
  challenge: CHALLENGE,
  rpId: RP_ID,
  origin: ORIGIN,
  userVerification: "required",
})
const signature = P256.sign({ payload, privateKey: TEST_PRIVATE_KEY, hash: true })

// webauthn-sol rejects s > n/2; every Mida assertion adapter normalizes (spec §10.4).
const r = BigInt(signature.r)
const rawS = BigInt(signature.s)
const s = rawS > P256_N / 2n ? P256_N - rawS : rawS

// ox 1.7.4 represents r and s as hex strings, not bigints.
if (!WebAuthnP256.verify({ challenge: CHALLENGE, metadata, publicKey, signature: { r: toBytes32(r), s: toBytes32(s), yParity: 0 } })) {
  throw new Error("fixture does not verify off-chain")
}

const fixture = {
  rpId: RP_ID,
  origin: ORIGIN,
  challenge: CHALLENGE,
  qx: toBytes32(BigInt(publicKey.x)),
  qy: toBytes32(BigInt(publicKey.y)),
  authenticatorData: metadata.authenticatorData,
  clientDataJSON: metadata.clientDataJSON,
  challengeIndex: metadata.challengeIndex,
  typeIndex: metadata.typeIndex,
  r: toBytes32(r),
  s: toBytes32(s),
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${out}`)
```

Run: `pnpm vectors:webauthn`
Expected: `wrote …/contracts/test/vectors/webauthn-v1.json`. The file's `clientDataJSON` is `{"type":"webauthn.get","challenge":"q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s","origin":"https://vault.mida.xyz","crossOrigin":false}` and `authenticatorData` begins with `0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb05`, which is `sha256("vault.mida.xyz")` followed by flags `0x05` (UP and UV).

- [ ] **Step 2: Write the assertion signer used by every later contract test**

`contracts/test/utils/WebAuthnSigner.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";

/// @notice Builds WebAuthn assertions inside Foundry tests with the signP256 cheatcode, in the exact
///         byte layout ox's WebAuthnP256.getSignPayload produces (checked against webauthn-v1.json
///         in MidaWebAuthn.t.sol). Always emits low-s, as every Mida assertion adapter must.
///         Build assertions BEFORE vm.prank: the sha256 precompile calls inside consume a pending prank.
library WebAuthnSigner {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    bytes1 internal constant FLAGS_UP_UV = 0x05;
    bytes1 internal constant FLAGS_UP_ONLY = 0x01;
    string internal constant VAULT_RP_ID = "vault.mida.xyz";
    string internal constant VAULT_ORIGIN = "https://vault.mida.xyz";

    function publicKey(uint256 privateKey) internal pure returns (uint256 qx, uint256 qy) {
        return VM.publicKeyP256(privateKey);
    }

    function clientDataJSON(bytes32 challenge, string memory origin) internal pure returns (string memory) {
        return string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"',
            origin,
            '","crossOrigin":false}'
        );
    }

    function authenticatorData(string memory rpId, bytes1 flags) internal pure returns (bytes memory) {
        return abi.encodePacked(sha256(bytes(rpId)), flags, uint32(0));
    }

    function sign(uint256 privateKey, bytes32 challenge) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return signWith(privateKey, challenge, VAULT_RP_ID, VAULT_ORIGIN, FLAGS_UP_UV);
    }

    function signWith(uint256 privateKey, bytes32 challenge, string memory rpId, string memory origin, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes memory authData = authenticatorData(rpId, flags);
        string memory clientData = clientDataJSON(challenge, origin);
        bytes32 messageHash = sha256(abi.encodePacked(authData, sha256(bytes(clientData))));
        (bytes32 r, bytes32 s) = VM.signP256(privateKey, messageHash);
        uint256 lowS = uint256(s) > P256_N / 2 ? P256_N - uint256(s) : uint256(s);
        auth = WebAuthn.WebAuthnAuth({
            authenticatorData: authData,
            clientDataJSON: clientData,
            challengeIndex: 23,
            typeIndex: 1,
            r: uint256(r),
            s: lowS
        });
    }
}
```

- [ ] **Step 3: Write the failing wrapper and path tests**

`contracts/test/MidaWebAuthn.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {MidaWebAuthn} from "../src/MidaWebAuthn.sol";
import {WebAuthnSigner} from "./utils/WebAuthnSigner.sol";

contract WebAuthnHarness is MidaWebAuthn {
    constructor(string memory rpId) MidaWebAuthn(rpId) {}

    function verify(bytes32 challenge, WebAuthn.WebAuthnAuth memory auth, uint256 qx, uint256 qy)
        external
        view
        returns (bool)
    {
        return _verifyVaultAssertion(challenge, auth, qx, qy);
    }
}

/// @notice §15 WebAuthn rows. Fixture assertions come from ox (export-webauthn-fixture.ts);
///         the rest are built with WebAuthnSigner, which the byte-layout test proves compatible.
contract MidaWebAuthnTest is Test {
    uint256 internal constant OWNER_P256_KEY = 0xa11ce;
    bytes32 internal constant CHALLENGE = keccak256("grant digest under test");

    WebAuthnHarness internal harness;
    string internal fixture;

    function setUp() public {
        harness = new WebAuthnHarness(WebAuthnSigner.VAULT_RP_ID);
        fixture = vm.readFile("test/vectors/webauthn-v1.json");
    }

    function _fixtureAuth() internal view returns (WebAuthn.WebAuthnAuth memory) {
        return WebAuthn.WebAuthnAuth({
            authenticatorData: vm.parseJsonBytes(fixture, ".authenticatorData"),
            clientDataJSON: vm.parseJsonString(fixture, ".clientDataJSON"),
            challengeIndex: vm.parseJsonUint(fixture, ".challengeIndex"),
            typeIndex: vm.parseJsonUint(fixture, ".typeIndex"),
            r: uint256(vm.parseJsonBytes32(fixture, ".r")),
            s: uint256(vm.parseJsonBytes32(fixture, ".s"))
        });
    }

    function _fixtureKey() internal view returns (uint256 qx, uint256 qy) {
        return (uint256(vm.parseJsonBytes32(fixture, ".qx")), uint256(vm.parseJsonBytes32(fixture, ".qy")));
    }

    function test_rpIdHashIsSha256OfConfiguredRpId() public view {
        assertEq(harness.VAULT_RP_ID_HASH(), sha256("vault.mida.xyz"));
        assertEq(harness.vaultRpId(), "vault.mida.xyz");
    }

    function test_emptyRpIdRejectedAtDeployment() public {
        vm.expectRevert(MidaWebAuthn.EmptyRpId.selector);
        new WebAuthnHarness("");
    }

    function test_oxFixtureVerifies() public view {
        (uint256 qx, uint256 qy) = _fixtureKey();
        assertTrue(harness.verify(vm.parseJsonBytes32(fixture, ".challenge"), _fixtureAuth(), qx, qy));
    }

    function test_soliditySignerMatchesOxByteLayout() public view {
        bytes32 challenge = vm.parseJsonBytes32(fixture, ".challenge");
        assertEq(
            WebAuthnSigner.clientDataJSON(challenge, WebAuthnSigner.VAULT_ORIGIN),
            vm.parseJsonString(fixture, ".clientDataJSON")
        );
        assertEq(
            WebAuthnSigner.authenticatorData(WebAuthnSigner.VAULT_RP_ID, WebAuthnSigner.FLAGS_UP_UV),
            vm.parseJsonBytes(fixture, ".authenticatorData")
        );
    }

    function test_soliditySignerAssertionVerifies() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        assertTrue(harness.verify(CHALLENGE, WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE), qx, qy));
    }

    function test_wrongChallengeRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        assertFalse(harness.verify(keccak256("other"), WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE), qx, qy));
    }

    function test_wrongKeyRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY + 1);
        assertFalse(harness.verify(CHALLENGE, WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE), qx, qy));
    }

    /// @dev §15 "grant signed without user-verification flag".
    function test_missingUserVerificationRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            OWNER_P256_KEY, CHALLENGE, WebAuthnSigner.VAULT_RP_ID, WebAuthnSigner.VAULT_ORIGIN, WebAuthnSigner.FLAGS_UP_ONLY
        );
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy));
    }

    /// @dev §15 "authenticatorData[0:32] is not the configured Vault RP-ID hash": rejected by the wrapper.
    function test_foreignRpIdRejectedByWrapper() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            OWNER_P256_KEY, CHALLENGE, "evil.example", "https://vault.mida.xyz", WebAuthnSigner.FLAGS_UP_UV
        );
        assertTrue(WebAuthn.verify(abi.encode(CHALLENGE), true, auth, qx, qy), "library alone accepts it");
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy), "Mida wrapper must reject it");
    }

    /// @dev §15 "high-s signature": rejected by webauthn-sol.
    function test_highSRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE);
        auth.s = WebAuthnSigner.P256_N - auth.s;
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy));
    }

    /// @dev §15 "foreign clientDataJSON.origin but correct RP-ID hash": ACCEPTED on-chain.
    ///      This test documents the v0 limitation; if it ever fails, update spec §10.4 first.
    function test_foreignOriginWithCorrectRpIdIsAcceptedOnChain() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            OWNER_P256_KEY, CHALLENGE, WebAuthnSigner.VAULT_RP_ID, "https://evil.example", WebAuthnSigner.FLAGS_UP_UV
        );
        assertTrue(harness.verify(CHALLENGE, auth, qx, qy));
    }

    function test_truncatedAuthenticatorDataRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE);
        auth.authenticatorData = abi.encodePacked(sha256("vault.mida.xyz"));
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy));
    }
}
```

`contracts/test/P256Paths.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {WebAuthnHarness} from "./MidaWebAuthn.t.sol";

/// @notice Evidence that the two local verification paths are distinct (spec §10.4, §19).
///         Run twice:
///           forge test --match-contract P256PathsTest -vv                      -> native PASS, fallback SKIP
///           forge test --match-contract P256PathsTest -vv --evm-version prague -> native SKIP, fallback PASS
///         The Monad testnet native path is evidenced separately in plan Task 27.
contract P256PathsTest is Test {
    uint256 internal constant NATIVE_MAX_GAS = 120_000;
    uint256 internal constant FALLBACK_MIN_GAS = 250_000;

    WebAuthnHarness internal harness;
    string internal fixture;
    WebAuthn.WebAuthnAuth internal auth;
    bytes32 internal challenge;
    uint256 internal qx;
    uint256 internal qy;

    function setUp() public {
        harness = new WebAuthnHarness("vault.mida.xyz");
        fixture = vm.readFile("test/vectors/webauthn-v1.json");
        challenge = vm.parseJsonBytes32(fixture, ".challenge");
        qx = uint256(vm.parseJsonBytes32(fixture, ".qx"));
        qy = uint256(vm.parseJsonBytes32(fixture, ".qy"));
        auth = WebAuthn.WebAuthnAuth({
            authenticatorData: vm.parseJsonBytes(fixture, ".authenticatorData"),
            clientDataJSON: vm.parseJsonString(fixture, ".clientDataJSON"),
            challengeIndex: vm.parseJsonUint(fixture, ".challengeIndex"),
            typeIndex: vm.parseJsonUint(fixture, ".typeIndex"),
            r: uint256(vm.parseJsonBytes32(fixture, ".r")),
            s: uint256(vm.parseJsonBytes32(fixture, ".s"))
        });
    }

    /// @dev Calls 0x100 directly with the fixture's 160-byte input. An absent precompile is an empty
    ///      account: the call succeeds with empty return data.
    function _precompilePresent() internal view returns (bool) {
        bytes32 messageHash = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(messageHash, auth.r, auth.s, qx, qy));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    function _measuredVerifyGas() internal view returns (uint256 used) {
        uint256 before = gasleft();
        bool verified = harness.verify(challenge, auth, qx, qy);
        used = before - gasleft();
        assertTrue(verified, "fixture must verify on this path");
    }

    function test_nativePrecompilePath() public {
        vm.skip(!_precompilePresent(), "P256VERIFY absent at 0x100; this run proves the fallback path");
        uint256 used = _measuredVerifyGas();
        emit log_named_uint("native P256 verify gas", used);
        assertLt(used, NATIVE_MAX_GAS);
    }

    function test_solidityFallbackPath() public {
        vm.skip(_precompilePresent(), "P256VERIFY present at 0x100; rerun with --evm-version prague");
        uint256 used = _measuredVerifyGas();
        emit log_named_uint("FreshCryptoLib P256 verify gas", used);
        assertGt(used, FALLBACK_MIN_GAS);
    }
}
```

- [ ] **Step 4: Run to verify they fail**

Run: `forge test --match-path "test/{MidaWebAuthn,P256Paths}.t.sol"`
Expected: FAIL at compilation, because `src/MidaWebAuthn.sol` does not exist.

- [ ] **Step 5: Implement the wrapper**

`contracts/src/MidaWebAuthn.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";

/// @notice Mida's WebAuthn verification boundary (spec §10.4).
///         This wrapper checks the RP-ID hash; webauthn-sol checks type, challenge, UP, UV (always
///         required here), low-s and the P256 signature. clientDataJSON.origin is NOT checked
///         on-chain: that binding rests on the browser refusing to assert this RP ID for another
///         origin. This is a documented v0 limitation.
abstract contract MidaWebAuthn {
    error EmptyRpId();

    /// @notice SHA-256 of the configured Vault RP ID, compared with authenticatorData[0:32].
    bytes32 public immutable VAULT_RP_ID_HASH;
    string public vaultRpId;

    constructor(string memory rpId) {
        if (bytes(rpId).length == 0) revert EmptyRpId();
        VAULT_RP_ID_HASH = sha256(bytes(rpId));
        vaultRpId = rpId;
    }

    /// @param challenge The 32-byte digest the owner approved (grantDigest or p256RotationDigest).
    function _verifyVaultAssertion(bytes32 challenge, WebAuthn.WebAuthnAuth memory auth, uint256 qx, uint256 qy)
        internal
        view
        returns (bool)
    {
        // 32 bytes rpIdHash + 1 byte flags + 4 bytes signCount
        if (auth.authenticatorData.length < 37) return false;
        if (bytes32(auth.authenticatorData) != VAULT_RP_ID_HASH) return false;
        return WebAuthn.verify(abi.encode(challenge), true, auth, qx, qy);
    }
}
```

- [ ] **Step 6: Run both local paths and record the evidence**

Run:
```bash
forge test --match-path "test/{MidaWebAuthn,P256Paths}.t.sol" -vv
forge test --match-path "test/{MidaWebAuthn,P256Paths}.t.sol" -vv --evm-version prague
```
Expected, first run: `MidaWebAuthnTest` `12 passed`; `P256PathsTest` shows `[PASS] test_nativePrecompilePath()` with `native P256 verify gas:` about 55,000, and `[SKIP: P256VERIFY present at 0x100; …] test_solidityFallbackPath()`.

Expected, second run: `MidaWebAuthnTest` `12 passed`; `P256PathsTest` shows `[SKIP: P256VERIFY absent at 0x100; …] test_nativePrecompilePath()` and `[PASS] test_solidityFallbackPath()` with `FreshCryptoLib P256 verify gas:` about 400,000.

If the first run shows the native test skipped, `evm_version = "osaka"` is missing from `foundry.toml`. Per spec §10.4, do not proceed on fallback-only coverage: fix the configuration and rerun.

Save both outputs as evidence for Task 28:
```bash
mkdir -p ../docs/evidence
forge test --match-contract P256PathsTest -vv > ../docs/evidence/p256-local-native.txt
forge test --match-contract P256PathsTest -vv --evm-version prague > ../docs/evidence/p256-local-fallback.txt
```

- [ ] **Step 7: Commit**

```bash
cd ..
git add contracts/src/MidaWebAuthn.sol contracts/test/MidaWebAuthn.t.sol contracts/test/P256Paths.t.sol contracts/test/utils/WebAuthnSigner.sol contracts/test/vectors/webauthn-v1.json packages/protocol/scripts/export-webauthn-fixture.ts packages/protocol/package.json package.json pnpm-lock.yaml docs/evidence
git commit -m "feat(contracts): Mida WebAuthn boundary with RP-ID hash check and two local P256 paths

Native precompile and FreshCryptoLib fallback are evidenced separately by gas band.

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 16: `CapabilityRegistry`: agent registration, key rotation, manifest updates

**Depends on:** Tasks 14 and 15.

**Files:**
- Create: `contracts/src/SignatureRecovery.sol`, `contracts/src/AgentRegistry.sol`, `contracts/src/CapabilityRegistry.sol`
- Test: `contracts/test/utils/AgentFixtures.sol`, `contracts/test/AgentRegistry.t.sol`

**Interfaces:**
- Consumes: `AgentRegistration` struct and `MidaHashing.agentId`, `agentRegistrationDigest`, `signerRotationDigest`, `manifestBindingDigest` (Task 14); `MidaWebAuthn` constructor (Task 15).
- Produces, `library SignatureRecovery`: `recover(bytes32 digest, bytes memory signature) internal pure returns (address)` — 65 bytes, low-s, `v ∈ {27, 28}`, else `address(0)`.
- Produces, `abstract contract AgentRegistry`:
  - `struct AgentRecord { address operator; address signer; bytes32 encryptionPublicKey; uint32 encryptionKeyVersion; bytes32 callbackOriginHash; bytes32 capabilityManifestHash; uint64 capabilityManifestVersion; bool active; }`
  - `registerAgent(bytes32 agentSalt, address signer, bytes32 encryptionPublicKey, bytes32 callbackOriginHash, bytes32 capabilityManifestHash, bytes calldata signerSignature) external returns (bytes32 agentId)`
  - `rotateAgentSigner(bytes32 agentId, address newSigner, bytes calldata newSignerSignature) external`
  - `rotateAgentEncryptionKey(bytes32 agentId, bytes32 newEncryptionPublicKey) external`
  - `setAgentCallbackOrigin(bytes32 agentId, bytes32 newCallbackOriginHash) external`
  - `updateAgentCapabilityManifest(bytes32 agentId, bytes32 bodyHash, uint64 manifestVersion, bytes calldata operatorSignature) external`
  - `getAgent(bytes32 agentId) external view returns (AgentRecord memory)`
  - `agentIdOfSigner(address signer) public view returns (bytes32)` — `bytes32(0)` when unbound
  - `signerRotationNonce(bytes32 agentId) public view returns (uint64)`
  - internal `_activeAgent(bytes32 agentId) returns (AgentRecord storage)`
  - Errors: `AgentNotFound(bytes32)`, `AgentAlreadyRegistered(bytes32)`, `NotOperator(bytes32)`, `SignerAlreadyBound(address)`, `InvalidSignature()`, `ZeroValue()`, `ManifestVersionInvalid(uint64 expected, uint64 submitted)`
  - Events: `AgentRegistered(bytes32 indexed agentId, address indexed operator, address indexed signer, bytes32 encryptionPublicKey, uint32 encryptionKeyVersion, bytes32 callbackOriginHash, bytes32 capabilityManifestHash, uint64 capabilityManifestVersion)`, `AgentSigningKeyRotated(bytes32 indexed agentId, address indexed previousSigner, address indexed newSigner)`, `AgentEncryptionKeyRotated(bytes32 indexed agentId, bytes32 encryptionPublicKey, uint32 encryptionKeyVersion)`, `AgentOriginChanged(bytes32 indexed agentId, bytes32 callbackOriginHash)`, `AgentCapabilityManifestUpdated(bytes32 indexed agentId, bytes32 capabilityManifestHash, uint64 capabilityManifestVersion)`
- Produces, `contract CapabilityRegistry is NamespaceTree, AgentRegistry, MidaWebAuthn` with `constructor(string memory vaultRpId)`. Tasks 17 and 18 change only its parent list; the constructor signature stays.
- Produces, test base `AgentFixtures is Test`: `struct TestAgent { bytes32 agentId; uint256 operatorKey; address operator; uint256 signerKey; address signer; bytes32 encryptionPublicKey; bytes32 callbackOriginHash; bytes32 manifestHash; }`, `_sign(uint256 key, bytes32 digest) returns (bytes)`, `_newAgent(string label) returns (TestAgent)`, `_registrationSignature(CapabilityRegistry, TestAgent, bytes32 salt, uint256 signingKey) returns (bytes32 agentId, bytes signature)`, `_register(CapabilityRegistry, string label) returns (TestAgent)`

- [ ] **Step 1: Write the test fixtures**

`contracts/test/utils/AgentFixtures.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentRegistration} from "../../src/MidaTypes.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {CapabilityRegistry} from "../../src/CapabilityRegistry.sol";

/// @notice Shared agent setup for registry tests. Keys are Foundry test keys, never real secrets.
abstract contract AgentFixtures is Test {
    struct TestAgent {
        bytes32 agentId;
        uint256 operatorKey;
        address operator;
        uint256 signerKey;
        address signer;
        bytes32 encryptionPublicKey;
        bytes32 callbackOriginHash;
        bytes32 manifestHash;
    }

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _newAgent(string memory label) internal returns (TestAgent memory agent) {
        (agent.operator, agent.operatorKey) = makeAddrAndKey(string.concat(label, ".operator"));
        (agent.signer, agent.signerKey) = makeAddrAndKey(string.concat(label, ".signer"));
        agent.encryptionPublicKey = keccak256(abi.encode(label, "x25519"));
        agent.callbackOriginHash = keccak256(bytes(string.concat("https://", label, ".example")));
        agent.manifestHash = keccak256(abi.encode(label, "manifest", uint64(1)));
    }

    function _registrationSignature(CapabilityRegistry registry, TestAgent memory agent, bytes32 salt, uint256 signingKey)
        internal
        view
        returns (bytes32 agentId, bytes memory signature)
    {
        agentId = MidaHashing.agentId(block.chainid, address(registry), agent.operator, salt);
        AgentRegistration memory registration = AgentRegistration({
            agentId: agentId,
            operator: agent.operator,
            signer: agent.signer,
            encryptionPublicKey: agent.encryptionPublicKey,
            encryptionKeyVersion: 1,
            callbackOriginHash: agent.callbackOriginHash,
            capabilityManifestHash: agent.manifestHash,
            capabilityManifestVersion: 1
        });
        signature = _sign(signingKey, MidaHashing.agentRegistrationDigest(registration, block.chainid, address(registry)));
    }

    function _register(CapabilityRegistry registry, string memory label) internal returns (TestAgent memory agent) {
        agent = _newAgent(label);
        bytes32 salt = keccak256(abi.encode(label, "salt"));
        bytes memory signature;
        (agent.agentId, signature) = _registrationSignature(registry, agent, salt, agent.signerKey);
        vm.prank(agent.operator);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, signature
        );
    }
}
```

- [ ] **Step 2: Write the failing tests**

`contracts/test/AgentRegistry.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MidaHashing} from "../src/MidaHashing.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {AgentFixtures} from "./utils/AgentFixtures.sol";

/// @notice §15 Identity rows and contract-side Advisor manifest rows.
contract AgentRegistryTest is AgentFixtures {
    CapabilityRegistry internal registry;

    function setUp() public {
        registry = new CapabilityRegistry("vault.mida.xyz");
    }

    function test_registerStoresRecordAndEmits() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        (bytes32 expectedId, bytes memory signature) = _registrationSignature(registry, agent, salt, agent.signerKey);

        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentRegistered(
            expectedId, agent.operator, agent.signer, agent.encryptionPublicKey, 1, agent.callbackOriginHash, agent.manifestHash, 1
        );
        vm.prank(agent.operator);
        bytes32 agentId = registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, signature
        );

        assertEq(agentId, expectedId);
        AgentRegistry.AgentRecord memory record = registry.getAgent(agentId);
        assertEq(record.operator, agent.operator);
        assertEq(record.signer, agent.signer);
        assertEq(record.encryptionPublicKey, agent.encryptionPublicKey);
        assertEq(record.encryptionKeyVersion, 1);
        assertEq(record.callbackOriginHash, agent.callbackOriginHash);
        assertEq(record.capabilityManifestHash, agent.manifestHash);
        assertEq(record.capabilityManifestVersion, 1);
        assertTrue(record.active);
        assertEq(registry.agentIdOfSigner(agent.signer), agentId);
    }

    /// @dev §15 "register an agent without signer acceptance proof".
    function test_registrationWithoutSignerProofRejected() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        (, bytes memory operatorSigned) = _registrationSignature(registry, agent, salt, agent.operatorKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, operatorSigned
        );
    }

    function test_registrationSignatureBoundToChainAndRegistry() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        CapabilityRegistry other = new CapabilityRegistry("vault.mida.xyz");
        (, bytes memory forOtherRegistry) = _registrationSignature(other, agent, salt, agent.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, forOtherRegistry
        );

        (, bytes memory forThisChain) = _registrationSignature(registry, agent, salt, agent.signerKey);
        vm.chainId(10143);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, forThisChain
        );
    }

    function test_registrationSignatureCannotBeMutated() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        (, bytes memory signature) = _registrationSignature(registry, agent, salt, agent.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, keccak256("different key"), agent.callbackOriginHash, agent.manifestHash, signature
        );
    }

    function test_duplicateAgentIdRejected() public {
        TestAgent memory agent = _register(registry, "career");
        TestAgent memory again = _newAgent("career");
        (again.signer, again.signerKey) = makeAddrAndKey("career.second-signer");
        bytes32 salt = keccak256(abi.encode("career", "salt"));
        (, bytes memory signature) = _registrationSignature(registry, again, salt, again.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentAlreadyRegistered.selector, agent.agentId));
        registry.registerAgent(salt, again.signer, again.encryptionPublicKey, again.callbackOriginHash, again.manifestHash, signature);
    }

    /// @dev §15 "reuse one active signer for another agent ID".
    function test_signerCannotBindTwoAgents() public {
        TestAgent memory first = _register(registry, "career");
        TestAgent memory second = _newAgent("travel");
        second.signer = first.signer;
        second.signerKey = first.signerKey;
        bytes32 salt = keccak256("travel.salt");
        (, bytes memory signature) = _registrationSignature(registry, second, salt, second.signerKey);
        vm.prank(second.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerAlreadyBound.selector, first.signer));
        registry.registerAgent(salt, second.signer, second.encryptionPublicKey, second.callbackOriginHash, second.manifestHash, signature);
    }

    function test_zeroValuesRejected() public {
        TestAgent memory agent = _newAgent("career");
        vm.startPrank(agent.operator);
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.registerAgent(bytes32(0), address(0), agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, "");
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.registerAgent(bytes32(0), agent.signer, bytes32(0), agent.callbackOriginHash, agent.manifestHash, "");
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.registerAgent(bytes32(0), agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, bytes32(0), "");
        vm.stopPrank();
    }

    function test_unknownAgentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentNotFound.selector, bytes32(uint256(7))));
        registry.getAgent(bytes32(uint256(7)));
    }

    function _rotationSignature(bytes32 agentId, address newSigner, uint64 nonce, uint256 key) internal view returns (bytes memory) {
        return _sign(key, MidaHashing.signerRotationDigest(agentId, newSigner, nonce, block.chainid, address(registry)));
    }

    function test_signerRotationMovesBindingAndEmits() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner, uint256 newKey) = makeAddrAndKey("career.rotated");
        bytes memory proof = _rotationSignature(agent.agentId, newSigner, 0, newKey);

        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentSigningKeyRotated(agent.agentId, agent.signer, newSigner);
        vm.prank(agent.operator);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);

        assertEq(registry.getAgent(agent.agentId).signer, newSigner);
        assertEq(registry.agentIdOfSigner(newSigner), agent.agentId);
        assertEq(registry.agentIdOfSigner(agent.signer), bytes32(0));
        assertEq(registry.signerRotationNonce(agent.agentId), 1);
    }

    /// @dev §15 "signing-key rotation lacks new-signer proof".
    function test_signerRotationRequiresNewSignerProof() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner,) = makeAddrAndKey("career.rotated");
        bytes memory oldSignerProof = _rotationSignature(agent.agentId, newSigner, 0, agent.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.rotateAgentSigner(agent.agentId, newSigner, oldSignerProof);
    }

    function test_signerRotationProofCannotBeReplayed() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner, uint256 newKey) = makeAddrAndKey("career.rotated");
        bytes memory proof = _rotationSignature(agent.agentId, newSigner, 0, newKey);
        vm.startPrank(agent.operator);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);
        registry.rotateAgentSigner(agent.agentId, agent.signer, _rotationSignature(agent.agentId, agent.signer, 1, agent.signerKey));
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);
        vm.stopPrank();
    }

    function test_signerRotationRejectsSignerBoundElsewhere() public {
        TestAgent memory career = _register(registry, "career");
        TestAgent memory travel = _register(registry, "travel");
        bytes memory proof = _rotationSignature(career.agentId, travel.signer, 0, travel.signerKey);
        vm.prank(career.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerAlreadyBound.selector, travel.signer));
        registry.rotateAgentSigner(career.agentId, travel.signer, proof);
    }

    /// @dev §15 "non-operator rotates agent key".
    function test_nonOperatorCannotChangeAgent() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner, uint256 newKey) = makeAddrAndKey("career.rotated");
        bytes memory proof = _rotationSignature(agent.agentId, newSigner, 0, newKey);
        bytes memory notOperator = abi.encodeWithSelector(AgentRegistry.NotOperator.selector, agent.agentId);

        vm.startPrank(agent.signer);
        vm.expectRevert(notOperator);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);
        vm.expectRevert(notOperator);
        registry.rotateAgentEncryptionKey(agent.agentId, keccak256("new key"));
        vm.expectRevert(notOperator);
        registry.setAgentCallbackOrigin(agent.agentId, keccak256("https://evil.example"));
        vm.expectRevert(notOperator);
        registry.updateAgentCapabilityManifest(agent.agentId, keccak256("body"), 2, "");
        vm.stopPrank();
    }

    function test_encryptionRotationIncrementsVersion() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 newKey = keccak256("career.x25519.v2");
        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentEncryptionKeyRotated(agent.agentId, newKey, 2);
        vm.prank(agent.operator);
        registry.rotateAgentEncryptionKey(agent.agentId, newKey);
        AgentRegistry.AgentRecord memory record = registry.getAgent(agent.agentId);
        assertEq(record.encryptionPublicKey, newKey);
        assertEq(record.encryptionKeyVersion, 2);
    }

    function test_callbackOriginChangeEmits() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 newOrigin = keccak256("https://career-v2.example");
        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentOriginChanged(agent.agentId, newOrigin);
        vm.prank(agent.operator);
        registry.setAgentCallbackOrigin(agent.agentId, newOrigin);
        assertEq(registry.getAgent(agent.agentId).callbackOriginHash, newOrigin);
    }

    function _manifestSignature(bytes32 agentId, bytes32 bodyHash, uint64 version, uint256 key, uint256 chainId, address reg)
        internal
        pure
        returns (bytes memory)
    {
        return _sign(key, MidaHashing.manifestBindingDigest(bodyHash, agentId, version, chainId, reg));
    }

    function test_manifestUpdateAdvancesExactlyOneVersion() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body v2");
        bytes memory signature = _manifestSignature(agent.agentId, body, 2, agent.operatorKey, block.chainid, address(registry));
        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentCapabilityManifestUpdated(agent.agentId, body, 2);
        vm.prank(agent.operator);
        registry.updateAgentCapabilityManifest(agent.agentId, body, 2, signature);
        AgentRegistry.AgentRecord memory record = registry.getAgent(agent.agentId);
        assertEq(record.capabilityManifestHash, body);
        assertEq(record.capabilityManifestVersion, 2);
    }

    /// @dev §15 "non-operator or skipped/replayed manifest version update".
    function test_manifestUpdateRejectsSkippedAndReplayedVersions() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body");
        vm.startPrank(agent.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ManifestVersionInvalid.selector, uint64(2), uint64(3)));
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 3, _manifestSignature(agent.agentId, body, 3, agent.operatorKey, block.chainid, address(registry))
        );
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ManifestVersionInvalid.selector, uint64(2), uint64(1)));
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 1, _manifestSignature(agent.agentId, body, 1, agent.operatorKey, block.chainid, address(registry))
        );
        vm.stopPrank();
    }

    function test_manifestUpdateRequiresOperatorSignature() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body v2");
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 2, _manifestSignature(agent.agentId, body, 2, agent.signerKey, block.chainid, address(registry))
        );
    }

    /// @dev §15 "use manifest envelope from another chain/registry".
    function test_manifestSignatureBoundToChainAndRegistry() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body v2");
        vm.startPrank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 2, _manifestSignature(agent.agentId, body, 2, agent.operatorKey, 10143, address(registry))
        );
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 2, _manifestSignature(agent.agentId, body, 2, agent.operatorKey, block.chainid, address(0xBEEF))
        );
        vm.stopPrank();
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `forge test --match-contract AgentRegistryTest`
Expected: FAIL at compilation, because `src/CapabilityRegistry.sol` and `src/AgentRegistry.sol` do not exist.

- [ ] **Step 4: Implement signature recovery, the agent registry and the registry shell**

`contracts/src/SignatureRecovery.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Strict secp256k1 recovery for EIP-712 signatures from viem accounts: 65 bytes (r, s, v),
///         low-s only, v in {27, 28}. Returns address(0) for anything malformed; callers compare
///         the result with an expected non-zero signer.
library SignatureRecovery {
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > HALF_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
```

`contracts/src/AgentRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentRegistration} from "./MidaTypes.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {SignatureRecovery} from "./SignatureRecovery.sol";

/// @notice Agent identities (spec §4.3) and capability-manifest commitments (spec §14.1).
///         agentId = keccak256(abi.encode("MIDA_AGENT_V1", chainId, registry, operator, agentSalt)).
///         The signer is a rotatable attribute and is not part of the identifier.
abstract contract AgentRegistry {
    struct AgentRecord {
        address operator;
        address signer;
        bytes32 encryptionPublicKey;
        uint32 encryptionKeyVersion;
        bytes32 callbackOriginHash;
        bytes32 capabilityManifestHash;
        uint64 capabilityManifestVersion;
        bool active;
    }

    error AgentNotFound(bytes32 agentId);
    error AgentAlreadyRegistered(bytes32 agentId);
    error NotOperator(bytes32 agentId);
    error SignerAlreadyBound(address signer);
    error InvalidSignature();
    error ZeroValue();
    error ManifestVersionInvalid(uint64 expected, uint64 submitted);

    mapping(bytes32 agentId => AgentRecord) private _agents;
    mapping(address signer => bytes32 agentId) private _agentIdBySigner;
    mapping(bytes32 agentId => uint64) public signerRotationNonce;

    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed operator,
        address indexed signer,
        bytes32 encryptionPublicKey,
        uint32 encryptionKeyVersion,
        bytes32 callbackOriginHash,
        bytes32 capabilityManifestHash,
        uint64 capabilityManifestVersion
    );
    event AgentSigningKeyRotated(bytes32 indexed agentId, address indexed previousSigner, address indexed newSigner);
    event AgentEncryptionKeyRotated(bytes32 indexed agentId, bytes32 encryptionPublicKey, uint32 encryptionKeyVersion);
    event AgentOriginChanged(bytes32 indexed agentId, bytes32 callbackOriginHash);
    event AgentCapabilityManifestUpdated(
        bytes32 indexed agentId, bytes32 capabilityManifestHash, uint64 capabilityManifestVersion
    );

    /// @notice Called by the operator. The proposed signer must have signed MidaAgentRegistrationV1
    ///         over every field, with encryptionKeyVersion = 1 and capabilityManifestVersion = 1.
    function registerAgent(
        bytes32 agentSalt,
        address signer,
        bytes32 encryptionPublicKey,
        bytes32 callbackOriginHash,
        bytes32 capabilityManifestHash,
        bytes calldata signerSignature
    ) external returns (bytes32 agentId) {
        if (
            signer == address(0) || encryptionPublicKey == bytes32(0) || callbackOriginHash == bytes32(0)
                || capabilityManifestHash == bytes32(0)
        ) revert ZeroValue();
        agentId = MidaHashing.agentId(block.chainid, address(this), msg.sender, agentSalt);
        if (_agents[agentId].operator != address(0)) revert AgentAlreadyRegistered(agentId);
        if (_agentIdBySigner[signer] != bytes32(0)) revert SignerAlreadyBound(signer);

        AgentRegistration memory registration = AgentRegistration({
            agentId: agentId,
            operator: msg.sender,
            signer: signer,
            encryptionPublicKey: encryptionPublicKey,
            encryptionKeyVersion: 1,
            callbackOriginHash: callbackOriginHash,
            capabilityManifestHash: capabilityManifestHash,
            capabilityManifestVersion: 1
        });
        bytes32 digest = MidaHashing.agentRegistrationDigest(registration, block.chainid, address(this));
        if (SignatureRecovery.recover(digest, signerSignature) != signer) revert InvalidSignature();

        _agents[agentId] = AgentRecord({
            operator: msg.sender,
            signer: signer,
            encryptionPublicKey: encryptionPublicKey,
            encryptionKeyVersion: 1,
            callbackOriginHash: callbackOriginHash,
            capabilityManifestHash: capabilityManifestHash,
            capabilityManifestVersion: 1,
            active: true
        });
        _agentIdBySigner[signer] = agentId;
        emit AgentRegistered(
            agentId, msg.sender, signer, encryptionPublicKey, 1, callbackOriginHash, capabilityManifestHash, 1
        );
    }

    /// @notice Operator authority plus MidaSignerRotationV1 signed by the new signer.
    function rotateAgentSigner(bytes32 agentId, address newSigner, bytes calldata newSignerSignature) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (newSigner == address(0)) revert ZeroValue();
        if (_agentIdBySigner[newSigner] != bytes32(0)) revert SignerAlreadyBound(newSigner);
        uint64 nonce = signerRotationNonce[agentId];
        bytes32 digest = MidaHashing.signerRotationDigest(agentId, newSigner, nonce, block.chainid, address(this));
        if (SignatureRecovery.recover(digest, newSignerSignature) != newSigner) revert InvalidSignature();

        signerRotationNonce[agentId] = nonce + 1;
        address previous = agent.signer;
        delete _agentIdBySigner[previous];
        _agentIdBySigner[newSigner] = agentId;
        agent.signer = newSigner;
        emit AgentSigningKeyRotated(agentId, previous, newSigner);
    }

    /// @notice Operator authority. Existing reader wraps for the old version become invalid.
    function rotateAgentEncryptionKey(bytes32 agentId, bytes32 newEncryptionPublicKey) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (newEncryptionPublicKey == bytes32(0)) revert ZeroValue();
        agent.encryptionPublicKey = newEncryptionPublicKey;
        agent.encryptionKeyVersion += 1;
        emit AgentEncryptionKeyRotated(agentId, newEncryptionPublicKey, agent.encryptionKeyVersion);
    }

    function setAgentCallbackOrigin(bytes32 agentId, bytes32 newCallbackOriginHash) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (newCallbackOriginHash == bytes32(0)) revert ZeroValue();
        agent.callbackOriginHash = newCallbackOriginHash;
        emit AgentOriginChanged(agentId, newCallbackOriginHash);
    }

    /// @notice Operator authority, the exact next version, and the operator's EIP-712 ManifestBinding
    ///         signature under the "Mida Agent Capability Manifest" domain for this chain and registry.
    function updateAgentCapabilityManifest(
        bytes32 agentId,
        bytes32 bodyHash,
        uint64 manifestVersion,
        bytes calldata operatorSignature
    ) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (bodyHash == bytes32(0)) revert ZeroValue();
        uint64 expected = agent.capabilityManifestVersion + 1;
        if (manifestVersion != expected) revert ManifestVersionInvalid(expected, manifestVersion);
        bytes32 digest = MidaHashing.manifestBindingDigest(bodyHash, agentId, manifestVersion, block.chainid, address(this));
        if (SignatureRecovery.recover(digest, operatorSignature) != agent.operator) revert InvalidSignature();

        agent.capabilityManifestHash = bodyHash;
        agent.capabilityManifestVersion = manifestVersion;
        emit AgentCapabilityManifestUpdated(agentId, bodyHash, manifestVersion);
    }

    function getAgent(bytes32 agentId) external view returns (AgentRecord memory) {
        return _activeAgent(agentId);
    }

    /// @notice Returns bytes32(0) when the address is not the current signer of any agent.
    function agentIdOfSigner(address signer) public view returns (bytes32) {
        return _agentIdBySigner[signer];
    }

    function _activeAgent(bytes32 agentId) internal view returns (AgentRecord storage agent) {
        agent = _agents[agentId];
        if (!agent.active) revert AgentNotFound(agentId);
    }

    function _operatorAgent(bytes32 agentId) private view returns (AgentRecord storage agent) {
        agent = _activeAgent(agentId);
        if (agent.operator != msg.sender) revert NotOperator(agentId);
    }
}
```

`contracts/src/CapabilityRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentRegistry} from "./AgentRegistry.sol";
import {MidaWebAuthn} from "./MidaWebAuthn.sol";
import {NamespaceTree} from "./NamespaceTree.sol";

/// @notice Canonical authority for Mida Context (spec §10). Task 16 stage: namespaces and agents.
contract CapabilityRegistry is NamespaceTree, AgentRegistry, MidaWebAuthn {
    constructor(string memory vaultRpId) MidaWebAuthn(vaultRpId) {}
}
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
forge test --match-contract AgentRegistryTest
forge test
```
Expected: `AgentRegistryTest` `19 passed`. The full suite has no failures (`P256PathsTest` shows one skipped test by design).

- [ ] **Step 6: Commit**

```bash
cd ..
git add contracts/src/SignatureRecovery.sol contracts/src/AgentRegistry.sol contracts/src/CapabilityRegistry.sol contracts/test/utils/AgentFixtures.sol contracts/test/AgentRegistry.t.sol
git commit -m "feat(contracts): agent registration with signer acceptance, key rotation and manifest versions

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 17: `CapabilityRegistry`: owner P256 keys and `grantBatch`

**Depends on:** Task 16.

**Foundry test pitfalls this task's tests already avoid.** Keep avoiding them in Tasks 18–20.
- Build any WebAuthn assertion **before** `vm.prank`. `WebAuthnSigner` calls the `sha256` precompile, and that call consumes a pending prank.
- Under via-IR, do not re-read `block.timestamp` in the same test function after `vm.warp`: the optimizer can reuse the earlier value. Use absolute timestamps you computed before warping, or `vm.getBlockTimestamp()`.
- `vm.expectRevert(bytes4)` needs the full revert data to be just that selector. For errors with arguments, pass `abi.encodeWithSelector(Error.selector, args)`.

**Files:**
- Create: `contracts/src/CapabilityStore.sol`, `contracts/src/ReadEpochs.sol`, `contracts/src/OwnerKeys.sol`, `contracts/src/Grants.sol`
- Modify: `contracts/src/CapabilityRegistry.sol`
- Test: `contracts/test/utils/GrantFixtures.sol`, `contracts/test/Grants.t.sol`

**Interfaces:**
- Consumes: Task 14 constants, structs and errors; `MidaHashing.accessRequestDigest`, `grantDigest`, `scopesHash`, `capabilityId`, `p256RotationDigest`; `NamespaceTree.isRegisteredNamespace`, `isHighSensitivity`, `_requireNamespace`; `MidaWebAuthn._verifyVaultAssertion` (Task 15); `AgentRegistry._activeAgent`, `InvalidSignature`, `AgentRecord` (Task 16); `SignatureRecovery.recover`.
- Produces, `abstract contract CapabilityStore`:
  - `struct Capability { address owner; bytes32 agentId; bytes32 namespaceId; uint8 permissions; uint8 provenancePolicy; uint64 issuedAt; uint64 expiresAt; uint64 agentEpoch; uint64 grantedAtReadEpoch; bool revoked; }` (spec §10.3 field order)
  - `getCapability(bytes32) external view returns (Capability memory)`; `agentEpoch(address owner, bytes32 agentId) external view returns (uint64)`; `isCapabilityValid(bytes32) public view returns (bool)`; `activeCapabilityIds(address owner, bytes32 agentId) external view returns (bytes32[] memory)`
  - internal: `_capabilities`, `_agentEpoch`, `_activeByNamespace`, `_activeByAgent`, `_isLive(Capability storage)`, `_compact(bytes32[] storage)`, `_storeCapability(bytes32, Capability memory)`
  - Errors: `CapabilityNotFound(bytes32)`, `CapabilityLimit(bytes32 namespaceId)`
- Produces, `abstract contract ReadEpochs is NamespaceTree`:
  - `initializeReadEpoch(bytes32 namespaceId, bytes32 publicKey) external`
  - `requiredReadEpoch(address owner, bytes32 namespaceId) public view returns (uint64)` — 1 when never advanced
  - `epochPublicKey(address owner, bytes32 namespaceId, uint64 epoch) public view returns (bytes32)`
  - `writeDeadline(address owner, bytes32 namespaceId) external view returns (uint64)`
  - `isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) public view returns (bool)`
  - internal `_writeDeadline`, `_lowerWriteDeadline(address, bytes32, uint64)`, `_publishNextEpoch(address owner, bytes32 namespaceId, bytes32 publicKey, uint64 newDeadline) returns (uint64 next)`
  - Errors: `ZeroEpochKey()`, `EpochAlreadyInitialized(bytes32)`
  - Events: `ReadEpochRequired(address indexed owner, bytes32 indexed namespaceId, uint64 readEpoch, uint64 writeDeadline)`, `NamespaceEpochKeySet(address indexed owner, bytes32 indexed namespaceId, uint64 indexed readEpoch, bytes32 publicKey)`
- Produces, `abstract contract OwnerKeys is MidaWebAuthn`:
  - `struct P256Key { uint256 qx; uint256 qy; }`
  - `registerP256Key(uint256 qx, uint256 qy) external`; `rotateP256Key(uint256 newQx, uint256 newQy, WebAuthn.WebAuthnAuth calldata auth) external`; `ownerP256Key(address) external view returns (uint256 qx, uint256 qy)`; `p256RotationNonce(address) public view returns (uint256)`
  - internal `_requireOwnerKey(address) returns (P256Key memory)`
  - Errors: `ZeroP256Key()`, `P256KeyExists(address)`, `P256KeyMissing(address)`, `WebAuthnInvalid()`
  - Event: `P256KeyRegistered(address indexed owner, uint256 qx, uint256 qy, uint256 rotationNonce)`
- Produces, `abstract contract Grants is NamespaceTree, AgentRegistry, OwnerKeys, CapabilityStore, ReadEpochs`:
  - `struct GrantContext { bytes32 requestHash; bytes32 manifestHash; uint64 manifestVersion; bytes32 policyVersionHash; bytes32 namespaceTreeVersionHash; uint256 grantNonce; }`
  - `grantBatch(AccessRequestInput calldata request, GrantScope[] calldata finalScopes, uint64 expiresAt, WebAuthn.WebAuthnAuth calldata auth) external returns (bytes32[] memory capabilityIds)`
  - `grantNonce(address owner) public view returns (uint256)`
  - Errors: `VersionUnsupported()`, `RequestExpired()`, `ManifestStale()`, `CallbackOriginMismatch()`, `ScopesNotCanonical()`, `AuthorityExceedsRequest(bytes32 namespaceId)`, `ExpiryInvalid()`, `HighSensitivityExpiry(bytes32 namespaceId)`
  - Event: `CapabilityGranted(address indexed owner, bytes32 indexed agentId, bytes32 indexed namespaceId, bytes32 capabilityId, uint8 permissions, uint8 provenancePolicy, uint64 expiresAt, GrantContext context)`
- Produces, test base `GrantFixtures is AgentFixtures`: `struct TestOwner { address owner; uint256 p256Key; }`, `START_TIME = 1_750_000_000`, `registry`, `_deployRegistry()`, `_ownerWithKey(string)`, `_ns(string)`, `_scope(string, uint8, uint8)`, `_one`, `_two`, `_sortScopes`, `_epochKey(address, string, uint64)`, `_initEpoch(TestOwner, string)`, `_unsignedRequest(TestAgent, GrantScope[], uint64)`, `_signRequest(TestAgent, AccessRequestInput)`, `_request(TestAgent, GrantScope[], uint64)`, `_grantDigestFor(address, AccessRequestInput, GrantScope[], uint64 expiresAt, uint256 nonce, uint256 chainId, address verifyingRegistry)`, `_assertion(TestOwner, AccessRequestInput, GrantScope[], uint64)`, `_grant(TestOwner, AccessRequestInput, GrantScope[], uint64) returns (bytes32[])`, `_grantExact(TestOwner, TestAgent, GrantScope[], uint64) returns (bytes32[])`, `_expectGrantRevert(TestOwner, AccessRequestInput, GrantScope[], uint64, bytes revertData)`

**Decisions this task makes where the spec is silent** (report disagreement before implementing):
- The contract also requires `request.callbackOriginHash` to equal the agent's registered hash. The spec requires the Vault to check this (§13.2); enforcing it on-chain too cannot broaden authority.
- A capability's validity does not re-check the namespace: namespaces are immutable after deployment, so a granted namespace is always registered.
- Scopes with zero permissions are non-canonical, matching `assertCanonicalScopes` in Part A Task 5.

- [ ] **Step 1: Write the grant fixtures**

`contracts/test/utils/GrantFixtures.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {
    AccessRequestInput,
    GrantDigestInput,
    GrantScope,
    NAMESPACE_TREE_VERSION_HASH,
    POLICY_VERSION_HASH
} from "../../src/MidaTypes.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {CapabilityRegistry} from "../../src/CapabilityRegistry.sol";
import {AgentFixtures} from "./AgentFixtures.sol";
import {WebAuthnSigner} from "./WebAuthnSigner.sol";

/// @notice Owner, request and grant helpers. Requests are signed exactly as the SDK signs them;
///         grant assertions are WebAuthn assertions over grantDigest with the owner's P256 key.
abstract contract GrantFixtures is AgentFixtures {
    struct TestOwner {
        address owner;
        uint256 p256Key;
    }

    uint256 internal constant START_TIME = 1_750_000_000;

    CapabilityRegistry internal registry;

    function _deployRegistry() internal {
        vm.warp(START_TIME);
        registry = new CapabilityRegistry(WebAuthnSigner.VAULT_RP_ID);
    }

    function _ownerWithKey(string memory label) internal returns (TestOwner memory testOwner) {
        testOwner.owner = makeAddr(label);
        testOwner.p256Key = uint256(keccak256(abi.encode(label, "p256"))) % (WebAuthnSigner.P256_N - 1) + 1;
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(testOwner.p256Key);
        vm.prank(testOwner.owner);
        registry.registerP256Key(qx, qy);
    }

    function _ns(string memory name) internal pure returns (bytes32) {
        return MidaHashing.namespaceId(name);
    }

    function _scope(string memory name, uint8 permissions, uint8 provenancePolicy)
        internal
        pure
        returns (GrantScope memory)
    {
        return GrantScope(_ns(name), permissions, provenancePolicy);
    }

    function _one(GrantScope memory a) internal pure returns (GrantScope[] memory scopes) {
        scopes = new GrantScope[](1);
        scopes[0] = a;
    }

    function _two(GrantScope memory a, GrantScope memory b) internal pure returns (GrantScope[] memory scopes) {
        scopes = new GrantScope[](2);
        scopes[0] = a;
        scopes[1] = b;
        _sortScopes(scopes);
    }

    function _sortScopes(GrantScope[] memory scopes) internal pure {
        for (uint256 i = 1; i < scopes.length; i++) {
            GrantScope memory key = scopes[i];
            uint256 j = i;
            while (j > 0 && uint256(scopes[j - 1].namespaceId) > uint256(key.namespaceId)) {
                scopes[j] = scopes[j - 1];
                j--;
            }
            scopes[j] = key;
        }
    }

    function _epochKey(address owner, string memory name, uint64 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, name, epoch));
    }

    function _initEpoch(TestOwner memory testOwner, string memory name) internal {
        vm.prank(testOwner.owner);
        registry.initializeReadEpoch(_ns(name), _epochKey(testOwner.owner, name, 1));
    }

    function _unsignedRequest(TestAgent memory agent, GrantScope[] memory scopes, uint64 capabilityExpiresAt)
        internal
        view
        returns (AccessRequestInput memory request)
    {
        request.requestId = keccak256(abi.encode(agent.agentId, "request", block.timestamp, scopes));
        request.nonce = keccak256(abi.encode(request.requestId, "nonce"));
        request.agentId = agent.agentId;
        request.purposeIdHash = keccak256("career_coaching");
        request.callbackOriginHash = agent.callbackOriginHash;
        request.manifestHash = agent.manifestHash;
        request.manifestVersion = 1;
        request.policyVersionHash = POLICY_VERSION_HASH;
        request.namespaceTreeVersionHash = NAMESPACE_TREE_VERSION_HASH;
        request.issuedAt = uint64(block.timestamp);
        request.requestExpiresAt = uint64(block.timestamp + 300);
        request.capabilityExpiresAt = capabilityExpiresAt;
        request.scopes = scopes;
    }

    function _signRequest(TestAgent memory agent, AccessRequestInput memory request) internal view {
        request.agentSignature =
            _sign(agent.signerKey, MidaHashing.accessRequestDigest(request, block.chainid, address(registry)));
    }

    function _request(TestAgent memory agent, GrantScope[] memory scopes, uint64 capabilityExpiresAt)
        internal
        view
        returns (AccessRequestInput memory request)
    {
        request = _unsignedRequest(agent, scopes, capabilityExpiresAt);
        _signRequest(agent, request);
    }

    /// @dev requestHash is always computed for the real chain and registry; chainId and verifyingRegistry
    ///      only change the outer grant digest, which models an assertion signed for the wrong deployment.
    function _grantDigestFor(
        address owner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt,
        uint256 nonce,
        uint256 chainId,
        address verifyingRegistry
    ) internal view returns (bytes32) {
        return MidaHashing.grantDigest(
            GrantDigestInput({
                chainId: chainId,
                capabilityRegistry: verifyingRegistry,
                owner: owner,
                agentId: request.agentId,
                requestHash: MidaHashing.accessRequestDigest(request, block.chainid, address(registry)),
                manifestHash: request.manifestHash,
                manifestVersion: request.manifestVersion,
                scopesHash: MidaHashing.scopesHash(finalScopes),
                expiresAt: expiresAt,
                grantNonce: nonce
            })
        );
    }

    function _assertion(
        TestOwner memory testOwner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt
    ) internal view returns (WebAuthn.WebAuthnAuth memory) {
        bytes32 digest = _grantDigestFor(
            testOwner.owner,
            request,
            finalScopes,
            expiresAt,
            registry.grantNonce(testOwner.owner),
            block.chainid,
            address(registry)
        );
        return WebAuthnSigner.sign(testOwner.p256Key, digest);
    }

    function _grant(
        TestOwner memory testOwner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt
    ) internal returns (bytes32[] memory capabilityIds) {
        WebAuthn.WebAuthnAuth memory auth = _assertion(testOwner, request, finalScopes, expiresAt);
        vm.prank(testOwner.owner);
        capabilityIds = registry.grantBatch(request, finalScopes, expiresAt, auth);
    }

    function _grantExact(TestOwner memory testOwner, TestAgent memory agent, GrantScope[] memory scopes, uint64 expiresAt)
        internal
        returns (bytes32[] memory)
    {
        return _grant(testOwner, _request(agent, scopes, expiresAt), scopes, expiresAt);
    }

    function _expectGrantRevert(
        TestOwner memory testOwner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt,
        bytes memory revertData
    ) internal {
        WebAuthn.WebAuthnAuth memory auth = _assertion(testOwner, request, finalScopes, expiresAt);
        vm.prank(testOwner.owner);
        vm.expectRevert(revertData);
        registry.grantBatch(request, finalScopes, expiresAt, auth);
    }
}
```

- [ ] **Step 2: Write the failing grant tests**

`contracts/test/Grants.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {
    AccessRequestInput,
    EpochRotationRequired,
    GrantScope,
    InvalidNamespace,
    NAMESPACE_TREE_VERSION_HASH,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    POLICY_VERSION_HASH,
    PROV_ALLOW_INFERENCE
} from "../src/MidaTypes.sol";
import {MidaHashing} from "../src/MidaHashing.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CapabilityStore} from "../src/CapabilityStore.sol";
import {Grants} from "../src/Grants.sol";
import {OwnerKeys} from "../src/OwnerKeys.sol";
import {ReadEpochs} from "../src/ReadEpochs.sol";
import {GrantFixtures} from "./utils/GrantFixtures.sol";
import {WebAuthnSigner} from "./utils/WebAuthnSigner.sol";

/// @notice §10.1 owner keys, §10.4 grant rules 1–13, and §15 Capability rows.
contract GrantsTest is GrantFixtures {
    TestOwner internal alice;
    TestAgent internal careerAgent;

    function setUp() public {
        _deployRegistry();
        alice = _ownerWithKey("alice");
        careerAgent = _register(registry, "career");
        _initEpoch(alice, "goals.career");
    }

    // ---------------------------------------------------------------- owner P256 keys (§10.1)

    /// @dev §15 "live session tries to overwrite registered P256 key".
    function test_registerP256KeyNeverOverwrites() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(OwnerKeys.P256KeyExists.selector, alice.owner));
        registry.registerP256Key(qx, qy);
    }

    function test_rotateP256KeyWithOldKeyAssertion() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        bytes32 digest = MidaHashing.p256RotationDigest(block.chainid, address(registry), alice.owner, qx, qy, 0);
        // Build the assertion before vm.prank: its sha256 precompile calls would consume the prank.
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(alice.p256Key, digest);
        vm.expectEmit(address(registry));
        emit OwnerKeys.P256KeyRegistered(alice.owner, qx, qy, 1);
        vm.prank(alice.owner);
        registry.rotateP256Key(qx, qy, auth);
        (uint256 storedX, uint256 storedY) = registry.ownerP256Key(alice.owner);
        assertEq(storedX, qx);
        assertEq(storedY, qy);
        assertEq(registry.p256RotationNonce(alice.owner), 1);
    }

    /// @dev §15 "P256 rotation lacks old-key assertion".
    function test_rotateP256KeyRequiresOldKey() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        bytes32 digest = MidaHashing.p256RotationDigest(block.chainid, address(registry), alice.owner, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory signedByNewKey = WebAuthnSigner.sign(0xbeef, digest);
        vm.prank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.rotateP256Key(qx, qy, signedByNewKey);
    }

    function test_rotateP256KeyAssertionCannotBeReplayed() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(
            alice.p256Key, MidaHashing.p256RotationDigest(block.chainid, address(registry), alice.owner, qx, qy, 0)
        );
        vm.startPrank(alice.owner);
        registry.rotateP256Key(qx, qy, auth);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.rotateP256Key(qx, qy, auth);
        vm.stopPrank();
    }

    function test_ownerWithoutKeyCannotGrant() public {
        address bob = makeAddr("bob");
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory auth;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OwnerKeys.P256KeyMissing.selector, bob));
        registry.grantBatch(request, scopes, 0, auth);
    }

    // ---------------------------------------------------------------- read epoch 1 (§10.6)

    function test_initializeReadEpochOnce() public {
        bytes32 career = _ns("goals.career");
        assertEq(registry.requiredReadEpoch(alice.owner, career), 1);
        assertEq(registry.epochPublicKey(alice.owner, career, 1), _epochKey(alice.owner, "goals.career", 1));
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 1));
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 2));

        vm.startPrank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(ReadEpochs.EpochAlreadyInitialized.selector, career));
        registry.initializeReadEpoch(career, keccak256("replacement key"));
        vm.expectRevert(ReadEpochs.ZeroEpochKey.selector);
        registry.initializeReadEpoch(_ns("projects.current"), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(InvalidNamespace.selector, _ns("goals.side")));
        registry.initializeReadEpoch(_ns("goals.side"), keccak256("key"));
        vm.stopPrank();

        assertFalse(registry.isWriteEpochValid(alice.owner, _ns("projects.current"), 1), "uninitialized epoch");
    }

    // ---------------------------------------------------------------- successful grants

    function test_grantStoresExactCapabilitiesAndEmits() public {
        _initEpoch(alice, "profile.skills");
        GrantScope[] memory scopes = _two(_scope("goals.career", PERM_READ, 0), _scope("profile.skills", PERM_READ, 0));
        uint64 expiresAt = uint64(block.timestamp + 7 days);
        AccessRequestInput memory request = _request(careerAgent, scopes, expiresAt);
        bytes32 requestHash = MidaHashing.accessRequestDigest(request, block.chainid, address(registry));
        bytes32 firstId = MidaHashing.capabilityId(alice.owner, careerAgent.agentId, 0, 0, scopes[0], expiresAt);

        vm.expectEmit(address(registry));
        emit Grants.CapabilityGranted(
            alice.owner,
            careerAgent.agentId,
            scopes[0].namespaceId,
            firstId,
            PERM_READ,
            0,
            expiresAt,
            Grants.GrantContext(requestHash, careerAgent.manifestHash, 1, POLICY_VERSION_HASH, NAMESPACE_TREE_VERSION_HASH, 0)
        );
        bytes32[] memory ids = _grant(alice, request, scopes, expiresAt);

        assertEq(ids.length, 2);
        assertEq(ids[0], firstId);
        assertEq(ids[1], MidaHashing.capabilityId(alice.owner, careerAgent.agentId, 0, 1, scopes[1], expiresAt));
        CapabilityStore.Capability memory capability = registry.getCapability(ids[1]);
        assertEq(capability.owner, alice.owner);
        assertEq(capability.agentId, careerAgent.agentId);
        assertEq(capability.namespaceId, scopes[1].namespaceId);
        assertEq(capability.permissions, PERM_READ);
        assertEq(capability.issuedAt, block.timestamp);
        assertEq(capability.expiresAt, expiresAt);
        assertEq(capability.agentEpoch, 0);
        assertEq(capability.grantedAtReadEpoch, 1);
        assertFalse(capability.revoked);
        assertTrue(registry.isCapabilityValid(ids[0]));
        assertEq(registry.grantNonce(alice.owner), 1);
    }

    /// @dev §15 "user narrows requested permissions".
    function test_userNarrowingAccepted() public {
        uint64 requestedExpiry = uint64(block.timestamp + 7 days);
        AccessRequestInput memory request = _request(
            careerAgent,
            _one(_scope("goals.career", PERM_READ | PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)),
            requestedExpiry
        );
        uint64 narrowerExpiry = uint64(block.timestamp + 1 days);
        bytes32[] memory ids = _grant(alice, request, _one(_scope("goals.career", PERM_READ, 0)), narrowerExpiry);
        CapabilityStore.Capability memory capability = registry.getCapability(ids[0]);
        assertEq(capability.permissions, PERM_READ);
        assertEq(capability.provenancePolicy, 0);
        assertEq(capability.expiresAt, narrowerExpiry);
    }

    function test_createOnlyGrantNeedsNoEpoch() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32[] memory ids = _grantExact(alice, careerAgent, _one(_scope("projects.current", PERM_CREATE, 0)), expiresAt);
        assertEq(registry.getCapability(ids[0]).grantedAtReadEpoch, 0);
    }

    // ---------------------------------------------------------------- replay and binding

    /// @dev §15 "replay grant assertion".
    function test_replayedGrantAssertionRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        AccessRequestInput memory request = _request(careerAgent, scopes, expiresAt);
        WebAuthn.WebAuthnAuth memory auth = _assertion(alice, request, scopes, expiresAt);
        vm.startPrank(alice.owner);
        registry.grantBatch(request, scopes, expiresAt, auth);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, auth);
        vm.stopPrank();
    }

    /// @dev §15 "wrong request/manifest/policy/tree hash in P256 challenge".
    function test_challengeBindsRequestScopesAndExpiry() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        AccessRequestInput memory request = _request(careerAgent, _one(_scope("goals.career", PERM_READ | PERM_CREATE, 0)), expiresAt);

        WebAuthn.WebAuthnAuth memory wrongExpiry = WebAuthnSigner.sign(
            alice.p256Key, _grantDigestFor(alice.owner, request, scopes, expiresAt - 1, 0, block.chainid, address(registry))
        );
        WebAuthn.WebAuthnAuth memory wrongScopes = WebAuthnSigner.sign(
            alice.p256Key,
            _grantDigestFor(
                alice.owner, request, _one(_scope("goals.career", PERM_READ | PERM_CREATE, 0)), expiresAt, 0, block.chainid, address(registry)
            )
        );
        AccessRequestInput memory otherRequest = _unsignedRequest(careerAgent, scopes, expiresAt);
        otherRequest.requestId = keccak256("a different request");
        WebAuthn.WebAuthnAuth memory wrongRequest = WebAuthnSigner.sign(
            alice.p256Key, _grantDigestFor(alice.owner, otherRequest, scopes, expiresAt, 0, block.chainid, address(registry))
        );

        vm.startPrank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, wrongExpiry);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, wrongScopes);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, wrongRequest);
        vm.stopPrank();
    }

    function test_unsupportedPolicyOrTreeVersionRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _unsignedRequest(careerAgent, scopes, 0);
        request.policyVersionHash = keccak256("mida-grant-policy-v2");
        _signRequest(careerAgent, request);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.VersionUnsupported.selector));

        request = _unsignedRequest(careerAgent, scopes, 0);
        request.namespaceTreeVersionHash = keccak256("mida-namespace-tree-v2");
        _signRequest(careerAgent, request);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.VersionUnsupported.selector));
    }

    /// @dev §15 "manifest updates between request and grant".
    function test_manifestUpdatedAfterRequestRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        bytes32 body = keccak256("manifest v2");
        bytes memory binding = _sign(
            careerAgent.operatorKey,
            MidaHashing.manifestBindingDigest(body, careerAgent.agentId, 2, block.chainid, address(registry))
        );
        vm.prank(careerAgent.operator);
        registry.updateAgentCapabilityManifest(careerAgent.agentId, body, 2, binding);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.ManifestStale.selector));
    }

    /// @dev §15 "grant signed for wrong chain or registry".
    function test_grantBoundToChainAndRegistry() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory otherChain =
            WebAuthnSigner.sign(alice.p256Key, _grantDigestFor(alice.owner, request, scopes, 0, 0, 10143, address(registry)));
        WebAuthn.WebAuthnAuth memory otherRegistry =
            WebAuthnSigner.sign(alice.p256Key, _grantDigestFor(alice.owner, request, scopes, 0, 0, block.chainid, address(0xBEEF)));
        vm.startPrank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, otherChain);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, otherRegistry);
        vm.stopPrank();

        AccessRequestInput memory signedForOtherRegistry = _unsignedRequest(careerAgent, scopes, 0);
        signedForOtherRegistry.agentSignature = _sign(
            careerAgent.signerKey, MidaHashing.accessRequestDigest(signedForOtherRegistry, block.chainid, address(0xBEEF))
        );
        _expectGrantRevert(alice, signedForOtherRegistry, scopes, 0, abi.encodeWithSelector(AgentRegistry.InvalidSignature.selector));
    }

    /// @dev §15 "grant signed without user-verification flag".
    function test_grantWithoutUserVerificationRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            alice.p256Key,
            _grantDigestFor(alice.owner, request, scopes, 0, 0, block.chainid, address(registry)),
            WebAuthnSigner.VAULT_RP_ID,
            WebAuthnSigner.VAULT_ORIGIN,
            WebAuthnSigner.FLAGS_UP_ONLY
        );
        vm.prank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, auth);
    }

    /// @dev §15 "assertion whose authenticatorData[0:32] is not the configured Vault RP-ID hash".
    function test_grantWithForeignRpIdRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            alice.p256Key,
            _grantDigestFor(alice.owner, request, scopes, 0, 0, block.chainid, address(registry)),
            "evil.example",
            WebAuthnSigner.VAULT_ORIGIN,
            WebAuthnSigner.FLAGS_UP_UV
        );
        vm.prank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, auth);
    }

    // ---------------------------------------------------------------- request validity

    function test_requestTimingEnforced() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        bytes memory expired = abi.encodeWithSelector(Grants.RequestExpired.selector);

        AccessRequestInput memory future = _unsignedRequest(careerAgent, scopes, 0);
        future.issuedAt = uint64(block.timestamp + 1);
        _signRequest(careerAgent, future);
        _expectGrantRevert(alice, future, scopes, 0, expired);

        AccessRequestInput memory tooLong = _unsignedRequest(careerAgent, scopes, 0);
        tooLong.requestExpiresAt = tooLong.issuedAt + 601;
        _signRequest(careerAgent, tooLong);
        _expectGrantRevert(alice, tooLong, scopes, 0, expired);

        AccessRequestInput memory stale = _request(careerAgent, scopes, 0);
        vm.warp(stale.requestExpiresAt);
        _expectGrantRevert(alice, stale, scopes, 0, expired);
    }

    function test_requestMustBeSignedByCurrentAgentSigner() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _unsignedRequest(careerAgent, scopes, 0);
        request.agentSignature =
            _sign(careerAgent.operatorKey, MidaHashing.accessRequestDigest(request, block.chainid, address(registry)));
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(AgentRegistry.InvalidSignature.selector));
    }

    function test_callbackOriginMustMatchRegisteredAgent() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _unsignedRequest(careerAgent, scopes, 0);
        request.callbackOriginHash = keccak256("https://evil.example");
        _signRequest(careerAgent, request);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.CallbackOriginMismatch.selector));
    }

    function test_unknownAgentRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        request.agentId = keccak256("nobody");
        WebAuthn.WebAuthnAuth memory auth;
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentNotFound.selector, request.agentId));
        registry.grantBatch(request, scopes, 0, auth);
    }

    // ---------------------------------------------------------------- exact scopes and subset (rules 5, 6)

    function test_scopesMustBeCanonical() public {
        _initEpoch(alice, "profile.skills");
        GrantScope[] memory requested = _two(_scope("goals.career", PERM_READ, 1), _scope("profile.skills", PERM_READ, 1));
        AccessRequestInput memory request = _request(careerAgent, requested, 0);
        bytes memory notCanonical = abi.encodeWithSelector(Grants.ScopesNotCanonical.selector);

        GrantScope[] memory reversed = new GrantScope[](2);
        reversed[0] = requested[1];
        reversed[1] = requested[0];
        _expectGrantRevert(alice, request, reversed, 0, notCanonical);

        GrantScope[] memory duplicated = new GrantScope[](2);
        duplicated[0] = requested[0];
        duplicated[1] = requested[0];
        _expectGrantRevert(alice, request, duplicated, 0, notCanonical);

        _expectGrantRevert(alice, request, new GrantScope[](0), 0, notCanonical);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", 0, 0)), 0, notCanonical);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", 16, 0)), 0, notCanonical);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", PERM_READ, 8)), 0, notCanonical);

        AccessRequestInput memory unknown = _request(careerAgent, _one(_scope("goals.side", PERM_READ, 0)), 0);
        _expectGrantRevert(
            alice, unknown, _one(_scope("goals.side", PERM_READ, 0)), 0, abi.encodeWithSelector(InvalidNamespace.selector, _ns("goals.side"))
        );
    }

    /// @dev §15 "final exact authority exceeds signed request".
    function test_finalAuthorityBeyondRequestRejected() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        AccessRequestInput memory request =
            _request(careerAgent, _one(_scope("goals.career", PERM_READ | PERM_CREATE, PROV_ALLOW_INFERENCE)), expiresAt);
        bytes memory exceeds = abi.encodeWithSelector(Grants.AuthorityExceedsRequest.selector, _ns("goals.career"));

        _expectGrantRevert(alice, request, _one(_scope("goals.career", PERM_READ | PERM_SUPERSEDE_ANY, 0)), expiresAt, exceeds);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", PERM_READ, 3)), expiresAt, exceeds);
        _expectGrantRevert(
            alice,
            request,
            _two(_scope("goals.career", PERM_READ, 0), _scope("projects.current", PERM_CREATE, 0)),
            expiresAt,
            abi.encodeWithSelector(Grants.AuthorityExceedsRequest.selector, _ns("projects.current"))
        );
    }

    function testFuzz_finalAuthorityMustBeSubsetOfRequest(
        uint8 requestedPermissions,
        uint8 finalPermissions,
        uint8 requestedProvenance,
        uint8 finalProvenance
    ) public {
        requestedPermissions = uint8(bound(requestedPermissions, 1, 15));
        finalPermissions = uint8(bound(finalPermissions, 1, 15));
        requestedProvenance = uint8(bound(requestedProvenance, 0, 7));
        finalProvenance = uint8(bound(finalProvenance, 0, 7));
        uint64 expiresAt = uint64(block.timestamp + 1 days);

        AccessRequestInput memory request =
            _request(careerAgent, _one(_scope("goals.career", requestedPermissions, requestedProvenance)), expiresAt);
        GrantScope[] memory finalScopes = _one(_scope("goals.career", finalPermissions, finalProvenance));
        WebAuthn.WebAuthnAuth memory auth = _assertion(alice, request, finalScopes, expiresAt);
        bool subset = finalPermissions & ~requestedPermissions == 0 && finalProvenance & ~requestedProvenance == 0;

        vm.prank(alice.owner);
        if (!subset) {
            vm.expectRevert(abi.encodeWithSelector(Grants.AuthorityExceedsRequest.selector, _ns("goals.career")));
        }
        registry.grantBatch(request, finalScopes, expiresAt, auth);
        if (subset) assertEq(registry.grantNonce(alice.owner), 1);
    }

    // ---------------------------------------------------------------- expiry (rule 7)

    function test_expiryCanOnlyNarrow() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        bytes memory invalid = abi.encodeWithSelector(Grants.ExpiryInvalid.selector);

        AccessRequestInput memory finite = _request(careerAgent, scopes, uint64(block.timestamp + 1 days));
        _expectGrantRevert(alice, finite, scopes, uint64(block.timestamp + 2 days), invalid);
        _expectGrantRevert(alice, finite, scopes, 0, invalid);

        AccessRequestInput memory unbounded = _request(careerAgent, scopes, 0);
        _expectGrantRevert(alice, unbounded, scopes, uint64(block.timestamp), invalid);
        _grant(alice, unbounded, scopes, uint64(block.timestamp + 1 hours));
        _grant(alice, _request(careerAgent, scopes, 0), scopes, 0);
    }

    /// @dev §15 "HIGH final grant exceeds 24 hours or is unbounded".
    function test_highSensitivityRequiresFiniteExpiryWithin24Hours() public {
        _initEpoch(alice, "financial");
        GrantScope[] memory scopes = _one(_scope("financial", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        bytes memory high = abi.encodeWithSelector(Grants.HighSensitivityExpiry.selector, _ns("financial"));
        _expectGrantRevert(alice, request, scopes, 0, high);
        _expectGrantRevert(alice, request, scopes, uint64(block.timestamp + 24 hours + 1), high);
        _grant(alice, request, scopes, uint64(block.timestamp + 24 hours));
    }

    // ---------------------------------------------------------------- epochs at grant time (rules 9, 13)

    function test_readGrantRequiresInitializedWritableEpoch() public {
        GrantScope[] memory uninitialized = _one(_scope("projects.current", PERM_READ, 0));
        _expectGrantRevert(
            alice,
            _request(careerAgent, uninitialized, 0),
            uninitialized,
            0,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("projects.current"), uint64(1))
        );

        GrantScope[] memory career = _one(_scope("goals.career", PERM_READ, 0));
        _grantExact(alice, careerAgent, career, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        _expectGrantRevert(
            alice,
            _request(careerAgent, career, 0),
            career,
            0,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("goals.career"), uint64(1))
        );
    }

    /// @dev §15 "new short-lived reader lowers deadline" and "write at exactly deadline".
    function test_shortLivedReaderLowersWriteDeadline() public {
        bytes32 career = _ns("goals.career");
        GrantScope[] memory read = _one(_scope("goals.career", PERM_READ, 0));
        uint64 inOneDay = uint64(block.timestamp + 1 days);

        _grantExact(alice, careerAgent, read, uint64(block.timestamp + 7 days));
        assertEq(registry.writeDeadline(alice.owner, career), block.timestamp + 7 days);
        _grantExact(alice, careerAgent, read, inOneDay);
        assertEq(registry.writeDeadline(alice.owner, career), inOneDay);
        _grantExact(alice, careerAgent, read, uint64(block.timestamp + 3 days));
        _grantExact(alice, careerAgent, read, 0);
        _grantExact(alice, careerAgent, _one(_scope("goals.career", PERM_CREATE, 0)), uint64(block.timestamp + 1 hours));
        assertEq(registry.writeDeadline(alice.owner, career), inOneDay);

        assertTrue(registry.isWriteEpochValid(alice.owner, career, 1));
        vm.warp(inOneDay - 1);
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 1));
        vm.warp(inOneDay);
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1));
    }

    // ---------------------------------------------------------------- bounded active capabilities (rule 8)

    function test_activeCapabilityLimitPerNamespace() public {
        GrantScope[] memory create = _one(_scope("goals.career", PERM_CREATE, 0));
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        for (uint256 i = 0; i < 32; i++) {
            _grantExact(alice, _register(registry, string.concat("agent-", vm.toString(i))), create, expiresAt);
        }
        TestAgent memory extra = _register(registry, "agent-32");
        _expectGrantRevert(
            alice,
            _request(extra, create, expiresAt),
            create,
            expiresAt,
            abi.encodeWithSelector(CapabilityStore.CapabilityLimit.selector, _ns("goals.career"))
        );

        // Under via-IR a test must not re-read block.timestamp after vm.warp; use absolute values.
        vm.warp(expiresAt);
        _grantExact(alice, extra, create, expiresAt + 1 days);
        assertEq(registry.activeCapabilityIds(alice.owner, extra.agentId).length, 1);
    }

    function test_activeCapabilityLimitPerAgent() public {
        string[22] memory names = [
            "profile", "profile.identity", "profile.skills", "goals", "goals.career", "goals.learning",
            "goals.personal", "preferences", "preferences.communication", "preferences.tools", "preferences.work",
            "projects", "projects.current", "projects.past", "decisions", "decisions.career", "decisions.projects",
            "credentials", "financial", "financial.preferences", "relationships", "private"
        ];
        GrantScope[] memory all = new GrantScope[](22);
        for (uint256 i = 0; i < 22; i++) {
            all[i] = _scope(names[i], PERM_CREATE, 0);
        }
        _sortScopes(all);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);

        _grantExact(alice, careerAgent, all, expiresAt);
        _grantExact(alice, careerAgent, all, expiresAt);
        AccessRequestInput memory third = _request(careerAgent, all, expiresAt);
        WebAuthn.WebAuthnAuth memory auth = _assertion(alice, third, all, expiresAt);
        vm.prank(alice.owner);
        // 44 live entries plus the first 20 scopes of this batch reach 64; the 21st reverts.
        vm.expectRevert(abi.encodeWithSelector(CapabilityStore.CapabilityLimit.selector, all[20].namespaceId));
        registry.grantBatch(third, all, expiresAt, auth);
        assertEq(registry.activeCapabilityIds(alice.owner, careerAgent.agentId).length, 44);
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `forge test --match-contract GrantsTest`
Expected: FAIL at compilation, because `src/Grants.sol` and the other new sources do not exist and `CapabilityRegistry` has no `grantBatch`.

- [ ] **Step 4: Implement the capability store and read epochs**

`contracts/src/CapabilityStore.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MAX_ACTIVE_PER_AGENT, MAX_ACTIVE_PER_NAMESPACE} from "./MidaTypes.sol";

/// @notice Exact capability storage (spec §10.3) with bounded active-capability lists (spec §10.4 rule 8).
abstract contract CapabilityStore {
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

    error CapabilityNotFound(bytes32 capabilityId);
    error CapabilityLimit(bytes32 namespaceId);

    mapping(bytes32 capabilityId => Capability) internal _capabilities;
    mapping(address owner => mapping(bytes32 agentId => uint64)) internal _agentEpoch;
    mapping(address owner => mapping(bytes32 namespaceId => bytes32[])) internal _activeByNamespace;
    mapping(address owner => mapping(bytes32 agentId => bytes32[])) internal _activeByAgent;

    function getCapability(bytes32 capabilityId) external view returns (Capability memory capability) {
        capability = _capabilities[capabilityId];
        if (capability.owner == address(0)) revert CapabilityNotFound(capabilityId);
    }

    function agentEpoch(address owner, bytes32 agentId) external view returns (uint64) {
        return _agentEpoch[owner][agentId];
    }

    /// @notice Valid = exists, not revoked, not expired (block.timestamp < expiresAt when finite),
    ///         and captured agent epoch equals the current owner-agent epoch (spec §10.3).
    function isCapabilityValid(bytes32 capabilityId) public view returns (bool) {
        return _isLive(_capabilities[capabilityId]);
    }

    function activeCapabilityIds(address owner, bytes32 agentId) external view returns (bytes32[] memory) {
        return _activeByAgent[owner][agentId];
    }

    function _isLive(Capability storage capability) internal view returns (bool) {
        return capability.owner != address(0) && !capability.revoked
            && (capability.expiresAt == 0 || block.timestamp < capability.expiresAt)
            && capability.agentEpoch == _agentEpoch[capability.owner][capability.agentId];
    }

    /// @dev Removes revoked, expired and epoch-invalidated entries. Order is not preserved.
    function _compact(bytes32[] storage ids) internal {
        uint256 i;
        while (i < ids.length) {
            if (_isLive(_capabilities[ids[i]])) {
                i++;
            } else {
                ids[i] = ids[ids.length - 1];
                ids.pop();
            }
        }
    }

    function _storeCapability(bytes32 capabilityId, Capability memory capability) internal {
        bytes32[] storage byNamespace = _activeByNamespace[capability.owner][capability.namespaceId];
        bytes32[] storage byAgent = _activeByAgent[capability.owner][capability.agentId];
        _compact(byNamespace);
        _compact(byAgent);
        if (byNamespace.length >= MAX_ACTIVE_PER_NAMESPACE || byAgent.length >= MAX_ACTIVE_PER_AGENT) {
            revert CapabilityLimit(capability.namespaceId);
        }
        _capabilities[capabilityId] = capability;
        byNamespace.push(capabilityId);
        byAgent.push(capabilityId);
    }
}
```

`contracts/src/ReadEpochs.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NamespaceTree} from "./NamespaceTree.sol";

/// @notice Read-epoch generations, their immutable public keys, and write deadlines (spec §7.2, §10.6).
///         Keys live here, not in ContextRegistry, so revocation and key publication share one call.
abstract contract ReadEpochs is NamespaceTree {
    error ZeroEpochKey();
    error EpochAlreadyInitialized(bytes32 namespaceId);

    mapping(address owner => mapping(bytes32 namespaceId => uint64)) private _currentEpoch;
    mapping(address owner => mapping(bytes32 namespaceId => mapping(uint64 epoch => bytes32))) private _epochKeys;
    mapping(address owner => mapping(bytes32 namespaceId => uint64)) internal _writeDeadline;

    event ReadEpochRequired(address indexed owner, bytes32 indexed namespaceId, uint64 readEpoch, uint64 writeDeadline);
    event NamespaceEpochKeySet(
        address indexed owner, bytes32 indexed namespaceId, uint64 indexed readEpoch, bytes32 publicKey
    );

    /// @notice Publishes epoch 1 for msg.sender. Published keys are never replaced.
    function initializeReadEpoch(bytes32 namespaceId, bytes32 publicKey) external {
        _requireNamespace(namespaceId);
        if (publicKey == bytes32(0)) revert ZeroEpochKey();
        if (_epochKeys[msg.sender][namespaceId][1] != bytes32(0)) revert EpochAlreadyInitialized(namespaceId);
        _epochKeys[msg.sender][namespaceId][1] = publicKey;
        emit NamespaceEpochKeySet(msg.sender, namespaceId, 1, publicKey);
    }

    /// @notice Defaults to 1 when no epoch has been advanced (spec §10.6).
    function requiredReadEpoch(address owner, bytes32 namespaceId) public view returns (uint64) {
        uint64 epoch = _currentEpoch[owner][namespaceId];
        return epoch == 0 ? 1 : epoch;
    }

    function epochPublicKey(address owner, bytes32 namespaceId, uint64 epoch) public view returns (bytes32) {
        return _epochKeys[owner][namespaceId][epoch];
    }

    function writeDeadline(address owner, bytes32 namespaceId) external view returns (uint64) {
        return _writeDeadline[owner][namespaceId];
    }

    /// @notice Frozen invariant (spec §7.2): writes only while the deadline is strictly in the future.
    function isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) public view returns (bool) {
        uint64 deadline = _writeDeadline[owner][namespaceId];
        return epoch == requiredReadEpoch(owner, namespaceId) && _epochKeys[owner][namespaceId][epoch] != bytes32(0)
            && (deadline == 0 || block.timestamp < deadline);
    }

    function _lowerWriteDeadline(address owner, bytes32 namespaceId, uint64 expiresAt) internal {
        if (expiresAt == 0) return;
        uint64 current = _writeDeadline[owner][namespaceId];
        if (current == 0 || expiresAt < current) _writeDeadline[owner][namespaceId] = expiresAt;
    }

    /// @dev Advances to the next epoch, stores its key and the recomputed deadline. Used by Task 18.
    function _publishNextEpoch(address owner, bytes32 namespaceId, bytes32 publicKey, uint64 newDeadline)
        internal
        returns (uint64 next)
    {
        if (publicKey == bytes32(0)) revert ZeroEpochKey();
        next = requiredReadEpoch(owner, namespaceId) + 1;
        _currentEpoch[owner][namespaceId] = next;
        _epochKeys[owner][namespaceId][next] = publicKey;
        _writeDeadline[owner][namespaceId] = newDeadline;
        emit ReadEpochRequired(owner, namespaceId, next, newDeadline);
        emit NamespaceEpochKeySet(owner, namespaceId, next, publicKey);
    }
}
```

- [ ] **Step 5: Implement owner keys, grants and the registry composition**

`contracts/src/OwnerKeys.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {MidaWebAuthn} from "./MidaWebAuthn.sol";

/// @notice Owner P256 passkey keys (spec §10.1). Registration never overwrites; rotation needs an
///         assertion from the currently registered key over MIDA_ROTATE_P256_V1 with a contract nonce.
abstract contract OwnerKeys is MidaWebAuthn {
    struct P256Key {
        uint256 qx;
        uint256 qy;
    }

    error ZeroP256Key();
    error P256KeyExists(address owner);
    error P256KeyMissing(address owner);
    error WebAuthnInvalid();

    mapping(address owner => P256Key) private _ownerKeys;
    mapping(address owner => uint256) public p256RotationNonce;

    event P256KeyRegistered(address indexed owner, uint256 qx, uint256 qy, uint256 rotationNonce);

    function registerP256Key(uint256 qx, uint256 qy) external {
        if (qx == 0 || qy == 0) revert ZeroP256Key();
        if (_ownerKeys[msg.sender].qx != 0) revert P256KeyExists(msg.sender);
        _ownerKeys[msg.sender] = P256Key(qx, qy);
        emit P256KeyRegistered(msg.sender, qx, qy, 0);
    }

    function rotateP256Key(uint256 newQx, uint256 newQy, WebAuthn.WebAuthnAuth calldata auth) external {
        P256Key memory current = _requireOwnerKey(msg.sender);
        if (newQx == 0 || newQy == 0) revert ZeroP256Key();
        uint256 nonce = p256RotationNonce[msg.sender];
        bytes32 digest = MidaHashing.p256RotationDigest(block.chainid, address(this), msg.sender, newQx, newQy, nonce);
        if (!_verifyVaultAssertion(digest, auth, current.qx, current.qy)) revert WebAuthnInvalid();
        p256RotationNonce[msg.sender] = nonce + 1;
        _ownerKeys[msg.sender] = P256Key(newQx, newQy);
        emit P256KeyRegistered(msg.sender, newQx, newQy, nonce + 1);
    }

    function ownerP256Key(address owner) external view returns (uint256 qx, uint256 qy) {
        P256Key memory key = _ownerKeys[owner];
        return (key.qx, key.qy);
    }

    function _requireOwnerKey(address owner) internal view returns (P256Key memory key) {
        key = _ownerKeys[owner];
        if (key.qx == 0) revert P256KeyMissing(owner);
    }
}
```

`contracts/src/Grants.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {
    AccessRequestInput,
    EpochRotationRequired,
    GrantDigestInput,
    GrantScope,
    HIGH_MAX_DURATION,
    InvalidNamespace,
    KNOWN_PERMISSION_BITS,
    KNOWN_PROVENANCE_BITS,
    MAX_REQUEST_WINDOW,
    NAMESPACE_TREE_VERSION_HASH,
    PERM_READ,
    POLICY_VERSION_HASH
} from "./MidaTypes.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {CapabilityStore} from "./CapabilityStore.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {NamespaceTree} from "./NamespaceTree.sol";
import {OwnerKeys} from "./OwnerKeys.sol";
import {ReadEpochs} from "./ReadEpochs.sol";
import {SignatureRecovery} from "./SignatureRecovery.sol";

/// @notice grantBatch (spec §10.4): the agent-signed request bounds authority, the owner's passkey
///         assertion binds the final exact authority, and a contract nonce prevents replay.
abstract contract Grants is NamespaceTree, AgentRegistry, OwnerKeys, CapabilityStore, ReadEpochs {
    struct GrantContext {
        bytes32 requestHash;
        bytes32 manifestHash;
        uint64 manifestVersion;
        bytes32 policyVersionHash;
        bytes32 namespaceTreeVersionHash;
        uint256 grantNonce;
    }

    error VersionUnsupported();
    error RequestExpired();
    error ManifestStale();
    error CallbackOriginMismatch();
    error ScopesNotCanonical();
    error AuthorityExceedsRequest(bytes32 namespaceId);
    error ExpiryInvalid();
    error HighSensitivityExpiry(bytes32 namespaceId);

    mapping(address owner => uint256) public grantNonce;

    event CapabilityGranted(
        address indexed owner,
        bytes32 indexed agentId,
        bytes32 indexed namespaceId,
        bytes32 capabilityId,
        uint8 permissions,
        uint8 provenancePolicy,
        uint64 expiresAt,
        GrantContext context
    );

    function grantBatch(
        AccessRequestInput calldata request,
        GrantScope[] calldata finalScopes,
        uint64 expiresAt,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (bytes32[] memory capabilityIds) {
        P256Key memory ownerKey = _requireOwnerKey(msg.sender);
        bytes32 requestHash = _verifyRequest(request);
        _requireCanonical(finalScopes);
        _requireSubset(request.scopes, finalScopes);
        _requireExpiry(request.capabilityExpiresAt, finalScopes, expiresAt);

        uint256 nonce = grantNonce[msg.sender];
        bytes32 digest = MidaHashing.grantDigest(
            GrantDigestInput({
                chainId: block.chainid,
                capabilityRegistry: address(this),
                owner: msg.sender,
                agentId: request.agentId,
                requestHash: requestHash,
                manifestHash: request.manifestHash,
                manifestVersion: request.manifestVersion,
                scopesHash: MidaHashing.scopesHash(finalScopes),
                expiresAt: expiresAt,
                grantNonce: nonce
            })
        );
        if (!_verifyVaultAssertion(digest, auth, ownerKey.qx, ownerKey.qy)) revert WebAuthnInvalid();
        grantNonce[msg.sender] = nonce + 1;

        GrantContext memory context = GrantContext({
            requestHash: requestHash,
            manifestHash: request.manifestHash,
            manifestVersion: request.manifestVersion,
            policyVersionHash: POLICY_VERSION_HASH,
            namespaceTreeVersionHash: NAMESPACE_TREE_VERSION_HASH,
            grantNonce: nonce
        });
        capabilityIds = new bytes32[](finalScopes.length);
        for (uint256 i = 0; i < finalScopes.length; i++) {
            capabilityIds[i] = _grantOne(request.agentId, finalScopes[i], i, expiresAt, context);
        }
    }

    function _verifyRequest(AccessRequestInput calldata request) private view returns (bytes32 requestHash) {
        if (
            request.policyVersionHash != POLICY_VERSION_HASH
                || request.namespaceTreeVersionHash != NAMESPACE_TREE_VERSION_HASH
        ) revert VersionUnsupported();
        if (
            request.issuedAt > block.timestamp || block.timestamp >= request.requestExpiresAt
                || request.requestExpiresAt - request.issuedAt > MAX_REQUEST_WINDOW
        ) revert RequestExpired();

        AgentRecord storage agent = _activeAgent(request.agentId);
        if (
            request.manifestHash != agent.capabilityManifestHash
                || request.manifestVersion != agent.capabilityManifestVersion
        ) revert ManifestStale();
        if (request.callbackOriginHash != agent.callbackOriginHash) revert CallbackOriginMismatch();
        _requireCanonical(request.scopes);

        requestHash = MidaHashing.accessRequestDigest(request, block.chainid, address(this));
        if (SignatureRecovery.recover(requestHash, request.agentSignature) != agent.signer) revert InvalidSignature();
    }

    /// @dev Non-empty, strictly ascending by namespaceId, registered, non-zero known permission bits,
    ///      known provenance bits. Mirrors assertCanonicalScopes() in the TypeScript protocol package.
    function _requireCanonical(GrantScope[] calldata scopes) private view {
        if (scopes.length == 0) revert ScopesNotCanonical();
        for (uint256 i = 0; i < scopes.length; i++) {
            GrantScope calldata scope = scopes[i];
            if (!isRegisteredNamespace(scope.namespaceId)) revert InvalidNamespace(scope.namespaceId);
            if (i > 0 && uint256(scope.namespaceId) <= uint256(scopes[i - 1].namespaceId)) revert ScopesNotCanonical();
            if (scope.permissions == 0 || scope.permissions & ~KNOWN_PERMISSION_BITS != 0) revert ScopesNotCanonical();
            if (scope.provenancePolicy & ~KNOWN_PROVENANCE_BITS != 0) revert ScopesNotCanonical();
        }
    }

    /// @dev Both lists are canonical, so one forward pass proves every final bit was requested.
    function _requireSubset(GrantScope[] calldata requested, GrantScope[] calldata finalScopes) private pure {
        uint256 j;
        for (uint256 i = 0; i < finalScopes.length; i++) {
            GrantScope calldata granted = finalScopes[i];
            while (j < requested.length && uint256(requested[j].namespaceId) < uint256(granted.namespaceId)) j++;
            if (j == requested.length || requested[j].namespaceId != granted.namespaceId) {
                revert AuthorityExceedsRequest(granted.namespaceId);
            }
            if (
                granted.permissions & ~requested[j].permissions != 0
                    || granted.provenancePolicy & ~requested[j].provenancePolicy != 0
            ) revert AuthorityExceedsRequest(granted.namespaceId);
        }
    }

    function _requireExpiry(uint64 requestedExpiry, GrantScope[] calldata finalScopes, uint64 expiresAt) private view {
        if (requestedExpiry != 0 && (expiresAt == 0 || expiresAt > requestedExpiry)) revert ExpiryInvalid();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInvalid();
        for (uint256 i = 0; i < finalScopes.length; i++) {
            if (!isHighSensitivity(finalScopes[i].namespaceId)) continue;
            if (expiresAt == 0 || expiresAt > block.timestamp + HIGH_MAX_DURATION) {
                revert HighSensitivityExpiry(finalScopes[i].namespaceId);
            }
        }
    }

    function _grantOne(bytes32 agentId, GrantScope calldata scope, uint256 index, uint64 expiresAt, GrantContext memory context)
        private
        returns (bytes32 capabilityId)
    {
        capabilityId = MidaHashing.capabilityId(msg.sender, agentId, context.grantNonce, index, scope, expiresAt);
        uint64 grantedAtReadEpoch;
        if (scope.permissions & PERM_READ != 0) {
            grantedAtReadEpoch = requiredReadEpoch(msg.sender, scope.namespaceId);
            if (!isWriteEpochValid(msg.sender, scope.namespaceId, grantedAtReadEpoch)) {
                revert EpochRotationRequired(scope.namespaceId, grantedAtReadEpoch);
            }
            _lowerWriteDeadline(msg.sender, scope.namespaceId, expiresAt);
        }
        _storeCapability(
            capabilityId,
            Capability({
                owner: msg.sender,
                agentId: agentId,
                namespaceId: scope.namespaceId,
                permissions: scope.permissions,
                provenancePolicy: scope.provenancePolicy,
                issuedAt: uint64(block.timestamp),
                expiresAt: expiresAt,
                agentEpoch: _agentEpoch[msg.sender][agentId],
                grantedAtReadEpoch: grantedAtReadEpoch,
                revoked: false
            })
        );
        emit CapabilityGranted(
            msg.sender, agentId, scope.namespaceId, capabilityId, scope.permissions, scope.provenancePolicy, expiresAt, context
        );
    }
}
```

Replace `contracts/src/CapabilityRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Grants} from "./Grants.sol";
import {MidaWebAuthn} from "./MidaWebAuthn.sol";

/// @notice Canonical authority for Mida Context (spec §10). Task 17 stage: owner keys and grants.
contract CapabilityRegistry is Grants {
    constructor(string memory vaultRpId) MidaWebAuthn(vaultRpId) {}
}
```

- [ ] **Step 6: Run to verify it passes**

Run:
```bash
forge test --match-contract GrantsTest
forge test
forge build --sizes | grep CapabilityRegistry
```
Expected: `GrantsTest` `29 passed` (the fuzz test runs 256 cases). Full suite `81 passed, 0 failed, 1 skipped`. `CapabilityRegistry` runtime size is about 17,600 bytes, under the 24,576-byte local limit.

- [ ] **Step 7: Commit**

```bash
cd ..
git add contracts/src contracts/test/utils/GrantFixtures.sol contracts/test/Grants.t.sol
git commit -m "feat(contracts): owner passkey keys, read epoch 1 and passkey-approved grantBatch

Request/final subset, expiry narrowing, HIGH 24h cap, replay nonce and bounded active capabilities.

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 18: `CapabilityRegistry`: read epochs, revocation with rotation, expiry, `isAuthorized`

**Depends on:** Task 17, and Task 14 Step 8 (the generated `PolicyHashV1.sol`). If Task 14 Step 8 is not done, do it first; this task's registry imports the generated constant.

**Files:**
- Create: `contracts/src/Revocations.sol`
- Modify: `contracts/src/CapabilityRegistry.sol` (final composition)
- Test: `contracts/test/Revocations.t.sol`

**Interfaces:**
- Consumes: `Grants`, `CapabilityStore._capabilities`, `_agentEpoch`, `_activeByAgent`, `_activeByNamespace`, `_isLive`, `_compact`, `CapabilityNotFound`; `ReadEpochs._writeDeadline`, `_publishNextEpoch`, `ZeroEpochKey`; `NamespaceTree.isRegisteredNamespace`; generated `MIDA_POLICY_DOCUMENT_HASH_V1`.
- Produces, `abstract contract Revocations is Grants`:
  - `struct EpochRotation { bytes32 namespaceId; bytes32 newEpochPublicKey; }` (spec §10.6)
  - `revoke(bytes32 capabilityId) external` — rejects a live READ capability
  - `revokeAndRotate(bytes32 capabilityId, bytes32 newEpochPublicKey) external` — requires a live READ capability
  - `revokeAgentAndRotate(bytes32 agentId, EpochRotation[] calldata rotations) external` — rotations must equal the set of unique namespaces with live READ, once each
  - `rotateExpiredEpoch(bytes32 namespaceId, bytes32 newEpochPublicKey) external` — requires `writeDeadline != 0 && block.timestamp >= writeDeadline`
  - `isAuthorized(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permission) external view returns (bool)` (spec §10.5)
  - `hasAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permissions, uint8 provenanceBits) public view returns (bool)` — one live exact capability must carry every requested bit; `permissions == 0` always returns false
  - Errors: `NotCapabilityOwner(bytes32)`, `CapabilityAlreadyRevoked(bytes32)`, `ReadRequiresRotation(bytes32)`, `RotationNotApplicable(bytes32)`, `RotationSetMismatch()`, `EpochNotExpired(bytes32)`
  - Events: `CapabilityRevoked(address indexed owner, bytes32 indexed agentId, bytes32 indexed namespaceId, bytes32 capabilityId)`, `AgentRevoked(address indexed owner, bytes32 indexed agentId, uint64 agentEpoch)`
- Produces, final `contract CapabilityRegistry is Revocations`: `constructor(string memory vaultRpId)`; `POLICY_HASH_V1() external view returns (bytes32)`

**Decisions this task makes where the spec is silent** (report disagreement before implementing):
- An expired or agent-epoch-invalidated READ capability is no longer live, so `revoke` accepts it without rotation. Its READ authority already ended; the epoch deadline or the agent revocation already forced rotation.
- `revokeAgentAndRotate` also clears the agent's active-capability list, and it accepts an unknown `agentId` with an empty rotation list. That changes nothing but the owner-agent epoch.
- `isAuthorized` does not check that `agentId` is a registered agent. Capabilities can only be granted to registered agents, and agents cannot be deleted.

- [ ] **Step 1: Write the failing tests**

`contracts/test/Revocations.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    GrantScope,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_INFERENCE
} from "../src/MidaTypes.sol";
import {CapabilityStore} from "../src/CapabilityStore.sol";
import {ReadEpochs} from "../src/ReadEpochs.sol";
import {Revocations} from "../src/Revocations.sol";
import {GrantFixtures} from "./utils/GrantFixtures.sol";

/// @notice §10.5 exact authorization, §10.6 revocation with rotation, §7.3 expiry, and §15 CREATE, READ,
///         Revocation, Expiry and Epoch rows.
contract RevocationsTest is GrantFixtures {
    TestOwner internal alice;
    TestAgent internal readerA;
    TestAgent internal readerD;
    TestAgent internal creatorC;
    bytes32 internal career;
    bytes32 internal capA;
    bytes32 internal capD;
    bytes32 internal capC;

    function setUp() public {
        _deployRegistry();
        alice = _ownerWithKey("alice");
        readerA = _register(registry, "agent-a");
        readerD = _register(registry, "agent-d");
        creatorC = _register(registry, "agent-c");
        career = _ns("goals.career");
        _initEpoch(alice, "goals.career");
        capA = _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        capD = _grantExact(alice, readerD, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        capC = _grantExact(alice, creatorC, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0)[0];
    }

    function _rotation(string memory name, uint64 epoch) internal view returns (Revocations.EpochRotation memory) {
        return Revocations.EpochRotation(_ns(name), _epochKey(alice.owner, name, epoch));
    }

    // ---------------------------------------------------------------- exact authorization (§10.5)

    /// @dev §15 "CREATE-only agent reads existing object": capability denied.
    function test_isAuthorizedIsExact() public view {
        assertTrue(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_READ));
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_CREATE));
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, _ns("goals"), PERM_READ), "parent not implied");
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, _ns("goals.learning"), PERM_READ), "sibling");
        assertTrue(registry.isAuthorized(alice.owner, creatorC.agentId, career, PERM_CREATE));
        assertFalse(registry.isAuthorized(alice.owner, creatorC.agentId, career, PERM_READ), "CREATE does not imply READ");
        assertFalse(registry.isAuthorized(address(0xB0B), readerA.agentId, career, PERM_READ), "other owner");
        assertFalse(registry.isAuthorized(alice.owner, keccak256("agent-b"), career, PERM_READ), "no grant");
        assertFalse(registry.isAuthorized(alice.owner, _ns("goals.side"), career, PERM_READ), "unknown agent id");
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, _ns("goals.side"), PERM_READ), "unknown namespace");
    }

    function test_zeroPermissionNeverAuthorizes() public view {
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, career, 0));
        assertFalse(registry.hasAuthority(alice.owner, creatorC.agentId, career, 0, 0));
    }

    function test_hasAuthorityRequiresBitsInOneCapability() public {
        TestAgent memory split = _register(registry, "agent-split");
        _grantExact(alice, split, _one(_scope("goals.career", PERM_CREATE, 0)), 0);
        _grantExact(alice, split, _one(_scope("goals.career", PERM_READ, PROV_ALLOW_INFERENCE)), 0);
        assertTrue(registry.hasAuthority(alice.owner, split.agentId, career, PERM_CREATE, 0));
        assertTrue(registry.hasAuthority(alice.owner, split.agentId, career, PERM_READ, PROV_ALLOW_INFERENCE));
        assertFalse(registry.hasAuthority(alice.owner, split.agentId, career, PERM_CREATE, PROV_ALLOW_INFERENCE));
        assertFalse(registry.hasAuthority(alice.owner, split.agentId, career, PERM_CREATE | PERM_READ, 0));
        assertTrue(registry.hasAuthority(alice.owner, creatorC.agentId, career, PERM_CREATE, PROV_ALLOW_INFERENCE));
    }

    // ---------------------------------------------------------------- revoke without rotation

    function test_revokeRejectsLiveReadCapability() public {
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.ReadRequiresRotation.selector, capA));
        registry.revoke(capA);
    }

    function test_revokeCreateOnlyCapability() public {
        vm.expectEmit(address(registry));
        emit Revocations.CapabilityRevoked(alice.owner, creatorC.agentId, career, capC);
        vm.prank(alice.owner);
        registry.revoke(capC);
        assertFalse(registry.isAuthorized(alice.owner, creatorC.agentId, career, PERM_CREATE));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 1, "CREATE revocation needs no rotation");

        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.CapabilityAlreadyRevoked.selector, capC));
        registry.revoke(capC);
    }

    function test_onlyCapabilityOwnerCanRevoke() public {
        address bob = makeAddr("bob");
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(Revocations.NotCapabilityOwner.selector, capC));
        registry.revoke(capC);
        vm.expectRevert(abi.encodeWithSelector(Revocations.NotCapabilityOwner.selector, capA));
        registry.revokeAndRotate(capA, keccak256("key"));
        vm.expectRevert(abi.encodeWithSelector(CapabilityStore.CapabilityNotFound.selector, bytes32(uint256(1))));
        registry.revoke(bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- revokeAndRotate

    /// @dev §15 "revoke one reader", "write in old epoch after revoke", "remaining reader crosses an epoch rotation".
    function test_revokeAndRotateEndsReadAndAdvancesEpoch() public {
        bytes32 epoch2Key = _epochKey(alice.owner, "goals.career", 2);
        vm.expectEmit(address(registry));
        emit Revocations.CapabilityRevoked(alice.owner, readerA.agentId, career, capA);
        vm.expectEmit(address(registry));
        emit ReadEpochs.ReadEpochRequired(alice.owner, career, 2, 0);
        vm.expectEmit(address(registry));
        emit ReadEpochs.NamespaceEpochKeySet(alice.owner, career, 2, epoch2Key);
        vm.prank(alice.owner);
        registry.revokeAndRotate(capA, epoch2Key);

        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_READ));
        assertTrue(registry.isAuthorized(alice.owner, readerD.agentId, career, PERM_READ), "remaining reader");
        assertEq(registry.getCapability(capD).grantedAtReadEpoch, 1, "remaining reader keeps its capability");
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        assertEq(registry.epochPublicKey(alice.owner, career, 1), _epochKey(alice.owner, "goals.career", 1), "history kept");
        assertEq(registry.epochPublicKey(alice.owner, career, 2), epoch2Key);
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1), "old epoch closed");
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 2));
    }

    function test_revokeAndRotateRejectsNonReadRevokedAndZeroKey() public {
        vm.startPrank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.RotationNotApplicable.selector, capC));
        registry.revokeAndRotate(capC, keccak256("key"));
        vm.expectRevert(ReadEpochs.ZeroEpochKey.selector);
        registry.revokeAndRotate(capA, bytes32(0));
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 2));
        vm.expectRevert(abi.encodeWithSelector(Revocations.CapabilityAlreadyRevoked.selector, capA));
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 3));
        vm.stopPrank();
    }

    function test_rotationRecomputesDeadlineFromRemainingReaders() public {
        TestAgent memory shortReader = _register(registry, "agent-short");
        TestAgent memory longReader = _register(registry, "agent-long");
        uint64 inOneDay = uint64(block.timestamp + 1 days);
        uint64 inTwoDays = uint64(block.timestamp + 2 days);
        bytes32 shortCap = _grantExact(alice, shortReader, _one(_scope("goals.career", PERM_READ, 0)), inOneDay)[0];
        _grantExact(alice, longReader, _one(_scope("goals.career", PERM_READ, 0)), inTwoDays);
        assertEq(registry.writeDeadline(alice.owner, career), inOneDay);

        vm.prank(alice.owner);
        registry.revokeAndRotate(shortCap, _epochKey(alice.owner, "goals.career", 2));
        assertEq(registry.writeDeadline(alice.owner, career), inTwoDays);
    }

    // ---------------------------------------------------------------- agent-wide revocation

    /// @dev §15 "agent-wide revocation": every old capability epoch fails.
    function test_revokeAgentAndRotateInvalidatesEveryCapability() public {
        _initEpoch(alice, "profile.skills");
        bytes32 skillsCap = _grantExact(alice, readerA, _one(_scope("profile.skills", PERM_READ, 0)), 0)[0];
        bytes32 createCap = _grantExact(alice, readerA, _one(_scope("projects.current", PERM_CREATE, 0)), 0)[0];
        Revocations.EpochRotation[] memory rotations = new Revocations.EpochRotation[](2);
        rotations[0] = _rotation("profile.skills", 2);
        rotations[1] = _rotation("goals.career", 2);

        vm.expectEmit(address(registry));
        emit Revocations.AgentRevoked(alice.owner, readerA.agentId, 1);
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(readerA.agentId, rotations);

        assertFalse(registry.isCapabilityValid(capA));
        assertFalse(registry.isCapabilityValid(skillsCap));
        assertFalse(registry.isCapabilityValid(createCap));
        assertFalse(registry.getCapability(capA).revoked, "invalidated by agent epoch, not by flag");
        assertEq(registry.agentEpoch(alice.owner, readerA.agentId), 1);
        assertEq(registry.activeCapabilityIds(alice.owner, readerA.agentId).length, 0);
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        assertEq(registry.requiredReadEpoch(alice.owner, _ns("profile.skills")), 2);
        assertEq(registry.requiredReadEpoch(alice.owner, _ns("projects.current")), 1, "CREATE-only namespace untouched");
        assertTrue(registry.isAuthorized(alice.owner, readerD.agentId, career, PERM_READ));

        bytes32 regranted = _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        assertEq(registry.getCapability(regranted).agentEpoch, 1);
        assertTrue(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_READ));
    }

    function test_revokeAgentAndRotateRequiresExactRotationSet() public {
        _initEpoch(alice, "profile.skills");
        _grantExact(alice, readerA, _one(_scope("profile.skills", PERM_READ, 0)), 0);
        bytes memory mismatch = abi.encodeWithSelector(Revocations.RotationSetMismatch.selector);

        Revocations.EpochRotation[] memory missing = new Revocations.EpochRotation[](1);
        missing[0] = _rotation("goals.career", 2);
        Revocations.EpochRotation[] memory duplicate = new Revocations.EpochRotation[](2);
        duplicate[0] = _rotation("goals.career", 2);
        duplicate[1] = _rotation("goals.career", 2);
        Revocations.EpochRotation[] memory wrong = new Revocations.EpochRotation[](2);
        wrong[0] = _rotation("goals.career", 2);
        wrong[1] = _rotation("projects.current", 2);
        Revocations.EpochRotation[] memory extra = new Revocations.EpochRotation[](3);
        extra[0] = _rotation("goals.career", 2);
        extra[1] = _rotation("profile.skills", 2);
        extra[2] = _rotation("projects.current", 2);

        vm.startPrank(alice.owner);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, missing);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, duplicate);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, wrong);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, extra);
        vm.stopPrank();

        assertTrue(registry.isCapabilityValid(capA), "every failed attempt rolled back");
        assertEq(registry.agentEpoch(alice.owner, readerA.agentId), 0);
    }

    function test_twoReadCapabilitiesOnOneNamespaceRotateOnce() public {
        _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ | PERM_SUPERSEDE_OWN, 0)), 0);
        Revocations.EpochRotation[] memory rotations = new Revocations.EpochRotation[](1);
        rotations[0] = _rotation("goals.career", 2);
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(readerA.agentId, rotations);
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
    }

    function test_revokeAgentWithoutReadNeedsNoRotations() public {
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(creatorC.agentId, new Revocations.EpochRotation[](0));
        assertFalse(registry.isCapabilityValid(capC));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 1);
    }

    // ---------------------------------------------------------------- expiry (§7.3)

    /// @dev §15 Expiry rows: authorization fails at expiry, writes fail at and after the deadline,
    ///      owner rotation resumes writes in the next epoch.
    function test_expiryEndsAuthorityAndRotationResumesWrites() public {
        TestAgent memory temporary = _register(registry, "agent-temp");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 tempCap = _grantExact(alice, temporary, _one(_scope("goals.career", PERM_READ, 0)), deadline)[0];

        vm.warp(deadline - 1);
        assertTrue(registry.isAuthorized(alice.owner, temporary.agentId, career, PERM_READ));
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.EpochNotExpired.selector, career));
        registry.rotateExpiredEpoch(career, _epochKey(alice.owner, "goals.career", 2));

        vm.warp(deadline);
        assertFalse(registry.isAuthorized(alice.owner, temporary.agentId, career, PERM_READ), "expired at expiresAt");
        assertFalse(registry.isCapabilityValid(tempCap));
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1), "write at exactly deadline");
        vm.warp(deadline + 1);
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1), "write after deadline");
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.RotationNotApplicable.selector, tempCap));
        registry.revokeAndRotate(tempCap, _epochKey(alice.owner, "goals.career", 2));

        vm.prank(alice.owner);
        registry.rotateExpiredEpoch(career, _epochKey(alice.owner, "goals.career", 2));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        assertEq(registry.writeDeadline(alice.owner, career), 0, "remaining readers are unbounded");
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 2));
        assertTrue(registry.isAuthorized(alice.owner, readerD.agentId, career, PERM_READ));
    }

    function test_rotateExpiredEpochRequiresADeadline() public {
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.EpochNotExpired.selector, career));
        registry.rotateExpiredEpoch(career, _epochKey(alice.owner, "goals.career", 2));
    }

    function test_expiredReadCapabilityCanBeRevokedWithoutRotation() public {
        TestAgent memory temporary = _register(registry, "agent-temp");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 tempCap = _grantExact(alice, temporary, _one(_scope("goals.career", PERM_READ, 0)), deadline)[0];
        vm.warp(deadline);
        vm.prank(alice.owner);
        registry.revoke(tempCap);
        assertTrue(registry.getCapability(tempCap).revoked);
    }

    function test_policyHashConstantMatchesExport() public view {
        string memory policy = vm.readFile("test/vectors/policy-v1.json");
        assertEq(registry.POLICY_HASH_V1(), vm.parseJsonBytes32(policy, ".policyHash"));
    }
}
```

Note: `test_isAuthorizedIsExact` is a `view` test, so it uses `address(0xB0B)` rather than `makeAddr`, which writes a label and cannot be called from a view function.

- [ ] **Step 2: Run to verify it fails**

Run: `forge test --match-contract RevocationsTest`
Expected: FAIL at compilation, because `src/Revocations.sol` does not exist.

- [ ] **Step 3: Implement revocation and the final registry**

`contracts/src/Revocations.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PERM_READ} from "./MidaTypes.sol";
import {Grants} from "./Grants.sol";

/// @notice Ending authority (spec §7.3, §10.5, §10.6). Any path that ends live READ authority advances the
///         namespace read epoch and publishes the next public key in the same call, so one owner EOA
///         transaction is enough and no cross-contract call changes msg.sender.
abstract contract Revocations is Grants {
    struct EpochRotation {
        bytes32 namespaceId;
        bytes32 newEpochPublicKey;
    }

    error NotCapabilityOwner(bytes32 capabilityId);
    error CapabilityAlreadyRevoked(bytes32 capabilityId);
    error ReadRequiresRotation(bytes32 capabilityId);
    error RotationNotApplicable(bytes32 capabilityId);
    error RotationSetMismatch();
    error EpochNotExpired(bytes32 namespaceId);

    event CapabilityRevoked(
        address indexed owner, bytes32 indexed agentId, bytes32 indexed namespaceId, bytes32 capabilityId
    );
    event AgentRevoked(address indexed owner, bytes32 indexed agentId, uint64 agentEpoch);

    /// @notice Revokes a capability that does not currently confer READ. Live READ must use revokeAndRotate.
    function revoke(bytes32 capabilityId) external {
        Capability storage capability = _ownedUnrevoked(capabilityId);
        if (capability.permissions & PERM_READ != 0 && _isLive(capability)) revert ReadRequiresRotation(capabilityId);
        capability.revoked = true;
        emit CapabilityRevoked(capability.owner, capability.agentId, capability.namespaceId, capabilityId);
    }

    /// @notice Ends one live READ capability and advances its namespace to the next epoch with newEpochPublicKey.
    function revokeAndRotate(bytes32 capabilityId, bytes32 newEpochPublicKey) external {
        Capability storage capability = _ownedUnrevoked(capabilityId);
        if (capability.permissions & PERM_READ == 0 || !_isLive(capability)) revert RotationNotApplicable(capabilityId);
        capability.revoked = true;
        emit CapabilityRevoked(capability.owner, capability.agentId, capability.namespaceId, capabilityId);
        _rotate(msg.sender, capability.namespaceId, newEpochPublicKey);
    }

    /// @notice Invalidates every capability msg.sender granted to agentId by incrementing the owner-agent epoch.
    ///         rotations must name exactly the unique namespaces where the agent held live READ, once each.
    function revokeAgentAndRotate(bytes32 agentId, EpochRotation[] calldata rotations) external {
        bytes32[] storage ids = _activeByAgent[msg.sender][agentId];
        bytes32[] memory readNamespaces = new bytes32[](ids.length);
        uint256 count;
        for (uint256 i = 0; i < ids.length; i++) {
            Capability storage capability = _capabilities[ids[i]];
            if (capability.permissions & PERM_READ == 0 || !_isLive(capability)) continue;
            bool seen;
            for (uint256 j = 0; j < count; j++) {
                if (readNamespaces[j] == capability.namespaceId) {
                    seen = true;
                    break;
                }
            }
            if (!seen) readNamespaces[count++] = capability.namespaceId;
        }

        uint64 newAgentEpoch = _agentEpoch[msg.sender][agentId] + 1;
        _agentEpoch[msg.sender][agentId] = newAgentEpoch;
        delete _activeByAgent[msg.sender][agentId];
        emit AgentRevoked(msg.sender, agentId, newAgentEpoch);

        if (rotations.length != count) revert RotationSetMismatch();
        for (uint256 i = 0; i < rotations.length; i++) {
            bool expected;
            for (uint256 j = 0; j < count; j++) {
                // Namespace ids are never zero, so clearing a matched slot also rejects duplicates.
                if (readNamespaces[j] == rotations[i].namespaceId) {
                    readNamespaces[j] = bytes32(0);
                    expected = true;
                    break;
                }
            }
            if (!expected) revert RotationSetMismatch();
            _rotate(msg.sender, rotations[i].namespaceId, rotations[i].newEpochPublicKey);
        }
    }

    /// @notice Resumes writes after the earliest READ expiry closed the epoch (spec §7.3 expiry).
    function rotateExpiredEpoch(bytes32 namespaceId, bytes32 newEpochPublicKey) external {
        uint64 deadline = _writeDeadline[msg.sender][namespaceId];
        if (deadline == 0 || block.timestamp < deadline) revert EpochNotExpired(namespaceId);
        _rotate(msg.sender, namespaceId, newEpochPublicKey);
    }

    /// @notice Exact authorization (spec §10.5): one registered namespace, one permission bit, no ancestry.
    function isAuthorized(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permission)
        external
        view
        returns (bool)
    {
        return hasAuthority(owner, agentId, namespaceId, permission, 0);
    }

    /// @notice True only if ONE live exact capability carries every requested permission and provenance bit.
    ///         A zero permission never authorizes anything.
    function hasAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permissions, uint8 provenanceBits)
        public
        view
        returns (bool)
    {
        if (permissions == 0 || !isRegisteredNamespace(namespaceId)) return false;
        bytes32[] storage ids = _activeByAgent[owner][agentId];
        for (uint256 i = 0; i < ids.length; i++) {
            Capability storage capability = _capabilities[ids[i]];
            if (
                capability.namespaceId == namespaceId && _isLive(capability)
                    && capability.permissions & permissions == permissions
                    && capability.provenancePolicy & provenanceBits == provenanceBits
            ) return true;
        }
        return false;
    }

    function _ownedUnrevoked(bytes32 capabilityId) private view returns (Capability storage capability) {
        capability = _capabilities[capabilityId];
        if (capability.owner == address(0)) revert CapabilityNotFound(capabilityId);
        if (capability.owner != msg.sender) revert NotCapabilityOwner(capabilityId);
        if (capability.revoked) revert CapabilityAlreadyRevoked(capabilityId);
    }

    /// @dev Recomputes the next deadline from remaining live exact READ capabilities (at most 32), then
    ///      publishes the next epoch key.
    function _rotate(address owner, bytes32 namespaceId, bytes32 newEpochPublicKey) private {
        bytes32[] storage ids = _activeByNamespace[owner][namespaceId];
        _compact(ids);
        uint64 deadline;
        for (uint256 i = 0; i < ids.length; i++) {
            Capability storage capability = _capabilities[ids[i]];
            if (capability.permissions & PERM_READ == 0 || capability.expiresAt == 0) continue;
            if (deadline == 0 || capability.expiresAt < deadline) deadline = capability.expiresAt;
        }
        _publishNextEpoch(owner, namespaceId, newEpochPublicKey, deadline);
    }
}
```

Replace `contracts/src/CapabilityRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MidaWebAuthn} from "./MidaWebAuthn.sol";
import {Revocations} from "./Revocations.sol";
import {MIDA_POLICY_DOCUMENT_HASH_V1} from "./generated/PolicyHashV1.sol";

/// @notice Canonical authority for Mida Context (spec §10): namespaces, agents, owner passkey keys,
///         exact capabilities, read epochs with their public keys, and revocation.
contract CapabilityRegistry is Revocations {
    /// @notice keccak256 of the canonical mida-grant-policy-v1 document (spec §14.2).
    bytes32 public constant POLICY_HASH_V1 = MIDA_POLICY_DOCUMENT_HASH_V1;

    constructor(string memory vaultRpId) MidaWebAuthn(vaultRpId) {}
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
forge test --match-contract RevocationsTest
forge test
forge build --sizes | grep CapabilityRegistry
```
Expected: `RevocationsTest` `17 passed`. Full suite has no failures. `CapabilityRegistry` runtime size is about 20,300 bytes, still under 24,576.

- [ ] **Step 5: Commit**

```bash
cd ..
git add contracts/src/Revocations.sol contracts/src/CapabilityRegistry.sol contracts/test/Revocations.t.sol
git commit -m "feat(contracts): revocation with atomic epoch rotation, expiry rotation and exact authorization

Plain revoke cannot end live READ; agent-wide revocation must rotate exactly the affected namespaces.

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 19: `ContextRegistry`: roots, evidence, provenance rules

**Depends on:** Task 18.

**Files:**
- Create: `contracts/src/ICapabilityRegistry.sol`, `contracts/src/ContextRegistry.sol`
- Test: `contracts/test/utils/ContextFixtures.sol`, `contracts/test/ContextRoots.t.sol`

**Interfaces:**
- Consumes: file-level errors `InvalidNamespace`, `CapabilityDenied`, `EpochRotationRequired`, `EpochStale`, `ProvenanceForbidden`, `AnchorOwnerOnly` and record constants (Task 14); `MidaHashing.contextId`; `CapabilityRegistry.isRegisteredNamespace`, `agentIdOfSigner`, `requiredReadEpoch`, `epochPublicKey`, `isWriteEpochValid`, `hasAuthority` (Tasks 16–18).
- Produces, `interface ICapabilityRegistry` with exactly those six views.
- Produces, `contract ContextRegistry`:
  - `struct ContextInput` and `struct ContextRecord`, field for field as spec §11.3
  - `constructor(ICapabilityRegistry capabilityRegistry)`; `CAPABILITY_REGISTRY() external view returns (ICapabilityRegistry)`
  - `register(address owner, ContextInput[] calldata inputs) external returns (bytes32[] memory contextIds)`
  - `getRecord(bytes32 contextId) external view returns (ContextRecord memory)`; `exists(bytes32) external view returns (bool)`; `latest(bytes32 lineageId) external view returns (bytes32)`
  - Errors: `ZeroRegistry()`, `EmptyBatch()`, `InvalidRecord(bytes32 contextId)`, `ContextIdMismatch(bytes32 expected, bytes32 submitted)`, `DuplicateContext(bytes32)`, `ContextNotFound(bytes32)`
  - Events: `ContextRegistered(address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, ContextRecord record)`, `ContextSuperseded(address indexed owner, bytes32 indexed lineageId, bytes32 indexed contextId, bytes32 parentId, uint32 version)`, `EvidenceRegistered(address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, bytes32 author, bytes32 manifestHash)`
- Produces, test base `ContextFixtures is GrantFixtures`: `contexts`, `_deployContexts()`, `_contextInput(address owner, bytes32 authorId, string namespaceName, string nonceLabel, uint8 kind, uint8 provenanceSource)`, `_evidenceInput(address, bytes32, string, string)`, `_batch(ContextInput)`, `_submit(address sender, address owner, ContextInput) returns (bytes32)`, `_expectSubmitRevert(address sender, address owner, ContextInput, bytes revertData)`

**Decisions this task makes where the spec is silent** (report disagreement before implementing):
- `manifestHash` and `ciphertextCommitment` must be non-zero for every record.
- An evidence input with a non-zero `expectedParentId`, a non-`STANDARD` lineage, a kind, or a provenance source is `InvalidRecord`. `EvidenceImmutable` is reserved for a *context* input whose parent is evidence (Task 20).
- Evidence records store `lineageId = 0`, `parentId = 0`, `version = 1`, and emit only `EvidenceRegistered`.
- An agent writing evidence needs `CREATE` on that exact namespace. The epoch rules apply to evidence exactly as to context.
- `_supersede` in this task is a stage stub that reverts `ContextNotFound`. Task 20 replaces the whole file.

- [ ] **Step 1: Write the fixtures and failing tests**

`contracts/test/utils/ContextFixtures.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LINEAGE_STANDARD, RECORD_CONTEXT, RECORD_EVIDENCE} from "../../src/MidaTypes.sol";
import {ContextRegistry} from "../../src/ContextRegistry.sol";
import {ICapabilityRegistry} from "../../src/ICapabilityRegistry.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {GrantFixtures} from "./GrantFixtures.sol";

/// @notice Builds ContextInput values exactly as the SDK will: contextId is recomputed from
///         (chain, ContextRegistry, owner, author, namespace, nonce) before submission.
abstract contract ContextFixtures is GrantFixtures {
    ContextRegistry internal contexts;

    function _deployContexts() internal {
        _deployRegistry();
        contexts = new ContextRegistry(ICapabilityRegistry(address(registry)));
    }

    function _contextInput(
        address owner,
        bytes32 authorId,
        string memory namespaceName,
        string memory nonceLabel,
        uint8 kind,
        uint8 provenanceSource
    ) internal view returns (ContextRegistry.ContextInput memory input) {
        input.objectNonce = keccak256(bytes(nonceLabel));
        input.namespaceId = _ns(namespaceName);
        input.contextId = MidaHashing.contextId(
            block.chainid, address(contexts), owner, authorId, input.namespaceId, input.objectNonce
        );
        input.manifestHash = keccak256(abi.encode(nonceLabel, "manifest"));
        input.ciphertextCommitment = sha256(abi.encode(nonceLabel, "ciphertext"));
        input.readEpoch = registry.requiredReadEpoch(owner, input.namespaceId);
        input.recordType = RECORD_CONTEXT;
        input.lineagePolicy = LINEAGE_STANDARD;
        input.kind = kind;
        input.provenanceSource = provenanceSource;
    }

    function _evidenceInput(address owner, bytes32 authorId, string memory namespaceName, string memory nonceLabel)
        internal
        view
        returns (ContextRegistry.ContextInput memory input)
    {
        input = _contextInput(owner, authorId, namespaceName, nonceLabel, 0, 0);
        input.recordType = RECORD_EVIDENCE;
    }

    function _batch(ContextRegistry.ContextInput memory input)
        internal
        pure
        returns (ContextRegistry.ContextInput[] memory inputs)
    {
        inputs = new ContextRegistry.ContextInput[](1);
        inputs[0] = input;
    }

    function _submit(address sender, address owner, ContextRegistry.ContextInput memory input) internal returns (bytes32) {
        vm.prank(sender);
        return contexts.register(owner, _batch(input))[0];
    }

    function _expectSubmitRevert(address sender, address owner, ContextRegistry.ContextInput memory input, bytes memory revertData)
        internal
    {
        ContextRegistry.ContextInput[] memory inputs = _batch(input);
        vm.prank(sender);
        vm.expectRevert(revertData);
        contexts.register(owner, inputs);
    }
}
```

`contracts/test/ContextRoots.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochRotationRequired,
    EpochStale,
    InvalidNamespace,
    KIND_NONE,
    LINEAGE_OWNER_CONTROLLED,
    PERM_CREATE,
    PERM_READ,
    PROV_ALLOW_IMPORTED,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    SOURCE_AGENT_INFERRED,
    SOURCE_EXTERNAL_ATTESTATION,
    SOURCE_IMPORTED,
    SOURCE_NONE,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED
} from "../src/MidaTypes.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {ICapabilityRegistry} from "../src/ICapabilityRegistry.sol";
import {ContextFixtures} from "./utils/ContextFixtures.sol";

/// @notice §11.4 registration rules, §11.5 roots, §11.7 evidence, §11.8 provenance, and the write side of
///         §15 CREATE, Revocation, Expiry, Provenance, Anchor, Evidence and Concurrency rows.
contract ContextRootsTest is ContextFixtures {
    uint8 internal constant GOAL = 3;
    uint8 internal constant FACT = 1;

    TestOwner internal alice;
    TestAgent internal readerA;
    TestAgent internal agentB;
    TestAgent internal creatorC;
    bytes32 internal capA;

    function setUp() public {
        _deployContexts();
        alice = _ownerWithKey("alice");
        readerA = _register(registry, "agent-a");
        agentB = _register(registry, "agent-b");
        creatorC = _register(registry, "agent-c");
        _initEpoch(alice, "goals.career");
        capA = _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        _grantExact(alice, creatorC, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
    }

    function test_constructorRejectsZeroRegistry() public {
        vm.expectRevert(ContextRegistry.ZeroRegistry.selector);
        new ContextRegistry(ICapabilityRegistry(address(0)));
    }

    // ---------------------------------------------------------------- roots and derived fields

    function test_ownerRegistersRootWithDerivedFields() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, bytes32(0), "goals.career", "alice-goal-1", GOAL, SOURCE_USER_ASSERTED);
        bytes32 contextId = _submit(alice.owner, alice.owner, input);

        ContextRegistry.ContextRecord memory record = contexts.getRecord(contextId);
        assertEq(record.contextId, input.contextId);
        assertEq(record.owner, alice.owner);
        assertEq(record.author, bytes32(0));
        assertEq(record.lineageId, contextId);
        assertEq(record.parentId, bytes32(0));
        assertEq(record.version, 1);
        assertEq(record.readEpoch, 1);
        assertEq(record.createdAt, block.timestamp);
        assertEq(record.manifestHash, input.manifestHash);
        assertEq(record.ciphertextCommitment, input.ciphertextCommitment);
        assertEq(contexts.latest(contextId), contextId);
        assertTrue(contexts.exists(contextId));
    }

    /// @dev §15 "caller forges version/lineage/author": the id binds author, so a forged author fails.
    function test_contextIdIsRecomputedWithDerivedAuthor() public {
        ContextRegistry.ContextInput memory claimsOwnerAuthor =
            _contextInput(alice.owner, bytes32(0), "goals.career", "forged", GOAL, SOURCE_AGENT_INFERRED);
        bytes32 expected = keccak256(
            abi.encode(
                string("MIDA_CONTEXT_OBJECT_V1"),
                block.chainid,
                address(contexts),
                alice.owner,
                creatorC.agentId,
                claimsOwnerAuthor.namespaceId,
                claimsOwnerAuthor.objectNonce
            )
        );
        _expectSubmitRevert(
            creatorC.signer,
            alice.owner,
            claimsOwnerAuthor,
            abi.encodeWithSelector(ContextRegistry.ContextIdMismatch.selector, expected, claimsOwnerAuthor.contextId)
        );
    }

    function test_duplicateAndUnknownNamespaceRejected() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, bytes32(0), "goals.career", "dup", GOAL, SOURCE_USER_ASSERTED);
        _submit(alice.owner, alice.owner, input);
        _expectSubmitRevert(
            alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.DuplicateContext.selector, input.contextId)
        );

        ContextRegistry.ContextInput memory unknown =
            _contextInput(alice.owner, bytes32(0), "goals.side", "unknown", GOAL, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            alice.owner, alice.owner, unknown, abi.encodeWithSelector(InvalidNamespace.selector, _ns("goals.side"))
        );
    }

    /// @dev §4.1: a relayer calling directly is the relayer, not the owner.
    function test_relayerCannotActForOwner() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, bytes32(0), "goals.career", "relayed", GOAL, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(address(0xBEEF), alice.owner, input, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_emptyBatchRejected() public {
        vm.prank(alice.owner);
        vm.expectRevert(ContextRegistry.EmptyBatch.selector);
        contexts.register(alice.owner, new ContextRegistry.ContextInput[](0));
    }

    function test_batchIsAtomic() public {
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _contextInput(alice.owner, bytes32(0), "goals.career", "batch-ok", GOAL, SOURCE_USER_ASSERTED);
        inputs[1] = _contextInput(alice.owner, bytes32(0), "goals.career", "batch-bad", GOAL, SOURCE_AGENT_INFERRED);
        vm.prank(alice.owner);
        vm.expectRevert(ProvenanceForbidden.selector);
        contexts.register(alice.owner, inputs);
        assertFalse(contexts.exists(inputs[0].contextId));
    }

    // ---------------------------------------------------------------- agent authority

    /// @dev §16 step 9: Agent B has no grant.
    function test_agentWithoutGrantDenied() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, agentB.agentId, "goals.career", "b-write", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(agentB.signer, alice.owner, input, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_readOnlyAgentCannotCreate() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, readerA.agentId, "goals.career", "a-write", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(readerA.signer, alice.owner, input, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    /// @dev §15 "CREATE-only agent obtains epoch public key → new write succeeds"; §16 step 11.
    function test_createOnlyAgentWritesInferredRoot() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-write", GOAL, SOURCE_AGENT_INFERRED);
        bytes32 contextId = _submit(creatorC.signer, alice.owner, input);
        assertEq(contexts.getRecord(contextId).author, creatorC.agentId);
        assertEq(contexts.latest(contextId), contextId);
    }

    function test_agentCannotCreateOwnerControlledRoot() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-anchor", GOAL, SOURCE_AGENT_INFERRED);
        input.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(creatorC.signer, alice.owner, input, abi.encodeWithSelector(AnchorOwnerOnly.selector));

        ContextRegistry.ContextInput memory anchor =
            _contextInput(alice.owner, bytes32(0), "goals.career", "alice-anchor", GOAL, SOURCE_USER_ASSERTED);
        anchor.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchorId = _submit(alice.owner, alice.owner, anchor);
        assertEq(contexts.getRecord(anchorId).lineagePolicy, LINEAGE_OWNER_CONTROLLED);
    }

    // ---------------------------------------------------------------- epochs on the write path

    /// @dev §15 "write in old epoch after revoke" and "obsolete read-epoch object upload".
    function test_staleEpochRejectedAfterRotation() public {
        ContextRegistry.ContextInput memory oldEpoch =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "old-epoch", GOAL, SOURCE_AGENT_INFERRED);
        vm.prank(alice.owner);
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 2));
        _expectSubmitRevert(
            creatorC.signer,
            alice.owner,
            oldEpoch,
            abi.encodeWithSelector(EpochStale.selector, _ns("goals.career"), uint64(1), uint64(2))
        );

        ContextRegistry.ContextInput memory newEpoch =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "new-epoch", GOAL, SOURCE_AGENT_INFERRED);
        assertEq(newEpoch.readEpoch, 2);
        _submit(creatorC.signer, alice.owner, newEpoch);
    }

    function test_uninitializedEpochRejected() public {
        _grantExact(alice, creatorC, _one(_scope("projects.current", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, creatorC.agentId, "projects.current", "no-key", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(
            creatorC.signer,
            alice.owner,
            input,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("projects.current"), uint64(1))
        );
    }

    /// @dev §15 "write at exactly deadline", "write after deadline", "owner rotates after deadline".
    function test_writesCloseAtDeadlineAndResumeAfterRotation() public {
        TestAgent memory temporary = _register(registry, "agent-temp");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        _grantExact(alice, temporary, _one(_scope("goals.career", PERM_READ, 0)), deadline);
        ContextRegistry.ContextInput memory atDeadline =
            _contextInput(alice.owner, bytes32(0), "goals.career", "at-deadline", GOAL, SOURCE_USER_ASSERTED);

        vm.warp(deadline);
        _expectSubmitRevert(
            alice.owner,
            alice.owner,
            atDeadline,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("goals.career"), uint64(1))
        );

        vm.prank(alice.owner);
        registry.rotateExpiredEpoch(_ns("goals.career"), _epochKey(alice.owner, "goals.career", 2));
        ContextRegistry.ContextInput memory resumed =
            _contextInput(alice.owner, bytes32(0), "goals.career", "resumed", GOAL, SOURCE_USER_ASSERTED);
        _submit(alice.owner, alice.owner, resumed);
    }

    // ---------------------------------------------------------------- provenance (§11.8)

    /// @dev §15 "agent submits USER_ASSERTED" and "agent submits USER_CONFIRMED".
    function test_agentCannotClaimUserProvenance() public {
        ContextRegistry.ContextInput memory asserted =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-asserted", GOAL, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(creatorC.signer, alice.owner, asserted, abi.encodeWithSelector(ProvenanceForbidden.selector));
        ContextRegistry.ContextInput memory confirmed =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-confirmed", GOAL, SOURCE_USER_CONFIRMED);
        confirmed.evidenceCommitment = keccak256("refs");
        _expectSubmitRevert(creatorC.signer, alice.owner, confirmed, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    /// @dev §15 "owner submits USER_CONFIRMED without evidence commitment" and "owner labels a record AGENT_INFERRED".
    function test_ownerProvenanceRules() public {
        ContextRegistry.ContextInput memory confirmed =
            _contextInput(alice.owner, bytes32(0), "goals.career", "a-confirmed", GOAL, SOURCE_USER_CONFIRMED);
        _expectSubmitRevert(alice.owner, alice.owner, confirmed, abi.encodeWithSelector(ProvenanceForbidden.selector));
        confirmed.evidenceCommitment = keccak256("confirmed_from refs");
        _submit(alice.owner, alice.owner, confirmed);

        ContextRegistry.ContextInput memory inferred =
            _contextInput(alice.owner, bytes32(0), "goals.career", "a-inferred", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(alice.owner, alice.owner, inferred, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    function test_agentInferenceRequiresAllowInference() public {
        TestAgent memory plain = _register(registry, "agent-plain");
        _grantExact(alice, plain, _one(_scope("goals.career", PERM_CREATE, 0)), 0);
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, plain.agentId, "goals.career", "plain-inferred", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(plain.signer, alice.owner, input, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    function test_provenanceBitsMustComeFromTheCreateCapability() public {
        TestAgent memory split = _register(registry, "agent-split");
        _grantExact(alice, split, _one(_scope("goals.career", PERM_CREATE, 0)), 0);
        _grantExact(alice, split, _one(_scope("goals.career", PERM_READ, PROV_ALLOW_INFERENCE)), 0);
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, split.agentId, "goals.career", "split-inferred", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(split.signer, alice.owner, input, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    /// @dev §15 "imported/attested without evidence".
    function test_importedAndAttestedNeedEvidenceAndPolicyBits() public {
        TestAgent memory importer = _register(registry, "agent-import");
        _grantExact(alice, importer, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_IMPORTED)), 0);

        ContextRegistry.ContextInput memory noEvidence =
            _contextInput(alice.owner, importer.agentId, "goals.career", "imp-none", FACT, SOURCE_IMPORTED);
        _expectSubmitRevert(importer.signer, alice.owner, noEvidence, abi.encodeWithSelector(ProvenanceForbidden.selector));

        ContextRegistry.ContextInput memory imported =
            _contextInput(alice.owner, importer.agentId, "goals.career", "imp-ok", FACT, SOURCE_IMPORTED);
        imported.evidenceCommitment = keccak256("evidence refs");
        _submit(importer.signer, alice.owner, imported);

        ContextRegistry.ContextInput memory attested =
            _contextInput(alice.owner, importer.agentId, "goals.career", "att", FACT, SOURCE_EXTERNAL_ATTESTATION);
        attested.evidenceCommitment = keccak256("evidence refs");
        _expectSubmitRevert(importer.signer, alice.owner, attested, abi.encodeWithSelector(ProvenanceForbidden.selector));

        ContextRegistry.ContextInput memory ownerImport =
            _contextInput(alice.owner, bytes32(0), "goals.career", "owner-imp", FACT, SOURCE_IMPORTED);
        _expectSubmitRevert(alice.owner, alice.owner, ownerImport, abi.encodeWithSelector(ProvenanceForbidden.selector));
        ownerImport.evidenceCommitment = keccak256("evidence refs");
        _submit(alice.owner, alice.owner, ownerImport);
    }

    // ---------------------------------------------------------------- evidence and record shape (§11.7)

    function test_evidenceRecordsAreImmutableArtifacts() public {
        ContextRegistry.ContextInput memory evidence = _evidenceInput(alice.owner, bytes32(0), "goals.career", "cv-upload");
        vm.expectEmit(address(contexts));
        emit ContextRegistry.EvidenceRegistered(alice.owner, evidence.namespaceId, evidence.contextId, bytes32(0), evidence.manifestHash);
        bytes32 evidenceId = _submit(alice.owner, alice.owner, evidence);

        ContextRegistry.ContextRecord memory record = contexts.getRecord(evidenceId);
        assertEq(record.lineageId, bytes32(0));
        assertEq(record.parentId, bytes32(0));
        assertEq(contexts.latest(evidenceId), bytes32(0), "evidence has no lineage head");

        ContextRegistry.ContextInput memory agentEvidence =
            _evidenceInput(alice.owner, creatorC.agentId, "goals.career", "c-evidence");
        _submit(creatorC.signer, alice.owner, agentEvidence);
        ContextRegistry.ContextInput memory deniedEvidence =
            _evidenceInput(alice.owner, readerA.agentId, "goals.career", "a-evidence");
        _expectSubmitRevert(readerA.signer, alice.owner, deniedEvidence, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_recordShapeRules() public {
        ContextRegistry.ContextInput memory input =
            _evidenceInput(alice.owner, bytes32(0), "goals.career", "shape-evidence-kind");
        input.kind = GOAL;
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _evidenceInput(alice.owner, bytes32(0), "goals.career", "shape-evidence-anchor");
        input.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _evidenceInput(alice.owner, bytes32(0), "goals.career", "shape-evidence-parent");
        input.expectedParentId = keccak256("parent");
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-kind-none", KIND_NONE, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-source-none", GOAL, SOURCE_NONE);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-enum", 9, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-manifest", GOAL, SOURCE_USER_ASSERTED);
        input.manifestHash = bytes32(0);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));
    }

    // ---------------------------------------------------------------- concurrency (§3.2)

    /// @dev §15 "independent roots/lineages created concurrently": no global nonce or lock.
    function test_independentRootsInOneBlockAndOneBatch() public {
        _submit(alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "par-1", GOAL, SOURCE_USER_ASSERTED));
        _submit(
            creatorC.signer,
            alice.owner,
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "par-2", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _contextInput(alice.owner, bytes32(0), "goals.career", "par-3", GOAL, SOURCE_USER_ASSERTED);
        inputs[1] = _contextInput(alice.owner, bytes32(0), "goals.career", "par-4", GOAL, SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        bytes32[] memory ids = contexts.register(alice.owner, inputs);
        assertEq(contexts.latest(ids[0]), ids[0]);
        assertEq(contexts.latest(ids[1]), ids[1]);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `forge test --match-contract ContextRootsTest`
Expected: FAIL at compilation, because `src/ContextRegistry.sol` and `src/ICapabilityRegistry.sol` do not exist.

- [ ] **Step 3: Implement the interface and the registry**

`contracts/src/ICapabilityRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The CapabilityRegistry views ContextRegistry depends on. ContextRegistry never writes to it.
interface ICapabilityRegistry {
    function isRegisteredNamespace(bytes32 namespaceId) external view returns (bool);
    function agentIdOfSigner(address signer) external view returns (bytes32);
    function requiredReadEpoch(address owner, bytes32 namespaceId) external view returns (uint64);
    function epochPublicKey(address owner, bytes32 namespaceId, uint64 epoch) external view returns (bytes32);
    function isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) external view returns (bool);
    function hasAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permissions, uint8 provenanceBits)
        external
        view
        returns (bool);
}
```

`contracts/src/ContextRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochRotationRequired,
    EpochStale,
    InvalidNamespace,
    KIND_MAX,
    KIND_NONE,
    LINEAGE_OWNER_CONTROLLED,
    LINEAGE_STANDARD,
    PERM_CREATE,
    PROV_ALLOW_EXTERNAL_ATTESTATION,
    PROV_ALLOW_IMPORTED,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    RECORD_CONTEXT,
    RECORD_EVIDENCE,
    SOURCE_AGENT_INFERRED,
    SOURCE_EXTERNAL_ATTESTATION,
    SOURCE_IMPORTED,
    SOURCE_NONE,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED
} from "./MidaTypes.sol";
import {ICapabilityRegistry} from "./ICapabilityRegistry.sol";
import {MidaHashing} from "./MidaHashing.sol";

/// @notice Immutable context and evidence records with contract-derived authorship, provenance rules
///         and lineage (spec §11). Holds no epoch keys: every write reads epoch validity from
///         CapabilityRegistry. No plaintext is ever stored here, only commitments.
contract ContextRegistry {
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

    error ZeroRegistry();
    error EmptyBatch();
    error InvalidRecord(bytes32 contextId);
    error ContextIdMismatch(bytes32 expected, bytes32 submitted);
    error DuplicateContext(bytes32 contextId);
    error ContextNotFound(bytes32 contextId);

    ICapabilityRegistry public immutable CAPABILITY_REGISTRY;

    mapping(bytes32 contextId => ContextRecord) private _records;
    mapping(bytes32 lineageId => bytes32 contextId) private _latest;

    event ContextRegistered(
        address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, ContextRecord record
    );
    event ContextSuperseded(
        address indexed owner, bytes32 indexed lineageId, bytes32 indexed contextId, bytes32 parentId, uint32 version
    );
    event EvidenceRegistered(
        address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, bytes32 author, bytes32 manifestHash
    );

    constructor(ICapabilityRegistry capabilityRegistry) {
        if (address(capabilityRegistry) == address(0)) revert ZeroRegistry();
        CAPABILITY_REGISTRY = capabilityRegistry;
    }

    /// @notice Registers a batch atomically. msg.sender is either the owner (author = bytes32(0)) or the
    ///         current signer of a registered agent (author = agentId) acting under that owner's capabilities.
    function register(address owner, ContextInput[] calldata inputs) external returns (bytes32[] memory contextIds) {
        if (inputs.length == 0) revert EmptyBatch();
        bytes32 author = _resolveAuthor(owner);
        contextIds = new bytes32[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            contextIds[i] = _registerOne(owner, author, inputs[i]);
        }
    }

    function getRecord(bytes32 contextId) external view returns (ContextRecord memory record) {
        record = _records[contextId];
        if (record.owner == address(0)) revert ContextNotFound(contextId);
    }

    function exists(bytes32 contextId) external view returns (bool) {
        return _records[contextId].owner != address(0);
    }

    /// @notice Canonical head of a context lineage; bytes32(0) for unknown lineages and for evidence ids.
    function latest(bytes32 lineageId) external view returns (bytes32) {
        return _latest[lineageId];
    }

    function _resolveAuthor(address owner) private view returns (bytes32 author) {
        if (owner == address(0)) revert CapabilityDenied();
        if (msg.sender == owner) return bytes32(0);
        author = CAPABILITY_REGISTRY.agentIdOfSigner(msg.sender);
        if (author == bytes32(0)) revert CapabilityDenied();
    }

    function _registerOne(address owner, bytes32 author, ContextInput calldata input) private returns (bytes32 contextId) {
        _validateShape(input);
        if (!CAPABILITY_REGISTRY.isRegisteredNamespace(input.namespaceId)) revert InvalidNamespace(input.namespaceId);

        contextId = MidaHashing.contextId(block.chainid, address(this), owner, author, input.namespaceId, input.objectNonce);
        if (input.contextId != contextId) revert ContextIdMismatch(contextId, input.contextId);
        if (_records[contextId].owner != address(0)) revert DuplicateContext(contextId);

        uint64 required = CAPABILITY_REGISTRY.requiredReadEpoch(owner, input.namespaceId);
        if (input.readEpoch != required) revert EpochStale(input.namespaceId, input.readEpoch, required);
        if (!CAPABILITY_REGISTRY.isWriteEpochValid(owner, input.namespaceId, required)) {
            revert EpochRotationRequired(input.namespaceId, required);
        }

        if (input.recordType == RECORD_EVIDENCE) {
            if (author != bytes32(0)) _requireAgentAuthority(owner, author, input.namespaceId, PERM_CREATE, 0);
            _store(owner, author, input, contextId, bytes32(0), bytes32(0), 1);
            emit EvidenceRegistered(owner, input.namespaceId, contextId, author, input.manifestHash);
            return contextId;
        }

        uint8 provenanceBits = _provenanceBits(author == bytes32(0), input);
        if (input.expectedParentId == bytes32(0)) {
            _registerRoot(owner, author, input, contextId, provenanceBits);
        } else {
            _supersede(owner, author, input, contextId, provenanceBits);
        }
    }

    /// @dev Enum ranges, non-zero commitments, and the evidence/context split of spec §11.7.
    function _validateShape(ContextInput calldata input) private pure {
        if (
            input.recordType > RECORD_EVIDENCE || input.lineagePolicy > LINEAGE_OWNER_CONTROLLED || input.kind > KIND_MAX
                || input.provenanceSource > SOURCE_EXTERNAL_ATTESTATION || input.manifestHash == bytes32(0)
                || input.ciphertextCommitment == bytes32(0)
        ) revert InvalidRecord(input.contextId);
        if (input.recordType == RECORD_EVIDENCE) {
            if (
                input.expectedParentId != bytes32(0) || input.lineagePolicy != LINEAGE_STANDARD || input.kind != KIND_NONE
                    || input.provenanceSource != SOURCE_NONE
            ) revert InvalidRecord(input.contextId);
        } else if (input.recordType == RECORD_CONTEXT) {
            if (input.kind == KIND_NONE || input.provenanceSource == SOURCE_NONE) revert InvalidRecord(input.contextId);
        }
    }

    /// @dev Spec §11.8. Returns the provenance-policy bits an agent's capability must carry.
    function _provenanceBits(bool ownerAuthored, ContextInput calldata input) private pure returns (uint8) {
        uint8 source = input.provenanceSource;
        bool hasEvidence = input.evidenceCommitment != bytes32(0);
        if (source == SOURCE_USER_ASSERTED) {
            if (!ownerAuthored) revert ProvenanceForbidden();
            return 0;
        }
        if (source == SOURCE_USER_CONFIRMED) {
            if (!ownerAuthored || !hasEvidence) revert ProvenanceForbidden();
            return 0;
        }
        if (source == SOURCE_AGENT_INFERRED) {
            if (ownerAuthored) revert ProvenanceForbidden();
            return PROV_ALLOW_INFERENCE;
        }
        if (!hasEvidence) revert ProvenanceForbidden();
        if (ownerAuthored) return 0;
        return source == SOURCE_IMPORTED ? PROV_ALLOW_IMPORTED : PROV_ALLOW_EXTERNAL_ATTESTATION;
    }

    function _registerRoot(address owner, bytes32 author, ContextInput calldata input, bytes32 contextId, uint8 provenanceBits)
        private
    {
        if (author != bytes32(0)) {
            if (input.lineagePolicy != LINEAGE_STANDARD) revert AnchorOwnerOnly();
            _requireAgentAuthority(owner, author, input.namespaceId, PERM_CREATE, provenanceBits);
        }
        _store(owner, author, input, contextId, contextId, bytes32(0), 1);
        _latest[contextId] = contextId;
    }

    /// @dev Task 20 replaces this function with lineage supersession.
    function _supersede(address, bytes32, ContextInput calldata input, bytes32, uint8) private pure {
        revert ContextNotFound(input.expectedParentId);
    }

    /// @dev One exact capability must carry the permission; if provenance bits are required, the same
    ///      capability must carry them too (CapabilityRegistry.hasAuthority checks both together).
    function _requireAgentAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permission, uint8 provenanceBits)
        private
        view
    {
        if (!CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, permission, 0)) revert CapabilityDenied();
        if (provenanceBits != 0 && !CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, permission, provenanceBits)) {
            revert ProvenanceForbidden();
        }
    }

    function _store(
        address owner,
        bytes32 author,
        ContextInput calldata input,
        bytes32 contextId,
        bytes32 lineageId,
        bytes32 parentId,
        uint32 version
    ) private {
        ContextRecord memory record = ContextRecord({
            contextId: contextId,
            owner: owner,
            author: author,
            namespaceId: input.namespaceId,
            lineageId: lineageId,
            parentId: parentId,
            manifestHash: input.manifestHash,
            ciphertextCommitment: input.ciphertextCommitment,
            evidenceCommitment: input.evidenceCommitment,
            readEpoch: input.readEpoch,
            createdAt: uint64(block.timestamp),
            expiresAt: input.expiresAt,
            version: version,
            recordType: input.recordType,
            lineagePolicy: input.lineagePolicy,
            kind: input.kind,
            provenanceSource: input.provenanceSource
        });
        _records[contextId] = record;
        emit ContextRegistered(owner, input.namespaceId, contextId, record);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
forge test --match-contract ContextRootsTest
forge test
forge build --sizes | grep -E "ContextRegistry|CapabilityRegistry"
```
Expected: `ContextRootsTest` `22 passed`. Full suite has no failures. `ContextRegistry` runtime size is about 4,900 bytes.

- [ ] **Step 5: Commit**

```bash
cd ..
git add contracts/src/ICapabilityRegistry.sol contracts/src/ContextRegistry.sol contracts/test/utils/ContextFixtures.sol contracts/test/ContextRoots.t.sol
git commit -m "feat(contracts): context registry roots, immutable evidence and provenance enforcement

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

### Task 20: `ContextRegistry`: supersession, owner-controlled anchors, stale parents, concurrency

**Depends on:** Task 19.

**Files:**
- Modify: `contracts/src/ContextRegistry.sol` (full replacement below)
- Create: `contracts/script/Deploy.s.sol`, `contracts/deployments/.gitkeep`
- Modify: root `.gitignore`
- Test: `contracts/test/ContextLineage.t.sol`, `contracts/test/Scenario.t.sol`

**Interfaces:**
- Consumes: everything from Task 19; file-level errors `StaleParent(bytes32,bytes32)` and `EvidenceImmutable(bytes32)`; `PERM_SUPERSEDE_OWN`, `PERM_SUPERSEDE_ANY`; `CapabilityRegistry.hasAuthority`, `revokeAndRotate`, `revokeAgentAndRotate`, `Revocations.EpochRotation`.
- Produces, `ContextRegistry` additions:
  - Error `ParentMismatch(bytes32 parentId)`
  - Supersession through `register` when `expectedParentId != 0`: reverts `ContextNotFound(parent)`, `EvidenceImmutable(parent)`, `ParentMismatch(parent)`, `StaleParent(parent, currentHead)`, `InvalidRecord(contextId)` (lineage-policy change), `AnchorOwnerOnly()`, `CapabilityDenied()` or `ProvenanceForbidden()`; on success derives `lineageId = parent.lineageId`, `parentId = expectedParentId`, `version = parent.version + 1`, moves `latest(lineageId)`, and emits `ContextRegistered` then `ContextSuperseded`.
- Produces, `contract Deploy is Script`: `run() external returns (CapabilityRegistry, ContextRegistry)`. Reads optional env `VAULT_RP_ID` (default `vault.mida.xyz`). Writes `contracts/deployments/<chainId>.json` with keys `capabilityRegistry`, `chainId`, `contextRegistry`, `deploymentBlock`, `policyHashV1`, `vaultRpId`, `vaultRpIdHash`. Part E reads this file for addresses and uses `deploymentBlock` as the first block of every chunked log scan.

**Decisions this task makes where the spec is silent** (report disagreement before implementing):
- A successor's `lineagePolicy` must equal the lineage root's. Owner-controlled status can be neither removed nor added after the root.
- `SUPERSEDE_ANY` also covers the agent's own lineage. `SUPERSEDE_OWN` covers only lineages whose root author is that agent.
- When provenance bits are required on a supersession, the same capability that grants the supersede permission must carry them.
- The owner may supersede any lineage it owns in that namespace, including agent-authored lineages, with no capability.

- [ ] **Step 1: Write the failing lineage and scenario tests**

`contracts/test/ContextLineage.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochStale,
    EvidenceImmutable,
    LINEAGE_OWNER_CONTROLLED,
    LINEAGE_STANDARD,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    SOURCE_AGENT_INFERRED,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED,
    StaleParent
} from "../src/MidaTypes.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {Revocations} from "../src/Revocations.sol";
import {ContextFixtures} from "./utils/ContextFixtures.sol";

/// @notice §11.6 supersession, §11.5 owner-controlled anchors, §3.2 FAFO concurrency, and §15 Anchor,
///         Evidence, Lineage and Concurrency rows.
contract ContextLineageTest is ContextFixtures {
    uint8 internal constant GOAL = 3;

    TestOwner internal alice;
    TestAgent internal ownAgent;
    TestAgent internal anyAgent;
    bytes32 internal aliceRoot;

    function setUp() public {
        _deployContexts();
        alice = _ownerWithKey("alice");
        ownAgent = _register(registry, "agent-own");
        anyAgent = _register(registry, "agent-any");
        _initEpoch(alice, "goals.career");
        _initEpoch(alice, "projects.current");
        _grantExact(
            alice, ownAgent, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0
        );
        _grantExact(
            alice, anyAgent, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_ANY, PROV_ALLOW_INFERENCE)), 0
        );
        aliceRoot = _submit(
            alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "alice-root", GOAL, SOURCE_USER_ASSERTED)
        );
    }

    function _successor(
        address owner,
        bytes32 authorId,
        string memory namespaceName,
        bytes32 parentId,
        string memory label,
        uint8 source
    ) internal view returns (ContextRegistry.ContextInput memory input) {
        input = _contextInput(owner, authorId, namespaceName, label, GOAL, source);
        input.expectedParentId = parentId;
    }

    // ---------------------------------------------------------------- owner supersession

    function test_ownerSupersedesAndLineageFieldsAreDerived() public {
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "alice-v2", SOURCE_USER_ASSERTED);
        vm.expectEmit(address(contexts));
        emit ContextRegistry.ContextSuperseded(alice.owner, aliceRoot, next.contextId, aliceRoot, 2);
        bytes32 v2 = _submit(alice.owner, alice.owner, next);

        ContextRegistry.ContextRecord memory record = contexts.getRecord(v2);
        assertEq(record.lineageId, aliceRoot);
        assertEq(record.parentId, aliceRoot);
        assertEq(record.version, 2);
        assertEq(contexts.latest(aliceRoot), v2);
    }

    /// @dev §15 "same current parent superseded twice": second gets STALE_PARENT.
    function test_secondSupersessionOfSameParentIsStale() public {
        bytes32 first = _submit(
            alice.owner, alice.owner, _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "first", SOURCE_USER_ASSERTED)
        );
        ContextRegistry.ContextInput memory second =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "second", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, second, abi.encodeWithSelector(StaleParent.selector, aliceRoot, first));
        assertEq(contexts.latest(aliceRoot), first);
    }

    function test_staleParentInsideOneBatchRevertsTheBatch() public {
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "batch-a", SOURCE_USER_ASSERTED);
        inputs[1] = _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "batch-b", SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(StaleParent.selector, aliceRoot, inputs[0].contextId));
        contexts.register(alice.owner, inputs);
        assertEq(contexts.latest(aliceRoot), aliceRoot);
    }

    function testFuzz_onlyTheCurrentHeadCanBeSuperseded(uint8 depthSeed, uint8 pickSeed) public {
        uint256 depth = bound(depthSeed, 1, 8);
        bytes32[] memory chain = new bytes32[](depth + 1);
        chain[0] = aliceRoot;
        for (uint256 i = 1; i <= depth; i++) {
            chain[i] = _submit(
                alice.owner,
                alice.owner,
                _successor(alice.owner, bytes32(0), "goals.career", chain[i - 1], string.concat("fuzz-", vm.toString(i)), SOURCE_USER_ASSERTED)
            );
        }
        uint256 pick = bound(pickSeed, 0, depth);
        ContextRegistry.ContextInput memory attempt =
            _successor(alice.owner, bytes32(0), "goals.career", chain[pick], "fuzz-attempt", SOURCE_USER_ASSERTED);
        if (pick == depth) {
            bytes32 head = _submit(alice.owner, alice.owner, attempt);
            assertEq(contexts.getRecord(head).version, depth + 2);
            assertEq(contexts.latest(aliceRoot), head);
        } else {
            _expectSubmitRevert(alice.owner, alice.owner, attempt, abi.encodeWithSelector(StaleParent.selector, chain[pick], chain[depth]));
            assertEq(contexts.latest(aliceRoot), chain[depth]);
        }
    }

    /// @dev §15 "independent roots/lineages created concurrently": two lineages advance in one batch.
    function test_independentLineagesAdvanceTogether() public {
        bytes32 otherRoot = _submit(
            alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "other-root", GOAL, SOURCE_USER_ASSERTED)
        );
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "lineage-1-v2", SOURCE_USER_ASSERTED);
        inputs[1] = _successor(alice.owner, bytes32(0), "goals.career", otherRoot, "lineage-2-v2", SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        bytes32[] memory ids = contexts.register(alice.owner, inputs);
        assertEq(contexts.latest(aliceRoot), ids[0]);
        assertEq(contexts.latest(otherRoot), ids[1]);
    }

    // ---------------------------------------------------------------- agent supersession rules

    function test_supersedeOwnWorksOnlyOnOwnLineage() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        _submit(
            ownAgent.signer,
            alice.owner,
            _successor(alice.owner, ownAgent.agentId, "goals.career", agentRoot, "own-v2", SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory othersLineage =
            _successor(alice.owner, ownAgent.agentId, "goals.career", aliceRoot, "own-on-alice", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(ownAgent.signer, alice.owner, othersLineage, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_supersedeAnyWorksOnAnotherAuthorsStandardLineage() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        bytes32 v2 = _submit(
            anyAgent.signer,
            alice.owner,
            _successor(alice.owner, anyAgent.agentId, "goals.career", agentRoot, "any-v2", SOURCE_AGENT_INFERRED)
        );
        assertEq(contexts.getRecord(v2).author, anyAgent.agentId);
        _submit(
            anyAgent.signer,
            alice.owner,
            _successor(alice.owner, anyAgent.agentId, "goals.career", aliceRoot, "any-on-alice", SOURCE_AGENT_INFERRED)
        );
    }

    function test_createOnlyAgentCannotSupersede() public {
        TestAgent memory creator = _register(registry, "agent-create");
        _grantExact(alice, creator, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        bytes32 creatorRoot = _submit(
            creator.signer,
            alice.owner,
            _contextInput(alice.owner, creator.agentId, "goals.career", "creator-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, creator.agentId, "goals.career", creatorRoot, "creator-v2", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(creator.signer, alice.owner, next, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_supersessionProvenanceBitsMustComeFromTheSupersedeCapability() public {
        TestAgent memory split = _register(registry, "agent-split");
        _grantExact(alice, split, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        _grantExact(alice, split, _one(_scope("goals.career", PERM_SUPERSEDE_OWN, 0)), 0);
        bytes32 splitRoot = _submit(
            split.signer,
            alice.owner,
            _contextInput(alice.owner, split.agentId, "goals.career", "split-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, split.agentId, "goals.career", splitRoot, "split-v2", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(split.signer, alice.owner, next, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    // ---------------------------------------------------------------- anchors (§11.5, §11.6)

    /// @dev §15 "SUPERSEDE_ANY agent edits owner-controlled lineage".
    function test_noAgentMaySupersedeAnOwnerControlledLineage() public {
        ContextRegistry.ContextInput memory anchorInput =
            _contextInput(alice.owner, bytes32(0), "goals.career", "anchor", GOAL, SOURCE_USER_ASSERTED);
        anchorInput.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchor = _submit(alice.owner, alice.owner, anchorInput);

        ContextRegistry.ContextInput memory edit =
            _successor(alice.owner, anyAgent.agentId, "goals.career", anchor, "any-edit", SOURCE_AGENT_INFERRED);
        edit.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(anyAgent.signer, alice.owner, edit, abi.encodeWithSelector(AnchorOwnerOnly.selector));
        assertEq(contexts.latest(anchor), anchor);
    }

    /// @dev §15 "agent creates separate proposal": accepted with inference policy; anchor head unchanged.
    function test_agentProposalIsASeparateLineage() public {
        ContextRegistry.ContextInput memory anchorInput =
            _contextInput(alice.owner, bytes32(0), "goals.career", "anchor", GOAL, SOURCE_USER_ASSERTED);
        anchorInput.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchor = _submit(alice.owner, alice.owner, anchorInput);

        ContextRegistry.ContextInput memory proposal =
            _contextInput(alice.owner, anyAgent.agentId, "goals.career", "proposal", GOAL, SOURCE_AGENT_INFERRED);
        proposal.evidenceCommitment = keccak256(abi.encode("supports", anchor));
        bytes32 proposalId = _submit(anyAgent.signer, alice.owner, proposal);

        assertEq(contexts.latest(proposalId), proposalId);
        assertEq(contexts.latest(anchor), anchor, "a generic reference never moves the anchor head");
    }

    function test_ownerControlledStatusCannotBeAddedOrRemoved() public {
        ContextRegistry.ContextInput memory anchorInput =
            _contextInput(alice.owner, bytes32(0), "goals.career", "anchor", GOAL, SOURCE_USER_ASSERTED);
        anchorInput.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchor = _submit(alice.owner, alice.owner, anchorInput);

        ContextRegistry.ContextInput memory removes =
            _successor(alice.owner, bytes32(0), "goals.career", anchor, "remove-policy", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, removes, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, removes.contextId));

        ContextRegistry.ContextInput memory keeps =
            _successor(alice.owner, bytes32(0), "goals.career", anchor, "keep-policy", SOURCE_USER_ASSERTED);
        keeps.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _submit(alice.owner, alice.owner, keeps);

        ContextRegistry.ContextInput memory adds =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "add-policy", SOURCE_USER_ASSERTED);
        adds.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(alice.owner, alice.owner, adds, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, adds.contextId));
    }

    /// @dev §11.8: a user-confirmed successor may edit an agent proposal.
    function test_ownerMayConfirmAndSupersedeAnAgentLineage() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory confirmed =
            _successor(alice.owner, bytes32(0), "goals.career", agentRoot, "confirmed", SOURCE_USER_CONFIRMED);
        confirmed.evidenceCommitment = keccak256(abi.encode("confirmed_from", agentRoot));
        bytes32 v2 = _submit(alice.owner, alice.owner, confirmed);
        assertEq(contexts.getRecord(v2).author, bytes32(0));
        assertEq(contexts.latest(agentRoot), v2);
    }

    // ---------------------------------------------------------------- parents

    /// @dev §15 "supersede evidence": EVIDENCE_IMMUTABLE.
    function test_evidenceCannotBeSuperseded() public {
        bytes32 evidence = _submit(alice.owner, alice.owner, _evidenceInput(alice.owner, bytes32(0), "goals.career", "cv"));
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, bytes32(0), "goals.career", evidence, "on-evidence", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, next, abi.encodeWithSelector(EvidenceImmutable.selector, evidence));
    }

    function test_parentMustExistWithSameOwnerAndNamespace() public {
        ContextRegistry.ContextInput memory missing =
            _successor(alice.owner, bytes32(0), "goals.career", keccak256("nothing"), "missing", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            alice.owner, alice.owner, missing, abi.encodeWithSelector(ContextRegistry.ContextNotFound.selector, keccak256("nothing"))
        );

        ContextRegistry.ContextInput memory otherNamespace =
            _successor(alice.owner, bytes32(0), "projects.current", aliceRoot, "cross-namespace", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            alice.owner, alice.owner, otherNamespace, abi.encodeWithSelector(ContextRegistry.ParentMismatch.selector, aliceRoot)
        );

        TestOwner memory bob = _ownerWithKey("bob");
        _initEpoch(bob, "goals.career");
        ContextRegistry.ContextInput memory otherOwner =
            _successor(bob.owner, bytes32(0), "goals.career", aliceRoot, "cross-owner", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            bob.owner, bob.owner, otherOwner, abi.encodeWithSelector(ContextRegistry.ParentMismatch.selector, aliceRoot)
        );
    }

    // ---------------------------------------------------------------- epochs and revocation on supersession

    function test_supersessionUsesTheCurrentEpoch() public {
        TestAgent memory reader = _register(registry, "agent-reader");
        bytes32 readCap = _grantExact(alice, reader, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        ContextRegistry.ContextInput memory oldEpoch =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "old-epoch-v2", SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        registry.revokeAndRotate(readCap, _epochKey(alice.owner, "goals.career", 2));
        _expectSubmitRevert(
            alice.owner,
            alice.owner,
            oldEpoch,
            abi.encodeWithSelector(EpochStale.selector, _ns("goals.career"), uint64(1), uint64(2))
        );
    }

    function test_revokedAgentCannotSupersede() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(ownAgent.agentId, new Revocations.EpochRotation[](0));
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, ownAgent.agentId, "goals.career", agentRoot, "revoked-v2", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(ownAgent.signer, alice.owner, next, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_lineagePolicyDefaultIsStandard() public view {
        assertEq(contexts.getRecord(aliceRoot).lineagePolicy, LINEAGE_STANDARD);
    }
}
```

`contracts/test/Scenario.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessRequestInput,
    CapabilityDenied,
    EpochStale,
    GrantScope,
    PERM_CREATE,
    PERM_READ,
    PROV_ALLOW_INFERENCE,
    SOURCE_AGENT_INFERRED,
    SOURCE_USER_ASSERTED
} from "../src/MidaTypes.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {ContextFixtures} from "./utils/ContextFixtures.sol";

/// @notice The on-chain half of the spec §16 end-to-end scenario, as one test. Steps that are off-chain
///         (manifest and advisor evaluation, wraps, decryption, API deny overlay) are proven in Part E; this
///         test proves the chain allows or denies exactly what those steps assume.
contract ScenarioTest is ContextFixtures {
    uint8 internal constant GOAL = 3;

    function test_section16OnChainSteps() public {
        _deployContexts();

        // 1. Alice registers her owner P256 key and the goals.career epoch-1 public key.
        TestOwner memory alice = _ownerWithKey("alice");
        _initEpoch(alice, "goals.career");
        bytes32 career = _ns("goals.career");

        // 2. Agents A, B, C (and remaining reader D) register with signer proofs and manifest commitments.
        TestAgent memory agentA = _register(registry, "agent-a");
        TestAgent memory agentB = _register(registry, "agent-b");
        TestAgent memory agentC = _register(registry, "agent-c");
        TestAgent memory agentD = _register(registry, "agent-d");

        // 3. Alice creates encrypted goals.career context under epoch 1.
        bytes32 aliceContext = _submit(
            alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "s16-alice", GOAL, SOURCE_USER_ASSERTED)
        );
        assertEq(contexts.getRecord(aliceContext).readEpoch, 1);

        // 4-6. A requests READ goals.career plus unnecessary READ financial; Alice approves only READ goals.career.
        GrantScope[] memory requested = _two(_scope("goals.career", PERM_READ, 0), _scope("financial", PERM_READ, 0));
        AccessRequestInput memory request = _request(agentA, requested, 0);
        bytes32 capA = _grant(alice, request, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        assertTrue(registry.isAuthorized(alice.owner, agentA.agentId, career, PERM_READ));
        assertFalse(registry.isAuthorized(alice.owner, agentA.agentId, _ns("financial"), PERM_READ), "financial was not granted");
        _grantExact(alice, agentD, _one(_scope("goals.career", PERM_READ, 0)), 0);

        // 9. Agent B has no grant.
        assertFalse(registry.isAuthorized(alice.owner, agentB.agentId, career, PERM_READ));
        _expectSubmitRevert(
            agentB.signer,
            alice.owner,
            _contextInput(alice.owner, agentB.agentId, "goals.career", "s16-b", GOAL, SOURCE_AGENT_INFERRED),
            abi.encodeWithSelector(CapabilityDenied.selector)
        );

        // 10-12. C gets exact CREATE goals.career without READ and creates a new lineage.
        _grantExact(alice, agentC, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        assertFalse(registry.isAuthorized(alice.owner, agentC.agentId, career, PERM_READ), "CREATE does not imply READ");
        bytes32 cEpoch1 = _submit(
            agentC.signer, alice.owner, _contextInput(alice.owner, agentC.agentId, "goals.career", "s16-c-1", GOAL, SOURCE_AGENT_INFERRED)
        );
        assertEq(contexts.latest(cEpoch1), cEpoch1);

        // 14. Alice revokes A and advances goals.career to epoch 2 in one transaction.
        ContextRegistry.ContextInput memory staleAfterRevoke =
            _contextInput(alice.owner, agentC.agentId, "goals.career", "s16-c-stale", GOAL, SOURCE_AGENT_INFERRED);
        vm.prank(alice.owner);
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 2));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        _expectSubmitRevert(
            agentC.signer, alice.owner, staleAfterRevoke, abi.encodeWithSelector(EpochStale.selector, career, uint64(1), uint64(2))
        );

        // 15. C writes a new object under epoch 2.
        bytes32 cEpoch2 = _submit(
            agentC.signer, alice.owner, _contextInput(alice.owner, agentC.agentId, "goals.career", "s16-c-2", GOAL, SOURCE_AGENT_INFERRED)
        );
        assertEq(contexts.getRecord(cEpoch2).readEpoch, 2);

        // 16-17. A's chain authorization fails; the remaining reader D is still authorized.
        assertFalse(registry.isAuthorized(alice.owner, agentA.agentId, career, PERM_READ));
        assertTrue(registry.isAuthorized(alice.owner, agentD.agentId, career, PERM_READ));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `forge test --match-path "test/{ContextLineage,Scenario}.t.sol"`
Expected: FAIL at compilation, because `ContextRegistry.ParentMismatch` does not exist yet.

- [ ] **Step 3: Implement supersession (full file replacement)**

Replace `contracts/src/ContextRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochRotationRequired,
    EpochStale,
    EvidenceImmutable,
    InvalidNamespace,
    KIND_MAX,
    KIND_NONE,
    LINEAGE_OWNER_CONTROLLED,
    LINEAGE_STANDARD,
    PERM_CREATE,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_EXTERNAL_ATTESTATION,
    PROV_ALLOW_IMPORTED,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    RECORD_CONTEXT,
    RECORD_EVIDENCE,
    SOURCE_AGENT_INFERRED,
    SOURCE_EXTERNAL_ATTESTATION,
    SOURCE_IMPORTED,
    SOURCE_NONE,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED,
    StaleParent
} from "./MidaTypes.sol";
import {ICapabilityRegistry} from "./ICapabilityRegistry.sol";
import {MidaHashing} from "./MidaHashing.sol";

/// @notice Immutable context and evidence records with contract-derived authorship, provenance rules
///         and lineage (spec §11). Holds no epoch keys: every write reads epoch validity from
///         CapabilityRegistry. No plaintext is ever stored here, only commitments.
contract ContextRegistry {
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

    error ZeroRegistry();
    error EmptyBatch();
    error InvalidRecord(bytes32 contextId);
    error ContextIdMismatch(bytes32 expected, bytes32 submitted);
    error DuplicateContext(bytes32 contextId);
    error ContextNotFound(bytes32 contextId);
    error ParentMismatch(bytes32 parentId);

    ICapabilityRegistry public immutable CAPABILITY_REGISTRY;

    mapping(bytes32 contextId => ContextRecord) private _records;
    mapping(bytes32 lineageId => bytes32 contextId) private _latest;

    event ContextRegistered(
        address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, ContextRecord record
    );
    event ContextSuperseded(
        address indexed owner, bytes32 indexed lineageId, bytes32 indexed contextId, bytes32 parentId, uint32 version
    );
    event EvidenceRegistered(
        address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, bytes32 author, bytes32 manifestHash
    );

    constructor(ICapabilityRegistry capabilityRegistry) {
        if (address(capabilityRegistry) == address(0)) revert ZeroRegistry();
        CAPABILITY_REGISTRY = capabilityRegistry;
    }

    /// @notice Registers a batch atomically. msg.sender is either the owner (author = bytes32(0)) or the
    ///         current signer of a registered agent (author = agentId) acting under that owner's capabilities.
    function register(address owner, ContextInput[] calldata inputs) external returns (bytes32[] memory contextIds) {
        if (inputs.length == 0) revert EmptyBatch();
        bytes32 author = _resolveAuthor(owner);
        contextIds = new bytes32[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            contextIds[i] = _registerOne(owner, author, inputs[i]);
        }
    }

    function getRecord(bytes32 contextId) external view returns (ContextRecord memory record) {
        record = _records[contextId];
        if (record.owner == address(0)) revert ContextNotFound(contextId);
    }

    function exists(bytes32 contextId) external view returns (bool) {
        return _records[contextId].owner != address(0);
    }

    /// @notice Canonical head of a context lineage; bytes32(0) for unknown lineages and for evidence ids.
    function latest(bytes32 lineageId) external view returns (bytes32) {
        return _latest[lineageId];
    }

    function _resolveAuthor(address owner) private view returns (bytes32 author) {
        if (owner == address(0)) revert CapabilityDenied();
        if (msg.sender == owner) return bytes32(0);
        author = CAPABILITY_REGISTRY.agentIdOfSigner(msg.sender);
        if (author == bytes32(0)) revert CapabilityDenied();
    }

    function _registerOne(address owner, bytes32 author, ContextInput calldata input) private returns (bytes32 contextId) {
        _validateShape(input);
        if (!CAPABILITY_REGISTRY.isRegisteredNamespace(input.namespaceId)) revert InvalidNamespace(input.namespaceId);

        contextId = MidaHashing.contextId(block.chainid, address(this), owner, author, input.namespaceId, input.objectNonce);
        if (input.contextId != contextId) revert ContextIdMismatch(contextId, input.contextId);
        if (_records[contextId].owner != address(0)) revert DuplicateContext(contextId);

        uint64 required = CAPABILITY_REGISTRY.requiredReadEpoch(owner, input.namespaceId);
        if (input.readEpoch != required) revert EpochStale(input.namespaceId, input.readEpoch, required);
        if (!CAPABILITY_REGISTRY.isWriteEpochValid(owner, input.namespaceId, required)) {
            revert EpochRotationRequired(input.namespaceId, required);
        }

        if (input.recordType == RECORD_EVIDENCE) {
            if (author != bytes32(0)) _requireAgentAuthority(owner, author, input.namespaceId, PERM_CREATE, 0);
            _store(owner, author, input, contextId, bytes32(0), bytes32(0), 1);
            emit EvidenceRegistered(owner, input.namespaceId, contextId, author, input.manifestHash);
            return contextId;
        }

        uint8 provenanceBits = _provenanceBits(author == bytes32(0), input);
        if (input.expectedParentId == bytes32(0)) {
            _registerRoot(owner, author, input, contextId, provenanceBits);
        } else {
            _supersede(owner, author, input, contextId, provenanceBits);
        }
    }

    /// @dev Enum ranges, non-zero commitments, and the evidence/context split of spec §11.7.
    function _validateShape(ContextInput calldata input) private pure {
        if (
            input.recordType > RECORD_EVIDENCE || input.lineagePolicy > LINEAGE_OWNER_CONTROLLED || input.kind > KIND_MAX
                || input.provenanceSource > SOURCE_EXTERNAL_ATTESTATION || input.manifestHash == bytes32(0)
                || input.ciphertextCommitment == bytes32(0)
        ) revert InvalidRecord(input.contextId);
        if (input.recordType == RECORD_EVIDENCE) {
            if (
                input.expectedParentId != bytes32(0) || input.lineagePolicy != LINEAGE_STANDARD || input.kind != KIND_NONE
                    || input.provenanceSource != SOURCE_NONE
            ) revert InvalidRecord(input.contextId);
        } else if (input.recordType == RECORD_CONTEXT) {
            if (input.kind == KIND_NONE || input.provenanceSource == SOURCE_NONE) revert InvalidRecord(input.contextId);
        }
    }

    /// @dev Spec §11.8. Returns the provenance-policy bits an agent's capability must carry.
    function _provenanceBits(bool ownerAuthored, ContextInput calldata input) private pure returns (uint8) {
        uint8 source = input.provenanceSource;
        bool hasEvidence = input.evidenceCommitment != bytes32(0);
        if (source == SOURCE_USER_ASSERTED) {
            if (!ownerAuthored) revert ProvenanceForbidden();
            return 0;
        }
        if (source == SOURCE_USER_CONFIRMED) {
            if (!ownerAuthored || !hasEvidence) revert ProvenanceForbidden();
            return 0;
        }
        if (source == SOURCE_AGENT_INFERRED) {
            if (ownerAuthored) revert ProvenanceForbidden();
            return PROV_ALLOW_INFERENCE;
        }
        if (!hasEvidence) revert ProvenanceForbidden();
        if (ownerAuthored) return 0;
        return source == SOURCE_IMPORTED ? PROV_ALLOW_IMPORTED : PROV_ALLOW_EXTERNAL_ATTESTATION;
    }

    function _registerRoot(address owner, bytes32 author, ContextInput calldata input, bytes32 contextId, uint8 provenanceBits)
        private
    {
        if (author != bytes32(0)) {
            if (input.lineagePolicy != LINEAGE_STANDARD) revert AnchorOwnerOnly();
            _requireAgentAuthority(owner, author, input.namespaceId, PERM_CREATE, provenanceBits);
        }
        _store(owner, author, input, contextId, contextId, bytes32(0), 1);
        _latest[contextId] = contextId;
    }

    /// @dev Spec §11.6. The parent must be the current head of a context lineage with the same owner and
    ///      namespace. Agents need SUPERSEDE_OWN on their own lineage or SUPERSEDE_ANY on another author's
    ///      STANDARD lineage; no agent may supersede an OWNER_CONTROLLED lineage.
    function _supersede(address owner, bytes32 author, ContextInput calldata input, bytes32 contextId, uint8 provenanceBits)
        private
    {
        bytes32 parentId = input.expectedParentId;
        ContextRecord storage parent = _records[parentId];
        if (parent.owner == address(0)) revert ContextNotFound(parentId);
        if (parent.recordType == RECORD_EVIDENCE) revert EvidenceImmutable(parentId);
        if (parent.owner != owner || parent.namespaceId != input.namespaceId) revert ParentMismatch(parentId);

        bytes32 lineageId = parent.lineageId;
        bytes32 head = _latest[lineageId];
        if (head != parentId) revert StaleParent(parentId, head);

        ContextRecord storage root = _records[lineageId];
        // Owner-controlled status is fixed at the root and can never be added or removed later.
        if (input.lineagePolicy != root.lineagePolicy) revert InvalidRecord(input.contextId);
        if (author != bytes32(0)) {
            if (root.lineagePolicy == LINEAGE_OWNER_CONTROLLED) revert AnchorOwnerOnly();
            _requireSupersedeAuthority(owner, author, input.namespaceId, root.author == author, provenanceBits);
        }

        uint32 version = parent.version + 1;
        _store(owner, author, input, contextId, lineageId, parentId, version);
        _latest[lineageId] = contextId;
        emit ContextSuperseded(owner, lineageId, contextId, parentId, version);
    }

    function _requireSupersedeAuthority(
        address owner,
        bytes32 agentId,
        bytes32 namespaceId,
        bool ownLineage,
        uint8 provenanceBits
    ) private view {
        bool viaOwn = ownLineage && CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_OWN, 0);
        bool viaAny = CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_ANY, 0);
        if (!viaOwn && !viaAny) revert CapabilityDenied();
        if (provenanceBits == 0) return;
        bool bitsViaOwn =
            ownLineage && CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_OWN, provenanceBits);
        bool bitsViaAny = CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_ANY, provenanceBits);
        if (!bitsViaOwn && !bitsViaAny) revert ProvenanceForbidden();
    }

    /// @dev One exact capability must carry the permission; if provenance bits are required, the same
    ///      capability must carry them too (CapabilityRegistry.hasAuthority checks both together).
    function _requireAgentAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permission, uint8 provenanceBits)
        private
        view
    {
        if (!CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, permission, 0)) revert CapabilityDenied();
        if (provenanceBits != 0 && !CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, permission, provenanceBits)) {
            revert ProvenanceForbidden();
        }
    }

    function _store(
        address owner,
        bytes32 author,
        ContextInput calldata input,
        bytes32 contextId,
        bytes32 lineageId,
        bytes32 parentId,
        uint32 version
    ) private {
        ContextRecord memory record = ContextRecord({
            contextId: contextId,
            owner: owner,
            author: author,
            namespaceId: input.namespaceId,
            lineageId: lineageId,
            parentId: parentId,
            manifestHash: input.manifestHash,
            ciphertextCommitment: input.ciphertextCommitment,
            evidenceCommitment: input.evidenceCommitment,
            readEpoch: input.readEpoch,
            createdAt: uint64(block.timestamp),
            expiresAt: input.expiresAt,
            version: version,
            recordType: input.recordType,
            lineagePolicy: input.lineagePolicy,
            kind: input.kind,
            provenanceSource: input.provenanceSource
        });
        _records[contextId] = record;
        emit ContextRegistered(owner, input.namespaceId, contextId, record);
    }
}
```

- [ ] **Step 4: Run the full contract suite on both P256 paths**

Run:
```bash
forge test --match-path "test/{ContextLineage,Scenario}.t.sol"
forge test
forge test --evm-version prague
forge build --sizes | grep -E "ContextRegistry|CapabilityRegistry"
```
Expected: `ContextLineageTest` `18 passed`, `ScenarioTest` `1 passed`. `forge test` ends with `10 test suites … 139 tests passed, 0 failed, 1 skipped (140 total tests)`. The prague run also has 0 failures, with the other `P256PathsTest` case skipped instead. Sizes are about 20,300 bytes for `CapabilityRegistry` and 6,800 bytes for `ContextRegistry`.

- [ ] **Step 5: Add the deployment script**

```bash
mkdir -p deployments
touch deployments/.gitkeep
```

Append this line to the repository-root `.gitignore`, so local Anvil deployments are never committed while the Monad testnet file (Task 27) is:
```text
contracts/deployments/31337.json
```

`contracts/script/Deploy.s.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {ICapabilityRegistry} from "../src/ICapabilityRegistry.sol";

/// @notice Deploys CapabilityRegistry then ContextRegistry and writes deployments/<chainId>.json for the
///         SDK, API and indexer. VAULT_RP_ID defaults to vault.mida.xyz.
///         forge script script/Deploy.s.sol --rpc-url <url> --broadcast --private-key <key>
contract Deploy is Script {
    function run() external returns (CapabilityRegistry capabilityRegistry, ContextRegistry contextRegistry) {
        string memory vaultRpId = vm.envOr("VAULT_RP_ID", string("vault.mida.xyz"));
        uint256 deploymentBlock = block.number;

        vm.startBroadcast();
        capabilityRegistry = new CapabilityRegistry(vaultRpId);
        contextRegistry = new ContextRegistry(ICapabilityRegistry(address(capabilityRegistry)));
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deploymentBlock", deploymentBlock);
        vm.serializeString(key, "vaultRpId", vaultRpId);
        vm.serializeBytes32(key, "vaultRpIdHash", capabilityRegistry.VAULT_RP_ID_HASH());
        vm.serializeBytes32(key, "policyHashV1", capabilityRegistry.POLICY_HASH_V1());
        vm.serializeAddress(key, "capabilityRegistry", address(capabilityRegistry));
        string memory json = vm.serializeAddress(key, "contextRegistry", address(contextRegistry));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("CapabilityRegistry", address(capabilityRegistry));
        console2.log("ContextRegistry", address(contextRegistry));
        console2.log("wrote", path);
    }
}
```

- [ ] **Step 6: Deploy to a local Anvil and read the result back**

In a second terminal, from `contracts/`, start Anvil at its default (Osaka) hardfork:
```bash
anvil
```

In the first terminal, from `contracts/`. The private key below is Anvil's public, pre-funded development account 0. Never use it on any real network.
```bash
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cat deployments/31337.json
CAP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("deployments/31337.json","utf8")).capabilityRegistry)')
CTX=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("deployments/31337.json","utf8")).contextRegistry)')
cast call "$CAP" "POLICY_HASH_V1()(bytes32)" --rpc-url http://127.0.0.1:8545
cast call "$CAP" "NAMESPACE_COUNT()(uint256)" --rpc-url http://127.0.0.1:8545
cast call "$CAP" "vaultRpId()(string)" --rpc-url http://127.0.0.1:8545
cast call "$CTX" "CAPABILITY_REGISTRY()(address)" --rpc-url http://127.0.0.1:8545
```
Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.` and `wrote deployments/31337.json`. On a fresh Anvil the addresses are `CapabilityRegistry 0x5FbDB2315678afecb367f032d93F642f64180aa3` and `ContextRegistry 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`. The JSON has the seven keys listed in Interfaces, with `vaultRpIdHash` `0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb`. The reads return the same `policyHashV1` as the JSON, `22`, `"vault.mida.xyz"`, and the `CapabilityRegistry` address. Stop Anvil with Ctrl+C.

If `vm.writeJson` fails with `is not allowed to be accessed for write operations`, `foundry.toml` is missing the `read-write` permission for `./deployments` from Task 14 Step 1.

- [ ] **Step 7: Commit**

```bash
cd ..
git add .gitignore contracts/src/ContextRegistry.sol contracts/test/ContextLineage.t.sol contracts/test/Scenario.t.sol contracts/script/Deploy.s.sol contracts/deployments/.gitkeep
git commit -m "feat(contracts): stale-parent-safe supersession, anchors, section 16 on-chain scenario and deploy script

Claude-Session: https://claude.ai/code/session_01Gjzo41PhP1bgEgNxYyz2Sk"
```

---

## Part D completion check

Run from `contracts/` before starting Part E:
```bash
forge test
forge test --evm-version prague
forge test --match-contract P256PathsTest -vv
forge test --match-contract P256PathsTest -vv --evm-version prague
```
Expected: no failures in either full run; the two path runs each pass one path and skip the other, with gas about 55,000 (native) and 400,000 (fallback).

**What Part E can rely on:**
- ABIs: `contracts/out/CapabilityRegistry.sol/CapabilityRegistry.json` and `contracts/out/ContextRegistry.sol/ContextRegistry.json` after `forge build`.
- Addresses and the log-scan start block: `contracts/deployments/<chainId>.json`.
- Every identifier and EIP-712 digest in Part A Task 5 is byte-identical on-chain, as `ParityTest` proves.
- Revert names to map to §12.6 codes: `CapabilityDenied` → `CAPABILITY_DENIED`, `EpochRotationRequired` → `EPOCH_ROTATION_REQUIRED`, `EpochStale` → `EPOCH_STALE`, `StaleParent` → `STALE_PARENT`, `EvidenceImmutable` → `EVIDENCE_IMMUTABLE`, `ProvenanceForbidden` → `PROVENANCE_FORBIDDEN`, `AnchorOwnerOnly` → `ANCHOR_OWNER_ONLY`, `InvalidNamespace` → `INVALID_NAMESPACE`.
- An expired capability is rejected when `block.timestamp >= expiresAt`; a write epoch is closed when `block.timestamp >= writeDeadline`. The API must use the same inclusive boundary.

**What Part D does not prove:** Monad's native P256 path (Task 27), anything off-chain (manifest bodies, wraps, decryption, API deny overlay), and the real policy hash until Part C Task 10 exports it.
