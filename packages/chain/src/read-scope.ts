import type { PublicClient } from "viem"

/**
 * in-9 R-5 — the per-operation read scope.
 *
 * One logical read (a handoff, a whats-new refresh) asks the chain the same questions many
 * times: the agent record for every epoch key, the capability state for every object, the
 * same block for every save it anchored. None of those answers can change inside one
 * operation — the chain either held them when the operation started or the next operation
 * will see the change. So the scope keeps one Map of `(method, args) → the in-flight wire
 * call`, shared by every client built inside the operation: the runtime's own client and
 * each agent's fresh one all hit the same entry, and an answer still on the wire is awaited
 * once, not re-requested.
 *
 * The scope is a snapshot by design and dies with the operation. It is never process-wide:
 * a revocation that lands between two handoffs is read fresh by the second one, because the
 * second handoff builds a new scope.
 *
 * A scope can also carry a deadline: once it passes, no NEW chain read starts for the
 * operation — an abandoned handoff stops spending the shared rate limit instead of finishing
 * a read nobody will ever render. Calls already on the wire are left to finish; only new
 * ones are refused with ReadDeadlineError.
 */
export interface ReadScope {
  /**
   * signer (lowercase address) → the read-scope token the store last issued for it (in-12 N-10).
   * The token is the store's own HMAC-signed grant — client code never invents one — so this map
   * is only ever filled from response headers, and an entry that has expired is replaced by the
   * next response's token rather than stamped again.
   */
  readonly tokens: Map<string, string>
  /** `(method, serialized args)` → the one in-flight or settled wire call the operation shares. */
  readonly memo: Map<string, Promise<unknown>>
  /** epoch ms after which the scope starts no new chain read; absent means no deadline. */
  readonly deadlineAt?: number
}

/** The error a read started after the scope's deadline gets — the operation ran out of time. */
export class ReadDeadlineError extends Error {
  readonly code = "read-deadline" as const
  constructor() {
    super("the operation's read deadline passed — no new chain reads start for it")
    this.name = "ReadDeadlineError"
  }
}

/** Walks the cause chain — viem wraps fetch failures — for a scope-deadline refusal. */
export function isReadDeadlineError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof ReadDeadlineError) return true
  }
  return false
}

export function createReadScope(options?: { deadlineMs?: number }): ReadScope {
  return {
    tokens: new Map(),
    memo: new Map(),
    ...(options?.deadlineMs === undefined ? {} : { deadlineAt: Date.now() + options.deadlineMs }),
  }
}

/**
 * The test-visible counter the transport probe is for requests: every memoized call records
 * whether it hit an existing entry or started the wire call. Counters accumulate until reset —
 * measure a window by resetting first.
 */
export const readScopeProbe = {
  hits: 0,
  misses: 0,
  /** reads refused after the scope's deadline */
  refused: 0,
  reset(): void {
    this.hits = 0
    this.misses = 0
    this.refused = 0
  },
}

/**
 * The client methods the scope may memoize — every one is a pure question about chain state
 * as it stood when the operation ran. Deliberately absent: anything whose honest answer can
 * change mid-operation (balances, nonces, receipts, estimates, simulations) or that sends.
 */
const MEMOIZED_METHODS = new Set(["readContract", "getBlock", "getBlockNumber", "getLogs"])

/**
 * The BatchAnchor questions whose honest answer can change inside one operation: a flush landing
 * mid-handoff turns `batchOf` from empty to anchored, moves `headCommitOf`, and raises
 * `hasBatchedSaves`. The readCheckpoints flush/re-poll loop exists to observe exactly those
 * transitions, so these reads always go to the wire — memoizing them would pin the pre-flush
 * answer and hide the batch that just landed.
 */
const FRESH_READS = new Set(["batchOf", "headCommitOf", "hasBatchedSaves"])

const bigintJson = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? `0x${value.toString(16)}` : value)

/**
 * A client whose memoized methods share the scope's wire calls. Only the whitelisted read
 * methods are touched; every other property and method passes straight through, so a
 * write-capable client wrapped here still sends, estimates and waits on receipts normally.
 *
 * A FAILED call is evicted from the memo: one transient refusal must not poison every later
 * identical read in the operation — the next one tries again on its own request.
 */
export function memoizedReads(client: PublicClient, scope: ReadScope): PublicClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop !== "string" || !MEMOIZED_METHODS.has(prop) || typeof value !== "function") {
        return value
      }
      const call = value as (...args: unknown[]) => unknown
      return (...args: unknown[]): Promise<unknown> => {
        if (scope.deadlineAt !== undefined && Date.now() >= scope.deadlineAt) {
          readScopeProbe.refused += 1
          return Promise.reject(new ReadDeadlineError())
        }
        if (prop === "readContract") {
          const functionName = (args[0] as { functionName?: string } | undefined)?.functionName
          if (functionName !== undefined && FRESH_READS.has(functionName)) {
            return Promise.resolve(call.apply(target, args))
          }
        }
        const key = `${prop}:${JSON.stringify(args, bigintJson)}`
        const held = scope.memo.get(key)
        if (held !== undefined) {
          readScopeProbe.hits += 1
          return held
        }
        readScopeProbe.misses += 1
        const pending = Promise.resolve(call.apply(target, args))
        scope.memo.set(key, pending)
        pending.catch(() => {
          if (scope.memo.get(key) === pending) scope.memo.delete(key)
        })
        return pending
      }
    },
  })
}
