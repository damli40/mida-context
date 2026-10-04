import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaError } from "@mida/protocol"
import type { AccessRequest } from "@mida/protocol"
import { increaseLocalTime } from "@mida/chain"
import { TimeoutError } from "viem"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import { MidaHome, Runtime, expectedScopesFor, init, loadAgentIdentity, loadGrants, migrateToleratesApprovalRefusal, ownerRefusalLine, readOwnerFacts, remember, runCli, runDoctor } from "@mida/midad"
import type { Network } from "@mida/midad"

const STEP_TIMEOUT = 60_000

const INIT_GRANT_REQUEST = "agents/assistant/init-grant-request.json"
const RECOVERY_LINE =
  "assistant's approval was already on chain from an earlier try. Mida finished recording it on this machine (no transaction)."
const UNRECORDED_LINE =
  "assistant is approved on chain, but this machine never finished recording that approval, so assistant cannot read. Run mida revoke assistant, then mida init."
const DOCTOR_INIT_LINE =
  "PROBLEM: assistant is approved on chain, but this machine never finished recording that approval, so assistant cannot read. Run mida init to finish it."
const DOCTOR_REVOKE_LINE =
  "PROBLEM: assistant is approved on chain, but this machine never finished recording that approval, so assistant cannot read. Run mida revoke assistant, then mida init."
const APPROVE_LINE = "assistant's grant is sent by mida init, not approve. Run mida init to finish recording it."

/**
 * UF-APR7's lost-reply seam (the same shape the review's T4 uses): the grant transaction really
 * lands — the caller only sees a failure whose reply was lost. Reader wraps are held back for
 * the failed attempt, so the state afterwards is exactly "approved on chain, nothing recorded,
 * no read keys sent". Since UF-APR7B R4 init answers that state with approve's landed-
 * but-unconfirmed line, the tests expect that sentence — not the sponsor's raw code.
 */
const LANDED_LINE = "the grant for assistant landed on Monad"
function loseReplyAfterSend(runtime: Runtime): () => void {
  const vault = runtime.vault as unknown as {
    approveGrant: (input: never) => Promise<unknown>
    publishReaderWraps: (input: never) => Promise<unknown>
  }
  const realApprove = vault.approveGrant.bind(runtime.vault)
  const realWraps = vault.publishReaderWraps.bind(runtime.vault)
  vault.publishReaderWraps = (async () => []) as never
  vault.approveGrant = (async (input: never) => {
    await realApprove(input)
    throw new MidaError("SPONSOR_PENDING", "the bundler accepted the operation but the receipt never arrived")
  }) as never
  return () => {
    vault.approveGrant = realApprove
    vault.publishReaderWraps = realWraps
  }
}

describe("mida init finishes the assistant's landed grant after a lost reply (UF-APR7)", () => {
  let env: ScenarioEnvironment
  let network: Network

  const open = async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-apr7-")))
    const progress: string[] = []
    const runtime = await Runtime.open(home, network)
    runtime.progress = (line) => progress.push(line)
    return { home, runtime, progress }
  }

  /** Sends the owner's own context makes — the count a "no transaction" claim is measured by. */
  const ownerNonce = (runtime: Runtime) => runtime.ownerChain.publicClient.getTransactionCount({ address: runtime.owner })

  beforeAll(async () => {
    env = await localEnvironment()
    network = { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund }
  }, 600_000)

  afterAll(async () => {
    await env?.stop()
  })

  it("the re-run finishes a grant that landed before the reply was lost — no transaction, the assistant reads, doctor says ok", async () => {
    const { home, runtime, progress } = await open()
    try {
      // a real init first so a fact can be written BEFORE the failure the test stages
      await init(runtime, ["claude-code"])
      expect((await remember(runtime, "the fact written before the failure")).kind).toBe("remembered")
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      expect(home.has(INIT_GRANT_REQUEST)).toBe(true)
      expect(home.has("agents/assistant/grants.json")).toBe(false)

      const sendsBefore = await ownerNonce(runtime)
      progress.length = 0
      await init(runtime, ["assistant"])

      expect(await ownerNonce(runtime)).toBe(sendsBefore)
      expect(progress).toContain(RECOVERY_LINE)
      expect(home.has(INIT_GRANT_REQUEST)).toBe(false)
      expect(loadGrants(home, "assistant")).toHaveLength(1)
      const facts = await readOwnerFacts(runtime, "assistant")
      expect(facts.some((fact) => fact.text === "the fact written before the failure")).toBe(true)

      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
      expect(lines).toContain("ok: assistant approved")
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("the re-run still finishes it an hour of chain time later — the request's own window decides the log search", async () => {
    const { home, runtime, progress } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      expect(home.has(INIT_GRANT_REQUEST)).toBe(true)
      await increaseLocalTime(env.rpcUrl, 3600n) // requests last 5 minutes — the request is long dead
      await init(runtime, ["assistant"])
      expect(progress).toContain(RECOVERY_LINE)
      expect(loadGrants(home, "assistant")).toHaveLength(1)
      expect(home.has(INIT_GRANT_REQUEST)).toBe(false)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("with no saved request the re-run says it never finished recording, sends nothing, and doctor names revoke then init", async () => {
    const { home, runtime, progress } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      home.remove(INIT_GRANT_REQUEST) // a home that hit this before init saved the request

      const sendsBefore = await ownerNonce(runtime)
      await init(runtime, ["assistant"])
      expect(await ownerNonce(runtime)).toBe(sendsBefore)
      expect(progress).toContain(UNRECORDED_LINE)
      expect(home.has("agents/assistant/grants.json")).toBe(false)

      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
      expect(lines).toContain(DOCTOR_REVOKE_LINE)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("a clean init leaves no saved request behind, and a second init is silent about assistant and sends nothing", async () => {
    const { home, runtime, progress } = await open()
    try {
      await init(runtime, ["assistant"])
      expect(home.has(INIT_GRANT_REQUEST)).toBe(false)
      expect(loadGrants(home, "assistant")).toHaveLength(1)

      const sendsBefore = await ownerNonce(runtime)
      progress.length = 0
      await init(runtime, ["assistant"])
      expect(await ownerNonce(runtime)).toBe(sendsBefore)
      expect(progress.some((line) => line.includes("assistant"))).toBe(false)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("the assistant never appears as a pending project request — approve --all neither lists nor approves it", async () => {
    const { home, runtime } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      expect(home.has(INIT_GRANT_REQUEST)).toBe(true)
      expect(home.has("agents/assistant/pending-request.json")).toBe(false)
    } finally {
      await runtime.close() // runCli opens its own runtime; the home lock allows only one
    }
    const workDir = mkdtempSync(join(tmpdir(), "mida-apr7-work-"))
    const out: string[] = []
    await runCli(["approve", "--all"], {
      home,
      network,
      cwd: workDir,
      print: (line) => out.push(line),
      prompt: async () => "yes",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })
    expect(out.some((line) => line.includes("assistant"))).toBe(false)
    expect(home.has("agents/assistant/grants.json")).toBe(false)
  }, STEP_TIMEOUT)

  it("doctor names the repair by whether the saved request exists — `mida init` with it, revoke then init without it", async () => {
    const { home, runtime } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()

      const withRequest: string[] = []
      await runDoctor({ home, print: (line) => withRequest.push(line), env: {}, daemonProbeMs: 50 })
      expect(withRequest).toContain(DOCTOR_INIT_LINE)
      expect(withRequest).not.toContain(DOCTOR_REVOKE_LINE)

      home.remove(INIT_GRANT_REQUEST)
      const withoutRequest: string[] = []
      await runDoctor({ home, print: (line) => withoutRequest.push(line), env: {}, daemonProbeMs: 50 })
      expect(withoutRequest).toContain(DOCTOR_REVOKE_LINE)
      expect(withoutRequest).not.toContain(DOCTOR_INIT_LINE)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("approve, doctor and init all name revoke-then-init when the saved request is unusable (R1)", async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-apr7-")))
    const progress: string[] = []
    const openRuntime = async () => {
      const rt = await Runtime.open(home, network)
      rt.progress = (line) => progress.push(line)
      return rt
    }
    let runtime = await openRuntime()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      const savedRequest = home.readJson<{ request: AccessRequest }>(INIT_GRANT_REQUEST)!.request

      const workDir = mkdtempSync(join(tmpdir(), "mida-apr7-work-"))
      const cases = [
        ["no saved request", () => home.remove(INIT_GRANT_REQUEST)],
        ["a corrupt saved file", () => writeFileSync(home.path(INIT_GRANT_REQUEST), "not json")],
        ["a request list for another agentId", () => home.writeSecretJson(INIT_GRANT_REQUEST, { requests: [{ agentId: `0x${"1".repeat(64)}` }] })],
        ["a saved request for another agentId", () => home.writeSecretJson(INIT_GRANT_REQUEST, { request: { ...savedRequest, agentId: `0x${"1".repeat(64)}` } })],
        ["an empty request list", () => home.writeSecretJson(INIT_GRANT_REQUEST, { requests: [] })],
      ] as const
      for (const [, setFile] of cases) {
        setFile()
        progress.length = 0
        await init(runtime, ["assistant"])
        expect(progress).toContain(UNRECORDED_LINE)
        expect(home.has("agents/assistant/grants.json")).toBe(false)

        const lines: string[] = []
        await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
        expect(lines).toContain(DOCTOR_REVOKE_LINE)
        expect(lines).not.toContain(DOCTOR_INIT_LINE)

        await runtime.close()
        const out: string[] = []
        const code = await runCli(["approve", "assistant"], {
          home,
          network,
          cwd: workDir,
          print: (line) => out.push(line),
          prompt: async () => "yes",
          stdinIsTTY: true,
          stdoutIsTTY: true,
        })
        expect(code).toBe(1)
        expect(out).toContain(UNRECORDED_LINE)
        expect(out).not.toContain(APPROVE_LINE)
        runtime = await openRuntime()
      }
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT * 3)

  it("keeps every unfinished request — a request that lands after the re-run still finishes (R2)", async () => {
    const { home, runtime, progress } = await open()
    try {
      const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
      const realApprove = vault.approveGrant.bind(runtime.vault)
      // a sponsor that accepts the operation then loses every reply WITHOUT anything landing:
      // each re-run signs a fresh request — and must not overwrite the one still in flight
      vault.approveGrant = (async () => {
        throw new MidaError("SPONSOR_PENDING", "the bundler accepted the operation but the receipt never arrived")
      }) as never
      await expect(init(runtime, ["assistant"])).rejects.toThrow("SPONSOR_PENDING")
      await expect(init(runtime, ["assistant"])).rejects.toThrow("SPONSOR_PENDING")

      const saved = home.readJson<{ request?: AccessRequest; requests?: AccessRequest[] }>(INIT_GRANT_REQUEST)!
      const requests = saved.requests ?? (saved.request === undefined ? [] : [saved.request])
      expect(requests).toHaveLength(2)
      const [first, second] = requests
      expect(first!.requestId).not.toBe(second!.requestId)

      // the first request's grant lands only now — the second never does
      const identity = loadAgentIdentity(home, "assistant")!
      await realApprove({ accessRequest: first, manifest: identity.manifest, selection: { kind: "recommended" } } as never)
      vault.approveGrant = realApprove

      const sendsBefore = await ownerNonce(runtime)
      progress.length = 0
      await init(runtime, ["assistant"])
      expect(await ownerNonce(runtime)).toBe(sendsBefore)
      expect(progress).toContain(RECOVERY_LINE)
      expect(loadGrants(home, "assistant").some((grant) => grant.requestId === first!.requestId)).toBe(true)
      expect(home.has(INIT_GRANT_REQUEST)).toBe(false)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("finishes the live half of a partly-live grant, then grants the missing half (R3)", async () => {
    const { home, runtime, progress } = await open()
    try {
      const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
      const realApprove = vault.approveGrant.bind(runtime.vault)
      // the first send's reply is lost without anything landing — the request for both scopes
      // is left on disk, nothing on chain
      vault.approveGrant = (async () => {
        throw new MidaError("SPONSOR_PENDING", "the bundler accepted the operation but the receipt never arrived")
      }) as never
      await expect(init(runtime, ["assistant"])).rejects.toThrow("SPONSOR_PENDING")

      // a request covering only the first expected scope lands — the other half stays missing
      const identity = loadAgentIdentity(home, "assistant")!
      const partial = await runtime.agent("assistant").createAccessRequest({
        purposeId: "general_assistance",
        scopes: [expectedScopesFor("general_assistance")[0]!],
        capabilityExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60),
      })
      await realApprove({ accessRequest: partial, manifest: identity.manifest, selection: { kind: "recommended" } } as never)
      const saved = home.readJson<{ request?: AccessRequest; requests?: AccessRequest[] }>(INIT_GRANT_REQUEST)!
      const prior = saved.requests ?? (saved.request === undefined ? [] : [saved.request])
      home.writeSecretJson(INIT_GRANT_REQUEST, { requests: [...prior, partial] })
      vault.approveGrant = realApprove

      await init(runtime, ["assistant"])
      expect(progress).toContain(RECOVERY_LINE)
      expect(loadGrants(home, "assistant")).toHaveLength(2)
      expect(home.has(INIT_GRANT_REQUEST)).toBe(false)

      const lines: string[] = []
      await runDoctor({ home, print: (line) => lines.push(line), env: {}, daemonProbeMs: 50 })
      expect(lines).toContain("ok: assistant approved")
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("a timeout after the grant landed prints the landed-but-unconfirmed line, not 'nothing was sent' (R4)", async () => {
    const { home, runtime } = await open()
    try {
      const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
      const realApprove = vault.approveGrant.bind(runtime.vault)
      // the grant really lands; only the transport answer times out
      vault.approveGrant = (async (input: never) => {
        await realApprove(input)
        throw new TimeoutError({ url: "http://127.0.0.1:8545", body: {} })
      }) as never
      const error = await init(runtime, ["assistant"]).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      // the line the owner would see — approve's landed-but-unconfirmed sentence with init's retry
      const line = ownerRefusalLine("init", "assistant", error, runtime.owner, runtime.chain.deployment.capabilityRegistry, home)
      expect(line).toContain(LANDED_LINE)
      expect(line).toContain("mida init")
      expect(line).not.toContain("nothing was sent")
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("a finish that throws on the re-run says to run mida init again before the error (R5)", async () => {
    const { home, runtime, progress } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      // the store now refuses the read-key send the finish pass makes
      const vault = runtime.vault as unknown as { publishReaderWraps: (input: never) => Promise<unknown> }
      vault.publishReaderWraps = (async () => {
        throw new MidaError("INTERNAL_ERROR", "the store refused the read-key send")
      }) as never
      await expect(init(runtime, ["assistant"])).rejects.toThrow("the store refused the read-key send")
      expect(progress).toContain(
        "assistant's approval is on chain, but Mida could not finish recording it. Run mida init again to finish it.",
      )
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("when the saved-request file cannot be removed, the note names mida init (R5)", async () => {
    const { home, runtime, progress } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
      const homeRef = runtime.home as unknown as { remove: (file: string) => void }
      const realRemove = homeRef.remove.bind(runtime.home)
      homeRef.remove = ((file: string) => {
        if (file === INIT_GRANT_REQUEST) throw new Error("EPERM: operation not permitted")
        return realRemove(file)
      }) as never
      await init(runtime, ["assistant"])
      expect(progress.some((line) => line.includes("run `mida init` again to finish"))).toBe(true)
      expect(progress.some((line) => line.includes("mida approve assistant"))).toBe(false)
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("migrate tolerates the assistant's grant refusal the way it tolerates already-approved (R5)", () => {
    expect(migrateToleratesApprovalRefusal("assistant", "assistant-grant-via-init")).toBe(true)
    expect(migrateToleratesApprovalRefusal("assistant", "already-approved")).toBe(true)
    expect(migrateToleratesApprovalRefusal("assistant", "no-pending-request")).toBe(true)
    expect(migrateToleratesApprovalRefusal("claude-code", "assistant-grant-via-init")).toBe(false)
    expect(migrateToleratesApprovalRefusal("assistant", "REQUEST_EXPIRED")).toBe(false)
  })

  it("an expired request during init names the agent in the refusal line (R5)", async () => {
    const { home, runtime } = await open()
    try {
      const vault = runtime.vault as unknown as { approveGrant: (input: never) => Promise<unknown> }
      vault.approveGrant = (async () => {
        throw new MidaError("REQUEST_EXPIRED", "the request's validity window passed")
      }) as never
      const error = await init(runtime, ["assistant"]).catch((e: unknown) => e)
      // init takes no <agent> argument — the CLI hands ownerRefusalLine an empty name, so the
      // failing agent must ride on the error
      const line = ownerRefusalLine("init", "", error, runtime.owner, runtime.chain.deployment.capabilityRegistry, home)
      expect(line).toContain("assistant's request has expired")
      expect(line).toContain("mida request assistant")
      // a flag in argv[1] (`mida init --passkey`) is not a name either — the error still carries it
      const flagged = ownerRefusalLine("init", "--passkey", error, runtime.owner, runtime.chain.deployment.capabilityRegistry, home)
      expect(flagged).toContain("assistant's request has expired")
    } finally {
      await runtime.close()
    }
  }, STEP_TIMEOUT)

  it("mida approve assistant in the unrecorded state points at mida init and exits 1", async () => {
    const { home, runtime } = await open()
    try {
      const restore = loseReplyAfterSend(runtime)
      await expect(init(runtime, ["assistant"])).rejects.toThrow(LANDED_LINE)
      restore()
    } finally {
      await runtime.close()
    }
    const workDir = mkdtempSync(join(tmpdir(), "mida-apr7-work-"))
    const out: string[] = []
    const code = await runCli(["approve", "assistant"], {
      home,
      network,
      cwd: workDir,
      print: (line) => out.push(line),
      prompt: async () => "yes",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })
    expect(code).toBe(1)
    expect(out).toContain(APPROVE_LINE)
    expect(home.has("agents/assistant/grants.json")).toBe(false)
  }, STEP_TIMEOUT)
})
