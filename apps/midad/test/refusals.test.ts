import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { REQUEST_LIFETIME_SECONDS } from "@mida/sdk"
import { MidaHome, historyCursor, ownerRefusalLine } from "@mida/midad"

/**
 * R4-5 — a coded refusal with an obvious next step prints a plain line that names it; every
 * other code keeps `refused: <code>` and a code-less error keeps `refused: ERROR`. A message
 * from a deeper layer is never echoed — except OWNER_WALLET_LOW, whose message we built.
 */

const coded = (code: string, message = "inner detail never shown"): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

describe("ownerRefusalLine (R4-5)", () => {
  it("an expired request tells the owner how long a request lasts and what to run next", () => {
    const line = ownerRefusalLine("approve", "codex", coded("REQUEST_EXPIRED"))
    // the real lifetime — five minutes, from the constant, never a hardcoded number
    expect(line).toBe(
      `codex's request has expired (a request lasts ${Number(REQUEST_LIFETIME_SECONDS) / 60} minutes): run \`mida request codex\` and approve again`,
    )
  })

  it("an agent the chain already approves gets the this-folder line, not refused: ERROR", () => {
    expect(ownerRefusalLine("approve", "codex", coded("already-approved"))).toBe(
      "codex is already approved. To let it use THIS folder too, run `mida approve codex` here (no transaction, nothing to pay).",
    )
    expect(ownerRefusalLine("request", "codex", coded("already-approved"))).toBe(
      "codex is already approved. To let it use THIS folder too, run `mida approve codex` here (no transaction, nothing to pay).",
    )
  })

  it("the other owner-facing codes each name their next step", () => {
    expect(ownerRefusalLine("approve", "codex", coded("no-pending-request"))).toBe(
      "codex has no pending request — run `mida request codex` first",
    )
    for (const code of ["agent-unidentified", "agent-not-setup"]) {
      expect(ownerRefusalLine("revoke", "codex", coded(code))).toBe(
        "codex is not set up on this machine — run `mida init` first",
      )
    }
    expect(ownerRefusalLine("approve", "codex", coded("not-a-project"))).toBe(
      "this folder cannot hold a project — run `mida approve codex` inside the project's folder",
    )
    expect(ownerRefusalLine("approve", "codex", coded("list-unreadable"))).toBe(
      "the approved-projects list could not be read — check the file's permissions",
    )
  })

  it("the owner declining the ask still prints 'not approved'", () => {
    expect(ownerRefusalLine("approve", "codex", coded("not-approved"))).toBe("not approved")
  })

  it("OWNER_WALLET_LOW prints its own message — the balance, the cost and the shortfall", () => {
    const line = ownerRefusalLine(
      "approve",
      "codex",
      new MidaError("OWNER_WALLET_LOW", "your wallet holds 0.0500 MON but this transaction needs 0.0832 MON — 0.0332 MON short"),
    )
    expect(line).toBe("your wallet holds 0.0500 MON but this transaction needs 0.0832 MON — 0.0332 MON short")
  })

  it("an unknown code keeps `refused: <code>` and a code-less error keeps `refused: ERROR`", () => {
    expect(ownerRefusalLine("approve", "codex", coded("SOMETHING_NEW"))).toBe("refused: SOMETHING_NEW")
    expect(ownerRefusalLine("approve", "codex", new Error("a message that is never echoed"))).toBe("refused: ERROR")
    expect(ownerRefusalLine("approve", "codex", "not even an error")).toBe("refused: ERROR")
  })
})

/**
 * R4-9 — the on-disk history cursor: `state/history/<agentId>.json` records where the last
 * successful scan ended, keyed on chain id and registry. Anything that does not match, or
 * cannot be read, answers undefined — a full scan, never a guess.
 */
describe("historyCursor (R4-9)", () => {
  const home = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-history-")))
  const AGENT: Hex = `0x${"aa".repeat(32)}`
  const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3"

  it("a saved cursor round-trips: same chain, same registry, same position", async () => {
    const h = home()
    const cursor = historyCursor(h, AGENT, 10143n, REGISTRY)
    await cursor.save({ observedThroughBlock: 123_456n, previouslyRevoked: true })
    expect(await cursor.load()).toEqual({ observedThroughBlock: 123_456n, previouslyRevoked: true })
    expect(h.path(`state/history/${AGENT}.json`)).toContain("state/history")
  })

  it("a missing file, a malformed file and nonsense values all answer undefined", async () => {
    const h = home()
    const cursor = historyCursor(h, AGENT, 10143n, REGISTRY)
    expect(await cursor.load()).toBeUndefined()
    const file = `state/history/${AGENT}.json`
    mkdirSync(join(h.root, "state/history"), { recursive: true })
    for (const junk of ["not json", "[]", '{"chainId":10143}', '{"chainId":"10143","registry":"0x5fbdb2315678afecb367f032d93f642f64180aa3","observedThroughBlock":"oops"}']) {
      writeFileSync(h.path(file), junk)
      expect(await cursor.load(), junk).toBeUndefined()
    }
  })

  it("a cursor from a different chain id or a different registry is ignored", async () => {
    const h = home()
    const cursor = historyCursor(h, AGENT, 10143n, REGISTRY)
    await cursor.save({ observedThroughBlock: 50n, previouslyRevoked: false })
    expect(await historyCursor(h, AGENT, 31337n, REGISTRY).load()).toBeUndefined()
    expect(await historyCursor(h, AGENT, 10143n, "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512").load()).toBeUndefined()
    // the registry comparison is case-insensitive — addresses may be checksummed on disk
    expect(await historyCursor(h, AGENT, 10143n, "0x5FbDB2315678afecb367f032d93f642f64180aa3").load()).toEqual({
      observedThroughBlock: 50n,
      previouslyRevoked: false,
    })
  })
})
