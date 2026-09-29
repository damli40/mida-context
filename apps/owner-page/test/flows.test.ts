import { describe, expect, it } from "vitest"
import { encodeAbiParameters, encodeEventTopics, zeroHash } from "viem"
import type { Address, Hex } from "viem"
import { PERMISSION, decodeUint64, encodeUint64, hashString, namespaceById, namespaceId } from "@mida/protocol"
import { deriveEpochKeyPair, deriveNamespaceSecret, hexOf } from "@mida/crypto"
import { capabilityRegistryAbi } from "@mida/chain/browser"
import type { Deployment, SponsoredReceipt, TxKind } from "@mida/chain/browser"
import { SponsorDidNotPay, SponsorPending } from "@mida/chain/browser"
import { POLICY_HASH_V1, manifestBodyHash } from "@mida/grant-advisor"
import { fakePrfOutput } from "@mida/fake-vault/browser"
import {
  AGENT_ID,
  CHAIN_ID,
  NOW,
  REGISTRY,
  agentRecordFor,
  manifestBody,
  signManifest,
  signRequest,
  unsignedRequest,
} from "../../../packages/grant-advisor/test/fixtures.js"
import { deriveOwnerSecrets, ownerAccount } from "../src/owner/secrets.js"
import type { OwnerSecrets } from "../src/owner/secrets.js"
import { parseLinkFragment } from "../src/owner/link.js"
import type { ParsedLink } from "../src/owner/link.js"
import { base64UrlEncode } from "../src/check/bytes.js"
import type { CredentialsContainerLike } from "../src/check/client.js"
import { makeAssertion, makeKeyPair } from "./helpers.js"
import {
  confirmApprove,
  confirmRevoke,
  prepareApprove,
  prepareRevoke,
  runSignup,
} from "../src/owner/flows.js"
import type { FlowEnvironment } from "../src/owner/flows.js"
import { actionChallenge } from "../src/owner/webauthn.js"

/**
 * The three flows end to end against fakes — a fake navigator.credentials that signs whatever
 * challenge it is handed and answers the PRF extension with a fixed secret, a fake chain that
 * answers view calls, a fake sponsor that records sends, a fake store. The tests assert the
 * ORDER the brief fixes: verify the request → ONE credential call → then the sends.
 */

const PRF = new Uint8Array(32).map((_, i) => i + 1)
const OTHER_PRF = new Uint8Array(32).map((_, i) => i + 50)
const RP_ID = "midacontext.xyz"
const NS_ID = namespaceId("preferences.communication")
const CAP_EXPIRY = NOW + 7n * 86_400n
const NONCE = "0123456789abcdef"
const SURVIVOR: Hex = `0x${"77".repeat(32)}`

const DEPLOYMENT: Deployment = {
  chainId: CHAIN_ID,
  capabilityRegistry: REGISTRY,
  contextRegistry: "0x9999999999999999999999999999999999999999",
  deploymentBlock: 0n,
  policyHashV1: POLICY_HASH_V1,
  vaultRpId: RP_ID,
  vaultRpIdHash: `0x${"aa".repeat(32)}`,
}

const passkey = makeKeyPair()
const passkeyPoint = { qx: BigInt(hexOf(passkey.x)), qy: BigInt(hexOf(passkey.y)) }

function ownerOf(prf: Uint8Array): Address {
  return ownerAccount(deriveOwnerSecrets(prf.slice())).address.toLowerCase() as Address
}
const OWNER = ownerOf(PRF)

function epochKey(nsId: Hex, epoch: bigint, prf: Uint8Array = PRF): Hex {
  const secrets = deriveOwnerSecrets(prf.slice())
  const node = namespaceById(nsId)
  const nsSecret = deriveNamespaceSecret(fakePrfOutput(secrets.ownerSeed, node.domain), node.id)
  return hexOf(deriveEpochKeyPair(nsSecret, epoch).publicKey)
}

// --- fakes ------------------------------------------------------------------

function fakeCredentials(key: ReturnType<typeof makeKeyPair>, prfOutput: Uint8Array) {
  const calls: { kind: "create" | "get"; challenge?: Uint8Array }[] = []
  const rawId = new TextEncoder().encode("owner-credential")
  const prf = prfOutput // the buffer the flow's deriveOwnerSecrets must consume in place
  const toBuf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const container: CredentialsContainerLike = {
    async create() {
      calls.push({ kind: "create" })
      return {
        type: "public-key",
        rawId,
        authenticatorAttachment: "platform",
        response: {
          getPublicKeyAlgorithm: () => -7,
          getPublicKey: () => toBuf(key.spki),
          getTransports: () => ["internal"],
        },
        getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: prf } } }),
      }
    },
    async get(options) {
      const request = options!.publicKey as { challenge: Uint8Array }
      calls.push({ kind: "get", challenge: request.challenge })
      const assertion = makeAssertion(key.privateKey, { challenge: request.challenge, rpId: RP_ID })
      return {
        type: "public-key",
        rawId,
        response: {
          authenticatorData: toBuf(assertion.authenticatorData),
          clientDataJSON: toBuf(assertion.clientDataJSON),
          signature: toBuf(assertion.signatureDer),
        },
        getClientExtensionResults: () => ({ prf: { results: { first: prf } } }),
      }
    },
  }
  return { container, calls, prf }
}

interface SendRecord {
  functionName: string
  kind: TxKind
}

function fakeChain(handlers: Record<string, (args: readonly unknown[]) => unknown> = {}) {
  const calls: string[] = []
  const defaults: Record<string, (args: readonly unknown[]) => unknown> = {
    getAgent: () => agentRecordFor(manifestBody()),
    agentEpoch: () => 0n,
    grantNonce: () => 0n,
    hasAuthority: () => false,
    requiredReadEpoch: () => 1n,
    isWriteEpochValid: () => true,
    ownerP256Key: () => [passkeyPoint.qx, passkeyPoint.qy],
    activeCapabilityIds: () => [],
    isCapabilityValid: () => true,
    epochPublicKey: (args) => epochKey(args[1] as Hex, args[2] as bigint),
    ...handlers,
  }
  const publicClient = {
    async readContract(input: { functionName: string; args: readonly unknown[] }) {
      calls.push(`read:${input.functionName}`)
      const handler = defaults[input.functionName]
      if (handler === undefined) throw new Error(`no fake for ${input.functionName}`)
      return handler(input.args)
    },
    async simulateContract(input: { functionName: string }) {
      calls.push(`simulate:${input.functionName}`)
      return { request: {} }
    },
    async estimateContractGas() {
      return 100_000n
    },
    async getBlock() {
      return { timestamp: NOW }
    },
    async getBlockNumber() {
      return 100n
    },
    async getLogs() {
      return []
    },
  }
  return { publicClient: publicClient as never, calls }
}

function fakeSponsor(sends: SendRecord[], receiptLogs: { topics: Hex[]; data: Hex }[] = []) {
  return {
    async send(call: { functionName: string }, kind: TxKind) {
      sends.push({ functionName: call.functionName, kind })
      return {
        transactionHash: `0x${"bb".repeat(32)}` as Hex,
        gasUsed: 100n,
        gasLimit: 200_000n,
        userOpHash: `0x${"cc".repeat(32)}` as Hex,
        logs: receiptLogs.map((log) => ({ address: REGISTRY, topics: log.topics, data: log.data })),
      } as unknown as SponsoredReceipt
    },
  }
}

/** What GET /revocations hands back — the fields clearStaleDenies reads. */
interface DenyIntent {
  intentId: Hex
  state: string
  target: { kind: "agent"; agentId: Hex } | { kind: "capability"; capabilityId: Hex }
  agentEpochAtIntent: string | null
}

function fakeApi(calls: string[], intents: DenyIntent[] = []) {
  return {
    async putObject() {
      calls.push("api:putObject")
      return {}
    },
    async publishEpochWrap(wrap: { agentId: Hex; namespaceId: Hex; readEpoch: bigint }) {
      calls.push(`api:publishEpochWrap:${wrap.agentId.slice(2, 6)}:${wrap.namespaceId.slice(2, 10)}:${wrap.readEpoch}`)
      return { stored: true }
    },
    async requestRevocationDeny() {
      calls.push("api:requestRevocationDeny")
      return { intentId: `0x${"dd".repeat(32)}` as Hex }
    },
    async listRevocations() {
      calls.push("api:listRevocations")
      return intents
    },
    async reissueRevocationNonce(intentId: Hex) {
      calls.push(`api:reissueRevocationNonce:${intentId.slice(2, 6)}`)
      return { intentId, state: "active", cancellationNonce: "7" }
    },
    async cancelRevocation(intentId: Hex) {
      calls.push(`api:cancelRevocation:${intentId.slice(2, 6)}`)
      return {}
    },
  }
}

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  }
}

function makeEnv(opts: {
  prf?: Uint8Array
  chain?: ReturnType<typeof fakeChain>
  sends: SendRecord[]
  apiCalls: string[]
  sponsor?: ReturnType<typeof fakeSponsor>
  receiptLogs?: { topics: Hex[]; data: Hex }[]
  fetchManifest?: (h: Hex) => Promise<unknown>
  storage?: ReturnType<typeof fakeStorage>
  releasedSecrets?: OwnerSecrets[]
  intents?: DenyIntent[]
}): { env: FlowEnvironment; credentials: ReturnType<typeof fakeCredentials>; storage: ReturnType<typeof fakeStorage> } {
  const credentials = fakeCredentials(passkey, opts.prf ?? PRF.slice())
  const chain = opts.chain ?? fakeChain()
  const sponsor = opts.sponsor ?? fakeSponsor(opts.sends, opts.receiptLogs)
  const store = opts.storage ?? fakeStorage()
  const env: FlowEnvironment = {
    credentials: credentials.container,
    publicClient: chain.publicClient,
    deployment: DEPLOYMENT,
    storeUrl: "https://store.test",
    storage: store.storage,
    makeSponsor: () => sponsor, // flows wrap it to record receipts into their own `sent` list
    makeApi: () => fakeApi(opts.apiCalls, opts.intents ?? []) as never,
    fetchManifest: opts.fetchManifest ?? (async () => { throw new Error("no manifest") }),
    onSecrets: (s) => opts.releasedSecrets?.push(s),
  }
  return { env, credentials, storage: store }
}

function link(flow: "signup" | "approve" | "revoke", req: Record<string, unknown>, port = 4700): ParsedLink {
  const b64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(req)))
  return parseLinkFragment(`v=1&req=${b64}&port=${port}&nonce=${NONCE}`, flow)
}

function capabilityGrantedLog(owner: Address): { topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: capabilityRegistryAbi,
    eventName: "CapabilityGranted",
    args: { owner, agentId: AGENT_ID, namespaceId: NS_ID },
  }).filter((t): t is Hex => typeof t === "string")
  const data = encodeAbiParameters(
    [
      { name: "capabilityId", type: "bytes32" },
      { name: "permissions", type: "uint8" },
      { name: "provenancePolicy", type: "uint8" },
      { name: "expiresAt", type: "uint64" },
      {
        name: "context",
        type: "tuple",
        components: [
          { name: "requestHash", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "manifestVersion", type: "uint64" },
          { name: "policyVersionHash", type: "bytes32" },
          { name: "namespaceTreeVersionHash", type: "bytes32" },
          { name: "grantNonce", type: "uint256" },
        ],
      },
    ],
    [
      `0x${"55".repeat(32)}` as Hex,
      PERMISSION.READ,
      0,
      CAP_EXPIRY,
      {
        requestHash: `0x${"00".repeat(32)}` as Hex,
        manifestHash: manifestBodyHash(manifestBody()),
        manifestVersion: 1n,
        policyVersionHash: hashString("mida-grant-policy-v1"),
        namespaceTreeVersionHash: hashString("mida-namespace-tree-v1"),
        grantNonce: 0n,
      },
    ],
  )
  return { topics, data }
}

async function approveReq() {
  const body = manifestBody()
  const manifest = await signManifest(body)
  const unsigned = unsignedRequest(
    [{ namespace: "preferences.communication", permissions: PERMISSION.READ }],
    { chainId: encodeUint64(CHAIN_ID), capabilityRegistry: REGISTRY },
    body,
  )
  const accessRequest = await signRequest(unsigned)
  return { manifest, accessRequest }
}

// --- tests ------------------------------------------------------------------

describe("runSignup", () => {
  it("one create ceremony → registerP256Key + three initializeReadEpoch sends → result with owner + public key", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const releasedSecrets: OwnerSecrets[] = []
    const { env, credentials, storage } = makeEnv({
      sends,
      apiCalls,
      releasedSecrets,
      chain: fakeChain({ ownerP256Key: () => [0n, 0n], epochPublicKey: () => zeroHash }),
    })
    const result = await runSignup(env, link("signup", { chainId: Number(CHAIN_ID) }), "Dami's Mida")

    expect(result.status).toBe("success")
    expect(result.owner).toBe(OWNER)
    expect(result.publicKey).toEqual({ x: `0x${hexOf(passkey.x).slice(2)}`, y: `0x${hexOf(passkey.y).slice(2)}` })
    expect(credentials.calls.map((c) => c.kind)).toEqual(["create"])
    expect(sends.map((s) => s.functionName)).toEqual([
      "registerP256Key",
      "initializeReadEpoch",
      "initializeReadEpoch",
      "initializeReadEpoch",
    ])
    expect(result.transactions).toHaveLength(4)
    const saved = JSON.parse(storage.map.get("mida.owner.v1")!)
    expect(saved.owner).toBe(OWNER)
    expect(saved.credentialId).toBe(base64UrlEncode(new TextEncoder().encode("owner-credential")))
    // after the flow the derived buffers are overwritten and the object ended
    expect(releasedSecrets).toHaveLength(1)
    expect(releasedSecrets[0]!.released).toBe(true)
    expect(releasedSecrets[0]!.evmKey.every((b) => b === 0)).toBe(true)
    expect(releasedSecrets[0]!.ownerSeed.every((b) => b === 0)).toBe(true)
  })

  it("skips registration and already-open areas when the chain shows them", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env } = makeEnv({
      sends,
      apiCalls,
      chain: fakeChain({ epochPublicKey: () => epochKey(NS_ID, 1n) }),
    })
    const result = await runSignup(env, link("signup", { chainId: Number(CHAIN_ID) }), "x")
    expect(result.status).toBe("success")
    expect(sends).toHaveLength(0) // key registered, areas open — nothing to send
  })
})

describe("approve flow", () => {
  async function setup(opts: {
    prf?: Uint8Array
    sponsor?: ReturnType<typeof fakeSponsor>
    releasedSecrets?: OwnerSecrets[]
    intents?: DenyIntent[]
    granted?: () => boolean
    storage?: ReturnType<typeof fakeStorage>
  } = {}) {
    const { manifest, accessRequest } = await approveReq()
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    // hasAuthority answers false before the grantBatch send and true after — so the scope reads
    // as "needed" at prepare time and the wrap publish sees the live grant after the send.
    const granted = opts.granted ?? (() => sends.some((s) => s.functionName === "grantBatch"))
    const chain = fakeChain({
      getAgent: () => agentRecordFor(manifestBody()),
      hasAuthority: () => granted(),
    })
    const { env, credentials, storage } = makeEnv({
      sends,
      apiCalls,
      chain,
      sponsor: opts.sponsor,
      receiptLogs: [capabilityGrantedLog(OWNER)],
      fetchManifest: async () => manifest,
      prf: opts.prf,
      releasedSecrets: opts.releasedSecrets,
      intents: opts.intents,
      storage: opts.storage,
    })
    const req = {
      chainId: Number(CHAIN_ID),
      owner: OWNER,
      request: accessRequest,
      entry: { agent: AGENT_ID, projectId: "proj-1", root: `0x${"33".repeat(32)}` },
      readers: [AGENT_ID, SURVIVOR],
    }
    return { env, credentials, storage, sends, apiCalls, req, accessRequest }
  }

  it("prepare does every check with zero credential calls; confirm runs exactly one get then the sends", async () => {
    const releasedSecrets: OwnerSecrets[] = []
    const { env, credentials, sends, apiCalls, req } = await setup({ releasedSecrets })
    const parsed = link("approve", req)

    const prep = await prepareApprove(env, parsed)
    expect(credentials.calls).toHaveLength(0) // nothing asked of the passkey yet
    expect(prep.needed).toHaveLength(1)
    expect(prep.agentName).toBe("CareerAI")
    expect(prep.alreadyGranted).toBe(false)

    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(result.owner).toBe(OWNER)
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"])
    // the ceremony signed the grant digest — the challenge handed to the authenticator
    expect(hexOf(credentials.calls[0]!.challenge!)).toBe(prep.challenge)
    expect(sends.map((s) => s.functionName)).toEqual(["grantBatch"])
    // the stale-deny sweep asks the store first (M3-D4 item 3 passkey side), then the wrap publish
    expect(apiCalls).toEqual(["api:listRevocations", `api:publishEpochWrap:${AGENT_ID.slice(2, 6)}:${NS_ID.slice(2, 10)}:1`])
    expect(result.transactions).toEqual([`0x${"bb".repeat(32)}`])
    expect(result.operations).toEqual([`0x${"cc".repeat(32)}`])
    // the project entry is signed and carries the appended row
    expect(result.entry?.signature).toMatch(/^0x/)
    expect((result.entry?.entries as { agent: string }[]).some((e) => e.agent === AGENT_ID)).toBe(true)
    expect(releasedSecrets[0]?.released).toBe(true)
    expect(releasedSecrets[0]?.evmKey.every((b) => b === 0)).toBe(true)
  })

  it("a device remembering another owner does not block this link's passkey (in-25 P-3)", async () => {
    // Shared-browser case: /me signed in passkey B last, but this approve link is for owner A
    // and passkey A answers — the stored record is a hint, not a second gate.
    const store = fakeStorage()
    store.map.set(
      "mida.owner.v1",
      JSON.stringify({ credentialId: base64UrlEncode(new TextEncoder().encode("other-credential")), owner: ownerOf(OTHER_PRF) }),
    )
    const { env, sends, req } = await setup({ storage: store })
    const parsed = link("approve", req)
    const prep = await prepareApprove(env, parsed)
    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(sends.map((s) => s.functionName)).toEqual(["grantBatch"])
  })

  it("a wrong-owner passkey fails before any send — in words, with both addresses", async () => {
    const { env, sends, req } = await setup({ prf: OTHER_PRF })
    const parsed = link("approve", req)
    const prep = await prepareApprove(env, parsed)
    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("different Mida owner")
    // the message shows both ends shortened: derived 0xc8fb…ccd6 vs expected — check both halves
    expect(result.reason).toContain(ownerOf(OTHER_PRF).slice(0, 6))
    expect(result.reason).toContain(ownerOf(OTHER_PRF).slice(-4))
    expect(sends).toHaveLength(0)
  })

  it("a sponsor refusal fails plainly — nothing else is sent, no self-pay", async () => {
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorDidNotPay("quota exhausted")
      },
    }
    const { env, sends, req } = await setup({ sponsor: sponsor as never })
    const parsed = link("approve", req)
    const prep = await prepareApprove(env, parsed)
    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("failed")
    expect(result.reason).toBe("the gas sponsor refused: quota exhausted")
    expect(sends).toHaveLength(0)
  })

  it("a pending sponsor returns status pending with the operation hash — never a resend", async () => {
    const sponsor = {
      async send(): Promise<SponsoredReceipt> {
        throw new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
      },
    }
    const { env, req } = await setup({ sponsor: sponsor as never })
    const parsed = link("approve", req)
    const prep = await prepareApprove(env, parsed)
    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("pending")
    expect(result.operations).toContain(`0x${"ee".repeat(32)}`)
    expect(result.reason).toBe("accepted, still landing — check again in a minute")
  })

  it("an already-approved agent with a project row still gets its one touch — no grant send, the row is signed", async () => {
    const { env, credentials, sends, apiCalls, req } = await setup({ granted: () => true })
    const parsed = link("approve", req)

    const prep = await prepareApprove(env, parsed)
    expect(prep.alreadyGranted).toBe(true)
    expect(prep.needed).toHaveLength(0)

    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"]) // the touch still happens — it signs the row
    // The signed challenge is the domain-separated approve.entry assertion — never a contract-
    // valid grantDigest the page does not show. Same shape as revoke and /me (in-25 P-2).
    expect(hexOf(credentials.calls[0]!.challenge!)).toBe(hexOf(actionChallenge("approve.entry", parsed.requestBytes)))
    expect(hexOf(credentials.calls[0]!.challenge!)).toBe(prep.challenge)
    expect(sends).toHaveLength(0) // nothing was minted
    expect(result.transactions).toEqual([])
    expect(result.entry?.signature).toMatch(/^0x/)
    expect((result.entry?.entries as { agent: string }[]).some((e) => e.agent === AGENT_ID)).toBe(true)
    expect(apiCalls).toEqual(["api:listRevocations"]) // the deny check runs even when no grant will
  })

  it("a stale deny from a failed revoke is cleared before the grant — one extra passkey touch", async () => {
    const denyId: Hex = `0x${"dd".repeat(32)}`
    // agentEpochAtIntent "0" and the chain still on epoch 0 — the revoke never landed, the deny is stale
    const intents: DenyIntent[] = [
      { intentId: denyId, state: "active", target: { kind: "agent", agentId: AGENT_ID }, agentEpochAtIntent: "0" },
    ]
    const { env, credentials, sends, apiCalls, req } = await setup({ intents })
    const parsed = link("approve", req)
    const prep = await prepareApprove(env, parsed)

    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("success")
    // the grant ceremony's get, then a second get for the cancel assertion
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get", "get"])
    expect(apiCalls.slice(0, 3)).toEqual([
      "api:listRevocations",
      `api:reissueRevocationNonce:${denyId.slice(2, 6)}`,
      `api:cancelRevocation:${denyId.slice(2, 6)}`,
    ])
    expect(sends.map((s) => s.functionName)).toEqual(["grantBatch"])
  })

  it("a deny whose revoke actually landed is left alone — anchored, not stale", async () => {
    const denyId: Hex = `0x${"dd".repeat(32)}`
    // agentEpochAtIntent "0" but the chain moved to epoch 1 — the revoke landed, the deny is the record
    const intents: DenyIntent[] = [
      { intentId: denyId, state: "active", target: { kind: "agent", agentId: AGENT_ID }, agentEpochAtIntent: "0" },
    ]
    const { manifest, accessRequest } = await approveReq()
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const granted = () => sends.some((s) => s.functionName === "grantBatch")
    const chain = fakeChain({
      getAgent: () => agentRecordFor(manifestBody()),
      hasAuthority: () => granted(),
      agentEpoch: () => 1n, // the revoke landed — epoch moved past the intent's snapshot
    })
    const { env, credentials } = makeEnv({
      sends,
      apiCalls,
      chain,
      receiptLogs: [capabilityGrantedLog(OWNER)],
      fetchManifest: async () => manifest,
      intents,
    })
    const req = {
      chainId: Number(CHAIN_ID),
      owner: OWNER,
      request: accessRequest,
      entry: { agent: AGENT_ID, projectId: "proj-1", root: `0x${"33".repeat(32)}` },
      readers: [AGENT_ID, SURVIVOR],
    }
    const parsed = link("approve", req)
    const prep = await prepareApprove(env, parsed)

    const result = await confirmApprove(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"]) // no second touch — nothing was cleared
    expect(apiCalls).not.toContain(`api:cancelRevocation:${denyId.slice(2, 6)}`)
    expect(sends.map((s) => s.functionName)).toEqual(["grantBatch"])
  })

  it("an expired request is refused in prepare — the passkey is never asked", async () => {
    const body = manifestBody()
    const manifest = await signManifest(body)
    const stale = unsignedRequest(
      [{ namespace: "preferences.communication", permissions: PERMISSION.READ }],
      { requestExpiresAt: encodeUint64(NOW - 1n) },
      body,
    )
    const accessRequest = await signRequest(stale)
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, fetchManifest: async () => manifest })
    await expect(
      prepareApprove(env, link("approve", { chainId: Number(CHAIN_ID), owner: OWNER, request: accessRequest })),
    ).rejects.toThrowError()
    expect(credentials.calls).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })

  it("a manifest whose body hash does not match the request is refused before the passkey", async () => {
    const { accessRequest } = await approveReq()
    const other = await signManifest(manifestBody({ name: "NotCareerAI" }))
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, fetchManifest: async () => other })
    await expect(
      prepareApprove(env, link("approve", { chainId: Number(CHAIN_ID), owner: OWNER, request: accessRequest })),
    ).rejects.toThrowError(/does not match/)
    expect(credentials.calls).toHaveLength(0)
  })
})

describe("revoke flow", () => {
  const CAP_ID: Hex = `0x${"55".repeat(32)}`

  function revokeChain(sends: SendRecord[]) {
    return fakeChain({
      activeCapabilityIds: () => [CAP_ID],
      // after the rotate send lands, the required read epoch is 2
      requiredReadEpoch: () => (sends.some((s) => s.functionName === "revokeAgentAndRotate") ? 2n : 1n),
      getCapability: () => ({
        owner: OWNER,
        agentId: AGENT_ID,
        namespaceId: NS_ID,
        permissions: PERMISSION.READ,
        provenancePolicy: 0,
        issuedAt: 1n,
        expiresAt: NOW + 86_400n,
        agentEpoch: 0n,
        grantedAtReadEpoch: 1n,
        revoked: false,
      }),
      hasAuthority: (args) => args[1] === SURVIVOR, // the revoked agent fails the re-check; the survivor passes
      epochPublicKey: (args) => epochKey(args[1] as Hex, args[2] as bigint),
    })
  }

  it("prepare lists the live grant from chain; confirm revokes, rotates, and re-wraps the survivor", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, chain: revokeChain(sends) })
    const parsed = link("revoke", { chainId: Number(CHAIN_ID), owner: OWNER, agentId: AGENT_ID, readers: [AGENT_ID, SURVIVOR] })

    const prep = await prepareRevoke(env, parsed)
    expect(credentials.calls).toHaveLength(0)
    expect(prep.live).toHaveLength(1)
    expect(prep.live[0]!.namespaceName).toBe("preferences.communication")

    const result = await confirmRevoke(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"])
    expect(sends.map((s) => s.functionName)).toEqual(["revokeAgentAndRotate"])
    // the deny is posted, then the surviving agent gets a wrap for the rotated epoch
    expect(apiCalls[0]).toBe("api:requestRevocationDeny")
    expect(apiCalls).toContain(`api:publishEpochWrap:${SURVIVOR.slice(2, 6)}:${NS_ID.slice(2, 10)}:2`)
    // the revoked agent itself is never re-wrapped — hasAuthority says no
    expect(apiCalls.some((c) => c.includes(AGENT_ID.slice(2, 6)))).toBe(false)
  })

  it("revoking an agent with nothing live fails before the passkey prompt", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, chain: fakeChain({ activeCapabilityIds: () => [] }) })
    const parsed = link("revoke", { chainId: Number(CHAIN_ID), owner: OWNER, agentId: AGENT_ID })
    const prep = await prepareRevoke(env, parsed)
    expect(prep.live).toHaveLength(0)
    const result = await confirmRevoke(env, parsed, prep)
    expect(result.status).toBe("failed")
    expect(result.reason).toContain("nothing live")
    expect(credentials.calls).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })

  it("a successful revoke also returns the surviving project list, re-signed verbatim", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env } = makeEnv({ sends, apiCalls, chain: revokeChain(sends) })
    // the terminal already filtered the revoked agent's rows out — these are the survivors
    const kept = [
      { agent: SURVIVOR, projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
    ]
    const parsed = link("revoke", {
      chainId: Number(CHAIN_ID),
      owner: OWNER,
      agentId: AGENT_ID,
      readers: [AGENT_ID, SURVIVOR],
      entries: kept,
    })
    const prep = await prepareRevoke(env, parsed)
    const result = await confirmRevoke(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(sends.map((s) => s.functionName)).toEqual(["revokeAgentAndRotate"])
    // the returned entry is exactly the rows sent — nothing added, nothing re-dated
    expect(result.entry?.signature).toMatch(/^0x/)
    expect(result.entry?.entries).toEqual(kept)
  })

  it("an agent with nothing live but rows still on the list gets its one touch — no revoke send, the list is re-signed", async () => {
    const sends: SendRecord[] = []
    const apiCalls: string[] = []
    const { env, credentials } = makeEnv({ sends, apiCalls, chain: fakeChain({ activeCapabilityIds: () => [] }) })
    const kept = [
      { agent: SURVIVOR, projectId: "proj-1", root: `0x${"33".repeat(32)}`, approvedAt: "2026-09-20T00:00:00.000Z" },
    ]
    const parsed = link("revoke", { chainId: Number(CHAIN_ID), owner: OWNER, agentId: AGENT_ID, entries: kept })
    const prep = await prepareRevoke(env, parsed)
    expect(prep.live).toHaveLength(0)
    const result = await confirmRevoke(env, parsed, prep)
    expect(result.status).toBe("success")
    expect(credentials.calls.map((c) => c.kind)).toEqual(["get"]) // the touch still happens — it signs the list
    expect(sends).toHaveLength(0) // nothing was revoked — the chain already showed it dead
    expect(result.entry?.signature).toMatch(/^0x/)
    expect(result.entry?.entries).toEqual(kept)
  })
})
