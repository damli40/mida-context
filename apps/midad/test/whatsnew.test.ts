import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StoredCheckpoint } from "@mida/checkpoint"
import type { ServiceRuntime } from "@mida/midad"
import {
  CheckpointCopies,
  MidaHome,
  buildWhatsNew,
  readLastSeen,
  writeLastSeen,
} from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-whatsnew-")))

const NOW = Date.parse("2026-09-21T12:00:00.000Z")
/** An ISO timestamp `minutes` before NOW. */
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

/** A stored checkpoint as readCheckpoints returns it. */
const cp = (sessionId: string, authorId: string, createdAt: string, over: Record<string, unknown> = {}): StoredCheckpoint => ({
  checkpoint: sampleCheckpoint({ createdAt, ...over }),
  projectId: "p1",
  sessionId,
  continuesSession: null,
  compiledBy: "claude-haiku",
  contextId: `0x${sessionId}ctx`,
  authorId,
  namespaceId: "0xns",
})

/** The runtime whats-new needs: a home plus the fields checkAccess touches. */
const runtimeWith = (dir: MidaHome) => ({ home: dir }) as unknown as ServiceRuntime

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
    read: async () => ({ checkpoints, skipped: 0, milliseconds: 1 }),
    authorNames: NAMES,
    now: () => NOW,
    copies,
    ...over,
  }
}

describe("buildWhatsNew", () => {
  it("a foreign checkpoint newer than lastSeen becomes a one-line update", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(30))
    const checkpoints = [
      cp("other-session", "0xauthorCodex", iso(5), {
        progress: ["fixed the retry loop", "added the tests"],
        nextAction: "run the suite",
        artifacts: ["src/retry.ts", "test/retry.test.ts"],
      }),
    ]
    const out = await buildWhatsNew(runtimeWith(dir), { agent: "claude-code", cwd: "/repo", sessionId: "s-1" }, baseDeps(checkpoints))
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("Mida update since you last checked:")
    expect(out.note).toContain("codex")
    expect(out.note).toContain("5 min ago")
    expect(out.note).toContain("fixed the retry loop")
    expect(out.note).toContain("added the tests")
    expect(out.note).toContain("run the suite")
    expect(out.note).toContain("src/retry.ts")
    expect(out.note).toContain("test/retry.test.ts")
    expect(out.updates).toEqual([{ agent: "codex", savedAt: iso(5) }])
    // the watermark advances to the newest checkpoint the read saw
    expect(out.lastSeen).toBe(iso(5))
  })

  it("nothing newer than lastSeen answers none and keeps the old watermark", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(10))
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(20))]),
    )
    expect(out.kind).toBe("none")
    if (out.kind === "none") expect(out.lastSeen).toBe(iso(10))
  })

  it("the session's own checkpoints never appear, even when they are the only new ones", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(30))
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("s-1", "0xauthorCodex", iso(2))]),
    )
    expect(out.kind).toBe("none")
  })

  it("two foreign agents get one line each, newest first", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(60))
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

  it("only the files an author added since lastSeen are listed as new", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(30))
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([
        cp("other", "0xauthorCodex", iso(40), { artifacts: ["a.ts"] }),
        cp("other", "0xauthorCodex", iso(5), { artifacts: ["a.ts", "b.ts"] }),
      ]),
    )
    expect(out.kind).toBe("updates")
    if (out.kind !== "updates") return
    expect(out.note).toContain("b.ts")
    expect(out.note).not.toContain("a.ts")
  })

  it("a missing lastSeen file treats every checkpoint as new", async () => {
    const dir = home()
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(5_000), { progress: ["old but unseen"] })]),
    )
    expect(out.kind).toBe("updates")
  })

  it("a corrupt lastSeen file degrades to no baseline, never a crash", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(10))
    writeFileSync(dir.path("state/lastseen/s-1.json"), "{ not json")
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([cp("other", "0xauthorCodex", iso(5))]),
    )
    expect(out.kind).toBe("updates")
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
    writeLastSeen(dir, "s-1", iso(60))
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
    expect(out.note).toContain("Mida update since you last checked:")
  })

  it("a failed refresh answers none on an absent copy and logs the failure — it never refuses", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(10))
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
    writeLastSeen(dir, "s-1", iso(30))
    let t = NOW
    const copies = new CheckpointCopies(() => t)
    copies.seed("claude-code", "p1", [cp("other", "0xauthorCodex", iso(10), { progress: ["stale but present"] })])
    t += 21_000 // the copy is stale — the request starts a refresh it must not wait for
    let resolveRead: ((value: { checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number }) => void) | undefined
    const read = () =>
      new Promise<{ checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number }>((resolve) => {
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
    resolveRead?.({ checkpoints: [], skipped: 0, milliseconds: 5_000 })
    await copies.idle()
  })

  it("two prompts during one slow refresh share a single read — the second never starts another", async () => {
    const dir = home()
    let reads = 0
    let resolveRead: ((value: { checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number }) => void) | undefined
    const copies = new CheckpointCopies(() => NOW) // absent copy — the first request must start a refresh
    const read = () => {
      reads += 1
      return new Promise<{ checkpoints: StoredCheckpoint[]; skipped: number; milliseconds: number }>((resolve) => {
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
    resolveRead?.({ checkpoints: [cp("other", "0xauthorCodex", iso(5))], skipped: 0, milliseconds: 1 })
    await copies.idle()
    const next = await buildWhatsNew(runtimeWith(dir), input, deps)
    expect(next.kind).toBe("updates")
  })

  it("a failed refresh keeps the old copy, still serves it, and logs once a minute at most", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(30))
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

  it("a local revoke refuses the very next prompt even with a warm copy — and the copy is gone", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(30))
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
})

describe("lastSeen state", () => {
  it("writeLastSeen then readLastSeen round-trips the watermark", () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(10))
    expect(readLastSeen(dir, "s-1")).toBe(iso(10))
  })

  it("a missing file reads as the empty baseline", () => {
    const dir = home()
    expect(readLastSeen(dir, "s-1")).toBe("")
  })

  it("an unsafe session id writes nothing and reads nothing", () => {
    const dir = home()
    writeLastSeen(dir, "../escape", iso(10))
    expect(dir.list("state/lastseen")).toEqual([])
    expect(readLastSeen(dir, "../escape")).toBe("")
    expect(readLastSeen(dir, undefined)).toBe("")
  })
})
