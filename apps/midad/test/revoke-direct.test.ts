// in-3 (I6): the direct lane's last gap. `PUT /objects` runs the store's whole gate — including
// the deny overlay — but only at upload time. Between that answer and `contexts.register` the
// contract sees nothing new, and a revoke pending on Monad is invisible to it: an upload that
// passed could still register inside the window. The SDK now asks the store once more, right
// before register — WRITE_DENIED (deny still pending) or CAPABILITY_REVOKED (it landed) both
// stop the transaction; the uploaded bytes just sit unanchored.
//
// An after-response hook on a real API server lands the deny (E) or the full revoke (D) in the
// exact gap between PUT /objects and register — no fake timing. A control save from an unrelated
// agent still writes the whole time.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http } from "viem"
import { serve } from "@hono/node-server"
import { chainFor, deployLocal, fundLocal, startAnvil } from "@mida/chain"
import type { Deployment } from "@mida/chain"
import { RegistryReader, createContextApi } from "@mida/api"
import type { Hex } from "@mida/protocol"
import { MidaHome, NAMESPACE, Runtime, approve, init, loadAgentIdentity, readCheckpoints, requestAccess, revoke, saveCheckpoint } from "@mida/midad"
import type { Network } from "@mida/midad"
import { sampleCheckpoint } from "./helpers.js"

const AGENTS = ["claude-code", "codex"] as const
const T = 180_000

const env = (projectId: string, eventId: string, sessionId = "s1") => ({
  projectId,
  sessionId,
  continuesSession: null,
  compiledBy: "test",
  checkpoint: sampleCheckpoint({ eventId }),
})

const codeOf = (error: unknown): string => (error as { code?: string })?.code ?? String(error)

describe("in-3 I6 — a direct save checks the deny list again right before register", () => {
  let stopAnvil: () => Promise<void>
  let closeServer: () => Promise<void>
  let network: Network
  let afterHook: ((request: Request, response: Response) => Promise<void>) | undefined

  beforeAll(async () => {
    const node = await startAnvil()
    stopAnvil = node.stop
    const deployment: Deployment = await deployLocal({ rpcUrl: node.rpcUrl })
    const publicClient = createPublicClient({ chain: chainFor(deployment.chainId), transport: http(node.rpcUrl) })
    const reader = new RegistryReader({ publicClient, deployment })
    const dataDir = mkdtempSync(join(tmpdir(), "mida-in3-i6-api-"))
    const { app } = createContextApi({ reader, deployment, dataDir })
    const baseUrl = await new Promise<string>((resolve) => {
      const server = serve(
        {
          fetch: async (request: Request) => {
            const method = request.method
            const url = request.url
            const response = await app.fetch(request)
            const hook = afterHook
            if (hook !== undefined && response.status < 300) await hook(new Request(url, { method }), response)
            return response
          },
          port: 0,
          hostname: "127.0.0.1",
        },
        (info) => {
          closeServer = () => new Promise((done) => server.close(() => done()))
          resolve(`http://127.0.0.1:${info.port}`)
        },
      )
    })
    network = { rpcUrl: node.rpcUrl, deployment, fund: (a) => fundLocal(node.rpcUrl, a), storageUrl: baseUrl }
  }, 600_000)

  afterAll(async () => {
    await closeServer?.()
    await stopAnvil?.()
  })

  const newHome = async () => {
    const home = new MidaHome(mkdtempSync(join(tmpdir(), "mida-in3-i6-")))
    const runtime = await Runtime.open(home, network)
    await init(runtime, AGENTS)
    for (const name of AGENTS) {
      await requestAccess(runtime, name)
      await approve(runtime, name)
    }
    const agentId = loadAgentIdentity(home, "claude-code")!.agentId
    return { runtime, agentId }
  }

  /** The "revoke pending on Monad" state: the owner's deny is staged at the store, the chain tx has not landed. */
  const stageDenyOnly = (runtime: Runtime, agentId: Hex) => runtime.ownerApi.requestRevocationDeny({ owner: runtime.owner, agentId })

  /** Fires `act` exactly once — on the first successful PUT /objects inside a save. */
  const hookAfterObjectPut = (act: () => Promise<void>) => {
    let fired = false
    afterHook = async (request) => {
      if (fired || request.method !== "PUT" || !request.url.endsWith("/objects")) return
      fired = true
      await act()
    }
    return () => {
      afterHook = undefined
      return fired
    }
  }

  it("a deny staged between PUT /objects and register stops the register — the write parks, never anchors", async () => {
    const { runtime, agentId } = await newHome()
    try {
      const fired = hookAfterObjectPut(() => stageDenyOnly(runtime, agentId).then(() => undefined))
      let outcome = "saved"
      await saveCheckpoint(runtime, "claude-code", env("proj-deny", "cp-i6-E-0001")).catch((e) => (outcome = codeOf(e)))
      expect(fired()).toBe(true)
      // The pending-deny answer: WRITE_DENIED, not a landed-revoke code — the write is parked,
      // and nothing registered while the window was open.
      expect(outcome).toBe("WRITE_DENIED")
      expect((await readCheckpoints(runtime, "codex", "proj-deny")).checkpoints).toHaveLength(0)

      // The revoke then lands: codex still sees nothing — the parked upload never became a record.
      await revoke(runtime, "claude-code")
      expect((await readCheckpoints(runtime, "codex", "proj-deny")).checkpoints).toHaveLength(0)
    } finally {
      afterHook = undefined
      await runtime.close()
    }
  }, T)

  it("a revoke landed between PUT /objects and register also stops the register — as CAPABILITY_REVOKED", async () => {
    const { runtime } = await newHome()
    try {
      const fired = hookAfterObjectPut(() => revoke(runtime, "claude-code").then(() => undefined))
      let outcome = "saved"
      await saveCheckpoint(runtime, "claude-code", env("proj-landed", "cp-i6-D-0001")).catch((e) => (outcome = codeOf(e)))
      expect(fired()).toBe(true)
      expect(outcome).not.toBe("saved")
      expect((await readCheckpoints(runtime, "codex", "proj-landed")).checkpoints).toHaveLength(0)
    } finally {
      afterHook = undefined
      await runtime.close()
    }
  }, T)

  it("an unrelated agent's direct save still registers while claude-code's deny is pending", async () => {
    const { runtime, agentId } = await newHome()
    try {
      await stageDenyOnly(runtime, agentId)
      const saved = await saveCheckpoint(runtime, "codex", env("proj-other", "cp-i6-F-0001", "sF"))
      expect(saved.contextId).toMatch(/^0x/)
      expect((await readCheckpoints(runtime, "codex", "proj-other")).checkpoints).toHaveLength(1)
    } finally {
      await runtime.close()
    }
  }, T)
})
