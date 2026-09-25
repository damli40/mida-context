import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OWNER_AUTHOR_ID, PROVENANCE_SOURCE, namespaceId } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { zeroHash } from "viem"
import { MidaHome, NEEDS_TERMINAL_LINE, ownerOnlyLine, resolveFactId, runCli, runCliWithRuntime } from "@mida/midad"
import type { FactNamespace, Runtime, ServiceRuntime } from "@mida/midad"

/**
 * in-4 I9 — `resolveFactId` answers what `mida remember --replaces <short-id>` will write against,
 * before the owner is asked to confirm. A short id is the first 8 hex characters printed by
 * `mida read --as`; matching is case-insensitive over the owner-authored USER_ASSERTED records in
 * the two fact namespaces. Zero matches and more-than-one are different refusals — and a fact
 * that is already replaced is refused rather than re-superseded (the chain would answer
 * StaleParent, which names nothing the owner can act on).
 * The fake runtime serves records directly: chain truth (author, provenance, parent) is what
 * decides, never the object payload.
 */
interface FakeRecord {
  contextId: Hex
  parentId?: Hex
  /** Defaults to an owner fact — set to flip the record out of the fact set. */
  author?: Hex
  provenanceSource?: number
}

const FACT = `0x${"ab".repeat(32)}` as Hex

const factRuntime = (
  byNamespace: Partial<Record<FactNamespace, FakeRecord[]>>,
  opts: { partial?: boolean } = {},
): Runtime => {
  const records = new Map<string, { contextId: Hex; author: Hex; provenanceSource: number; parentId: Hex }>()
  for (const records_ of Object.values(byNamespace)) {
    for (const record of records_ ?? []) {
      records.set(record.contextId.toLowerCase(), {
        contextId: record.contextId,
        author: record.author ?? OWNER_AUTHOR_ID,
        provenanceSource: record.provenanceSource ?? PROVENANCE_SOURCE.USER_ASSERTED,
        parentId: record.parentId ?? zeroHash,
      })
    }
  }
  return {
    owner: `0x${"55".repeat(20)}`,
    ownerApi: {
      listObjects: async (input: { namespaceId: Hex }) => {
        const namespace = (Object.entries(byNamespace) as [FactNamespace, FakeRecord[]][]).find(
          ([name]) => namespaceId(name) === input.namespaceId,
        )
        return { objects: (namespace?.[1] ?? []).map((record) => ({ contextId: record.contextId })), partial: opts.partial === true }
      },
    },
    reader: {
      getRecords: async (ids: readonly Hex[]) => ids.map((id) => records.get(id.toLowerCase()) ?? null),
    },
  } as unknown as Runtime
}

describe("resolveFactId", () => {
  it("a unique prefix resolves to the fact's context id and its own namespace", async () => {
    const runtime = factRuntime({ "profile.skills": [{ contextId: FACT }] })
    // matching is case-insensitive and only needs a prefix — even a short one, while it is unique
    for (const id of ["ABAB", "abababab", "ab"]) {
      expect(await resolveFactId(runtime, id)).toEqual({ kind: "ok", contextId: FACT, namespace: "profile.skills" })
    }
    // a leading 0x is accepted — it is how the id is often pasted
    expect(await resolveFactId(runtime, "0xabababab")).toEqual({ kind: "ok", contextId: FACT, namespace: "profile.skills" })
  })

  it("an id that names no fact refuses unknown-fact-id", async () => {
    const runtime = factRuntime({ "preferences.communication": [{ contextId: FACT }] })
    const resolved = await resolveFactId(runtime, "deadbeef")
    expect(resolved.kind).toBe("refused")
    if (resolved.kind !== "refused") return
    expect(resolved.code).toBe("unknown-fact-id")
  })

  it("an id that names more than one fact refuses ambiguous-fact-id", async () => {
    // two facts whose context ids share their first 8 hex characters — the shortest prefix that
    // cannot be made unique is refused rather than resolved by luck
    const a = `0xabcd1234${"0".repeat(56)}` as Hex
    const b = `0xabcd1234${"f".repeat(56)}` as Hex
    const runtime = factRuntime({ "preferences.communication": [{ contextId: a }], "profile.skills": [{ contextId: b }] })
    const resolved = await resolveFactId(runtime, "abcd1234")
    expect(resolved.kind).toBe("refused")
    if (resolved.kind !== "refused") return
    expect(resolved.code).toBe("ambiguous-fact-id")
  })

  it("anything that is not hex refuses bad-fact-id", async () => {
    const runtime = factRuntime({ "preferences.communication": [{ contextId: FACT }] })
    for (const id of ["", "python", "0xzz", "ab cd"]) {
      const resolved = await resolveFactId(runtime, id)
      expect(resolved.kind).toBe("refused")
      if (resolved.kind !== "refused") continue
      expect(resolved.code).toBe("bad-fact-id")
    }
  })

  it("a fact that was already replaced refuses fact-already-replaced — it is history", async () => {
    const child = `0x${"cd".repeat(32)}` as Hex
    const runtime = factRuntime({
      "preferences.communication": [{ contextId: FACT }, { contextId: child, parentId: FACT }],
    })
    const resolved = await resolveFactId(runtime, "abababab")
    expect(resolved.kind).toBe("refused")
    if (resolved.kind !== "refused") return
    expect(resolved.code).toBe("fact-already-replaced")
    // the child — the lineage head — still resolves fine
    expect(await resolveFactId(runtime, "cdcdcdcd")).toEqual({ kind: "ok", contextId: child, namespace: "preferences.communication" })
  })

  it("a store list it could not fully verify refuses list-incomplete — never resolves half a set", async () => {
    const runtime = factRuntime({ "preferences.communication": [{ contextId: FACT }] }, { partial: true })
    const resolved = await resolveFactId(runtime, "abababab")
    expect(resolved.kind).toBe("refused")
    if (resolved.kind !== "refused") return
    expect(resolved.code).toBe("list-incomplete")
  })

  it("records the chain does not attribute to the owner — or to USER_ASSERTED — are not replaceable facts", async () => {
    const agentWritten = `0x${"ee".repeat(32)}` as Hex
    const confirmed = `0x${"cc".repeat(32)}` as Hex
    const runtime = factRuntime({
      "preferences.communication": [
        { contextId: agentWritten, author: `0x${"42".repeat(32)}` as Hex },
        { contextId: confirmed, provenanceSource: PROVENANCE_SOURCE.USER_CONFIRMED },
      ],
    })
    for (const id of ["eeeeeeee", "cccccccc"]) {
      const resolved = await resolveFactId(runtime, id)
      expect(resolved.kind).toBe("refused")
      if (resolved.kind !== "refused") continue
      expect(resolved.code).toBe("unknown-fact-id")
    }
  })
})

describe("the --replaces gate itself", () => {
  it("inside an agent the command is the owner-command refusal — same rule as plain remember", async () => {
    const runtime = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-replace-"))) } as unknown as ServiceRuntime
    const lines: string[] = []
    expect(await runCliWithRuntime(["remember", "--replaces", "abcd1234", "a new fact"], runtime, (line) => lines.push(line))).toBe(2)
    expect(lines).toEqual([ownerOnlyLine("remember")])
  })

  it("without a real terminal it answers needs-terminal before anything else", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-replace-")))
    const lines: string[] = []
    for (const stdinIsTTY of [false, true]) {
      lines.length = 0
      const code = await runCli(["remember", "--replaces", "abcd1234", "a new fact"], {
        home,
        network: {} as never,
        print: (line) => lines.push(line),
        prompt: async () => "yes",
        stdinIsTTY,
        stdoutIsTTY: false,
      })
      expect(code).toBe(2)
      expect(lines).toEqual([NEEDS_TERMINAL_LINE])
    }
  })
})
