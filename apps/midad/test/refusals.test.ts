import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseError } from "viem"
import { MidaError } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { REQUEST_LIFETIME_SECONDS } from "@mida/sdk"
import { MidaHome, historyCursor, ownerRefusalLine } from "@mida/midad"

/**
 * R4-5 — a coded refusal with an obvious next step prints a plain line that names it; every
 * other code keeps `refused: <code>` and a code-less error is named (`UNEXPECTED`, or
 * `CHAIN_CALL_FAILED` for a chain error) — never the word ERROR (CHAIN-09). A message from a
 * deeper layer is never echoed — except OWNER_WALLET_LOW, whose message we built.
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
    // from `approve` the line must never say "run mida approve" — that is the command just run (M3-D4)
    expect(ownerRefusalLine("approve", "codex", coded("already-approved"))).toBe("codex is already approved on chain")
    // from `request` the next step really is `approve`: it adds THIS folder with no transaction
    expect(ownerRefusalLine("request", "codex", coded("already-approved"))).toBe(
      "codex is already approved on chain. To use it in THIS folder, run `mida approve codex` here (no transaction, nothing to pay).",
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

  it("SPONSOR_PENDING names the operation and points at a re-run that tells the truth", () => {
    // The sponsored call was ACCEPTED — the message must never pretend nothing happened, and a
    // re-run of approve/revoke/init detects the landed work instead of sending a second copy.
    const error = new MidaError("SPONSOR_PENDING", "inner detail never shown") as MidaError & { userOpHash: Hex }
    error.userOpHash = `0x${"5a".repeat(32)}`
    for (const command of ["approve", "revoke", "init"]) {
      const line = ownerRefusalLine(command, "codex", error)
      expect(line).toContain("0x5a5a5a5a…") // the operation hash, first 10 chars + ellipsis
      expect(line).toContain("run the same command again")
      expect(line).toContain("nothing was sent from your wallet")
      expect(line).not.toContain("inner detail") // a deeper message is never echoed
    }
  })

  it("SPONSOR_PENDING on remember does not promise a blind re-run — a second fact would be written", () => {
    const error = new MidaError("SPONSOR_PENDING", "inner detail never shown") as MidaError & { userOpHash: Hex }
    error.userOpHash = `0x${"5a".repeat(32)}`
    const line = ownerRefusalLine("remember", "", error)
    expect(line).toContain("0x5a5a5a5a…")
    expect(line).toContain("mida read --as assistant")
    expect(line).not.toContain("run the same command again")
  })

  it("an unknown code keeps `refused: <code>` and a code-less error is named, never ERROR (CHAIN-09)", () => {
    expect(ownerRefusalLine("approve", "codex", coded("SOMETHING_NEW"))).toBe("refused: SOMETHING_NEW")
    expect(ownerRefusalLine("approve", "codex", new Error("a message that is never echoed"))).toBe("refused: UNEXPECTED")
    expect(ownerRefusalLine("approve", "codex", "not even an error")).toBe("refused: UNEXPECTED")
  })

  it("a coded CHAIN_CALL_FAILED names the setup's contract and the debug flag (CHAIN-09)", () => {
    const line = ownerRefusalLine(
      "approve",
      "codex",
      coded("CHAIN_CALL_FAILED"),
      undefined,
      "0xf07d000000000000000000000000000000000042",
    )
    expect(line).toBe("the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why")
    expect(line).not.toContain("ERROR")
    expect(line).not.toContain("boom")
  })

  it("a bare viem failure — the chain could not be asked — is the busy line, never an authorization answer (in-6 R4)", () => {
    const line = ownerRefusalLine(
      "approve",
      "codex",
      new BaseError("boom"),
      undefined,
      "0xf07d000000000000000000000000000000000042",
    )
    expect(line).toBe("Monad is busy right now — nothing was sent or decided; wait a moment and run the same command again")
    expect(line).not.toContain("boom")
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
