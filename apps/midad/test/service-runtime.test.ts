import { afterAll, describe, expect, it } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { MidaHome, ServiceRuntime } from "@mida/midad"
import type { Network } from "@mida/midad"
import { lockHolder, processProbeFor, windowsProcessProbe } from "../src/runtime.js"

/**
 * The daemon's runtime carries no owner key. These tests run with no chain: the refusal happens
 * before any chain call, and the open itself only binds a local API server.
 */
const DEPLOYMENT = {
  chainId: 31337n,
  capabilityRegistry: "0x0000000000000000000000000000000000000001",
  contextRegistry: "0x0000000000000000000000000000000000000002",
  deploymentBlock: 0n,
  policyHashV1: `0x${"00".repeat(32)}`,
  vaultRpId: "test.local",
  vaultRpIdHash: `0x${"00".repeat(32)}`,
} as const
const network: Network = { rpcUrl: "http://127.0.0.1:1", deployment: DEPLOYMENT as never, fund: async () => {} }
const OWNER = "0x1111111111111111111111111111111111111111"

const freshHome = () => new MidaHome(mkdtempSync(join(tmpdir(), "mida-svc-")))

/**
 * What `ps -o lstart= -p <pid>` prints for a live pid under LC_ALL=C TZ=UTC — the exact string a
 * lock writer stores in `started`. A test spawns the child and only ever kills what it spawned.
 */
const lstartOf = (pid: number): string | undefined => {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
  if (ps.error !== undefined || ps.status !== 0) return undefined
  const out = ps.stdout.trim()
  return out === "" ? undefined : out
}

describe("ServiceRuntime — the daemon's runtime", () => {
  it("refuses to open when owner-address.json is missing, with one line telling the user to run mida init", async () => {
    const home = freshHome()
    await expect(ServiceRuntime.open(home, network)).rejects.toThrow(/mida init/)
    // refused before the lock was ever taken
    expect(home.has("midad.lock")).toBe(false)
  })

  it("opens on the public owner address alone — the owner secret file is never read or created", async () => {
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const runtime = await ServiceRuntime.open(home, network)
    try {
      expect(runtime.owner).toBe(OWNER)
      expect(home.has("owner/secrets.json")).toBe(false)
      // no owner-signing member exists on the type — a compile-time fact, exercised here as data
      for (const member of ["vault", "ownerChain", "ownerApi", "ensureFunded", "attach"] as const) {
        expect(member in runtime, member).toBe(false)
      }
      // while the daemon runs, the owner CLI finds its Context API through api-url.json
      const published = JSON.parse(readFileSync(home.path("api-url.json"), "utf8")) as { baseUrl?: string }
      expect(published.baseUrl).toBe(runtime.apiBaseUrl)
    } finally {
      await runtime.close()
    }
    expect(home.has("midad.lock")).toBe(false)
    expect(home.has("api-url.json")).toBe(false)
  })

  it("an agent() call rebuilds from disk every time, so a grant written after open is seen at once", async () => {
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const runtime = await ServiceRuntime.open(home, network)
    try {
      // no identity on disk — the error is the same one the owner runtime gives
      expect(() => runtime.agent("codex")).toThrow(/run init first/)
    } finally {
      await runtime.close()
    }
  })

  it("a lock naming a live non-Mida process is stale — open clears it instead of waiting it out (in-39 B-1)", async () => {
    // the recycled pid: `kill -0` answers but the number now belongs to a program that is not
    // Mida, so the lock holds nothing and open replaces it immediately
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      home.writeSecretJson("midad.lock", { pid: holder.pid })
      const runtime = await ServiceRuntime.open(home, network, { lockWaitMs: 500, lockStepMs: 50 })
      try {
        expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(process.pid)
      } finally {
        await runtime.close()
      }
    } finally {
      holder.kill()
    }
  })

  it("a lock naming a live Mida process really is held — open waits, refuses, and leaves it alone (in-39 B-1)", async () => {
    // the child's command line is the bundled daemon's `node …/dist/midad.js` — the same check
    // that clears a foreign pid must keep this one untouched
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const script = join(mkdtempSync(join(tmpdir(), "mida-holder-")), "dist/midad.js")
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, "setInterval(() => {}, 1000)\n")
    const holder = spawn(process.execPath, [script], { stdio: "ignore" })
    try {
      home.writeSecretJson("midad.lock", { pid: holder.pid })
      await expect(ServiceRuntime.open(home, network, { lockWaitMs: 300, lockStepMs: 50 })).rejects.toThrow(
        `another Mida process (pid ${holder.pid}) already holds this home`,
      )
      expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(holder.pid)
    } finally {
      holder.kill()
    }
  })

  it("writes the lock with the writer's start time and role — the lock proves who took it", async () => {
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const runtime = await ServiceRuntime.open(home, network)
    try {
      const lock = home.readJson<{ pid?: number; started?: string; role?: string }>("midad.lock")!
      expect(lock.pid).toBe(process.pid)
      expect(lock.role).toBe("service")
      expect(lock.started).toBe(lstartOf(process.pid))
    } finally {
      await runtime.close()
    }
  })

  it("an open role other than the daemon's lands in the lock — the drainer writes save-helper", async () => {
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const runtime = await ServiceRuntime.open(home, network, { role: "save-helper" })
    try {
      expect(home.readJson<{ role?: string }>("midad.lock")?.role).toBe("save-helper")
    } finally {
      await runtime.close()
    }
  })

  it("a lock whose started matches the live pid is held — even when the command line is not Mida's (in-40 L-1)", async () => {
    // The Sep 29 orphaning bug's fix: a plain `node -e` child wears no Mida command line, but the
    // lock it is written into carries its real start time — the match proves the process IS the
    // one that took the lock, so open refuses and leaves everything alone.
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      const started = lstartOf(holder.pid!)
      expect(started).toBeDefined()
      home.writeSecretJson("midad.lock", { pid: holder.pid, started, role: "service" })
      await expect(ServiceRuntime.open(home, network, { lockWaitMs: 300, lockStepMs: 50 })).rejects.toThrow(
        `another Mida process (pid ${holder.pid}) already holds this home`,
      )
      expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(holder.pid)
    } finally {
      holder.kill()
    }
  })

  it("a lock whose start time does not match the live pid is stale — the number was recycled (in-40 L-1)", async () => {
    // The process the lock remembers is gone; a different program owns the pid now, so the start
    // times disagree and open takes the lock over instead of waiting on a stranger.
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      home.writeSecretJson("midad.lock", { pid: holder.pid, started: "Thu Jan  1 00:00:00 1970", role: "service" })
      const runtime = await ServiceRuntime.open(home, network, { lockWaitMs: 500, lockStepMs: 50 })
      try {
        expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(process.pid)
      } finally {
        await runtime.close()
      }
    } finally {
      holder.kill()
    }
  })

  it("a lock ps cannot check at all stays held — a missing ps is never a reason to remove it (in-40 L-1)", async () => {
    // BusyBox ps has no -p, Windows has no ps: whatever the lock says, an uninspectable pid is
    // "unknown" — held, not stale — so the live service under it is never mistaken for dead.
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      home.writeSecretJson("midad.lock", { pid: holder.pid, started: lstartOf(holder.pid!), role: "service" })
      const noPs = () => undefined
      await expect(
        ServiceRuntime.open(home, network, { lockWaitMs: 300, lockStepMs: 50, ps: noPs }),
      ).rejects.toThrow(/another Mida process/)
      expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(holder.pid)
    } finally {
      holder.kill()
    }
  })

  it("a lock written and read under a swung TZ still holds — ps answers are pinned to UTC (in-41 U-1)", async () => {
    // The Sep 29 orphaning bug, second half: `ps -o lstart=` prints LOCAL time, so a lock
    // written under one zone and read under another made a live service look recycled and got
    // its socket removed. With the process TZ swung to Asia/Tokyo the lock written here must
    // still prove the holder — `started` must equal the `TZ=UTC LC_ALL=C` ps answer.
    const savedTz = process.env.TZ
    process.env.TZ = "Asia/Tokyo"
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const runtime = await ServiceRuntime.open(home, network)
    try {
      // what this process wrote is exactly what ps prints with the zone pinned to UTC
      const lock = home.readJson<{ pid?: number; started?: string }>("midad.lock")
      expect(lock?.pid).toBe(process.pid)
      expect(lock?.started).toBe(lstartOf(process.pid))
      // …and a second open on the same home judges this live lock held, not recycled
      await expect(
        ServiceRuntime.open(home, network, { lockWaitMs: 300, lockStepMs: 50 }),
      ).rejects.toThrow(/another Mida process/)
      // a foreign lock is held the same way when its `started` is the UTC answer for its pid
      const home2 = freshHome()
      home2.writeSecretJson("owner-address.json", { address: OWNER })
      home2.writeSecretJson("midad.lock", { pid: holder.pid, started: lstartOf(holder.pid!), role: "service" })
      await expect(
        ServiceRuntime.open(home2, network, { lockWaitMs: 300, lockStepMs: 50 }),
      ).rejects.toThrow(/another Mida process/)
      expect(home2.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(holder.pid)
    } finally {
      await runtime.close()
      holder.kill()
      if (savedTz === undefined) delete process.env.TZ
      else process.env.TZ = savedTz
    }
  })

  it("a legacy {pid} lock naming this very process is held — the writer's own pid needs no ps (in-40 L-1)", async () => {
    // The B7b shape: one process opened the home and the SAME process opens it again — the lock's
    // pid is this process's own, so the answer is "held" before any process-table question is
    // asked. Removing it would orphan the live first runtime.
    const home = freshHome()
    home.writeSecretJson("owner-address.json", { address: OWNER })
    home.writeSecretJson("midad.lock", { pid: process.pid })
    await expect(ServiceRuntime.open(home, network, { lockWaitMs: 300, lockStepMs: 50 })).rejects.toThrow(
      `another Mida process (pid ${process.pid}) already holds this home`,
    )
    expect(home.readJson<{ pid?: number }>("midad.lock")?.pid).toBe(process.pid)
  })
})

describe("Windows process probe", () => {
  const made: string[] = []
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  const fakeRun = (stdout: string, status = 0) => {
    const calls: { cmd: string; args: readonly string[] }[] = []
    const run = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args })
      return { status, stdout, stderr: "", error: undefined }
    }) as unknown as typeof import("node:child_process").spawnSync
    return { run, calls }
  }

  it("asks PowerShell for the creation time in UTC and returns it trimmed", () => {
    const { run, calls } = fakeRun("2026-10-03T01:02:03.4567890Z\r\n")
    expect(windowsProcessProbe(run)(4242, "lstart")).toBe("2026-10-03T01:02:03.4567890Z")
    expect(calls[0]!.cmd).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    expect(calls[0]!.args).toContain("-NoProfile")
    expect(calls[0]!.args.join(" ")).toContain("ProcessId=4242")
    expect(calls[0]!.args.join(" ")).toContain("ToUniversalTime()")
  })

  it("asks for the command line for the command field", () => {
    const { run, calls } = fakeRun("node.exe x\r\n")
    expect(windowsProcessProbe(run)(7, "command")).toBe("node.exe x")
    expect(calls[0]!.args.join(" ")).toContain("CommandLine")
  })

  it("answers undefined for a failed lookup or a non-integer pid, without running anything for the latter", () => {
    expect(windowsProcessProbe(fakeRun("", 1).run)(7, "lstart")).toBeUndefined()
    const { run, calls } = fakeRun("x")
    expect(windowsProcessProbe(run)(1.5, "lstart")).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it("runs PowerShell by its full path built from SystemRoot, so a trimmed PATH cannot break it", () => {
    const saved = process.env.SystemRoot
    process.env.SystemRoot = "D:\\WinDir"
    try {
      const { run, calls } = fakeRun("x")
      windowsProcessProbe(run)(1, "lstart")
      expect(calls[0]!.cmd).toBe("D:\\WinDir\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    } finally {
      if (saved === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = saved
    }
  })

  it("defaults the PowerShell path to C:\\Windows when SystemRoot is not set", () => {
    const saved = process.env.SystemRoot
    delete process.env.SystemRoot
    try {
      const { run, calls } = fakeRun("x")
      windowsProcessProbe(run)(1, "lstart")
      expect(calls[0]!.cmd).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    } finally {
      if (saved !== undefined) process.env.SystemRoot = saved
    }
  })

  it("processProbeFor picks the Windows probe on win32", () => {
    expect(processProbeFor("win32")).not.toBe(processProbeFor("darwin"))
  })

  it("an older lock is recognised from a Windows command line", () => {
    const home = freshHome()
    made.push(home.root)
    home.writeSecretJson("midad.lock", { pid: process.ppid })
    const probe = (_pid: number, field: "lstart" | "command") =>
      field === "command"
        ? '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Jane\\AppData\\Roaming\\npm\\node_modules\\mida-context\\dist\\midad.js'
        : undefined
    expect(lockHolder(home, probe)).toEqual({ pid: process.ppid, kind: "held", role: "service" })
  })
})
