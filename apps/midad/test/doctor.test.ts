import { afterEach, describe, expect, it, vi } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import type { AddressInfo, Server } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { toFunctionSelector } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { encodeUint64 } from "@mida/protocol"
import { parseDeployment } from "@mida/chain"
import { CODEX_BLOCK_V1, CODEX_TRUST_SENTENCE, MidaHome, approveProject, claudeCodeMcpJson, doctorReplaceStaleService, enqueue, ensureCurrentDaemon, installClaudeCode, installCodex, installDevin, isMidaProcess, linkProject, loadOrCreateOwnerSecrets, recordCodexHome, runDoctor, runDoctorLive, runInstall, saveOwnerAddress, saveOwnerMode, socketPathFor, writeSummarizer } from "@mida/midad"
import type { Runtime } from "@mida/midad"
import { codeIdentity } from "../src/code-identity.js"

const dir = () => mkdtempSync(join(tmpdir(), "mida-doctor-"))

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const tsxLoader = join(repo, "node_modules/tsx/dist/loader.mjs")
const cliMainPath = join(repo, "apps/midad/src/cli.ts")

/**
 * Live children a test spawns so `midad.lock` can name a real pid — killed in afterEach, only
 * ever by the test that spawned them. `form` is the command line the pid wears: "bundled" is
 * the npm package's `node …/dist/midad.js`, "bin" the shebang form `node …/midad`, "source" a
 * checkout's `node --import tsx …/apps/midad/src/daemon-main.ts`, and "foreign" a plain
 * `node -e` — the recycled-pid case doctor must never call Mida.
 */
const spawned: ChildProcess[] = []

afterEach(() => {
  while (spawned.length > 0) spawned.pop()!.kill()
})

function spawnHolder(form: "bundled" | "bin" | "source" | "foreign"): ChildProcess {
  let args: string[]
  if (form === "foreign") {
    args = ["-e", "setInterval(() => {}, 1000)"]
  } else {
    const root = dir()
    const file =
      form === "bundled" ? join(root, "dist/midad.js")
      : form === "bin" ? join(root, "bin/midad")
      : join(root, "apps/midad/src/daemon-main.ts")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "setInterval(() => {}, 1000)\n")
    args = form === "source" ? ["--import", tsxLoader, file] : [file]
  }
  const child = spawn(process.execPath, args, { stdio: "ignore" })
  spawned.push(child)
  return child
}

/** A stub listener on the home's control socket that answers every request with `status` + JSON `body`. */
async function stubDaemon(home: MidaHome, status: number, body: unknown): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("data", () => {
      const payload = JSON.stringify(body)
      socket.end(
        `HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPathFor(home), () => resolve())
  })
  return server
}

const closeServer = (server: Server) => new Promise<void>((done) => server.close(() => done()))

describe("mida doctor without a chain", () => {
  it("a fresh home reports the daemon, network.json and every dependent check — and finishes", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const config = join(dir(), "config.toml")
    const lines: string[] = []
    const code = await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings, codex: config },
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines[0]).toBe("PROBLEM: midad is not answering — start the daemon")
    expect(lines).toContain("PROBLEM: network.json is missing or unreadable — run `mida init`")
    // every dependent check reports rather than hanging or staying silent
    expect(lines.some((line) => line.includes("owner"))).toBe(true)
    expect(lines.some((line) => line.includes("claude-code hooks"))).toBe(true)
    expect(lines.some((line) => line.includes("codex hooks"))).toBe(true)
    expect(code).toBeGreaterThan(0)
    expect(code).toBeLessThanOrEqual(9)
  })

  it("a live Mida lock holder whose socket does not answer is told to kill it, not to start a new one (in-29 S-1)", async () => {
    // Sep 29, item 14's end state: midad's process is alive (its lock pid is), the socket it
    // listens on is gone, and api-url.json is still on disk — running but unreachable. Doctor
    // must name the pid and the fix; "start the daemon" would orphan it a second time. The pid
    // is a spawned child whose command line IS the bundled daemon's — a bare live pid stopped
    // being proof once pids got recycled (in-39 B-1).
    const home = new MidaHome(join(dir(), "home"))
    const holder = spawnHolder("bundled")
    home.writeSecretJson("midad.lock", { pid: holder.pid })
    home.writeSecretJson("api-url.json", { baseUrl: "http://127.0.0.1:9" })
    const lines: string[] = []
    const code = await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain(
      `PROBLEM: the Mida service (pid ${holder.pid}) is running but has not answered for 5 s. If mida doctor still says this in a minute, stop it with kill ${holder.pid}, then open any agent session or run mida task to start a fresh one.`,
    )
    expect(lines).not.toContain("PROBLEM: midad is not answering — start the daemon")
    expect(code).toBeGreaterThan(0)
  })

  it("a lock naming a live non-Mida process is a stale lock — doctor never tells the owner to kill it (in-39 B-1)", async () => {
    // The recycled-pid case review caught: Mida died without cleanup, the number went to an
    // unrelated program, and kill(pid,0) still answers. The service is GONE — the fix is a new
    // one clearing the lock, not a kill aimed at a stranger's process.
    const home = new MidaHome(join(dir(), "home"))
    const holder = spawnHolder("foreign")
    home.writeSecretJson("midad.lock", { pid: holder.pid })
    home.writeSecretJson("api-url.json", { baseUrl: "http://127.0.0.1:9" })
    const lines: string[] = []
    const code = await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain(
      `PROBLEM: midad.lock names pid ${holder.pid}, which is no longer the Mida process that took the lock, so the last Mida service did not exit cleanly. Open any agent session or run mida task; the new service clears the stale lock.`,
    )
    // never named as the service, never a kill target
    expect(lines.some((line) => line.includes("is running but has not answered"))).toBe(false)
    expect(lines.some((line) => line.includes(`kill ${holder.pid}`))).toBe(false)
    expect(code).toBeGreaterThan(0)
  })

  it("a lock held by a live mida command names the command, never kill (in-40 L-2)", async () => {
    // A `mida` owner command holds midad.lock while it runs — often waiting on a typed yes. The
    // lock's own role says so; doctor asks the owner to finish or cancel it, never to kill it.
    const home = new MidaHome(join(dir(), "home"))
    const holder = spawnHolder("foreign")
    const started = spawnSync("ps", ["-o", "lstart=", "-p", String(holder.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).stdout.trim()
    home.writeSecretJson("midad.lock", { pid: holder.pid, started, role: "command" })
    const lines: string[] = []
    const code = await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain(
      `PROBLEM: the Mida service is not running, and a mida command (pid ${holder.pid}) holds this home until it finishes. Finish or cancel that command, then open any agent session or run mida task.`,
    )
    expect(lines.some((line) => line.includes("kill"))).toBe(false)
    expect(code).toBeGreaterThan(0)
  })

  it("a lock held by the save helper says it finishes on its own, never kill (in-40 L-2)", async () => {
    // The detached drainer holds the home for a save pass. Doctor tells the owner to wait it
    // out — a kill hint would have them shooting a helper mid-save.
    const home = new MidaHome(join(dir(), "home"))
    const holder = spawnHolder("foreign")
    const started = spawnSync("ps", ["-o", "lstart=", "-p", String(holder.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).stdout.trim()
    home.writeSecretJson("midad.lock", { pid: holder.pid, started, role: "save-helper" })
    const lines: string[] = []
    const code = await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain(
      `PROBLEM: the Mida service is not running, and Mida's save helper (pid ${holder.pid}) holds this home until it finishes, usually within a minute. Then open any agent session or run mida task.`,
    )
    expect(lines.some((line) => line.includes("kill"))).toBe(false)
    expect(code).toBeGreaterThan(0)
  })

  it("a lock pid ps cannot read is unknown — doctor names the lock file, never kill (in-40 L-2)", async () => {
    // A machine where ps answers nothing (BusyBox has no -p, Windows has no ps) must not get a
    // kill hint or a stale-lock verdict: doctor says what it could not tell and names the file
    // the owner would remove once they have checked the pid themselves.
    const home = new MidaHome(join(dir(), "home"))
    const holder = spawnHolder("foreign")
    home.writeSecretJson("midad.lock", { pid: holder.pid, started: "Thu Jan  1 00:00:00 1970", role: "service" })
    const lines: string[] = []
    const code = await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      ps: () => undefined,
    })
    expect(lines).toContain(
      `PROBLEM: midad.lock names pid ${holder.pid}, and doctor cannot tell whether that process is still Mida. Run ps -p ${holder.pid} -o command= to see what it is. If it is not Mida, delete ${home.path("midad.lock")}, then open any agent session or run mida task.`,
    )
    expect(lines.some((line) => line.includes("kill"))).toBe(false)
    expect(code).toBeGreaterThan(0)
  })

  it("a rejected-ledger reason the store wrote prints folded — ESC and newline never reach the line (in-41 U-2)", async () => {
    // state/batch-rejected.json is data the store handed us: a reason carrying an erase-screen
    // and a forged second line must land in the PROBLEM line as one folded, harmless string.
    const home = new MidaHome(join(dir(), "home"))
    const esc = String.fromCharCode(0x1b)
    home.writeSecretJson("state/batch-rejected.json", {
      entries: [
        {
          contextId: `0x${"aa".repeat(32)}`,
          eventId: "e1",
          sessionId: "s1",
          agent: "codex",
          reason: `store says ${esc}[2J wipe\nforged second line`,
          at: "2026-09-29T00:00:00.000Z",
        },
      ],
    })
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    const line = lines.find((l) => l.includes("rejected on chain"))
    expect(line).toBeDefined()
    expect(line).not.toContain(esc)
    expect(line).not.toContain("\n")
    expect(line).toContain("store says [2J wipe")
  })

  it("a store probe's rejection reason folds the same way — one line, no paint (in-41 U-2)", async () => {
    // The same line built from the live probe's answer rather than the ledger: an old pending
    // entry asks the store, and whatever reason the answer carries prints folded.
    const home = new MidaHome(join(dir(), "home"))
    const esc = String.fromCharCode(0x1b)
    home.writeSecretJson("state/batch-pending.json", {
      entries: [
        {
          contextId: `0x${"bb".repeat(32)}`,
          eventId: "e2",
          sessionId: "s2",
          agent: "codex",
          queuedAt: "2020-01-01T00:00:00.000Z",
          state: "QUEUED",
        },
      ],
    })
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      probeBatchSave: async () => ({ state: "REJECTED", reason: `store says ${esc}[2J wipe\nforged second line` }),
    })
    const line = lines.find((l) => l.includes("rejected on chain"))
    expect(line).toBeDefined()
    expect(line).not.toContain(esc)
    expect(line).not.toContain("\n")
    expect(line).toContain("store says [2J wipe")
  })

  it("isMidaProcess matches every Mida entry form — and not the vitest pid or a foreign child (in-39 B-1)", () => {
    // the bundled daemon, the shebang'd bin name, and the tsx source form the repo's bin/mida
    // launcher and the e2e tests spawn — all true; the test runner itself and an arbitrary
    // node -e child are not.
    expect(isMidaProcess(spawnHolder("bundled").pid!)).toBe(true)
    expect(isMidaProcess(spawnHolder("bin").pid!)).toBe(true)
    expect(isMidaProcess(spawnHolder("source").pid!)).toBe(true)
    expect(isMidaProcess(spawnHolder("foreign").pid!)).toBe(false)
    expect(isMidaProcess(process.pid)).toBe(false)
  })

  it("a lock whose pid is dead is just a stale lock — the same socket file scenario says start the daemon", async () => {
    // a crashed service leaves the same files behind but its pid is gone — nothing is running,
    // so the ordinary missing-daemon line stays right. 4194304 is above the usual pid_max.
    const home = new MidaHome(join(dir(), "home"))
    home.writeSecretJson("midad.lock", { pid: 4_194_304 })
    home.writeSecretJson("api-url.json", { baseUrl: "http://127.0.0.1:9" })
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain("PROBLEM: midad is not answering — start the daemon")
    expect(lines.some((line) => line.includes("is running but cannot be reached"))).toBe(false)
  })

  it("an out-of-gas wait names the agent, the fix, and the next retry time (in-29 S-2)", async () => {
    // Sep 29, item 15: the queue check answered "job(s) waiting" with no reason and no schedule —
    // the owner could not tell a dry wallet from a dead chain. The state file the drain wrote
    // carries the reason and the failedAt the next-try time is computed from. A stub service
    // answers /health so the note can promise a real clock time (B-2: a down service changes it).
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      // three attempts in: the next try is failedAt + 60 s × 2^3 = eight minutes on
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 3, failedAt, reason: "out-of-gas" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain("PROBLEM: claude-code's wallet ran out of gas, so its saves are waiting. Run mida sponsor on, or mida init to top it up.")
      const due = new Date(Date.parse(failedAt) + 8 * 60_000)
      const hhmm = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`
      expect(lines).toContain(`note: 1 session(s) waiting to save; the next try is at ${hhmm} local time.`)
    } finally {
      await closeServer(server)
    }
  })

  it("a sponsored setup's out-of-gas line names the sponsor that did not pay — never 'run mida sponsor on' (in-39 B-4)", async () => {
    // A sponsor IS configured on this setup, so "run mida sponsor on" is nonsense advice — the
    // honest line is that the configured sponsor did not pay, and the wallet needs topping up
    // until it does. The sponsor/store probes are stubbed so nothing reaches a real service.
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      home.writeSecretJson("network.json", { sponsorUrl: "https://sponsor.example" })
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 3, failedAt, reason: "out-of-gas" })
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        fetch: async () => new Response("{}", { status: 200 }),
        sponsorReachable: async () => false,
      })
      expect(lines).toContain(
        "PROBLEM: claude-code's wallet ran out of gas and the gas sponsor did not pay, so its saves are waiting. Check doctor's sponsor line; until the sponsor pays again, the wallet needs testnet MON.",
      )
      expect(lines.some((line) => line.includes("Run mida sponsor on"))).toBe(false)
    } finally {
      await closeServer(server)
    }
  })

  it("a self-paid setup keeps the top-it-up out-of-gas line (in-39 B-4)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 3, failedAt, reason: "out-of-gas" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain("PROBLEM: claude-code's wallet ran out of gas, so its saves are waiting. Run mida sponsor on, or mida init to top it up.")
    } finally {
      await closeServer(server)
    }
  })

  // UF-O item O4: two waits the queue check used to mislabel or hide — a wallet funded below the
  // send threshold cannot pay either, and a sponsor-limit wait is the sponsor's daily cap, which
  // resets at 00:00 UTC. UF-QA: wallet-low is its own line now — the wallet is LOW, not out —
  // and the sponsor-limit line says the sponsor stopped paying, never whose limit ran out: the
  // same wait happens when the sponsor's shared daily budget is spent, not only one agent's cap.
  it("a wallet-low wait says the paying wallet is low on gas, self-paid or sponsored alike (UF-QA)", async () => {
    for (const sponsored of [false, true]) {
      const home = new MidaHome(join(dir(), `home-${sponsored}`))
      const server = await stubDaemon(home, 200, { ok: true })
      try {
        if (sponsored) home.writeSecretJson("network.json", { sponsorUrl: "https://sponsor.example" })
        enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
        const failedAt = new Date(Date.now() - 30_000).toISOString()
        home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 2, failedAt, reason: "wallet-low" })
        const lines: string[] = []
        await runDoctor({
          home,
          print: (line) => lines.push(line),
          settings: {},
          env: {},
          daemonProbeMs: 50,
          fetch: async () => new Response("{}", { status: 200 }),
          sponsorReachable: async () => false,
        })
        expect(lines, `sponsored=${sponsored}`).toContain(
          "PROBLEM: claude-code's saves are waiting because the wallet that pays for them is low on gas. See doctor's sponsor and wallets lines.",
        )
        expect(lines.some((line) => line.includes("ran out of gas")), `sponsored=${sponsored}`).toBe(false)
      } finally {
        await closeServer(server)
      }
    }
  })

  it("a sponsor-limit wait says the sponsor stopped paying — its limits reset at 00:00 UTC (UF-QA)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, failedAt, reason: "sponsor-limit" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(
        "PROBLEM: the gas sponsor has stopped paying for today, so claude-code's saves are waiting. Mida sends them after its limits reset at 00:00 UTC.",
      )
      // the old wording blamed the agent's own limit — the same wait happens on the shared budget
      expect(lines.some((line) => line.includes("daily limit for claude-code"))).toBe(false)
    } finally {
      await closeServer(server)
    }
  })

  // UF-P3 item P3b: a save held for a summary model is a PROBLEM that names the wait — the
  // owner is told why and which command shows or changes the choice.
  it("a summarizer-limit wait names the model's usage limit and points at mida summarizer (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, failedAt, reason: "summarizer-limit" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(
        "PROBLEM: the model that writes Mida's summaries hit its usage limit, so claude-code's saves are waiting. Run mida summarizer to see it or to choose another.",
      )
    } finally {
      await closeServer(server)
    }
  })

  it("a no-summarizer wait says no model is set up and points at mida summarizer (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, failedAt, reason: "no-summarizer" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(
        "PROBLEM: no model is set up to write Mida's summaries, so claude-code's saves are waiting. Run mida summarizer.",
      )
    } finally {
      await closeServer(server)
    }
  })

  // UF-QF: a save stuck past its eighth failed try on an ordinary reason is not waiting on an
  // allowance — Mida is still retrying it, more slowly and one cheap call at a time, until the
  // job is seven days old. The queue check says exactly that.
  it("a save that has failed nine times on an ordinary reason gets the keeps-trying line (UF-QF)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 9, failedAt, reason: "model-failed" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(
        "PROBLEM: a save from claude-code has failed 9 times (model-failed). Mida keeps trying, more slowly, and drops it when it is seven days old.",
      )
    } finally {
      await closeServer(server)
    }
  })

  it("the keeps-trying line waits for eight tries — three failures earn no line (UF-QF)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 3, failedAt, reason: "model-failed" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines.some((line) => line.includes("has failed"))).toBe(false)
    } finally {
      await closeServer(server)
    }
  })

  it("a session waiting on a capacity reason earns its own line, never the keeps-trying one (UF-QF)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 30_000).toISOString()
      home.writeSecretJson("queue/state/s1.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 9, failedAt, reason: "sponsor-limit" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines.some((line) => line.includes("has failed"))).toBe(false)
      expect(lines).toContain(
        "PROBLEM: the gas sponsor has stopped paying for today, so claude-code's saves are waiting. Mida sends them after its limits reset at 00:00 UTC.",
      )
    } finally {
      await closeServer(server)
    }
  })

  // UF-QF: the review's empty test — `mida doctor`'s stale-service swap must allow the old
  // service a full minute to stop and must print the busy line through the callback, not a
  // "finishing a save" claim the service may not be doing. The ensure call is injected.
  it("doctor's stale-service swap waits a minute and prints the busy line through the callback (UF-QF)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    let seen: Parameters<typeof ensureCurrentDaemon>[2] | undefined
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    try {
      await doctorReplaceStaleService(home, async (_h, _spawn, options) => {
        seen = options
        options.onStillUp?.()
        return { up: false }
      })
    } finally {
      spy.mockRestore()
    }
    expect(seen?.shutdownWaitMs).toBe(65_000)
    expect(seen?.whenDown).toBe("leave")
    expect(written).toContain("The older Mida service is still busy. Waiting up to a minute for it to stop.\n")
  })

  it("the sponsor line says how many SAVES a day its limits really pay for (UF-O)", async () => {
    // one save spends 2 free calls (stub data + gas estimate), so a free-call limit can bind
    // tighter than the signing limit: 120 free calls = 60 saves, not 300
    const cases: { limits: Record<string, unknown>; saves: number }[] = [
      { limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, freeCallsPerSenderPerDay: 120 }, saves: 60 },
      { limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, freeCallsPerSenderPerDay: 900 }, saves: 300 },
      { limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000 }, saves: 300 },
    ]
    for (const { limits, saves } of cases) {
      const home = new MidaHome(join(dir(), `home-${saves}`))
      const server = await stubDaemon(home, 200, { ok: true })
      try {
        home.writeSecretJson("network.json", { sponsorUrl: "https://sponsor.example" })
        const lines: string[] = []
        await runDoctor({
          home,
          print: (line) => lines.push(line),
          settings: {},
          env: {},
          daemonProbeMs: 50,
          fetch: async () => new Response(JSON.stringify({ limits }), { status: 200 }),
        })
        expect(lines).toContain(
          `ok: gas sponsor reachable at sponsor.example (willingness is only proven by a real send; it pays for up to ${saves} saves per agent a day, 2000 a day across everyone)`,
        )
      } finally {
        await closeServer(server)
      }
    }
  })

  // UF-QA: the sponsor's GET reply also carries limits.dailyWeiBudget — a decimal string of wei,
  // the daily budget shared by EVERYONE, which runs out long before the count limits do. When it
  // is a decimal string the detail names it in whole MON; when absent or malformed the old count
  // wording stands. perAgent clamps at 0 — a freeCalls field of 0, 1 or -5 is never "-3 saves".
  it("a sponsor carrying a daily budget says it is shared by everyone, in whole MON (UF-QA)", async () => {
    const cases: { limits: Record<string, unknown>; detail: string }[] = [
      {
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, dailyWeiBudget: "150000000000000000000" },
        detail: "; it pays for up to 300 saves per agent a day, from a daily budget of 150 MON shared by everyone",
      },
      {
        // wei under the next whole MON rounds DOWN — 150.9 MON prints as 150
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, dailyWeiBudget: "150999999999999999999" },
        detail: "; it pays for up to 300 saves per agent a day, from a daily budget of 150 MON shared by everyone",
      },
      {
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, dailyWeiBudget: "not-a-decimal" },
        detail: "; it pays for up to 300 saves per agent a day, 2000 a day across everyone",
      },
      {
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, dailyWeiBudget: 150000000000000000000 },
        detail: "; it pays for up to 300 saves per agent a day, 2000 a day across everyone",
      },
      {
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, freeCallsPerSenderPerDay: 0, dailyWeiBudget: "150000000000000000000" },
        detail: "; it pays for up to 0 saves per agent a day, from a daily budget of 150 MON shared by everyone",
      },
      {
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, freeCallsPerSenderPerDay: 1, dailyWeiBudget: "150000000000000000000" },
        detail: "; it pays for up to 0 saves per agent a day, from a daily budget of 150 MON shared by everyone",
      },
      {
        limits: { signingsPerSenderPerDay: 300, signingsGlobalPerDay: 2000, freeCallsPerSenderPerDay: -5, dailyWeiBudget: "150000000000000000000" },
        detail: "; it pays for up to 0 saves per agent a day, from a daily budget of 150 MON shared by everyone",
      },
    ]
    for (const [i, { limits, detail }] of cases.entries()) {
      const home = new MidaHome(join(dir(), `home-budget-${i}`))
      const server = await stubDaemon(home, 200, { ok: true })
      try {
        home.writeSecretJson("network.json", { sponsorUrl: "https://sponsor.example" })
        const lines: string[] = []
        await runDoctor({
          home,
          print: (line) => lines.push(line),
          settings: {},
          env: {},
          daemonProbeMs: 50,
          fetch: async () => new Response(JSON.stringify({ limits }), { status: 200 }),
        })
        expect(lines, JSON.stringify(limits)).toContain(
          `ok: gas sponsor reachable at sponsor.example (willingness is only proven by a real send${detail})`,
        )
      } finally {
        await closeServer(server)
      }
    }
  })

  it("a session waiting on a non-gas reason gets the note but no wallet line (in-29 S-2)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "codex", event: "Stop", sessionId: "s2", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const failedAt = new Date(Date.now() - 5_000).toISOString()
      home.writeSecretJson("queue/state/s2.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 1, failedAt, reason: "chain-busy" })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      const due = new Date(Date.parse(failedAt) + 2 * 60_000)
      const hhmm = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`
      expect(lines).toContain(`note: 1 session(s) waiting to save; the next try is at ${hhmm} local time.`)
      expect(lines.some((line) => line.includes("ran out of gas"))).toBe(false)
    } finally {
      await closeServer(server)
    }
  })

  it("a wait whose next-try time has already passed says 'due now' — never a stale clock reading (in-39 B-2)", async () => {
    // a flush job with no failure record owes nothing — its due time is epoch 0, which used to
    // print as "01:00 local time". The injected clock pins "now" so the boundary is exact.
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true })
    try {
      enqueue(home, { agent: "claude-code", event: "Stop", sessionId: "s1", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50, now: () => 1_760_000_000_000 })
      expect(lines).toContain("note: 1 session(s) waiting to save; the next try is due now.")
    } finally {
      await closeServer(server)
    }
  })

  it("a service that did not answer moves the waiting note to 'once the Mida service is running' (in-39 B-2)", async () => {
    // nothing is listening, so no clock reading is honest — the saves land on the next running
    // service, whenever that is
    const home = new MidaHome(join(dir(), "home"))
    enqueue(home, { agent: "codex", event: "Stop", sessionId: "s2", transcriptPath: "/tmp/t.jsonl", cwd: "/tmp", error: null })
    const failedAt = new Date(Date.now() - 5_000).toISOString()
    home.writeSecretJson("queue/state/s2.json", { transcriptBytes: 10, lastLineHash: "", savedAt: failedAt, attempts: 1, failedAt, reason: "chain-busy" })
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain("note: 1 session(s) waiting to save; they are sent once the Mida service is running.")
    expect(lines.some((line) => line.includes("next try is at"))).toBe(false)
  })

  it("names the compile model and where the session text goes — per provider, from the real chain (M3-D5)", async () => {
    // UF-P3: the check resolves through currentSummarizer now — the same function the service
    // uses — so the agent tools on PATH count, and a Codex tail names its own label.
    const home = new MidaHome(join(dir(), "home"))
    const run = async (env: NodeJS.ProcessEnv) => {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env,
        daemonProbeMs: 50,
        onPath: () => true,
        claudeSafeMode: () => false,
      })
      return lines
    }

    // no keys: haiku through the claude CLI, Codex behind it
    const haiku = await run({})
    expect(haiku).toContain("ok: compile model is claude-haiku")
    const haikuNote = haiku.filter((line) => line.startsWith("note:") && line.includes("transcript text"))
    expect(haikuNote).toHaveLength(1)
    expect(haikuNote[0]).toContain("api.anthropic.com")
    expect(haikuNote[0]).toContain("a failed call falls back to codex-luna")

    // deepseek key alone: the default, falling back to the agents
    const deepseek = await run({ DEEPSEEK_API_KEY: "test-key" })
    expect(deepseek).toContain("ok: compile model is deepseek-flash")
    expect(deepseek).toContain(
      "note: deepseek sends the session's transcript text to api.deepseek.com (secrets are scrubbed first); a failed call falls back to claude-haiku (api.anthropic.com), then codex-luna (api.openai.com)",
    )
    expect(deepseek.join("\n")).not.toContain("test-key")

    // both keys: the note names the full real chain
    const both = await run({ DEEPSEEK_API_KEY: "d", KIMI_API_KEY: "k" })
    expect(both).toContain(
      "note: deepseek sends the session's transcript text to api.deepseek.com (secrets are scrubbed first); a failed call falls back to kimi (api.moonshot.ai), then claude-haiku (api.anthropic.com), then codex-luna (api.openai.com)",
    )

    // kimi alone: Moonshot is where the text goes
    const kimi = await run({ KIMI_API_KEY: "test-key" })
    expect(kimi).toContain("ok: compile model is kimi-k2.7-code-highspeed")
    expect(kimi).toContain(
      "note: kimi sends the session's transcript text to api.moonshot.ai (secrets are scrubbed first); a failed call falls back to claude-haiku (api.anthropic.com), then codex-luna (api.openai.com)",
    )
    expect(kimi.join("\n")).not.toContain("test-key")
    expect(kimi.some((line) => line.includes("not Moonshot"))).toBe(false)
  })

  it("a pinned custom is the owner's own endpoint — no vendor, no fallback, unless MIDA_COMPILE_FALLBACK=1 (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const custom = {
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "http://127.0.0.1:11434/v1",
      MIDA_COMPILE_MODEL_ID: "qwen-local",
      DEEPSEEK_API_KEY: "d",
      KIMI_API_KEY: "k",
    }
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: custom, daemonProbeMs: 50, onPath: () => true, claudeSafeMode: () => false })
    expect(lines).toContain("ok: compile model is qwen-local")
    expect(lines).toContain("note: compile text is sent to 127.0.0.1:11434 (your own endpoint); no fallback")
    // the custom base URL is itself — never a 'not Moonshot'-style problem
    expect(lines.some((line) => line.startsWith("PROBLEM:") && line.includes("compile text"))).toBe(false)

    // opted-in fallback names the vendors the text could reach
    const withFallback: string[] = []
    await runDoctor({
      home,
      print: (line) => withFallback.push(line),
      settings: {},
      env: { ...custom, MIDA_COMPILE_FALLBACK: "1" },
      daemonProbeMs: 50,
      onPath: () => true,
      claudeSafeMode: () => false,
    })
    expect(withFallback).toContain(
      "note: compile text is sent to 127.0.0.1:11434 (your own endpoint); a failed call falls back to deepseek (api.deepseek.com), then kimi (api.moonshot.ai), then claude-haiku (api.anthropic.com)",
    )

    // a pinned custom missing its required vars is a PROBLEM — every compile would fail
    const missing: string[] = []
    await runDoctor({
      home,
      print: (line) => missing.push(line),
      settings: {},
      env: { MIDA_COMPILE_MODEL: "custom" },
      daemonProbeMs: 50,
    })
    const missingLine = missing.find((line) => line.startsWith("PROBLEM:") && line.includes("custom"))
    expect(missingLine).toBeDefined()
    expect(missingLine).toContain("MIDA_COMPILE_BASE_URL")
    expect(missingLine).toContain("MIDA_COMPILE_MODEL_ID")
  })

  it("an overridden provider base URL is a PROBLEM naming the host only — provider-aware, never the full URL (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const run = async (env: NodeJS.ProcessEnv) => {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env, daemonProbeMs: 50 })
      return lines
    }

    // kimi override while kimi is in the chain — the old "not Moonshot" problem, provider-aware
    const kimi = await run({ KIMI_API_KEY: "test-key", KIMI_BASE_URL: "http://example.com/secret/path?token=abc" })
    const kimiWarn = kimi.find((line) => line.includes("not Moonshot"))
    expect(kimiWarn).toBeDefined()
    expect(kimiWarn).toContain("PROBLEM:")
    expect(kimiWarn).toContain("compile text is being sent to example.com, not Moonshot")
    expect(kimiWarn).not.toContain("/secret/path")
    expect(kimiWarn).not.toContain("token=abc")

    // deepseek override — the same problem names DeepSeek
    const deepseek = await run({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "https://evil.example" })
    expect(deepseek.some((line) => line.includes("compile text is being sent to evil.example, not DeepSeek"))).toBe(true)
    // and the note tells the truth about where it actually goes
    expect(deepseek.some((line) => line.startsWith("note:") && line.includes("evil.example"))).toBe(true)

    // a kimi override with NO kimi in the chain is dormant, not a problem
    const dormant = await run({ DEEPSEEK_API_KEY: "d", KIMI_BASE_URL: "https://evil.example" })
    expect(dormant.some((line) => line.includes("not Moonshot"))).toBe(false)

    // a custom endpoint is the user's own — never a problem, no matter the host
    const custom = await run({
      MIDA_COMPILE_MODEL: "custom",
      MIDA_COMPILE_BASE_URL: "https://anything.example.com/v1",
      MIDA_COMPILE_MODEL_ID: "m",
    })
    expect(custom.some((line) => line.startsWith("PROBLEM:") && line.includes("compile text"))).toBe(false)
    expect(custom.some((line) => line.includes("anything.example.com"))).toBe(true)
  })

  // UF-P3 item P3b: compile-model resolves the chain the SERVICE would use — currentSummarizer,
  // not the old env-only choice — so a Codex-only PATH, an empty chain, an unreadable saved
  // choice and a saved key each get their own honest line.
  it("with only Codex on PATH the compile model is codex-luna and Claude is named a missing backup (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      onPath: (bin) => bin === "codex",
    })
    expect(lines).toContain("ok: compile model is codex-luna")
    expect(lines).toContain(
      "note: codex-luna sends the session's transcript text to api.openai.com via the codex CLI (secrets are scrubbed first); no fallback",
    )
    expect(lines).toContain("note: Claude Code (haiku) is not installed, so Mida cannot use it.")
  })

  it("with neither agent tool the compile-model check is one PROBLEM line and nothing else (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      onPath: () => false,
    })
    const problem = "PROBLEM: no model can write Mida's summaries, so no session is being saved. Install Claude Code or Codex, or run mida summarizer use key."
    expect(lines).toContain(problem)
    // nothing else from this check: no ok:, no transcript note, no fallback, no backup note
    expect(lines.some((line) => line.includes("compile model is"))).toBe(false)
    expect(lines.some((line) => line.includes("transcript text"))).toBe(false)
    expect(lines.some((line) => line.includes("cannot be the backup"))).toBe(false)
    expect(lines.filter((line) => line.includes("Mida's summaries")).length).toBe(1)
  })

  it("an environment pin for a model that cannot run names the environment as the chooser (UF-QD)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: { MIDA_COMPILE_MODEL: "haiku" },
      daemonProbeMs: 50,
      onPath: (bin) => bin === "codex",
    })
    expect(lines).toContain(
      "PROBLEM: no model can write Mida's summaries, so no session is being saved. Your environment variables choose a model that cannot run here. Run mida summarizer use agents.",
    )
    expect(lines.some((line) => line.includes("Install Claude Code or Codex"))).toBe(false)
  })

  it("an unreadable summarizer.json is its own PROBLEM line — never an ok model line (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    writeFileSync(home.path("summarizer.json"), "{not json")
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      onPath: () => true,
    })
    expect(lines).toContain(
      "PROBLEM: the saved summariser choice (summarizer.json) cannot be read, so no session is being saved. Run mida summarizer use agents, or mida summarizer use key.",
    )
    expect(lines.some((line) => line.includes("compile model is"))).toBe(false)
  })

  it("a saved key choice names the provider's model — and the key appears in no line (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    writeSummarizer(home, { use: "key", provider: "deepseek", apiKey: "sk-test-secret-key" })
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      onPath: () => true,
      claudeSafeMode: () => false,
    })
    expect(lines).toContain("ok: compile model is deepseek-flash")
    expect(lines).toContain(
      "note: deepseek sends the session's transcript text to api.deepseek.com (secrets are scrubbed first); no fallback",
    )
    expect(lines.join("\n")).not.toContain("sk-test-secret-key")
  })

  it("a running service on a different summarizer chain gets the whose-answer-counts note (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      codeRoot: codeIdentity().codeRoot,
      codeCommit: codeIdentity().codeCommit,
      codeVersion: codeIdentity().codeVersion,
      summarizer: {
        mode: "key",
        chosen: true,
        invalid: false,
        entries: [{ id: "deepseek", label: "deepseek-flash", display: "DeepSeek (deepseek-flash)", host: "api.deepseek.com", installed: true }],
        chain: ["deepseek-flash"],
      },
    })
    try {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        onPath: () => true,
        claudeSafeMode: () => false,
      })
      expect(lines).toContain(
        "note: the running Mida service uses deepseek-flash; this shell would use claude-haiku, codex-luna. The service's answer is the one that counts.",
      )
    } finally {
      await closeServer(server)
    }
  })

  it("a service at the same folder and commit but another codeVersion is reported as other code (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      codeRoot: codeIdentity().codeRoot,
      codeCommit: codeIdentity().codeCommit,
      codeVersion: "0.0.0-older",
    })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines.some((line) => line.includes("this command runs the same"))).toBe(false)
      expect(lines.some((line) => line.startsWith("PROBLEM:") && line.includes("midad runs"))).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it("a service that names root and commit but no codeVersion is reported as other code (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      codeRoot: codeIdentity().codeRoot,
      codeCommit: codeIdentity().codeCommit,
    })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      expect(lines.some((line) => line.includes("this command runs the same"))).toBe(false)
      expect(lines.some((line) => line.startsWith("PROBLEM:") && line.includes("midad"))).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it("a running service on the SAME chain gets no note (UF-P3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      codeRoot: codeIdentity().codeRoot,
      codeCommit: codeIdentity().codeCommit,
      codeVersion: codeIdentity().codeVersion,
      summarizer: {
        mode: "agents",
        chosen: true,
        invalid: false,
        entries: [
          { id: "claude", label: "claude-haiku", display: "Claude Code (haiku)", host: "api.anthropic.com", installed: true },
          { id: "codex", label: "codex-luna", display: "Codex (luna)", host: "api.openai.com", installed: true },
        ],
        chain: ["claude-haiku", "codex-luna"],
      },
    })
    try {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        onPath: () => true,
        claudeSafeMode: () => false,
      })
      expect(lines.some((line) => line.includes("The service's answer is the one that counts"))).toBe(false)
    } finally {
      await closeServer(server)
    }
  })

  // UF-QC: the compile-model check describes the RUNNING service's chain — the entries and the
  // chain labels in its /health reply — not the chain this shell would resolve. The local
  // resolution is only the fallback when the service cannot or did not say.
  const selfIdentity = () => ({ codeRoot: codeIdentity().codeRoot, codeCommit: codeIdentity().codeCommit, codeVersion: codeIdentity().codeVersion })
  const agentEntries = (claudeInstalled: boolean, codexInstalled: boolean) => [
    { id: "claude", label: "claude-haiku", display: "Claude Code (haiku)", host: "api.anthropic.com", installed: claudeInstalled },
    { id: "codex", label: "codex-luna", display: "Codex (luna)", host: "api.openai.com", installed: codexInstalled },
  ]

  it("the service reporting an empty chain is the PROBLEM even when this shell has both tools (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      ...selfIdentity(),
      summarizer: { mode: "agents", chosen: true, invalid: false, entries: agentEntries(true, true), chain: [] },
    })
    try {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        onPath: () => true,
        claudeSafeMode: () => false,
      })
      expect(lines.filter((line) => line.includes("no model can write Mida's summaries"))).toHaveLength(1)
      expect(lines.some((line) => line.includes("compile model is"))).toBe(false)
      expect(lines).toContain(
        "note: the running Mida service uses none; this shell would use claude-haiku, codex-luna. The service's answer is the one that counts.",
      )
    } finally {
      await closeServer(server)
    }
  })

  it("a service with only codex-luna is ok even when this shell has no tool at all (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      ...selfIdentity(),
      summarizer: { mode: "agents", chosen: true, invalid: false, entries: agentEntries(false, true), chain: ["codex-luna"] },
    })
    try {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        onPath: () => false,
      })
      expect(lines).toContain("ok: compile model is codex-luna")
      expect(lines).toContain(
        "note: the running Mida service uses codex-luna; this shell would use none. The service's answer is the one that counts.",
      )
      // the service's Claude is not installed, and the note says so in its own words
      expect(lines).toContain("note: Claude Code (haiku) is not installed, so Mida cannot use it.")
    } finally {
      await closeServer(server)
    }
  })

  it("with no service the lines are this shell's chain plus the not-running note (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: {},
      daemonProbeMs: 50,
      onPath: () => true,
      claudeSafeMode: () => false,
    })
    expect(lines).toContain("ok: compile model is claude-haiku")
    expect(lines).toContain("note: the Mida service is not running; the lines above describe what it would use if started from this shell.")
  })

  it("a service whose reply carries no summarizer field gets the did-not-say note (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true, ...selfIdentity() })
    try {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        onPath: () => true,
        claudeSafeMode: () => false,
      })
      expect(lines).toContain("ok: compile model is claude-haiku")
      expect(lines).toContain("note: the running Mida service did not say which model it uses; the lines above describe this shell.")
    } finally {
      await closeServer(server)
    }
  })

  it("the fallback clause names each fallback's host (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, {
      ok: true,
      ...selfIdentity(),
      summarizer: { mode: "agents", chosen: true, invalid: false, entries: agentEntries(true, true), chain: ["claude-haiku", "codex-luna"] },
    })
    try {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: {},
        env: {},
        daemonProbeMs: 50,
        onPath: () => true,
        claudeSafeMode: () => false,
      })
      expect(lines.some((line) => line.includes("a failed call falls back to codex-luna (api.openai.com)"))).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it("a saved custom choice with an empty MIDA_COMPILE_BASE_URL prints no needs line (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    writeSummarizer(home, { use: "key", provider: "custom", apiKey: "k", baseUrl: "https://x.example/v1", model: "m" })
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: { MIDA_COMPILE_BASE_URL: "" },
      daemonProbeMs: 50,
      onPath: () => true,
      claudeSafeMode: () => false,
    })
    expect(lines.some((line) => line.includes("MIDA_COMPILE_MODEL=custom needs"))).toBe(false)
  })

  it("the environment check lists every compile-provider variable — set or unset, never a value (M3-D5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: { DEEPSEEK_API_KEY: "deepseek-secret-value", MIDA_COMPILE_MODEL: "deepseek" },
      daemonProbeMs: 50,
    })
    const set = lines.find((line) => line.includes("environment — set:"))
    const unset = lines.find((line) => line.includes("environment — unset:"))
    expect(set).toBeDefined()
    expect(unset).toBeDefined()
    expect(set).toContain("DEEPSEEK_API_KEY")
    expect(set).toContain("MIDA_COMPILE_MODEL")
    for (const name of ["DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_TIMEOUT_MS", "KIMI_API_KEY", "MIDA_COMPILE_API_KEY", "MIDA_COMPILE_BASE_URL", "MIDA_COMPILE_MODEL_ID", "MIDA_COMPILE_TIMEOUT_MS", "MIDA_COMPILE_FALLBACK", "MIDA_CLAUDE_SUMMARY_MODEL", "MIDA_CODEX_SUMMARY_MODEL"]) {
      expect(unset).toContain(name)
    }
    // values never reach a doctor line
    expect(lines.join("\n")).not.toContain("deepseek-secret-value")
  })

  it("more than three whats-new timeouts in the last hour is a PROBLEM — fewer stays visible, none is ok", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const record = (at: string) => `${JSON.stringify({ at, event: "whatsnew-timeout", agent: "codex", sessionId: "s1" })}`
    mkdirSync(home.path("logs"), { recursive: true })
    // four give-ups inside the hour, plus one from two hours ago that must NOT count
    const recent = new Date(Date.now() - 10 * 60_000).toISOString()
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    writeFileSync(
      home.path("logs/hook.jsonl"),
      [record(recent), record(recent), record(recent), record(recent), record(old), ""].join("\n"),
    )
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    const line = lines.find((l) => l.includes("timing out"))
    expect(line).toBeDefined()
    expect(line).toContain("PROBLEM:")
    expect(line).toContain("the daemon may be unreachable")

    // three or fewer is a note with the count — silence is visible, but it is not a problem
    writeFileSync(home.path("logs/hook.jsonl"), [record(recent), record(recent), record(old), ""].join("\n"))
    const fewer: string[] = []
    await runDoctor({ home, print: (line) => fewer.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    const noteLine = fewer.find((l) => l.includes("timeout"))
    expect(noteLine).toBeDefined()
    expect(noteLine).not.toContain("PROBLEM:")
    expect(noteLine).toContain("2")
  })

  it("a listener that answers 404 is a PROBLEM naming the status — never 'ok: midad answers'", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 404, { error: "not-found" })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 500 })
      expect(lines).not.toContain("ok: midad answers")
      const daemonLine = lines.find((l) => l.includes("midad"))
      expect(daemonLine).toBeDefined()
      expect(daemonLine).toContain("PROBLEM:")
      expect(daemonLine).toContain("404")
    } finally {
      await closeServer(server)
    }
  })

  it("a 200 whose body does not say ok:true is still a PROBLEM naming the status", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: false })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 500 })
      expect(lines).not.toContain("ok: midad answers")
      const daemonLine = lines.find((l) => l.includes("midad"))
      expect(daemonLine).toContain("PROBLEM:")
      expect(daemonLine).toContain("200")
    } finally {
      await closeServer(server)
    }
  })

  it("a 200 with ok:true reports ok: midad answers", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const server = await stubDaemon(home, 200, { ok: true, pid: 1 })
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 500 })
      expect(lines).toContain("ok: midad answers")
    } finally {
      await closeServer(server)
    }
  })

  it("installed hooks report ok", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const config = join(dir(), "config.toml")
    installClaudeCode(settings)
    installCodex(config, { home: home.root })
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings, codex: config },
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines).toContain("ok: claude-code hooks installed")
    expect(lines).toContain("ok: codex hooks installed")
  })

  it("the Codex trust reminder prints whenever a managed block exists — installed, outdated or edited", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const config = join(dir(), "config.toml")
    installCodex(config, { home: home.root })
    const note = `note: ${CODEX_TRUST_SENTENCE}`
    for (const variant of ["installed", "outdated", "edited"] as const) {
      if (variant === "outdated") writeFileSync(config, `${CODEX_BLOCK_V1}\n`)
      if (variant === "edited") {
        writeFileSync(
          config,
          `${CODEX_BLOCK_V1}\n`.replace('command = "mida-hook codex"', 'command = "mida-hook codex --extra"'),
        )
      }
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: { codex: config }, env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(note)
      expect(lines.filter((l) => l === note)).toHaveLength(1)
    }
  })

  it("no managed block means nothing was written — the reminder stays away", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const config = join(dir(), "config.toml")
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: { codex: config }, env: {}, daemonProbeMs: 50 })
    expect(lines.some((line) => line.includes("Codex will ignore these hooks"))).toBe(false)
  })

  it("devin without ~/.config/devin prints nothing about it — not installed is not a problem", async () => {
    const home = new MidaHome(join(dir(), "home"))
    // the path names a directory that does not exist — Devin was never installed here
    const devinConfig = join(dir(), "devin", "config.json")
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: { devin: devinConfig }, env: {}, daemonProbeMs: 50 })
    expect(lines.some((line) => line.toLowerCase().includes("devin"))).toBe(false)
  })

  it("installed devin hooks report ok; a stale block reports the version problem", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const devinDir = join(dir(), "devin")
    mkdirSync(devinDir, { recursive: true })
    const devinConfig = join(devinDir, "config.json")
    installDevin(devinConfig)
    const run = async () => {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: { devin: devinConfig }, env: {}, daemonProbeMs: 50 })
      return lines
    }
    expect(await run()).toContain("ok: devin hooks installed")

    // an older block: every event still names a mida command, but none matches the pinned path
    const bare = (kind: "mida-hook" | "mida-inject") => ({ hooks: [{ type: "command", command: `${kind} devin` }] })
    writeFileSync(
      devinConfig,
      JSON.stringify({
        hooks: {
          SessionStart: [bare("mida-inject")],
          UserPromptSubmit: [bare("mida-inject")],
          PostToolUse: [bare("mida-hook")],
          Stop: [bare("mida-hook")],
          PostCompaction: [bare("mida-hook")],
          SessionEnd: [bare("mida-hook")],
        },
      }),
    )
    const lines = await run()
    expect(lines).toContain("PROBLEM: devin's hook block is an older version — run `mida install devin`")
  })

  it("one line per installed CLI tool reports its MCP server — the in-28 doctor lines", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), "claude.json")
    const config = join(dir(), "config.toml")
    const devinDir = join(dir(), "devin")
    mkdirSync(devinDir, { recursive: true })
    const devinConfig = join(devinDir, "config.json")
    installClaudeCode(settings)
    installCodex(config, { home: home.root, mcp: false })
    installDevin(devinConfig)
    const run = async () => {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: { "claude-code": settings, codex: config, devin: devinConfig },
        claudeUserConfig: userConfig,
        env: {},
        daemonProbeMs: 50,
      })
      return lines
    }
    // nothing installed for MCP yet: no claude user config, a hooks-only codex block, and a
    // devin this build cannot write a server for
    const bare = await run()
    expect(bare).toContain("note: claude-code MCP server not installed. Run mida install claude-code.")
    expect(bare).toContain("note: codex MCP server not installed. Run mida install codex.")
    // the devin note names the real limitation — no `mida install devin` can fix it (F-6)
    expect(bare).toContain("note: devin MCP server not installed. This build does not know where Devin keeps MCP servers.")
    expect(bare).not.toContain("ok: claude-code MCP server installed")
    expect(bare).not.toContain("ok: codex MCP server installed")

    // a `mida` entry in ~/.claude.json that is not Mida's still reports the note — the line
    // names the same is-it-ours state install would refuse on
    writeFileSync(
      userConfig,
      JSON.stringify({ mcpServers: { mida: { command: "/usr/bin/true", args: ["--as", "claude-code"], env: { MIDA_HOME: join(dir(), "other-home") } } } }),
    )
    expect(await run()).toContain("note: claude-code MCP server not installed. Run mida install claude-code.")

    // ours — the same JSON `mida install claude-code` hands to `claude mcp add-json`
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { mida: JSON.parse(claudeCodeMcpJson(home.root)) } }))
    // and the codex block gains its [mcp_servers.mida] table on a plain re-install
    installCodex(config, { home: home.root })
    const installed = await run()
    expect(installed).toContain("ok: claude-code MCP server installed")
    expect(installed).toContain("ok: codex MCP server installed")
    // devin's can never read ok under this build — its location is not known to it
    expect(installed).toContain("note: devin MCP server not installed. This build does not know where Devin keeps MCP servers.")
  })

  it("reads .claude.json under CLAUDE_CONFIG_DIR — the same file install wrote (F-3)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const claudeConfigDir = join(dir(), "claude-config")
    mkdirSync(claudeConfigDir, { recursive: true })
    installClaudeCode(settings)
    writeFileSync(
      join(claudeConfigDir, ".claude.json"),
      JSON.stringify({ mcpServers: { mida: JSON.parse(claudeCodeMcpJson(home.root)) } }),
    )
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings },
      env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      daemonProbeMs: 50,
    })
    expect(lines).toContain("ok: claude-code MCP server installed")
  })

  it("an ours entry with a stale launcher reports the different-copy note — and install repairs it (F-5)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const userConfig = join(dir(), "claude.json")
    installClaudeCode(settings)
    // our identity, our home — but a launcher from a checkout that has since moved
    const stale = { command: "/nonexistent/checkout/bin/mida-mcp", args: ["--as", "claude-code"], env: { MIDA_HOME: home.root } }
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { mida: stale } }))
    const run = async () => {
      const lines: string[] = []
      await runDoctor({
        home,
        print: (line) => lines.push(line),
        settings: { "claude-code": settings },
        claudeUserConfig: userConfig,
        env: {},
        daemonProbeMs: 50,
      })
      return lines
    }
    expect(await run()).toContain(
      "note: claude-code's MCP server starts a different copy of Mida than this one. Run mida install claude-code to point it here.",
    )
    // the repair is a real install through an injected claude — remove the stale entry, add ours
    const calls: string[][] = []
    const claude = (args: string[]) => {
      calls.push(args)
      const parsed = JSON.parse(readFileSync(userConfig, "utf8")) as { mcpServers: Record<string, unknown> }
      if (args[1] === "remove") delete parsed.mcpServers.mida
      if (args[1] === "add-json") parsed.mcpServers.mida = JSON.parse(args[5]!)
      writeFileSync(userConfig, JSON.stringify(parsed))
      return { status: 0 }
    }
    const installLines: string[] = []
    expect(
      runInstall(["install", "claude-code"], {
        print: (line) => installLines.push(line),
        claudeSettings: settings,
        codexConfig: join(dir(), "config.toml"),
        home,
        claudeUserConfig: userConfig,
        claudeCli: claude,
      }),
    ).toBe(0)
    expect(calls.map((a) => a[1])).toEqual(["remove", "add-json"])
    expect(await run()).toContain("ok: claude-code MCP server installed")
  })

  it("a tool without installed hooks gets no MCP line — the hook problem owns the fix", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const devinDir = join(dir(), "devin")
    mkdirSync(devinDir, { recursive: true })
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {
        "claude-code": join(dir(), "settings.json"),
        codex: join(dir(), "config.toml"),
        devin: join(devinDir, "config.json"),
      },
      claudeUserConfig: join(dir(), "claude.json"),
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines.some((line) => line.includes("MCP server"))).toBe(false)
  })

  it("a runtime without node:sqlite reports the devin PROBLEM — and stays silent without Devin", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const devinDir = join(dir(), "devin")
    mkdirSync(devinDir, { recursive: true })
    const devinConfig = join(devinDir, "config.json")
    installDevin(devinConfig)
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { devin: devinConfig },
      env: {},
      daemonProbeMs: 50,
      devinSqliteAvailable: () => false,
    })
    expect(lines.some((line) => line.startsWith("PROBLEM:") && line.includes("node:sqlite"))).toBe(true)

    const lines2: string[] = []
    await runDoctor({
      home,
      print: (line) => lines2.push(line),
      settings: { devin: join(dir(), "missing-dir", "config.json") },
      env: {},
      daemonProbeMs: 50,
      devinSqliteAvailable: () => false,
    })
    expect(lines2.some((line) => line.includes("node:sqlite"))).toBe(false)
  })

  it("an unreadable approved-projects file is a permissions problem — never a signature claim", async () => {
    const home = new MidaHome(join(dir(), "home"))
    // the check needs only the owner's address — the signature verify is local cryptography
    loadOrCreateOwnerSecrets(home)
    const list = home.path("approved-projects.json")
    writeFileSync(list, "{}")
    chmodSync(list, 0o000)
    try {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      const line = lines.find((l) => l.includes("approved-projects"))
      expect(line).toBeDefined()
      expect(line).toContain("could not be read")
      expect(line).toContain("permissions")
      expect(line).not.toContain("signature")
    } finally {
      chmodSync(list, 0o600)
    }
  })

  it("a bad-signature approved-projects file still names the signature check", async () => {
    const home = new MidaHome(join(dir(), "home"))
    loadOrCreateOwnerSecrets(home)
    home.writeSecretJson("approved-projects.json", { entries: [], signature: `0x${"ab".repeat(65)}` })
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain("PROBLEM: the approved-projects list failed its signature check — re-run `mida approve <agent>` in each project folder")
  })

  it("one ok line per project with every approved folder — a listed folder that is gone is a PROBLEM (lk-1)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const owner = privateKeyToAccount(loadOrCreateOwnerSecrets(home).privateKey).address
    const runtime = { home, owner } as unknown as Runtime
    const dirA = mkdtempSync(join(tmpdir(), "mida-docp-a-"))
    const dirB = mkdtempSync(join(tmpdir(), "mida-docp-b-"))
    const dirC = mkdtempSync(join(tmpdir(), "mida-docp-c-"))
    mkdirSync(join(dirA, ".mida"))
    writeFileSync(join(dirA, ".mida", "project.json"), JSON.stringify({ projectId: "ae3e5609-0000-4000-8000-000000000001" }))
    mkdirSync(join(dirC, ".mida"))
    writeFileSync(join(dirC, ".mida", "project.json"), JSON.stringify({ projectId: "bb000000-0000-4000-8000-000000000002" }))
    await approveProject(runtime, { agent: "claude-code", cwd: dirA })
    await approveProject(runtime, { agent: "claude-code", cwd: dirC })
    // link adds a second approved folder to project ae3e5609… — one project, two roots
    await linkProject(runtime, { projectId: "ae3e5609-0000-4000-8000-000000000001", dir: dirB })

    const run = async () => {
      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: {}, daemonProbeMs: 50 })
      return lines
    }
    const lines = await run()
    // one line per project on the list, each naming every folder its rows cover
    const projectLine = lines.find((l) => l.startsWith("ok: project ae3e5609…"))
    expect(projectLine).toBeDefined()
    expect(projectLine).toContain("2 folders")
    expect(projectLine).toContain(realpathSync(dirA))
    expect(projectLine).toContain(realpathSync(dirB))
    expect(lines).toContain(`ok: project bb000000… — 1 folder (${realpathSync(dirC)})`)

    // a listed folder disappears — the project line stays, the gone root becomes a PROBLEM with the fix
    const goneRoot = realpathSync(dirB)
    rmSync(dirB, { recursive: true, force: true })
    const after = await run()
    expect(after.some((l) => l.startsWith("ok: project ae3e5609…"))).toBe(true)
    const missing = after.find((l) => l.startsWith("PROBLEM:") && l.includes(goneRoot))
    expect(missing).toBeDefined()
    // the fix names a command that exists (in-16 B3): unlink inside a deleted folder is
    // impossible, and hand-editing the list breaks the owner signature — the flag form works
    expect(missing).toContain(`mida unlink --folder ${goneRoot}`)
    expect(missing).toContain("approved-projects.json")
  })

  it("names the API-key variables that are set — never their values", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: {},
      env: { ANTHROPIC_API_KEY: "sk-ant-secret-value", ANTHROPIC_AUTH_TOKEN: "tok-secret" },
      daemonProbeMs: 50,
    })
    const note = lines.find((line) => line.startsWith("note:") && line.includes("ANTHROPIC_API_KEY"))
    expect(note).toBeDefined()
    expect(note).toContain("ANTHROPIC_API_KEY")
    expect(note).toContain("ANTHROPIC_AUTH_TOKEN")
    expect(note).not.toContain("sk-ant-secret-value")
    expect(note).not.toContain("tok-secret")
    // notes are not problems: the note line never counts toward the exit code
    expect(lines.every((line) => !line.startsWith("note:") || !line.startsWith("PROBLEM:"))).toBe(true)
  })

  it("the hook binaries resolve absolutely — PATH is never consulted (R5-7)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const emptyPath = join(dir(), "empty-path")
    mkdirSync(emptyPath)
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), settings: {}, env: { PATH: emptyPath }, daemonProbeMs: 50 })
    const hook = lines.find((line) => line.includes("mida-hook resolves to"))
    const inject = lines.find((line) => line.includes("mida-inject resolves to"))
    const mcp = lines.find((line) => line.includes("mida-mcp resolves to"))
    expect(hook).toBeDefined()
    expect(inject).toBeDefined()
    expect(mcp).toBeDefined()
    expect(hook).toContain("ok:")
    expect(inject).toContain("ok:")
    expect(mcp).toContain("ok:")
    // the resolved path is absolute — the file the settings will name, not a PATH lookup
    for (const line of [hook, inject, mcp]) {
      expect(line).toMatch(/resolves to \//)
    }
    expect(lines.some((line) => line.includes("on your PATH"))).toBe(false)
  })

  it("a hook command pointing at a missing path is a PROBLEM naming the file (R5-7)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    // an absolute-path install whose files are gone — a moved or deleted checkout
    const goneHook = "/gone/hook-main.ts claude-code"
    const goneInject = "/gone/inject-main.ts claude-code"
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: goneInject }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: goneInject }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: goneHook }] }],
          Stop: [{ hooks: [{ type: "command", command: goneHook }] }],
          StopFailure: [{ hooks: [{ type: "command", command: goneHook }] }],
          PreCompact: [{ hooks: [{ type: "command", command: goneHook }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: goneHook }] }],
        },
      }),
    )
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings },
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines).toContain("PROBLEM: a claude-code hook points at /gone/hook-main.ts, which does not exist — run `mida install claude-code`")
    expect(lines).toContain("PROBLEM: a claude-code hook points at /gone/inject-main.ts, which does not exist — run `mida install claude-code`")
  })

  it("a bare-name install from before the absolute-path change reads outdated, with the reinstall fix (R5-7)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const legacy = (command: string) => [{ hooks: [{ type: "command", command }] }]
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: legacy("mida-inject claude-code"),
          UserPromptSubmit: legacy("mida-inject claude-code"),
          PostToolUse: legacy("mida-hook claude-code"),
          Stop: legacy("mida-hook claude-code"),
          StopFailure: legacy("mida-hook claude-code"),
          PreCompact: legacy("mida-hook claude-code"),
          SessionEnd: legacy("mida-hook claude-code"),
        },
      }),
    )
    const lines: string[] = []
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      settings: { "claude-code": settings },
      env: {},
      daemonProbeMs: 50,
    })
    expect(lines.some((line) => line.startsWith("PROBLEM: claude-code hooks point at an older command"))).toBe(true)
    // the bare name is reported once, by the outdated line — never as a separate path problem
    expect(lines.every((line) => !line.includes("runs the bare name"))).toBe(true)
    // and install upgrades the file to the absolute commands
    installClaudeCode(settings)
    await runDoctor({ home, print: (line) => lines.push(line), settings: { "claude-code": settings }, env: {}, daemonProbeMs: 50 })
    expect(lines).toContain("ok: claude-code hooks installed")
  })

  it("MIDA_CLAUDE_SETTINGS and MIDA_CODEX_CONFIG point the hooks check at throwaway settings files (R4-6)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const settings = join(dir(), "settings.json")
    const config = join(dir(), "config.toml")
    installClaudeCode(settings)
    installCodex(config, { home: home.root })
    const lines: string[] = []
    // no `settings` dep at all — the env vars name the files, as a throwaway-settings run does
    await runDoctor({
      home,
      print: (line) => lines.push(line),
      env: { MIDA_CLAUDE_SETTINGS: settings, MIDA_CODEX_CONFIG: config },
      daemonProbeMs: 50,
    })
    expect(lines).toContain("ok: claude-code hooks installed")
    expect(lines).toContain("ok: codex hooks installed")
  })

  // F8: the codex config doctor checks is the home `mida install codex` RECORDED — a
  // CODEX_HOME exported into the shell afterwards must not redirect the check. The real
  // `mida doctor` entry is spawned because the resolution lives in main's settings wiring.
  it("the real doctor checks the recorded Codex home, not the shell's CODEX_HOME (F8)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    // the recorded home holds a complete managed block…
    const recorded = mkdtempSync(join(tmpdir(), "mida-codex-recorded-"))
    installCodex(join(recorded, "config.toml"), { home: home.root })
    recordCodexHome(home, recorded)
    // …while the shell's CODEX_HOME points at a home with NO hooks
    const elsewhere = mkdtempSync(join(tmpdir(), "mida-codex-elsewhere-"))
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", tsxLoader, cliMainPath, "doctor"], {
        env: { HOME: mkdtempSync(join(tmpdir(), "mida-doctor-home-")), MIDA_HOME: home.root, CODEX_HOME: elsewhere, PATH: process.env.PATH ?? "" },
        cwd: "/tmp",
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")))
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")))
      child.on("error", reject)
      child.on("exit", (code) => done({ status: code, stdout, stderr }))
    })
    expect(res.stdout).toContain("ok: codex hooks installed")
    expect(res.stdout).not.toContain("codex hooks are not installed")
  }, 60_000)
})

describe("mida doctor --live", () => {
  it("refuses in CI before anything runs", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runDoctorLive("codex", {
      home,
      print: (line) => lines.push(line),
      env: { CI: "true" },
      stdinIsTTY: true,
    })
    expect(code).toBe(2)
    expect(lines).toEqual(["refused: live checks do not run in CI"])
  })

  it("refuses when stdin is not a TTY", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    const code = await runDoctorLive("claude-code", {
      home,
      print: (line) => lines.push(line),
      env: {},
      stdinIsTTY: false,
    })
    expect(code).toBe(2)
    expect(lines).toEqual(["refused: live checks need an interactive terminal"])
  })

  it("a refused --live replaces nothing — the stale-service check never runs (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    let replaced = 0
    const code = await runDoctorLive("codex", {
      home,
      print: (line) => lines.push(line),
      env: { CI: "true" },
      stdinIsTTY: true,
      replaceStaleService: async () => {
        replaced += 1
      },
    })
    expect(code).toBe(2)
    expect(lines).toEqual(["refused: live checks do not run in CI"])
    expect(replaced).toBe(0)
  })

  it("once the refusals pass, --live replaces a stale service before the session starts (UF-QC)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines: string[] = []
    let replaced = 0
    let sessions = 0
    const code = await runDoctorLive("codex", {
      home,
      print: (line) => lines.push(line),
      env: {},
      stdinIsTTY: true,
      watchMs: 50,
      replaceStaleService: async () => {
        replaced += 1
      },
      startSession: () => {
        sessions += 1
        return { stop() {} }
      },
    })
    expect(code).toBe(1)
    expect(replaced).toBe(1)
    expect(sessions).toBe(1)
  })
})

describe("mida doctor on a passkey home", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as `0x${string}`
  const QX = `0x${"ab".repeat(32)}` as `0x${string}`
  const QY = `0x${"cd".repeat(32)}` as `0x${string}`

  /** A stub JSON-RPC that scripts one answer: the point `ownerP256Key`'s eth_call returns. */
  async function stubRpc(point: { qx: bigint; qy: bigint } | null): Promise<{ url: string; close(): Promise<void> }> {
    const pointAnswer =
      point === null
        ? `0x${"00".repeat(64)}`
        : `0x${point.qx.toString(16).padStart(64, "0")}${point.qy.toString(16).padStart(64, "0")}`
    const server = createHttpServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string }
        const reply = (result: unknown) => {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
        }
        if (call.method === "eth_call") return reply(pointAnswer)
        if (call.method === "eth_getBalance") return reply("0x0")
        if (call.method === "eth_chainId") return reply("0x7a69")
        if (call.method === "eth_blockNumber") return reply("0x64")
        return reply("0x")
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const port = (server.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
  }

  const DEPLOYMENT = {
    chainId: "31337",
    capabilityRegistry: "0x2222222222222222222222222222222222222222",
    contextRegistry: "0x3333333333333333333333333333333333333333",
    deploymentBlock: "0",
    vaultRpId: "vault.mida.xyz",
    vaultRpIdHash: `0x${"55".repeat(32)}`,
    policyHashV1: `0x${"44".repeat(32)}`,
  }

  function passkeyHome(rpcUrl: string, withPublicKey: boolean): MidaHome {
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "passkey")
    saveOwnerAddress(home, OWNER, withPublicKey ? { x: QX, y: QY } : undefined)
    home.writeSecretJson("network.json", { rpcUrl, deployment: DEPLOYMENT })
    return home
  }

  function doctorLines(home: MidaHome, lines: string[]): Promise<number> {
    return runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
  }

  /** The lines the "owner" check printed — from its first line to the next check's output. */
  function ownerLines(lines: string[]): string[] {
    const start = lines.findIndex((line) => line.includes("owner is a passkey") || line.includes("passkey home has no owner"))
    if (start === -1) return []
    return lines.slice(start, start + 3)
  }

  it("reports the passkey owner, the matching on-chain key, and the remember note", async () => {
    const rpc = await stubRpc({ qx: BigInt(QX), qy: BigInt(QY) })
    const home = passkeyHome(rpc.url, true)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(ownerLines(lines)).toEqual([
        `ok: owner is a passkey (address ${OWNER}); no owner key on this machine`,
        "ok: owner passkey registered on chain (P-256 key matches)",
        "note: remember is not available with a passkey owner yet",
      ])
      expect(lines).toContain("ok: no wallets on this machine — only the passkey page signs owner sends")
      // doctor must never create or expect a software key
      expect(() => readFileSync(home.path("owner/secrets.json"), "utf8")).toThrow()
    } finally {
      await rpc.close()
    }
  })

  it("a registered key with no recorded point still reads ok — just without the match claim", async () => {
    const rpc = await stubRpc({ qx: BigInt(QX), qy: BigInt(QY) })
    const home = passkeyHome(rpc.url, false)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(ownerLines(lines)[1]).toBe("ok: owner passkey registered on chain")
    } finally {
      await rpc.close()
    }
  })

  it("no passkey on chain is a PROBLEM pointing at init --passkey", async () => {
    const rpc = await stubRpc(null)
    const home = passkeyHome(rpc.url, true)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(lines).toContain("PROBLEM: the chain holds no passkey for this owner — run `mida init --passkey`")
    } finally {
      await rpc.close()
    }
  })

  it("a different point on chain is a PROBLEM, not an ok", async () => {
    const rpc = await stubRpc({ qx: BigInt(`0x${"99".repeat(32)}`), qy: BigInt(QY) })
    const home = passkeyHome(rpc.url, true)
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(lines.some((line) => line.startsWith("PROBLEM: the passkey on chain is not the key this home registered"))).toBe(true)
      expect(lines.every((line) => !line.includes("P-256 key matches"))).toBe(true)
    } finally {
      await rpc.close()
    }
  })

  it("a passkey home with no owner address says so and points at init --passkey", async () => {
    const rpc = await stubRpc(null)
    const home = new MidaHome(join(dir(), "home"))
    saveOwnerMode(home, "passkey")
    home.writeSecretJson("network.json", { rpcUrl: rpc.url, deployment: DEPLOYMENT })
    try {
      const lines: string[] = []
      await doctorLines(home, lines)
      expect(lines).toContain("PROBLEM: this passkey home has no owner yet — run `mida init --passkey`")
    } finally {
      await rpc.close()
    }
  })
})

// Plan A Task 2: doctor resolves the network through the same rule every other entry point
// uses. A Sep-22-era network.json — contract + RPC and NO service URLs — means this setup ran
// the local store and paid its own gas, so doctor must never report or probe the hosted
// defaults as if the home used them.
describe("mida doctor on a saved home with no service URLs", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
  const X_RAW = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs/evidence/deployment-10143-vault.mida.xyz-2026-09-17.json"), "utf8"),
  ) as { capabilityRegistry: string }
  const Y = parseDeployment(
    JSON.parse(readFileSync(join(REPO_ROOT, "contracts/deployments/10143.json"), "utf8")),
  )
  const X_CAPREG = X_RAW.capabilityRegistry.toLowerCase()
  const short = (a: string) => `${a.slice(0, 6)}…`

  /** The Sep-22 home: saved before storage/sponsor URLs existed. A dead local port keeps the chain checks instant. */
  const sep22Home = () => {
    const home = new MidaHome(join(dir(), "home"))
    home.writeSecretJson("network.json", { chainId: 10143, rpcUrl: "http://127.0.0.1:1", deployment: X_RAW })
    return home
  }
  const doctorLines = async (home: MidaHome): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
    return lines
  }

  it("reports the local store and self-paid gas — never the hosted defaults", async () => {
    const lines = await doctorLines(sep22Home())
    expect(lines).toContain("ok: store: local (this setup saved no store address)")
    expect(lines).toContain("ok: sponsor: none — this setup pays its own gas")
    // no line may name the hosted store or sponsor — this home was never configured to them
    const output = lines.join("\n")
    expect(output).not.toContain("store.midacontext.xyz")
    expect(output).not.toContain("sponsor.midacontext.xyz")
    // and the sponsor probe itself is skipped — there is nothing to probe
    expect(lines.every((line) => !line.includes("gas sponsor reachable") && !line.includes("did not answer"))).toBe(true)
  })

  it("a setup saved on another contract names both records — a note, not a problem", async () => {
    const lines = await doctorLines(sep22Home())
    expect(lines).toContain("ok: network.json present")
    expect(lines).toContain(`contract ${short(X_CAPREG)}`)
    expect(lines).toContain(
      `note: this setup is on contract ${short(X_CAPREG)}; this version of Mida ships ${short(Y.capabilityRegistry.toLowerCase())} — run \`mida migrate\` to move`,
    )
    // the mismatch is a note because the setup still works — never a PROBLEM
    expect(lines.every((line) => !line.startsWith("PROBLEM: MIDA_DEPLOYMENTS_DIR"))).toBe(true)
  })
})

// in-6 R7: `mida doctor` names the RPC the process resolves — host and source only, because the
// URL's path or query can carry a provider's API key and doctor output is quoted into reports.
describe("mida doctor names the chain RPC — host and source only", () => {
  const X_RAW = JSON.parse(
    readFileSync(join(repo, "docs/evidence/deployment-10143-vault.mida.xyz-2026-09-17.json"), "utf8"),
  ) as { capabilityRegistry: string }

  const doctorLines = async (home: MidaHome, env: Record<string, string | undefined>): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), env, daemonProbeMs: 50 })
    return lines
  }

  it("a saved rpcUrl prints its host as (network.json) — and a key in the path never leaks", async () => {
    const home = new MidaHome(join(dir(), "home"))
    home.writeSecretJson("network.json", {
      rpcUrl: "http://127.0.0.1:1/v2/SECRET-API-KEY-0001?token=abcdef",
      deployment: X_RAW,
    })
    const lines = await doctorLines(home, {})
    expect(lines).toContain("ok: chain RPC 127.0.0.1:1 (network.json)")
    const output = lines.join("\n")
    expect(output).not.toContain("SECRET-API-KEY-0001")
    expect(output).not.toContain("abcdef")
    expect(output).not.toContain("/v2/")
  })

  it("MONAD_TESTNET_RPC beats the saved file and prints (environment)", async () => {
    const home = new MidaHome(join(dir(), "home"))
    home.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: X_RAW })
    const lines = await doctorLines(home, { MONAD_TESTNET_RPC: "https://provider.example/rpc/KEY-0002" })
    expect(lines).toContain("ok: chain RPC provider.example (environment)")
    expect(lines.join("\n")).not.toContain("KEY-0002")
  })

  it("a home with no network.json names the public default and prints the rate note", async () => {
    const home = new MidaHome(join(dir(), "home"))
    const lines = await doctorLines(home, {})
    expect(lines).toContain("ok: chain RPC testnet-rpc.monad.xyz (public default)")
    expect(lines).toContain(
      "note: the public Monad RPC allows about 15 requests a second; a provider URL in MONAD_TESTNET_RPC or network.json raises that",
    )
  })
})

// in-11 R-3: the hosted store deployed before in-3 has no /write-authority. Saves still work —
// the client proceeds as the pre-in-3 client did — but the owner needs the note telling them to
// redeploy for the pending-revoke check. The probe is unsigned: only a 404 means "no route".
describe("mida doctor names a store that predates the pending-revoke check", () => {
  const X_RAW = JSON.parse(
    readFileSync(join(repo, "docs/evidence/deployment-10143-vault.mida.xyz-2026-09-17.json"), "utf8"),
  ) as { capabilityRegistry: string }

  const stubStore = async (status: number, body: string, contentType = "text/plain"): Promise<{ url: string; host: string; close: () => Promise<void> }> => {
    const server = createHttpServer((request, response) => {
      response.writeHead(status, { "content-type": contentType })
      response.end(body)
    })
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { url, host: new URL(url).host, close: () => new Promise((done) => server.close(() => done())) }
  }

  const doctorLines = async (storageUrl: string): Promise<string[]> => {
    const home = new MidaHome(join(dir(), "home"))
    home.writeSecretJson("network.json", { rpcUrl: "http://127.0.0.1:1", deployment: X_RAW, storageUrl })
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
    return lines
  }

  it("a 404 on /write-authority prints the redeploy note naming the store host", async () => {
    const store = await stubStore(404, "404 Not Found")
    try {
      const lines = await doctorLines(store.url)
      expect(lines).toContain(`note: the store at ${store.host} predates the pending-revoke check — redeploy the store to enable the pending-revoke check`)
    } finally {
      await store.close()
    }
  })

  it("any other answer proves the route exists — a coded refusal counts", async () => {
    const store = await stubStore(401, JSON.stringify({ error: { code: "AUTH_INVALID", message: "missing signature" } }), "application/json")
    try {
      const lines = await doctorLines(store.url)
      expect(lines).toContain(`ok: the store at ${store.host} answers the pending-revoke check`)
      expect(lines.every((line) => !line.includes("predates the pending-revoke check"))).toBe(true)
    } finally {
      await store.close()
    }
  })
})

// in-15 J-7 — the same warning install prints, repeated for an entry that is already installed:
// a launcher under a macOS-protected folder cannot be spawned by the app, so the entry shows
// "Server disconnected". Platform and home are injected; nothing here touches the real ~/Library.
describe("mida doctor warns about an MCP launcher inside a macOS-protected folder (in-15 J-7)", () => {
  const writeConfig = (config: string, launcher: string, midaHome: string) => {
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          "mida-claude-desktop": {
            command: launcher,
            args: ["--as", "claude-desktop", "--project", "/work"],
            env: { MIDA_HOME: midaHome },
          },
        },
      }),
    )
  }

  const doctorLines = async (deps: { config: string; fakeHome: string; platform: NodeJS.Platform; home: MidaHome }): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({
      home: deps.home,
      print: (line) => lines.push(line),
      env: {},
      daemonProbeMs: 50,
      mcpConfigs: { "claude-desktop": deps.config, cursor: join(dir(), "no-cursor", "mcp.json") },
      homeDir: deps.fakeHome,
      platform: deps.platform,
    })
    return lines
  }

  it("an installed entry under ~/Desktop prints the fix; off macOS or outside the folders it is silent", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "mida-macos-home-"))
    const home = new MidaHome(join(dir(), "home"))
    const protectedLauncher = join(fakeHome, "Desktop", "mida-context", "bin", "mida-mcp")
    const config = join(dir(), "claude_desktop_config.json")
    writeConfig(config, protectedLauncher, home.root)

    const darwin = await doctorLines({ config, fakeHome, platform: "darwin", home })
    expect(darwin).toContain(
      `note: macOS protects ~/Desktop, ~/Documents and ~/Downloads — the mida-claude-desktop launcher ` +
        `is inside one at ${protectedLauncher}, so macOS may block Claude Desktop from running it: ` +
        `grant Claude Desktop access in System Settings → Privacy & Security → Files and Folders, or run Mida outside those folders`,
    )
    const linux = await doctorLines({ config, fakeHome, platform: "linux", home })
    expect(linux.every((line) => !line.includes("macOS protects"))).toBe(true)

    const outside = join(fakeHome, "opt", "mida", "bin", "mida-mcp")
    writeConfig(config, outside, home.root)
    const outsideLines = await doctorLines({ config, fakeHome, platform: "darwin", home })
    expect(outsideLines.every((line) => !line.includes("macOS protects"))).toBe(true)
  })

  it("an entry Mida did not write is not judged", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "mida-macos-home-"))
    const home = new MidaHome(join(dir(), "home"))
    const config = join(dir(), "claude_desktop_config.json")
    // a same-name entry belonging to another Mida home — doctor must not claim it
    writeConfig(config, join(fakeHome, "Desktop", "other", "bin", "mida-mcp"), "/some/other/home")
    const lines = await doctorLines({ config, fakeHome, platform: "darwin", home })
    expect(lines.every((line) => !line.includes("macOS protects"))).toBe(true)
  })
})

// in-15 J-3 — Sep 27 live: doctor printed "devin asked but is not approved — run mida approve
// devin" for a request whose five-minute window had already closed; approve then refused
// REQUEST_EXPIRED. The expired ask gets its own advice: a fresh request, then approve right away.
describe("mida doctor on an expired access request (in-15 J-3)", () => {
  const DEPLOYMENT = {
    chainId: "31337",
    capabilityRegistry: "0x2222222222222222222222222222222222222222",
    contextRegistry: "0x3333333333333333333333333333333333333333",
    deploymentBlock: "0",
    vaultRpId: "vault.mida.xyz",
    vaultRpIdHash: `0x${"55".repeat(32)}`,
    policyHashV1: `0x${"44".repeat(32)}`,
  }
  const AGENT_ID = `0x${"ab".repeat(32)}`

  /** A stub JSON-RPC chain: empty capability list for every agent, a scripted "latest" timestamp. */
  async function stubChain(latestTimestamp: bigint): Promise<{ url: string; close(): Promise<void> }> {
    const ACTIVE_IDS = toFunctionSelector("activeCapabilityIds(address,bytes32)")
    const OWNER_KEY = toFunctionSelector("ownerP256Key(address)")
    const server = createHttpServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] }
        const reply = (result: unknown) => {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
        }
        if (call.method === "eth_call") {
          const data = (call.params?.[0] as { data?: string } | undefined)?.data ?? ""
          if (data.startsWith(ACTIVE_IDS)) {
            // abi.encode(empty bytes32[]): offset 0x20, length 0
            return reply(`0x${"0".repeat(63)}20${"0".repeat(64)}`)
          }
          if (data.startsWith(OWNER_KEY)) return reply(`0x${"11".repeat(64)}`)
          return reply("0x")
        }
        if (call.method === "eth_getBlockByNumber") {
          return reply({
            number: "0x64",
            hash: `0x${"cd".repeat(32)}`,
            parentHash: `0x${"00".repeat(32)}`,
            nonce: "0x0000000000000000",
            sha3Uncles: `0x${"00".repeat(32)}`,
            logsBloom: `0x${"00".repeat(256)}`,
            transactionsRoot: `0x${"00".repeat(32)}`,
            stateRoot: `0x${"00".repeat(32)}`,
            receiptsRoot: `0x${"00".repeat(32)}`,
            miner: `0x${"00".repeat(20)}`,
            difficulty: "0x0",
            totalDifficulty: "0x0",
            extraData: "0x",
            size: "0x3e8",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            timestamp: `0x${latestTimestamp.toString(16)}`,
            transactions: [],
            uncles: [],
          })
        }
        if (call.method === "eth_getBalance") return reply("0x0")
        if (call.method === "eth_chainId") return reply("0x7a69")
        if (call.method === "eth_blockNumber") return reply("0x64")
        return reply("0x")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) }
  }

  /** A software home with devin set up and a pending request stamped `requestExpiresAt`. */
  function homeWithPending(rpcUrl: string, requestExpiresAt: bigint): MidaHome {
    const home = new MidaHome(join(dir(), "home"))
    loadOrCreateOwnerSecrets(home)
    const key = `0x${"ab".repeat(32)}`
    mkdirSync(join(home.root, "agents", "devin"), { recursive: true })
    writeFileSync(
      join(home.root, "agents", "devin", "identity.json"),
      JSON.stringify({
        name: "devin",
        agentId: AGENT_ID,
        signerPrivateKey: key,
        encryptionPrivateKey: key,
        encryptionPublicKey: key,
        manifestHash: key,
        callbackOrigin: "http://localhost",
        purposeId: "project_assistance",
        manifest: {},
      }),
    )
    home.writeSecretJson("agents/devin/pending-request.json", { request: { requestExpiresAt: encodeUint64(requestExpiresAt) } })
    home.writeSecretJson("network.json", { rpcUrl, deployment: DEPLOYMENT })
    return home
  }

  const doctorLines = async (home: MidaHome): Promise<string[]> => {
    const lines: string[] = []
    await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
    return lines
  }

  it("a request past its window gets request-then-approve advice, not the approve line", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000))
    const rpc = await stubChain(now)
    try {
      const lines = await doctorLines(homeWithPending(rpc.url, now - 1n))
      expect(lines).toContain(
        "PROBLEM: devin's access request expired (requests last 5 minutes) — run `mida request devin`, then `mida approve devin` right away",
      )
      expect(lines.every((line) => !line.includes("asked but is not approved on chain"))).toBe(true)
    } finally {
      await rpc.close()
    }
  })

  it("a request still inside its window keeps the approve line", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000))
    const rpc = await stubChain(now)
    try {
      const lines = await doctorLines(homeWithPending(rpc.url, now + 60n))
      expect(lines).toContain("PROBLEM: devin asked but is not approved on chain — run `mida approve devin`")
      expect(lines.every((line) => !line.includes("access request expired"))).toBe(true)
    } finally {
      await rpc.close()
    }
  })
})
