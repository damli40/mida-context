import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
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

function fakeSpawn(behavior: "ok" | "error" | "exit1" | "hang") {
  const calls: { command: string; args: string[]; options?: unknown }[] = []
  const spawn = (command: string, args: string[], options?: unknown) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    queueMicrotask(() => {
      if (behavior === "hang") return
      if (behavior === "error") child.emit("error", new Error("spawn xdg-open ENOENT"))
      else {
        child.emit("exit", behavior === "ok" ? 0 : 1)
        child.emit("close", behavior === "ok" ? 0 : 1)
      }
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
    expect(calls).toEqual([{ command: "open", args: [LINK.url], options: { stdio: "ignore" } }])
  })

  it("on Linux spawns `xdg-open <url>`", async () => {
    const { calls, spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: () => {}, spawn, platform: "linux" })
    expect(calls).toEqual([{ command: "xdg-open", args: [LINK.url], options: { stdio: "ignore" } }])
  })

  it("on Windows opens the link with rundll32 by its full System32 path", async () => {
    // a bare name resolves against the current folder first on Windows, and a rundll32.exe
    // planted in a cloned project would run instead
    const root = process.env.SystemRoot
    process.env.SystemRoot = "D:\\WinDir"
    try {
      const { calls, spawn } = fakeSpawn("ok")
      await openOwnerLink(LINK, { print: () => {}, spawn, platform: "win32" })
      expect(calls).toEqual([{ command: "D:\\WinDir\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", LINK.url], options: { stdio: "ignore" } }])
    } finally {
      if (root === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = root
    }
  })

  it("without SystemRoot the rundll32 path defaults under C:\\Windows", async () => {
    const root = process.env.SystemRoot
    delete process.env.SystemRoot
    try {
      const { calls, spawn } = fakeSpawn("ok")
      await openOwnerLink(LINK, { print: () => {}, spawn, platform: "win32" })
      expect(calls).toEqual([{ command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", LINK.url], options: { stdio: "ignore" } }])
    } finally {
      if (root !== undefined) process.env.SystemRoot = root
    }
  })

  it("on any other platform it prints the link and spawns nothing", async () => {
    const lines: string[] = []
    const { calls, spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: (l) => lines.push(l), spawn, platform: "freebsd" })
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

  it("the opener is spawned with its own stdio ignored", async () => {
    const { calls, spawn } = fakeSpawn("ok")
    await openOwnerLink(LINK, { print: () => {}, spawn, platform: "darwin" })
    expect(calls[0]!.options).toEqual({ stdio: "ignore" })
  })

  it("an opener that never exits resolves anyway after five seconds", async () => {
    // the browser may keep running after it takes the link; approve must not wait on it
    vi.useFakeTimers()
    try {
      const { spawn } = fakeSpawn("hang")
      let resolved = false
      const opened = openOwnerLink(LINK, { print: () => {}, spawn, platform: "darwin" }).then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(4999)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await opened
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("only https links open: a file or http link is printed but spawns nothing", async () => {
    const lines: string[] = []
    const { calls, spawn } = fakeSpawn("ok")
    const fileLink = { ...LINK, url: "file:///etc/passwd" }
    const httpLink = { ...LINK, url: "http://example.com/x" }
    await openOwnerLink(fileLink, { print: (l) => lines.push(l), spawn, platform: "darwin" })
    await openOwnerLink(httpLink, { print: (l) => lines.push(l), spawn, platform: "linux" })
    expect(calls).toEqual([])
    // the link still printed for the owner to open by hand
    expect(lines).toContain("file:///etc/passwd")
    expect(lines).toContain("http://example.com/x")
  })
})
