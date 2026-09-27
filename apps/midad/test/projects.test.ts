import { describe, expect, it } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Hex } from "@mida/protocol"
import {
  MidaHome, approveProject, approvalsFileStatus, canonicalEntries, checkProject, linkProject, loadOrCreateOwnerSecrets,
  planProjectLink, removeAgentApprovals,
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

  it("a list file that parses but fails shape or signature is list-tampered — never an exception, never treated as empty", async () => {
    const { home, runtime, workDir } = setup()
    mark(workDir, "p-1")
    const sig = `0x${"ab".repeat(65)}` as Hex
    const cases: [string, () => void][] = [
      ["no signature field", () => home.writeSecretJson(LIST, { entries: [] })],
      ["entries not an array", () => home.writeSecretJson(LIST, { entries: "nope", signature: sig })],
      ["an entry with a wrong-typed field", () =>
        home.writeSecretJson(LIST, { entries: [{ agent: "claude-code", projectId: "p-1", root: 42, approvedAt: "x" }], signature: sig })],
      ["a signature that is not a string", () => home.writeSecretJson(LIST, { entries: [], signature: 7 })],
    ]
    for (const [name, write] of cases) {
      try {
        write()
        const result = await checkProject(runtime, { agent: "claude-code", cwd: workDir })
        expect(result, name).toEqual({ ok: false, reason: "list-tampered" })
        expect(await approvalsFileStatus(home, runtime.owner), name).toBe("bad-signature")
      } finally {
        home.remove(LIST)
      }
    }
  })

  it("a list file that cannot be read or parsed is list-unreadable — a permissions problem, not a signature claim", async () => {
    const { home, runtime, workDir } = setup()
    mark(workDir, "p-1")
    const cases: [string, () => void][] = [
      ["unparseable JSON", () => writeFileSync(home.path(LIST), "{not json")],
      ["a permission-denied file", () => { writeFileSync(home.path(LIST), "{}"); chmodSync(home.path(LIST), 0o000) }],
    ]
    for (const [name, write] of cases) {
      try {
        write()
        const result = await checkProject(runtime, { agent: "claude-code", cwd: workDir })
        expect(result, name).toEqual({ ok: false, reason: "list-unreadable" })
        expect(await approvalsFileStatus(home, runtime.owner), name).toBe("unreadable")
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
    const { approval, droppedRows } = await approveProject(runtime, { agent: "claude-code", cwd: workDir })
    expect(approval).toMatchObject({ agent: "claude-code", projectId: "p-1", root: realpathSync(workDir) })
    expect(droppedRows).toBe(0)
    const nested = join(workDir, "a", "b")
    mkdirSync(nested, { recursive: true })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: nested })).toEqual({ ok: true, approval })
    expect(statSync(home.path(LIST)).mode & 0o777).toBe(0o600)
  })

  it("creates <cwd>/.mida/project.json when no marker exists up the tree", async () => {
    const { dir, runtime } = setup()
    const fresh = join(dir, "fresh")
    mkdirSync(fresh)
    const { approval } = await approveProject(runtime, { agent: "codex", cwd: fresh })
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

  it("an unreadable list refuses — one approve cannot silently discard every other row", async () => {
    const { home, runtime, workDir } = setup()
    mark(workDir, "p-1")
    const bytes = '{"entries":[],"signature":"0x12"}'
    writeFileSync(home.path(LIST), bytes)
    chmodSync(home.path(LIST), 0o000)
    try {
      await expect(approveProject(runtime, { agent: "claude-code", cwd: workDir }))
        .rejects.toThrow("the approved-projects list could not be read: check the file's permissions")
    } finally {
      chmodSync(home.path(LIST), 0o600)
    }
    // the refusal wrote nothing — the bytes the owner may still fix are untouched
    expect(readFileSync(home.path(LIST), "utf8")).toBe(bytes)
  })

  it("a bad-signature list is rebuilt from empty and reports how many rows it dropped", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); mark(dirA, "p-a")
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    // a hand-added row the signature does not cover — the file parses, the signature fails
    const file = home.readJson<{ entries: ProjectApproval[]; signature: Hex }>(LIST)!
    const planted: ProjectApproval = { agent: "evil", projectId: "p-evil", root: "/tmp", approvedAt: "x" }
    home.writeSecretJson(LIST, { entries: [...file.entries, planted], signature: file.signature })
    const dirB = join(dir, "b"); mark(dirB, "p-b")
    const result = await approveProject(runtime, { agent: "codex", cwd: dirB })
    expect(result.approval.agent).toBe("codex")
    expect(result.droppedRows).toBe(2)   // both unverifiable rows went away — none was re-signed
    const healed = home.readJson<{ entries: ProjectApproval[] }>(LIST)!
    expect(healed.entries).toHaveLength(1)
  })

  it("a bad-signature file whose rows cannot be counted reports null, not a guess", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); mark(dirA, "p-a")
    home.writeSecretJson(LIST, { entries: "nope", signature: `0x${"ab".repeat(65)}` })
    const result = await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    expect(result.droppedRows).toBeNull()
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
    const { approval: a } = await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    const { approval: b } = await approveProject(runtime, { agent: "claude-code", cwd: dirB })
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
    const { approval } = await approveProject(runtime, { agent: "codex", cwd: link })
    expect(approval.root).toBe(realpathSync(real))
    expect(await checkProject(runtime, { agent: "codex", cwd: real })).toMatchObject({ ok: true })
  })
})

describe("the same folder is the same folder, whatever its letter case (in-6 R6)", () => {
  // realpathSync keeps the case a path was TYPED in on macOS; realpathSync.native returns the
  // real case. Approving `~/Documents/Notes` then opening `~/documents/notes`
  // used to answer folder-mismatch → "not approved" while approve said "already approved".
  const caseInsensitive = (() => {
    const probe = mkdtempSync(join(realpathSync(tmpdir()), "mida-CiSe-"))
    return existsSync(probe.toLowerCase())
  })()

  it.skipIf(!caseInsensitive)("approve through one case and check through the other approves", async () => {
    const { dir, runtime } = setup()
    const work = join(dir, "MiXeD-WoRk")
    mark(work, "p-1")
    const lower = join(dir, "mixed-work")
    await approveProject(runtime, { agent: "claude-code", cwd: lower })
    // opened through the real case — and approved through the typed one — is the same project
    expect(await checkProject(runtime, { agent: "claude-code", cwd: work })).toMatchObject({ ok: true })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: lower })).toMatchObject({ ok: true })
  })

  it.skipIf(!caseInsensitive)("a row written before this fix — root in typed case — still matches its real folder", async () => {
    const { dir, home, runtime } = setup()
    const work = join(dir, "ReAl-WoRk")
    mark(work, "p-1")
    // a pre-fix file holds realpathSync output — the case the path was typed in
    const row: ProjectApproval = { agent: "claude-code", projectId: "p-1", root: realpathSync(join(dir, "real-work")), approvedAt: "x" }
    const key = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey)
    const signature = await key.signMessage({ message: canonicalEntries([row]) })
    home.writeSecretJson(LIST, { entries: [row], signature })
    expect(await checkProject(runtime, { agent: "claude-code", cwd: work })).toMatchObject({ ok: true })
  })

  it("a stored root that no longer exists is skipped by the canonical compare, not fatal", async () => {
    const { dir, home, runtime, workDir } = setup()
    mark(workDir, "p-1")
    const row: ProjectApproval = { agent: "claude-code", projectId: "p-1", root: join(dir, "deleted-folder"), approvedAt: "x" }
    const key = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey)
    const signature = await key.signMessage({ message: canonicalEntries([row]) })
    home.writeSecretJson(LIST, { entries: [row], signature })
    // same agent + projectId under a root that cannot be canonicalised — folder-mismatch, no throw
    expect(await checkProject(runtime, { agent: "claude-code", cwd: workDir })).toEqual({ ok: false, reason: "folder-mismatch" })
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

/**
 * lk-1 — `mida link` puts a second folder under an existing project: B's own marker takes the
 * project's id and the signed list gains one row per agent the project already allows. The list
 * is owner-signed local data, so the same stub runtime drives every step — no chain anywhere.
 */
describe("mida link — a second folder joins an existing project (lk-1)", () => {
  const entriesOf = (home: MidaHome) => home.readJson<{ entries: ProjectApproval[] }>(LIST)!.entries

  it("B gets A's project id, one signed row per approved agent, and every pre-existing row is untouched", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b"); const other = join(dir, "other")
    mark(dirA, "p-a"); mark(other, "p-x")
    mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    await approveProject(runtime, { agent: "codex", cwd: dirA })
    // an agent approved somewhere else must not gain a row in B
    await approveProject(runtime, { agent: "gemini", cwd: other })
    const before = entriesOf(home)

    const plan = await planProjectLink(runtime, { folder: dirA, cwd: dirB })
    expect(plan).toMatchObject({ kind: "ok", projectId: "p-a", agents: ["claude-code", "codex"] })
    const linked = await linkProject(runtime, { projectId: "p-a", dir: dirB })
    expect(linked.added).toEqual(["claude-code", "codex"])

    // B now carries A's project id
    const marker = JSON.parse(readFileSync(join(dirB, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toBe("p-a")
    const rows = entriesOf(home).filter((e) => e.root === realpathSync(dirB))
    expect(rows.map((e) => e.agent).sort()).toEqual(["claude-code", "codex"])
    expect(rows.every((e) => e.projectId === "p-a")).toBe(true)
    // every row that was there before is untouched — other projects and folders included
    expect(entriesOf(home).filter((e) => e.root !== realpathSync(dirB))).toEqual(before)
    // the list still verifies, and the security gate now answers ok in B — including a subfolder
    expect(await approvalsFileStatus(home, runtime.owner)).toBe("signed")
    expect(await checkProject(runtime, { agent: "claude-code", cwd: dirB })).toMatchObject({ ok: true })
    const nested = join(dirB, "nested")
    mkdirSync(nested)
    expect(await checkProject(runtime, { agent: "claude-code", cwd: nested })).toMatchObject({ ok: true })
    // gemini was approved for a different project — B refuses it as before
    expect(await checkProject(runtime, { agent: "gemini", cwd: dirB })).toEqual({ ok: false, reason: "not-approved" })
  })

  it("refuses when the named folder is not inside a project — and when it does not exist at all", async () => {
    const { dir, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mkdirSync(dirA); mkdirSync(dirB)
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "refused", code: "no-project" })
    // a typo'd path refuses too — it must not silently resolve to a parent's project
    expect(await planProjectLink(runtime, { folder: join(dir, "ghost"), cwd: dirB })).toMatchObject({ kind: "refused", code: "no-project" })
    expect(existsSync(join(dirB, ".mida"))).toBe(false)
  })

  it("refuses to link the folder to itself — B IS A once both paths are canonical", async () => {
    const { dir, runtime } = setup()
    const dirA = join(dir, "a"); mark(dirA, "p-a")
    const alias = join(dir, "alias-of-a")
    symlinkSync(dirA, alias)
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirA })).toMatchObject({ kind: "refused", code: "same-folder" })
    // the named folder spelled through a symlink lands on the same canonical folder
    expect(await planProjectLink(runtime, { folder: alias, cwd: dirA })).toMatchObject({ kind: "refused", code: "same-folder" })
  })

  it("refuses when B already carries its own marker for a DIFFERENT project — nothing written", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mark(dirB, "p-b")
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "refused", code: "different-project" })
    // B's marker still names its own project — the refusal wrote nothing
    const marker = JSON.parse(readFileSync(join(dirB, ".mida", "project.json"), "utf8")) as { projectId: string }
    expect(marker.projectId).toBe("p-b")
    expect(home.has(LIST)).toBe(false)
  })

  it("refuses to preview a link when the signed list cannot be read", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mkdirSync(dirB)
    writeFileSync(home.path(LIST), "{not json")
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "refused", code: "list-unreadable" })
    expect(existsSync(join(dirB, ".mida"))).toBe(false)
  })

  it("refuses a tampered list — who the project allows is unknowable, so it never rebuilds empty", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    const file = home.readJson<{ entries: ProjectApproval[]; signature: Hex }>(LIST)!
    home.writeSecretJson(LIST, {
      entries: [...file.entries, { agent: "evil", projectId: "p-a", root: "/tmp/evil", approvedAt: "x" }],
      signature: file.signature,
    })
    // the plan refuses before any yes could be typed — and nothing moves
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "refused", code: "list-tampered" })
    expect(existsSync(join(dirB, ".mida"))).toBe(false)
    // the write path refuses too — unlike approve, link cannot rebuild from trusted content:
    // the agents it would add are the very thing the broken file no longer proves
    await expect(linkProject(runtime, { projectId: "p-a", dir: dirB })).rejects.toMatchObject({ code: "list-tampered" })
    // every row the owner actually signed still sits in the file — verifyMessage fails only on the added line
    expect(await approvalsFileStatus(home, runtime.owner)).toBe("bad-signature")
  })

  it("a second link into the same project is the no-op the owner is told about", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    await linkProject(runtime, { projectId: "p-a", dir: dirB })
    expect(entriesOf(home)).toHaveLength(2)
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "already", projectId: "p-a" })
    expect(entriesOf(home)).toHaveLength(2)
  })

  it("a relative spelling of <folder> joins the same project — B's row is still its realpath", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    const plan = await planProjectLink(runtime, { folder: "../a", cwd: dirB })
    expect(plan).toMatchObject({ kind: "ok", projectId: "p-a" })
    const linked = await linkProject(runtime, { projectId: "p-a", dir: dirB })
    expect(linked.root).toBe(realpathSync(dirB))
    expect(entriesOf(home).filter((e) => e.root === realpathSync(dirB))).toHaveLength(1)
  })

  it("a tilde spelling of <folder> expands against the home dir before the marker walk", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    expect(await planProjectLink(runtime, { folder: "~/a", cwd: dirB, homeDir: dir })).toMatchObject({ kind: "ok", projectId: "p-a" })
    expect(await planProjectLink(runtime, { folder: "~/nope", cwd: dirB, homeDir: dir })).toMatchObject({ kind: "refused", code: "no-project" })
  })

  it("linking through a symlinked cwd signs the realpath row — a second spelling adds nothing", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "b")
    mark(dirA, "p-a"); mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    const link = join(dir, "b-link")
    symlinkSync(dirB, link)
    const linked = await linkProject(runtime, { projectId: "p-a", dir: link })
    expect(linked.root).toBe(realpathSync(dirB))
    expect(entriesOf(home)).toHaveLength(2)
    // the same folder through its real path is already linked — no second row, no second marker write needed
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "already" })
    expect(entriesOf(home)).toHaveLength(2)
  })

  const caseInsensitive = (() => {
    const probe = mkdtempSync(join(realpathSync(tmpdir()), "mida-LkCi-"))
    return existsSync(probe.toLowerCase())
  })()

  it.skipIf(!caseInsensitive)("a case-only spelling of the same folder adds no second row (in-6 R6 rule)", async () => {
    const { dir, home, runtime } = setup()
    const dirA = join(dir, "a"); const dirB = join(dir, "MiXeD-B")
    mark(dirA, "p-a"); mkdirSync(dirB)
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    await linkProject(runtime, { projectId: "p-a", dir: join(dir, "mixed-b") })
    expect(entriesOf(home)).toHaveLength(2)
    // already linked through the other case — nothing to add
    expect(await planProjectLink(runtime, { folder: dirA, cwd: dirB })).toMatchObject({ kind: "already" })
    expect(entriesOf(home)).toHaveLength(2)
  })
})
