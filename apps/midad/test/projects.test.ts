import { describe, expect, it } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Hex } from "@mida/protocol"
import {
  MidaHome, approveProject, checkProject, loadOrCreateOwnerSecrets, removeAgentApprovals,
} from "@mida/midad"
import type { ProjectApproval, Runtime } from "@mida/midad"

/**
 * The approved-projects list never touches the chain in these tests: entries are signed by the
 * owner's key and checked against `runtime.owner`, so a stub runtime carrying a home and the owner
 * address is enough. `dir` is canonicalised because macOS's /var is a symlink — `root` in the list
 * is always a realpath, so test folders must be too.
 */
function setup() {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "mida-projects-")))
  const home = new MidaHome(join(dir, "mida"))
  const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
  const runtime = { home, owner } as unknown as Runtime
  const workDir = join(dir, "work")
  mkdirSync(workDir, { recursive: true })
  return { dir, home, runtime, workDir }
}

const mark = (dir: string, projectId: string) => {
  mkdirSync(join(dir, ".mida"), { recursive: true })
  writeFileSync(join(dir, ".mida", "project.json"), JSON.stringify({ projectId }))
}

const LIST = "approved-projects.json"

describe("checkProject never throws and names a stable reason", () => {
  it("a folder with no marker anywhere up the tree is not-a-project", async () => {
    const { runtime, workDir } = setup()
    expect(await checkProject(runtime, { agent: "claude-code", cwd: workDir })).toEqual({ ok: false, reason: "not-a-project" })
  })

  it("a marked project with no list file at all is not-approved", async () => {
    const { runtime, workDir } = setup()
    mark(workDir, "p-1")
    expect(await checkProject(runtime, { agent: "claude-code", cwd: workDir })).toEqual({ ok: false, reason: "not-approved" })
  })

  it("every present-but-wrong list file is list-tampered — never an exception, never treated as empty", async () => {
    const { home, runtime, workDir } = setup()
    mark(workDir, "p-1")
    const sig = `0x${"ab".repeat(65)}` as Hex
    const cases: [string, () => void][] = [
      ["unparseable JSON", () => writeFileSync(home.path(LIST), "{not json")],
      ["no signature field", () => home.writeSecretJson(LIST, { entries: [] })],
      ["entries not an array", () => home.writeSecretJson(LIST, { entries: "nope", signature: sig })],
      ["an entry with a wrong-typed field", () =>
        home.writeSecretJson(LIST, { entries: [{ agent: "claude-code", projectId: "p-1", root: 42, approvedAt: "x" }], signature: sig })],
      ["a signature that is not a string", () => home.writeSecretJson(LIST, { entries: [], signature: 7 })],
      ["an unreadable file", () => { writeFileSync(home.path(LIST), "{}"); chmodSync(home.path(LIST), 0o000) }],
    ]
    for (const [name, write] of cases) {
      try {
        write()
        const result = await checkProject(runtime, { agent: "claude-code", cwd: workDir })
        expect(result, name).toEqual({ ok: false, reason: "list-tampered" })
      } finally {
        if (home.has(LIST)) chmodSync(home.path(LIST), 0o600)
        home.remove(LIST)
      }
    }
  })
})

describe("approveProject", () => {
  it("uses an existing marker's projectId, stores the realpath root, and checkProject then approves — even two folders down", async () => {
    const { home, runtime, workDir } = setup()
    mark(workDir, "p-1")
    const approval = await approveProject(runtime, { agent: "claude-code", cwd: workDir })
    expect(approval).toMatchObject({ agent: "claude-code", projectId: "p-1", root: realpathSync(workDir) })
    const nested = join(workDir, "a", "b")
    mkdirSync(nested, { recursive: true })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: nested })).toEqual({ ok: true, approval })
    expect(statSync(home.path(LIST)).mode & 0o777).toBe(0o600)
  })

  it("creates <cwd>/.mida/project.json when no marker exists up the tree", async () => {
    const { dir, runtime } = setup()
    const fresh = join(dir, "fresh")
    mkdirSync(fresh)
    const approval = await approveProject(runtime, { agent: "codex", cwd: fresh })
    const marker = JSON.parse(readFileSync(join(fresh, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toBe(approval.projectId)
    expect(approval.root).toBe(realpathSync(fresh))
  })

  it("refuses not-a-project in the home folder and at the filesystem root, writing nothing", async () => {
    const { dir, home, runtime } = setup()
    const fakeHome = join(dir, "user-home")
    mkdirSync(fakeHome)
    await expect(approveProject(runtime, { agent: "codex", cwd: fakeHome, homeDir: fakeHome }))
      .rejects.toMatchObject({ code: "not-a-project" })
    expect(existsSync(join(fakeHome, ".mida"))).toBe(false)
    await expect(approveProject(runtime, { agent: "codex", cwd: "/", homeDir: fakeHome }))
      .rejects.toMatchObject({ code: "not-a-project" })
    expect(home.has(LIST)).toBe(false)
  })

  it("two approvals back to back — and two run concurrently — both land in the file", async () => {
    const { dir, home, runtime } = setup()
    const a = join(dir, "a"); const b = join(dir, "b")
    mark(a, "p-a"); mark(b, "p-b")
    await approveProject(runtime, { agent: "claude-code", cwd: a })
    await approveProject(runtime, { agent: "claude-code", cwd: b })
    let file = home.readJson<{ entries: ProjectApproval[] }>(LIST)!
    expect(file.entries).toHaveLength(2)
    // the same race in one process: neither entry may overwrite the other
    const c = join(dir, "c"); const d = join(dir, "d")
    mark(c, "p-c"); mark(d, "p-d")
    await Promise.all([
      approveProject(runtime, { agent: "codex", cwd: c }),
      approveProject(runtime, { agent: "gemini", cwd: d }),
    ])
    file = home.readJson<{ entries: ProjectApproval[] }>(LIST)!
    expect(file.entries).toHaveLength(4)
    expect(await checkProject(runtime, { agent: "codex", cwd: c })).toMatchObject({ ok: true })
    expect(await checkProject(runtime, { agent: "gemini", cwd: d })).toMatchObject({ ok: true })
  })
})

describe("the signature covers a canonical form of the entries", () => {
  it("entries reordered by hand still verify; a one-character root edit or a foreign key is list-tampered", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mark(dirB, "p-b")
    const a = await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    const b = await approveProject(runtime, { agent: "claude-code", cwd: dirB })
    const signed = home.readJson<{ entries: ProjectApproval[]; signature: Hex }>(LIST)!

    // reorder the two entries in place — the canonical sort makes the signature still hold
    home.writeSecretJson(LIST, { entries: [b, a], signature: signed.signature })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirA })).toMatchObject({ ok: true })

    // one character of one root changed — the bytes no longer match what the owner signed
    const edited: ProjectApproval = { ...a, root: `${a.root.slice(0, -1)}${a.root.endsWith("x") ? "y" : "x"}` }
    home.writeSecretJson(LIST, { entries: [edited, b], signature: signed.signature })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirA })).toEqual({ ok: false, reason: "list-tampered" })

    // the identical entries signed by a freshly generated key — the signer is not the owner
    const foreign = privateKeyToAccount(generatePrivateKey())
    const canonical = JSON.stringify([a, b].map((e) => ({ agent: e.agent, projectId: e.projectId, root: e.root, approvedAt: e.approvedAt })))
    const signature = await foreign.signMessage({ message: canonical })
    home.writeSecretJson(LIST, { entries: [a, b], signature })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirA })).toEqual({ ok: false, reason: "list-tampered" })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirB })).toEqual({ ok: false, reason: "list-tampered" })
  })
})

describe("folder-mismatch beats not-approved", () => {
  it("this agent's projectId under another root is folder-mismatch; only another agent's entry is not-approved", async () => {
    const { dir, runtime } = setup()
    const real = join(dir, "real"); mark(real, "p-1")
    await approveProject(runtime, { agent: "claude-code", cwd: real })
    // the project folder copied somewhere else carries the same projectId
    const clone = join(dir, "clone"); mark(clone, "p-1")
    expect(await checkProject(runtime, { agent: "claude-code", cwd: clone })).toEqual({ ok: false, reason: "folder-mismatch" })
    // an agent that was never approved for this project gets the plain refusal
    expect(await checkProject(runtime, { agent: "codex", cwd: real })).toEqual({ ok: false, reason: "not-approved" })
    expect(await checkProject(runtime, { agent: "codex", cwd: clone })).toEqual({ ok: false, reason: "not-approved" })
  })

  it("a symlinked cwd resolves to the approved real root", async () => {
    const { dir, runtime } = setup()
    const real = join(dir, "real"); mark(real, "p-1")
    await approveProject(runtime, { agent: "claude-code", cwd: real })
    const link = join(dir, "link")
    symlinkSync(real, link)
    expect(await checkProject(runtime, { agent: "claude-code", cwd: link })).toMatchObject({ ok: true })
    // approving through the link stores the realpath, so the bare path checks out too
    const approval = await approveProject(runtime, { agent: "codex", cwd: link })
    expect(approval.root).toBe(realpathSync(real))
    expect(await checkProject(runtime, { agent: "codex", cwd: real })).toMatchObject({ ok: true })
  })
})

describe("removeAgentApprovals", () => {
  it("drops one agent's rows, keeps another's, and the file still verifies", async () => {
    const { dir, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mark(dirB, "p-b")
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    await approveProject(runtime, { agent: "codex", cwd: dirB })
    expect(await removeAgentApprovals(runtime, "claude-code")).toBe(1)
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirA })).toEqual({ ok: false, reason: "not-approved" })
    expect(await checkProject(runtime, { agent: "codex", cwd: dirB })).toMatchObject({ ok: true })
  })

  it("a missing list removes nothing and stays missing", async () => {
    const { home, runtime } = setup()
    expect(await removeAgentApprovals(runtime, "nobody")).toBe(0)
    expect(home.has(LIST)).toBe(false)
  })

  it("a tampered list is never re-signed as-is: the write path rebuilds it from trusted content only", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); mark(dirA, "p-a")
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    // an attacker-written row that can never have been signed by the owner
    const file = home.readJson<{ entries: ProjectApproval[]; signature: Hex }>(LIST)!
    const planted: ProjectApproval = { agent: "evil", projectId: "p-evil", root: realpathSync(dirA), approvedAt: "x" }
    home.writeSecretJson(LIST, { entries: [...file.entries, planted], signature: file.signature })
    expect(await checkProject(runtime, { agent: "evil", cwd: dirA })).toEqual({ ok: false, reason: "list-tampered" })
    // approving again must not carry the untrusted row into a validly signed file
    const dirC = join(dir, "c"); mark(dirC, "p-c")
    await approveProject(runtime, { agent: "claude-code", cwd: dirC })
    const healed = home.readJson<{ entries: ProjectApproval[] }>(LIST)!
    expect(healed.entries.some((e) => e.agent === "evil")).toBe(false)
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirC })).toMatchObject({ ok: true })
    // the row that was there before the tamper is gone too — nothing unverifiable is kept
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirA })).toEqual({ ok: false, reason: "not-approved" })
  })
})
