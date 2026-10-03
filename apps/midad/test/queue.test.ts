import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, enqueue, listJobs, projectIdFor, removeJob } from "@mida/midad"

const T0 = new Date("2026-09-21T10:00:00.000Z")
const T1 = new Date("2026-09-21T10:00:01.000Z")

function tempHome(): MidaHome {
  return new MidaHome(mkdtempSync(join(tmpdir(), "mida-queue-")))
}

const job = (over: Record<string, unknown> = {}) => ({
  agent: "claude-code",
  event: "Stop" as const,
  sessionId: "s1",
  transcriptPath: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  error: null,
  ...over,
})

describe("capture queue", () => {
  it("enqueue writes one job that listJobs returns with its fields", () => {
    const home = tempHome()
    const saved = enqueue(home, job(), () => T0)
    const jobs = listJobs(home)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: saved.id,
      agent: "claude-code",
      event: "Stop",
      sessionId: "s1",
      transcriptPath: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      error: null,
      at: T0.toISOString(),
    })
  })

  it("lists two jobs oldest first", () => {
    const home = tempHome()
    const first = enqueue(home, job({ sessionId: "older" }), () => T0)
    const second = enqueue(home, job({ sessionId: "newer" }), () => T1)
    expect(listJobs(home).map((j) => j.id)).toEqual([first.id, second.id])
  })

  it("a new job id holds no ':' (Windows forbids it) but still leads with the instant", () => {
    const home = tempHome()
    const saved = enqueue(home, job(), () => T0)
    expect(saved.id).not.toContain(":")
    expect(saved.id.startsWith("2026-09-21T10-00-00.000Z-")).toBe(true)
    const second = enqueue(home, job({ sessionId: "newer" }), () => T1)
    expect(listJobs(home).map((j) => j.id)).toEqual([saved.id, second.id])
  })

  it("a job file named the old way, with ':' in it, still drains and is addressed by its name", () => {
    const home = tempHome()
    // the shape a 0.1.3 hook wrote; an upgrade can leave these in the folder
    const oldId = "2026-09-21T09:59:00.000Z-deadbeef"
    home.writeSecretJson(`queue/${oldId}.json`, { ...job(), at: "2026-09-21T09:59:00.000Z" })
    const saved = enqueue(home, job({ sessionId: "s2" }), () => T0)
    const jobs = listJobs(home)
    expect(jobs.map((j) => j.id)).toEqual([oldId, saved.id])
    removeJob(home, oldId)
    expect(listJobs(home).map((j) => j.id)).toEqual([saved.id])
  })

  it("moves a corrupt job file to queue/bad and still lists the rest", () => {
    const home = tempHome()
    const saved = enqueue(home, job(), () => T0)
    writeFileSync(home.path("queue/zz-corrupt.json"), "{not json")
    expect(listJobs(home).map((j) => j.id)).toEqual([saved.id])
    expect(home.has("queue/bad/zz-corrupt.json")).toBe(true)
    expect(home.has("queue/zz-corrupt.json")).toBe(false)
  })

  it("job files are readable by the owner only", () => {
    const home = tempHome()
    const saved = enqueue(home, job(), () => T0)
    expect(statSync(home.path(`queue/${saved.id}.json`)).mode & 0o777).toBe(0o600)
  })

  it("removeJob deletes the file and tolerates an id that is already gone", () => {
    const home = tempHome()
    const saved = enqueue(home, job(), () => T0)
    removeJob(home, saved.id)
    expect(listJobs(home)).toHaveLength(0)
    removeJob(home, saved.id)
  })

  it("enqueue refuses an agent or session id that is not a safe name", () => {
    const home = tempHome()
    expect(() => enqueue(home, job({ sessionId: "../../agents/x/identity" }), () => T0)).toThrow()
    expect(() => enqueue(home, job({ sessionId: ".." }), () => T0)).toThrow()
    expect(() => enqueue(home, job({ sessionId: "" }), () => T0)).toThrow()
    expect(() => enqueue(home, job({ agent: "../x" }), () => T0)).toThrow()
    expect(listJobs(home)).toHaveLength(0)
  })

  it("listJobs moves a hand-crafted job file with an unsafe session id aside", () => {
    const home = tempHome()
    home.writeSecretJson("queue/zz-evil.json", { ...job({ sessionId: "../../agents/x/identity" }), at: T0.toISOString() })
    expect(listJobs(home)).toHaveLength(0)
    expect(home.has("queue/bad/zz-evil.json")).toBe(true)
  })
})

describe("projectIdFor", () => {
  it("finds .mida/project.json two folders up and returns null when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "mida-proj-"))
    mkdirSync(join(root, ".mida"))
    writeFileSync(join(root, ".mida", "project.json"), JSON.stringify({ projectId: "p-1" }))
    const deep = join(root, "a", "b")
    mkdirSync(deep, { recursive: true })
    expect(projectIdFor(deep)).toBe("p-1")
    expect(projectIdFor(join(root, "a"))).toBe("p-1")
    const other = mkdtempSync(join(tmpdir(), "mida-noproj-"))
    expect(projectIdFor(other)).toBeNull()
  })
})
