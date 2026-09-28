import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaError, namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { MidaHome, buildRemember, pendingAnchors } from "@mida/midad"
import type { RememberDeps, ServiceRuntime } from "@mida/midad"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-remember-")))

const OWNER = "0x0000000000000000000000000000000000000001" as const
const AGENT_ID = "0x00000000000000000000000000000000000000aa" as const
const PID = "proj-remember"

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex
const NS = "projects.current"
const FACT = "profile.skills"

const runtime = (dir: MidaHome = home()): ServiceRuntime => ({ home: dir, owner: OWNER }) as unknown as ServiceRuntime

/** Every gate open and the direct lane answering; individual tests override one piece. */
const okDeps = (over: Partial<RememberDeps> = {}): RememberDeps => ({
  loadIdentity: () => ({ name: "codex", agentId: AGENT_ID }) as never,
  checkProject: async () => ({ ok: true, approval: { agent: "codex", projectId: PID, root: "/r", approvedAt: "t" } }),
  capability: async () => "live",
  isRevoked: () => false,
  revokePending: () => undefined,
  hasAuthority: async () => true,
  lane: async () => ({ kind: "direct", why: "switch-off" }),
  create: async (_runtime, _agent, _namespace, input) => ({ contextId: id(11), transactionHash: id(51), input } as never),
  createBatched: async (_runtime, _agent, _namespace, input) => ({ contextId: id(12), input } as never),
  supersede: async (_runtime, _agent, parentId, input) => ({ contextId: id(13), parentId, input } as never),
  ...over,
})

const call = async (deps: Partial<RememberDeps> = {}, body: Record<string, unknown> = {}, dir: MidaHome = home()) =>
  buildRemember(runtime(dir), { agent: "codex", cwd: "/work", namespace: NS, content: "a note", ...body }, okDeps(deps))

describe("buildRemember — the daemon's /remember route", () => {
  it("writes through the create path and answers the record id, anchored on the direct lane", async () => {
    let seen: { agent?: string; namespace?: string; input?: unknown } = {}
    const result = await call({
      create: async (_runtime, agent, namespace, input) => {
        seen = { agent, namespace, input }
        return { contextId: id(11), transactionHash: id(51) } as never
      },
    })
    expect(result).toMatchObject({ kind: "saved", id: id(11), state: "anchored", lane: "direct" })
    expect(seen.agent).toBe("codex")
    expect(seen.namespace).toBe(NS)
    const input = seen.input as { value: unknown; kind: string; source: string }
    expect(input.value).toBe("a note")
    expect(input.kind).toBe("INFERENCE")
    // always AGENT_INFERRED — the service stamps provenance, never the caller
    expect(input.source).toBe("AGENT_INFERRED")
  })

  it("passes kind and references through to the sealed record", async () => {
    let seen: { references?: unknown } = {}
    const result = await call(
      {
        create: async (_r, _a, _n, input) => {
          seen = input as { references?: unknown }
          return { contextId: id(11) } as never
        },
      },
      { kind: "DECISION", references: [{ relation: "supports", recordId: id(9) }] },
    )
    expect(result.kind).toBe("saved")
    expect(seen.references).toEqual([{ relation: "supports", recordId: id(9) }])
  })

  it("a batched lane queues the save, answers pending, and records it in the pending ledger under its namespace", async () => {
    const dir = home()
    const result = await call(
      {
        lane: async () => ({ kind: "batched", storeUrl: "http://store", batchAnchor: "0x00000000000000000000000000000000000000bb" }),
      },
      { namespace: FACT, cwd: undefined },
      dir,
    )
    expect(result).toMatchObject({ kind: "saved", id: id(12), state: "pending", lane: "batched" })
    const entries = pendingAnchors(dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.contextId).toBe(id(12))
    // the resubmit path must re-seal under THIS namespace — not the checkpoint one
    expect(entries[0]!.namespace).toBe(FACT)
  })

  it("a batched lane that closed between the lane decision and the POST still lands — on the direct lane (in-20 T-1)", async () => {
    // BATCHING_DISABLED / BATCH_UNAVAILABLE / OWNER_NOT_ALLOWED judge the lane, not the note —
    // the same write goes out on its own transaction rather than being refused or dropped.
    for (const code of ["BATCHING_DISABLED", "BATCH_UNAVAILABLE", "OWNER_NOT_ALLOWED"] as const) {
      const dir = home()
      const result = await call(
        {
          lane: async () => ({ kind: "batched", storeUrl: "http://store", batchAnchor: "0x00000000000000000000000000000000000000bb" }),
          createBatched: async () => {
            throw new MidaError(code as never, "the batched lane is closed")
          },
        },
        {},
        dir,
      )
      expect(result).toMatchObject({ kind: "saved", id: id(11), state: "anchored", lane: "direct" })
      expect(pendingAnchors(dir)).toHaveLength(0)
    }
  })

  it("the lane-closed fallback answers to the DIRECT lane's 1/min window, not the batched one (in-21 U-2)", async () => {
    // The decided lane reserved the batched slot (60/min); the fallback write goes out as its
    // own direct transaction, so it must pass the direct window exactly as a direct-decided
    // write does — one per minute, the rest refused `rate-limited` naming the direct lane.
    const admittedSaves = new Map<string, number[]>()
    let directSends = 0
    const deps = okDeps({
      lane: async () => ({ kind: "batched", storeUrl: "http://store", batchAnchor: "0x00000000000000000000000000000000000000bb" }),
      createBatched: async () => {
        throw new MidaError("BATCH_UNAVAILABLE" as never, "the batch lane is closed")
      },
      create: async () => {
        directSends += 1
        return { contextId: id(20 + directSends), transactionHash: id(51) } as never
      },
      admittedSaves,
    })
    const rt = runtime()
    const body = { agent: "codex", cwd: "/work", namespace: NS, content: "x" }
    const results = []
    for (let i = 0; i < 3; i += 1) {
      results.push(await buildRemember(rt, { ...body, content: `n${i}` }, deps))
    }
    expect(results[0]).toMatchObject({ kind: "saved", state: "anchored", lane: "direct" })
    for (const refused of results.slice(1)) {
      expect(refused).toMatchObject({ kind: "refused", reason: "rate-limited", lane: "direct" })
    }
    expect(directSends).toBe(1)
  })

  it("a caller-supplied provenance source is refused before anything is signed", async () => {
    let written = false
    const deps: Partial<RememberDeps> = {
      create: async () => {
        written = true
        return { contextId: id(11) } as never
      },
    }
    const result = await call(deps, { source: "USER_ASSERTED" })
    expect(result).toMatchObject({ kind: "refused", reason: "bad-input" })
    if (result.kind === "refused") expect(result.fields).toContain("source")
    expect(written).toBe(false)
  })

  it("namespace is required; auto and unknown areas refuse without touching the chain", async () => {
    const missing = await call({}, { namespace: undefined })
    expect(missing).toMatchObject({ kind: "refused", reason: "bad-input" })
    const auto = await call({}, { namespace: "auto" })
    expect(auto).toMatchObject({ kind: "refused", reason: "invalid-namespace" })
    const unknown = await call({}, { namespace: "no.such.area" })
    expect(unknown).toMatchObject({ kind: "refused", reason: "invalid-namespace" })
  })

  it("bad agent names, malformed content, kind, references and supersedes refuse as bad input", async () => {
    expect(await call({}, { agent: "../escape" })).toMatchObject({ kind: "refused", reason: "bad-agent" })
    expect(await call({}, { content: 42 })).toMatchObject({ kind: "refused", reason: "bad-input" })
    expect(await call({}, { content: ["a"] })).toMatchObject({ kind: "refused", reason: "bad-input" })
    expect(await call({}, { content: undefined })).toMatchObject({ kind: "refused", reason: "bad-input" })
    expect(await call({}, { kind: "NOT_A_KIND" })).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    expect(await call({}, { kind: "NONE" })).toMatchObject({ kind: "refused", reason: "invalid-shape" })
    expect(await call({}, { references: [{ relation: "caused", recordId: id(1) }] })).toMatchObject({
      kind: "refused",
      reason: "invalid-shape",
    })
    expect(await call({}, { references: [{ relation: "supports", recordId: "short" }] })).toMatchObject({
      kind: "refused",
      reason: "invalid-shape",
    })
    expect(await call({}, { supersedes: "not-hex" })).toMatchObject({ kind: "refused", reason: "invalid-shape" })
  })

  it("supersedes takes the supersede path — never the batch lane — even when batching is on", async () => {
    let superseded: string | undefined
    let batched = false
    const result = await call(
      {
        lane: async () => ({ kind: "batched", storeUrl: "http://store", batchAnchor: "0x00000000000000000000000000000000000000bb" }),
        createBatched: async () => {
          batched = true
          return { contextId: id(12) } as never
        },
        supersede: async (_r, _a, parentId) => {
          superseded = parentId
          return { contextId: id(13) } as never
        },
      },
      { supersedes: id(3) },
    )
    expect(result).toMatchObject({ kind: "saved", id: id(13), state: "anchored", lane: "direct" })
    expect(superseded).toBe(id(3))
    expect(batched).toBe(false)
  })

  it("superseding another agent's record surfaces the chain's refusal — never a silent save", async () => {
    const result = await call(
      { supersede: async () => { throw new MidaError("CAPABILITY_DENIED", "no completed grant allows superseding this lineage") } },
      { supersedes: id(3) },
    )
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
  })

  it("the SUPERSEDE_OWN gate asks the chain for supersede authority, not create", async () => {
    const asked: number[] = []
    await call(
      {
        hasAuthority: async (_id, _ns, permission) => {
          asked.push(permission)
          return true
        },
      },
      { supersedes: id(3) },
    )
    // SUPERSEDE_OWN (4) or SUPERSEDE_ANY (8) — CREATE (2) must not appear for a supersede
    expect(asked.length).toBeGreaterThan(0)
    expect(asked).not.toContain(2)
    expect(asked.some((bit) => bit === 4 || bit === 8)).toBe(true)
  })

  it("grant gates: no authority is not-approved, a read-only grant says so, revoked markers win", async () => {
    expect(await call({ hasAuthority: async () => false })).toMatchObject({ kind: "refused", reason: "not-approved" })
    const readOnly = await call({
      hasAuthority: async (_id, _ns, permission) => permission === 1, // READ only
    })
    expect(readOnly).toMatchObject({ kind: "refused", reason: "read-only" })
    const revoked = await call({ hasAuthority: async () => false, isRevoked: () => true })
    expect(revoked).toMatchObject({ kind: "refused", reason: "revoked" })
    const pending = await call({ hasAuthority: async () => true, revokePending: () => ({ at: "t" } as never) })
    expect(pending).toMatchObject({ kind: "refused", reason: "revoke-pending" })
  })

  it("missing and unreadable identities are different refusals, before any write", async () => {
    let written = false
    const deps: Partial<RememberDeps> = {
      create: async () => {
        written = true
        return { contextId: id(11) } as never
      },
    }
    const missing = await call({ ...deps, loadIdentity: () => undefined })
    expect(missing).toMatchObject({ kind: "refused", reason: "no-identity" })
    const dir = home()
    mkdirSync(join(dir.root, "agents", "codex"), { recursive: true })
    writeFileSync(join(dir.root, "agents", "codex", "identity.json"), "{corrupt")
    const broken = await call({ ...deps, loadIdentity: () => { throw new Error("corrupt") } }, {}, dir)
    expect(broken).toMatchObject({ kind: "refused", reason: "identity-unreadable" })
    expect(written).toBe(false)
  })

  it("projects.current requires the folder's approval; a fact namespace does not", async () => {
    let asked = false
    const project = await call({
      checkProject: async () => {
        asked = true
        return { ok: false, reason: "not-approved" }
      },
    })
    expect(project).toMatchObject({ kind: "refused", reason: "not-approved" })
    expect(asked).toBe(true)

    asked = false
    const fact = await call(
      {
        checkProject: async () => {
          asked = true
          return { ok: false, reason: "not-a-project" }
        },
      },
      { namespace: FACT, cwd: "/nowhere" },
    )
    expect(fact.kind).toBe("saved")
    expect(asked).toBe(false)
  })

  it("the direct lane admits one write a minute per agent — the second refuses with the lane named", async () => {
    const admittedSaves = new Map<string, number[]>()
    const body = { agent: "codex", cwd: "/work", namespace: NS, content: "one" }
    const first = await buildRemember(runtime(), body, okDeps({ admittedSaves }))
    expect(first.kind).toBe("saved")
    // a second SDK client sends the same agent name — the service-side map catches it
    const second = await buildRemember(runtime(), { ...body, content: "two" }, okDeps({ admittedSaves }))
    expect(second).toMatchObject({ kind: "refused", reason: "rate-limited", lane: "direct" })
  })

  it("the batching lane admits sixty a minute per agent; the sixty-first names the batched lane", async () => {
    const admittedSaves = new Map<string, number[]>()
    const batched = { kind: "batched", storeUrl: "http://store", batchAnchor: "0x00000000000000000000000000000000000000bb" } as const
    const body = { agent: "codex", namespace: FACT, content: "x" }
    const rt = runtime()
    for (let i = 0; i < 60; i += 1) {
      const result = await buildRemember(rt, body, okDeps({ lane: async () => batched, admittedSaves }))
      expect(result.kind).toBe("saved")
    }
    const refused = await buildRemember(runtime(), body, okDeps({ lane: async () => batched, admittedSaves }))
    expect(refused).toMatchObject({ kind: "refused", reason: "rate-limited", lane: "batched" })
  })

  it("a write that fails frees its rate slot — the next call gets a real answer", async () => {
    const admittedSaves = new Map<string, number[]>()
    const body = { agent: "codex", cwd: "/work", namespace: NS, content: "one" }
    const failed = await buildRemember(
      runtime(),
      body,
      okDeps({ admittedSaves, create: async () => { throw new MidaError("CHAIN_UNAVAILABLE", "down") } }),
    )
    expect(failed).toMatchObject({ kind: "refused", reason: "chain-busy" })
    const retried = await buildRemember(runtime(), body, okDeps({ admittedSaves }))
    expect(retried.kind).toBe("saved")
  })

  it("two reservations in the same millisecond are distinct — a release frees only its own (in-22 V-5)", async () => {
    const admittedSaves = new Map<string, number[]>()
    const batched = { kind: "batched", storeUrl: "http://store", batchAnchor: "0x00000000000000000000000000000000000000bb" } as const
    const body = { agent: "codex", namespace: FACT, content: "x" }
    const rt = runtime()
    // a frozen clock makes every reservation land on the same stamp
    const deps = (over: Partial<RememberDeps> = {}) =>
      okDeps({ lane: async () => batched, admittedSaves, now: () => 1_700_000_000_000, ...over })
    expect((await buildRemember(rt, body, deps())).kind).toBe("saved")
    expect((await buildRemember(rt, body, deps())).kind).toBe("saved")
    const key = "batched\ncodex"
    expect(admittedSaves.get(key)).toHaveLength(2)
    // the third write fails — its release must free its own reservation and no one else's
    const failed = await buildRemember(
      rt,
      body,
      deps({ createBatched: async () => { throw new MidaError("CHAIN_UNAVAILABLE", "down") } }),
    )
    expect(failed.kind).toBe("refused")
    expect(admittedSaves.get(key)).toHaveLength(2)
  })

  it("chain-side answers mid-save map to the same refusals the gates print", async () => {
    const revoked = await call({ create: async () => { throw new MidaError("CAPABILITY_REVOKED", "revoked") } })
    expect(revoked).toMatchObject({ kind: "refused", reason: "revoked" })
    const denied = await call({ create: async () => { throw new MidaError("CAPABILITY_DENIED", "no grant") }, isRevoked: () => true })
    expect(denied).toMatchObject({ kind: "refused", reason: "revoked" })
    const held = await call({ create: async () => { throw new MidaError("WRITE_DENIED", "staged deny") } })
    expect(held).toMatchObject({ kind: "refused", reason: "revoke-pending" })
    const gone = await call({ supersede: async () => { throw new MidaError("NOT_FOUND", "no parent") } }, { supersedes: id(3) })
    expect(gone).toMatchObject({ kind: "refused", reason: "not-found" })
  })

  it("content too large for a record refuses before signing", async () => {
    let written = false
    const result = await call(
      {
        create: async () => {
          written = true
          return { contextId: id(11) } as never
        },
      },
      { content: "x".repeat(70_000) },
    )
    expect(result).toMatchObject({ kind: "refused", reason: "too-large" })
    expect(written).toBe(false)
  })

  // in-23 W-1 (review R-1): the SDK sends its session id on /remember so the route can refresh
  // that session's existing state files — the same keep-alive a read performs. The id is
  // transport metadata: it never lands in the record, and a write never creates a state file.
  it("a sessionId refreshes the session's existing state files — creates none, and never enters the record", async () => {
    const dir = home()
    const sid = "sdk-codex-a1b2c3d4"
    const stateFiles = [`state/tasks/${sid}.json`, `state/lastseen/${sid}.json`, `state/continues/${sid}.json`]
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    for (const rel of stateFiles) {
      dir.writeSecretJson(rel, { stale: true })
      utimesSync(dir.path(rel), old, old)
    }
    let sealed: unknown
    const result = await call(
      {
        create: async (_r, _a, _n, input) => {
          sealed = input
          return { contextId: id(11) } as never
        },
      },
      { sessionId: sid },
      dir,
    )
    expect(result.kind).toBe("saved")
    for (const rel of stateFiles) {
      expect(Date.now() - statSync(dir.path(rel)).mtimeMs).toBeLessThan(60_000)
    }
    expect(sealed).toBeDefined()
    expect(Object.keys(sealed as Record<string, unknown>)).not.toContain("sessionId")
    expect(JSON.stringify(sealed)).not.toContain(sid)
    // a write never creates a state file the session does not already have
    const bare = await call({}, { sessionId: "sdk-codex-nothing" }, dir)
    expect(bare.kind).toBe("saved")
    for (const folder of ["tasks", "lastseen", "continues"]) {
      expect(dir.has(`state/${folder}/sdk-codex-nothing.json`)).toBe(false)
    }
    // an id that is not a safe filename touches nothing and changes nothing about the write
    const odd = await call({}, { sessionId: "../escape" }, dir)
    expect(odd.kind).toBe("saved")
  })

  // in-24 (review N-1): the touch refreshes a live session's pin — under the old order it ran
  // on admission, so a write that never landed still marked a dead session alive. It now runs
  // only after a saved result, never on a refusal or a failed send.
  const staleSession = (dir: MidaHome, sid = "sdk-codex-a1b2c3d4") => {
    const files = [`state/tasks/${sid}.json`, `state/lastseen/${sid}.json`, `state/continues/${sid}.json`]
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    for (const rel of files) {
      dir.writeSecretJson(rel, { stale: true })
      utimesSync(dir.path(rel), old, old)
    }
    const stillStale = () =>
      files.every((rel) => Date.now() - statSync(dir.path(rel)).mtimeMs > 30 * 24 * 60 * 60 * 1000)
    return { files, stillStale }
  }

  it("a write refused at send time touches nothing", async () => {
    const dir = home()
    const { stillStale } = staleSession(dir)
    const result = await call(
      {
        create: async () => {
          throw new MidaError("CAPABILITY_DENIED" as never, "the grant is gone")
        },
      },
      { sessionId: "sdk-codex-a1b2c3d4" },
      dir,
    )
    expect(result).toMatchObject({ kind: "refused", reason: "not-approved" })
    expect(stillStale()).toBe(true)
  })

  it("a send that throws touches nothing either", async () => {
    const dir = home()
    const { stillStale } = staleSession(dir)
    await expect(
      call(
        {
          create: async () => {
            throw new Error("the transport died")
          },
        },
        { sessionId: "sdk-codex-a1b2c3d4" },
        dir,
      ),
    ).rejects.toThrow("the transport died")
    expect(stillStale()).toBe(true)
  })

  it("the namespace the chain is asked about is the canonicalized one the caller named", async () => {
    const asked: string[] = []
    await call(
      {
        hasAuthority: async (_id, ns, _p) => {
          asked.push(ns)
          return true
        },
      },
      { namespace: "  Profile.Skills ", cwd: "/any" },
    )
    expect(asked).toContain(namespaceId(FACT))
  })
})
