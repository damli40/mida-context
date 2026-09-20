import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessRequest, Hex } from "@mida/protocol"
import { FileAccessRequestStore, MidaHome } from "@mida/midad"

const REQUEST_ID = `0x${"ab".repeat(32)}` as Hex
const request = { requestId: REQUEST_ID, purposeId: "project_assistance" } as unknown as AccessRequest
const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-req-")))

describe("FileAccessRequestStore", () => {
  it("loads what it saved, unconsumed", async () => {
    const store = new FileAccessRequestStore(freshHome(), "codex")
    await store.save(request)
    expect(await store.load(REQUEST_ID)).toEqual({ request, consumed: false })
  })

  it("treats request IDs as case-insensitive", async () => {
    const store = new FileAccessRequestStore(freshHome(), "codex")
    await store.save(request)
    expect(await store.load(`0x${"AB".repeat(32)}` as Hex)).toBeDefined()
  })

  it("refuses to save the same request ID twice", async () => {
    const store = new FileAccessRequestStore(freshHome(), "codex")
    await store.save(request)
    await expect(store.save(request)).rejects.toMatchObject({ code: "REPLAY" })
  })

  it("survives a restart: a second store on the same home sees the request", async () => {
    const home = freshHome()
    await new FileAccessRequestStore(home, "codex").save(request)
    expect(await new FileAccessRequestStore(home, "codex").load(REQUEST_ID)).toEqual({ request, consumed: false })
  })

  it("marks consumed exactly once, even across two store instances", async () => {
    const home = freshHome()
    const first = new FileAccessRequestStore(home, "codex")
    await first.save(request)
    await first.markConsumed(REQUEST_ID)
    expect((await first.load(REQUEST_ID))!.consumed).toBe(true)
    await expect(new FileAccessRequestStore(home, "codex").markConsumed(REQUEST_ID)).rejects.toMatchObject({ code: "REQUEST_CONSUMED" })
  })

  it("rejects marking an unknown request", async () => {
    await expect(new FileAccessRequestStore(freshHome(), "codex").markConsumed(REQUEST_ID)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("keeps each agent's requests apart", async () => {
    const home = freshHome()
    await new FileAccessRequestStore(home, "codex").save(request)
    expect(await new FileAccessRequestStore(home, "claude-code").load(REQUEST_ID)).toBeUndefined()
  })
})
