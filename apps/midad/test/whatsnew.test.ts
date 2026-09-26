import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpRequestError } from "viem"
import { ChainBusyError } from "@mida/chain"
import type { StoredCheckpoint } from "../src/skeleton.js"
import type { ServiceRuntime } from "@mida/midad"
import {
  CheckpointCopies,
  MidaHome,
  buildWhatsNew,
  readSeen,
  writeSeen,
} from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-whatsnew-")))

const NOW = Date.parse("2026-09-21T12:00:00.000Z")
/** An ISO timestamp `minutes` before NOW. */
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

/** A stored checkpoint as readCheckpoints returns it; `contextId` defaults to a unique-per-call id. */
const cp = (
  sessionId: string,
  authorId: string,
  createdAt: string,
  over: Record<string, unknown> = {},
  contextId = `0x${sessionId}ctx-${createdAt}`,
): StoredCheckpoint => ({
  checkpoint: sampleCheckpoint({ createdAt, ...over }),
  projectId: "p1",
  sessionId,
  continuesSession: null,
  compiledBy: "claude-haiku",
  contextId,
  authorId,
  namespaceId: "0xns",
})

/**
 * The runtime whats-new needs: a home plus the fields checkAccess touches — and, since the
 * identity gate runs first, a well-formed identity for the agent under test.
 */
const runtimeWith = (dir: MidaHome) => {
  dir.writeSecretJson("agents/claude-code/identity.json", {
    name: "claude-code",
    agentId: `0x${"1".repeat(64)}`,
    signerPrivateKey: `0x${"2".repeat(64)}`,
    encryptionPrivateKey: `0x${"3".repeat(64)}`,
    encryptionPublicKey: `0x${"4".repeat(64)}`,
    callbackOrigin: "https://agent.test",
    purposeId: "test",
    manifest: {},
    manifestHash: `0x${"5".repeat(64)}`,
  })
  return { home: dir } as unknown as ServiceRuntime
}

const NAMES = { "0xauthorcodex": "codex", "0xauthorclaude": "claude-code" }

/**
 * The deps every whats-new call needs: the gates say live, and the daemon's copy already holds
 * `checkpoints` — the `read` spy is only reached by a background refresh, which a fresh copy
 * never triggers. Tests about refresh behaviour build their own copies/deps.
 */
const baseDeps = (checkpoints: StoredCheckpoint[], over: Record<string, unknown> = {}) => {
  const copies = new CheckpointCopies(() => NOW)
  copies.seed("claude-code", "p1", checkpoints)
  return {
    checkProject: async () => ({
      ok: true as const,
      approval: { agent: "claude-code", projectId: "p1", root: "/repo", approvedAt: "2026-09-21T00:00:00.000Z" },
    }),
    capability: async () => "live" as const,
    read: async () => ({ checkpoints, skipped: 0, milliseconds: 1, partial: false }),
    authorNames: NAMES,
    now: () => NOW,
    copies,
    ...over,
  }
}

describe("buildWhatsNew", () => {
  it("a foreign checkpoint the session never saw becomes a one-line update", async () => {
    const dir = home()
    writeSeen(dir, "s-1", ["0xprior-delivery"])
    const foreign = cp("other-session", "0xauthorCodex", iso(5), {
      progress: ["fixed the retry loop", "added the tests"],
      nextAction: "run the suite",
      artifacts: ["src/retry.ts", "test/retry.test.ts"],
    })
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, baseDeps([foreign]))
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    // the header says what the note IS: reports from other sessions at their save time — never
    // a claim about the world now (in-8 H3)
    expect(out.note).toContain("Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):")
    expect(out.note).toContain("codex")
    expect(out.note).toContain("5 min ago")
    expect(out.note).toContain("fixed the retry loop")
    expect(out.note).toContain("added the tests")
    expect(out.note).toContain("run the suite")
    expect(out.note).toContain("src/retry.ts")
    expect(out.note).toContain("test/retry.test.ts")
    expect(out.updates).toEqual([{ agent: "codex", savedAt: iso(5) }])
    // the proposed set keeps what was already delivered and adds this checkpoint's id
    expect(out.seen).toEqual(["0xprior-delivery", foreign.contextId])
  })

  it("a pending-anchor checkpoint carries the marker in its line and is never described as saved", async () => {
    const dir = home()
    const pending: StoredCheckpoint = {
      ...cp("other-session", "0xauthorCodex", iso(5), { progress: ["queued before the anchor"] }),
      anchor: "PENDING_ANCHOR",
    }
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, baseDeps([pending]))
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("queued before the anchor")
    expect(out.note).toContain("PENDING_ANCHOR: not yet anchored on Monad; may still be rejected")
    expect(out.note).not.toContain("saved")
  })

  it("a pending checkpoint with nothing else to show still carries the marker — never 'saved a checkpoint'", async () => {
    const dir = home()
    const pending: StoredCheckpoint = {
      ...cp("other-session", "0xauthorCodex", iso(5), { nextAction: "" }),
      anchor: "PENDING_ANCHOR",
    }
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, baseDeps([pending]))
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("PENDING_ANCHOR: not yet anchored on Monad; may still be rejected")
    expect(out.note).not.toContain("saved")
  })

  it("an anchored checkpoint renders exactly as before — no marker", async () => {
    const dir = home()
    const anchored: StoredCheckpoint = {
      ...cp("other-session", "0xauthorCodex", iso(5), { progress: ["real update"] }),
      anchor: "ANCHORED",
    }
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, baseDeps([anchored]))
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("real update")
    expect(out.note).not.toContain("PENDING_ANCHOR")
  })

  it("a save that lies about its clock does not head the note — Monad's placement picks the update", async () => {
    const dir = home()
    // Same author, both unseen: the future-dated claim has the EARLIER chain placement, so the
    // note must name the save Monad recorded last — never the one claiming 2099.
    const forged: StoredCheckpoint = {
      ...cp("other-session", "0xauthorCodex", "2099-01-01T00:00:00.000Z", { progress: ["forged clock"] }),
      chain: { at: BigInt(Math.floor(NOW / 1000) - 600), block: 10n, index: 0 },
    }
    const latest: StoredCheckpoint = {
      ...cp("other-session", "0xauthorCodex", iso(2), { progress: ["the real latest work"] }),
      // the chain's stamp deliberately differs from the claim — savedAt must be the chain's
      chain: { at: BigInt(Math.floor(NOW / 1000) - 300), block: 11n, index: 0 },
    }
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, baseDeps([forged, latest]))
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("the real latest work")
    expect(out.note).not.toContain("forged clock")
    expect(out.updates).toEqual([
      { agent: "codex", savedAt: new Date((Math.floor(NOW / 1000) - 300) * 1000).toISOString() },
    ])
  })

  it("a foreign checkpoint already in the seen set answers none", async () => {
    const dir = home()
    const old = cp("other", "0xauthorCodex", iso(20))
    writeSeen(dir, "s-1", [old.contextId])
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([old]),
    )
    expect(out.kind).toBe("none")
  })

  it("the session's own checkpoints never appear and never enter the seen set", async () => {
    const dir = home()
    const own = cp("s-1", "0xauthorCodex", iso(2))
    const foreign = cp("other", "0xauthorCodex", iso(3), { progress: ["real update"] })
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([own, foreign]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).not.toContain("2 min ago")
    expect(out.seen).toEqual([foreign.contextId])
    // and when the own save is the only arrival, there is nothing to say
    const only = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([own]),
    )
    expect(only.kind).toBe("none")
  })

  it("two foreign agents get one line each, newest first", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([
        cp("old-session", "0xauthorClaude", iso(20), { progress: ["older work"], nextAction: "n1" }),
        cp("new-session", "0xauthorCodex", iso(5), { progress: ["newer work"], nextAction: "n2" }),
      ]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    const lines = out.note.split("\n").filter((l) => l.startsWith("- "))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("codex")
    expect(lines[1]).toContain("claude-code")
  })

  it("the artifact baseline is the newest SEEN checkpoint of that author", async () => {
    const dir = home()
    const seenOld = cp("other", "0xauthorCodex", iso(40), { artifacts: ["a.ts"] })
    const unseenOld = cp("other", "0xauthorCodex", iso(30), { artifacts: ["a.ts", "x.ts"] })
    const newest = cp("other", "0xauthorCodex", iso(5), { artifacts: ["a.ts", "x.ts", "b.ts"] })
    writeSeen(dir, "s-1", [seenOld.contextId])
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([seenOld, unseenOld, newest]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    // the diff is measured against the newest seen checkpoint, not the newest before some time
    expect(out.note).toContain("b.ts")
    expect(out.note).toContain("x.ts")
    expect(out.note).not.toContain("a.ts")
  })

  it("a missing seen file treats every checkpoint as new", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(5_000), { progress: ["old but unseen"] })]),
    )
    expect(out.kind).toBe("updates")
  })

  it("a corrupt seen file degrades to no baseline, never a crash", async () => {
    const dir = home()
    writeSeen(dir, "s-1", ["0xanything"])
    writeFileSync(dir.path("state/lastseen/s-1.json"), "{ not json")
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(5))]),
    )
    expect(out.kind).toBe("updates")
  })

  it("an old { lastSeen } watermark file is treated as missing — everything new once", async () => {
    const dir = home()
    dir.writeSecretJson("state/lastseen/s-1.json", { lastSeen: iso(10) })
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(20), { progress: ["stamped before the old watermark"] })]),
    )
    expect(out.kind).toBe("updates")
  })

  it("a checkpoint stamped before the session's own newest still reports — the late-landing case", async () => {
    const dir = home()
    // the exact loss the watermark caused: codex compiled at 12:00:00 but its save landed at
    // 12:00:20, after this session's own 12:00:10 checkpoint was already seen — under a time
    // watermark codex's checkpoint was "older than the watermark" forever
    const own = cp("s-1", "0xauthorClaude", "2026-09-21T12:00:10.000Z")
    const codexLate = cp("codex-session", "0xauthorCodex", "2026-09-21T12:00:00.000Z", {
      progress: ["codex landed late"],
    })
    writeSeen(dir, "s-1", ["0xprior-delivery"])
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([own, codexLate]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("codex")
    expect(out.note).toContain("codex landed late")
    expect(out.seen).toEqual(["0xprior-delivery", codexLate.contextId])
    // the session's own checkpoint was covered by the answer but its id never enters the set
    expect(out.seen).not.toContain(own.contextId)
  })

  it("a foreign checkpoint stamped five minutes behind a seen one is still new — clock skew changes nothing", async () => {
    const dir = home()
    // the other machine's clock runs 5 minutes slow: its checkpoint lands stamped BEFORE a
    // foreign checkpoint this session already saw — a watermark hides it, the set does not
    const earlier = cp("other", "0xauthorCodex", iso(10))
    const skewed = cp("other", "0xauthorCodex", iso(15), { progress: ["written on a slow clock"] })
    writeSeen(dir, "s-1", [earlier.contextId])
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([earlier, skewed]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("written on a slow clock")
    expect(out.seen).toEqual([earlier.contextId, skewed.contextId])
  })

  it("a delivered checkpoint is never reported twice", async () => {
    const dir = home()
    const foreign = cp("other", "0xauthorCodex", iso(5), { progress: ["say it once"] })
    const deps = baseDeps([foreign])
    const input = { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }
    const first = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(first.kind).toBe("updates")
    if (first.kind !== "updates") return
    // the hook writes the proposed set after the note was printed — the next prompt has nothing
    writeSeen(dir, "s-1", first.seen)
    const second = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(second.kind).toBe("none")
  })

  it("the proposed set keeps the newest 300 ids — a 301st drops the oldest", async () => {
    const dir = home()
    const ids = Array.from({ length: 300 }, (_, i) => `0xid-${i}`)
    writeSeen(dir, "s-1", ids)
    const foreign = cp("other", "0xauthorCodex", iso(5))
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([foreign]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.seen).toHaveLength(300)
    expect(out.seen).not.toContain("0xid-0")
    expect(out.seen).toContain("0xid-299")
    expect(out.seen).toContain(foreign.contextId)
  })

  it("a revoked agent is refused, not silently emptied", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([], { capability: async () => "revoked" as const }),
    )
    expect(out).toEqual({ kind: "refused", reason: "revoked" })
  })

  it("an unapproved project is refused with the same reason the handoff reports", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([], {
        checkProject: async () => ({ ok: false as const, reason: "not-approved" }),
        isRevoked: () => false,
      }),
    )
    expect(out).toEqual({ kind: "refused", reason: "not-approved" })
  })

  it("the note never exceeds 600 characters, however big the checkpoints are", async () => {
    const dir = home()
    const checkpoints = ["0xauthorCodex", "0xauthorClaude", "0xauthorthird"].map((author, i) =>
      cp(`s-${i}`, author, iso(5 + i), {
        progress: ["x".repeat(400)],
        nextAction: "y".repeat(400),
        artifacts: [`${"f".repeat(200)}.ts`],
      }),
    )
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps(checkpoints),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note.length).toBeLessThanOrEqual(600)
    expect(out.note).toContain("Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):")
  })

  it("the note opens with the honesty header — and the 600 limit counts it (in-8 H3)", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(5), { progress: ["recent work"] })]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note.startsWith("Mida update since you last checked (what other sessions reported at the time — check the current state before acting on it):")).toBe(true)
    expect(out.note.length).toBeLessThanOrEqual(600)
  })

  it("a failed refresh answers none on an absent copy and logs the failure — it never refuses", async () => {
    const dir = home()
    const logs: object[] = []
    const copies = new CheckpointCopies(() => NOW)
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([], {
        copies,
        read: async () => { throw new Error("boom") },
        log: (entry: object) => logs.push(entry),
      }),
    )
    expect(out.kind).toBe("none")
    await copies.idle()
    expect(logs.filter((e) => (e as { event?: string }).event === "whatsnew-refresh-failed")).toHaveLength(1)
  })

  it("an unsafe session id reads no state file and still answers", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "../escape" },
      baseDeps([cp("other", "0xauthorCodex", iso(5))]),
    )
    expect(out.kind).toBe("updates")
    expect(dir.list("state/lastseen")).toEqual([])
  })
})

describe("the daemon's checkpoint copy", () => {
  /** Gates that always approve — the copy and refresh behaviour is what varies. */
  const gateDeps = (over: Record<string, unknown> = {}) => ({
    checkProject: async () => ({
      ok: true as const,
      approval: { agent: "claude-code", projectId: "p1", root: "/repo", approvedAt: "2026-09-21T00:00:00.000Z" },
    }),
    authorNames: NAMES,
    ...over,
  })

  it("a read that takes 5 s never blocks the prompt — the stale copy answers at once", async () => {
    const dir = home()
    let t = NOW
    const copies = new CheckpointCopies(() => t)
    copies.seed("claude-code", "p1", [cp("other", "0xauthorCodex", iso(10), { progress: ["stale but present"] })])
    t += 21_000 // the copy is stale — the request starts a refresh it must not wait for
    let resolveRead: ((value: { checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number; partial: boolean }) => void) | undefined
    const read = () =>
      new Promise<{ checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number; partial: boolean }>((resolve) => {
        resolveRead = resolve
      })
    const started = Date.now()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      gateDeps({ capability: async () => "live" as const, read, now: () => t, copies }),
    )
    expect(Date.now() - started).toBeLessThan(50)
    expect(out.kind).toBe("updates")
    if (out.kind === "updates") expect(out.note).toContain("stale but present")
    resolveRead?.({ checkpoints: [], skipped: 0, milliseconds: 5_000, partial: false })
    await copies.idle()
  })

  it("two prompts during one slow refresh share a single read — the second never starts another", async () => {
    const dir = home()
    let reads = 0
    let resolveRead: ((value: { checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number; partial: boolean }) => void) | undefined
    const copies = new CheckpointCopies(() => NOW) // absent copy — the first request must start a refresh
    const read = () => {
      reads += 1
      return new Promise<{ checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number; partial: boolean }>((resolve) => {
        resolveRead = resolve
      })
    }
    const deps = gateDeps({ capability: async () => "live" as const, read, now: () => NOW, copies })
    const input = { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }
    const [a, b] = await Promise.all([
      buildWhatsNew(runtimeWith(dir), input, deps),
      buildWhatsNew(runtimeWith(dir), input, deps),
    ])
    expect(reads).toBe(1)
    // no copy existed yet — both answered none at once, and the refresh serves the NEXT prompt
    expect(a.kind).toBe("none")
    expect(b.kind).toBe("none")
    resolveRead?.({ checkpoints: [cp("other", "0xauthorCodex", iso(5))], skipped: 0, milliseconds: 1, partial: false })
    await copies.idle()
    const next = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(next.kind).toBe("updates")
  })

  it("a failed refresh keeps the old copy, still serves it, and logs once a minute at most", async () => {
    const dir = home()
    let t = NOW
    const copies = new CheckpointCopies(() => t)
    copies.seed("claude-code", "p1", [cp("other", "0xauthorCodex", iso(10), { progress: ["kept across failures"] })])
    t += 21_000
    const logs: object[] = []
    const deps = gateDeps({
      capability: async () => "live" as const,
      read: async () => { throw new Error("network down") },
      now: () => t,
      copies,
      log: (entry: object) => logs.push(entry),
    })
    const input = { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }
    const first = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(first.kind).toBe("updates")
    if (first.kind === "updates") expect(first.note).toContain("kept across failures")
    await copies.idle()
    const failures = () => logs.filter((e) => (e as { event?: string }).event === "whatsnew-refresh-failed")
    expect(failures()).toHaveLength(1)
    // the next stale prompt refreshes again and fails again — inside the minute, still one line
    const second = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(second.kind).toBe("updates")
    await copies.idle()
    expect(failures()).toHaveLength(1)
  })

  it("a partial refresh never lands — the copy keeps its last complete list (M3-D)", async () => {
    const dir = home()
    let t = NOW
    const copies = new CheckpointCopies(() => t)
    const kept = cp("other", "0xauthorCodex", iso(10), { progress: ["the last complete list"] })
    copies.seed("claude-code", "p1", [kept])
    t += 21_000 // stale — the request starts a refresh behind its answer
    const logs: object[] = []
    const deps = gateDeps({
      capability: async () => "live" as const,
      // the store answers partial: a shorter, unverifiable list must not replace the known one
      read: async () => ({ checkpoints: [cp("other", "0xauthorCodex", iso(1), { progress: ["partial-new"] })], skipped: 0, milliseconds: 1, partial: true }),
      now: () => t,
      copies,
      log: (entry: object) => logs.push(entry),
    })
    const input = { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }
    const out = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(out.kind).toBe("updates")
    await copies.idle()
    // the refresh was refused as an answer source: the copy still holds only the complete list
    expect(copies.get("claude-code", "p1")?.checkpoints.map((c) => c.contextId)).toEqual([kept.contextId])
    expect(logs.some((e) => (e as { event?: string }).event === "whatsnew-refresh-failed")).toBe(true)
  })

  it("a local revoke refuses the very next prompt even with a warm copy — and the copy is gone", async () => {
    const dir = home()
    const copies = new CheckpointCopies(() => NOW)
    copies.seed("claude-code", "p1", [cp("other", "0xauthorCodex", iso(10))])
    // `mida revoke` ran in the owner's process: the marker file landed and the approval row is
    // gone — the project check answers not-approved and the marker says why
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      gateDeps({
        checkProject: async () => ({ ok: false as const, reason: "not-approved" as const }),
        isRevoked: () => true,
        copies,
      }),
    )
    expect(out).toEqual({ kind: "refused", reason: "revoked" })
    expect(copies.get("claude-code", "p1")).toBeUndefined()
  })

  it("a live capability verdict is reused for 30 s per (agent, projectId), then re-checked", async () => {
    const dir = home()
    let t = NOW
    const copies = new CheckpointCopies(() => t)
    copies.seed("claude-code", "p1", [])
    let calls = 0
    const deps = gateDeps({
      capability: async () => {
        calls += 1
        return "live" as const
      },
      copies,
      now: () => t,
    })
    const input = { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }
    await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(calls).toBe(1)
    await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(calls).toBe(1) // inside the reuse window — the chain was not asked again
    t += 31_000
    await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(calls).toBe(2) // past 30 s the verdict is stale — asked again
  })

  it("a rate-limited chain refuses chain-busy — never not-approved, never internal (in-6 R4)", async () => {
    const dir = home()
    const busy = () => new HttpRequestError({ url: "http://rpc.test", cause: new ChainBusyError() })
    const deps = baseDeps([], {
      capability: async () => {
        throw busy()
      },
    })
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, deps)
    expect(out).toEqual({ kind: "refused", reason: "chain-busy" })
  })
})

describe("seen state", () => {
  it("writeSeen then readSeen round-trips the set", () => {
    const dir = home()
    writeSeen(dir, "s-1", ["0xa", "0xb"])
    expect(readSeen(dir, "s-1")).toEqual(new Set(["0xa", "0xb"]))
  })

  it("a missing file reads as the empty set", () => {
    const dir = home()
    expect(readSeen(dir, "s-1")).toEqual(new Set())
  })

  it("an old { lastSeen } file reads as the empty set — a silent migration", () => {
    const dir = home()
    dir.writeSecretJson("state/lastseen/s-1.json", { lastSeen: iso(10) })
    expect(readSeen(dir, "s-1")).toEqual(new Set())
  })

  it("the file keeps the newest 300 ids — a 301st drops the oldest", () => {
    const dir = home()
    writeSeen(dir, "s-1", Array.from({ length: 301 }, (_, i) => `0xid-${i}`))
    const seen = readSeen(dir, "s-1")
    expect(seen.size).toBe(300)
    expect(seen.has("0xid-0")).toBe(false)
    expect(seen.has("0xid-300")).toBe(true)
  })

  it("an unsafe session id writes nothing and reads nothing", () => {
    const dir = home()
    writeSeen(dir, "../escape", ["0xa"])
    expect(dir.list("state/lastseen")).toEqual([])
    expect(readSeen(dir, "../escape")).toEqual(new Set())
    expect(readSeen(dir, undefined)).toEqual(new Set())
  })
})
