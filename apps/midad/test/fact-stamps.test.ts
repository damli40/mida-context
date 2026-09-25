import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey } from "viem/accounts"
import { OWNER_AUTHOR_ID, PROVENANCE_SOURCE } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import type { ContextObject } from "@mida/sdk"
import { MidaHome, buildHandoff, runCliWithRuntime } from "@mida/midad"
import type { HandoffDeps, ProjectCheck, ServiceRuntime } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"
import type { StoredCheckpoint } from "@mida/checkpoint"

/**
 * in-4 I8 — every fact an agent or the owner sees names itself: the first 8 hex characters of its
 * context id (what `mida remember --replaces` later takes as its target) and the date Monad
 * stamped on the record, "YYYY-MM-DD HH:MM UTC". Never the full 64-hex id, never a
 * payload-claimed time. The fixtures below reuse the fake-runtime shape remember.test.ts built:
 * objects are served whole, the chain record answers only the three fields the fact filter
 * reads — author, provenance and createdAt.
 */
const CHAIN_SECONDS = 1_758_000_000n // the fake record's createdAt → 2025-09-16T05:20:00Z
const STAMP = "2025-09-16 05:20 UTC"
const FACT_ID = `0x${"66".repeat(32)}` as Hex // short id: 66666666

const factObject = (text: string, contextId: Hex): ContextObject => ({
  contextId,
  owner: `0x${"55".repeat(20)}`,
  namespace: "preferences.communication",
  namespaceId: `0x${"77".repeat(32)}` as Hex,
  authorId: OWNER_AUTHOR_ID,
  lineageId: `0x${"99".repeat(32)}` as Hex,
  parentId: `0x${"00".repeat(32)}` as Hex,
  version: 1,
  readEpoch: 1n,
  recordType: "CONTEXT",
  payload: {
    v: 1,
    kind: "PREFERENCE",
    provenance: { source: "USER_ASSERTED" },
    value: { text, assertedAt: "2026-09-18T10:00:00.000Z" },
  },
})

const stampHome = () => {
  const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-stamps-")))
  for (const name of ["claude-code", "codex"]) {
    home.writeSecretJson(`agents/${name}/identity.json`, {
      name,
      agentId: `0x${"aa".repeat(32)}`,
      signerPrivateKey: generatePrivateKey(),
      encryptionPrivateKey: `0x${"11".repeat(32)}`,
      encryptionPublicKey: `0x${"22".repeat(32)}`,
      callbackOrigin: "https://agent.test",
      purposeId: "project_assistance",
      manifest: { v: 1 },
      manifestHash: `0x${"33".repeat(32)}`,
    })
  }
  return home
}

/** A runtime that serves the given objects in preferences.communication and a record for each. */
const factRuntime = (objects: ContextObject[]): ServiceRuntime =>
  ({
    home: stampHome(),
    owner: `0x${"55".repeat(20)}`,
    agent: () => ({
      read: async (_owner: string, namespace: string) => (namespace === "preferences.communication" ? objects : []),
    }),
    reader: {
      getRecord: async () => ({
        author: OWNER_AUTHOR_ID,
        provenanceSource: PROVENANCE_SOURCE.USER_ASSERTED,
        createdAt: CHAIN_SECONDS,
        parentId: `0x${"00".repeat(32)}`,
      }),
    },
  }) as unknown as ServiceRuntime

describe("fact ids and chain dates (in-4 I8)", () => {
  it("mida read --as names every fact by short id and chain date", async () => {
    const runtime = factRuntime([factObject("answers in lowercase", FACT_ID)])
    const lines: string[] = []
    expect(await runCliWithRuntime(["read", "--as", "claude-code", "preferences.communication"], runtime, (line) => lines.push(line))).toBe(0)
    expect(lines).toContain("What you have told Mida about yourself")
    // the first 8 hex characters of the context id, then the record's chain stamp — never the
    // full 64-hex id, never the payload's own assertedAt claim (2026-09-18)
    expect(lines).toContain(`  preferences.communication: answers in lowercase (id 66666666, ${STAMP})`)
  })

  it("the handoff's fact block carries the same stamp in place of the full record id", async () => {
    const runtime = { home: stampHome() } as unknown as ServiceRuntime
    const approval: ProjectCheck = {
      ok: true,
      approval: { agent: "codex", projectId: "p1", root: "/tmp/work", approvedAt: "2026-09-21T00:00:00.000Z" },
    }
    const stored: StoredCheckpoint = {
      checkpoint: sampleCheckpoint({ eventId: "cp-stamps-01", objective: "hand off with a fact", nextAction: "read it" }),
      projectId: "p1",
      sessionId: "s1",
      continuesSession: null,
      compiledBy: "test",
      contextId: `0x${"1".repeat(64)}`,
      authorId: `0x${"a".repeat(64)}`,
      namespaceId: `0x${"2".repeat(64)}`,
    }
    const deps: HandoffDeps = {
      checkProject: async () => approval,
      capability: async () => "live",
      read: async () => ({ checkpoints: [stored], skipped: 0, milliseconds: 1, partial: false }),
      readFacts: async () => [{ text: "answers in lowercase", contextId: FACT_ID, namespace: "preferences.communication", assertedAt: "2025-09-16T05:20:00.000Z" }],
      isRevoked: () => false,
    }
    const result = await buildHandoff(runtime, { agent: "codex", cwd: "/tmp/work", authorNames: {} }, deps)
    expect(result.kind).toBe("handoff")
    if (result.kind !== "handoff") return
    expect(result.text).toContain("What you have told Mida about yourself")
    expect(result.text).toContain(`- stated by you: answers in lowercase (id 66666666, ${STAMP})`)
    expect(result.text).not.toContain(`(record ${FACT_ID})`)
  })
})
