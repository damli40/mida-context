import { describe, expect, it } from "vitest"
import { MidaError, PERMISSION, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { hexOf } from "@mida/crypto"
import { randomBytes } from "@noble/hashes/utils.js"
import { zeroHash } from "viem"
import { MidaAgent } from "@mida/sdk"

/**
 * M3-D item 1 — the store can answer a list it could not fully verify (x-mida-partial after all
 * retries). A caller that asked only for objects — `read` — must never receive a short list as
 * if it were complete: it gets a typed PARTIAL_READ instead. A caller that asked about partiality
 * — `readWithStatus` — gets the verified objects AND the flag.
 */

const CHAIN_ID = 31337n
const CAPABILITY_REGISTRY = `0x${"11".repeat(20)}` as Address
const CONTEXT_REGISTRY = `0x${"22".repeat(20)}` as Address
const OWNER = `0x${"33".repeat(20)}` as Address
const SIGNER = `0x${"55".repeat(20)}` as Address
const AGENT_ID = `0x${"aa".repeat(32)}` as Hex
const NAMESPACE = "projects.current"
const NAMESPACE_ID = namespaceId(NAMESPACE)

function agentWith(partial: boolean, objects: unknown[] = []) {
  const chainReads: string[] = []
  const agent = new MidaAgent({
    agentId: AGENT_ID,
    callbackOrigin: "https://agent.example",
    encryptionPrivateKey: randomBytes(32),
    chain: {
      deployment: { chainId: CHAIN_ID, capabilityRegistry: CAPABILITY_REGISTRY, contextRegistry: CONTEXT_REGISTRY, deploymentBlock: 0n },
      account: { address: SIGNER },
      publicClient: {
        readContract: async (params: { functionName: string }) => {
          chainReads.push(params.functionName)
          if (params.functionName === "getAgent") {
            return {
              operator: `0x${"44".repeat(20)}`,
              signer: SIGNER,
              encryptionPublicKey: hexOf(randomBytes(32)),
              encryptionKeyVersion: 1,
              callbackOriginHash: zeroHash,
              capabilityManifestHash: zeroHash,
              capabilityManifestVersion: 1n,
              active: true,
            }
          }
          throw new Error(`unexpected readContract ${params.functionName}`)
        },
      },
    } as never,
    api: {
      account: { address: SIGNER },
      listObjects: async () => ({ objects, partial }),
    } as never,
    grants: [
      {
        owner: OWNER,
        agentId: AGENT_ID,
        requestId: `0x${"99".repeat(32)}` as Hex,
        capabilities: [
          {
            capabilityId: `0x${"77".repeat(32)}` as Hex,
            namespaceId: NAMESPACE_ID,
            permissions: PERMISSION.READ,
            provenancePolicy: 0,
            expiresAt: "0",
            transactionHash: `0x${"88".repeat(32)}` as Hex,
          },
        ],
      },
    ],
  })
  return { agent, chainReads }
}

describe("MidaAgent partial reads (M3-D)", () => {
  it("read() throws PARTIAL_READ on an incomplete list — a caller that did not ask gets no short list", async () => {
    const { agent } = agentWith(true)
    const error = await agent.read(OWNER, NAMESPACE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MidaError)
    expect((error as MidaError).code).toBe("PARTIAL_READ")
  })

  it("readWithStatus() returns the verified objects AND the flag — the partial list is usable, labeled", async () => {
    const { agent } = agentWith(true)
    const result = await agent.readWithStatus(OWNER, NAMESPACE)
    expect(result.partial).toBe(true)
    expect(result.objects).toEqual([])
  })

  it("an empty partial list costs no chain read — there is nothing to open, so no wrap is needed", async () => {
    const { agent, chainReads } = agentWith(true)
    await agent.readWithStatus(OWNER, NAMESPACE)
    expect(chainReads).toEqual([])
  })

  it("a complete list reads normally through both methods", async () => {
    const { agent } = agentWith(false)
    await expect(agent.read(OWNER, NAMESPACE)).resolves.toEqual([])
    await expect(agent.readWithStatus(OWNER, NAMESPACE)).resolves.toEqual({ objects: [], partial: false })
  })
})
