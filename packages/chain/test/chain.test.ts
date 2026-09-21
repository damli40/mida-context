import { describe, expect, it } from "vitest"
import { encodeErrorResult, getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import {
  LOG_SCAN_CONCURRENCY,
  MAX_LOG_BLOCK_RANGE,
  REVERT_CODES,
  blockWindows,
  capabilityRegistryAbi,
  chainFor,
  contextRegistryAbi,
  getLogsChunked,
  ownerHistory,
  parseDeployment,
  revertNameFromData,
} from "@mida/chain"
import type { Deployment, LogClient } from "@mida/chain"

const OWNER: Address = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
const AGENT: Hex = `0x${"aa".repeat(32)}`
const OTHER_AGENT: Hex = `0x${"bb".repeat(32)}`

const deployment: Deployment = {
  chainId: 31337n,
  capabilityRegistry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contextRegistry: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  deploymentBlock: 5n,
  policyHashV1: "0xfd7cb44154ac443f554cc7f16f8d89da452475b06b71fce6df1cbda2c139dc45",
  vaultRpId: "vault.mida.xyz",
  vaultRpIdHash: "0xb275669f95bfc600063e7cd0d2c3b12039f5067d964f36d9bb8275e09e3a36cb",
}

function recordingClient(head: bigint, logsFor: (call: { event: AbiEvent; fromBlock: bigint; toBlock: bigint }) => unknown[]) {
  const calls: Array<{ event: string; fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> }> = []
  const client: LogClient = {
    getBlockNumber: async () => head,
    getLogs: async (parameters) => {
      calls.push({ event: parameters.event.name, fromBlock: parameters.fromBlock, toBlock: parameters.toBlock, args: parameters.args })
      return logsFor(parameters)
    },
  }
  return { client, calls }
}

describe("generated ABIs (plan Task 21)", () => {
  it("contain the functions Part E calls and the §12.6 revert names", () => {
    const capabilityFunctions = capabilityRegistryAbi.filter((item) => item.type === "function").map((item) => item.name)
    for (const name of [
      "grantBatch", "initializeReadEpoch", "revoke", "revokeAndRotate", "revokeAgentAndRotate", "rotateExpiredEpoch",
      "registerAgent", "registerP256Key", "getAgent", "getCapability", "agentEpoch", "hasAuthority", "isAuthorized",
      "requiredReadEpoch", "epochPublicKey", "isWriteEpochValid", "agentIdOfSigner", "grantNonce", "ownerP256Key",
      "activeCapabilityIds", "isCapabilityValid",
    ]) {
      expect(capabilityFunctions, name).toContain(name)
    }
    const contextFunctions = contextRegistryAbi.filter((item) => item.type === "function").map((item) => item.name)
    for (const name of ["register", "getRecord", "exists", "latest"]) expect(contextFunctions, name).toContain(name)
    const errorNames = new Set<string>([...capabilityRegistryAbi, ...contextRegistryAbi].filter((i) => i.type === "error").map((i) => i.name))
    for (const name of Object.keys(REVERT_CODES)) expect(errorNames.has(name), name).toBe(true)
  })

  it("decodes revert data to a contract error name", () => {
    const career = namespaceId("goals.career")
    const data = encodeErrorResult({ abi: contextRegistryAbi, errorName: "StaleParent", args: [career, AGENT] })
    expect(revertNameFromData(data)).toBe("StaleParent")
    expect(REVERT_CODES.StaleParent).toBe("STALE_PARENT")
    expect(revertNameFromData("0xdeadbeef")).toBeUndefined()
  })
})

describe("network configuration", () => {
  it("parses a Deploy.s.sol file and normalizes addresses to lowercase", () => {
    const parsed = parseDeployment({
      chainId: 31337,
      deploymentBlock: 5,
      vaultRpId: "vault.mida.xyz",
      vaultRpIdHash: deployment.vaultRpIdHash,
      policyHashV1: deployment.policyHashV1,
      capabilityRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      contextRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    })
    expect(parsed).toEqual(deployment)
  })

  it("rejects a file with a missing or malformed key", () => {
    const fails = (value: unknown) => {
      try {
        parseDeployment(value)
      } catch (error) {
        return isMidaError(error, "INVALID_WIRE")
      }
      return false
    }
    expect(fails({ ...deployment, capabilityRegistry: undefined, chainId: 31337, deploymentBlock: 5 })).toBe(true)
    expect(fails({ ...deployment, chainId: -1, deploymentBlock: 5 })).toBe(true)
    expect(fails([])).toBe(true)
  })

  it("maps only the local chain and Monad testnet, using viem's definitions", () => {
    expect(chainFor(31337n).id).toBe(31337)
    expect(chainFor(10143n).id).toBe(10143)
    expect(chainFor(10143n).rpcUrls.default.http[0]).toBe("https://testnet-rpc.monad.xyz")
    expect(() => chainFor(1n)).toThrow()
  })
})

describe("chunked log scans (≤100 blocks per request)", () => {
  it("splits an inclusive range into windows of at most 100 blocks", () => {
    expect(MAX_LOG_BLOCK_RANGE).toBe(100n)
    expect(blockWindows(0n, 250n)).toEqual([
      { fromBlock: 0n, toBlock: 99n },
      { fromBlock: 100n, toBlock: 199n },
      { fromBlock: 200n, toBlock: 250n },
    ])
    expect(blockWindows(7n, 7n)).toEqual([{ fromBlock: 7n, toBlock: 7n }])
    expect(blockWindows(8n, 7n)).toEqual([])
    expect(() => blockWindows(0n, 10n, 101n)).toThrow()
  })

  it("never asks the provider for more than 100 blocks", async () => {
    const event = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent
    const { client, calls } = recordingClient(1_234n, (call) => [{ args: {}, blockNumber: call.fromBlock, transactionHash: null, logIndex: 0 }])
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n })
    expect(calls.length).toBe(13)
    for (const call of calls) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(100n)
    expect(calls[0]!.fromBlock).toBe(5n)
    expect(calls.at(-1)!.toBlock).toBe(1_234n)
    expect(logs).toHaveLength(13)
  })
})

describe("chunked log scans run a few windows at a time", () => {
  const event = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent

  it("keeps block order and never has more than the limit in flight", async () => {
    let inFlight = 0
    let peak = 0
    const client = {
      getBlockNumber: async () => 2_999n,
      getLogs: async (call: { fromBlock: bigint }) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, call.fromBlock % 300n === 0n ? 15 : 1))
        inFlight -= 1
        return [{ args: {}, blockNumber: call.fromBlock, transactionHash: null, logIndex: 0 }]
      },
    }
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n })
    expect(logs).toHaveLength(30)
    expect(logs.map((entry) => entry.blockNumber)).toEqual(Array.from({ length: 30 }, (_, i) => BigInt(i * 100)))
    expect(peak).toBeLessThanOrEqual(LOG_SCAN_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
  })

  it("a window that keeps failing fails the whole scan — no answer with a hole in it", async () => {
    const client = {
      getBlockNumber: async () => 499n,
      getLogs: async (call: { fromBlock: bigint }) => {
        if (call.fromBlock === 200n) throw new Error("window down")
        return []
      },
    }
    await expect(getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n })).rejects.toThrow("window down")
  }, 10_000)
})

describe("owner history (§14.6 PREVIOUSLY_REVOKED)", () => {
  const log = (owner: string, agentId: string) => ({ args: { owner, agentId }, blockNumber: 9n, transactionHash: null, logIndex: 0 })

  it("starts at deploymentBlock, filters by exactly (owner, agentId), and scans both revocation events", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const history = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })
    expect(history).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: false, observedThroughBlock: 20n })
    expect(new Set(calls.map((call) => call.event))).toEqual(new Set(["CapabilityRevoked", "AgentRevoked"]))
    for (const call of calls) {
      expect(call.fromBlock).toBe(5n)
      expect(call.args).toEqual({ owner: OWNER, agentId: AGENT })
    }
  })

  it("reports a revocation of this exact pair", async () => {
    const { client } = recordingClient(20n, (call) => (call.event.name === "AgentRevoked" ? [log(OWNER, AGENT.toUpperCase().replace("0X", "0x"))] : []))
    expect((await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).previouslyRevoked).toBe(true)
  })

  it("a revocation counter above 0 answers in one request, with no log scan at all", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const withView = { ...client, getBlockNumber: client.getBlockNumber.bind(client), getLogs: client.getLogs.bind(client), readContract: async () => 1n }
    const history = await ownerHistory({ client: withView, deployment, owner: OWNER, agentId: AGENT })
    expect(history).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: true, observedThroughBlock: 20n })
    expect(calls).toHaveLength(0)
  })

  it("a counter of 0 still scans, but only for single-capability revokes", async () => {
    const { client, calls } = recordingClient(20n, (call) => (call.event.name === "CapabilityRevoked" ? [log(OWNER, AGENT)] : []))
    const withView = { ...client, getBlockNumber: client.getBlockNumber.bind(client), getLogs: client.getLogs.bind(client), readContract: async () => 0n }
    expect((await ownerHistory({ client: withView, deployment, owner: OWNER, agentId: AGENT })).previouslyRevoked).toBe(true)
    expect(new Set(calls.map((call) => call.event))).toEqual(new Set(["CapabilityRevoked"]))
  })

  it("a counter read that fails, or returns nonsense, fails the whole check — never 'not revoked'", async () => {
    const { client } = recordingClient(20n, () => [])
    const base = { ...client, getBlockNumber: client.getBlockNumber.bind(client), getLogs: client.getLogs.bind(client) }
    await expect(ownerHistory({ client: { ...base, readContract: async () => { throw new Error("rpc down") } }, deployment, owner: OWNER, agentId: AGENT })).rejects.toThrow("rpc down")
    await expect(ownerHistory({ client: { ...base, readContract: async () => "1" }, deployment, owner: OWNER, agentId: AGENT })).rejects.toThrow()
  })

  it("ignores revocations of another agent or by another owner even if a provider returns them", async () => {
    const { client } = recordingClient(20n, () => [
      log(OWNER, OTHER_AGENT),
      log("0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", AGENT),
    ])
    expect((await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).previouslyRevoked).toBe(false)
  })
})

describe("the history scan cursor (R4-9)", () => {
  const zeroCounter = (client: LogClient) => ({
    ...client,
    getBlockNumber: client.getBlockNumber.bind(client),
    getLogs: client.getLogs.bind(client),
    readContract: async () => 0n,
  })
  /** An in-memory cursor standing in for the CLI's state/history/<agentId>.json file. */
  const memoryCursor = (saved: { observedThroughBlock: bigint; previouslyRevoked: boolean } | undefined) => {
    const writes: { observedThroughBlock: bigint; previouslyRevoked: boolean }[] = []
    return {
      writes,
      cursor: {
        load: () => saved,
        save: (state: { observedThroughBlock: bigint; previouslyRevoked: boolean }) => {
          writes.push(state)
        },
      },
    }
  }

  it("a saved previouslyRevoked answers with no log scan at all", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const { cursor } = memoryCursor({ observedThroughBlock: 10n, previouslyRevoked: true })
    const history = await ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(history.previouslyRevoked).toBe(true)
    expect(history.observedThroughBlock).toBe(20n)
    expect(calls).toHaveLength(0)
  })

  it("a cursor at the head scans nothing", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const { cursor } = memoryCursor({ observedThroughBlock: 20n, previouslyRevoked: false })
    const history = await ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(history.previouslyRevoked).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("a cursor AHEAD of the head is impossible — it is ignored, scanned over in full, and overwritten (R5-7)", async () => {
    // head+1 with a real CapabilityRevoked in the range: an honest file could never have observed it
    const { client, calls } = recordingClient(20n, (call) =>
      call.event.name === "CapabilityRevoked" ? [{ args: { owner: OWNER, agentId: AGENT }, blockNumber: 9n, transactionHash: null, logIndex: 0 }] : [],
    )
    const { cursor, writes } = memoryCursor({ observedThroughBlock: 21n, previouslyRevoked: false })
    const history = await ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(history.previouslyRevoked).toBe(true)
    expect(history.observedThroughBlock).toBe(20n)
    // the scan ran the full range from deploymentBlock, not the fake position — and the file was rewritten
    expect(calls.length).toBeGreaterThan(0)
    expect(Math.min(...calls.map((call) => Number(call.fromBlock)))).toBe(5)
    expect(writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: true }])
  })

  it("an ahead-of-head cursor that claims a revoke is still not trusted — the scan decides", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const { cursor, writes } = memoryCursor({ observedThroughBlock: 500n, previouslyRevoked: true })
    const history = await ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor })
    // no events on this chain — the file's claimed revoke was wrong-chain or tampered
    expect(history.previouslyRevoked).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
    expect(writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: false }])
  })

  it("a cursor behind the head scans only the new range and then saves the new position", async () => {
    const { client, calls } = recordingClient(250n, () => [])
    const { cursor, writes } = memoryCursor({ observedThroughBlock: 100n, previouslyRevoked: false })
    const scans: number[] = []
    const history = await ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor, onScan: (n) => scans.push(n) })
    expect(history).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: false, observedThroughBlock: 250n })
    // the scan resumes one block after the cursor — never rescans what was already observed
    expect(calls.length).toBeGreaterThan(0)
    expect(Math.min(...calls.map((call) => Number(call.fromBlock)))).toBe(101)
    expect(writes).toEqual([{ observedThroughBlock: 250n, previouslyRevoked: false }])
    // the progress line gets the window count before the requests start
    expect(scans).toEqual([blockWindows(101n, 250n).length])
  })

  it("a found revocation is saved sticky — previouslyRevoked: true", async () => {
    const { client } = recordingClient(20n, (call) =>
      call.event.name === "CapabilityRevoked" ? [{ args: { owner: OWNER, agentId: AGENT }, blockNumber: 9n, transactionHash: null, logIndex: 0 }] : [],
    )
    const { cursor, writes } = memoryCursor(undefined)
    await ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: true }])
  })

  it("a scan that fails saves no cursor — a partial position would hide a missed revoke", async () => {
    const { client, calls } = recordingClient(250n, (call) => {
      if (call.fromBlock === 105n) throw new Error("window down")
      return []
    })
    const { cursor, writes } = memoryCursor(undefined)
    await expect(ownerHistory({ client: zeroCounter(client), deployment, owner: OWNER, agentId: AGENT, cursor })).rejects.toThrow("window down")
    expect(calls.length).toBeGreaterThan(0)
    expect(writes).toHaveLength(0)
  }, 15_000)

  it("the contract's own answer wins over any cursor — the cursor is consulted only after the counter read", async () => {
    const { client, calls } = recordingClient(20n, () => [])
    const withView = { ...zeroCounter(client), readContract: async () => 3n }
    const { cursor } = memoryCursor({ observedThroughBlock: 10n, previouslyRevoked: false })
    const history = await ownerHistory({ client: withView, deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(history.previouslyRevoked).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
