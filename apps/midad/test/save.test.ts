import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { MidaHome, saveCheckpoint } from "@mida/midad"
import type { Runtime } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const OWNER = `0x${"11".repeat(20)}` as const
const CONTEXT_ID = `0x${"cc".repeat(32)}` as const

const input = {
  projectId: "p-1",
  sessionId: "s1",
  continuesSession: null,
  compiledBy: "stub",
  checkpoint: sampleCheckpoint({ eventId: "cp-save0001" }),
}

/** A Runtime-shaped stub: saveCheckpoint only needs owner, home and agent(name). */
function fakeRuntime(home: MidaHome, agent: { findDuplicate: () => Promise<Hex | undefined>; create: () => Promise<{ contextId: Hex; transactionHash: Hex | null }> }): Runtime {
  return {
    home,
    owner: OWNER,
    agent: () => agent,
  } as unknown as Runtime
}

describe("saveCheckpoint duplicate detection", () => {
  it("a saved-ids index hit answers duplicate without any chain read", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-save-")))
    let checks = 0
    let creates = 0
    const runtime = fakeRuntime(home, {
      findDuplicate: async () => {
        checks += 1
        return undefined
      },
      create: async () => {
        creates += 1
        return { contextId: CONTEXT_ID, transactionHash: `0x${"dd".repeat(32)}` as Hex }
      },
    })
    const first = await saveCheckpoint(runtime, "claude-code", input)
    expect(first.duplicate).toBe(false)
    expect(checks).toBe(1)
    expect(creates).toBe(1)

    const second = await saveCheckpoint(runtime, "claude-code", input)
    expect(second.duplicate).toBe(true)
    expect(second.contextId).toBe(CONTEXT_ID)
    expect(checks).toBe(1)   // the index answered — the namespace was never checked again
    expect(creates).toBe(1)
  })

  it("a duplicate check that fails with an ordinary error rejects — it must not pretend empty", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-save-")))
    let creates = 0
    const runtime = fakeRuntime(home, {
      findDuplicate: async () => {
        throw new Error("rpc unreachable")
      },
      create: async () => {
        creates += 1
        return { contextId: CONTEXT_ID, transactionHash: null }
      },
    })
    await expect(saveCheckpoint(runtime, "claude-code", input)).rejects.toThrow("rpc unreachable")
    expect(creates).toBe(0)
  })

  it("a genuine no-READ-permission denial proceeds to create", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-save-")))
    let creates = 0
    const runtime = fakeRuntime(home, {
      findDuplicate: async () => {
        throw new MidaError("CAPABILITY_DENIED", "no read")
      },
      create: async () => {
        creates += 1
        return { contextId: CONTEXT_ID, transactionHash: `0x${"ee".repeat(32)}` as Hex }
      },
    })
    const result = await saveCheckpoint(runtime, "claude-code", input)
    expect(result.duplicate).toBe(false)
    expect(result.contextId).toBe(CONTEXT_ID)
    expect(creates).toBe(1)
  })
})
