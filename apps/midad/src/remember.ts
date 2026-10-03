import { privateKeyToAccount } from "viem/accounts"
import { zeroHash } from "viem"
import { ContextApiClient } from "@mida/api"
import { MidaError, OWNER_AUTHOR_ID, PERMISSION, PROVENANCE_SOURCE, isMidaError, namespaceId } from "@mida/protocol"
import { chainRefusalReason } from "./chain-busy.js"
import { daemonWarning } from "./log.js"
import type { ContextKind, Hex } from "@mida/protocol"
import type { ContextObject } from "@mida/sdk"
import { scrubSecrets } from "@mida/compiler"
import type { Runtime, ServiceRuntime } from "./runtime.js"
import { listAgentNames, loadAgentIdentity, markWrapsOwed } from "./keys.js"
import { movedOnSuffix, readEnvelope, validateMigrationEnvelope } from "./migration-envelope.js"

/**
 * The two namespaces `mida remember` may write in M2, in the order the refusal message lists them.
 * Both are LOW-sensitivity preference/profile spaces the policy already recommends agents READ.
 */
export const FACT_NAMESPACES = ["preferences.communication", "profile.skills"] as const
export type FactNamespace = (typeof FACT_NAMESPACES)[number]
export const DEFAULT_FACT_NAMESPACE: FactNamespace = "preferences.communication"
const MAX_FACT_CHARS = 2_000
/** At most this many facts are shown to a receiving agent, newest first. */
export const MAX_FACTS = 20

/** The id an owner types or reads back: the first 8 hex characters of the context id. */
export const factShortId = (contextId: string): string => contextId.replace(/^0x/i, "").slice(0, 8)
/** A chain instant as the owner sees it: "YYYY-MM-DD HH:MM UTC" from the record's ISO stamp. */
export const factStamp = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`

const KIND_FOR: Record<FactNamespace, ContextKind> = {
  "preferences.communication": "PREFERENCE",
  "profile.skills": "FACT",
}

export interface OwnerFact {
  text: string
  contextId: Hex
  namespace: string
  assertedAt: string
  /**
   * Set when a newer fact superseded this record on chain — the child's context id and its chain
   * stamp, what `mida read --as` prints as "(replaced by <short-id> on <date>)". The record is
   * never removed: a superseded fact stays anchored as history.
   */
  replacedBy?: { contextId: Hex; assertedAt: string }
}

export type RememberResult =
  | { kind: "remembered"; contextId: Hex; namespace: string }
  | { kind: "refused"; code: string; message: string }

const refuse = (code: string, message: string): RememberResult => ({ kind: "refused", code, message })

/** Every run of whitespace — newlines included — becomes one space, so a fact can never fake a heading. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ")

/**
 * The owner writes a fact about themselves with provenance USER_ASSERTED (§11.5/A14): the chain
 * records the owner — author id zero — as the record's author, so every authorized agent can later
 * tell "what you told Mida" from anything an agent inferred. Refusals are decided entirely by the
 * checks below and happen before any upload or transaction: a refused fact stores nothing.
 */
export async function remember(
  runtime: Runtime,
  fact: string,
  options: { namespace?: string; replaces?: { contextId: Hex; namespace: FactNamespace } } = {},
): Promise<RememberResult> {
  // A replacement writes into the fact it supersedes — the parent's namespace, never the default:
  // the registry's _supersede reverts on a namespace mismatch, so the parent decides.
  const namespace = options.replaces?.namespace ?? options.namespace ?? DEFAULT_FACT_NAMESPACE
  if (!(FACT_NAMESPACES as readonly string[]).includes(namespace)) {
    return refuse("namespace-not-enabled", `facts live in ${FACT_NAMESPACES.join(" and ")} only`)
  }
  const trimmed = fact.trim()
  if (trimmed === "") return refuse("empty-fact", "the fact is empty")
  if (trimmed.length > MAX_FACT_CHARS) return refuse("fact-too-long", `a fact is at most ${MAX_FACT_CHARS} characters`)
  const text = oneLine(trimmed)
  // The handoff fence's own markers are refused outright — quoting them would still read as a fence break.
  if (text.includes("=== BEGIN") || text.includes("=== END")) {
    return refuse("bad-characters", "a fact cannot contain the handoff fence markers")
  }
  if (scrubSecrets(text) !== text) return refuse("looks-like-a-secret", "that looks like a secret, and secrets are never stored")

  const { vault, reader, owner } = runtime
  const nsId = namespaceId(namespace)
  // A namespace the owner has never opened gets epoch 1 here (an M1 home only opened
  // projects.current); every agent that already holds READ then needs its reader wrap.
  if ((await reader.epochPublicKey(owner, nsId, 1n)) == null) {
    runtime.progress?.(`opening the ${namespace} context area…`)
    await vault.initializeNamespace(namespace)
    await repairFactWraps(runtime, nsId)
  }
  runtime.sendProgress("writing your fact")
  const written = await vault.createOwnerContext({
    namespace,
    // The registry's supersede path: the new fact names the old record as its expected parent,
    // so the chain itself records new-replaces-old and the old record stays anchored as history.
    ...(options.replaces === undefined ? {} : { expectedParentId: options.replaces.contextId }),
    payload: {
      v: 1,
      value: { text, assertedAt: new Date().toISOString() },
      kind: KIND_FOR[namespace as FactNamespace],
      provenance: { source: "USER_ASSERTED" },
      tags: ["mida-fact"],
    },
  })
  return { kind: "remembered", contextId: written.contextId, namespace }
}

/**
 * Publishes reader wraps for one namespace to every local agent the CHAIN says holds live exact
 * READ there. Needed when a fact namespace is opened after grants were already issued.
 */
async function repairFactWraps(runtime: Runtime, nsId: Hex): Promise<void> {
  const { vault, reader, owner, home } = runtime
  try {
    const targets: Hex[] = []
    for (const name of listAgentNames(home)) {
      let identity: ReturnType<typeof loadAgentIdentity>
      try {
        identity = loadAgentIdentity(home, name)
      } catch {
        continue
      }
      if (identity === undefined) continue
      if (await reader.hasAuthority(owner, identity.agentId, nsId, PERMISSION.READ, 0)) targets.push(identity.agentId)
    }
    if (targets.length > 0) {
      runtime.progress?.(`sending the new key to ${targets.length} agent${targets.length === 1 ? "" : "s"}…`)
    }
    for (const agentId of targets) {
      await vault.publishReaderWraps({ agentId, namespaceId: nsId })
    }
  } catch (error) {
    // UF-APR4: an interrupted fact-key send is owed work — the marker makes a later
    // `mida approve` run the repair pass for the readers that never got it.
    markWrapsOwed(home)
    throw error
  }
}

/**
 * The text a fact record carries, whatever shape its value took — plus, for a fact `mida migrate`
 * moved here, the move date its sealed envelope records. The suffix rides inside the fact text so
 * every list that prints facts — `mida read`, the handoff's fact block — shows it the same way.
 */
function factText(value: unknown): string | null {
  const raw =
    typeof value === "string" ? value
    : typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string" ? (value as { text: string }).text
    : null
  if (raw === null) return null
  const text = oneLine(raw).trim()
  if (text === "") return null
  if (typeof value === "object" && value !== null) {
    const migration = validateMigrationEnvelope((value as { migration?: unknown }).migration)
    if (migration.ok) return `${text} ${movedOnSuffix(migration.value)}`
  }
  return text
}

/**
 * What this agent may see of "What you have told Mida about yourself" (A14): a full protocol read
 * of both fact namespaces as that agent, then ONLY records the chain itself attributes to the
 * owner — author id zero — with provenance USER_ASSERTED. The encrypted payload's own claim about
 * who wrote it is never consulted for authority: a record an agent managed to land there (it
 * cannot — the chain refuses, holding READ only) or an owner-authored record carrying an agent
 * provenance is dropped. A namespace the agent has no grant for contributes nothing, and is not an
 * error. Newest first — by the ORIGINAL stating time, not the chain stamp: a fact `mida migrate`
 * moved carries its source time in the envelope (`originalCreatedAt`), and the chain's own
 * `createdAt` stamps at replay, several records to a whole second, so it cannot order moved
 * records at all. It remains the time for facts that never moved. At most MAX_FACTS.
 *
 * A record `mida remember --replaces` superseded is still anchored — the registry keeps it as
 * history. `history: true` returns every fact with `replacedBy` annotated on superseded ones
 * (what `mida read --as` prints); the default returns only lineage heads, which is what the
 * handoff's current-facts list must be.
 */
export async function readOwnerFacts(
  runtime: ServiceRuntime,
  name: string,
  // PROV-13: `onDenied` hears each area the store refused, with the refusal code — the list stays
  // silent about it (the handoff wants that), but `mida read` must not print "nothing saved" for
  // "no access". With a listener, an expired or revoked grant is reported for its area too,
  // instead of aborting the whole read; without one (the handoff), those still throw as before.
  options: { history?: boolean; onDenied?: (namespace: string, code: string) => void } = {},
): Promise<OwnerFact[]> {
  const agent = runtime.agent(name)
  const { reader, owner } = runtime
  const facts: { fact: OwnerFact; statedAt: number; chain?: ContextObject["chain"] }[] = []
  // parentId → the record that superseded it, over every object the read returned — the chain's
  // own supersession link, so a replaced fact is marked by what Monad recorded, never by a
  // payload claim.
  const supersededBy = new Map<string, { contextId: Hex; createdAt: bigint }>()
  // The two namespace reads are independent — asked together (in-9 R-5); "no grant" still
  // contributes nothing, the M1 single-scope grant being exactly that case.
  const listed = await Promise.all(
    FACT_NAMESPACES.map(async (namespace) => {
      try {
        return await agent.read(owner, namespace)
      } catch (error) {
        if (isMidaError(error, "CAPABILITY_DENIED")) {
          options.onDenied?.(namespace, "CAPABILITY_DENIED")
          return []
        }
        if (options.onDenied !== undefined) {
          for (const code of ["CAPABILITY_EXPIRED", "CAPABILITY_REVOKED"] as const) {
            if (isMidaError(error, code)) {
              options.onDenied(namespace, code)
              return []
            }
          }
        }
        throw error
      }
    }),
  )
  for (const [nsIndex, namespace] of FACT_NAMESPACES.entries()) {
    const objects = listed[nsIndex]!
    // The chain's record decides who said this — never a field inside the encrypted payload.
    // One getRecords per namespace: the SDK's own record check ran through Multicall3, which
    // does not share the operation's read memo, so per-object getRecord calls here would be N
    // fresh wire reads against the shared 10-requests-a-second bucket (in-38 V-1).
    const records = objects.length === 0 ? [] : await reader.getRecords(objects.map((object) => object.contextId))
    for (const [index, object] of objects.entries()) {
      const record = records[index]
      if (record === null || record === undefined) continue
      if (record.parentId !== zeroHash) supersededBy.set(record.parentId.toLowerCase(), { contextId: record.contextId, createdAt: record.createdAt })
      if (record.author !== OWNER_AUTHOR_ID) continue
      if (record.provenanceSource !== PROVENANCE_SOURCE.USER_ASSERTED) continue
      const text = factText(object.payload.value)
      if (text === null) continue
      // The ordering instant in milliseconds: the chain's createdAt in whole seconds, lowered
      // toward the envelope's originalCreatedAt when the record moved (readEnvelope checks both
      // slots — inside an object value, beside a string one). The envelope is sealed inside the
      // encrypted payload — a claim the record's owner could write — so it may only AGE the
      // fact: min(claim, chain stamp). A forged originalCreatedAt in the future collapses to
      // the chain stamp and can never make its record newer than Monad placed it (in-2 I0).
      let statedAt = Number(record.createdAt) * 1000
      try {
        const moved = readEnvelope(object.payload)
        if (moved !== undefined) statedAt = Math.min(Date.parse(moved.originalCreatedAt), statedAt)
      } catch {
        // a contradictory envelope — carried in both slots — sorts by chain time, never fatal
      }
      facts.push({
        // The stamp every reader prints is the same effective instant the sort uses — a moved
        // fact shows when it was stated, not the replay day (in-11 R-10).
        fact: { text, contextId: object.contextId, namespace, assertedAt: new Date(statedAt).toISOString() },
        statedAt,
        // Monad's own placement of the record — the tie-break below; an object read without
        // chain placement simply has none and loses a same-second tie to a placed one.
        chain: object.chain,
      })
    }
  }
  // Mark every fact the chain shows as superseded — the marker is the child's id and its own
  // chain stamp. The default view then keeps only lineage heads; the history view keeps them all.
  for (const { fact } of facts) {
    const child = supersededBy.get(fact.contextId.toLowerCase())
    if (child !== undefined) fact.replacedBy = { contextId: child.contextId, assertedAt: new Date(Number(child.createdAt) * 1000).toISOString() }
  }
  const shown = options.history === true ? facts : facts.filter(({ fact }) => fact.replacedBy === undefined)
  // Newest first by the original stating time; a same-second tie breaks by the order Monad
  // actually wrote the records in — block, then the anchoring transaction's index inside it,
  // then the save's own position inside the transaction — so a slow or lying clock can never
  // reorder what the chain already fixed. contextId is the last resort only, for records that
  // carry no placement at all.
  shown.sort((a, b) => {
    const time = b.statedAt - a.statedAt
    if (time !== 0) return time
    const aBlock = a.chain?.block
    const bBlock = b.chain?.block
    if (aBlock !== undefined || bBlock !== undefined) {
      if (aBlock === undefined) return 1
      if (bBlock === undefined) return -1
      if (aBlock !== bBlock) return aBlock < bBlock ? 1 : -1
    }
    // Inside one block the anchoring transaction decides before the save's own position —
    // `index` is a log index on the direct lane and a batch position on the batched one, two
    // units that may never be compared (in-13 M-5).
    const aTransaction = a.chain?.transaction
    const bTransaction = b.chain?.transaction
    if (aTransaction !== undefined || bTransaction !== undefined) {
      if (aTransaction === undefined) return 1
      if (bTransaction === undefined) return -1
      if (aTransaction !== bTransaction) return bTransaction - aTransaction
    }
    const aIndex = a.chain?.index
    const bIndex = b.chain?.index
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1
      if (bIndex === undefined) return -1
      if (aIndex !== bIndex) return bIndex - aIndex
    }
    return b.fact.contextId.localeCompare(a.fact.contextId)
  })
  return shown.slice(0, MAX_FACTS).map(({ fact }) => fact)
}

/** What `--replaces <short-id>` resolves to — the fact it will write against, or why it refuses. */
export type FactIdResolution =
  | { kind: "ok"; contextId: Hex; namespace: FactNamespace }
  | { kind: "refused"; code: string; message: string }

/**
 * What `mida remember --replaces <short-id>` writes against, answered before the owner is asked
 * "Type yes". The candidate set is the same chain-side rule `readOwnerFacts` prints:
 * owner-authored (author id zero) USER_ASSERTED records in the two fact namespaces, read off
 * Monad's records, never payload claims. A prefix matches against every candidate's context id —
 * zero matches and more than one are different refusals — and a fact the chain already shows a
 * child for is refused rather than re-superseded: it is history, and the chain's own answer
 * (StaleParent) would name nothing the owner can act on. A listing the store marks incomplete
 * refuses outright rather than resolving half the set.
 */
export async function resolveFactId(runtime: Runtime, shortId: string): Promise<FactIdResolution> {
  const prefix = shortId.trim().toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{1,64}$/.test(prefix)) {
    return { kind: "refused", code: "bad-fact-id", message: `a fact id is hexadecimal — the "id" part printed on a \`mida read --as\` line` }
  }
  const candidates: { contextId: Hex; namespace: FactNamespace }[] = []
  const superseded = new Set<string>()
  let partial = false
  for (const namespace of FACT_NAMESPACES) {
    const listed = await runtime.ownerApi.listObjects({ owner: runtime.owner, namespaceId: namespaceId(namespace) })
    partial = partial || listed.partial
    const records = await runtime.reader.getRecords(listed.objects.map((object) => object.contextId))
    for (const [index, record] of records.entries()) {
      if (record === null) continue
      if (record.parentId !== zeroHash) superseded.add(record.parentId.toLowerCase())
      if (record.author !== OWNER_AUTHOR_ID) continue
      if (record.provenanceSource !== PROVENANCE_SOURCE.USER_ASSERTED) continue
      candidates.push({ contextId: listed.objects[index]!.contextId, namespace })
    }
  }
  if (partial) return { kind: "refused", code: "list-incomplete", message: "the store could not verify the whole fact list — run the command again" }
  const matches = candidates.filter((candidate) => candidate.contextId.slice(2).toLowerCase().startsWith(prefix))
  if (matches.length === 0) {
    return { kind: "refused", code: "unknown-fact-id", message: `no remembered fact has an id starting with "${prefix}" — \`mida read --as <agent>\` lists them` }
  }
  if (matches.length > 1) {
    return { kind: "refused", code: "ambiguous-fact-id", message: `"${prefix}" names ${matches.length} facts — use more characters` }
  }
  const match = matches[0]!
  if (superseded.has(match.contextId.toLowerCase())) {
    return { kind: "refused", code: "fact-already-replaced", message: "that fact was already replaced — it stays as history" }
  }
  return { kind: "ok", contextId: match.contextId, namespace: match.namespace }
}

/**
 * `mida read --as <agent>` attempts `projects.current` through the real server: the agent's own
 * signer authenticates the request and the API's chain-bounded authorization answers. The refusal
 * code the server returns is the proof — never a local pre-check. A completed grant's capabilityId
 * is presented when the agent holds one for the namespace.
 */
export async function attemptNamespaceRead(
  runtime: ServiceRuntime,
  name: string,
  namespace: string,
): Promise<{ ok: true; objects: number; partial: boolean } | { ok: false; code: string }> {
  const identity = loadAgentIdentity(runtime.home, name)
  if (identity === undefined) throw new MidaError("CAPABILITY_DENIED", `agent "${name}" is not set up on this machine`)
  const signer = privateKeyToAccount(identity.signerPrivateKey)
  const api = new ContextApiClient({
    baseUrl: runtime.apiBaseUrl,
    account: signer,
    chainId: runtime.network.deployment.chainId,
    capabilityRegistry: runtime.network.deployment.capabilityRegistry,
    warn: daemonWarning(runtime.home),
  })
  const nsId = namespaceId(namespace)
  const capabilityId = runtime
    .agent(name)
    .grants.flatMap((grant) => grant.capabilities)
    .find((cap) => cap.namespaceId.toLowerCase() === nsId && (cap.permissions & PERMISSION.READ) === PERMISSION.READ)?.capabilityId
  try {
    const listed = await api.listObjects({ owner: runtime.owner, namespaceId: nsId, ...(capabilityId === undefined ? {} : { capabilityId }) })
    return { ok: true, objects: listed.objects.length, partial: listed.partial }
  } catch (error) {
    // "the chain could not be asked" gets the same reason everywhere — and a wrong setup or
    // refused key names itself instead of posing as busy (in-11 R-8)
    const chainReason = chainRefusalReason(error)
    if (chainReason !== undefined) return { ok: false, code: chainReason }
    if (error instanceof MidaError) return { ok: false, code: error.code }
    throw error
  }
}
