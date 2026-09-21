import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StoredCheckpoint } from "@mida/checkpoint"
import type { ServiceRuntime } from "@mida/midad"
import {
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

const baseDeps = (checkpoints: StoredCheckpoint[], over: Record<string, unknown> = {}) => ({
  checkProject: async () => ({
    ok: true as const,
    approval: { agent: "claude-code", projectId: "p1", root: "/repo", approvedAt: "2026-09-21T00:00:00.000Z" },
  }),
  capability: async () => "live" as const,
  read: async () => ({ checkpoints, skipped: 0, milliseconds: 1 }),
  authorNames: NAMES,
  now: () => NOW,
  ...over,
})

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

  it("a read failure refuses internally rather than reporting stale state", async () => {
    const dir = home()
    writeLastSeen(dir, "s-1", iso(10))
    const out = await buildWhatsNew(
      runtimeWith(dir),
      { agent: "claude-code", cwd: "/repo", sessionId: "s-1" },
      baseDeps([], { read: async () => { throw new Error("boom") } }),
    )
    expect(out).toEqual({ kind: "refused", reason: "internal" })
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
