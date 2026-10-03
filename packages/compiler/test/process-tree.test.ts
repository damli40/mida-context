import { describe, expect, it } from "vitest"
import { killProcessTree } from "../src/process-tree.js"

describe("killProcessTree", () => {
  it("on Windows calls taskkill by its System32 path and takes the children with it, and cannot hang", () => {
    const calls: unknown[][] = []
    killProcessTree(321, { platform: "win32", spawnSync: ((...a: unknown[]) => { calls.push(a); return { status: 0 } }) as never })
    expect(calls[0]![0]).toBe(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`)
    expect(calls[0]![1]).toEqual(["/pid", "321", "/T", "/F"])
    // a wedged taskkill is abandoned after five seconds so the caller can kill the direct child
    expect(calls[0]![2]).toEqual({ stdio: "ignore", windowsHide: true, timeout: 5000 })
  })

  it("a taskkill that cannot run throws, so the caller falls back to the direct child", () => {
    const run = (() => ({ error: new Error("ENOENT"), status: null })) as never
    expect(() => killProcessTree(321, { platform: "win32", spawnSync: run })).toThrow("ENOENT")
  })

  it("a taskkill exit code other than 0 or 128 throws for the same fallback", () => {
    const run = (() => ({ status: 1 })) as never
    expect(() => killProcessTree(321, { platform: "win32", spawnSync: run })).toThrow("taskkill exited 1")
  })

  it("exit 0 and 128 (the pid was already gone) are both success", () => {
    expect(() => killProcessTree(321, { platform: "win32", spawnSync: (() => ({ status: 0 })) as never })).not.toThrow()
    expect(() => killProcessTree(321, { platform: "win32", spawnSync: (() => ({ status: 128 })) as never })).not.toThrow()
  })

  it("signals the negative pid (the process group) on Mac and Linux", () => {
    const calls: [number, string][] = []
    killProcessTree(321, { platform: "darwin", kill: (pid, signal) => calls.push([pid, signal]) })
    expect(calls).toEqual([[-321, "SIGKILL"]])
  })
})
