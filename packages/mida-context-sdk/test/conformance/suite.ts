import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { isMidaSdkError } from "../../src/index.js"
import type { ContextInput, ContextResult, RememberInput, RememberResult } from "../../src/index.js"

/**
 * The conformance scenario every Mida transport must pass — the local transport runs it against
 * a real midad on local Anvil; phase 2's `direct` transport plugs the same calls in elsewhere.
 * The scenario is the product contract in miniature: an agent writes records, supersedes one,
 * reads back lineage heads in chain order with chain-proven authorship, and a revoked agent is
 * refused — never served an empty or stale answer.
 *
 * A transport binding supplies a client factory (two clients for one agent must see the same
 * world — the limits and the state live in the service, not the process) and the owner-side
 * controls the scenario cannot do through the SDK: provisioning the writer and revoking it.
 */

/** The surface the scenario exercises — any transport implementing context()/remember() fits. */
export interface ConformanceClient {
  context(input: ContextInput): Promise<ContextResult>
  remember(input: RememberInput): Promise<RememberResult>
}

export interface ConformanceSetup {
  /** The context area the scenario writes to — `projects.current` for the local transport. */
  namespace: string
  /** The agent the binding provisioned and approved before the suite ran. */
  writer: string
  /**
   * A record the writer already anchored in `namespace` — the supersede target. It must be
   * anchored, not pending: a pending row has no chain record yet, and superseding needs the
   * parent's row to name it (the direct lane's own write is the honest way to seed one).
   */
  seed: { id: `0x${string}` }
  /** A client for the named agent — called more than once for the same agent on purpose. */
  client(agent: string): ConformanceClient
  /** The owner-side revoke — the SDK carries no revoke call; this is what it would refuse after. */
  revoke(agent: string): Promise<void>
  /** Tear the binding down — daemon, chain, temp homes. */
  close(): Promise<void>
}

const HEX_ID = /^0x[0-9a-fA-F]{64}$/
/** Pending writes order on the store's receivedAt — a beat between saves keeps the stamps distinct. */
const beat = () => new Promise((resolve) => setTimeout(resolve, 20))

export function conformanceSuite(label: string, setup: () => Promise<ConformanceSetup>): void {
  describe(`mida transport conformance: ${label}`, () => {
    let env: ConformanceSetup
    beforeAll(async () => {
      env = await setup()
    }, 300_000)
    afterAll(async () => {
      await env?.close()
    })

    it("writes three records, supersedes one, and reads lineage heads newest-first with real authors", async () => {
      const first = env.client(env.writer)
      const second = env.client(env.writer) // a second process — same agent, same limits, same view
      const writes = [
        await first.remember({ namespace: env.namespace, content: { note: "one" } }),
        await beat().then(() => second.remember({ namespace: env.namespace, content: { note: "two" } })),
        await beat().then(() => first.remember({ namespace: env.namespace, content: { note: "three" } })),
      ]
      for (const write of writes) {
        expect(write.id).toMatch(HEX_ID)
        expect(["anchored", "pending"]).toContain(write.state)
      }
      // a supersede through the second client — the parent leaves the lineage heads
      const replacement = await beat().then(() =>
        second.remember({ namespace: env.namespace, content: { note: "seed — revised" }, supersedes: env.seed.id }),
      )
      const { items } = await first.context({ namespace: env.namespace, limit: 100_000 })
      const ids = items.map((item) => item.id)
      // the superseded parent is gone from the heads; the replacement and all three writes stay
      expect(ids).not.toContain(env.seed.id)
      expect(new Set(ids)).toEqual(new Set([replacement.id, writes[0]!.id, writes[1]!.id, writes[2]!.id]))
      // newest first — writtenAt is the record's effective instant, non-increasing down the page
      for (let i = 1; i < items.length; i += 1) {
        expect(Date.parse(items[i - 1]!.writtenAt)).toBeGreaterThanOrEqual(Date.parse(items[i]!.writtenAt))
      }
      // authorship comes from the chain record, never the payload — both clients wrote as the agent
      for (const item of items) {
        expect(item.author.name).toBe(env.writer)
        expect(item.source).toBe("AGENT_INFERRED")
        expect(item.superseded).toBe(false)
        expect(item.proof.recordId).toBe(item.id)
      }
      const head = items.find((item) => item.id === replacement.id)
      expect(head?.content).toEqual({ note: "seed — revised" })
    })

    it("a revoked agent is refused — never an empty or stale answer", async () => {
      await env.revoke(env.writer)
      const client = env.client(env.writer)
      const read = await client.context({ namespace: env.namespace, limit: 100_000 }).catch((error) => error)
      expect(isMidaSdkError(read, "revoked")).toBe(true)
      const write = await client.remember({ namespace: env.namespace, content: "still denied" }).catch((error) => error)
      expect(isMidaSdkError(write, "revoked")).toBe(true)
    })
  })
}
