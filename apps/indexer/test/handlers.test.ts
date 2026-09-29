import { afterEach, describe, expect, it } from "vitest"
import {
  CHAIN_ID,
  START_BLOCK,
  addr,
  bytes32,
  contextRecordTuple,
  grantContext,
  item,
  newIndexer,
  run,
  txHash,
} from "./helpers.js"
import { KNOWN_OUR_OPERATORS } from "../src/our-operators.js"

const OWNER = addr(0x1001)
const OPERATOR = addr(0x2002)
const SIGNER = addr(0x3003)
const AGENT = bytes32(0x4001)
const NAMESPACE = bytes32(0x5001)
const CAP = bytes32(0x6001)

const B = START_BLOCK + 100

const agentRegistered = (opts: { tx: number; block: number; agentId?: string; operator?: string }) =>
  item(
    "CapabilityRegistry",
    "AgentRegistered",
    {
      agentId: opts.agentId ?? AGENT,
      operator: opts.operator ?? OPERATOR,
      signer: SIGNER,
      encryptionPublicKey: bytes32(0x11),
      encryptionKeyVersion: 1n,
      callbackOriginHash: bytes32(0x12),
      capabilityManifestHash: bytes32(0x13),
      capabilityManifestVersion: 1n,
    },
    { tx: opts.tx, block: opts.block },
  )

const capabilityGranted = (
  capId: string,
  opts: { tx: number; block: number; logIndex?: number; owner?: string; agentId?: string },
) =>
  item(
    "CapabilityRegistry",
    "CapabilityGranted",
    {
      owner: opts.owner ?? OWNER,
      agentId: opts.agentId ?? AGENT,
      namespaceId: NAMESPACE,
      capabilityId: capId,
      permissions: 1n,
      provenancePolicy: 0n,
      expiresAt: 1800000000n,
      context: grantContext(1),
    },
    { tx: opts.tx, block: opts.block, logIndex: opts.logIndex },
  )

afterEach(() => {
  delete process.env.OUR_OPERATORS
  delete process.env.ENVIO_OUR_OPERATORS
})

describe("AgentRegistered", () => {
  it("creates Agent + Operator rows and counts an outside operator", async () => {
    const idx = newIndexer()
    await run(idx, [agentRegistered({ tx: 1, block: B })])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.agents).toBe(1)
    expect(stats?.operators).toBe(1)
    expect(stats?.agentsByOutsideOperators).toBe(1)
    expect(stats?.lastBlock).toBe(B)

    const agent = await idx.Agent.get(AGENT)
    expect(agent?.operator).toBe(OPERATOR)
    expect(agent?.signer).toBe(SIGNER)
    expect(agent?.registeredBlock).toBe(B)
    expect(agent?.manifestVersion).toBe(1n)
    expect(agent?.isOutsideOperator).toBe(true)

    const operator = await idx.Operator.get(OPERATOR)
    expect(operator?.agentsRegistered).toBe(1)
    expect(operator?.firstSeenBlock).toBe(B)
  })

  it("does not count an operator listed in OUR_OPERATORS as outside", async () => {
    process.env.OUR_OPERATORS = `${OPERATOR},${addr(0x9999)}`
    const idx = newIndexer()
    await run(idx, [
      agentRegistered({ tx: 1, block: B }),
      agentRegistered({ tx: 2, block: B + 1, agentId: bytes32(0x4002), operator: addr(0x7777) }),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.agents).toBe(2)
    expect(stats?.operators).toBe(2)
    expect(stats?.agentsByOutsideOperators).toBe(1)
    expect((await idx.Agent.get(AGENT))?.isOutsideOperator).toBe(false)
    expect((await idx.Agent.get(bytes32(0x4002)))?.isOutsideOperator).toBe(true)
  })

  it("does not count an operator listed in ENVIO_OUR_OPERATORS as outside", async () => {
    process.env.ENVIO_OUR_OPERATORS = `${OPERATOR},${addr(0x9999)}`
    const idx = newIndexer()
    await run(idx, [
      agentRegistered({ tx: 1, block: B }),
      agentRegistered({ tx: 2, block: B + 1, agentId: bytes32(0x4002), operator: addr(0x7777) }),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.agents).toBe(2)
    expect(stats?.operators).toBe(2)
    expect(stats?.agentsByOutsideOperators).toBe(1)
    expect((await idx.Agent.get(AGENT))?.isOutsideOperator).toBe(false)
    expect((await idx.Agent.get(bytes32(0x4002)))?.isOutsideOperator).toBe(true)
  })

  it("prefers ENVIO_OUR_OPERATORS over OUR_OPERATORS when both are set", async () => {
    process.env.ENVIO_OUR_OPERATORS = addr(0x9999)
    process.env.OUR_OPERATORS = OPERATOR
    const idx = newIndexer()
    await run(idx, [agentRegistered({ tx: 1, block: B })])

    expect((await idx.GlobalStats.get("global"))?.agentsByOutsideOperators).toBe(1)
    expect((await idx.Agent.get(AGENT))?.isOutsideOperator).toBe(true)
  })

  it("counts an operator from the committed list as ours with no env list set", async () => {
    const idx = newIndexer()
    await run(idx, [
      agentRegistered({
        tx: 1,
        block: B,
        operator: "0xe36e9079eec8a46df83a905065d0f3bd12bdd20a",
      }),
    ])

    expect((await idx.GlobalStats.get("global"))?.agentsByOutsideOperators).toBe(0)
    expect((await idx.Agent.get(AGENT))?.isOutsideOperator).toBe(false)
  })

  it("adds ENVIO_OUR_OPERATORS to the committed list", async () => {
    process.env.ENVIO_OUR_OPERATORS = OPERATOR
    const idx = newIndexer()
    await run(idx, [
      agentRegistered({ tx: 1, block: B }),
      agentRegistered({
        tx: 2,
        block: B + 1,
        agentId: bytes32(0x4002),
        operator: "0x57aa727ba4a1c6603e9d8edaee2112ff1b1e09e4",
      }),
    ])

    expect((await idx.GlobalStats.get("global"))?.agentsByOutsideOperators).toBe(0)
  })

  it("keeps the committed operator list well-formed", () => {
    expect(KNOWN_OUR_OPERATORS).toHaveLength(8)
    for (const op of KNOWN_OUR_OPERATORS) {
      expect(op).toMatch(/^0x[0-9a-f]{40}$/)
    }
    expect(new Set(KNOWN_OUR_OPERATORS).size).toBe(KNOWN_OUR_OPERATORS.length)
  })

  it("counts an unlisted operator as outside when OUR_OPERATORS is empty", async () => {
    process.env.OUR_OPERATORS = ""
    const idx = newIndexer()
    await run(idx, [agentRegistered({ tx: 1, block: B })])
    expect((await idx.GlobalStats.get("global"))?.agentsByOutsideOperators).toBe(1)
  })

  it("lowercases mixed-case addresses and ids", async () => {
    const idx = newIndexer()
    const mixedOp = `0x${"Ab".repeat(20)}`
    const mixedAgent = `0x${"Cd".repeat(32)}`
    await run(idx, [
      item(
        "CapabilityRegistry",
        "AgentRegistered",
        {
          agentId: mixedAgent,
          operator: mixedOp,
          signer: SIGNER,
          encryptionPublicKey: bytes32(0x11),
          encryptionKeyVersion: 1n,
          callbackOriginHash: bytes32(0x12),
          capabilityManifestHash: bytes32(0x13),
          capabilityManifestVersion: 1n,
        },
        { tx: 1, block: B },
      ),
    ])
    const agent = await idx.Agent.get(mixedAgent.toLowerCase())
    expect(agent).toBeDefined()
    expect(agent?.operator).toBe(mixedOp.toLowerCase())
    expect(await idx.Operator.get(mixedOp.toLowerCase())).toBeDefined()
    expect(await idx.Agent.get(mixedAgent)).toBeUndefined()
  })
})

describe("CapabilityGranted / CapabilityRevoked", () => {
  it("creates Grant + Owner rows, counts grants and activeGrants", async () => {
    const idx = newIndexer()
    await run(idx, [capabilityGranted(CAP, { tx: 1, block: B })])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.grants).toBe(1)
    expect(stats?.activeGrants).toBe(1)
    expect(stats?.owners).toBe(1)

    const grant = await idx.Grant.get(CAP)
    expect(grant?.owner).toBe(OWNER)
    expect(grant?.agent).toBe(AGENT)
    expect(grant?.namespaceId).toBe(NAMESPACE)
    expect(grant?.permissions).toBe(1)
    expect(grant?.expiresAt).toBe(1800000000n)
    expect(grant?.grantedBlock).toBe(B)
    expect(grant?.revokedBlock).toBeUndefined()
    expect(grant?.txHash).toBe(txHash(1))

    const owner = await idx.Owner.get(OWNER)
    expect(owner?.grants).toBe(1)
    expect(owner?.firstSeenBlock).toBe(B)
  })

  it("CapabilityRevoked ends the grant and drops activeGrants by one", async () => {
    const idx = newIndexer()
    await run(idx, [
      capabilityGranted(CAP, { tx: 1, block: B }),
      item(
        "CapabilityRegistry",
        "CapabilityRevoked",
        { owner: OWNER, agentId: AGENT, namespaceId: NAMESPACE, capabilityId: CAP },
        { tx: 2, block: B + 1, logIndex: 1 },
      ),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.grants).toBe(1)
    expect(stats?.activeGrants).toBe(0)
    expect(stats?.capabilityRevocations).toBe(1)

    const grant = await idx.Grant.get(CAP)
    expect(grant?.revokedBlock).toBe(B + 1)
    expect(grant?.revokedBy).toBe("capability")

    const revocation = await idx.Revocation.get(`${txHash(2)}-1`)
    expect(revocation?.kind).toBe("capability")
    expect(revocation?.capabilityId).toBe(CAP)
    expect(revocation?.owner).toBe(OWNER)

    expect((await idx.Owner.get(OWNER))?.revocations).toBe(1)
  })
})

describe("AgentRevoked", () => {
  it("revokes every still-active grant of the (owner, agent) pair", async () => {
    const idx = newIndexer()
    const caps = [bytes32(0x6001), bytes32(0x6002), bytes32(0x6003)]
    await run(idx, [
      agentRegistered({ tx: 0, block: B - 1 }),
      capabilityGranted(caps[0]!, { tx: 1, block: B, logIndex: 0 }),
      capabilityGranted(caps[1]!, { tx: 1, block: B, logIndex: 1 }),
      capabilityGranted(caps[2]!, { tx: 1, block: B, logIndex: 2 }),
      // A grant for a different agent must survive.
      capabilityGranted(bytes32(0x60ff), {
        tx: 1,
        block: B,
        logIndex: 3,
        agentId: bytes32(0x4002),
      }),
      item(
        "CapabilityRegistry",
        "AgentRevoked",
        { owner: OWNER, agentId: AGENT, agentEpoch: 2n },
        { tx: 2, block: B + 1, logIndex: 0 },
      ),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.grants).toBe(4)
    expect(stats?.activeGrants).toBe(1)
    expect(stats?.agentRevocations).toBe(1)
    expect(stats?.capabilityRevocations).toBe(0)

    for (const cap of caps) {
      const grant = await idx.Grant.get(cap)
      expect(grant?.revokedBlock).toBe(B + 1)
      expect(grant?.revokedBy).toBe("agent")
    }
    const survivor = await idx.Grant.get(bytes32(0x60ff))
    expect(survivor?.revokedBlock).toBeUndefined()

    const revocation = await idx.Revocation.get(`${txHash(2)}-0`)
    expect(revocation?.kind).toBe("agent")
    expect((await idx.Agent.get(AGENT))?.revokedByOwners).toBe(1)
  })

  it("a CapabilityRevoked after AgentRevoked changes nothing but is still recorded", async () => {
    const idx = newIndexer()
    await run(idx, [
      capabilityGranted(CAP, { tx: 1, block: B }),
      item(
        "CapabilityRegistry",
        "AgentRevoked",
        { owner: OWNER, agentId: AGENT, agentEpoch: 2n },
        { tx: 2, block: B + 1 },
      ),
      item(
        "CapabilityRegistry",
        "CapabilityRevoked",
        { owner: OWNER, agentId: AGENT, namespaceId: NAMESPACE, capabilityId: CAP },
        { tx: 3, block: B + 2 },
      ),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.activeGrants).toBe(0)
    expect(stats?.agentRevocations).toBe(1)
    expect(stats?.capabilityRevocations).toBe(1)

    const grant = await idx.Grant.get(CAP)
    expect(grant?.revokedBlock).toBe(B + 1)
    expect(grant?.revokedBy).toBe("agent")
  })
})

describe("context events", () => {
  it("ContextRegistered (recordType 0) creates a ContextRecord and counts it", async () => {
    const idx = newIndexer()
    const record = contextRecordTuple(1, 0n)
    await run(idx, [
      item(
        "ContextRegistry",
        "ContextRegistered",
        { owner: OWNER, namespaceId: NAMESPACE, contextId: record.contextId, record },
        { tx: 1, block: B },
      ),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.contextRecords).toBe(1)
    expect(stats?.evidenceRecords).toBe(0)

    const row = await idx.ContextRecord.get(record.contextId)
    expect(row?.owner).toBe(OWNER)
    expect(row?.recordType).toBe(0)
    expect(row?.registeredBlock).toBe(B)
    expect((await idx.Owner.get(OWNER))?.records).toBe(1)
  })

  it("ContextRegistered stores the record's provenanceSource", async () => {
    const idx = newIndexer()
    const record = { ...contextRecordTuple(1, 0n), provenanceSource: 1n }
    await run(idx, [
      item(
        "ContextRegistry",
        "ContextRegistered",
        { owner: OWNER, namespaceId: NAMESPACE, contextId: record.contextId, record },
        { tx: 1, block: B },
      ),
    ])

    const row = await idx.ContextRecord.get(record.contextId)
    expect(row?.provenanceSource).toBe(1)
  })

  it("an evidence write is not double-counted as a context record", async () => {
    const idx = newIndexer()
    const record = contextRecordTuple(1, 1n)
    await run(idx, [
      // The contract emits ContextRegistered (recordType=1) then EvidenceRegistered
      // for one evidence write — same transaction, consecutive log indices.
      item(
        "ContextRegistry",
        "ContextRegistered",
        { owner: OWNER, namespaceId: NAMESPACE, contextId: record.contextId, record },
        { tx: 1, block: B, logIndex: 0 },
      ),
      item(
        "ContextRegistry",
        "EvidenceRegistered",
        {
          owner: OWNER,
          namespaceId: NAMESPACE,
          contextId: record.contextId,
          author: record.author,
          manifestHash: record.manifestHash,
        },
        { tx: 1, block: B, logIndex: 1 },
      ),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.contextRecords).toBe(0)
    expect(stats?.evidenceRecords).toBe(1)

    const row = await idx.ContextRecord.get(record.contextId)
    expect(row?.recordType).toBe(1)
    expect((await idx.Owner.get(OWNER))?.records).toBe(1)
  })

  it("ContextSuperseded counts a supersession and marks the parent record", async () => {
    const idx = newIndexer()
    const parent = contextRecordTuple(1, 0n)
    const child = contextRecordTuple(2, 0n)
    const lineage = parent.lineageId
    await run(idx, [
      item(
        "ContextRegistry",
        "ContextRegistered",
        { owner: OWNER, namespaceId: NAMESPACE, contextId: parent.contextId, record: parent },
        { tx: 1, block: B },
      ),
      item(
        "ContextRegistry",
        "ContextRegistered",
        { owner: OWNER, namespaceId: NAMESPACE, contextId: child.contextId, record: { ...child, parentId: parent.contextId, lineageId: lineage } },
        { tx: 2, block: B + 1, logIndex: 0 },
      ),
      item(
        "ContextRegistry",
        "ContextSuperseded",
        {
          owner: OWNER,
          lineageId: lineage,
          contextId: child.contextId,
          parentId: parent.contextId,
          version: 2n,
        },
        { tx: 2, block: B + 1, logIndex: 1 },
      ),
    ])

    const stats = await idx.GlobalStats.get("global")
    expect(stats?.contextRecords).toBe(2)
    expect(stats?.supersessions).toBe(1)

    const parentRow = await idx.ContextRecord.get(parent.contextId)
    expect(parentRow?.supersededBy).toBe(child.contextId)
    expect(parentRow?.supersededBlock).toBe(B + 1)
  })
})

describe("remaining events", () => {
  it("NamespaceRegistered stores a Namespace row without owner or timeline", async () => {
    const idx = newIndexer()
    await run(idx, [
      item(
        "CapabilityRegistry",
        "NamespaceRegistered",
        { namespaceId: NAMESPACE, parentId: bytes32(0), name: "mida", highSensitivity: false },
        { tx: 1, block: B },
      ),
    ])
    const ns = await idx.Namespace.get(NAMESPACE)
    expect(ns?.name).toBe("mida")
    expect(ns?.highSensitivity).toBe(false)
    expect(await idx.TimelineEntry.getAll()).toHaveLength(0)
  })

  it("owner-bearing maintenance events create Owner rows and timeline entries", async () => {
    const idx = newIndexer()
    await run(idx, [
      item(
        "CapabilityRegistry",
        "P256KeyRegistered",
        { owner: OWNER, qx: 1n, qy: 2n, rotationNonce: 0n },
        { tx: 1, block: B, logIndex: 0 },
      ),
      item(
        "CapabilityRegistry",
        "NamespaceEpochKeySet",
        { owner: OWNER, namespaceId: NAMESPACE, readEpoch: 7n, publicKey: bytes32(0x21) },
        { tx: 1, block: B, logIndex: 1 },
      ),
      item(
        "CapabilityRegistry",
        "ReadEpochRequired",
        { owner: OWNER, namespaceId: NAMESPACE, readEpoch: 7n, writeDeadline: 99n },
        { tx: 1, block: B, logIndex: 2 },
      ),
    ])

    const owner = await idx.Owner.get(OWNER)
    expect(owner?.p256Registered).toBe(true)
    expect(owner?.firstSeenBlock).toBe(B)

    const timeline = await idx.TimelineEntry.getAll()
    expect(timeline).toHaveLength(3)
    const kinds = timeline.map((t) => t.kind).sort()
    expect(kinds).toEqual(["namespace_epoch_key_set", "p256_key_registered", "read_epoch_required"])
  })

  it("agent lifecycle events update the Agent row without owner rows", async () => {
    const idx = newIndexer()
    await run(idx, [
      agentRegistered({ tx: 1, block: B }),
      item(
        "CapabilityRegistry",
        "AgentCapabilityManifestUpdated",
        { agentId: AGENT, capabilityManifestHash: bytes32(0x31), capabilityManifestVersion: 3n },
        { tx: 2, block: B + 1 },
      ),
      item(
        "CapabilityRegistry",
        "AgentEncryptionKeyRotated",
        { agentId: AGENT, encryptionPublicKey: bytes32(0x32), encryptionKeyVersion: 4n },
        { tx: 3, block: B + 2 },
      ),
      item(
        "CapabilityRegistry",
        "AgentSigningKeyRotated",
        { agentId: AGENT, previousSigner: SIGNER, newSigner: addr(0x3f3f) },
        { tx: 4, block: B + 3 },
      ),
      item(
        "CapabilityRegistry",
        "AgentOriginChanged",
        { agentId: AGENT, callbackOriginHash: bytes32(0x33) },
        { tx: 5, block: B + 4 },
      ),
    ])

    const agent = await idx.Agent.get(AGENT)
    expect(agent?.manifestVersion).toBe(3n)
    expect(agent?.encryptionKeyVersion).toBe(4)
    expect(agent?.signer).toBe(addr(0x3f3f))
    expect(agent?.callbackOriginHash).toBe(bytes32(0x33))
    expect((await idx.GlobalStats.get("global"))?.owners).toBe(0)
  })
})
