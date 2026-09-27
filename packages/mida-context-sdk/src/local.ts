import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { permissionBits, provenancePolicyBits, POLICY_DOCUMENT_V1 } from "@mida/grant-advisor"
import { canonicalizeNamespace, isMidaError, namespaceId } from "@mida/protocol"
import type { Hex, PurposeId } from "@mida/protocol"
import { connectAgent } from "@mida/sdk"
import type { AccessRequestInput } from "@mida/sdk"
import { callDaemon, socketPathFor } from "./daemon.js"
import { MidaSdkError, serviceRefusal } from "./errors.js"
import type {
  ContextInput,
  ContextResult,
  HandoffAnswer,
  RememberInput,
  RememberResult,
  RequestAccessResult,
  StatusAnswer,
  Transport,
  VerifyCheck,
  VerifyResult,
  WhatsNewAnswer,
} from "./transport.js"
import type { ContextItem } from "./transport.js"

/** How long each call waits on the socket — the daemon's own budgets plus headroom. */
const CONTEXT_TIMEOUT_MS = 30_000
const REMEMBER_TIMEOUT_MS = 60_000 // a direct-lane save is a real transaction
const HANDOFF_TIMEOUT_MS = 10_000
const WHATS_NEW_TIMEOUT_MS = 10_000
const HEALTH_TIMEOUT_MS = 5_000
const STATUS_PROBE_TIMEOUT_MS = 10_000

/** The grant lifetime a request asks for — the same 30 days `mida request` uses. */
const GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60

const SERVICE_DOWN = "the Mida service is not answering — run any `mida` command to start it"

const HEX_ID = /^0x[0-9a-fA-F]{64}$/
const REFERENCE_RELATIONS = new Set(["supports", "derived_from", "confirmed_from"])

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * The default transport: every call goes to the Mida service (midad) over this machine's private
 * Unix socket, so the daemon's gates — grants, revocation, the save lanes, the verified reads —
 * decide every answer. The SDK holds no chain keys and signs nothing itself; `requestAccess` and
 * `verify` are the exceptions, which read the agent's own identity files from the Mida home
 * through `@mida/sdk`, exactly as the CLI does.
 */
export class LocalTransport implements Transport {
  readonly #agent: string
  readonly #home: string
  readonly #project: string
  readonly #task: string | undefined

  constructor(options: { agent: string; home: string; project: string; task?: string }) {
    this.#agent = options.agent
    this.#home = options.home
    this.#project = options.project
    this.#task = options.task
  }

  /**
   * One socket call, mapped onto the SDK's error contract: no answer is `service-unavailable`, a
   * `refused` body throws the refusal's own code, and anything the call cannot honour is `failed`.
   */
  async #call(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const reply = await callDaemon(this.#home, path, body, { timeoutMs })
    if (reply.status === 0) {
      throw new MidaSdkError("service-unavailable", `${SERVICE_DOWN}. Nothing happened.`)
    }
    const record = isObj(reply.body) ? reply.body : null
    if (record !== null && record.kind === "refused") {
      const reason = typeof record.reason === "string" ? record.reason : "unknown"
      const text = typeof record.text === "string" ? record.text : `Mida refused the call (${reason}) — nothing happened.`
      const lane = record.lane === "direct" || record.lane === "batched" ? record.lane : undefined
      throw serviceRefusal(reason, text, { ...(lane === undefined ? {} : { lane }) })
    }
    if (reply.status !== 200) {
      throw new MidaSdkError("failed", `the Mida service could not answer this call (HTTP ${reply.status}) — nothing happened`)
    }
    return reply.body
  }

  async context(input: ContextInput): Promise<ContextResult> {
    // Validate here, before the socket: `limit` is required and counts bytes of content.
    if (input === undefined || input === null || !Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new MidaSdkError("invalid-option", "context() needs `limit` — a positive number of content bytes")
    }
    if (input.namespace !== undefined && input.namespaces !== undefined) {
      throw new MidaSdkError("invalid-option", "context() takes `namespace` or `namespaces`, not both")
    }
    if (input.namespaces !== undefined && (!Array.isArray(input.namespaces) || input.namespaces.length === 0)) {
      throw new MidaSdkError("invalid-option", "context() `namespaces` must be a non-empty list of namespace names")
    }
    const body = await this.#call(
      "/context",
      {
        agent: this.#agent,
        ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
        ...(input.namespaces === undefined ? {} : { namespaces: input.namespaces }),
        limit: input.limit,
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      CONTEXT_TIMEOUT_MS,
    )
    const record = body as { items?: unknown; cursor?: unknown; overLimit?: unknown; partial?: unknown }
    if (!Array.isArray(record.items)) {
      throw new MidaSdkError("failed", "the Mida service returned a context answer this SDK does not understand — nothing was read")
    }
    return {
      items: record.items as ContextResult["items"],
      cursor: typeof record.cursor === "string" ? record.cursor : null,
      ...(record.overLimit === true ? { overLimit: true as const } : {}),
      ...(record.partial === true ? { partial: true as const } : {}),
    }
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const extra = input as unknown as Record<string, unknown>
    // The source is the service's to stamp — always AGENT_INFERRED. A caller that tries to set a
    // USER_* provenance is refused before anything is signed, exactly as the contract would refuse.
    const claimed = extra["source"] ?? extra["provenance"]
    if (claimed !== undefined) {
      throw new MidaSdkError("invalid-option", "remember() writes are always AGENT_INFERRED — the source cannot be set. Nothing was written.")
    }
    if (typeof input?.namespace !== "string" || input.namespace === "") {
      throw new MidaSdkError("invalid-option", "remember() needs `namespace` — the context area the record belongs to")
    }
    if (input.namespace === "auto") {
      throw new MidaSdkError("invalid-option", "remember() has no `auto` namespace — name the area the record belongs to. Nothing was written.")
    }
    try {
      canonicalizeNamespace(input.namespace)
    } catch {
      throw new MidaSdkError("invalid-namespace", `"${input.namespace}" is not a context area Mida knows — nothing was written`)
    }
    if (input.supersedes !== undefined && !HEX_ID.test(input.supersedes)) {
      throw new MidaSdkError("invalid-option", "remember() `supersedes` must be a record id — a 32-byte hex string")
    }
    if (input.references !== undefined) {
      const bad = input.references.some(
        (ref) => !isObj(ref) || !REFERENCE_RELATIONS.has(String(ref.relation)) || typeof ref.recordId !== "string" || !HEX_ID.test(ref.recordId),
      )
      if (!Array.isArray(input.references) || bad) {
        throw new MidaSdkError("invalid-option", "remember() `references` must be { relation, recordId } pairs — nothing was written")
      }
    }
    const body = await this.#call(
      "/remember",
      {
        agent: this.#agent,
        namespace: input.namespace,
        content: input.content,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.references === undefined ? {} : { references: input.references }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      },
      REMEMBER_TIMEOUT_MS,
    )
    const record = body as { id?: unknown; state?: unknown }
    if (typeof record.id !== "string" || (record.state !== "anchored" && record.state !== "pending")) {
      throw new MidaSdkError("failed", "the Mida service returned a remember answer this SDK does not understand")
    }
    return { id: record.id as Hex, state: record.state }
  }

  /**
   * Files the access request where `mida approve <agent>` looks for it — `pending-request.json`
   * plus the request store — through the same `connectAgent` path the CLI uses. The agent cannot
   * approve itself: approval is the owner's terminal step, and this SDK carries no approve call.
   */
  async requestAccess(): Promise<RequestAccessResult> {
    const identityFile = join(this.#home, "agents", this.#agent, "identity.json")
    if (!existsSync(identityFile)) {
      throw new MidaSdkError("no-identity", `no agent "${this.#agent}" is set up in this Mida home — run \`mida init\` or \`mida add-agent ${this.#agent}\` first`)
    }
    const connected = connectAgent({ name: this.#agent, midaHome: this.#home })
    // Purpose comes off the identity file the way `mida request` reads it; a home written before
    // purposes existed defaults to project assistance, the grant every project agent asks for.
    let purposeId: PurposeId = "project_assistance"
    try {
      const record = JSON.parse(readFileSync(identityFile, "utf8")) as { purposeId?: unknown }
      if (record.purposeId === "project_assistance" || record.purposeId === "general_assistance") purposeId = record.purposeId
    } catch {
      // an unreadable identity file reaches connectAgent's own error below, which names the file
    }
    if (await connected.agent.hasLiveCapability(connected.owner)) {
      throw new MidaSdkError("not-approved", `${this.#agent} is already approved — there is nothing to request`)
    }
    const input: AccessRequestInput = {
      purposeId,
      scopes: POLICY_DOCUMENT_V1.purposes[purposeId].expected.map((entry) => ({
        namespace: entry.namespace,
        permissions: permissionBits(entry.permissions),
        provenancePolicy: provenancePolicyBits(entry.provenancePolicies),
      })),
      capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + GRANT_LIFETIME_SECONDS),
    }
    let request
    try {
      request = await connected.requestAccess(input)
    } catch (error) {
      throw toSdkError(error)
    }
    return {
      requestId: request.requestId,
      nextStep: `run \`mida approve ${this.#agent}\` in a terminal`,
    }
  }

  /**
   * Checks one item against the chain — not against the store or the payload. `commitment` asks
   * whether the registry's record carries exactly this manifest; `author` whether the chain
   * recorded this author; `grant-at-write` whether a record exists at all — the registry only
   * anchors writes made under a live grant, so anchoring is the grant-at-write proof.
   */
  async verify(item: ContextItem): Promise<VerifyResult> {
    const recordId = item?.proof?.recordId
    if (typeof recordId !== "string" || !HEX_ID.test(recordId)) {
      const checks: VerifyCheck[] = [
        { name: "commitment", ok: false, detail: "the item carries no valid record id to verify" },
        { name: "author", ok: false, detail: "no chain record to compare" },
        { name: "grant-at-write", ok: false, detail: "no chain record to compare" },
      ]
      return { valid: false, checks }
    }
    const connected = connectAgent({ name: this.#agent, midaHome: this.#home })
    let record
    try {
      record = await connected.agent.chainRecord(recordId.toLowerCase() as Hex)
    } catch (error) {
      throw toSdkError(error)
    }
    const nsId = (() => {
      try {
        return namespaceId(canonicalizeNamespace(item.namespace))
      } catch {
        return null
      }
    })()
    const checks: VerifyCheck[] = [
      {
        name: "commitment",
        ok: record !== null && record.manifestHash === item.proof.manifestHash && (nsId === null || record.namespaceId === nsId),
        detail:
          record === null
            ? "the registry holds no record with this id"
            : record.manifestHash === item.proof.manifestHash && (nsId === null || record.namespaceId === nsId)
              ? "the chain record's manifest commitment matches the item"
              : "the chain record's manifest commitment differs from the item's",
      },
      {
        name: "author",
        ok: record !== null && record.author.toLowerCase() === String(item.author?.id ?? "").toLowerCase(),
        detail:
          record !== null && record.author.toLowerCase() === String(item.author?.id ?? "").toLowerCase()
            ? "the chain recorded this author for the record"
            : "the chain recorded a different author — the claimed authorship does not hold",
      },
      {
        name: "grant-at-write",
        ok: record !== null && record.owner === connected.owner,
        detail:
          record !== null && record.owner === connected.owner
            ? "the record is anchored — Monad only anchors writes made under a live grant"
            : "the record is not anchored under this owner — no grant let this write land",
      },
    ]
    return { valid: checks.every((check) => check.ok), checks }
  }

  async handoff(): Promise<HandoffAnswer> {
    const body = await this.#call(
      "/handoff",
      { agent: this.#agent, cwd: this.#project, ...(this.#task === undefined ? {} : { task: this.#task }) },
      HANDOFF_TIMEOUT_MS,
    )
    const record = body as { kind?: unknown; text?: unknown }
    if ((record.kind !== "handoff" && record.kind !== "empty") || typeof record.text !== "string") {
      throw new MidaSdkError("failed", "the Mida service returned a handoff answer this SDK does not understand")
    }
    return { kind: record.kind, text: record.text }
  }

  async whatsNew(): Promise<WhatsNewAnswer> {
    const body = await this.#call(
      "/whatsnew",
      { agent: this.#agent, cwd: this.#project, ...(this.#task === undefined ? {} : { task: this.#task }) },
      WHATS_NEW_TIMEOUT_MS,
    )
    const record = body as { kind?: unknown; note?: unknown }
    if (record.kind === "updates" && typeof record.note === "string") {
      return { kind: "updates", text: record.note }
    }
    if (record.kind === "none") {
      return { kind: "none", text: "" }
    }
    throw new MidaSdkError("failed", "the Mida service returned a what's-new answer this SDK does not understand")
  }

  /**
   * `/health` plus the same `/handoff` probe `mida_status` runs per agent — the verdict line says
   * what that probe answered, word for word the adapter's line.
   */
  async status(): Promise<StatusAnswer> {
    const health = await callDaemon(this.#home, "/health", undefined, { timeoutMs: HEALTH_TIMEOUT_MS })
    if (health.status === 0) {
      return { up: false, text: `midad: not answering — ${SERVICE_DOWN}` }
    }
    const body = health.body as { ok?: unknown; pid?: unknown; startedAt?: unknown; queueDepth?: unknown } | null
    if (body?.ok !== true) {
      return { up: false, text: `midad: not answering — ${SERVICE_DOWN}` }
    }
    const startedAt =
      typeof body.startedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body.startedAt) ? body.startedAt : null
    const pid = typeof body.pid === "number" ? body.pid : null
    const queueDepth = typeof body.queueDepth === "number" ? body.queueDepth : null
    const service = { pid, startedAt, queueDepth }
    const lines = [
      `midad: answering — pid ${pid ?? "unknown"}, up since ${startedAt ?? "unknown"}, queue ${queueDepth ?? "unknown"} — socket in ${basename(dirname(socketPathFor(this.#home)))}`,
    ]
    const probe = await callDaemon(
      this.#home,
      "/handoff",
      { agent: this.#agent, cwd: this.#project, ...(this.#task === undefined ? {} : { task: this.#task }) },
      { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
    )
    const kind = (probe.body as { kind?: unknown } | null)?.kind
    const reason = (probe.body as { reason?: unknown } | null)?.reason
    const verdictLine =
      probe.status === 0
        ? `${this.#agent}: no answer from the daemon`
        : kind === "handoff" || kind === "empty"
          ? `${this.#agent}: approved for this folder`
          : reason === "revoked"
            ? `${this.#agent}: access revoked by the owner`
            : reason === "general-assistance"
              ? `${this.#agent}: a general assistant — it cannot read project context`
              : reason === "not-approved"
                ? `${this.#agent}: not approved for this folder`
                : `${this.#agent}: cannot tell (${typeof reason === "string" ? reason : "bad reply"})`
    lines.push(verdictLine)
    const verdict: NonNullable<StatusAnswer["agent"]>["verdict"] =
      probe.status === 0
        ? "unknown"
        : kind === "handoff" || kind === "empty"
          ? "approved"
          : reason === "revoked"
            ? "revoked"
            : reason === "general-assistance"
              ? "general-assistance"
              : reason === "not-approved"
                ? "not-approved"
                : "unknown"
    return { up: true, service, agent: { name: this.#agent, verdict }, text: lines.join("\n") }
  }
}

/**
 * The SDK-package errors `connectAgent` can raise arrive as plain `Error`s or `MidaError`s —
 * neither may leak a path detail the caller cannot use, so they map onto the SDK's own codes:
 * a missing identity is `no-identity`, a missing home file is `service-unavailable`, everything
 * else is `failed` with the upstream code as serviceReason when it carried one.
 */
function toSdkError(error: unknown): MidaSdkError {
  if (error instanceof MidaSdkError) return error
  const message = error instanceof Error ? error.message : "the call failed"
  if (isMidaError(error)) {
    const lower = error.code.toLowerCase().replace(/_/g, "-")
    return new MidaSdkError("failed", `${lower}: nothing happened`, { serviceReason: error.code, cause: error })
  }
  if (/not provisioned in this home|field ".+" is missing/.test(message)) {
    return new MidaSdkError("no-identity", `the agent's identity could not be read from this Mida home — run \`mida doctor\`. Nothing happened.`)
  }
  if (/run `mida init` first|no Context API to reach|does not exist/.test(message)) {
    return new MidaSdkError("service-unavailable", `${SERVICE_DOWN}. Nothing happened.`)
  }
  return new MidaSdkError("failed", "the call failed — nothing happened", { cause: error })
}
