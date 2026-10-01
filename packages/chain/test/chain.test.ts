import { describe, expect, it } from "vitest"
import { encodeErrorResult, getAbiItem } from "viem"
import type { AbiEvent } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import {
  LOG_SCAN_CONCURRENCY,
  MAX_LOG_BLOCK_RANGE,
  REVERT_CODES,
  SAFE_LOG_BLOCK_RANGE,
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

describe("chunked log scans (≤1,000 blocks per request, 100 on fallback)", () => {
  it("splits an inclusive range into windows of the requested size, capped at 1,000", () => {
    expect(MAX_LOG_BLOCK_RANGE).toBe(1_000n)
    expect(SAFE_LOG_BLOCK_RANGE).toBe(100n)
    expect(blockWindows(0n, 250n)).toEqual([{ fromBlock: 0n, toBlock: 250n }])
    expect(blockWindows(0n, 250n, 100n)).toEqual([
      { fromBlock: 0n, toBlock: 99n },
      { fromBlock: 100n, toBlock: 199n },
      { fromBlock: 200n, toBlock: 250n },
    ])
    expect(blockWindows(7n, 7n)).toEqual([{ fromBlock: 7n, toBlock: 7n }])
    expect(blockWindows(8n, 7n)).toEqual([])
    expect(() => blockWindows(0n, 10n, 1_001n)).toThrow()
    expect(() => blockWindows(0n, 10n, 0n)).toThrow()
  })

  it("never asks the provider for more than 1,000 blocks", async () => {
    const event = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent
    const { client, calls } = recordingClient(1_234n, (call) => [{ args: {}, blockNumber: call.fromBlock, transactionHash: null, logIndex: 0 }])
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n })
    expect(calls.length).toBe(2)
    for (const call of calls) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(1_000n)
    expect(calls[0]!.fromBlock).toBe(5n)
    expect(calls.at(-1)!.toBlock).toBe(1_234n)
    expect(logs).toHaveLength(2)
  })

  it("fetches the head with the cache off — a cached getBlockNumber can sit below the block just mined; an explicit toBlock skips the call", async () => {
    const event = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent
    const headCalls: Array<{ cacheTime?: number } | undefined> = []
    const windows: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    const client: LogClient = {
      getBlockNumber: async (options) => {
        headCalls.push(options)
        // a viem cache answers with the stale head (5n) unless the caller disables it
        return options?.cacheTime === 0 ? 1_234n : 5n
      },
      getLogs: async (parameters) => {
        windows.push({ fromBlock: parameters.fromBlock, toBlock: parameters.toBlock })
        return []
      },
    }
    await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n })
    expect(headCalls).toEqual([{ cacheTime: 0 }])
    expect(windows.at(-1)!.toBlock).toBe(1_234n)

    headCalls.length = 0
    windows.length = 0
    await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n, toBlock: 99n })
    expect(headCalls).toHaveLength(0)
    expect(windows.at(-1)!.toBlock).toBe(99n)
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
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n }, { maxRange: 100n })
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
    await expect(getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n }, { maxRange: 100n })).rejects.toThrow("window down")
  }, 10_000)
})

describe("adaptive log scan windows (range-limit fallback)", () => {
  const event = getAbiItem({ abi: capabilityRegistryAbi, name: "AgentRevoked" }) as AbiEvent
  const entry = (call: { fromBlock: bigint }) => ({ args: {}, blockNumber: call.fromBlock, transactionHash: null, logIndex: 0 })

  it("uses 1,000-block windows against a provider that accepts them, covering every block once", async () => {
    const { client, calls } = recordingClient(2_500n, (call) => [entry(call)])
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n })
    expect(calls.map((call) => [call.fromBlock, call.toBlock])).toEqual([
      [5n, 1_004n],
      [1_005n, 2_004n],
      [2_005n, 2_500n],
    ])
    expect(logs).toHaveLength(3)
    expect(logs.map((log) => log.blockNumber)).toEqual([5n, 1_005n, 2_005n])
  })

  it("a range refusal re-fetches the refused window in 100-block pieces and shrinks the rest of the scan — same logs, no gaps, no duplicates", async () => {
    const rangeError = () => Object.assign(new Error("eth_getLogs is limited to a 100 range"), { code: -32614 })
    const refused: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    const served: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    const limited = {
      getBlockNumber: async () => 1_234n,
      getLogs: async (call: { fromBlock: bigint; toBlock: bigint }) => {
        if (call.toBlock - call.fromBlock + 1n > 100n) {
          refused.push({ fromBlock: call.fromBlock, toBlock: call.toBlock })
          throw rangeError()
        }
        served.push({ fromBlock: call.fromBlock, toBlock: call.toBlock })
        return [entry(call)]
      },
    }
    const adaptive = await getLogsChunked(limited, { address: deployment.capabilityRegistry, event, fromBlock: 5n })

    const { client: baselineClient } = recordingClient(1_234n, (call) => [entry(call)])
    const baseline = await getLogsChunked(baselineClient, { address: deployment.capabilityRegistry, event, fromBlock: 5n }, { maxRange: 100n })
    expect(adaptive).toEqual(baseline)

    // a range refusal is never retried: at most the two starting 1,000-block windows saw one
    expect(refused.length).toBeGreaterThanOrEqual(1)
    expect(refused.length).toBeLessThanOrEqual(2)
    for (const call of refused) expect(call.toBlock - call.fromBlock + 1n).toBeGreaterThan(100n)
    // the served ranges tile [5, 1234] exactly — a hole could hide a revocation, a duplicate lies
    const covered = new Set<bigint>()
    for (const call of served) {
      expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(100n)
      for (let block = call.fromBlock; block <= call.toBlock; block++) {
        expect(covered.has(block)).toBe(false)
        covered.add(block)
      }
    }
    for (let block = 5n; block <= 1_234n; block++) expect(covered.has(block)).toBe(true)
  })

  it("an HTTP 413 without a matching message counts as a range refusal too", async () => {
    const served: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    const client = {
      getBlockNumber: async () => 250n,
      getLogs: async (call: { fromBlock: bigint; toBlock: bigint }) => {
        if (call.toBlock - call.fromBlock + 1n > 100n) {
          throw Object.assign(new Error("request entity too large"), { status: 413 })
        }
        served.push({ fromBlock: call.fromBlock, toBlock: call.toBlock })
        return [entry(call)]
      },
    }
    const logs = await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n })
    expect(logs).toHaveLength(3)
    expect(served.map((call) => [call.fromBlock, call.toBlock])).toEqual([
      [0n, 99n],
      [100n, 199n],
      [200n, 250n],
    ])
  })

  it("a non-range error still fails the scan after 3 attempts", async () => {
    let attempts = 0
    const client = {
      getBlockNumber: async () => 499n,
      getLogs: async (call: { fromBlock: bigint }) => {
        if (call.fromBlock === 0n) {
          attempts += 1
          throw new Error("window down")
        }
        return []
      },
    }
    await expect(getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n }, { maxRange: 100n })).rejects.toThrow("window down")
    expect(attempts).toBe(3)
  }, 10_000)

  it("clamps an out-of-range maxRange to 1..1,000 instead of failing; blockWindows still validates", async () => {
    const { client, calls } = recordingClient(4n, () => [])
    await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n, toBlock: 4n }, { maxRange: 5_000n })
    expect(calls.map((call) => [call.fromBlock, call.toBlock])).toEqual([[0n, 4n]])
    calls.length = 0
    await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 0n, toBlock: 4n }, { maxRange: 0n })
    expect(calls).toHaveLength(5)
    expect(() => blockWindows(0n, 10n, 1_001n)).toThrow()
  })

  it("reports progress in about-5% steps and always ends at (total, total)", async () => {
    const { client } = recordingClient(2_500n, () => [])
    const seen: Array<[number, number]> = []
    await getLogsChunked(client, { address: deployment.capabilityRegistry, event, fromBlock: 5n }, { onProgress: (done, total) => seen.push([done, total]) })
    expect(seen.at(-1)).toEqual([3, 3])
    let last = 0
    for (const [done, total] of seen) {
      expect(done).toBeGreaterThan(last)
      expect(done).toBeLessThanOrEqual(total)
      last = done
    }
  })
})

describe("owner history (§14.6 PREVIOUSLY_REVOKED — contract state, never a log scan)", () => {
  const CAP_A: Hex = `0x${"1".repeat(64)}`
  const CAP_B: Hex = `0x${"2".repeat(64)}`

  /**
   * A fake HistoryClient answering the three contract views from an in-memory picture and
   * recording every read. Its getLogs is a trap — ownerHistory must never call it, so the trap
   * rejects loudly instead of returning logs.
   */
  function historyClient(state: { head?: bigint; epoch?: unknown; ids?: unknown; capability?: (capabilityId: Hex) => unknown }) {
    const reads: { functionName: string; args: readonly unknown[] }[] = []
    const client = {
      getBlockNumber: () => Promise.resolve(state.head ?? 20n),
      getLogs: () => Promise.reject(new Error("ownerHistory must never call getLogs")),
      readContract: (parameters: { functionName: string; args: readonly unknown[] }): Promise<unknown> => {
        reads.push(parameters)
        if (parameters.functionName === "agentEpoch") return Promise.resolve(state.epoch ?? 0n)
        if (parameters.functionName === "activeCapabilityIds") {
          const ids = typeof state.ids === "function" ? (state.ids as () => unknown)() : state.ids
          return Promise.resolve(ids ?? [])
        }
        if (parameters.functionName === "getCapability") return Promise.resolve(state.capability?.(parameters.args[0] as Hex))
        return Promise.reject(new Error(`unexpected read ${parameters.functionName}`))
      },
    }
    return { client, reads }
  }

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

  it("a live grant, epoch 0 and nothing revoked answers false — and getLogs is never called", async () => {
    const { client, reads } = historyClient({ ids: [CAP_A], capability: () => ({ owner: OWNER, agentId: AGENT, revoked: false }) })
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).resolves.toEqual({
      owner: OWNER,
      agentId: AGENT,
      previouslyRevoked: false,
      observedThroughBlock: 20n,
    })
    // the pair-scoped reads ask for exactly (owner, agentId); each capability read asks for a listed id
    expect(reads.map((read) => [read.functionName, ...read.args])).toEqual([
      ["agentEpoch", OWNER, AGENT],
      ["activeCapabilityIds", OWNER, AGENT],
      ["getCapability", CAP_A],
    ])
  })

  it("a single-capability revoke still listed answers true — the record's revoked flag, no scan", async () => {
    const { client } = historyClient({
      ids: [CAP_A, CAP_B],
      capability: (capabilityId) => ({ owner: OWNER, agentId: AGENT, revoked: capabilityId === CAP_B }),
    })
    const { cursor, writes } = memoryCursor(undefined)
    const history = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(history.previouslyRevoked).toBe(true)
    // the machine keeps the yes — the later grant that compacts the revoked id away must not lose it
    expect(writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: true }])
  })

  it("KNOWN LIMIT: a single revoke compacted out of the list by a later grant is only seen through this machine's saved yes", async () => {
    // revoke(cap) leaves the id listed with revoked = true — the check sees it and saves the yes.
    // The next grant's _storeCapability compacts the list, so afterwards nothing in contract
    // state still carries the revoke; a machine that never saved the yes cannot see it.
    let ids: Hex[] = [CAP_A]
    const { client } = historyClient({
      ids: () => ids,
      capability: (capabilityId) => ({ owner: OWNER, agentId: AGENT, revoked: capabilityId === CAP_A }),
    })
    const saved: { observedThroughBlock: bigint; previouslyRevoked: boolean }[] = []
    const cursor = {
      load: () => saved[saved.length - 1],
      save: (state: { observedThroughBlock: bigint; previouslyRevoked: boolean }) => void saved.push(state),
    }
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, toBlock: 30n, cursor })).resolves.toMatchObject({ previouslyRevoked: true })
    ids = [CAP_B] // the new grant's _compact removed the revoked id; only the fresh id remains
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, toBlock: 31n, cursor })).resolves.toMatchObject({ previouslyRevoked: true })
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, toBlock: 31n })).resolves.toMatchObject({ previouslyRevoked: false })
  })

  it("a failed getCapability read rejects — a read that cannot answer never counts as 'not revoked'", async () => {
    const { client } = historyClient({
      ids: [CAP_A, CAP_B],
      capability: (capabilityId) => (capabilityId === CAP_B ? Promise.reject(new Error("rpc down")) : { revoked: false }),
    })
    const { cursor, writes } = memoryCursor(undefined)
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor })).rejects.toThrow("rpc down")
    // a failed check writes nothing — a half-answer must not be remembered
    expect(writes).toHaveLength(0)
  })

  it("a getCapability answer that is not a record with a boolean revoked flag rejects", async () => {
    for (const answer of [{ revoked: "yes" }, { owner: OWNER }, null, "capability", 7]) {
      const { client } = historyClient({ ids: [CAP_A], capability: () => answer })
      await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).rejects.toThrow()
    }
  })

  it("a whole-agent revoke counter above 0 answers true after exactly one contract read", async () => {
    const { client, reads } = historyClient({ epoch: 3n })
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).resolves.toEqual({
      owner: OWNER,
      agentId: AGENT,
      previouslyRevoked: true,
      observedThroughBlock: 20n,
    })
    expect(reads.map((read) => [read.functionName, ...read.args])).toEqual([["agentEpoch", OWNER, AGENT]])
  })

  it("a never-granted agent answers false after two reads — epoch 0 and an empty active list (in-15 J-10)", async () => {
    // _activeByAgent gains entries only at grant and loses its last one only inside the
    // epoch-bumping revoke, so empty + epoch 0 means the agent was never granted — and a
    // never-granted agent has nothing that could have been revoked.
    const { client, reads } = historyClient({ ids: [] })
    const history = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })
    expect(history).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: false, observedThroughBlock: 20n })
    expect(reads.map((read) => read.functionName)).toEqual(["agentEpoch", "activeCapabilityIds"])
  })

  it("an epoch or list read that fails — or answers nonsense — fails the check, never 'not revoked'", async () => {
    for (const broken of [
      { epoch: Promise.reject(new Error("rpc down")) },
      { epoch: "7" },
      { ids: "not a list" },
      { ids: Promise.reject(new Error("rpc down")) },
    ]) {
      const { client } = historyClient(broken)
      await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).rejects.toThrow()
    }
  })

  it("a cursor ahead of the head is impossible — its block is not trusted, but a saved yes is never erased (R5-7)", async () => {
    const { client } = historyClient({ ids: [CAP_A], capability: () => ({ owner: OWNER, agentId: AGENT, revoked: false }) })
    // a saved NO from ahead of the head has no effect — the contract's own reads answer
    const noCursor = memoryCursor({ observedThroughBlock: 500n, previouslyRevoked: false })
    const history = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor: noCursor.cursor })
    expect(history).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: false, observedThroughBlock: 20n })
    expect(noCursor.writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: false }])
    // a saved YES from ahead of the head still answers — nothing on the chain un-revokes, and a
    // lagging answer must not erase the one record of a compacted-away revoke
    const yesCursor = memoryCursor({ observedThroughBlock: 500n, previouslyRevoked: true })
    const kept = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor: yesCursor.cursor })
    expect(kept).toEqual({ owner: OWNER, agentId: AGENT, previouslyRevoked: true, observedThroughBlock: 20n })
    expect(yesCursor.writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: true }])
  })

  it("a cursor exactly AT the head is used — a saved yes there answers true", async () => {
    const { client } = historyClient({ ids: [CAP_A], capability: () => ({ owner: OWNER, agentId: AGENT, revoked: false }) })
    const { cursor, writes } = memoryCursor({ observedThroughBlock: 20n, previouslyRevoked: true })
    const history = await ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor })
    expect(history).toMatchObject({ previouslyRevoked: true, observedThroughBlock: 20n })
    expect(writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: true }])
  })

  it("the contract's answer wins over a saved no — a revoked record beats a cursor that says false", async () => {
    const { client } = historyClient({ ids: [CAP_A], capability: () => ({ owner: OWNER, agentId: AGENT, revoked: true }) })
    const { cursor, writes } = memoryCursor({ observedThroughBlock: 20n, previouslyRevoked: false })
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor })).resolves.toMatchObject({ previouslyRevoked: true })
    expect(writes).toEqual([{ observedThroughBlock: 20n, previouslyRevoked: true }])
  })

  it("a whole-agent revoke answers true even over a saved no — the counter beats the cursor", async () => {
    const { client } = historyClient({ epoch: 2n })
    const { cursor } = memoryCursor({ observedThroughBlock: 10n, previouslyRevoked: false })
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT, cursor })).resolves.toMatchObject({ previouslyRevoked: true })
  })

  it("12 listed ids are read with at most 8 in flight at once", async () => {
    let inFlight = 0
    let peak = 0
    const ids = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex)
    const { client, reads } = historyClient({
      ids,
      capability: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return { revoked: false }
      },
    })
    await expect(ownerHistory({ client, deployment, owner: OWNER, agentId: AGENT })).resolves.toMatchObject({ previouslyRevoked: false })
    expect(reads.filter((read) => read.functionName === "getCapability")).toHaveLength(12)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})
