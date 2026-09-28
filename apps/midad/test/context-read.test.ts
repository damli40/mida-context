import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaError, namespaceId } from "@mida/protocol"
import { MidaHome, buildContextRead } from "@mida/midad"
import type { ContextReadDeps, ServiceRuntime } from "@mida/midad"
import type { ContextObject } from "@mida/sdk"
import type { Hex } from "@mida/protocol"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-ctxread-")))

const OWNER = "0x0000000000000000000000000000000000000001" as const
const AGENT_ID = "0x00000000000000000000000000000000000000aa" as const
const OTHER_AGENT_ID = "0x00000000000000000000000000000000000000bb" as const
const PID = "proj-ctx"

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex
const NS = "projects.current"
const NS_ID = namespaceId(NS)

/** A verified ContextObject as readWithStatus returns it — chain fields only, no envelope tricks. */
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex

const object = (over: Partial<ContextObject> & { contextId: Hex }): ContextObject => ({
  owner: OWNER,
  namespace: NS,
  namespaceId: NS_ID,
  authorId: AGENT_ID,
  lineageId: over.contextId,
  parentId: ZERO,
  version: 1,
  readEpoch: 1n,
  recordType: "CONTEXT",
  manifestHash: `0x${"9".repeat(64)}` as Hex,
  payload: { v: 1, value: `record ${over.contextId.slice(2, 6)}`, kind: "INFERENCE", provenance: { source: "AGENT_INFERRED" } },
  ...over,
})

const runtime = (dir: MidaHome = home()): ServiceRuntime => ({ home: dir, owner: OWNER }) as unknown as ServiceRuntime

/** Every gate open; individual tests override one. */
const okDeps = (over: Partial<ContextReadDeps> = {}): ContextReadDeps => ({
  loadIdentity: () => ({ name: "codex", agentId: AGENT_ID }) as never,
  checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: PID, root: "/r", approvedAt: "t" } }),
  capability: async () => "live",
  isRevoked: () => false,
  read: async () => ({ objects: [], partial: false, skipped: 0 }),
  authorNames: () => ({ [AGENT_ID]: "codex", [OTHER_AGENT_ID]: "other-agent" }),
  ...over,
})

const call = async (deps: Partial<ContextReadDeps> = {}, body: Record<string, unknown> = {}, dir: MidaHome = home()) =>
  buildContextRead(runtime(dir), { agent: "codex", cwd: "/work", namespace: NS, limit: 100_000, ...body }, okDeps(deps))

describe("buildContextRead — the daemon's /context route", () => {
  it("returns items with chain-verified fields — author from the record, never the payload", async () => {
    const read = async () => ({
      objects: [
        object({ contextId: id(1), chain: { at: 1000n }, payload: { v: 1, value: { note: "first" }, kind: "FACT", provenance: { source: "AGENT_INFERRED", references: [{ relation: "supports", recordId: id(9) }] } } }),
        object({ contextId: id(2), authorId: OTHER_AGENT_ID, chain: { at: 2000n }, payload: { v: 1, value: "second", kind: "INFERENCE", provenance: { source: "AGENT_INFERRED" } } }),
      ],
      partial: false,
      skipped: 0,
    })
    const result = await call({ read })
    expect(result.kind).toBe("context")
    if (result.kind !== "context") return
    // newest first — the chain's own order, descending
    expect(result.items.map((item) => item.id)).toEqual([id(2), id(1)])
    const second = result.items[0]!
    expect(second.author).toEqual({ name: "other-agent", id: OTHER_AGENT_ID })
    expect(second.source).toBe("AGENT_INFERRED")
    expect(second.writtenAt).toBe(new Date(2000_000).toISOString())
    expect(second.state).toBe("anchored")
    expect(second.superseded).toBe(false)
    expect(second.content).toBe("second")
    expect(second.proof).toEqual({ manifestHash: `0x${"9".repeat(64)}`, recordId: id(2) })
    const first = result.items[1]!
    expect(first.references).toEqual([{ relation: "supports", recordId: id(9) }])
    expect(first.kind).toBe("FACT")
    expect(first.namespace).toBe(NS)
    expect(result.cursor).toBeNull()
    expect(result.overLimit).toBeUndefined()
  })

  it("returns only lineage heads — a superseded record is dropped, the newer version keeps its real author", async () => {
    const read = async () => ({
      objects: [
        object({ contextId: id(1), authorId: AGENT_ID, version: 1, chain: { at: 1000n }, payload: { v: 1, value: "old", kind: "FACT", provenance: { source: "AGENT_INFERRED" } } }),
        // a different agent wrote the replacement — the chain's parentId says so, not the payload
        object({ contextId: id(2), authorId: OTHER_AGENT_ID, lineageId: id(1), parentId: id(1), version: 2, chain: { at: 2000n }, payload: { v: 1, value: "new", kind: "FACT", provenance: { source: "AGENT_INFERRED" } } }),
      ],
      partial: false,
      skipped: 0,
    })
    const result = await call({ read })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.items.map((item) => item.id)).toEqual([id(2)])
    expect(result.items[0]!.author.id).toBe(OTHER_AGENT_ID)
  })

  it("a pending batched record is returned marked pending with the store's received stamp", async () => {
    const pending = { ...object({ contextId: id(7) }), anchor: "PENDING_ANCHOR" as const, authorAgentId: AGENT_ID, receivedAt: 1_700_000_000_000 }
    const result = await call({ read: async () => ({ objects: [pending], partial: false, skipped: 0 }) })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.items[0]!.state).toBe("pending")
    expect(result.items[0]!.writtenAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it("a pending record's supersession claim does not hide the anchored record it names", async () => {
    const anchored = object({ contextId: id(1), chain: { at: 1000n } })
    const pending = {
      ...object({ contextId: id(2), parentId: id(1), lineageId: id(1), version: 2 }),
      anchor: "PENDING_ANCHOR" as const,
      authorAgentId: AGENT_ID,
      receivedAt: 1_800_000_000_000,
    }
    const result = await call({ read: async () => ({ objects: [anchored, pending], partial: false, skipped: 0 }) })
    if (result.kind !== "context") throw new Error("expected context")
    // both shown: the pending child is marked pending, the parent stays until the child anchors
    expect(result.items.map((item) => item.id)).toEqual([id(2), id(1)])
    expect(result.items[1]!.state).toBe("anchored")
  })

  it("the byte budget packs whole records, newest first, and pages the rest with a cursor", async () => {
    const content = (ch: string, n: number) => ch.repeat(n)
    const objects = [
      object({ contextId: id(1), chain: { at: 1000n }, payload: { v: 1, value: content("a", 10), kind: "FACT", provenance: { source: "AGENT_INFERRED" } } }),
      object({ contextId: id(2), chain: { at: 2000n }, payload: { v: 1, value: content("b", 10), kind: "FACT", provenance: { source: "AGENT_INFERRED" } } }),
      object({ contextId: id(3), chain: { at: 3000n }, payload: { v: 1, value: content("c", 10), kind: "FACT", provenance: { source: "AGENT_INFERRED" } } }),
    ]
    const read = async () => ({ objects, partial: false, skipped: 0 })
    const first = await call({ read }, { limit: 20 })
    if (first.kind !== "context") throw new Error("expected context")
    expect(first.items.map((item) => item.id)).toEqual([id(3), id(2)])
    expect(first.cursor).toBe(id(2))
    const second = await call({ read }, { limit: 20, cursor: first.cursor! })
    if (second.kind !== "context") throw new Error("expected context")
    expect(second.items.map((item) => item.id)).toEqual([id(1)])
    expect(second.cursor).toBeNull()
  })

  it("a single record larger than limit is returned alone with overLimit — never hidden, never truncated", async () => {
    const big = object({ contextId: id(4), chain: { at: 1000n }, payload: { v: 1, value: "x".repeat(500), kind: "FACT", provenance: { source: "AGENT_INFERRED" } } })
    const result = await call({ read: async () => ({ objects: [big], partial: false, skipped: 0 }) }, { limit: 10 })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.overLimit).toBe(true)
    expect(result.items).toHaveLength(1)
    expect((result.items[0]!.content as string).length).toBe(500)
  })

  it("an oversized record mid-list ends the page before it; the next page returns it alone", async () => {
    const small = object({ contextId: id(1), chain: { at: 2000n }, payload: { v: 1, value: "tiny", kind: "FACT", provenance: { source: "AGENT_INFERRED" } } })
    const big = object({ contextId: id(2), chain: { at: 1000n }, payload: { v: 1, value: "x".repeat(500), kind: "FACT", provenance: { source: "AGENT_INFERRED" } } })
    const read = async () => ({ objects: [small, big], partial: false, skipped: 0 })
    const first = await call({ read }, { limit: 10 })
    if (first.kind !== "context") throw new Error("expected context")
    expect(first.items.map((item) => item.id)).toEqual([id(1)])
    expect(first.cursor).toBe(id(1))
    const second = await call({ read }, { limit: 10, cursor: id(1) })
    if (second.kind !== "context") throw new Error("expected context")
    expect(second.overLimit).toBe(true)
    expect(second.items.map((item) => item.id)).toEqual([id(2)])
    expect(second.cursor).toBeNull()
  })

  it("since keeps only items whose effective stamp is strictly newer", async () => {
    const objects = [
      object({ contextId: id(1), chain: { at: 1000n } }),
      object({ contextId: id(2), chain: { at: 2000n } }),
      object({ contextId: id(3), chain: { at: 3000n } }),
    ]
    const result = await call({ read: async () => ({ objects, partial: false, skipped: 0 }) }, { since: new Date(2000_000).toISOString() })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.items.map((item) => item.id)).toEqual([id(3)])
  })

  it("a cursor that names no record in this read is refused as bad input", async () => {
    const result = await call({}, { cursor: id(99) })
    expect(result.kind).toBe("refused")
    if (result.kind === "refused") expect(result.reason).toBe("bad-input")
  })

  it("partial reads carry the flag — the items shown verified, the list may not be whole", async () => {
    const result = await call({ read: async () => ({ objects: [object({ contextId: id(1), chain: { at: 1000n } })], partial: true, skipped: 0 }) })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.partial).toBe(true)
    expect(result.items).toHaveLength(1)
  })

  it("checkpoint envelopes outside this folder's project are filtered out of projects.current", async () => {
    const checkpoint = {
      eventId: "cp-0123456789",
      agent: "codex",
      source: "agent-tool",
      createdAt: "2026-09-30T00:00:00.000Z",
      objective: "o",
      nextAction: "n",
      originalRequest: null,
      progress: [],
      decisions: [],
      rejected: [],
      constraints: [],
      artifacts: [],
      remainingPlan: [],
      evidence: [],
      unresolvedIssue: null,
    }
    const envelope = (projectId: string) => ({ type: "mida.checkpoint.v1", projectId, sessionId: "s", continuesSession: null, compiledBy: "codex", checkpoint })
    const mine = object({ contextId: id(1), chain: { at: 1000n }, payload: { v: 1, value: envelope(PID), kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } } })
    const foreign = object({ contextId: id(2), chain: { at: 2000n }, payload: { v: 1, value: envelope("proj-other"), kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } } })
    const plain = object({ contextId: id(3), chain: { at: 3000n }, payload: { v: 1, value: "no envelope", kind: "INFERENCE", provenance: { source: "AGENT_INFERRED" } } })
    const result = await call({ read: async () => ({ objects: [mine, foreign, plain], partial: false, skipped: 0 }) })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.items.map((item) => item.id)).toEqual([id(3), id(1)])
  })

  it("checkpoint items carry their task — named, 'main' when absent, never on a plain record", async () => {
    // in-18 S2: context() is task-agnostic and serves every task's records together, so a
    // checkpoint item must name the thread it came from — the envelope's own field, "main"
    // when the envelope names none, and no key at all on a non-checkpoint record.
    const checkpoint = {
      eventId: "cp-0123456789",
      agent: "codex",
      source: "agent-tool",
      createdAt: "2026-09-30T00:00:00.000Z",
      objective: "o",
      nextAction: "n",
      originalRequest: null,
      progress: [],
      decisions: [],
      rejected: [],
      constraints: [],
      artifacts: [],
      remainingPlan: [],
      evidence: [],
      unresolvedIssue: null,
    }
    const envelope = (task?: string) => ({
      type: "mida.checkpoint.v1",
      projectId: PID,
      sessionId: "s",
      continuesSession: null,
      compiledBy: "codex",
      checkpoint,
      ...(task === undefined ? {} : { task }),
    })
    const sdkTask = object({ contextId: id(1), chain: { at: 3000n }, payload: { v: 1, value: envelope("sdk"), kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } } })
    const mainTask = object({ contextId: id(2), chain: { at: 2000n }, payload: { v: 1, value: envelope(), kind: "EPISODE", provenance: { source: "AGENT_INFERRED" } } })
    const plain = object({ contextId: id(3), chain: { at: 1000n }, payload: { v: 1, value: "no envelope", kind: "INFERENCE", provenance: { source: "AGENT_INFERRED" } } })
    const result = await call({ read: async () => ({ objects: [sdkTask, mainTask, plain], partial: false, skipped: 0 }) })
    if (result.kind !== "context") throw new Error("expected context")
    expect(result.items.map((item) => item.id)).toEqual([id(1), id(2), id(3)])
    expect(result.items[0]!.task).toBe("sdk")
    expect(result.items[1]!.task).toBe("main")
    expect("task" in result.items[2]!).toBe(false)
  })

  it("a fact namespace needs no folder approval — the chain grant alone decides", async () => {
    let projectAsked = false
    const result = await call(
      {
        checkProject: async () => {
          projectAsked = true
          return { ok: false, reason: "not-a-project" }
        },
        read: async () => ({ objects: [object({ contextId: id(1), chain: { at: 1000n }, namespace: "profile.skills", namespaceId: namespaceId("profile.skills") })], partial: false, skipped: 0 }),
      },
      { namespace: "profile.skills", cwd: "/nowhere" },
    )
    expect(result.kind).toBe("context")
    expect(projectAsked).toBe(false)
  })

  it("projects.current without an approved folder refuses with the project check's own reason", async () => {
    const result = await call({ checkProject: async () => ({ ok: false, reason: "not-approved" }) })
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
  })

  it("a revoked agent refuses with revoked — never an empty list", async () => {
    const byChain = await call({ capability: async () => "revoked" })
    expect(byChain).toMatchObject({ kind: "refused", reason: "revoked" })
    const byMarker = await call({ capability: async () => "none", isRevoked: () => true })
    expect(byMarker).toMatchObject({ kind: "refused", reason: "revoked" })
  })

  it("an agent with no live capability is not-approved; a namespace read denied by the chain is not-approved too", async () => {
    const noGrant = await call({ capability: async () => "none" })
    expect(noGrant).toMatchObject({ kind: "refused", reason: "not-approved" })
    const denied = await call({ read: async () => { throw new MidaError("CAPABILITY_DENIED", "no grant") } })
    expect(denied).toMatchObject({ kind: "refused", reason: "not-approved" })
  })

  it("missing and unreadable identities are different refusals, both before any read", async () => {
    let asked = false
    const deps: Partial<ContextReadDeps> = {
      read: async () => {
        asked = true
        return { objects: [], partial: false, skipped: 0 }
      },
    }
    const missing = await call({ ...deps, loadIdentity: () => undefined })
    expect(missing).toMatchObject({ kind: "refused", reason: "no-identity" })
    const dir = home()
    mkdirSync(join(dir.root, "agents", "codex"), { recursive: true })
    writeFileSync(join(dir.root, "agents", "codex", "identity.json"), "{corrupt")
    const broken = await call({ ...deps, loadIdentity: () => { throw new Error("corrupt") } }, {}, dir)
    expect(broken).toMatchObject({ kind: "refused", reason: "identity-unreadable" })
    expect(asked).toBe(false)
  })

  it("bad agent names, unknown namespaces and bad input refuse before the identity is even read", async () => {
    const result = await call({}, { agent: "../escape" })
    expect(result).toMatchObject({ kind: "refused", reason: "bad-agent" })
    const unknown = await call({}, { namespace: "no.such.area" })
    expect(unknown).toMatchObject({ kind: "refused", reason: "invalid-namespace" })
    const noNs = await call({}, { namespace: undefined })
    expect(noNs).toMatchObject({ kind: "refused", reason: "bad-input" })
    const both = await call({}, { namespace: undefined, namespaces: [NS, "profile.skills"] })
    expect(both.kind).toBe("context")
    const clash = await call({}, { namespaces: [NS] })
    expect(clash).toMatchObject({ kind: "refused", reason: "bad-input" })
    const missingLimit = await call({}, { limit: undefined })
    expect(missingLimit).toMatchObject({ kind: "refused", reason: "bad-input" })
  })

  it("a chain failure inside the read names the chain reason, not a generic failure", async () => {
    const result = await call({ read: async () => { throw new MidaError("CHAIN_UNAVAILABLE", "rpc down") } })
    expect(result).toMatchObject({ kind: "refused", reason: "chain-busy" })
  })
})
