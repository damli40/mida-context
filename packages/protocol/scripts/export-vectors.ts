/**
 * Writes contracts/test/vectors/ids-v1.json: fixed-input vectors that Solidity parity tests
 * (plan Task 14) must reproduce byte for byte. Re-run after any change to ids.ts or typed-data.ts.
 * Usage: pnpm vectors:ids [outputPath]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { hashTypedData, keccak256, stringToBytes, toHex, zeroHash } from "viem"
import type { Address, Hex } from "viem"
import {
  NAMESPACE_TREE_V1,
  BATCH_SAVE_TYPEHASH,
  accessRequestHash,
  agentId,
  agentRegistrationTypedData,
  batchContextId,
  batchLeafHash,
  batchSaveDigest,
  batchSaveStructHash,
  canonicalReferences,
  capabilityId,
  contextId,
  evidenceCommitment,
  grantDigest,
  hashString,
  headCommit,
  httpRequestTypedData,
  manifestBindingTypedData,
  merkleRoot,
  namespaceId,
  originHash,
  p256RotationDigest,
  scopesHash,
  signerRotationTypedData,
  sortScopes,
} from "../src/index.js"
import type { BatchSaveMessage, UnsignedAccessRequest } from "../src/index.js"

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

// --- batch-v1.json: fixed-input vectors for the BatchAnchor parity tests (BatchParity.t.sol) ---

const batchOut = fileURLToPath(new URL("../../../contracts/test/vectors/batch-v1.json", import.meta.url))

const BATCH_CHAIN_ID = 10143n
const BATCH_ANCHOR: Address = "0x1111111111111111111111111111111111111111"
const BATCH_AGENT_ID = keccak256(toHex("agent"))
const BATCH_NAMESPACE_ID = keccak256(toHex("ns"))
const BATCH_OBJECT_NONCE = keccak256(toHex("nonce"))

const batchMessage: BatchSaveMessage = {
  owner: OWNER,
  namespaceId: BATCH_NAMESPACE_ID,
  objectNonce: BATCH_OBJECT_NONCE,
  lineageId: zeroHash,
  parentId: zeroHash,
  parentVersion: 0,
  rootAuthor: zeroHash,
  manifestHash: keccak256(toHex("m")),
  ciphertextCommitment: keccak256(toHex("c")),
  readEpoch: 1n,
  expiresAt: 0n,
  kind: 5,
  provenanceSource: 3,
}

const batchContext = batchContextId({
  chainId: BATCH_CHAIN_ID,
  batchAnchor: BATCH_ANCHOR,
  owner: OWNER,
  agentId: BATCH_AGENT_ID,
  namespaceId: BATCH_NAMESPACE_ID,
  parentId: zeroHash,
  objectNonce: BATCH_OBJECT_NONCE,
})
const batchStructHash = batchSaveStructHash(batchMessage)
const batchLeaves = Array.from({ length: 5 }, (_, i) => keccak256(toHex(`leaf-${i}`)))

const batchVectors = {
  chainId: Number(BATCH_CHAIN_ID),
  batchAnchor: BATCH_ANCHOR,
  owner: OWNER,
  agentId: BATCH_AGENT_ID,
  namespaceId: BATCH_NAMESPACE_ID,
  objectNonce: BATCH_OBJECT_NONCE,
  parentId: zeroHash,
  message: {
    owner: batchMessage.owner,
    namespaceId: batchMessage.namespaceId,
    objectNonce: batchMessage.objectNonce,
    lineageId: batchMessage.lineageId,
    parentId: batchMessage.parentId,
    parentVersion: batchMessage.parentVersion,
    rootAuthor: batchMessage.rootAuthor,
    manifestHash: batchMessage.manifestHash,
    ciphertextCommitment: batchMessage.ciphertextCommitment,
    readEpoch: batchMessage.readEpoch.toString(),
    expiresAt: batchMessage.expiresAt.toString(),
    kind: batchMessage.kind,
    provenanceSource: batchMessage.provenanceSource,
  },
  typehash: BATCH_SAVE_TYPEHASH,
  structHash: batchStructHash,
  digest: batchSaveDigest({ chainId: BATCH_CHAIN_ID, batchAnchor: BATCH_ANCHOR, message: batchMessage }),
  contextId: batchContext,
  leafHash: batchLeafHash({
    contextId: batchContext, agentId: BATCH_AGENT_ID, lineageId: batchContext, version: 1, structHash: batchStructHash,
  }),
  headCommit: headCommit({
    contextId: batchContext, owner: OWNER, namespaceId: BATCH_NAMESPACE_ID, rootAuthor: BATCH_AGENT_ID, version: 1,
  }),
  leaves: batchLeaves,
  root: merkleRoot(batchLeaves),
}

mkdirSync(dirname(batchOut), { recursive: true })
writeFileSync(batchOut, `${JSON.stringify(batchVectors, null, 2)}\n`)
console.log(`wrote ${batchOut}`)
