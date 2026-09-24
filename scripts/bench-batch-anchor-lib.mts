// Pure helpers for scripts/bench-batch-anchor.mts — argument parsing, per-save division,
// percentiles and the evidence JSON shape. No network, no environment and no filesystem access,
// so this file is unit-tested without touching Monad testnet, a private key or a deployment.
//
// This file is .mts on purpose: bench-batch-anchor.mts is an .mts module and under
// moduleResolution NodeNext an .mts importer resolves ".js" specifiers to .mjs/.mts only — it
// could not import a plain .ts sibling. scripts/bench-batch-anchor-lib.ts is the re-export shim
// carrying the path the task brief names.

/**
 * The largest batch the runner submits in one transaction. The cap is operational, not a
 * contract limit (BatchAnchor.sol's MAX_BATCH is 1024): Monad refuses any transaction over
 * 30,000,000 gas, and the "batch.submit" ceiling budgets 28,000,000 — at the Sep 24 sweep's
 * lowest measured per-save cost (61,457 gas; docs/evidence/batch-anchor-sweep-2026-09-24.json)
 * the bound is floor(28,000,000 × 0.95 / 61,457) = 432. The earlier 480 was wrong: ~29.5M at
 * the same rate crosses the ceiling the estimate is checked against. The store's batcher sizes
 * each batch by a learned gas budget under the same rule; a larger --batch is refused rather
 * than weakening the limit.
 */
export const MAX_BATCH_SIZE = 432

/** Parsed benchmark command line. `--price-usd` is the only required flag. */
export interface BenchArgs {
  /** Checkpoint saves in the batched phase; the direct phase runs min(saves, 20). */
  saves: number
  /** Saves per submitBatch transaction when the runner submits itself. */
  batch: number
  /** Throwaway agents created under the throwaway owner; saves round-robin across them. */
  agents: number
  /** The MON price in USD the run is measured against — recorded, never assumed. */
  priceUsd: number
  /** When set, batched saves are posted to this store instead of self-submitted. */
  store?: string
}

const USAGE =
  "usage: bench-batch-anchor.mts --price-usd <MON price in USD> [--saves n] [--batch size] [--agents k] [--store url]"

function flagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value — ${USAGE}`)
  }
  return value
}

function positiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a positive integer, got "${raw}"`)
  const value = Number.parseInt(raw, 10)
  if (value <= 0) throw new Error(`${flag} must be a positive integer, got "${raw}"`)
  return value
}

/**
 * Parses `--saves --batch --agents --price-usd --store`. `--price-usd` is required: the evidence
 * ties every wei number to a stated MON price and date, and a benchmark that silently picked a
 * price would produce cost numbers nobody can defend. `--batch` above 432 is refused with the
 * reason — it is Monad's 30,000,000-gas per-transaction limit at the sweep's ~61k per save, not
 * the contract's own limit. Unknown flags and stray positionals are refused too: a benchmark that
 * half-read its arguments reports numbers for a run that was not the one asked for.
 */
export function parseArgs(argv: string[]): BenchArgs {
  let saves = 20
  let batch = 20
  let agents = 2
  let priceUsd: number | undefined
  let store: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--saves":
        saves = positiveInt(flagValue(argv, i, arg), arg)
        i += 1
        break
      case "--batch": {
        const value = positiveInt(flagValue(argv, i, arg), arg)
        if (value > MAX_BATCH_SIZE) {
          throw new Error(
            `--batch is capped at ${MAX_BATCH_SIZE}: Monad refuses any transaction over 30,000,000 gas and the Sep 24 sweep measured ~61k gas per save, so a larger batch would not fit the per-transaction limit`,
          )
        }
        batch = value
        i += 1
        break
      }
      case "--agents":
        agents = positiveInt(flagValue(argv, i, arg), arg)
        i += 1
        break
      case "--price-usd": {
        const raw = flagValue(argv, i, arg)
        const value = Number(raw)
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--price-usd must be a positive number, got "${raw}"`)
        }
        priceUsd = value
        i += 1
        break
      }
      case "--store": {
        const raw = flagValue(argv, i, arg)
        let url: URL
        try {
          url = new URL(raw)
        } catch {
          throw new Error(`--store must be a URL, got "${raw}"`)
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error(`--store must be an http(s) URL, got "${raw}"`)
        }
        store = raw
        i += 1
        break
      }
      default:
        throw new Error(`unknown argument "${arg}" — ${USAGE}`)
    }
  }
  if (priceUsd === undefined) {
    throw new Error(`--price-usd is required — the evidence ties every wei figure to a stated MON price — ${USAGE}`)
  }
  return { saves, batch, agents, priceUsd, ...(store === undefined ? {} : { store }) }
}

/**
 * Nearest-rank percentile: sort, take the element at rank ceil(p/100 × n). The answer is always
 * an observed value — never an interpolation — so a p95 line in the evidence is a real
 * measurement, not a blend of two. Throws on an empty list and on p outside (0, 100]: a
 * percentile of nothing, or past the last rank, would print a number that was never measured.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new RangeError("percentile: no values")
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile: p must be in (0, 100], got ${p}`)
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError(`percentile: ${value} is not a finite number`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]!
}

/**
 * Integer division of a wei total across a save count — truncation is deliberate (evidence
 * reports wei, where a fractional wei cannot exist). Zero or non-integer `saves` is refused:
 * dividing by zero would be Infinity in a file that promises decimal strings.
 */
export function perSave(totalWei: bigint, saves: number): bigint {
  if (!Number.isInteger(saves) || saves <= 0) {
    throw new RangeError(`perSave: saves must be a positive integer, got ${saves}`)
  }
  return totalWei / BigInt(saves)
}

/**
 * What a transaction actually costs the payer on Monad: the reserved gas LIMIT times the
 * effective gas price. Monad bills the limit, not the gas used — receipt.gasUsed is reported
 * alongside for comparison but is never the charge. (gas.ts and the sponsor probe say the same.)
 */
export function chargedWei(gasLimit: bigint, effectiveGasPrice: bigint): bigint {
  return gasLimit * effectiveGasPrice
}

/** The shared fields of one measured phase; wei is decimal strings so JSON.stringify never sees a bigint. */
export interface PhaseEvidence {
  saves: number
  txs: number
  chargedWeiPerSave: string
  gasUsedPerSave: string
}

export interface BatchedPhaseEvidence extends PhaseEvidence {
  batchSize: number
  rejected: number
  /** Present only when the run went through a real store (--store): queued→anchored ms. */
  latencyMs?: { p50: number; p95: number }
}

/** The file written to docs/evidence/batch-anchor-benchmark-<date>.json. */
export interface BenchEvidence {
  date: string
  chainId: number
  batchAnchor: string
  contextRegistry: string
  monPriceUsd: number
  direct: PhaseEvidence
  batched: BatchedPhaseEvidence
  maxSavesPerTxObserved: number
  notes: string[]
}

/** What the runner hands buildEvidence — the same shape, with bigints where the chain reported them. */
export interface BenchEvidenceInput {
  date: string
  chainId: bigint
  batchAnchor: string
  contextRegistry: string
  monPriceUsd: number
  direct: { saves: number; txs: number; chargedWeiPerSave: bigint; gasUsedPerSave: bigint }
  batched: {
    saves: number
    txs: number
    batchSize: number
    chargedWeiPerSave: bigint
    gasUsedPerSave: bigint
    rejected: number
    latencyMs?: { p50: number; p95: number }
  }
  maxSavesPerTxObserved: number
  notes: string[]
}

/**
 * Builds the evidence object exactly — the key set is a whitelist constructed field by field, so
 * nothing else in `input` (a caller's mistake, a stray key) can leak into the file. Bigints are
 * serialized as decimal strings; chainId is the one exception, emitted as a number because a
 * chain id is a label, not a quantity anyone would compare as a string.
 */
export function buildEvidence(input: BenchEvidenceInput): BenchEvidence {
  return {
    date: input.date,
    chainId: Number(input.chainId),
    batchAnchor: input.batchAnchor,
    contextRegistry: input.contextRegistry,
    monPriceUsd: input.monPriceUsd,
    direct: {
      saves: input.direct.saves,
      txs: input.direct.txs,
      chargedWeiPerSave: input.direct.chargedWeiPerSave.toString(10),
      gasUsedPerSave: input.direct.gasUsedPerSave.toString(10),
    },
    batched: {
      saves: input.batched.saves,
      txs: input.batched.txs,
      batchSize: input.batched.batchSize,
      chargedWeiPerSave: input.batched.chargedWeiPerSave.toString(10),
      gasUsedPerSave: input.batched.gasUsedPerSave.toString(10),
      rejected: input.batched.rejected,
      ...(input.batched.latencyMs === undefined ? {} : { latencyMs: { p50: input.batched.latencyMs.p50, p95: input.batched.latencyMs.p95 } }),
    },
    maxSavesPerTxObserved: input.maxSavesPerTxObserved,
    notes: [...input.notes],
  }
}
