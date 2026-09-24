import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseError } from "viem"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, NEEDS_TERMINAL_LINE, Runtime, USAGE, loadAgentIdentity, ownerCommandNotice, runCli, runCliWithRuntime } from "@mida/midad"
import type { Network, ResolvedNetwork, ServiceRuntime } from "@mida/midad"

describe("the crude mida command", () => {
  let env: ScenarioEnvironment
  let network: Network
  let home: MidaHome
  const lines: string[] = []
  // the prompt dep stands in for a human typing at the terminal — every approve here answers yes —
  // and the terminal deps stand in for the real TTY the owner commands refuse to run without
  const run = (...argv: string[]) =>
    runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
    home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-")))
  }, 120_000)
  afterAll(async () => {
    await env?.stop()
  })

  it("rejects an unknown command, an unknown agent and a missing project with exit code 2", async () => {
    expect(await run("frobnicate")).toBe(2)
    expect(await run("approve", "cursor")).toBe(2)
    expect(await run("read", "codex")).toBe(2)
  })

  it("walks the whole demo: init, approve both, save, read, revoke, refused", async () => {
    expect(await run("init")).toBe(0)
    expect(await run("request", "claude-code")).toBe(0)
    expect(await run("approve", "claude-code")).toBe(0)
    expect(await run("save-demo", "claude-code", "proj-1")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(1)
    expect(await run("request", "codex")).toBe(0)
    expect(await run("approve", "codex")).toBe(0)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(await run("revoke", "claude-code")).toBe(0)
    expect(await run("read", "claude-code", "proj-1")).toBe(1)
    expect(await run("read", "codex", "proj-1")).toBe(0)
    expect(lines.some((line) => line.includes("CAPABILITY_REVOKED"))).toBe(true)
  }, 300_000)

  it("kicks the daemon after a successful approve and revoke so the service notices, and never otherwise", async () => {
    const kicks: string[] = []
    const kick = () => (kicks.push("x"), Promise.resolve())
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: () => {}, kickDaemon: kick, prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    // request grants nothing by itself — no kick
    expect(await run2("request", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(1)
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(kicks).toHaveLength(2)
    // a command that fails does not kick: claude-code has no pending request now
    expect(await run2("approve", "claude-code")).toBe(1)
    expect(kicks).toHaveLength(2)
    // undo the revoke so the last test's home still has a live agent
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve prints the ask and the advice, waits for 'yes', and signs nothing without it", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const answers: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => lines.push(line),
        prompt: async (question) => { asked.push(question); return answers.shift() ?? "" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code is live from the tests above; a fresh ask needs a revoked agent first
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    answers.push("no")
    expect(await run2("approve", "claude-code")).toBe(1)
    // the owner saw the request, the advisor's read on it, and the question — then declined
    expect(lines.some((line) => line.includes("claude-code is asking for"))).toBe(true)
    expect(lines.some((line) => line.includes("grant advisor"))).toBe(true)
    expect(asked).toEqual(["Type yes to approve: "])
    expect(lines).toContain("not approved")
    // nothing was signed: the pending request is still there, waiting
    expect(home.has("agents/claude-code/pending-request.json")).toBe(true)
    // an explicit yes signs
    answers.push("yes")
    expect(await run2("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("approve, revoke and remember refuse when there is no real terminal; init is exempt", async () => {
    const refusals: string[] = []
    const noStdin = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => refusals.push(line), prompt: async () => "yes", stdinIsTTY: false, stdoutIsTTY: true })
    const noStdout = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => refusals.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: false })
    expect(await noStdin("approve", "claude-code")).toBe(2)
    expect(await noStdin("revoke", "claude-code")).toBe(2)
    expect(await noStdin("remember", "a fact")).toBe(2)
    expect(await noStdout("approve", "claude-code")).toBe(2)
    expect(refusals.filter((line) => line === NEEDS_TERMINAL_LINE)).toHaveLength(4)
    // init changes no agent's access, so it may run without a terminal
    expect(await noStdin("init")).toBe(0)
  }, 300_000)

  it("the yes-prompt drains whatever was already buffered before it asks, then waits for a fresh answer (R4-10)", async () => {
    const order: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: () => {},
        drainInput: async () => { order.push("drain") },
        prompt: async () => { order.push("prompt"); return "yes" },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // a fresh ask needs a revoked-then-requested agent
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    expect(await run2("approve", "claude-code")).toBe(0)
    // the drain ran before the question was printed — input pasted while approve ran is dropped
    expect(order).toEqual(["drain", "prompt"])
  }, 300_000)

  it("MIDA_DEBUG=1 prints a masked debug line on failure; unset prints nothing extra (R4-8)", async () => {
    const hex = `0x${"ab".repeat(40)}`
    const failingPrompt = async () => {
      throw new Error(`execution reverted: ${hex} with more data`)
    }
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => out.push(line),
        drainInput: async () => {},
        prompt: failingPrompt,
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    // claude-code was approved by the test above — a fresh ask needs it revoked and re-requested
    expect(await run2("revoke", "claude-code")).toBe(0)
    expect(await run2("request", "claude-code")).toBe(0)
    const prev = process.env.MIDA_DEBUG
    try {
      process.env.MIDA_DEBUG = "1"
      out.length = 0
      expect(await run2("approve", "claude-code")).toBe(1)
      const debug = out.find((line) => line.startsWith("debug:"))
      expect(debug).toBeDefined()
      expect(debug).toContain("<hex>")
      expect(debug).not.toContain(hex)
      expect(out.some((line) => line.startsWith("refused:"))).toBe(true)
      delete process.env.MIDA_DEBUG
      out.length = 0
      expect(await run2("approve", "claude-code")).toBe(1)
      expect(out.every((line) => !line.startsWith("debug:"))).toBe(true)
      expect(out.join("\n")).not.toContain(hex)
    } finally {
      if (prev === undefined) delete process.env.MIDA_DEBUG
      else process.env.MIDA_DEBUG = prev
    }
    // restore: the pending request is still waiting — approve it for real
    expect(await run("approve", "claude-code")).toBe(0)
  }, 300_000)

  it("remember names the context area before the ask and after the write, and waits for a typed yes (R5-3)", async () => {
    const lines: string[] = []
    const asked: string[] = []
    const order: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home, network,
        print: (line) => {
          lines.push(line)
          if (line.startsWith("area:")) order.push("area")
        },
        prompt: async (question) => {
          asked.push(question)
          order.push("prompt")
          return "yes"
        },
        stdinIsTTY: true, stdoutIsTTY: true,
      })
    expect(await run2("remember", "prefers short answers")).toBe(0)
    // the owner saw WHERE the fact will live before being asked to confirm, and again after it landed
    expect(lines).toContain("area: preferences.communication (agents with READ on this area will see it)")
    expect(asked).toEqual(["Type yes to remember: "])
    expect(lines.at(-1)).toMatch(/^remembered 0x[0-9a-f]{64} in preferences\.communication$/)
    expect(order).toEqual(["area", "prompt", "area"])
  }, 300_000)

  it("an answer other than yes stores nothing (R5-3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "no", stdinIsTTY: true, stdoutIsTTY: true })
    expect(await run2("remember", "should never be stored")).toBe(1)
    expect(lines).toContain("area: preferences.communication (agents with READ on this area will see it)")
    expect(lines.some((line) => line.startsWith("remembered "))).toBe(false)
    // and the declined fact is really not there to read back
    lines.length = 0
    expect(await run2("read", "--as", "claude-code")).toBe(0)
    expect(lines.join("\n")).not.toContain("should never be stored")
  }, 300_000)

  it("mida read labels every item with the context area it lives in (R5-3)", async () => {
    const lines: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, { home, network, print: (line) => lines.push(line), prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true })
    // a fact from the remember test above, labelled with its area
    expect(await run2("read", "--as", "claude-code")).toBe(0)
    expect(lines).toContain("  preferences.communication: prefers short answers")
    // checkpoints carry their area too — resolved from the record's namespace id
    expect(await run2("save-demo", "claude-code", "proj-areas")).toBe(0)
    lines.length = 0
    expect(await run2("read", "claude-code", "proj-areas")).toBe(0)
    expect(lines.some((line) => /^  projects\.current: 0x[0-9a-f]{64} written by /.test(line))).toBe(true)
  }, 300_000)

  it("a namespace id the tree cannot name prints its first ten characters, never nothing (R5-3)", async () => {
    const { namespaceLabel } = await import("@mida/midad")
    const { namespaceId } = await import("@mida/protocol")
    expect(namespaceLabel(namespaceId("projects.current"))).toBe("projects.current")
    const foreign = `0x${"f1".repeat(32)}`
    expect(namespaceLabel(foreign)).toBe("0xf1f1f1f1…")
  })

  it("a refused wrap for one agent never hides the landed revoke — chain line first, then per-agent key lines (M3-D4)", async () => {
    // The Sep-22 incident: a revoke that failed after staging its deny left codex store-blocked,
    // and the NEXT revoke's repair pass aborted on codex's refused wrap — assistant never got the
    // new key and the printed line read "refused" for a revoke that had succeeded on chain.
    const runtime = await Runtime.open(home, network)
    try {
      const codexId = loadAgentIdentity(home, "codex")!.agentId
      await runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId: codexId })
    } finally {
      await runtime.close()
    }

    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        print: (line) => out.push(line),
        progress: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    // the chain revoke succeeds — the exit code says so even though one wrap is refused
    expect(await run2("revoke", "claude-code")).toBe(0)
    // the chain answer leads: before any per-agent key line, and it is not "refused"
    const chainLine = out.findIndex((line) => line.startsWith("revoked claude-code on chain"))
    expect(chainLine).toBeGreaterThanOrEqual(0)
    expect(out[chainLine]).toMatch(/— tx 0x[0-9a-f]{64}/)
    // assistant got the new key; codex's refused wrap names its fix — and nothing calls the whole
    // revoke refused
    expect(out).toContain("new read key sent to assistant")
    const failedLine = out.find((line) => line.startsWith("could not send the new key to codex:"))
    expect(failedLine).toBeDefined()
    expect(failedLine).toContain("run `mida approve codex`")
    expect(out.every((line) => !line.startsWith("refused:"))).toBe(true)
    for (const keyLine of ["new read key sent to assistant", failedLine!]) {
      expect(out.indexOf(keyLine)).toBeGreaterThan(chainLine)
    }

    // cleanup, by the command the line itself names: approve clears the stale deny
    expect(await run2("approve", "codex")).toBe(1) // already-approved answer — the deny is gone first
    expect(out.some((line) => line === "cleared a stale block at the store left by a failed revoke")).toBe(true)
    // and claude-code's revoke really did land — reads stay refused
    expect(await run2("read", "claude-code", "proj-1")).toBe(1)
  }, 300_000)

  it("an already-approved approve says what the folder listing did — never 'run the command you just ran' (M3-D4)", async () => {
    // The Sep-22 incident's second lie: approve answered "already approved — to use THIS folder,
    // run mida approve codex here", naming the very command that was just run. Now the line says
    // whether the folder's list row was added or was already there.
    const dir = mkdtempSync(join(tmpdir(), "mida-proj-"))
    const out: string[] = []
    const run2 = (...argv: string[]) =>
      runCli(argv, {
        home,
        network,
        cwd: dir,
        print: (line) => out.push(line),
        progress: (line) => out.push(line),
        prompt: async () => "yes",
        stdinIsTTY: true,
        stdoutIsTTY: true,
      })
    expect(await run2("approve", "codex")).toBe(0)
    expect(out).toContain("codex is already approved on chain. This folder is now approved for codex too (no transaction).")
    out.length = 0
    expect(await run2("approve", "codex")).toBe(0)
    expect(out).toContain("codex is already approved on chain. This folder was already approved for codex.")
    // and neither answer tells the owner to re-run the command they just ran
    expect(out.every((line) => !line.includes("run `mida approve codex` here"))).toBe(true)
  }, 300_000)

  it("migrate is an owner command: a real terminal is required and the daemon socket refuses it", async () => {
    const out: string[] = []
    const noTty = (...argv: string[]) =>
      runCli(argv, {
        home, network, print: (line) => out.push(line), prompt: async () => "yes",
        stdinIsTTY: false, stdoutIsTTY: true, env: {}, migrateTarget: env.deployment, startService: () => {},
      })
    expect(await noTty("migrate")).toBe(2)
    expect(await noTty("migrate", "--undo")).toBe(2)
    expect(out.filter((line) => line === NEEDS_TERMINAL_LINE)).toHaveLength(2)
    // through the daemon's /cli route it is refused like every owner command
    const refused: string[] = []
    const stub = { home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-stub-"))) } as unknown as ServiceRuntime
    expect(await runCliWithRuntime(["migrate"], stub, (line) => refused.push(line))).toBe(2)
    expect(refused[0]).toContain("mida migrate")
    expect(await runCliWithRuntime(["migrate", "--undo"], stub, () => {})).toBe(2)
    // a flag it does not know is usage, not a half-run
    expect(await run("migrate", "--sideways")).toBe(2)
  })

  it("mida migrate says there is nothing to move when the saved contract is already the target", async () => {
    const out: string[] = []
    const code = await runCli(["migrate"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      env: {}, migrateTarget: env.deployment, startService: () => {},
    })
    expect(code).toBe(0)
    expect(out.join("\n")).toContain("nothing to move")
  }, 300_000)

  it("mida migrate --undo refuses when no backup exists", async () => {
    const out: string[] = []
    const code = await runCli(["migrate", "--undo"], {
      home, network, print: (line) => out.push(line),
      prompt: async () => "yes", stdinIsTTY: true, stdoutIsTTY: true,
      env: {}, migrateTarget: env.deployment, startService: () => {},
    })
    expect(code).toBe(1)
    expect(out.join("\n").toLowerCase()).toContain("backup")
  }, 300_000)

  it("a mismatched setup tells migrate what it is moving — never 'run mida migrate' — while other commands keep the old notice", () => {
    const resolved = {
      network: {}, saved: true, contractSource: "network.json", builtIn: {},
      mismatch: {
        saved: "0xaaaa00000000000000000000000000000000aa",
        builtIn: "0xbbbb00000000000000000000000000000000bb",
      },
      storage: { url: undefined, source: "local" },
      sponsor: { url: undefined, source: "local" },
    } as unknown as ResolvedNetwork
    const move = ownerCommandNotice(resolved, "migrate")
    expect(move).toBe("moving this setup from contract 0xaaaa… to 0xbbbb…")
    expect(move).not.toContain("mida migrate")
    // every other owner command still hears the pointer to migrate
    const other = ownerCommandNotice(resolved, "approve")
    expect(other).toContain("run `mida migrate`")
    // and a setup that matches the built-in contract hears nothing at all
    expect(ownerCommandNotice({ ...resolved, mismatch: undefined } as ResolvedNetwork, "migrate")).toBeUndefined()
  })

  it("never prints a secret: no output line contains any key stored in the home folder", () => {
    const secrets: string[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder)) {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== "data") walk(full)
        } else if (/secrets|signer|identity/.test(entry)) {
          const text = readFileSync(full, "utf8")
          for (const match of text.matchAll(/"(?:privateKey|seed|p256PrivateKey|signerPrivateKey|encryptionPrivateKey)":\s*"(0x[0-9a-f]{64})"/g)) secrets.push(match[1]!)
        }
      }
    }
    walk(home.root)
    expect(secrets.length).toBeGreaterThanOrEqual(8)
    const output = lines.join("\n")
    for (const secret of secrets) expect(output.includes(secret)).toBe(false)
  })
})

/**
 * CHAIN-09 — the Sep 22 incident: `mida request claude-code` printed `refused: ERROR` and nothing
 * else because the chain call had failed with an error Mida did not recognise. Now a chain error
 * names the setup's contract and the flag that shows why; a debug context appends the masked line.
 */
describe("named refusals on agent commands (CHAIN-09)", () => {
  const REGISTRY = "0xf07d000000000000000000000000000000000042"
  const stubRuntime = (thrown: unknown) =>
    ({
      home: new MidaHome(mkdtempSync(join(tmpdir(), "mida-cli-refusal-"))),
      chain: { deployment: { capabilityRegistry: REGISTRY } },
      agent: () => {
        throw thrown
      },
    }) as unknown as ServiceRuntime

  it("a chain error prints the contract line, never refused: ERROR", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new BaseError("boom")), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      "the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why",
    ])
    expect(lines.join("\n")).not.toContain("ERROR")
  })

  it("a non-chain error is refused: UNEXPECTED, never refused: ERROR", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["request", "claude-code"], stubRuntime(new Error("weird")), (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual(["refused: UNEXPECTED"])
  })

  it("with debug on, the catch also prints exactly one masked debug: line", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(
      ["request", "claude-code"],
      stubRuntime(new BaseError("boom")),
      (line) => lines.push(line),
      { debug: true },
    )
    expect(code).toBe(1)
    expect(lines.filter((line) => line.startsWith("debug:"))).toHaveLength(1)
    expect(lines[0]).toBe("the chain call failed — this setup's contract is 0xf07d…; run with MIDA_DEBUG=1 to see why")
    expect(lines[1]).toBe("debug: BaseError | boom")
  })

  it("without debug there is no debug: line and no error message", async () => {
    const lines: string[] = []
    await runCliWithRuntime(["request", "claude-code"], stubRuntime(new BaseError("a secret reason")), (line) => lines.push(line), {
      debug: false,
    })
    expect(lines.every((line) => !line.startsWith("debug:"))).toBe(true)
    expect(lines.join("\n")).not.toContain("a secret reason")
  })

  it("mida read --as <unregistered> prints the no-identity line, not a bare code", async () => {
    const stub = stubRuntime(new Error("unreached"))
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "ghost", "projects.current"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([`Mida: no agent "ghost" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
    expect(lines.every((line) => !line.startsWith("refused:"))).toBe(true)
  })

  it("mida read --as <corrupt identity> says the file exists but cannot be read — never 'not set up'", async () => {
    const stub = stubRuntime(new Error("unreached"))
    mkdirSync(join(stub.home.root, "agents", "corrupt"), { recursive: true })
    writeFileSync(join(stub.home.root, "agents", "corrupt", "identity.json"), "not json")
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "corrupt", "projects.current"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([
      `Mida: corrupt's identity in this Mida home (${stub.home.root}) exists but could not be read. Nothing was shared. Run \`mida doctor\`.`,
    ])
  })

  it("an agent name that cannot be an identity is still usage — never read under it", async () => {
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "--as", "a b"], stubRuntime(new Error("unreached")), (line) => lines.push(line))
    expect(code).toBe(2)
    expect(lines).toEqual([USAGE])
  })

  it("a read whose agent's identity is gone prints the same no-identity line", async () => {
    const notSetup = Object.assign(new Error("gone"), { code: "agent-not-setup" })
    const stub = stubRuntime(notSetup)
    const lines: string[] = []
    const code = await runCliWithRuntime(["read", "codex", "p1"], stub, (line) => lines.push(line))
    expect(code).toBe(1)
    expect(lines).toEqual([`Mida: no agent "codex" is set up in this Mida home (${stub.home.root}). Nothing was shared.`])
  })
})
