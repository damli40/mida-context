// Unit tests for the pure helpers behind scripts/bench-batch-anchor.mts — argument parsing,
// per-save division, percentiles and the evidence JSON shape. No network: these run in the
// normal vitest pass. The import goes through the .ts shim so the whole path a .ts consumer
// would use is what gets exercised.

import { describe, expect, it } from "vitest"
import { MAX_BATCH_SIZE, buildEvidence, chargedWei, parseArgs, perSave, percentile } from "./bench-batch-anchor-lib.js"
import type { BenchEvidenceInput } from "./bench-batch-anchor-lib.js"

describe("percentile", () => {
  it("takes the nearest-rank element of a sorted list", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50)
    expect(percentile([10, 20, 30, 40, 50], 100)).toBe(50)
  })

  it("sorts first, so input order does not matter", () => {
    expect(percentile([50, 10, 40, 20, 30], 50)).toBe(30)
  })

  it("returns an observed value, never an interpolation", () => {
    // rank = ceil(p/100 * n): [1, 100] at p50 is rank 1 → 1, not the interpolated 50.5
    expect(percentile([1, 100], 50)).toBe(1)
    expect(percentile([1, 100], 51)).toBe(100)
  })

  it("answers the single value for a one-element list", () => {
    expect(percentile([42], 95)).toBe(42)
  })

  it("refuses an empty list — a percentile of nothing would fabricate a measurement", () => {
    expect(() => percentile([], 50)).toThrow()
  })

  it("refuses p outside (0, 100]", () => {
    expect(() => percentile([1, 2, 3], 0)).toThrow()
    expect(() => percentile([1, 2, 3], -5)).toThrow()
    expect(() => percentile([1, 2, 3], 101)).toThrow()
  })

  it("refuses non-finite values — NaN would sort unpredictably and print as a number", () => {
    expect(() => percentile([1, Number.NaN, 3], 50)).toThrow()
    expect(() => percentile([1, Number.POSITIVE_INFINITY, 3], 50)).toThrow()
  })
})

describe("perSave", () => {
  it("divides a wei total across the save count", () => {
    expect(perSave(100n, 4)).toBe(25n)
  })

  it("truncates toward zero — fractional wei cannot exist", () => {
    expect(perSave(7n, 2)).toBe(3n)
  })

  it("handles zero wei", () => {
    expect(perSave(0n, 5)).toBe(0n)
  })

  it("refuses zero saves instead of returning a fabricated number", () => {
    expect(() => perSave(100n, 0)).toThrow()
  })

  it("refuses negative and non-integer save counts", () => {
    expect(() => perSave(100n, -1)).toThrow()
    expect(() => perSave(100n, 1.5)).toThrow()
  })
})

describe("chargedWei", () => {
  it("is gasLimit times effectiveGasPrice — Monad bills the reserved limit, not gas used", () => {
    expect(chargedWei(650_000n, 100_000_000_000n)).toBe(65_000_000_000_000_000n)
  })

  it("is zero when either factor is zero", () => {
    expect(chargedWei(0n, 100n)).toBe(0n)
    expect(chargedWei(100n, 0n)).toBe(0n)
  })
})

function sampleInput(): BenchEvidenceInput {
  return {
    date: "2026-09-24",
    chainId: 10143n,
    batchAnchor: "0xF07D24dBD1FE21645a0489a94baE2c99d7E0E80b",
    contextRegistry: "0x1111111111111111111111111111111111111111",
    monPriceUsd: 0.12,
    direct: { saves: 20, txs: 20, chargedWeiPerSave: 1234n, gasUsedPerSave: 567n },
    batched: { saves: 60, txs: 3, batchSize: 20, chargedWeiPerSave: 100n, gasUsedPerSave: 90n, rejected: 2 },
    maxSavesPerTxObserved: 20,
    notes: ["a note"],
  }
}

describe("buildEvidence", () => {
  it("produces exactly the documented key set, top level and per phase", () => {
    const evidence = buildEvidence(sampleInput())
    expect(Object.keys(evidence).sort()).toEqual(
      ["batchAnchor", "batched", "chainId", "contextRegistry", "date", "direct", "maxSavesPerTxObserved", "monPriceUsd", "notes"].sort(),
    )
    expect(Object.keys(evidence.direct).sort()).toEqual(["chargedWeiPerSave", "gasUsedPerSave", "saves", "txs"].sort())
    expect(Object.keys(evidence.batched).sort()).toEqual(
      ["batchSize", "chargedWeiPerSave", "gasUsedPerSave", "rejected", "saves", "txs"].sort(),
    )
  })

  it("serializes wei fields as decimal strings and chainId as a number", () => {
    const evidence = buildEvidence(sampleInput())
    expect(evidence.direct.chargedWeiPerSave).toBe("1234")
    expect(evidence.direct.gasUsedPerSave).toBe("567")
    expect(evidence.batched.chargedWeiPerSave).toBe("100")
    expect(evidence.batched.gasUsedPerSave).toBe("90")
    expect(evidence.chainId).toBe(10143)
    expect(evidence.date).toBe("2026-09-24")
    expect(evidence.monPriceUsd).toBe(0.12)
    expect(evidence.maxSavesPerTxObserved).toBe(20)
    expect(evidence.notes).toEqual(["a note"])
  })

  it("omits latencyMs unless supplied, and carries p50/p95 when it is", () => {
    expect("latencyMs" in buildEvidence(sampleInput()).batched).toBe(false)
    const withLatency = buildEvidence({
      ...sampleInput(),
      batched: { ...sampleInput().batched, latencyMs: { p50: 800, p95: 1500 } },
    })
    expect(withLatency.batched.latencyMs).toEqual({ p50: 800, p95: 1500 })
  })

  it("cannot leak a field the evidence shape does not name — the output is built field by field", () => {
    const secret = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
    const sneaky = { ...sampleInput(), deployerPrivateKey: secret }
    const evidence = buildEvidence(sneaky)
    expect("deployerPrivateKey" in evidence).toBe(false)
    expect(JSON.stringify(evidence)).not.toContain(secret)
  })
})

describe("parseArgs", () => {
  it("requires only --price-usd and defaults the small first run", () => {
    expect(parseArgs(["--price-usd", "0.12"])).toEqual({ saves: 20, batch: 20, agents: 2, priceUsd: 0.12 })
  })

  it("parses every flag", () => {
    expect(
      parseArgs(["--saves", "200", "--batch", "60", "--agents", "4", "--price-usd", "1.5", "--store", "https://store.example"]),
    ).toEqual({ saves: 200, batch: 60, agents: 4, priceUsd: 1.5, store: "https://store.example" })
  })

  it("refuses a missing --price-usd", () => {
    expect(() => parseArgs(["--saves", "20"])).toThrow(/--price-usd/)
  })

  it("refuses --price-usd that is not a positive number", () => {
    expect(() => parseArgs(["--price-usd", "0"])).toThrow(/--price-usd/)
    expect(() => parseArgs(["--price-usd", "-1"])).toThrow(/--price-usd/)
    expect(() => parseArgs(["--price-usd", "cheap"])).toThrow(/--price-usd/)
  })

  it(`refuses --batch above ${MAX_BATCH_SIZE} and says why — the 28M batch.submit budget, not the 30M wall`, () => {
    expect(() => parseArgs(["--price-usd", "1", "--batch", "433"])).toThrow(/28,000,000/)
    expect(() => parseArgs(["--price-usd", "1", "--batch", String(MAX_BATCH_SIZE + 1)])).toThrow(/28,000,000/)
    expect(() => parseArgs(["--price-usd", "1", "--batch", "1024"])).toThrow(new RegExp(String(MAX_BATCH_SIZE)))
  })

  it("accepts --batch at the cap — 432 = floor(28,000,000 × 0.95 / 61,457) at the sweep's lowest per-save gas", () => {
    expect(parseArgs(["--price-usd", "1", "--batch", "432"]).batch).toBe(432)
  })

  it("refuses non-positive integers for --saves, --batch and --agents", () => {
    expect(() => parseArgs(["--price-usd", "1", "--saves", "0"])).toThrow(/--saves/)
    expect(() => parseArgs(["--price-usd", "1", "--batch", "0"])).toThrow(/--batch/)
    expect(() => parseArgs(["--price-usd", "1", "--agents", "0"])).toThrow(/--agents/)
    expect(() => parseArgs(["--price-usd", "1", "--saves", "two"])).toThrow(/--saves/)
  })

  it("refuses a flag with no value", () => {
    expect(() => parseArgs(["--price-usd"])).toThrow()
    expect(() => parseArgs(["--price-usd", "1", "--batch"])).toThrow(/--batch/)
  })

  it("refuses unknown flags and stray positionals — a benchmark cannot half-read its arguments", () => {
    expect(() => parseArgs(["--price-usd", "1", "--bogus", "3"])).toThrow(/unknown argument/)
    expect(() => parseArgs(["--price-usd", "1", "leftover"])).toThrow(/unknown argument/)
  })

  it("accepts an http(s) --store URL and refuses anything else", () => {
    expect(parseArgs(["--price-usd", "1", "--store", "https://store.example"]).store).toBe("https://store.example")
    expect(() => parseArgs(["--price-usd", "1", "--store", "notaurl"])).toThrow(/--store/)
    expect(() => parseArgs(["--price-usd", "1", "--store", "ftp://store.example"])).toThrow(/--store/)
  })
})
