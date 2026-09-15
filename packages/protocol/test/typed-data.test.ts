import { describe, expect, it } from "vitest"
import { hashTypedData, keccak256, recoverTypedDataAddress } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Hex } from "viem"
import {
  ACCESS_REQUEST_TYPES,
  AGENT_REGISTRATION_TYPES,
  DOMAIN_NAMES,
  HTTP_REQUEST_TYPES,
  MANIFEST_BINDING_TYPES,
  SIGNER_ROTATION_TYPES,
  accessRequestHash,
  accessRequestTypedData,
  canonicalTarget,
  hashString,
  httpRequestTypedData,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type { UnsignedAccessRequest } from "@mida/protocol"

const REGISTRY = "0x1111111111111111111111111111111111111111"
const A32: Hex = `0x${"aa".repeat(32)}`
const B32: Hex = `0x${"bb".repeat(32)}`
const C32: Hex = `0x${"cc".repeat(32)}`

const request: UnsignedAccessRequest = {
  v: 1,
  chainId: "31337",
  capabilityRegistry: REGISTRY,
  requestId: A32,
  nonce: B32,
  agentId: C32,
  purposeId: "career_coaching",
  callbackOrigin: "https://career.example",
  manifestHash: A32,
  manifestVersion: 1,
  policyVersion: "mida-grant-policy-v1",
  namespaceTreeVersion: "mida-namespace-tree-v1",
  scopes: sortScopes([
    { namespaceId: namespaceId("goals.career"), permissions: 1, provenancePolicy: 0 },
    { namespaceId: namespaceId("financial"), permissions: 1, provenancePolicy: 0 },
  ]),
  issuedAt: "1000",
  requestExpiresAt: "1600",
  capabilityExpiresAt: "0",
}

const fields = (list: ReadonlyArray<{ name: string; type: string }>) => list.map((f) => `${f.type} ${f.name}`)

describe("EIP-712 struct definitions are frozen (plan Task 5)", () => {
  it("matches the Solidity type strings field for field", () => {
    expect(fields(ACCESS_REQUEST_TYPES.MidaAccessRequestV1)).toEqual([
      "bytes32 requestId", "bytes32 nonce", "bytes32 agentId", "bytes32 purposeIdHash", "bytes32 callbackOriginHash",
      "bytes32 manifestHash", "uint64 manifestVersion", "bytes32 policyVersionHash", "bytes32 namespaceTreeVersionHash",
      "bytes32 scopesHash", "uint64 issuedAt", "uint64 requestExpiresAt", "uint64 capabilityExpiresAt",
    ])
    expect(fields(MANIFEST_BINDING_TYPES.ManifestBinding)).toEqual([
      "bytes32 bodyHash", "bytes32 agentId", "uint64 manifestVersion",
    ])
    expect(fields(HTTP_REQUEST_TYPES.MidaHttpRequestV1)).toEqual([
      "address signer", "bytes32 methodHash", "bytes32 targetHash", "bytes32 bodyHash", "uint64 timestamp", "bytes32 nonce",
    ])
    expect(fields(AGENT_REGISTRATION_TYPES.MidaAgentRegistrationV1)).toEqual([
      "bytes32 agentId", "address operator", "address signer", "bytes32 encryptionPublicKey", "uint32 encryptionKeyVersion",
      "bytes32 callbackOriginHash", "bytes32 capabilityManifestHash", "uint64 capabilityManifestVersion",
    ])
    expect(fields(SIGNER_ROTATION_TYPES.MidaSignerRotationV1)).toEqual([
      "bytes32 agentId", "address newSigner", "uint64 rotationNonce",
    ])
    expect(DOMAIN_NAMES).toEqual({
      capabilityRegistry: "Mida Capability Registry",
      accessRequest: "Mida Context",
      manifest: "Mida Agent Capability Manifest",
      httpRequest: "Mida Context API",
    })
  })
})

describe("access request signing (§13.2)", () => {
  it("round-trips a signature and binds the domain to chain and registry", async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const typedData = accessRequestTypedData(request)
    expect(typedData.domain).toEqual({ name: "Mida Context", version: "1", chainId: 31337n, verifyingContract: REGISTRY })
    const signature = await account.signTypedData(typedData)
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(account.address)
    expect(accessRequestHash(request)).toBe(hashTypedData(typedData))
  })

  it("changes the request hash when authority or expiry changes", () => {
    const base = accessRequestHash(request)
    const broader = { ...request, scopes: request.scopes.map((s) => ({ ...s, permissions: 3 })) }
    expect(accessRequestHash(broader)).not.toBe(base)
    expect(accessRequestHash({ ...request, capabilityExpiresAt: "5000" })).not.toBe(base)
    expect(accessRequestHash({ ...request, chainId: "10143" })).not.toBe(base)
  })
})

describe("HTTP request authentication (§12.1)", () => {
  it("builds a canonical target with sorted query parameters", () => {
    expect(canonicalTarget("/epoch-wraps", { readEpoch: "2", owner: "0xab", agentId: "0x01" })).toBe(
      "/epoch-wraps?agentId=0x01&owner=0xab&readEpoch=2",
    )
    expect(canonicalTarget("/objects")).toBe("/objects")
  })

  it("uppercases the method and hashes an empty body as keccak256 of no bytes", () => {
    const typed = httpRequestTypedData({
      chainId: 31337n, capabilityRegistry: REGISTRY, signer: REGISTRY, method: "get",
      target: "/objects", body: new Uint8Array(), timestamp: 1_000n, nonce: A32,
    })
    expect(typed.message.methodHash).toBe(hashString("GET"))
    expect(typed.message.bodyHash).toBe(keccak256(new Uint8Array()))
    expect(typed.message.bodyHash).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    expect(typed.domain.name).toBe("Mida Context API")
  })
})
