// scripts/sponsor-probe.mts — the M3-B sponsored-gas probe (item 1).
//
// THE REVIEWER RUNS THIS. The agent that wrote it never does — it reaches real Monad testnet and
// Pimlico's hosted bundler/paymaster and spends real testnet MON:
//
//   node --env-file=.env --import tsx scripts/sponsor-probe.mts
//
// Reads PIMLICO_API_KEY, PIMLICO_POLICY_ID and DEPLOYER_PRIVATE_KEY (plus optional
// MONAD_TESTNET_RPC) from the environment. Every printed line and the evidence file pass through
// maskForLog: the key, the policy id, the deployer key and the fresh key can never appear, and no
// hex run of 40+ characters survives unless it is on the allow list — transaction hashes, the
// fresh throwaway address and public contract constants that must stay readable for the evidence
// to mean anything.
//
// What each step answers:
//   a. fresh-account          a brand-new key holding 0 MON exists and the RPC is really 10143
//   b. implementation-code    the 7702 implementation permissionless delegates to (its Sepolia
//                             default) has code on Monad testnet — if empty, delegation is
//                             meaningless and everything below it is expected to fail
//   c. sponsored-register     one sponsored user operation whose sender IS the fresh address can
//                             call registerP256Key on the CapabilityRegistry — chosen because any
//                             address may call it for itself and it records msg.sender
//   d. sender-is-owner        the contract recorded the FRESH address as the key owner — the whole
//                             point of 7702+4337: the payer changed, the sender did not
//   e. gas-fields             every gas field the operation carried vs the wei the paymaster was
//                             actually charged — Monad bills the gas LIMIT, not gas used
//   f. self-paid-under-10mon  the open danger: after funding 0.05 MON, can a 7702-delegated
//                             address still pay its OWN gas? Monad reverts a transaction that
//                             drops a delegated balance while under 10 MON. PASS means ordinary
//                             self-pay still works; FAIL means the SDK fallback is broken
//   g. clear-delegation       whether a sponsored operation carrying an authorization to the zero
//                             address can clear the delegation AT ALL — rejected before inclusion,
//                             included-but-reverted, included-but-not-cleared, or cleared. The
//                             answer decides whether the sponsor worker's ALLOW_CLEARING flag
//                             (default off) may ever be turned on
//
// Output: one PASS/FAIL/SKIP line per step plus docs/evidence/m3-sponsor-probe.json. Exit code is
// 1 when any step failed — a FAIL is a finding, not a crash; read the JSON for the evidence.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { createSmartAccountClient } from "permissionless"
import { to7702SimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { createPublicClient, createWalletClient, encodeFunctionData, http, zeroAddress } from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { monadTestnet } from "viem/chains"
import type { Address, Hex } from "viem"
import { MONAD_TESTNET_CHAIN_ID, capabilityRegistryAbi, loadDeployment } from "@mida/chain"
import { buildEvidence, maskForLog } from "./sponsor-probe-lib.mjs"
import type { ProbeStep, ProbeStepStatus } from "./sponsor-probe-lib.mjs"

/** The SimpleAccount implementation permissionless delegates to unless told otherwise — its
 * Sepolia address, UNVERIFIED on Monad testnet. Step b checks it. */
const PIMLICO_7702_IMPLEMENTATION = "0xe6Cae83BdE06E4c305530e199D7217f42808555B" as Address

/** What step f sends the fresh address — enough for a small transaction, far under the 10 MON reserve line. */
const STEP_F_FUNDING_WEI = 50_000_000_000_000_000n // 0.05 MON
/** Monad's funded-account delay: an EOA's inflight gas spend is budgeted against state k=3 blocks
 * back, so a just-funded address must wait past the lag before its own send is eligible. */
const FUNDING_LAG_BLOCKS = 4n

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_PATH = join(HERE, "..", "docs", "evidence", "m3-sponsor-probe.json")

const env = process.env
const pimlicoUrl = `https://api.pimlico.io/v2/monad-testnet/rpc?apikey=${env.PIMLICO_API_KEY ?? ""}`

/** Everything that must never reach a log line or the evidence file. */
const secrets: (string | undefined)[] = [
  env.PIMLICO_API_KEY,
  env.PIMLICO_POLICY_ID,
  env.DEPLOYER_PRIVATE_KEY,
  pimlicoUrl,
]

/** Hex runs that stay readable: filled as the run produces them (hashes, public addresses). */
const allow = new Set<string>([
  zeroAddress,
  entryPoint08Address,
  PIMLICO_7702_IMPLEMENTATION,
])

const print = (line: string): void => console.log(maskForLog(line, { secrets, allow: [...allow] }))

const steps: ProbeStep[] = []

async function step(id: string, name: string, run: () => Promise<{ status?: ProbeStepStatus; detail: Record<string, unknown> }>): Promise<void> {
  try {
    const result = await run()
    const status = result.status ?? "pass"
    steps.push({ id, name, status, detail: result.detail })
    print(`${status.toUpperCase()} ${id} — ${name} ${summarize(result.detail)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ id, name, status: "fail", detail: { error: maskForLog(message, { secrets, allow: [...allow] }) } })
    print(`FAIL ${id} — ${name} ${maskForLog(message, { secrets, allow: [...allow] })}`)
  }
}

/** One short suffix for the printed line; the full detail lives in the JSON. */
function summarize(detail: Record<string, unknown>): string {
  for (const key of ["outcome", "userOpHash", "transactionHash", "error", "reason", "balanceWei"]) {
    const value = detail[key]
    if (value !== undefined) return `(${key}=${String(value)})`
  }
  return ""
}

const deployment = loadDeployment(MONAD_TESTNET_CHAIN_ID)
allow.add(deployment.capabilityRegistry)
allow.add(deployment.contextRegistry)

const rpcUrl = env.MONAD_TESTNET_RPC ?? monadTestnet.rpcUrls.default.http[0]
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) })

// --- shared state between steps: the sponsored operation's identifiers and its key material ---
let freshAddress = "" as Address
let userOpHash: Hex | undefined
let registeredQx = 0n
let registeredQy = 0n
let actualGasCost: unknown

async function main(): Promise<void> {
  await step("a", "fresh-account", async () => {
    freshPrivateKey = generatePrivateKey()
    secrets.push(freshPrivateKey)
    const account = privateKeyToAccount(freshPrivateKey)
    freshAddress = account.address.toLowerCase() as Address
    allow.add(freshAddress)
    const [chainId, balance] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBalance({ address: account.address }),
    ])
    if (BigInt(chainId) !== MONAD_TESTNET_CHAIN_ID) throw new Error(`RPC ${rpcUrl} is chain ${chainId}, not Monad testnet 10143`)
    if (balance !== 0n) throw new Error(`fresh address unexpectedly holds ${balance} wei`)
    return { detail: { freshAddress, chainId, balanceWei: balance.toString() } }
  })

  await step("b", "implementation-code", async () => {
    const code = await publicClient.getCode({ address: PIMLICO_7702_IMPLEMENTATION })
    if (code === undefined || code === "0x") {
      return {
        status: "fail",
        detail: {
          implementation: PIMLICO_7702_IMPLEMENTATION,
          reason: "no code at the address permissionless delegates to — the Sepolia default does not exist on Monad testnet",
        },
      }
    }
    return { detail: { implementation: PIMLICO_7702_IMPLEMENTATION, codeBytes: (code.length - 2) / 2 } }
  })

  const sponsoredEnvPresent = env.PIMLICO_API_KEY !== undefined && env.PIMLICO_POLICY_ID !== undefined

  await step("c", "sponsored-register", async () => {
    if (!sponsoredEnvPresent) return { status: "skip", detail: { reason: "PIMLICO_API_KEY or PIMLICO_POLICY_ID missing" } }
    // A throwaway "P256 key": the contract requires qx,qy != 0 and records them against msg.sender;
    // it never checks the curve (real assertion checks happen at rotation). registerP256Key is the
    // cheapest owner-scoped write any address may call for itself.
    registeredQx = BigInt(`0x${randomBytes(32).toString("hex")}`)
    registeredQy = BigInt(`0x${randomBytes(32).toString("hex")}`)
    const account = privateKeyToAccount(storedFreshKey())
    const pimlico = createPimlicoClient({
      chain: monadTestnet,
      transport: http(pimlicoUrl),
      entryPoint: { address: entryPoint08Address, version: "0.8" },
    })
    const smartAccount = await to7702SimpleSmartAccount({ client: publicClient, owner: account })
    const bundler = createSmartAccountClient({
      account: smartAccount,
      chain: monadTestnet,
      bundlerTransport: http(pimlicoUrl),
      paymaster: pimlico,
      paymasterContext: { sponsorshipPolicyId: env.PIMLICO_POLICY_ID },
      userOperation: {
        estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
      },
    })
    const callData = encodeFunctionData({
      abi: capabilityRegistryAbi,
      functionName: "registerP256Key",
      args: [registeredQx, registeredQy],
    })
    userOpHash = await bundler.sendUserOperation({
      calls: [{ to: deployment.capabilityRegistry, value: 0n, data: callData }],
    }) as Hex
    allow.add(userOpHash)
    const userOpReceipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 })
    allow.add(userOpReceipt.receipt.transactionHash)
    actualGasCost = userOpReceipt.actualGasCost
    return {
      status: userOpReceipt.success ? "pass" : "fail",
      detail: {
        userOpHash,
        transactionHash: userOpReceipt.receipt.transactionHash,
        success: userOpReceipt.success,
        sender: userOpReceipt.sender,
        paymaster: userOpReceipt.paymaster,
        actualGasUsed: String(userOpReceipt.actualGasUsed),
        actualGasCost: String(userOpReceipt.actualGasCost),
        revertReason: "reason" in userOpReceipt ? String(userOpReceipt.reason) : undefined,
      },
    }
  })

  await step("d", "sender-is-owner", async () => {
    if (userOpHash === undefined) return { status: "skip", detail: { reason: "no sponsored operation succeeded to check" } }
    const [qx, qy] = (await publicClient.readContract({
      address: deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "ownerP256Key",
      args: [freshAddress],
    })) as [bigint, bigint]
    const recorded = qx === registeredQx && qy === registeredQy
    return {
      status: recorded ? "pass" : "fail",
      detail: {
        recordedUnder: freshAddress,
        expectedQx: `0x${registeredQx.toString(16)}`,
        expectedQy: `0x${registeredQy.toString(16)}`,
        onchainQx: `0x${qx.toString(16)}`,
        onchainQy: `0x${qy.toString(16)}`,
        outcome: recorded ? "msg.sender was the fresh address — the payer changed, the sender did not" : "key was not recorded under the fresh address",
      },
    }
  })

  await step("e", "gas-fields", async () => {
    if (userOpHash === undefined) return { status: "skip", detail: { reason: "no sponsored operation to inspect" } }
    if (!sponsoredEnvPresent) return { status: "skip", detail: { reason: "PIMLICO_API_KEY missing" } }
    const pimlico = createPimlicoClient({
      chain: monadTestnet,
      transport: http(pimlicoUrl),
      entryPoint: { address: entryPoint08Address, version: "0.8" },
    })
    const { userOperation } = await pimlico.getUserOperation({ hash: userOpHash })
    const op = userOperation as unknown as Record<string, unknown>
    const fields: Record<string, string> = {}
    for (const key of [
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ]) {
      if (op[key] !== undefined) fields[key] = String(op[key])
    }
    return {
      detail: {
        requestedGasFields: fields,
        billedToPaymaster: { actualGasCost: String(actualGasCost) },
        note: "Monad bills the LIMIT on every field, not gas used — the requested column is what the sponsor paid for",
      },
    }
  })

  await step("f", "self-paid-under-10mon", async () => {
    if (env.DEPLOYER_PRIVATE_KEY === undefined) return { status: "skip", detail: { reason: "DEPLOYER_PRIVATE_KEY missing" } }
    const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex)
    const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) })
    const fundingHash = await deployerWallet.sendTransaction({ to: freshAddress, value: STEP_F_FUNDING_WEI, chain: monadTestnet })
    allow.add(fundingHash)
    const fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: fundingHash })
    if (fundingReceipt.status !== "success") throw new Error(`funding transaction ${fundingHash} reverted`)
    // Wait past Monad's k-block funded-account delay before the fresh address spends its own gas.
    while ((await publicClient.getBlockNumber()) < fundingReceipt.blockNumber + FUNDING_LAG_BLOCKS) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const code = await publicClient.getCode({ address: freshAddress })
    const delegated = typeof code === "string" && code.startsWith("0xef0100")
    const freshWallet = createWalletClient({ account: privateKeyToAccount(storedFreshKey()), chain: monadTestnet, transport: http(rpcUrl) })
    try {
      const hash = await freshWallet.sendTransaction({ to: deployer.address, value: 0n, chain: monadTestnet })
      allow.add(hash)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      return {
        status: receipt.status === "success" ? "pass" : "fail",
        detail: {
          outcome: receipt.status === "success" ? "delegated address self-paid successfully" : "self-paid transaction reverted after inclusion",
          delegated,
          fundedWei: STEP_F_FUNDING_WEI.toString(),
          transactionHash: hash,
          receiptStatus: receipt.status,
        },
      }
    } catch (error) {
      return {
        status: "fail",
        detail: {
          outcome: "self-paid transaction rejected before inclusion — a delegated address under 10 MON cannot pay its own gas",
          delegated,
          fundedWei: STEP_F_FUNDING_WEI.toString(),
          error: maskForLog(error instanceof Error ? error.message : String(error), { secrets, allow: [...allow] }),
        },
      }
    }
  })

  await step("g", "clear-delegation", async () => {
    if (!sponsoredEnvPresent) return { status: "skip", detail: { reason: "PIMLICO_API_KEY or PIMLICO_POLICY_ID missing" } }
    if (userOpHash === undefined) return { status: "skip", detail: { reason: "no sponsored operation succeeded earlier" } }
    const account = privateKeyToAccount(storedFreshKey())
    const pimlico = createPimlicoClient({
      chain: monadTestnet,
      transport: http(pimlicoUrl),
      entryPoint: { address: entryPoint08Address, version: "0.8" },
    })
    const smartAccount = await to7702SimpleSmartAccount({ client: publicClient, owner: account })
    const bundler = createSmartAccountClient({
      account: smartAccount,
      chain: monadTestnet,
      bundlerTransport: http(pimlicoUrl),
      paymaster: pimlico,
      paymasterContext: { sponsorshipPolicyId: env.PIMLICO_POLICY_ID },
      userOperation: {
        estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
      },
    })
    // Clearing needs no Mida call: an authorization to the zero address plus an execute() to the
    // sender itself with empty data — the exact shape the sponsor worker's ALLOW_CLEARING flag
    // gates. The detail below records HOW it failed, because each failure means something
    // different for the flag: rejected before inclusion or reverted inside means a delegated
    // account cannot validate an operation carrying a clearing authorization at all — the flag
    // stays off forever; included-but-not-cleared means the shape did not apply — fix the shape.
    const clearing = await account.signAuthorization({
      contractAddress: zeroAddress,
      chainId: Number(MONAD_TESTNET_CHAIN_ID),
      nonce: await publicClient.getTransactionCount({ address: freshAddress }),
    })
    let clearHash: Hex
    try {
      clearHash = await bundler.sendUserOperation({
        calls: [{ to: freshAddress, value: 0n, data: "0x" as Hex }],
        authorization: clearing,
      }) as Hex
    } catch (error) {
      return {
        status: "fail",
        detail: {
          clearingPossible: false,
          stage: "rejected-before-inclusion",
          outcome:
            "the sponsored clearing operation was rejected before inclusion — a delegated account cannot validate an operation carrying a clearing authorization; ALLOW_CLEARING must stay off",
          error: maskForLog(error instanceof Error ? error.message : String(error), { secrets, allow: [...allow] }),
        },
      }
    }
    allow.add(clearHash)
    const receipt = await bundler.waitForUserOperationReceipt({ hash: clearHash, timeout: 180_000 })
    allow.add(receipt.receipt.transactionHash)
    const codeAfter = await publicClient.getCode({ address: freshAddress })
    const cleared = codeAfter === undefined || !codeAfter.startsWith("0xef0100")
    if (!receipt.success) {
      return {
        status: "fail",
        detail: {
          clearingPossible: false,
          stage: "included-but-reverted",
          outcome:
            "the clearing operation was included but reverted — the account could not validate it under a clearing authorization; ALLOW_CLEARING must stay off",
          userOpHash: clearHash,
          transactionHash: receipt.receipt.transactionHash,
          codeAfterPrefix: typeof codeAfter === "string" ? codeAfter.slice(0, 10) : String(codeAfter),
        },
      }
    }
    if (!cleared) {
      return {
        status: "fail",
        detail: {
          clearingPossible: false,
          stage: "included-but-not-cleared",
          outcome:
            "the operation succeeded but the delegation code remains — the clearing shape did not apply; investigate the shape, not the flag",
          userOpHash: clearHash,
          transactionHash: receipt.receipt.transactionHash,
          codeAfterPrefix: typeof codeAfter === "string" ? codeAfter.slice(0, 10) : String(codeAfter),
        },
      }
    }
    return {
      status: "pass",
      detail: {
        clearingPossible: true,
        stage: "cleared",
        outcome: "sponsored delegation clearing works — ALLOW_CLEARING may be enabled deliberately",
        userOpHash: clearHash,
        transactionHash: receipt.receipt.transactionHash,
        codeAfterPrefix: typeof codeAfter === "string" ? codeAfter.slice(0, 10) : String(codeAfter),
      },
    }
  })
}

/**
 * The fresh key is generated in step a and needed again in c/f/g; kept module-private so the only
 * copy lives in this process and in `secrets` for masking.
 */
let freshPrivateKey: Hex | undefined
function storedFreshKey(): Hex {
  if (freshPrivateKey === undefined) throw new Error("internal: fresh key requested before step a")
  return freshPrivateKey
}

async function run(): Promise<void> {
  await main()
  const evidence = buildEvidence({ chainId: Number(MONAD_TESTNET_CHAIN_ID), freshAddress, steps })
  const text = maskForLog(JSON.stringify(evidence, null, 2), { secrets, allow: [...allow] })
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
  writeFileSync(EVIDENCE_PATH, `${text}\n`)
  print(`WROTE ${EVIDENCE_PATH} — passed ${evidence.summary.passed}, failed ${evidence.summary.failed}, skipped ${evidence.summary.skipped}`)
  if (evidence.summary.failed > 0) process.exitCode = 1
}

await run()
