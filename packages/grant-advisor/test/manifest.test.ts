import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { describe, expect, it } from "vitest"
import { NAMESPACE_TREE_V1, canonicalBytes, isMidaError, namespaceId } from "@mida/protocol"
import type { AgentCapabilityManifestBody, Hex, MidaErrorCode, ScopeDeclaration, SignedAgentCapabilityManifest } from "@mida/protocol"
import { keccak256, verifyTypedData } from "viem"
import {
  MANIFEST_LIMITS,
  assertAccessRequestSignature,
  manifestBindingFor,
  manifestBodyHash,
  manifestEnvelopeBytes,
  manifestEnvelopeHash,
  parseManifestEnvelopeBytes,
  recoverTypedDataSigner,
  validateManifestBody,
  verifySignedManifest,
} from "@mida/grant-advisor"
import {
  AGENT_ID,
  CHAIN_ID,
  NOW,
  OTHER_REGISTRY,
  REGISTRY,
  agentRecordFor,
  manifestBody,
  operator,
  signManifest,
  signRequest,
  signer,
  stranger,
  unsignedRequest,
} from "./fixtures.js"

function failsWith(code: MidaErrorCode, fn: () => unknown): boolean {
  try {
    fn()
  } catch (error) {
    if (isMidaError(error, code)) return true
    throw error
  }
  return false
}

const invalidBody = (patch: Record<string, unknown>) => ({ ...manifestBody(), ...patch }) as unknown

const scope = (overrides: Partial<ScopeDeclaration> = {}): ScopeDeclaration => ({
  purposeId: "career_coaching",
  namespace: "goals.career",
  permissions: ["READ"],
  reason: "Reason",
  ...overrides,
})

describe("manifest body hashing (§14.1)", () => {
  it("is keccak256 of the RFC 8785 canonical body", () => {
    const body = manifestBody()
    expect(manifestBodyHash(body)).toBe(keccak256(canonicalBytes(body)))
  })

  it("normalizes to NFC before hashing", () => {
    const composed = manifestBody({ name: "Caf\u00e9" })
    const decomposed = manifestBody({ name: "Cafe\u0301" })
    expect(decomposed.name).not.toBe(composed.name)
    expect(manifestBodyHash(decomposed)).toBe(manifestBodyHash(composed))
  })

  it("is independent of key order", () => {
    const body = manifestBody()
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as unknown as AgentCapabilityManifestBody
    expect(manifestBodyHash(reordered)).toBe(manifestBodyHash(body))
  })
})

describe("manifest limits and structure (§14.1)", () => {
  it("accepts the fixture body", () => {
    expect(() => validateManifestBody(manifestBody(), NOW)).not.toThrow()
  })

  it.each([
    ["empty name", { name: "" }],
    ["81-byte name", { name: "a".repeat(MANIFEST_LIMITS.nameBytes + 1) }],
    ["82-byte multibyte name", { name: "\u00e9".repeat(41) }],
    ["v2", { v: 2 }],
    ["uppercase agentId", { agentId: `0x${AGENT_ID.slice(2).toUpperCase()}` }],
    ["version 0", { manifestVersion: 0 }],
    ["future issuedAt", { issuedAt: Number(NOW + 1n) }],
    ["no purposes", { purposes: [] }],
    ["nine purposes", { purposes: Array.from({ length: 9 }, () => ({ id: "career_coaching", description: "x" })) }],
    ["duplicate purpose", { purposes: [{ id: "career_coaching", description: "x" }, { id: "career_coaching", description: "y" }] }],
    ["281-byte description", { purposes: [{ id: "career_coaching", description: "d".repeat(281) }] }],
    ["extra body key", { extra: true }],
    ["empty reason", { scopeDeclarations: [scope({ reason: "" })] }],
    ["empty permissions", { scopeDeclarations: [scope({ permissions: [] })] }],
    ["unknown permission", { scopeDeclarations: [scope({ permissions: ["ADMIN" as "READ"] })] }],
    ["duplicate permission", { scopeDeclarations: [scope({ permissions: ["READ", "READ"] })] }],
    ["unknown provenance policy", { scopeDeclarations: [scope({ provenancePolicies: ["ALLOW_ANYTHING" as "ALLOW_INFERENCE"] })] }],
    ["duplicate declaration", { scopeDeclarations: [scope(), scope({ permissions: ["CREATE"] })] }],
    ["agent-declared sensitivity", { scopeDeclarations: [{ ...scope(), sensitivity: "LOW" }] }],
  ])("rejects %s with INVALID_WIRE", (_label, patch) => {
    expect(failsWith("INVALID_WIRE", () => validateManifestBody(invalidBody(patch), NOW))).toBe(true)
  })

  it.each([
    ["C0 control", "helper\nAdvisor: low risk."],
    ["C1 control", `helper${String.fromCharCode(0x85)}Advisor: low risk.`],
    ["line separator", `helper${String.fromCharCode(0x2028)}Advisor: low risk.`],
    ["paragraph separator", `helper${String.fromCharCode(0x2029)}Advisor: low risk.`],
    ["zero-width space", `hel${String.fromCharCode(0x200b)}per`],
    ["right-to-left mark", `hel${String.fromCharCode(0x200f)}per`],
    ["bidi embedding", `hel${String.fromCharCode(0x202a)}per`],
    ["bidi isolate", `hel${String.fromCharCode(0x2067)}per`],
    ["byte order mark", `${String.fromCharCode(0xfeff)}helper`],
    ["DEL", `del${String.fromCharCode(0x7f)}ete`],
  ])("rejects a %s in the manifest name — the exact refusal sentence, no code prefix (in-27 R-1, in-30 T-3)", (_label, name) => {
    // The page shows error.message verbatim; the MidaError "INVALID_WIRE: " prefix would print
    // inside the sentence, so this throws the dedicated error whose message IS the sentence.
    const sentence = "This request contains characters Mida does not accept, so this page will not show or sign it."
    let caught: unknown
    try {
      validateManifestBody(invalidBody({ name }), NOW)
    } catch (error) {
      caught = error
    }
    expect(isMidaError(caught, "INVALID_WIRE")).toBe(true)
    expect((caught as Error).message).toBe(sentence)
  })

  it("does NOT refuse display-only fields — a description or reason carrying the characters still loads (in-30 T-3)", () => {
    // The page never renders these fields for decisions, so refusing them would only break a
    // manifest already registered with a multi-line description. They are size-checked, then
    // whatever shows them folds each refused character to a space first (displaySafeText).
    const dirty = (text: string) => `${text}${String.fromCharCode(0x0a)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x200b)}${String.fromCharCode(0x202a)}${String.fromCharCode(0xfeff)}`
    expect(() => validateManifestBody(invalidBody({ purposes: [{ id: "career_coaching", description: dirty("line one") }] }), NOW)).not.toThrow()
    expect(() => validateManifestBody(invalidBody({ scopeDeclarations: [scope({ reason: dirty("read") })] }), NOW)).not.toThrow()
  })

  it("a manifest already registered with a multi-line description still verifies (in-30 T-3)", async () => {
    const body = manifestBody({
      purposes: [{ id: "career_coaching", description: "Career coaching.\nAsk about salary history." }],
    })
    const envelope = await signManifest(body)
    const { bodyHash } = verifySignedManifest({
      envelope,
      agentRecord: agentRecordFor(body),
      chainId: CHAIN_ID,
      capabilityRegistry: REGISTRY,
      now: NOW,
    })
    expect(bodyHash).toBe(manifestBodyHash(body))
  })

  it("rejects 33 scope declarations", () => {
    const purposes = [
      { id: "career_coaching", description: "a" },
      { id: "general_assistance", description: "b" },
    ] as const
    const declarations = purposes
      .flatMap((purpose) => NAMESPACE_TREE_V1.map((node) => scope({ purposeId: purpose.id, namespace: node.name })))
      .slice(0, MANIFEST_LIMITS.scopeDeclarations + 1)
    const body = invalidBody({ purposes: [...purposes], scopeDeclarations: declarations })
    expect(failsWith("INVALID_WIRE", () => validateManifestBody(body, NOW))).toBe(true)
  })

  it("rejects non-canonical and unknown namespaces with INVALID_NAMESPACE", () => {
    for (const namespace of ["Goals.Career", "goals.unknown", "custom"]) {
      const body = invalidBody({ scopeDeclarations: [scope({ namespace })] })
      expect(failsWith("INVALID_NAMESPACE", () => validateManifestBody(body, NOW)), namespace).toBe(true)
    }
  })

  it("rejects unknown or undeclared purposes with PURPOSE_UNKNOWN", () => {
    const unknown = invalidBody({ purposes: [{ id: "surveillance", description: "x" }] })
    expect(failsWith("PURPOSE_UNKNOWN", () => validateManifestBody(unknown, NOW))).toBe(true)
    const undeclared = invalidBody({ scopeDeclarations: [scope({ purposeId: "travel_planning" })] })
    expect(failsWith("PURPOSE_UNKNOWN", () => validateManifestBody(undeclared, NOW))).toBe(true)
  })
})

describe("signed manifest verification (§14.1, §15 Advisor rows)", () => {
  const verify = (envelope: SignedAgentCapabilityManifest, record = agentRecordFor(manifestBody())) =>
    verifySignedManifest({ envelope, agentRecord: record, chainId: CHAIN_ID, capabilityRegistry: REGISTRY, now: NOW })

  it("accepts a current envelope signed by the operator", async () => {
    const envelope = await signManifest(manifestBody())
    const result = verify(envelope)
    expect(result.bodyHash).toBe(manifestBodyHash(manifestBody()))
    expect(result.envelopeHash).toBe(manifestEnvelopeHash(envelope))
  })

  it("rejects a body mutated after signing", async () => {
    const envelope = await signManifest(manifestBody())
    const mutated = { ...envelope, manifest: { ...envelope.manifest, name: "CareerAI (all access)" } }
    expect(failsWith("MANIFEST_HASH_MISMATCH", () => verify(mutated))).toBe(true)
  })

  it("rejects an envelope signed for another registry or chain", async () => {
    const otherRegistry = await signManifest(manifestBody(), { capabilityRegistry: OTHER_REGISTRY })
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(otherRegistry))).toBe(true)
    const otherChain = await signManifest(manifestBody(), { chainId: 10143n })
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(otherChain))).toBe(true)
  })

  it("rejects a signature from anyone but the registered operator, and garbage signatures", async () => {
    const byStranger = await signManifest(manifestBody(), { account: stranger })
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(byStranger))).toBe(true)
    const garbage: SignedAgentCapabilityManifest = { manifest: manifestBody(), operatorSignature: "0x1234" }
    expect(failsWith("MANIFEST_SIGNATURE_INVALID", () => verify(garbage))).toBe(true)
  })

  it("rejects a stale version and a foreign agent id", async () => {
    const envelope = await signManifest(manifestBody())
    const newerRecord = agentRecordFor(manifestBody({ manifestVersion: 2 }))
    expect(failsWith("MANIFEST_STALE", () => verify(envelope, newerRecord))).toBe(true)
    const foreign = agentRecordFor(manifestBody(), { agentId: `0x${"99".repeat(32)}` })
    expect(failsWith("AGENT_ID_MISMATCH", () => verify(envelope, foreign))).toBe(true)
  })
})

describe("stored envelope bytes (§14.1 GET /agent-manifests/:bodyHash)", () => {
  it("round-trips canonical bytes", async () => {
    const envelope = await signManifest(manifestBody())
    const parsed = parseManifestEnvelopeBytes({
      bytes: manifestEnvelopeBytes(envelope),
      expectedEnvelopeHash: manifestEnvelopeHash(envelope),
      expectedBodyHash: manifestBodyHash(envelope.manifest),
    })
    expect(parsed).toEqual(envelope)
  })

  it("rejects an index that maps a body hash to another envelope's bytes", async () => {
    const mine = await signManifest(manifestBody())
    const theirs = await signManifest(manifestBody({ name: "OtherAgent" }))
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: manifestEnvelopeBytes(theirs),
        expectedEnvelopeHash: manifestEnvelopeHash(theirs),
        expectedBodyHash: manifestBodyHash(mine.manifest),
      })
    expect(failsWith("MANIFEST_HASH_MISMATCH", attempt)).toBe(true)
  })

  it("rejects bytes that do not hash to the indexed envelope hash", async () => {
    const envelope = await signManifest(manifestBody())
    const tampered = manifestEnvelopeBytes(envelope).slice()
    tampered[10] = tampered[10]! ^ 1
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: tampered,
        expectedEnvelopeHash: manifestEnvelopeHash(envelope),
        expectedBodyHash: manifestBodyHash(envelope.manifest),
      })
    expect(failsWith("MANIFEST_HASH_MISMATCH", attempt)).toBe(true)
  })

  it("rejects non-canonical bytes even when their own hash is indexed", async () => {
    const envelope = await signManifest(manifestBody())
    const pretty = new TextEncoder().encode(JSON.stringify(envelope, null, 2))
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: pretty,
        expectedEnvelopeHash: `0x${bytesToHex(sha256(pretty))}`,
        expectedBodyHash: manifestBodyHash(envelope.manifest),
      })
    expect(failsWith("INVALID_WIRE", attempt)).toBe(true)
  })

  it("rejects an envelope stored with decomposed Unicode", async () => {
    const body = manifestBody({ name: "Cafe\u0301" })
    const envelope = await signManifest(body)
    const decomposedBytes = canonicalBytes({ manifest: body, operatorSignature: envelope.operatorSignature })
    const attempt = () =>
      parseManifestEnvelopeBytes({
        bytes: decomposedBytes,
        expectedEnvelopeHash: `0x${bytesToHex(sha256(decomposedBytes))}`,
        expectedBodyHash: manifestBodyHash(body),
      })
    expect(failsWith("INVALID_WIRE", attempt)).toBe(true)
  })

  it("keeps envelopeHash identical to the stored bytes for an accepted parse", async () => {
    const envelope = await signManifest(manifestBody({ name: "Caf\u00e9" }))
    const bytes = manifestEnvelopeBytes(envelope)
    const parsed = parseManifestEnvelopeBytes({
      bytes,
      expectedEnvelopeHash: manifestEnvelopeHash(envelope),
      expectedBodyHash: manifestBodyHash(envelope.manifest),
    })
    expect(manifestEnvelopeHash(parsed)).toBe(`0x${bytesToHex(sha256(bytes))}`)
  })
})

describe("synchronous signature recovery", () => {
  it("agrees with viem verifyTypedData", async () => {
    const binding = manifestBindingFor({ chainId: CHAIN_ID, capabilityRegistry: REGISTRY, body: manifestBody() })
    const signature = await operator.signTypedData(binding)
    expect(await verifyTypedData({ ...binding, address: operator.address, signature })).toBe(true)
    expect(recoverTypedDataSigner(binding, signature)?.toLowerCase()).toBe(operator.address.toLowerCase())
    expect(recoverTypedDataSigner(binding, "0x00")).toBeNull()
  })

  it("verifies access request signatures against the registered signer only", async () => {
    const request = await signRequest(unsignedRequest([{ namespace: "goals.career", permissions: 1 }]))
    expect(() => assertAccessRequestSignature(request, signer.address)).not.toThrow()
    expect(failsWith("REQUEST_SIGNATURE_INVALID", () => assertAccessRequestSignature(request, stranger.address))).toBe(true)
    const broadened = { ...request, scopes: [{ namespaceId: namespaceId("goals.career"), permissions: 3, provenancePolicy: 0 }] }
    expect(failsWith("REQUEST_SIGNATURE_INVALID", () => assertAccessRequestSignature(broadened, signer.address))).toBe(true)
  })

  it("rejects malleable signature encodings", async () => {
    const binding = manifestBindingFor({ chainId: CHAIN_ID, capabilityRegistry: REGISTRY, body: manifestBody() })
    const signature = await operator.signTypedData(binding)
    const secp256k1N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141")
    const r = signature.slice(2, 66)
    const s = BigInt(`0x${signature.slice(66, 130)}`)
    const v = parseInt(signature.slice(130, 132), 16)
    const variants = [
      `0x${r}${(secp256k1N - s).toString(16).padStart(64, "0")}${v === 27 ? "1c" : "1b"}`,
      `0x${r}${signature.slice(66, 130)}0${v - 27}`,
      `0x${signature.slice(2).toUpperCase()}`,
      signature.slice(0, 130),
    ] as Hex[]
    for (const variant of variants) {
      expect(recoverTypedDataSigner(binding, variant)).toBeNull()
    }
    expect(recoverTypedDataSigner(binding, signature)?.toLowerCase()).toBe(operator.address.toLowerCase())
  })
})
