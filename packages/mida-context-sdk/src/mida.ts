import { isAbsolute, resolve } from "node:path"
import { resolveMidaHome } from "./daemon.js"
import { MidaSdkError } from "./errors.js"
import { LocalTransport } from "./local.js"
import type {
  ContextInput,
  ContextResult,
  HandoffAnswer,
  RememberInput,
  RememberResult,
  RequestAccessResult,
  StatusAnswer,
  Transport,
  VerifyResult,
  WhatsNewAnswer,
} from "./transport.js"
import type { ContextItem } from "./transport.js"

/** The transports this version speaks. `direct` is a named promise for phase 2. */
export type TransportKind = "local" | "direct"

export interface MidaOptions {
  /** The agent name this app was provisioned as — the name `mida approve` signed for. */
  agent: string
  /** How to reach Mida. Default and only option today is `"local"` — this machine's Mida service. */
  transport?: TransportKind
  /** The folder this agent works in — what counts as "this project". Default: process.cwd(). */
  project?: string
  /** The named task this agent is doing; scopes handoff()/whatsNew()/status() and the checkpoint records context() returns. */
  task?: string
  /** The Mida home — the folder `mida init` made. Default: $MIDA_HOME, else ~/.mida. */
  home?: string
}

/**
 * An app's handle on this user's Mida context. Every method asks the same question Mida itself
 * would — the Mida service decides what this agent may see, sign and remember — so an SDK app
 * can never see more than the grants the owner signed allow.
 */
export class Mida {
  /** The agent name, as the owner approved it. */
  readonly agent: string
  /** The project folder `context()`/handoff calls answer for. */
  readonly project: string
  /** The named task this handle is doing, when one was given. */
  readonly task: string | undefined
  /** Which transport this handle uses. */
  readonly transportKind: TransportKind

  readonly #transport: Transport

  constructor(options: MidaOptions) {
    if (options === undefined || options === null || typeof options !== "object") {
      throw new MidaSdkError("invalid-option", "new Mida() needs an options object — at least `{ agent }`")
    }
    if (typeof options.agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(options.agent)) {
      throw new MidaSdkError("invalid-option", "`agent` must be a provisioned agent name — 1–40 lowercase letters, digits or dashes, starting with a letter or digit")
    }
    const kind = options.transport ?? "local"
    if (kind === "direct") {
      throw new MidaSdkError("transport-unavailable", "direct transport arrives with Sign in with Mida — today, omit `transport` or pass \"local\"")
    }
    if (kind !== "local") {
      throw new MidaSdkError("invalid-option", `transport "${String(kind)}" is not one Mida knows — today the only transport is "local"`)
    }
    const project = resolve(options.project ?? process.cwd())
    if (!isAbsolute(project)) {
      throw new MidaSdkError("invalid-option", "`project` must resolve to an absolute folder path")
    }
    if (options.task !== undefined && typeof options.task !== "string") {
      throw new MidaSdkError("invalid-option", "`task` must be a string — the name of the task this agent is doing")
    }
    this.agent = options.agent
    this.project = project
    this.task = options.task
    this.transportKind = kind
    this.#transport = new LocalTransport({ agent: options.agent, home: resolveMidaHome(options.home), project, task: options.task })
  }

  /**
   * Read this user's context in the areas this agent's grants cover — most-recently-anchored
   * first, byte-budgeted, whole records only. In `projects.current`, checkpoint records are
   * scoped to this handle's task (the same task `handoff()` resolves); the result's
   * `otherTasks` names the project's other active tasks without their content. Throws the
   * refusal's code (`not-approved`, `revoked`, `rate-limited`…) when the service refuses;
   * `service-unavailable` when midad isn't answering.
   */
  context(input: ContextInput): Promise<ContextResult> {
    return this.#transport.context(input)
  }

  /**
   * Write one memory: a note, a finding, a decision. Always recorded as AGENT_INFERRED — the
   * provenance is the service's to stamp, never the caller's. Returns the record's id and
   * whether it is already anchored (`anchored`) or accepted onto the batching lane (`pending`).
   */
  remember(input: RememberInput): Promise<RememberResult> {
    return this.#transport.remember(input)
  }

  /**
   * File a request asking the owner for this agent's grants. The agent can never approve itself:
   * approval is the owner's terminal step — `mida approve <agent>` — and nothing in this SDK
   * performs it.
   */
  requestAccess(): Promise<RequestAccessResult> {
    return this.#transport.requestAccess()
  }

  /** Check one item against the chain: its commitment, its author, and the grant it was written under. */
  verify(item: ContextItem): Promise<VerifyResult> {
    return this.#transport.verify(item)
  }

  /** The session-start text `mida_handoff` would inject for this agent and folder. */
  handoff(): Promise<HandoffAnswer> {
    return this.#transport.handoff()
  }

  /** What's new for this agent and folder — the same answer `mida_whats_new` gives. */
  whatsNew(): Promise<WhatsNewAnswer> {
    return this.#transport.whatsNew()
  }

  /**
   * Is the Mida service up, and what would this agent get here — approved, revoked, or
   * never asked. Always answers; `up: false` when midad is not answering.
   */
  status(): Promise<StatusAnswer> {
    return this.#transport.status()
  }
}
