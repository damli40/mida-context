import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { buildOwnerLink } from "@mida/protocol"
import { openOwnerLink } from "../src/owner-link/open.js"

/**
 * Opening the page always prints first — the full link, the pairing code, the warning — then
 * tries `open`/`xdg-open`. A failed spawn is not an error: the owner can paste the link.
 */

const LINK = buildOwnerLink({
  origin: "https://app.midacontext.xyz",
  flow: "approve",
  req: { chainId: 10143, owner: "0x1234567890abcdef1234567890abcdef12345678", request: { v: 1 } },
  nonce: "0123456789abcdef",
  port: 8021,
})

function fakeSpawn(behavior: "ok" | "error" | "exit1") {
  const calls: { command: string; args: string[] }[] = []
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args })
    const child = new EventEmitter()
    queueMicrotask(() => {
      if (behavior === "error") child.emit("error", new Error("spawn xdg-open ENOENT"))
      else child.emit("close", behavior === "ok" ? 0 : 1)
    })
    return child as never
  }
  return { calls, spawn }
}

describe("openOwnerLink", () => {
  it("prints the full link, the pairing code, then the warning — before any spawn", async () => {
    const lines: string[] = []
    const { spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: (l) => lines.push(l), spawn, platform: "darwin" })
    expect(lines).toEqual([
      LINK.url,
      `pairing code: ${"satin cabin hedge 62"}`,
      "Only approve if the page shows this same code.",
    ])
  })

  it("on macOS spawns `open <url>`", async () => {
    const { calls, spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: () => {}, spawn, platform: "darwin" })
    expect(calls).toEqual([{ command: "open", args: [LINK.url] }])
  })

  it("on Linux spawns `xdg-open <url>`", async () => {
    const { calls, spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: () => {}, spawn, platform: "linux" })
    expect(calls).toEqual([{ command: "xdg-open", args: [LINK.url] }])
  })

  it("on any other platform it prints the link and spawns nothing", async () => {
    const lines: string[] = []
    const { calls, spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: (l) => lines.push(l), spawn, platform: "win32" })
    expect(calls).toEqual([])
    expect(lines[0]).toBe(LINK.url)
  })

  it("a spawn that fails prints the fallback line and does not throw", async () => {
    const lines: string[] = []
    const { spawn } = fakeSpawn("error")
    await openOwnerLink(LINK, { print: (l) => lines.push(l), spawn, platform: "linux" })
    expect(lines.at(-1)).toBe("Could not open a browser — open the link above yourself.")
  })

  it("a non-zero exit also falls back to print-only", async () => {
    const lines: string[] = []
    const { spawn } = fakeSpawn("exit1")
    await openOwnerLink(LINK, { print: (l) => lines.push(l), spawn, platform: "darwin" })
    expect(lines.at(-1)).toBe("Could not open a browser — open the link above yourself.")
  })
})
