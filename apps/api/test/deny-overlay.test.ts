import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Address, Hex } from "@mida/protocol"
import { DenyOverlay } from "@mida/api"

const OWNER = "0x1111111111111111111111111111111111111111" as Address
const AGENT = `0x${"22".repeat(32)}` as Hex
const CAPABILITY = `0x${"33".repeat(32)}` as Hex

const file = () => join(mkdtempSync(join(tmpdir(), "mida-deny-")), "revocations.json")

describe("DenyOverlay persistence (§12.5)", () => {
  it("starts empty only when the file does not exist", async () => {
    const overlay = new DenyOverlay(file())
    expect(await overlay.list()).toEqual([])
    expect(await overlay.denies({ owner: OWNER, agentId: AGENT, capabilityId: CAPABILITY })).toBe(false)
  })

  it("fails closed on a corrupt file instead of silently dropping pending denies", () => {
    const path = file()
    writeFileSync(path, "{ not json")
    expect(() => new DenyOverlay(path)).toThrow()
  })

  it("fails closed on JSON that is not a revocation intent array", () => {
    const scalar = file()
    writeFileSync(scalar, "42")
    expect(() => new DenyOverlay(scalar)).toThrow(/revocation intent/)
    const malformed = file()
    writeFileSync(malformed, JSON.stringify([{ id: 7, state: "active" }]))
    expect(() => new DenyOverlay(malformed)).toThrow(/revocation intent/)
  })

  it("still denies an active intent after a clean reload", async () => {
    const path = file()
    const intent = await new DenyOverlay(path).create(OWNER, { kind: "agent", agentId: AGENT }, 4n)
    const reloaded = new DenyOverlay(path)
    expect((await reloaded.list()).map((candidate) => candidate.id)).toEqual([intent.id])
    expect(await reloaded.denies({ owner: OWNER, agentId: AGENT, capabilityId: CAPABILITY })).toBe(true)
  })

  it("reconcileOwner reads the chain only for the caller's intents", async () => {
    const other = "0x9999999999999999999999999999999999999999" as Address
    const overlay = new DenyOverlay(file())
    const mine = await overlay.create(OWNER, { kind: "agent", agentId: AGENT }, 4n)
    const theirs = await overlay.create(other, { kind: "capability", capabilityId: CAPABILITY }, null)

    const reads: string[] = []
    const reader = {
      getCapability: async (capabilityId: Hex) => {
        reads.push(`capability:${capabilityId}`)
        return { revoked: true }
      },
      agentEpoch: async (owner: Address, agentId: Hex) => {
        reads.push(`epoch:${owner}:${agentId}`)
        return 9n
      },
    }
    await overlay.reconcileOwner(reader as never, OWNER)
    // The caller's deny anchored on the epoch advance; the other owner's was never even read.
    expect(reads).toEqual([`epoch:${OWNER.toLowerCase()}:${AGENT}`])
    const intents = await overlay.list()
    expect(intents.find((intent) => intent.id === mine.id)?.state).toBe("anchored")
    expect(intents.find((intent) => intent.id === theirs.id)?.state).toBe("active")
  })
})
