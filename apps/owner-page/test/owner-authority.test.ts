import { describe, expect, it } from "vitest"
import { encodeAbiParameters, encodeEventTopics, zeroHash } from "viem"
import type { Address, Hex } from "viem"
import {
  PERMISSION,
  accessRequestHash,
  decodeUint64,
  encodeUint64,
  grantDigest,
  hashString,
  namespaceById,
  namespaceId,
} from "@mida/protocol"
import type { AccessRequest } from "@mida/protocol"
import { deriveEpochKeyPair, deriveNamespaceSecret, hexOf } from "@mida/crypto"
import { capabilityRegistryAbi } from "@mida/chain/browser"
import type { Deployment, SponsoredReceipt, SponsoredSender, TxKind } from "@mida/chain/browser"
import { SponsorDidNotPay, SponsorPending } from "@mida/chain/browser"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"
import { fakePrfOutput } from "@mida/fake-vault/browser"
import type { VaultContextApi } from "@mida/fake-vault/browser"
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
import { PasskeyVaultAuthority } from "../src/owner/authority.js"
import type { CapturedAssertion } from "../src/owner/webauthn.js"
import { makeAssertion, makeKeyPair } from "./helpers.js"

/**
 * The authority end to end against fakes: the fake chain answers view calls, the fake sponsor
 * records every send it is asked for, the fake store records wraps and denies. The passkey's
 * P-256 key signs real assertions; the PRF output is a fixed test secret.
 */

const PRF = new Uint8Array(32).map((_, i) => i + 1)
const RP_ID = "midacontext.xyz"
const NS_ID = namespaceId("preferences.communication")
/** The fixture request's capability expiry (unsignedRequest sets capabilityExpiresAt = NOW + 7d). */
const CAP_EXPIRY = NOW + 7n * 86_400n

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

function ownerOfPrf(): Address {
  return ownerAccount(deriveOwnerSecrets(PRF.slice())).address.toLowerCase() as Address
}

/** The epoch public key the fake chain must report for the namespace secret this PRF yields. */
function epochPublicKey(nsId: Hex, epoch: bigint): Hex {
  const secrets = deriveOwnerSecrets(PRF.slice())
  const node = namespaceById(nsId)
  const nsSecret = deriveNamespaceSecret(fakePrfOutput(secrets.ownerSeed, node.domain), node.id)
  return hexOf(deriveEpochKeyPair(nsSecret, epoch).publicKey)
}

interface Call {
  what: string
  detail?: unknown
}

function fakeChain(overrides: Record<string, (args: readonly unknown[]) => unknown> = {}) {
  const calls: Call[] = []
  const handlers: Record<string, (args: readonly unknown[]) => unknown> = {
    grantNonce: () => 0n,
    hasAuthority: () => true,
    requiredReadEpoch: () => 1n,
    agentEpoch: () => 0n,
    activeCapabilityIds: () => [],
    isCapabilityValid: () => true,
    ...overrides,
  }
  const publicClient = {
    async readContract(input: { functionName: string; args: readonly unknown[] }) {
      calls.push({ what: `read:${input.functionName}` })
      const handler = handlers[input.functionName]
      if (handler === undefined) throw new Error(`no fake for ${input.functionName}`)
      return handler(input.args)
    },
    async simulateContract(input: { functionName: string }) {
      calls.push({ what: `simulate:${input.functionName}` })
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

function fakeSponsor(receiptLogs: { topics: Hex[]; data: Hex }[] = []) {
  const sends: { call: { functionName: string; args: readonly unknown[] }; kind: TxKind }[] = []
  const sponsor: SponsoredSender = {
    async send(call, kind) {
      sends.push({ call: call as { functionName: string; args: readonly unknown[] }, kind })
      return {
        transactionHash: `0x${"bb".repeat(32)}`,
        gasUsed: 123_456n,
        gasLimit: 200_000n,
        userOpHash: `0x${"cc".repeat(32)}`,
        logs: receiptLogs.map((log) => ({ address: REGISTRY, topics: log.topics, data: log.data })),
      } as unknown as SponsoredReceipt
    },
  }
  return { sponsor, sends }
}

/** A CapabilityGranted receipt log, encoded by hand — this viem has no encodeEventLog. */
function capabilityGrantedLog(args: {
  owner: Address
  agentId: Hex
  namespaceId: Hex
  capabilityId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: bigint
  context: {
    requestHash: Hex
    manifestHash: Hex
    manifestVersion: bigint
    policyVersionHash: Hex
    namespaceTreeVersionHash: Hex
    grantNonce: bigint
  }
}): { topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: capabilityRegistryAbi,
    eventName: "CapabilityGranted",
    args: { owner: args.owner, agentId: args.agentId, namespaceId: args.namespaceId },
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
    [args.capabilityId, args.permissions, args.provenancePolicy, args.expiresAt, args.context],
  )
  return { topics, data }
}

function fakeApi() {
  const calls: Call[] = []
  const api: VaultContextApi = {
    async putObject() {
      calls.push({ what: "api:putObject" })
      return {}
    },
    async publishEpochWrap(wrap) {
      calls.push({ what: "api:publishEpochWrap", detail: wrap })
      return { stored: true }
    },
    async requestRevocationDeny(target) {
      calls.push({ what: "api:requestRevocationDeny", detail: target })
      return { intentId: `0x${"dd".repeat(32)}` as Hex }
    },
  }
  return { api, calls }
}

function authority(opts: {
  publicClient: ReturnType<typeof fakeChain>["publicClient"]
  sponsor: SponsoredSender
  api: VaultContextApi
  assertion?: CapturedAssertion
}) {
  const secrets = deriveOwnerSecrets(PRF.slice())
  const account = ownerAccount(secrets)
  return new PasskeyVaultAuthority({
    secrets,
    account,
    publicClient: opts.publicClient,
    deployment: DEPLOYMENT,
    sponsor: opts.sponsor,
    api: opts.api,
    p256PublicKey: passkeyPoint,
    assertion: opts.assertion,
  })
}

/** A real P-256 assertion over `challenge`, shaped exactly like the browser capture. */
function assertionOver(challenge: Hex): CapturedAssertion {
  const bytes = new Uint8Array(32)
  const hex = challenge.slice(2)
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const a = makeAssertion(passkey.privateKey, { challenge: bytes, rpId: RP_ID })
  return { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signatureDer: a.signatureDer }
}

async function grantFixture() {
  const body = manifestBody()
  const manifest = await signManifest(body)
  const unsigned = unsignedRequest(
    [{ namespace: "preferences.communication", permissions: PERMISSION.READ }],
    { chainId: encodeUint64(CHAIN_ID), capabilityRegistry: REGISTRY },
  )
  const accessRequest: AccessRequest = await signRequest(unsigned)
  const owner = ownerOfPrf()
  const requestHash = accessRequestHash(unsigned)
  const finalScopes = unsigned.scopes
  const digest = grantDigest({
    chainId: CHAIN_ID,
    capabilityRegistry: REGISTRY,
    owner,
    agentId: AGENT_ID,
    requestHash,
    manifestHash: unsigned.manifestHash,
    manifestVersion: BigInt(unsigned.manifestVersion),
    finalScopes,
    expiresAt: decodeUint64(unsigned.capabilityExpiresAt),
    grantNonce: 0n,
  })
  return { body, manifest, unsigned, accessRequest, owner, requestHash, finalScopes, digest }
}

describe("PasskeyVaultAuthority", () => {
  it("registers the passkey's P-256 point through the sponsor — simulate first, never self-pay", async () => {
    const chain = fakeChain()
    const { sponsor, sends } = fakeSponsor()
    const { api } = fakeApi()
    const auth = authority({ publicClient: chain.publicClient, sponsor, api })
    const hash = await auth.registerOwnerKey()
    expect(hash).toBe(`0x${"bb".repeat(32)}`)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.kind).toBe("owner.key")
    expect(sends[0]!.call.functionName).toBe("registerP256Key")
    expect(sends[0]!.call.args).toEqual([passkeyPoint.qx, passkeyPoint.qy])
    // simulate ran before the send — a revert surfaces before the sponsor is asked
    expect(chain.calls.map((c) => c.what)).toEqual(["simulate:registerP256Key"])
  })

  it("initializes a namespace with the derived epoch-1 public key", async () => {
    const chain = fakeChain()
    const { sponsor, sends } = fakeSponsor()
    const { api } = fakeApi()
    const auth = authority({ publicClient: chain.publicClient, sponsor, api })
    await auth.initializeNamespace("preferences.communication")
    expect(sends).toHaveLength(1)
    expect(sends[0]!.kind).toBe("epoch.init")
    expect(sends[0]!.call.functionName).toBe("initializeReadEpoch")
    expect(sends[0]!.call.args).toEqual([NS_ID, epochPublicKey(NS_ID, 1n)])
  })

  it("approves a grant: one sponsored grantBatch carrying the passkey assertion, then wraps", async () => {
    const fx = await grantFixture()
    const grantedLog = capabilityGrantedLog({
      owner: fx.owner,
      agentId: AGENT_ID,
      namespaceId: NS_ID,
      capabilityId: `0x${"77".repeat(32)}` as Hex,
      permissions: PERMISSION.READ,
      provenancePolicy: 0,
      expiresAt: CAP_EXPIRY,
      context: {
        requestHash: fx.requestHash,
        manifestHash: fx.unsigned.manifestHash,
        manifestVersion: BigInt(fx.unsigned.manifestVersion),
        policyVersionHash: hashString("mida-grant-policy-v1"),
        namespaceTreeVersionHash: hashString("mida-namespace-tree-v1"),
        grantNonce: 0n,
      },
    })
    const chain = fakeChain({
      getAgent: () => agentRecordFor(fx.body),
      epochPublicKey: () => epochPublicKey(NS_ID, 1n),
    })
    const { sponsor, sends } = fakeSponsor([grantedLog])
    const { api, calls: apiCalls } = fakeApi()
    const auth = authority({
      publicClient: chain.publicClient,
      sponsor,
      api,
      assertion: assertionOver(fx.digest),
    })
    const approval = await auth.approveGrant({
      accessRequest: fx.accessRequest,
      manifest: fx.manifest,
      selection: { kind: "custom", scopes: fx.finalScopes, expiresAt: CAP_EXPIRY },
    })

    expect(sends).toHaveLength(1)
    expect(sends[0]!.kind).toBe("grant.batch")
    expect(sends[0]!.call.functionName).toBe("grantBatch")
    const authArg = sends[0]!.call.args[3] as { challengeIndex: bigint; r: bigint }
    expect(typeof authArg.challengeIndex).toBe("bigint")
    expect(authArg.r > 0n).toBe(true)
    // one READ capability granted → one wrap published to the store, after the send
    expect(approval.response.capabilities).toHaveLength(1)
    expect(apiCalls.map((c) => c.what)).toEqual(["api:publishEpochWrap"])
    expect(approval.response.owner).toBe(fx.owner)
  })

  it("refuses a grant when the assertion signed a different challenge — no send, nothing stored", async () => {
    const fx = await grantFixture()
    const chain = fakeChain({ getAgent: () => agentRecordFor(fx.body) })
    const { sponsor, sends } = fakeSponsor()
    const { api, calls: apiCalls } = fakeApi()
    const auth = authority({
      publicClient: chain.publicClient,
      sponsor,
      api,
      assertion: assertionOver(`0x${"ef".repeat(32)}` as Hex),
    })
    await expect(
      auth.approveGrant({
        accessRequest: fx.accessRequest,
        manifest: fx.manifest,
        selection: { kind: "custom", scopes: fx.finalScopes, expiresAt: CAP_EXPIRY },
      }),
    ).rejects.toThrowError(/not this grant's/)
    expect(sends).toHaveLength(0)
    expect(apiCalls).toHaveLength(0)
  })

  it("lets SponsorDidNotPay surface untouched — one send attempt, no fallback", async () => {
    const fx = await grantFixture()
    const chain = fakeChain({ getAgent: () => agentRecordFor(fx.body) })
    const refusal = new SponsorDidNotPay("quota exhausted")
    let attempts = 0
    const sponsor: SponsoredSender = {
      send: async () => {
        attempts += 1
        throw refusal
      },
    }
    const { api } = fakeApi()
    const auth = authority({ publicClient: chain.publicClient, sponsor, api, assertion: assertionOver(fx.digest) })
    const error = await auth
      .approveGrant({
        accessRequest: fx.accessRequest,
        manifest: fx.manifest,
        selection: { kind: "custom", scopes: fx.finalScopes, expiresAt: CAP_EXPIRY },
      })
      .catch((e: unknown) => e)
    expect(error).toBe(refusal)
    expect(attempts).toBe(1)
  })

  it("revokes an agent: deny posted first, then one sponsored revokeAgentAndRotate with the next epoch key", async () => {
    const capabilityId = `0x${"55".repeat(32)}` as Hex
    const chain = fakeChain({
      activeCapabilityIds: () => [capabilityId],
      getCapability: () => ({
        owner: ownerOfPrf(),
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
      isCapabilityValid: () => true,
    })
    const { sponsor, sends } = fakeSponsor()
    const { api, calls: apiCalls } = fakeApi()
    const auth = authority({ publicClient: chain.publicClient, sponsor, api })
    const approval = await auth.approveRevocation({ kind: "agent", agentId: AGENT_ID })
    expect(approval.intentId).toBe(`0x${"dd".repeat(32)}`)
    expect(approval.rotated).toEqual([{ namespaceId: NS_ID, readEpoch: 2n }])
    expect(apiCalls[0]!.what).toBe("api:requestRevocationDeny")
    expect(sends).toHaveLength(1)
    expect(sends[0]!.kind).toBe("revoke.agent")
    expect(sends[0]!.call.functionName).toBe("revokeAgentAndRotate")
    const rotations = sends[0]!.call.args[1] as { namespaceId: Hex; newEpochPublicKey: Hex }[]
    expect(rotations[0]!.namespaceId).toBe(NS_ID)
    expect(rotations[0]!.newEpochPublicKey).toBe(epochPublicKey(NS_ID, 2n))
  })

  it("lets SponsorPending propagate with the operation hash — pending, never retried", async () => {
    const pending = new SponsorPending(`0x${"ee".repeat(32)}` as Hex)
    const sponsor: SponsoredSender = {
      send: async () => {
        throw pending
      },
    }
    const chain = fakeChain()
    const { api } = fakeApi()
    const auth = authority({ publicClient: chain.publicClient, sponsor, api })
    const error = await auth.registerOwnerKey().catch((e: unknown) => e)
    expect(error).toBe(pending)
    expect((error as SponsorPending).userOpHash).toBe(`0x${"ee".repeat(32)}`)
  })

  it("release() overwrites the secret buffers and ends the authority", async () => {
    const secrets = deriveOwnerSecrets(PRF.slice())
    const account = ownerAccount(secrets)
    const chain = fakeChain()
    const { sponsor } = fakeSponsor()
    const { api } = fakeApi()
    const auth = new PasskeyVaultAuthority({
      secrets,
      account,
      publicClient: chain.publicClient,
      deployment: DEPLOYMENT,
      sponsor,
      api,
      p256PublicKey: passkeyPoint,
    })
    auth.release()
    expect(auth.released).toBe(true)
    expect(secrets.evmKey.every((b) => b === 0)).toBe(true)
    expect(secrets.ownerSeed.every((b) => b === 0)).toBe(true)
    await expect(auth.registerOwnerKey()).rejects.toThrowError(/released/)
    await expect(auth.deriveNamespaceSecret(NS_ID)).rejects.toThrowError(/released/)
  })

  it("refuses rotateP256Key plainly — out of scope for this page", () => {
    const auth = authority({ publicClient: fakeChain().publicClient, sponsor: fakeSponsor().sponsor, api: fakeApi().api })
    expect(() => auth.rotateP256Key()).toThrowError(/cannot rotate/)
  })

  it("refuses a request bound to a different chain before any send", async () => {
    const fx = await grantFixture()
    const foreign = { ...fx.unsigned, chainId: encodeUint64(CHAIN_ID + 1n) }
    const accessRequest = await signRequest(foreign)
    const chain = fakeChain()
    const { sponsor, sends } = fakeSponsor()
    const { api } = fakeApi()
    const auth = authority({ publicClient: chain.publicClient, sponsor, api, assertion: assertionOver(zeroHash) })
    await expect(
      auth.approveGrant({
        accessRequest,
        manifest: fx.manifest,
        selection: { kind: "custom", scopes: foreign.scopes, expiresAt: CAP_EXPIRY },
      }),
    ).rejects.toThrowError(/different chain or registry/)
    expect(sends).toHaveLength(0)
  })
})
