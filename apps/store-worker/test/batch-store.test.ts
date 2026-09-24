// BatchAnchor Task 5: D1BatchStore against a real SQLite D1 through Miniflare — not a fake, because
// the behaviours that matter here are SQL behaviours: INSERT OR IGNORE's dedup, the single-statement
// UPDATE ... RETURNING claim, and the sequence counter's atomic increment.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import type { BatchSaveRow, BatchedSaveWire } from "@mida/api"
import { D1BatchStore } from "../src/d1.js"
import type { D1Like } from "../src/d1.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const OWNER = `0x${"1".repeat(40)}` as Address
const OTHER_OWNER = `0x${"2".repeat(40)}` as Address
const SIGNER = `0x${"3".repeat(40)}` as Address
const NAMESPACE = namespaceId("goals.career")
const OTHER_NAMESPACE = namespaceId("goals.health")

let mf: Miniflare
let db: D1Like
let store: D1BatchStore

beforeAll(async () => {
  mf = new Miniflare({
    // Only the D1 binding is under test — the module is a stub that never serves a request.
    modules: [{ type: "ESModule", path: "worker.mjs", contents: "export default { fetch: () => new Response('unused') }" }],
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
  })
  db = (await mf.getD1Database("DB")) as unknown as D1Like
  const statements = readFileSync(join(HERE, "..", "schema.sql"), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
  await db.batch(statements.map((sql) => db.prepare(sql)))
  store = new D1BatchStore(db)
})

afterAll(async () => {
  await mf?.dispose()
})

let seq = 0
/** A minimal well-formed row; `save` carries a ciphertext blob inside save_json — never `objects`. */
function fakeRow(input: { owner?: Address; namespaceId?: Hex; receivedAt?: number; ciphertext?: string } = {}): BatchSaveRow {
  seq++
  const save: BatchedSaveWire = {
    message: {
      owner: input.owner ?? OWNER,
      namespaceId: input.namespaceId ?? NAMESPACE,
      objectNonce: hexOf(randomBytes(32)),
      lineageId: `0x${"0".repeat(64)}`,
      parentId: `0x${"0".repeat(64)}`,
      parentVersion: 0,
      rootAuthor: `0x${"0".repeat(64)}`,
      manifestHash: hexOf(randomBytes(32)),
      ciphertextCommitment: hexOf(randomBytes(32)),
      readEpoch: "1",
      expiresAt: "0",
      kind: 1,
      provenanceSource: 3,
    },
    signature: `0x${"ab".repeat(65)}` as Hex,
    manifest: {
      v: 1,
      contextId: hexOf(randomBytes(32)),
      ciphertextHash: hexOf(randomBytes(32)),
      ciphertextSize: 32,
      payloadNonce: hexOf(randomBytes(24)),
      cryptoVersion: "mida-crypto-v1",
      readEpoch: "1",
      epochDekWrap: {
        v: 1,
        contextId: hexOf(randomBytes(32)),
        namespaceId: NAMESPACE,
        readEpoch: "1",
        ephemeralPublicKey: hexOf(randomBytes(32)),
        nonce: hexOf(randomBytes(24)),
        wrappedDek: hexOf(randomBytes(48)),
      },
    },
    ciphertext: (input.ciphertext ?? `0x${"cd".repeat(32)}`) as Hex,
  }
  return {
    contextId: `0x${seq.toString(16).padStart(64, "0")}` as Hex,
    owner: (input.owner ?? OWNER).toUpperCase().replace("X", "x") as Address, // writes must normalize case
    namespaceId: (input.namespaceId ?? NAMESPACE).toUpperCase().replace("X", "x") as Address as Hex,
    signer: SIGNER,
    save,
    state: "QUEUED",
    reason: null,
    batchId: null,
    position: null,
    lineageId: null,
    version: null,
    proof: null,
    receivedAt: input.receivedAt ?? 1_800_000_000_000 + seq,
    anchoredAt: null,
  }
}

describe("D1BatchStore", () => {
  it("inserts once, dedups on contextId, and round-trips the whole signed save", async () => {
    const row = fakeRow()
    expect(await store.insert(row)).toBe("inserted")
    expect(await store.insert(row)).toBe("exists")

    const got = await store.get(row.contextId)
    expect(got).not.toBeNull()
    expect(got!.contextId).toBe(row.contextId.toLowerCase())
    expect(got!.owner).toBe(OWNER) // written uppercase, stored lowercase
    expect(got!.save).toEqual(row.save)
    expect(got!.state).toBe("QUEUED")
    expect(await store.get(hexOf(randomBytes(32)))).toBeNull()
  })

  it("lists QUEUED, SUBMITTED and ANCHORED for the reader's owner+namespace — REJECTED and other scopes stay out", async () => {
    const owner = `0x${"4".repeat(40)}` as Address
    const ns = namespaceId("money.portfolio")
    const a = fakeRow({ owner, namespaceId: ns, receivedAt: 100 })
    const b = fakeRow({ owner, namespaceId: ns, receivedAt: 200 })
    const c = fakeRow({ owner, namespaceId: ns, receivedAt: 300 })
    const d = fakeRow({ owner, namespaceId: ns, receivedAt: 400 })
    const e = fakeRow({ owner, namespaceId: ns, receivedAt: 500 })
    await store.insert(a)
    await store.insert(b)
    await store.insert(c)
    await store.insert(d)
    await store.insert(e)
    // a claimed by a batch (oldest first), c anchored, d rejected — b and e stay queued.
    const batchId = hexOf(randomBytes(32))
    const claimed = await store.takeQueued(1, batchId)
    expect(claimed.map((row) => row.contextId)).toEqual([a.contextId.toLowerCase()])
    await store.markAnchored(c.contextId, {
      batchId,
      position: 1,
      lineageId: c.contextId,
      version: 1,
      proof: [hexOf(randomBytes(32))],
      anchoredAt: 1_800_000_999_999,
    })
    await store.markRejected(d.contextId, "BAD_EPOCH")

    const rows = await store.listForReader(owner, ns)
    expect(rows.map((row) => [row.contextId, row.state])).toEqual([
      [a.contextId.toLowerCase(), "SUBMITTED"],
      [b.contextId.toLowerCase(), "QUEUED"],
      [c.contextId.toLowerCase(), "ANCHORED"],
      [e.contextId.toLowerCase(), "QUEUED"],
    ])
    const claimedRow = rows[0]!
    expect(claimedRow.batchId).toBe(batchId)
    const anchored = rows.find((row) => row.contextId === c.contextId.toLowerCase())
    expect(anchored).toMatchObject({ batchId, position: 1, version: 1, anchoredAt: 1_800_000_999_999 })
    expect(anchored!.proof).toHaveLength(1)

    // Direct lookup still finds the rejected row and its reason; the list does not.
    expect(await store.get(d.contextId)).toMatchObject({ state: "REJECTED", reason: "BAD_EPOCH" })
    // Other owner / other namespace see nothing.
    expect(await store.listForReader(OTHER_OWNER, ns)).toEqual([])
    expect(await store.listForReader(owner, OTHER_NAMESPACE)).toEqual([])
  })

  it("takeQueued is one UPDATE ... RETURNING: concurrent claims can never hand out the same row", async () => {
    // The queue is global: rows earlier tests left QUEUED would be claimed here too — drain them
    // first so this test's three rows are the only contenders.
    await store.takeQueued(1_000, hexOf(randomBytes(32)))
    expect(await store.countQueued()).toBe(0)
    const owner = `0x${"5".repeat(40)}` as Address
    const ns = namespaceId("health.fitness")
    for (let i = 0; i < 3; i++) await store.insert(fakeRow({ owner, namespaceId: ns, receivedAt: 1_000 + i }))
    const batchA = hexOf(randomBytes(32))
    const batchB = hexOf(randomBytes(32))
    // Two racing claims of 2 rows each: union must be disjoint and total at most 3.
    const [takenA, takenB] = await Promise.all([store.takeQueued(2, batchA), store.takeQueued(2, batchB)])
    const ids = [...takenA, ...takenB].map((row) => row.contextId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeLessThanOrEqual(3)
    for (const row of takenA) expect(row).toMatchObject({ state: "SUBMITTED", batchId: batchA })
    for (const row of takenB) expect(row).toMatchObject({ state: "SUBMITTED", batchId: batchB })

    // A failed submission requeues the whole batch; a later claim picks the rows up again.
    const requeued = await store.requeue(batchA)
    const claimedAgain = await store.takeQueued(10, hexOf(randomBytes(32)))
    expect(requeued).toBe(takenA.length)
    expect(claimedAgain.length).toBe(3 - takenB.length)
    // ANCHORED rows are never re-claimed.
    expect(claimedAgain.every((row) => row.state === "SUBMITTED")).toBe(true)
  })

  it("the receipt sequence increments atomically and never repeats; flush marks are per signer", async () => {
    const first = await store.nextSequence()
    const second = await store.nextSequence()
    const third = await store.nextSequence()
    expect(new Set([first, second, third]).size).toBe(3)
    expect(second).toBe(first + 1n)
    // Racing increments still hand out distinct values.
    const raced = await Promise.all([store.nextSequence(), store.nextSequence(), store.nextSequence()])
    expect(new Set(raced).size).toBe(3)
    expect(Math.min(...raced.map(Number))).toBe(Number(third) + 1)

    const signer = `0x${"6".repeat(40)}` as Address
    const other = `0x${"7".repeat(40)}` as Address
    expect(await store.lastFlush(signer)).toBeNull()
    await store.setLastFlush(signer, 1_800_000_123_456)
    expect(await store.lastFlush(signer)).toBe(1_800_000_123_456)
    expect(await store.lastFlush(other)).toBeNull()
    await store.setLastFlush(signer, 1_800_000_999_999)
    expect(await store.lastFlush(signer)).toBe(1_800_000_999_999)
  })

  it("countQueued counts only QUEUED — submitted, anchored and rejected rows are out", async () => {
    const owner = `0x${"8".repeat(40)}` as Address
    const ns = namespaceId("work.tasks")
    const before = await store.countQueued()
    const rows = [fakeRow({ owner, namespaceId: ns }), fakeRow({ owner, namespaceId: ns }), fakeRow({ owner, namespaceId: ns })]
    for (const row of rows) await store.insert(row)
    expect(await store.countQueued()).toBe(before + 3)
    await store.markRejected(rows[0]!.contextId, "NO_AUTHORITY")
    await store.takeQueued(1, hexOf(randomBytes(32))) // claims rows[1]
    expect(await store.countQueued()).toBe(before + 1)
  })
})
