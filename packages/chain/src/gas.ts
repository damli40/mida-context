import { MidaError } from "@mida/protocol"
import type { Abi, Address } from "viem"
import type { WriteContext } from "./writes.js"

/**
 * Gas ceilings per transaction kind (M2 fix round 3, R3-1).
 *
 * Monad bills a transaction for the gas LIMIT it carries, not the gas it uses, and a reverted
 * transaction still pays its full limit — so the limit attached to every send must be a number
 * we chose. A send whose node estimate exceeds its kind's ceiling is refused, not sent.
 *
 * Measured basis: `bench/gas-measure.ts` on local Anvil, default and "prague" hardforks
 * (prague forces the Solidity P256 fallback, so its numbers dominate for the P256 paths).
 * "tx.gas" is the limit the node would attach; "gasUsed" is what the receipt reported.
 * Those ceilings were measured on a local chain with Ethereum gas pricing — Monad prices cold
 * reads about 4x higher (contract tests rose 8.5% overall, up to 26% for revoke-everywhere), so
 * the Monad testnet figures are the ones to trust.
 */
export const GAS_CEILINGS = {
  // Plain value transfer (environment funding). Measured estimate 21,000, both hardforks.
  // 2x the measurement, rounded up to the next 50,000.
  funding: 50_000n,
  // registerP256Key. Ceiling 200,000. Measured tx.gas 69,388, both hardforks.
  "owner.key": 200_000n,
  // rotateP256Key. Measured tx.gas 428,088 under prague (78,817 default) — the fallback P256
  // verifier dominates. 2x = 856,176, rounded up to the next 50,000.
  "owner.keyRotate": 900_000n,
  // initializeReadEpoch. Ceiling 150,000. Measured tx.gas 49,977, both hardforks.
  "epoch.init": 150_000n,
  // rotateExpiredEpoch. Ceiling 300,000. Measured tx.gas 96,331 / gasUsed 81,931, both hardforks.
  "epoch.rotateExpired": 300_000n,
  // registerAgent. Measured tx.gas 214,138, both hardforks. 2x = 428,276, rounded up.
  "agent.register": 450_000n,
  // contextRegistry.register. Ceiling 650,000. Measured tx.gas 236,365 under prague.
  "context.register": 650_000n,
  // grantBatch. Ceiling 1,500,000 — grows with the scope count and with how many grants the
  // agent already holds. Measured tx.gas 654,761 under prague for the benchmark-sized batch.
  // Live cost finding (Monad testnet, Sep 21): re-approving a previously revoked agent billed
  // 832,470 gas — about twice a first approval (403,382 to 424,323) — because the compacted
  // capability list is rebuilt on top of the old grant rows.
  "grant.batch": 1_500_000n,
  // revoke (single capability). Measured tx.gas 55,430, both hardforks. 2x = 110,860, rounded up.
  "revoke.capability": 150_000n,
  // revokeAndRotate. Ceiling 450,000. Measured tx.gas 120,397 / gasUsed 101,197 under prague.
  "revoke.rotate": 450_000n,
  // revokeAgentAndRotate. Ceiling 6,000,000 — loops over every area the agent reads.
  // Measured tx.gas 122,926 for a two-scope agent.
  "revoke.agent": 6_000_000n,
} as const

/** The named kind every transaction send must declare; a send with no kind does not compile. */
export type TxKind = keyof typeof GAS_CEILINGS

function checked(kind: TxKind, estimate: bigint): bigint {
  const ceiling = GAS_CEILINGS[kind]
  if (estimate > ceiling) {
    throw new MidaError("GAS_CEILING_EXCEEDED", `${kind}: estimate ${estimate} exceeds ceiling ${ceiling}`)
  }
  return estimate
}

/**
 * The gas limit for a contract write: the node's estimate, sent explicitly and unpadded, refused
 * when it exceeds the kind's ceiling. An estimate call that fails surfaces its own error.
 */
export async function contractGas(
  context: WriteContext,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  kind: TxKind,
): Promise<bigint> {
  const estimate = await context.publicClient.estimateContractGas({
    account: context.account,
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never)
  return checked(kind, estimate)
}

/** The gas limit for a plain value transfer, under the same ceiling rule as a contract write. */
export async function valueGas(context: WriteContext, transfer: { to: Address; value: bigint }, kind: TxKind): Promise<bigint> {
  const estimate = await context.publicClient.estimateGas({ account: context.account, to: transfer.to, value: transfer.value })
  return checked(kind, estimate)
}
