// Event handlers for the Mida Context indexer.
//
// Counting rules that matter (see README for the plain-language version):
// - Every handler first writes a ProcessedEvent marker keyed "${txHash}-${logIndex}".
//   If the marker exists the handler returns before touching anything, so a
//   re-delivered log (reorg, restart) cannot move a counter twice.
// - Counters only move when the row they describe is new: a re-seen agentId,
//   capabilityId or contextId never double-counts even under a different event id.
// - AgentRevoked ends EVERY still-active grant of the (owner, agentId) pair — the
//   contract invalidates them by bumping the pair's epoch without emitting
//   per-grant CapabilityRevoked events — so the index ends them itself via the
//   AgentGrantBook row that tracks the pair's live capability ids.
// - "activeGrants" means "granted and not revoked". Expiry is a wall-clock fact the
//   index cannot evaluate; readers filter on Grant.expiresAt themselves.
// - An evidence write emits BOTH ContextRegistered (recordType=1) and
//   EvidenceRegistered. Only recordType 0 counts in contextRecords; only
//   EvidenceRegistered counts in evidenceRecords — evidence is never double-counted.
// - All ids and addresses are stored lowercase.
import { indexer } from "envio"
import type { Agent, AgentGrantBook, BatchStats, EvmOnEventContext, GlobalStats, Owner } from "envio"

type Context = EvmOnEventContext
type EventId = { transaction: { hash: string }; logIndex: number }
type EventMeta = EventId & { block: { number: number; timestamp: number } }
// Generated entity fields are readonly; stats get locally mutated per event
// before being written back, so handlers work on a mutable view.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

// IMPORTANT: envio runs every handler twice per event — once in a parallel
// "preload" pass where set() is a no-op (cache warming), then for real. A get()
// can hand back the stored object itself, so mutating a fetched entity in place
// (stats.x += 1 on the object get() returned) would corrupt the store during
// preload even though the set() was discarded. Every mutation below therefore
// happens on a fresh object and reaches the store only through set().

const GLOBAL_ID = "global"
const lc = (v: string) => v.toLowerCase()
const eventId = (e: EventId) => `${lc(e.transaction.hash)}-${e.logIndex}`
const bookId = (owner: string, agentId: string) => `${lc(owner)}-${lc(agentId)}`

const zeroStats = (): GlobalStats => ({
  id: GLOBAL_ID,
  owners: 0,
  agents: 0,
  operators: 0,
  agentsByOutsideOperators: 0,
  grants: 0,
  activeGrants: 0,
  capabilityRevocations: 0,
  agentRevocations: 0,
  contextRecords: 0,
  supersessions: 0,
  evidenceRecords: 0,
  lastBlock: 0,
  lastTimestamp: 0n,
})

const getStats = async (context: Context): Promise<Mutable<GlobalStats>> => ({
  ...((await context.GlobalStats.get(GLOBAL_ID)) ?? zeroStats()),
})

// Writes the singleton with lastBlock/lastTimestamp advanced to this event.
// Entity fields are readonly-typed, so callers pass a fully updated object.
const saveStats = (context: Context, event: EventMeta, stats: GlobalStats) =>
  context.GlobalStats.set({
    ...stats,
    lastBlock: Math.max(stats.lastBlock, event.block.number),
    lastTimestamp:
      stats.lastTimestamp > BigInt(event.block.timestamp)
        ? stats.lastTimestamp
        : BigInt(event.block.timestamp),
  })

// The idempotency guard. Returns true when this exact log was handled before.
const alreadyProcessed = async (context: Context, event: EventId) => {
  const id = eventId(event)
  if (await context.ProcessedEvent.get(id)) return true
  context.ProcessedEvent.set({ id })
  return false
}

// Fetches or stages an Owner row. `isNew` tells the caller to bump owners.
const ensureOwner = async (context: Context, address: string, block: number) => {
  const id = lc(address)
  const existing = await context.Owner.get(id)
  if (existing) return { owner: existing, isNew: false }
  const owner: Owner = {
    id,
    firstSeenBlock: block,
    grants: 0,
    revocations: 0,
    records: 0,
    p256Registered: false,
    batchedSaves: 0,
  }
  return { owner, isNew: true }
}

const addTimeline = (
  context: Context,
  event: EventMeta,
  owner: string,
  kind: string,
  subjects: { agentId?: string; namespaceId?: string; capabilityId?: string; contextId?: string } = {},
) =>
  context.TimelineEntry.set({
    id: eventId(event),
    owner: lc(owner),
    kind,
    block: event.block.number,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
    txHash: lc(event.transaction.hash),
    agentId: subjects.agentId === undefined ? undefined : lc(subjects.agentId),
    namespaceId: subjects.namespaceId === undefined ? undefined : lc(subjects.namespaceId),
    capabilityId: subjects.capabilityId === undefined ? undefined : lc(subjects.capabilityId),
    contextId: subjects.contextId === undefined ? undefined : lc(subjects.contextId),
  })

// ENVIO_OUR_OPERATORS: comma-separated addresses that belong to us and do NOT count
// as traction. Envio Cloud only passes environment variables whose names start with
// ENVIO_, so that is the name to set there; OUR_OPERATORS is still read, for local
// runs, when ENVIO_OUR_OPERATORS is unset. Parsed per event so deployments can change
// it without a rebuild. An empty/unset list means every operator counts as outside
// (README warns loudly).
const ourOperators = () =>
  new Set(
    (process.env.ENVIO_OUR_OPERATORS ?? process.env.OUR_OPERATORS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )

// ---------------------------------------------------------------------------
// CapabilityRegistry
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "AgentRegistered" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const agentId = lc(event.params.agentId)
    const operator = lc(event.params.operator)
    const isOutside = !ourOperators().has(operator)

    const existing = await context.Agent.get(agentId)
    const agent: Agent = {
      id: agentId,
      operator,
      signer: lc(event.params.signer),
      registeredBlock: existing?.registeredBlock ?? event.block.number,
      revokedByOwners: existing?.revokedByOwners ?? 0,
      manifestVersion: event.params.capabilityManifestVersion,
      isOutsideOperator: existing?.isOutsideOperator ?? isOutside,
      encryptionKeyVersion: Number(event.params.encryptionKeyVersion),
      callbackOriginHash: lc(event.params.callbackOriginHash),
    }
    context.Agent.set(agent)
    if (!existing) {
      stats.agents += 1
      if (agent.isOutsideOperator) stats.agentsByOutsideOperators += 1
    }

    const op = await context.Operator.get(operator)
    if (op) {
      context.Operator.set({ ...op, agentsRegistered: op.agentsRegistered + 1 })
    } else {
      context.Operator.set({
        id: operator,
        agentsRegistered: 1,
        firstSeenBlock: event.block.number,
      })
      stats.operators += 1
    }
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "AgentRevoked" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const agentId = lc(event.params.agentId)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set({ ...ownerRow, revocations: ownerRow.revocations + 1 })
    stats.agentRevocations += 1

    context.Revocation.set({
      id: eventId(event),
      owner,
      kind: "agent",
      agentId,
      namespaceId: undefined,
      capabilityId: undefined,
      block: event.block.number,
      timestamp: BigInt(event.block.timestamp),
      txHash: lc(event.transaction.hash),
    })

    // The contract kills every grant of this pair at once (epoch bump, no
    // per-grant events). End each still-active grant the book knows about.
    const book = await context.AgentGrantBook.get(bookId(owner, agentId))
    if (book) {
      for (const capabilityId of book.activeCapabilityIds) {
        const grant = await context.Grant.get(capabilityId)
        if (grant && grant.revokedBlock === undefined) {
          context.Grant.set({
            ...grant,
            revokedBlock: event.block.number,
            revokedBy: "agent",
          })
          stats.activeGrants -= 1
        }
      }
      context.AgentGrantBook.deleteUnsafe(book.id)
    }

    const agent = await context.Agent.get(agentId)
    if (agent) {
      context.Agent.set({ ...agent, revokedByOwners: agent.revokedByOwners + 1 })
    }

    addTimeline(context, event, owner, "agent_revoked", { agentId })
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "CapabilityGranted" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const agentId = lc(event.params.agentId)
    const capabilityId = lc(event.params.capabilityId)
    const namespaceId = lc(event.params.namespaceId)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1

    if (!(await context.Grant.get(capabilityId))) {
      context.Grant.set({
        id: capabilityId,
        owner,
        agent: agentId,
        namespaceId,
        permissions: Number(event.params.permissions),
        provenancePolicy: Number(event.params.provenancePolicy),
        expiresAt: event.params.expiresAt,
        grantedBlock: event.block.number,
        revokedBlock: undefined,
        revokedBy: undefined,
        txHash: lc(event.transaction.hash),
      })
      stats.grants += 1
      stats.activeGrants += 1
      context.Owner.set({ ...ownerRow, grants: ownerRow.grants + 1 })

      const id = bookId(owner, agentId)
      const book = await context.AgentGrantBook.get(id)
      const bookRow: AgentGrantBook = {
        id,
        activeCapabilityIds: [...(book?.activeCapabilityIds ?? []), capabilityId],
      }
      context.AgentGrantBook.set(bookRow)
    } else {
      context.Owner.set(ownerRow)
    }

    addTimeline(context, event, owner, "capability_granted", {
      agentId,
      namespaceId,
      capabilityId,
    })
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "CapabilityRevoked" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const agentId = lc(event.params.agentId)
    const capabilityId = lc(event.params.capabilityId)
    const namespaceId = lc(event.params.namespaceId)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set({ ...ownerRow, revocations: ownerRow.revocations + 1 })
    stats.capabilityRevocations += 1

    context.Revocation.set({
      id: eventId(event),
      owner,
      kind: "capability",
      agentId,
      namespaceId,
      capabilityId,
      block: event.block.number,
      timestamp: BigInt(event.block.timestamp),
      txHash: lc(event.transaction.hash),
    })

    // A grant already ended by AgentRevoked must not decrement again — the
    // event row above still records that the on-chain call happened.
    const grant = await context.Grant.get(capabilityId)
    if (grant && grant.revokedBlock === undefined) {
      context.Grant.set({
        ...grant,
        revokedBlock: event.block.number,
        revokedBy: "capability",
      })
      stats.activeGrants -= 1

      const book = await context.AgentGrantBook.get(bookId(owner, agentId))
      if (book) {
        context.AgentGrantBook.set({
          ...book,
          activeCapabilityIds: book.activeCapabilityIds.filter((id) => id !== capabilityId),
        })
      }
    }

    addTimeline(context, event, owner, "capability_revoked", {
      agentId,
      namespaceId,
      capabilityId,
    })
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "NamespaceRegistered" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const namespaceId = lc(event.params.namespaceId)
    if (!(await context.Namespace.get(namespaceId))) {
      context.Namespace.set({
        id: namespaceId,
        parentId: lc(event.params.parentId),
        name: event.params.name,
        highSensitivity: event.params.highSensitivity,
        registeredBlock: event.block.number,
      })
    }
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "NamespaceEpochKeySet" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set(ownerRow)
    addTimeline(context, event, owner, "namespace_epoch_key_set", {
      namespaceId: event.params.namespaceId,
    })
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "P256KeyRegistered" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set({ ...ownerRow, p256Registered: true })
    addTimeline(context, event, owner, "p256_key_registered")
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "ReadEpochRequired" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set(ownerRow)
    addTimeline(context, event, owner, "read_epoch_required", {
      namespaceId: event.params.namespaceId,
    })
    saveStats(context, event, stats)
  },
)

// Agent lifecycle updates: no owner, no timeline, no counters — they only keep
// the Agent row current when the agent is known to the index.
const updateAgent = async (
  context: Context,
  event: EventMeta,
  agentId: string,
  patch: Partial<Agent>,
) => {
  if (await alreadyProcessed(context, event)) return
  const stats = await getStats(context)
  const agent = await context.Agent.get(lc(agentId))
  if (agent) context.Agent.set({ ...agent, ...patch })
  saveStats(context, event, stats)
}

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "AgentCapabilityManifestUpdated" },
  ({ event, context }) =>
    updateAgent(context, event, event.params.agentId, {
      manifestVersion: event.params.capabilityManifestVersion,
    }),
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "AgentEncryptionKeyRotated" },
  ({ event, context }) =>
    updateAgent(context, event, event.params.agentId, {
      encryptionKeyVersion: Number(event.params.encryptionKeyVersion),
    }),
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "AgentOriginChanged" },
  ({ event, context }) =>
    updateAgent(context, event, event.params.agentId, {
      callbackOriginHash: lc(event.params.callbackOriginHash),
    }),
)

indexer.onEvent(
  { contract: "CapabilityRegistry", event: "AgentSigningKeyRotated" },
  ({ event, context }) =>
    updateAgent(context, event, event.params.agentId, {
      signer: lc(event.params.newSigner),
    }),
)

// ---------------------------------------------------------------------------
// ContextRegistry
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "ContextRegistry", event: "ContextRegistered" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)
    const record = event.params.record
    const contextId = lc(record.contextId)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1

    if (!(await context.ContextRecord.get(contextId))) {
      context.ContextRecord.set({
        id: contextId,
        owner,
        namespaceId: lc(record.namespaceId),
        author: lc(record.author),
        lineageId: lc(record.lineageId),
        parentId: lc(record.parentId),
        recordType: Number(record.recordType),
        kind: Number(record.kind),
        version: Number(record.version),
        readEpoch: record.readEpoch,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        provenanceSource: Number(record.provenanceSource),
        supersededBy: undefined,
        supersededBlock: undefined,
        registeredBlock: event.block.number,
        txHash: lc(event.transaction.hash),
      })
      context.Owner.set({ ...ownerRow, records: ownerRow.records + 1 })
      // Evidence (recordType 1) is counted by EvidenceRegistered, not here —
      // an evidence write emits both events and must not count twice.
      if (record.recordType === 0n) stats.contextRecords += 1
    } else {
      context.Owner.set(ownerRow)
    }

    addTimeline(context, event, owner, "context_registered", {
      namespaceId: event.params.namespaceId,
      contextId,
    })
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "ContextRegistry", event: "ContextSuperseded" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set(ownerRow)
    stats.supersessions += 1

    // contextId is the NEW record; parentId is the one being superseded. The
    // parent may predate start_block, so only annotate it if indexed.
    const parent = await context.ContextRecord.get(lc(event.params.parentId))
    if (parent) {
      context.ContextRecord.set({
        ...parent,
        supersededBy: lc(event.params.contextId),
        supersededBlock: event.block.number,
      })
    }

    addTimeline(context, event, owner, "context_superseded", {
      namespaceId: undefined,
      contextId: event.params.contextId,
    })
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "ContextRegistry", event: "EvidenceRegistered" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const owner = lc(event.params.owner)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1
    context.Owner.set(ownerRow)
    stats.evidenceRecords += 1

    addTimeline(context, event, owner, "evidence_registered", {
      namespaceId: event.params.namespaceId,
      contextId: event.params.contextId,
    })
    saveStats(context, event, stats)
  },
)

// ---------------------------------------------------------------------------
// BatchAnchor — batched checkpoint saves. The index only COUNTS these events;
// it never decides validity (the contract already did) and no save lands in
// ContextRecord, because batched saves never touch ContextRegistry.
// SaveAnchored / SaveRejected are the per-save log lines; BatchAnchored is the
// batch summary. The save counters move on the per-save lines only — the
// summary's acceptedCount/rejectedCount are never added, so one batch can
// never count its saves twice.
// ---------------------------------------------------------------------------

const BATCH_STATS_ID = "global"

const zeroBatchStats = (): BatchStats => ({
  id: BATCH_STATS_ID,
  batches: 0,
  anchoredSaves: 0,
  rejectedSaves: 0,
})

const getBatchStats = async (context: Context): Promise<Mutable<BatchStats>> => ({
  ...((await context.BatchStats.get(BATCH_STATS_ID)) ?? zeroBatchStats()),
})

indexer.onEvent(
  { contract: "BatchAnchor", event: "SaveAnchored" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const batchStats = await getBatchStats(context)
    const owner = lc(event.params.owner)

    const { owner: ownerRow, isNew } = await ensureOwner(context, owner, event.block.number)
    if (isNew) stats.owners += 1

    // One row per anchored save, keyed on contextId — the leaf's identity. A
    // second event carrying the same contextId (a replayed log, or a duplicated
    // leaf inside one batch) must not write a second row or move the counters:
    // they count saves, not log lines.
    const contextId = lc(event.params.contextId)
    if (!(await context.BatchedSave.get(contextId))) {
      context.BatchedSave.set({
        id: contextId,
        owner,
        namespaceId: lc(event.params.namespaceId),
        batchId: lc(event.params.batchId),
        position: Number(event.params.position),
        lineageId: lc(event.params.lineageId),
        version: Number(event.params.version),
        agentId: lc(event.params.author),
        block: event.block.number,
        txHash: lc(event.transaction.hash),
      })
      context.Owner.set({ ...ownerRow, batchedSaves: ownerRow.batchedSaves + 1 })
      batchStats.anchoredSaves += 1
    } else {
      context.Owner.set(ownerRow)
    }
    context.BatchStats.set(batchStats)
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "BatchAnchor", event: "SaveRejected" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const batchStats = await getBatchStats(context)
    batchStats.rejectedSaves += 1
    context.BatchStats.set(batchStats)
    saveStats(context, event, stats)
  },
)

indexer.onEvent(
  { contract: "BatchAnchor", event: "BatchAnchored" },
  async ({ event, context }) => {
    if (await alreadyProcessed(context, event)) return
    const stats = await getStats(context)
    const batchStats = await getBatchStats(context)
    batchStats.batches += 1
    context.BatchStats.set(batchStats)
    saveStats(context, event, stats)
  },
)
