import { privateKeyToAccount } from "viem/accounts"
import { ContextApiClient } from "@mida/api"
import { MidaError, OWNER_AUTHOR_ID, PERMISSION, PROVENANCE_SOURCE, isMidaError, namespaceId } from "@mida/protocol"
import type { ContextKind, Hex } from "@mida/protocol"
import { scrubSecrets } from "@mida/compiler"
import type { Runtime, ServiceRuntime } from "./runtime.js"
import { listAgentNames, loadAgentIdentity } from "./keys.js"

/**
 * The two namespaces `mida remember` may write in M2, in the order the refusal message lists them.
 * Both are LOW-sensitivity preference/profile spaces the policy already recommends agents READ.
 */
export const FACT_NAMESPACES = ["preferences.communication", "profile.skills"] as const
export type FactNamespace = (typeof FACT_NAMESPACES)[number]
const DEFAULT_FACT_NAMESPACE: FactNamespace = "preferences.communication"
const MAX_FACT_CHARS = 2_000
/** At most this many facts are shown to a receiving agent, newest first. */
export const MAX_FACTS = 20

const KIND_FOR: Record<FactNamespace, ContextKind> = {
  "preferences.communication": "PREFERENCE",
  "profile.skills": "FACT",
}

export interface OwnerFact {
  text: string
  contextId: Hex
  namespace: string
  assertedAt: string
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
  options: { namespace?: string } = {},
): Promise<RememberResult> {
  const namespace = options.namespace ?? DEFAULT_FACT_NAMESPACE
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
    await vault.initializeNamespace(namespace)
    await repairFactWraps(runtime, nsId)
  }
  const written = await vault.createOwnerContext({
    namespace,
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
  for (const name of listAgentNames(home)) {
    let identity: ReturnType<typeof loadAgentIdentity>
    try {
      identity = loadAgentIdentity(home, name)
    } catch {
      continue
    }
    if (identity === undefined) continue
    if (!(await reader.hasAuthority(owner, identity.agentId, nsId, PERMISSION.READ, 0))) continue
    await vault.publishReaderWraps({ agentId: identity.agentId, namespaceId: nsId })
  }
}

/** The text a fact record carries, whatever shape its value took. */
function factText(value: unknown): string | null {
  const raw =
    typeof value === "string" ? value
    : typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string" ? (value as { text: string }).text
    : null
  if (raw === null) return null
  const text = oneLine(raw).trim()
  return text === "" ? null : text
}

/**
 * What this agent may see of "What you have told Mida about yourself" (A14): a full protocol read
 * of both fact namespaces as that agent, then ONLY records the chain itself attributes to the
 * owner — author id zero — with provenance USER_ASSERTED. The encrypted payload's own claim about
 * who wrote it is never consulted for authority: a record an agent managed to land there (it
 * cannot — the chain refuses, holding READ only) or an owner-authored record carrying an agent
 * provenance is dropped. A namespace the agent has no grant for contributes nothing, and is not an
 * error. Newest first, at most MAX_FACTS.
 */
export async function readOwnerFacts(runtime: ServiceRuntime, name: string): Promise<OwnerFact[]> {
  const agent = runtime.agent(name)
  const { reader, owner } = runtime
  const facts: { fact: OwnerFact; createdAt: bigint }[] = []
  for (const namespace of FACT_NAMESPACES) {
    let objects
    try {
      objects = await agent.read(owner, namespace)
    } catch (error) {
      // "No grant" contributes nothing — the M1 single-scope grant is exactly this case.
      if (isMidaError(error, "CAPABILITY_DENIED")) continue
      throw error
    }
    for (const object of objects) {
      // The chain's record decides who said this — never a field inside the encrypted payload.
      const record = await reader.getRecord(object.contextId)
      if (record === null) continue
      if (record.author !== OWNER_AUTHOR_ID) continue
      if (record.provenanceSource !== PROVENANCE_SOURCE.USER_ASSERTED) continue
      const text = factText(object.payload.value)
      if (text === null) continue
      facts.push({
        fact: { text, contextId: object.contextId, namespace, assertedAt: new Date(Number(record.createdAt) * 1000).toISOString() },
        createdAt: record.createdAt,
      })
    }
  }
  facts.sort((a, b) => Number(b.createdAt - a.createdAt) || b.fact.contextId.localeCompare(a.fact.contextId))
  return facts.slice(0, MAX_FACTS).map(({ fact }) => fact)
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
): Promise<{ ok: true; objects: number } | { ok: false; code: string }> {
  const identity = loadAgentIdentity(runtime.home, name)
  if (identity === undefined) throw new MidaError("CAPABILITY_DENIED", `agent "${name}" is not set up on this machine`)
  const signer = privateKeyToAccount(identity.signerPrivateKey)
  const api = new ContextApiClient({
    baseUrl: runtime.apiBaseUrl,
    account: signer,
    chainId: runtime.network.deployment.chainId,
    capabilityRegistry: runtime.network.deployment.capabilityRegistry,
  })
  const nsId = namespaceId(namespace)
  const capabilityId = runtime
    .agent(name)
    .grants.flatMap((grant) => grant.capabilities)
    .find((cap) => cap.namespaceId.toLowerCase() === nsId && (cap.permissions & PERMISSION.READ) === PERMISSION.READ)?.capabilityId
  try {
    const objects = await api.listObjects({ owner: runtime.owner, namespaceId: nsId, ...(capabilityId === undefined ? {} : { capabilityId }) })
    return { ok: true, objects: objects.length }
  } catch (error) {
    if (error instanceof MidaError) return { ok: false, code: error.code }
    throw error
  }
}
