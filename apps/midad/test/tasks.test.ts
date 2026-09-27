import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeCheckpoints, renderHandoffReport, taskOf } from "@mida/checkpoint"
import type { Checkpoint, StoredCheckpoint } from "@mida/checkpoint"
import {
  CheckpointCopies,
  CheckpointPayloadError,
  MidaHome,
  TASK_RULE_TEXT,
  buildHandoff,
  buildMcpSave,
  buildWhatsNew,
  clearFolderTask,
  continuedTaskFor,
  drainOnce,
  enqueue,
  folderTaskFor,
  isTaskName,
  listJobs,
  pinSessionTask,
  readFolderTask,
  readSessionTask,
  resolveSessionTask,
  runCliWithRuntime,
  runDoctor,
  runHook,
  taskOrUndefined,
  unwrapCheckpoint,
  wrapCheckpoint,
  writeFolderTask,
} from "@mida/midad"
import type { CompileInput, compileCheckpoint } from "@mida/compiler"
import type { CheckpointEnvelope, DrainDeps, HandoffDeps, McpSaveDeps, ProjectCheck, Runtime, ServiceRuntime, saveCheckpoint } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

/**
 * tk-1 — named tasks. One Mida project, several efforts: a session's task is resolved once and
 * pinned, checkpoint bodies never cross task boundaries, and other active tasks surface as one
 * mention line each. These tests never reach a chain — every gate is injected.
 */

const OK: ProjectCheck = {
  ok: true,
  approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" },
}

const dir = () => mkdtempSync(join(tmpdir(), "mida-tasks-"))

/** A MidaHome carrying a well-formed `codex` identity so the access gates can read it. */
const homeWithCodex = (root: string): MidaHome => {
  const home = new MidaHome(root)
  home.writeSecretJson("agents/codex/identity.json", {
    name: "codex",
    agentId: `0x${"1".repeat(64)}`,
    signerPrivateKey: `0x${"2".repeat(64)}`,
    encryptionPrivateKey: `0x${"3".repeat(64)}`,
    encryptionPublicKey: `0x${"4".repeat(64)}`,
    callbackOrigin: "https://agent.test",
    purposeId: "test",
    manifest: {},
    manifestHash: `0x${"5".repeat(64)}`,
  })
  return home
}

/** A project folder: `.mida/project.json` holding `projectId` — same 0700 the marker write uses. */
const markFolder = (cwd: string, projectId = "p1") => {
  mkdirSync(join(cwd, ".mida"), { recursive: true, mode: 0o700 })
  writeFileSync(join(cwd, ".mida", "project.json"), JSON.stringify({ projectId }), { mode: 0o600 })
}

describe("task names and the folder default", () => {
  it("isTaskName accepts lowercase letters, digits and '-', and refuses the rest", () => {
    for (const good of ["a", "sdk", "grant-app", "0", "task-9", "x".repeat(40)]) {
      expect(isTaskName(good)).toBe(true)
    }
    for (const bad of ["", "SDK", "Grant_App", "-sdk", "sdk!", " sdk", "a b", "x".repeat(41), 42, null, undefined]) {
      expect(isTaskName(bad)).toBe(false)
    }
    // taskOrUndefined is the trusted-field sanitizer: invalid input becomes "absent", never a crash
    expect(taskOrUndefined("sdk")).toBe("sdk")
    expect(taskOrUndefined("NOT A TASK")).toBeUndefined()
  })

  it("a missing file reads as main, an invalid file reports invalid and falls back", () => {
    const cwd = dir()
    markFolder(cwd)
    expect(readFolderTask(cwd)).toEqual({ task: undefined, invalid: false })
    writeFileSync(join(cwd, ".mida", "task.json"), "not json{")
    expect(readFolderTask(cwd)).toEqual({ task: undefined, invalid: true })
    // a file that parses but is not a task record is invalid too
    writeFileSync(join(cwd, ".mida", "task.json"), JSON.stringify({ task: "BAD NAME" }))
    expect(readFolderTask(cwd)).toEqual({ task: undefined, invalid: true })
    // and the resolution falls back to main rather than guessing
    expect(resolveSessionTask(new MidaHome(join(dir(), "home")), { cwd }).task).toBe("main")
  })

  it("writes 0700/0600 like the marker, and `main`/clear remove the file", () => {
    const cwd = dir()
    markFolder(cwd)
    writeFolderTask(cwd, "sdk")
    const file = join(cwd, ".mida", "task.json")
    expect(readFolderTask(cwd)).toEqual({ task: "sdk", invalid: false })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(cwd, ".mida")).mode & 0o777).toBe(0o700)
    writeFolderTask(cwd, "main")
    expect(readFolderTask(cwd).task).toBeUndefined()
    writeFolderTask(cwd, "grant-app")
    clearFolderTask(cwd)
    expect(readFolderTask(cwd).task).toBeUndefined()
    // an invalid name is refused before any write
    expect(() => writeFolderTask(cwd, "BAD")).toThrow(TASK_RULE_TEXT.slice(0, 20))
    expect(readFolderTask(cwd).task).toBeUndefined()
  })

  it("folderTaskFor reports no marker separately from an unreadable file", () => {
    expect(folderTaskFor(dir())).toEqual({ markerDir: null, projectId: null, task: undefined, invalid: false })
  })
})

describe("the session pin and the resolution order", () => {
  it("first write wins — a later pin cannot move an already-pinned session", () => {
    const home = new MidaHome(join(dir(), "home"))
    expect(pinSessionTask(home, "s1", "p1", "sdk")).toBe("sdk")
    expect(pinSessionTask(home, "s1", "p1", "grant-app")).toBe("sdk")
    expect(readSessionTask(home, "s1", "p1")).toBe("sdk")
    // a pin is scoped to its project — the same session id in another project sees no pin
    expect(readSessionTask(home, "s1", "p2")).toBeUndefined()
  })

  it("resolveSessionTask: explicit > pin > predecessor > folder default > main", () => {
    const home = new MidaHome(join(dir(), "home"))
    const cwd = dir()
    markFolder(cwd)
    // nothing anywhere → main
    expect(resolveSessionTask(home, { sessionId: "s1", projectId: "p1", cwd })).toEqual({ task: "main", source: "default" })
    // folder default alone → folder
    writeFolderTask(cwd, "grant-app")
    expect(resolveSessionTask(home, { sessionId: "s1", projectId: "p1", cwd })).toEqual({ task: "grant-app", source: "folder" })
    // a continues record beats the folder
    home.writeSecretJson("state/continues/s1.json", { continues: "s0", projectId: "p1", task: "sdk" })
    expect(resolveSessionTask(home, { sessionId: "s1", projectId: "p1", cwd })).toEqual({ task: "sdk", source: "continues" })
    // a pin beats the continues record
    pinSessionTask(home, "s1", "p1", "port")
    expect(resolveSessionTask(home, { sessionId: "s1", projectId: "p1", cwd })).toEqual({ task: "port", source: "session" })
    // explicit beats everything
    expect(resolveSessionTask(home, { sessionId: "s1", projectId: "p1", cwd, explicit: "bench" })).toEqual({ task: "bench", source: "explicit" })
    // a continues record for a DIFFERENT project does not vote
    expect(continuedTaskFor(home, "s1", "p2")).toBeUndefined()
  })
})

describe("the checkpoint envelope's task field", () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    projectId: "p1",
    sessionId: "s1",
    continuesSession: null,
    compiledBy: "test",
    checkpoint: sampleCheckpoint(),
    ...over,
  })

  it("a named task serializes inside the envelope; `main` and absent are byte-identical", () => {
    const named = JSON.parse(JSON.stringify(wrapCheckpoint(envelope({ task: "sdk" })))) as Record<string, unknown>
    expect(named.task).toBe("sdk")
    const main = JSON.parse(JSON.stringify(wrapCheckpoint(envelope({ task: "main" })))) as Record<string, unknown>
    const plain = JSON.parse(JSON.stringify(wrapCheckpoint(envelope()))) as Record<string, unknown>
    expect("task" in main).toBe(false)
    expect("task" in plain).toBe(false)
    // invariant 2: the only difference a task makes is the one content field
    expect(Object.keys(named).sort()).toEqual([...Object.keys(plain).sort(), "task"].sort())
  })

  it("an invalid task name refuses the wrap, and an invalid stored task makes the record unreadable", () => {
    expect(() => wrapCheckpoint(envelope({ task: "BAD TASK" }))).toThrow(CheckpointPayloadError)
    const wrapped = JSON.parse(JSON.stringify(wrapCheckpoint(envelope({ task: "sdk" })))) as Record<string, unknown>
    wrapped.task = "NOT A TASK"
    expect(unwrapCheckpoint(wrapped)).toBeNull()
  })

  it("a record with no task field unwraps cleanly and reads as main", () => {
    const wrapped = JSON.parse(JSON.stringify(wrapCheckpoint(envelope()))) as Record<string, unknown>
    const back = unwrapCheckpoint(wrapped)
    expect(back).not.toBeNull()
    expect(back!.task).toBeUndefined()
    expect(taskOf(back!)).toBe("main")
  })
})

// ---------------------------------------------------------------------------
// Handoff fixtures and the injected gates
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-27T12:00:00.000Z")
const AUTHOR = `0x${"a".repeat(64)}`

const stored = (id: number, over: Partial<StoredCheckpoint> = {}, cp: Partial<Checkpoint> = {}): StoredCheckpoint => ({
  checkpoint: sampleCheckpoint(cp),
  projectId: "p1",
  sessionId: `s-${id}`,
  continuesSession: null,
  compiledBy: "test",
  contextId: `0x${String(id).padStart(64, "0")}`,
  authorId: AUTHOR,
  namespaceId: `0x${"2".repeat(64)}`,
  chain: { at: BigInt(Math.floor(T0 / 1000)) },
  ...over,
})

function handoffDeps(checkpoints: StoredCheckpoint[], over: Partial<HandoffDeps> = {}) {
  const d: HandoffDeps = {
    checkProject: async () => OK,
    capability: async () => "live",
    read: async () => ({ checkpoints, skipped: 0, milliseconds: 1, partial: false }),
    readFacts: async () => [],
    isRevoked: () => false,
    now: () => T0,
    ...over,
  }
  return d
}

const GA_MARKER = "GRANT-APP-ONLY-OBJECTIVE"
const SDK_MARKER = "SDK-ONLY-OBJECTIVE"
const MAIN_MARKER = "MAIN-ONLY-OBJECTIVE"

describe("handoff task isolation (tk-1)", () => {
  const fixtures = () => [
    stored(1, { sessionId: "s-sdk", task: "sdk" }, { objective: SDK_MARKER, nextAction: "sdk next" }),
    stored(2, { sessionId: "s-ga", task: "grant-app" }, { objective: GA_MARKER, nextAction: "grant next" }),
    stored(3, { sessionId: "s-main" }, { objective: MAIN_MARKER, nextAction: "main next" }),
  ]

  it("a named-task handoff holds only that task's thread and one mention line per other active task", async () => {
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    const result = await buildHandoff(
      runtime,
      { agent: "codex", cwd: "/tmp/work", authorNames: { [AUTHOR]: "codex" }, sessionId: "s-new", task: "grant-app" },
      handoffDeps(fixtures()),
    )
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain(GA_MARKER)
    // invariant 3: no foreign checkpoint text crosses the boundary — not the objective,
    // not the next action, nothing
    expect(result.text).not.toContain(SDK_MARKER)
    expect(result.text).not.toContain(MAIN_MARKER)
    expect(result.text).not.toContain("sdk next")
    expect(result.text).toContain("Other active tasks in this project (read one with `mida task show <name>`):")
    const mentions = result.text.split("\n").filter((line) => line.startsWith("- ") && line.includes(" — codex — "))
    expect(mentions).toHaveLength(2)
    expect(mentions.some((line) => line.startsWith("- sdk — codex — "))).toBe(true)
    expect(mentions.some((line) => line.startsWith("- main — codex — "))).toBe(true)
    // the foreign contextIds were shown as mentions, so they count as covered
    expect(result.seen).toContain(`0x${String(1).padStart(64, "0")}`)
    expect(result.seen).toContain(`0x${String(3).padStart(64, "0")}`)
  })

  it("the session pin decides, not the folder default that changed after session start (invariant 1)", async () => {
    const dirRoot = dir()
    const cwd = join(dirRoot, "work")
    markFolder(cwd)
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    const input = { agent: "codex", cwd, authorNames: { [AUTHOR]: "codex" }, sessionId: "s-live" }
    // session starts under grant-app: the handoff pins it
    writeFolderTask(cwd, "grant-app")
    const first = await buildHandoff(runtime, input, handoffDeps(fixtures()))
    expect(first.kind).toBe("handoff")
    expect(home.readJson<{ task: string }>("state/tasks/s-live.json")?.task).toBe("grant-app")
    // the folder default moves mid-session — the running session must not
    writeFolderTask(cwd, "sdk")
    const second = await buildHandoff(runtime, input, handoffDeps(fixtures()))
    expect(second.kind).toBe("handoff")
    if (second.kind !== "handoff") return
    expect(second.text).toContain(GA_MARKER)
    expect(second.text).not.toContain(SDK_MARKER)
  })

  it("a malformed explicit task is treated as absent — the folder default applies, no crash", async () => {
    const dirRoot = dir()
    const cwd = join(dirRoot, "work")
    markFolder(cwd)
    writeFolderTask(cwd, "sdk")
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    const result = await buildHandoff(
      runtime,
      { agent: "codex", cwd, authorNames: { [AUTHOR]: "codex" }, sessionId: "s-x", task: "NOT A TASK!" },
      handoffDeps(fixtures()),
    )
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain(SDK_MARKER)
    expect(result.text).not.toContain(GA_MARKER)
  })

  it("the served handoff's continuation record carries the task so a resume inherits it", async () => {
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    await buildHandoff(
      runtime,
      { agent: "codex", cwd: "/tmp/work", authorNames: {}, sessionId: "s-resume", task: "sdk" },
      handoffDeps(fixtures()),
    )
    expect(home.readJson("state/continues/s-resume.json")).toEqual({ continues: "s-sdk", projectId: "p1", task: "sdk" })
    // and a main-task serve writes the same record WITHOUT a task field — absent is main
    await buildHandoff(
      runtime,
      { agent: "codex", cwd: "/tmp/work", authorNames: {}, sessionId: "s-resume2" },
      handoffDeps(fixtures()),
    )
    expect(home.readJson("state/continues/s-resume2.json")).toEqual({ continues: "s-main", projectId: "p1" })
  })

  it("mentions cap at five and a task quiet for 14 days gets none", async () => {
    const fresh = stored(1, { sessionId: "s-ga", task: "grant-app" }, { objective: GA_MARKER })
    const many = Array.from({ length: 7 }, (_, i) =>
      stored(10 + i, { sessionId: `s-f${i}`, task: `task-${i}` }, { objective: `FOREIGN-${i}` }),
    )
    const stale = stored(20, { sessionId: "s-old", task: "old-thing", chain: { at: BigInt(Math.floor(T0 / 1000) - 15 * 24 * 3600) } }, { objective: "OLD" })
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    const result = await buildHandoff(
      runtime,
      { agent: "codex", cwd: "/tmp/work", authorNames: { [AUTHOR]: "codex" }, task: "grant-app" },
      handoffDeps([fresh, ...many, stale]),
    )
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    const mentionLines = result.text.split("\n").filter((line) => /^- task-\d — codex — /.test(line))
    expect(mentionLines).toHaveLength(5)
    expect(result.text).not.toContain("old-thing")
    expect(result.text).not.toContain("FOREIGN-0")
  })

  it("with no task ever named the render is byte-identical — no block, no mention", async () => {
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    const only = [stored(1, { sessionId: "s-main" }, { objective: MAIN_MARKER })]
    const result = await buildHandoff(runtime, { agent: "codex", cwd: "/tmp/work", authorNames: {} }, handoffDeps(only))
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).not.toContain("Other active tasks")
    expect(result.text).not.toContain("mida task show")
    // and at the render layer: an empty otherTasks option IS the absent option
    const merged = mergeCheckpoints(only)!
    const a = renderHandoffReport(merged, { now: () => T0 })
    const b = renderHandoffReport(merged, { now: () => T0, otherTasks: [] })
    expect(a.text).toBe(b.text)
  })
})

describe("whats-new task filtering (tk-1)", () => {
  it("detail lines belong to the session task; a foreign task gets exactly one count line", async () => {
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home } as unknown as Runtime
    const now = () => T0
    const copies = new CheckpointCopies(now)
    const sdk = stored(1, { sessionId: "s-sdk", task: "sdk" }, { objective: SDK_MARKER, progress: ["sdk progress marker"], nextAction: "sdk next" })
    const ga = stored(2, { sessionId: "s-ga", task: "grant-app" }, { objective: GA_MARKER, progress: ["grant progress"], nextAction: "grant next" })
    copies.seed("codex", "p1", [sdk, ga])
    const result = await buildWhatsNew(
      runtime,
      { agent: "codex", cwd: "/tmp/work", sessionId: "s-viewer", task: "grant-app" },
      {
        copies,
        now,
        checkProject: async () => OK,
        capability: async () => "live",
        authorNames: { [AUTHOR]: "codex" },
      },
    )
    expect(result.kind).toBe("updates")
    if (result.kind !== "updates") return
    // the grant-app save gets its detail line; sdk collapses to a count
    expect(result.note).toContain("grant progress")
    expect(result.note).not.toContain("sdk progress marker")
    expect(result.note).toContain("sdk: 1 new save by codex")
    // every foreign id lands in the proposed seen set — a shown mention is a delivered one
    expect(result.seen).toContain(sdk.contextId)
    expect(result.seen).toContain(ga.contextId)
    // and the pin for this session was written
    expect(readSessionTask(home, "s-viewer", "p1")).toBe("grant-app")
  })
})

describe("the hook stamps the once-resolved task on the job (tk-1)", () => {
  const hookSetup = (task?: string) => {
    const dirRoot = dir()
    const home = new MidaHome(join(dirRoot, "home"))
    const homeDir = join(dirRoot, "user-home")
    mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
    const transcriptPath = join(homeDir, ".claude", "projects", "proj", "t.jsonl")
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
    const cwd = join(dirRoot, "work")
    markFolder(cwd)
    if (task !== undefined) writeFolderTask(cwd, task)
    const stdin = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcriptPath, cwd })
    return { home, homeDir, cwd, transcriptPath, stdin }
  }

  it("MIDA_TASK wins at enqueue and the pin is written with it", async () => {
    const { home, homeDir, stdin } = hookSetup("grant-app")
    await runHook({ agent: "claude-code", stdin, home, homeDir, env: { MIDA_TASK: "sdk" }, parentBasename: () => undefined, spawnDrainer: () => {} })
    const jobs = listJobs(home)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.task).toBe("sdk")
    expect(readSessionTask(home, "s1", "p1")).toBe("sdk")
  })

  it("the folder default applies when MIDA_TASK is absent — and the pin keeps it immutable", async () => {
    const { home, homeDir, cwd, transcriptPath, stdin } = hookSetup("grant-app")
    await runHook({ agent: "claude-code", stdin, home, homeDir, env: {}, parentBasename: () => undefined, spawnDrainer: () => {} })
    expect(listJobs(home)[0]!.task).toBe("grant-app")
    // the folder default moves; a second event for the same session still stamps grant-app
    writeFolderTask(cwd, "sdk")
    const stdin2 = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", transcript_path: transcriptPath, cwd })
    await runHook({ agent: "claude-code", stdin: stdin2, home, homeDir, env: {}, parentBasename: () => undefined, spawnDrainer: () => {} })
    const jobs = listJobs(home)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]!.task).toBe("grant-app")
  })
})

describe("the drainer carries the job's task into the save (tk-1)", () => {
  const drainSetup = () => {
    const dirRoot = dir()
    const home = new MidaHome(join(dirRoot, "mida"))
    const homeDir = join(dirRoot, "user-home")
    mkdirSync(join(homeDir, ".claude", "projects", "proj"), { recursive: true })
    const transcriptPath = join(homeDir, ".claude", "projects", "proj", "t.jsonl")
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n")
    const cwd = join(dirRoot, "work")
    markFolder(cwd)
    const saveCalls: Parameters<typeof saveCheckpoint>[2][] = []
    const compile: typeof compileCheckpoint = async (input: CompileInput) => ({
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      retried: 0,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    })
    const save: typeof saveCheckpoint = async (_rt, _name, input) => {
      saveCalls.push(input)
      return { contextId: `0x${"ab".repeat(32)}`, transactionHash: null, milliseconds: 1, duplicate: false }
    }
    const open = async () => ({ close: async () => {} }) as unknown as Runtime
    const checkProject: NonNullable<DrainDeps["checkProject"]> = async (input) => ({
      ok: true,
      approval: { agent: input.agent, projectId: "p1", root: input.cwd, approvedAt: "2026-09-21T00:00:00.000Z" },
    })
    const drain = () =>
      drainOnce({ home, open, compile, save, homeDir, checkProject, isApproved: async () => true, now: () => new Date(T0 + 120_000) })
    return { home, homeDir, cwd, transcriptPath, saveCalls, drain }
  }

  it("a job stamped with a task saves under it; an old job resolves the pin instead", async () => {
    const { home, cwd, transcriptPath, saveCalls, drain } = drainSetup()
    pinSessionTask(home, "s-old", "p1", "sdk")
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s-new", transcriptPath, cwd, task: "grant-app", error: null })
    enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s-old", transcriptPath, cwd, error: null })
    await drain()
    expect(saveCalls).toHaveLength(2)
    expect(saveCalls.map((c) => c.sessionId).sort()).toEqual(["s-new", "s-old"])
    expect(saveCalls.find((c) => c.sessionId === "s-new")!.task).toBe("grant-app")
    expect(saveCalls.find((c) => c.sessionId === "s-old")!.task).toBe("sdk")
  })
})

describe("mcp-save task validation (tk-1)", () => {
  const FIELDS = { objective: "ship the thing", nextAction: "open the PR" }
  const mcpDeps = (sink: { input?: Omit<CheckpointEnvelope, "type"> }): McpSaveDeps => ({
    loadIdentity: () => ({ name: "claude-desktop", agentId: `0x${"7".repeat(64)}` }) as never,
    checkProject: async () => OK,
    hasAuthority: async () => true,
    capability: async () => "live",
    isRevoked: () => false,
    revokePending: () => undefined,
    save: (async (_rt: unknown, _name: string, input: Omit<CheckpointEnvelope, "type">) => {
      sink.input = input
      return { contextId: `0x${"cd".repeat(32)}`, transactionHash: null, milliseconds: 1, duplicate: false, lane: "direct" }
    }) as NonNullable<McpSaveDeps["save"]>,
    now: () => T0,
  })

  it("a bad task name is refused before any gate; a good one reaches the envelope", async () => {
    const home = homeWithCodex(join(dir(), "home"))
    const runtime = { home, owner: "0x0000000000000000000000000000000000000001" } as unknown as Runtime
    const sink: { input?: Omit<CheckpointEnvelope, "type"> } = {}
    const bad = await buildMcpSave(runtime, { agent: "claude-desktop", cwd: "/tmp/work", task: "NOT A TASK", fields: FIELDS }, mcpDeps(sink))
    expect(bad).toMatchObject({ kind: "refused", reason: "bad-task" })
    expect(sink.input).toBeUndefined()
    const good = await buildMcpSave(runtime, { agent: "claude-desktop", cwd: "/tmp/work", task: "sdk", fields: FIELDS }, mcpDeps(sink))
    expect(good).toMatchObject({ kind: "saved", task: "sdk" })
    expect(sink.input!.task).toBe("sdk")
  })
})

describe("mida task (tk-1)", () => {
  const cliRuntime = (home: MidaHome) => ({ home }) as unknown as ServiceRuntime

  it("sets, lists-current, refuses bad names, and clears — in a marked folder", async () => {
    const dirRoot = dir()
    const cwd = join(dirRoot, "work")
    markFolder(cwd)
    const home = new MidaHome(join(dirRoot, "home"))
    const lines: string[] = []
    const print = (line: string) => lines.push(line)
    const runtime = cliRuntime(home)
    expect(await runCliWithRuntime(["task", "grant-app"], runtime, print, { cwd })).toBe(0)
    expect(readFolderTask(cwd).task).toBe("grant-app")
    expect(await runCliWithRuntime(["task", "NOT A TASK"], runtime, print, { cwd })).toBe(2)
    expect(lines.some((line) => line.includes(TASK_RULE_TEXT.slice(0, 30)))).toBe(true)
    expect(await runCliWithRuntime(["task", "--clear"], runtime, print, { cwd })).toBe(0)
    expect(readFolderTask(cwd).task).toBeUndefined()
  })

  it("a bare `mida task` outside a project says so, exit 0", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    expect(await runCliWithRuntime(["task"], cliRuntime(home), (line) => lines.push(line), { cwd: dir() })).toBe(0)
    expect(lines[0]).toBe("current task: main (default)")
    expect(lines).toContain("this folder is not a Mida project — no task list")
  })

  it("a bare `mida task` reports MIDA_TASK as the source", async () => {
    const dirRoot = dir()
    const cwd = join(dirRoot, "work")
    markFolder(cwd)
    const home = new MidaHome(join(dirRoot, "home"))
    const lines: string[] = []
    // no approved agent exists, so the listing refuses after the current-task line
    await runCliWithRuntime(["task"], cliRuntime(home), (line) => lines.push(line), { cwd, task: "sdk" })
    expect(lines[0]).toBe("current task: sdk (MIDA_TASK)")
  })

  it("`task show` refuses a bad name before touching anything", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    expect(await runCliWithRuntime(["task", "show", "BAD NAME"], cliRuntime(home), (line) => lines.push(line), { cwd: dir() })).toBe(2)
    expect(lines[0]).toContain(TASK_RULE_TEXT.slice(0, 30))
  })
})

describe("the doctor task line (tk-1)", () => {
  const run = async (cwd: string) => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({ home, cwd, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 30 })
    return lines
  }

  it("reports the folder's current task, its default, and a broken task file", async () => {
    const cwd = dir()
    markFolder(cwd)
    const bare = await run(cwd)
    expect(bare).toContain("ok: this folder's current task is main (default)")
    writeFolderTask(cwd, "sdk")
    const named = await run(cwd)
    expect(named).toContain("ok: this folder's current task is sdk")
    writeFileSync(join(cwd, ".mida", "task.json"), "{broken")
    const broken = await run(cwd)
    expect(broken.some((line) => line.startsWith("PROBLEM:") && line.includes("task.json") && line.includes("main"))).toBe(true)
  })

  it("a folder that is not a project gets a note, not a failure", async () => {
    const lines = await run(dir())
    expect(lines).toContain("note: this folder is not a Mida project — tasks live inside one")
  })
})
