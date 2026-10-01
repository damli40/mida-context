// A request must reconcile only the asked-about owner's revoke notes. `reconcile` used to walk
// EVERY owner's active intents — one chain read each — so ~40 foreign pending revokes spent the
// whole 30-read budget and every agent of every owner was refused CHAIN_READ_BUDGET_EXHAUSTED.
// These tests pin the scoped variant: foreign notes cost nothing, the requester's own notes still
// gate, and an unrelated owner's note is left untouched.

import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { LocalAccount } from "viem"
import { PERMISSION, namespaceId } from "@mida/protocol"
import type { Address, AgentRecord, Hex, ReaderEpochWrap } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { Deployment } from "@mida/chain"
import {
  BudgetedReader,
  ContextApiClient,
  MAX_CHAIN_READS_PER_REQUEST,
  authorizeAgent,
  createContextApi,
} from "@mida/api"
import type { CapabilityView, RegistryReader } from "@mida/api"

const NOW_SECONDS = 1_800_000_000n
const NAMESPACE = namespaceId("goals.career")

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  batchAnchor: "0x1111111111111111111111111111111111111aa5",
  deploymentBlock: 0n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}

const ownerAccount = privateKeyToAccount(generatePrivateKey())
const OWNER_A = ownerAccount.address.toLowerCase() as Address
const agentAccount = privateKeyToAccount(generatePrivateKey())
const AGENT_ID = hexOf(randomBytes(32))
const READ_CAP = hexOf(randomBytes(32))
const EPOCH_KEY = hexOf(randomBytes(32))

const agentRecord: AgentRecord = {
  agentId: AGENT_ID,
  operator: OWNER_A,
  signer: agentAccount.address,
  encryptionPublicKey: hexOf(randomBytes(32)),
  encryptionKeyVersion: 1,
  callbackOriginHash: hexOf(randomBytes(32)),
  capabilityManifestHash: hexOf(randomBytes(32)),
  capabilityManifestVersion: 1,
  active: true,
}

/**
 * The reader Monad would be, with every chain read journaled into `calls`. `epoch` is mutable so a
 * test can move the owner-agent epoch to model a revoke that has (or has not) landed on Monad.
 */
const makeReader = (state: { epoch: bigint; calls: string[] }) =>
  ({
    context: { deployment, publicClient: {} },
    agentIdOfSigner: async (signer: Address) => {
      state.calls.push(`agentIdOfSigner:${signer}`)
      return signer.toLowerCase() === agentAccount.address.toLowerCase() ? AGENT_ID : null
    },
    getAgent: async (id: Hex) => {
      state.calls.push(`getAgent:${id}`)
      return id === AGENT_ID ? agentRecord : null
    },
    getCapability: async (id: Hex) => {
      state.calls.push(`getCapability:${id}`)
      if (id !== READ_CAP) return null
      const capability: CapabilityView = {
        owner: OWNER_A,
        agentId: AGENT_ID,
        namespaceId: NAMESPACE,
        permissions: PERMISSION.READ,
        provenancePolicy: 0,
        issuedAt: 0n,
        expiresAt: 0n,
        agentEpoch: state.epoch,
        grantedAtReadEpoch: 0n,
        revoked: false,
      }
      return capability
    },
    agentEpoch: async (owner: Address, agentId: Hex) => {
      state.calls.push(`agentEpoch:${owner}:${agentId}`)
      return state.epoch
    },
    now: async () => {
      state.calls.push("now")
      return NOW_SECONDS
    },
    requiredReadEpoch: async () => {
      state.calls.push("requiredReadEpoch")
      return 1n
    },
    epochPublicKey: async () => {
      state.calls.push("epochPublicKey")
      return EPOCH_KEY
    },
    hasAuthority: async () => {
      state.calls.push("hasAuthority")
      return true
    },
  }) as unknown as RegistryReader

const makeApi = (reader: RegistryReader) =>
  createContextApi({ reader, deployment, dataDir: mkdtempSync(join(tmpdir(), "mida-reconcile-")), clock: () => NOW_SECONDS })

const clientFor = (app: ReturnType<typeof createContextApi>["app"], account: LocalAccount) =>
  new ContextApiClient({
    baseUrl: "http://mida.test",
    account,
    chainId: deployment.chainId,
    capabilityRegistry: deployment.capabilityRegistry,
    clock: () => NOW_SECONDS,
    fetch: async (url, init) => app.request(url, init),
  })

/** `count` foreign active notes — capability-targeted, so each one costs a getCapability if read. */
const seedForeignNotes = async (overlay: ReturnType<typeof makeApi>["overlay"], count: number) => {
  const ids: Hex[] = []
  for (let i = 0; i < count; i++) {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const note = await overlay.create(owner, { kind: "capability", capabilityId: hexOf(randomBytes(32)) }, null)
    ids.push(note.id)
  }
  return ids
}

const wrap: ReaderEpochWrap = {
  v: 1,
  owner: OWNER_A,
  namespaceId: NAMESPACE,
  readEpoch: "1",
  agentId: AGENT_ID,
  agentKeyVersion: 1,
  ephemeralPublicKey: hexOf(randomBytes(32)),
  nonce: hexOf(randomBytes(24)),
  wrappedEpochPrivateKey: hexOf(randomBytes(48)),
  createdAt: "1",
}

const authorize = (reader: RegistryReader, overlay: ReturnType<typeof makeApi>["overlay"]) =>
  authorizeAgent({
    reader,
    overlay,
    signer: agentAccount.address.toLowerCase() as Address,
    owner: OWNER_A,
    capabilityId: READ_CAP,
    namespaceId: NAMESPACE,
    permission: PERMISSION.READ,
  })

describe("owner-scoped deny reconciliation", () => {
  it("authorize ignores other owners' active notes: same reads as an empty store, their notes untouched", async () => {
    const state = { epoch: 1n, calls: [] as string[] }
    const api = makeApi(makeReader(state))
    const foreign = await seedForeignNotes(api.overlay, 40)
    const otherOwnerNote = await api.overlay.create(
      privateKeyToAccount(generatePrivateKey()).address,
      { kind: "agent", agentId: hexOf(randomBytes(32)) },
      3n,
    )

    const baseline = { epoch: 1n, calls: [] as string[] }
    const emptyOverlay = makeApi(makeReader(baseline)).overlay
    await authorize(new BudgetedReader(makeReader(baseline), MAX_CHAIN_READS_PER_REQUEST), emptyOverlay)
    const baselineReads = baseline.calls.length

    state.calls.length = 0
    const result = await authorize(new BudgetedReader(makeReader(state), MAX_CHAIN_READS_PER_REQUEST), api.overlay)
    expect(result.agentId).toBe(AGENT_ID)
    // No reconcile read was spent on the 40 foreign notes: the total is the empty-store count.
    expect(state.calls.length).toBe(baselineReads)
    expect(state.calls.filter((call) => call.startsWith("getCapability:"))).toEqual([`getCapability:${READ_CAP}`])
    const intents = await api.overlay.list()
    for (const id of foreign) expect(intents.find((intent) => intent.id === id)?.state).toBe("active")
    expect(intents.find((intent) => intent.id === otherOwnerNote.id)?.state).toBe("active")
  })

  it("authorize still gates on the requester's own note, and anchors it when Monad shows the revoke", async () => {
    const state = { epoch: 1n, calls: [] as string[] }
    const api = makeApi(makeReader(state))
    const note = await api.overlay.create(OWNER_A, { kind: "agent", agentId: AGENT_ID }, 1n)

    // The revoke has not landed: the note stays active and the agent is refused.
    const denied = await authorize(new BudgetedReader(makeReader(state), MAX_CHAIN_READS_PER_REQUEST), api.overlay).then(
      () => {
        throw new Error("expected CAPABILITY_REVOKED")
      },
      (error: unknown) => error,
    )
    expect(denied).toMatchObject({ code: "CAPABILITY_REVOKED" })
    expect((denied as Error).message).toContain("owner revocation intent is active")
    expect((await api.overlay.get(note.id))?.state).toBe("active")

    // Monad now shows the revoke (epoch moved): A's own note is reconciled to anchored.
    state.epoch = 2n
    await authorize(new BudgetedReader(makeReader(state), MAX_CHAIN_READS_PER_REQUEST), api.overlay)
    expect((await api.overlay.get(note.id))?.state).toBe("anchored")
  })

  it("POST /epoch-wraps ignores other owners' notes but still blocks on the recipient owner's own", async () => {
    const state = { epoch: 1n, calls: [] as string[] }
    const api = makeApi(makeReader(state))
    const client = clientFor(api.app, ownerAccount)
    const foreign = await seedForeignNotes(api.overlay, 40)

    expect(await client.publishEpochWrap(wrap)).toEqual({ stored: true })
    const intents = await api.overlay.list()
    for (const id of foreign) expect(intents.find((intent) => intent.id === id)?.state).toBe("active")

    // An active deny of A's on the recipient agent blocks publication of A's wrap.
    await api.overlay.create(OWNER_A, { kind: "agent", agentId: AGENT_ID }, 1n)
    await expect(client.publishEpochWrap(wrap)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" })
  })
})
