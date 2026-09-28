import type { ContextKind, Hex, RecordReference } from "@mida/protocol"

/**
 * One memory record as the SDK reports it. `author` and `writtenAt` come from the chain (or the
 * store's received stamp while a save is pending) — never from the record's own content.
 */
export interface ContextItem {
  /** The record's contextId. */
  id: Hex
  namespace: string
  kind: ContextKind
  /** The decrypted payload value — the record's content, never a whole payload envelope. */
  content: string | Record<string, unknown>
  /** The author the chain recorded; `name` resolves through the home's identity files, null when unknown. */
  author: { name: string | null; id: Hex }
  /** The provenance source the chain recorded — agent writes are always "AGENT_INFERRED". */
  source: string
  /** ISO-8601. Anchored records carry the chain's stamp; pending ones the store's received stamp. */
  writtenAt: string
  /** "pending" = the batching lane accepted the save but Monad has not anchored it yet. */
  state: "anchored" | "pending"
  superseded: false
  references: RecordReference[]
  /** The on-chain proof of this record: its manifestHash and the record id to verify against. */
  proof: { manifestHash: Hex; recordId: Hex }
  /**
   * Checkpoint records only: the task the record belongs to. Workflow memory is task-scoped —
   * `context()` returns only the resolved task's checkpoint records, so on a checkpoint item
   * this always equals that task ("main" when the handle named none). Absent on every
   * non-checkpoint record, which is durable memory and never task-filtered.
   */
  task?: string
}

export interface ContextInput {
  /** One namespace — e.g. "projects.current". With `namespaces` unset, this is the whole read. */
  namespace?: string
  /** Several namespaces read together; there is no ranking, the merged order is the chain's. */
  namespaces?: string[]
  /** The byte budget, counted over each item's content. A single record larger than `limit` is
   *  returned alone with `overLimit` set — never hidden, never truncated. */
  limit: number
  /** ISO-8601 — only items whose effective stamp is strictly newer are returned. */
  since?: string
  /** A cursor from an earlier `context()` result — resumes strictly after it. */
  cursor?: string
}

export interface ContextResult {
  items: ContextItem[]
  /** Non-null while more items remain beyond this page — pass it back as `cursor`. */
  cursor: string | null
  /**
   * The project's other active tasks — name, who last saved, when — the same entries the
   * handoff prints as "Other active tasks". Awareness only: no content, no record ids; a
   * task's own thread is a deliberate `mida task show <name>` away. Empty when the read did
   * not touch `projects.current` or no other task saved recently.
   */
  otherTasks: { name: string; savedBy: string; savedAt: string }[]
  /** Set when a single record larger than `limit` was returned alone. */
  overLimit?: true
  /** Set when the store's list was incomplete — the items shown verified, but the list may not be whole. */
  partial?: true
}

export interface RememberInput {
  /** Required — the area the record lands in (e.g. "projects.current"). There is no `auto`. */
  namespace: string
  content: string | Record<string, unknown>
  /** Defaults to "INFERENCE" — the record is always written as AGENT_INFERRED. */
  kind?: ContextKind
  references?: RecordReference[]
  /** An earlier record of this agent's own lineage this one replaces — the SUPERSEDE_OWN path. */
  supersedes?: Hex
}

export interface RememberResult {
  id: Hex
  /** "anchored" on the direct lane; "pending" until the batching lane's save anchors. */
  state: "anchored" | "pending"
}

export interface RequestAccessResult {
  requestId: Hex
  /** The owner-side step nothing else can substitute for. */
  nextStep: string
}

export interface VerifyCheck {
  name: "commitment" | "author" | "grant-at-write"
  ok: boolean
  detail: string
}

export interface VerifyResult {
  valid: boolean
  checks: VerifyCheck[]
}

/** The session-start text `mida_handoff` would inject. Refusals throw — they never come back as text. */
export interface HandoffAnswer {
  kind: "handoff" | "empty"
  text: string
}

export interface WhatsNewAnswer {
  kind: "updates" | "none"
  text: string
}

export interface StatusAnswer {
  /** Whether the Mida service answered at all. */
  up: boolean
  /** The same lines `mida_status` prints — the service line, then this agent's verdict. */
  text: string
  service?: { pid: number | null; startedAt: string | null; queueDepth: number | null }
  agent?: { name: string; verdict: "approved" | "not-approved" | "revoked" | "general-assistance" | "unknown" }
}

/**
 * The seven calls every transport answers. `local` talks to the Mida service over this machine's
 * private socket; `direct` arrives in phase 2 with Sign in with Mida.
 */
export interface Transport {
  context(input: ContextInput): Promise<ContextResult>
  remember(input: RememberInput): Promise<RememberResult>
  requestAccess(): Promise<RequestAccessResult>
  verify(item: ContextItem): Promise<VerifyResult>
  handoff(): Promise<HandoffAnswer>
  whatsNew(): Promise<WhatsNewAnswer>
  status(): Promise<StatusAnswer>
}
