// in-11 R-9: the batch gate's cheap early-out and its affirmative-answer contract. The gate
// exists for the pending-deny window only — an owner with no active deny intent never pays a
// chain read, because the overlay can hold nothing for it and Monad decides authority on submit.
// And "hold" is only ever the overlay's own affirmative answer: a failed check is not one.

import { describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { createBatchDenyGate } from "../src/batch-deny.js"
import { DenyOverlay } from "../src/deny-overlay.js"
import type { RevocationIntent } from "../src/deny-overlay.js"
import type { BatchSaveRow } from "../src/batch-store.js"
import type { RegistryReader } from "../src/chain-views.js"
import type { DenyStore } from "../src/stores.js"

const OWNER = "0x1111111111111111111111111111111111111111" as Address
const OTHER_OWNER = "0x2222222222222222222222222222222222222222" as Address
const SIGNER = "0x3333333333333333333333333333333333333333" as Address
const AGENT_ID = hexOf(randomBytes(32))
const OTHER_AGENT_ID = hexOf(randomBytes(32))
const NAMESPACE = namespaceId("goals.career")

function makeRow(input: { owner?: Address; signer?: Address; namespaceId?: Hex } = {}): BatchSaveRow {
  return {
    contextId: hexOf(randomBytes(32)),
    owner: input.owner ?? OWNER,
    namespaceId: input.namespaceId ?? NAMESPACE,
    signer: input.signer ?? SIGNER,
    save: {
      message: { owner: input.owner ?? OWNER, namespaceId: input.namespaceId ?? NAMESPACE, parentId: zeroHash, rootAuthor: zeroHash },
    } as unknown as BatchSaveRow["save"],
    state: "QUEUED",
    reason: null,
    batchId: null,
    position: null,
    lineageId: null,
    version: null,
    proof: null,
    receivedAt: 0,
    anchoredAt: null,
  }
}

function denyIntent(input: { owner?: Address; agentId?: Hex; state?: RevocationIntent["state"] } = {}): RevocationIntent {
  return {
    id: hexOf(randomBytes(32)),
    owner: (input.owner ?? OWNER).toLowerCase() as Address,
    target: { kind: "agent", agentId: (input.agentId ?? AGENT_ID).toLowerCase() as Hex },
    state: input.state ?? "active",
    agentEpochAtIntent: "5",
    cancellationNonce: "7",
  }
}

function denyStoreWith(intents: RevocationIntent[]): DenyStore {
  return {
    list: async () => intents.map((intent) => ({ ...intent })),
    get: async () => undefined,
    insert: async () => {},
    update: async () => {},
  }
}

/** A reader that proves the gate touched no chain: every method counts and answers a default. */
function spyReader() {
  const calls = { reads: 0 }
  const reader = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "agentIdOfSigner") return async () => (calls.reads += 1, AGENT_ID)
        if (prop === "agentEpoch") return async () => (calls.reads += 1, 5n)
        if (prop === "getCapability") return async () => (calls.reads += 1, null)
        if (prop === "hasAuthority") return async () => (calls.reads += 1, true)
        return async () => (calls.reads += 1, null)
      },
    },
  ) as RegistryReader
  return { reader, calls }
}

describe("createBatchDenyGate — the honest-save path (in-11 R-9)", () => {
  it("an owner with no intents at all answers 'send' without a single chain read", async () => {
    const { reader, calls } = spyReader()
    const gate = createBatchDenyGate({ reader, overlay: new DenyOverlay(denyStoreWith([])) })
    expect(await gate.check(makeRow())).toBe("send")
    expect(calls.reads).toBe(0)
  })

  it("a deny that belongs to another owner still costs the row's owner no reads", async () => {
    const { reader, calls } = spyReader()
    const overlay = new DenyOverlay(denyStoreWith([denyIntent({ owner: OTHER_OWNER })]))
    const gate = createBatchDenyGate({ reader, overlay })
    expect(await gate.check(makeRow())).toBe("send")
    expect(calls.reads).toBe(0)
  })

  it("a cancelled or anchored intent does not gate the owner either — only 'active' holds", async () => {
    const { reader, calls } = spyReader()
    const overlay = new DenyOverlay(denyStoreWith([denyIntent({ state: "cancelled" }), denyIntent({ state: "anchored" })]))
    const gate = createBatchDenyGate({ reader, overlay })
    expect(await gate.check(makeRow())).toBe("send")
    expect(calls.reads).toBe(0)
  })

  it("an active deny covering the row's agent still answers 'hold'", async () => {
    const { reader } = spyReader()
    const overlay = new DenyOverlay(denyStoreWith([denyIntent()]))
    const gate = createBatchDenyGate({ reader, overlay })
    expect(await gate.check(makeRow())).toBe("hold")
  })

  it("an active deny aimed at a different agent falls through to the authority answer", async () => {
    const { reader } = spyReader()
    const overlay = new DenyOverlay(denyStoreWith([denyIntent({ agentId: OTHER_AGENT_ID })]))
    const gate = createBatchDenyGate({ reader, overlay })
    expect(await gate.check(makeRow())).toBe("send")
  })
})
