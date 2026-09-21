// Pure helpers for scripts/sponsor-probe.mts — masking and the evidence JSON shape.
// These carry no network code so they can be unit-tested without touching Monad or Pimlico.
//
// This file is .mts on purpose: sponsor-probe.mts is a .mts module and under moduleResolution
// NodeNext an .mts importer resolves ".js" specifiers to .mjs/.mts only — it could not import a
// plain .ts sibling. scripts/sponsor-probe-lib.ts is a re-export shim left for the path the
// first M3-B run created.

/**
 * A run of 40 or more hexadecimal characters — with or without a 0x prefix. 40 is the length of
 * an address; anything longer is a hash, a key or a signature. Every such run is masked unless it
 * is on the caller's allow list (transaction hashes, the fresh throwaway address, and public
 * contract constants that must stay readable for the evidence to mean anything).
 */
const HEX_RUN = /0x[0-9a-fA-F]{40,}|\b[0-9a-fA-F]{40,}\b/g

/** Masks every 40+ hex run except exact (case-insensitive) matches in `allow`. */
export function maskHexRuns(text: string, allow: readonly string[] = []): string {
  const allowed = new Set(allow.map((value) => value.toLowerCase()))
  return text.replace(HEX_RUN, (match) => (allowed.has(match.toLowerCase()) ? match : `${match.slice(0, 10)}…[masked]`))
}

/**
 * Replaces every occurrence of each secret with `[redacted]`. Secrets shorter than 8 characters
 * are skipped: masking on a tiny string would mangle ordinary words, and no real key is that short.
 */
export function maskSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]")
  }
  return out
}

/**
 * The one mask applied to every printed line and to the serialized evidence: secrets first
 * (a provider error that echoes the API key must never reach the file), then hex runs.
 */
export function maskForLog(
  text: string,
  options: { secrets?: readonly (string | undefined)[]; allow?: readonly string[] } = {},
): string {
  return maskHexRuns(maskSecrets(text, options.secrets ?? []), options.allow ?? [])
}

export type ProbeStepStatus = "pass" | "fail" | "skip"

/** One numbered step of the probe: the id and name stay stable so the evidence diffs cleanly. */
export interface ProbeStep {
  id: string
  name: string
  status: ProbeStepStatus
  detail: Record<string, unknown>
}

export interface ProbeEvidence {
  probe: "m3-sponsor-probe"
  generatedAt: string
  chainId: number
  freshAddress: string
  steps: ProbeStep[]
  summary: { passed: number; failed: number; skipped: number }
}

/** The JSON written to docs/evidence/m3-sponsor-probe.json — one object, steps in run order. */
export function buildEvidence(input: { chainId: number; freshAddress: string; steps: ProbeStep[] }): ProbeEvidence {
  return {
    probe: "m3-sponsor-probe",
    generatedAt: new Date().toISOString(),
    chainId: input.chainId,
    freshAddress: input.freshAddress,
    steps: input.steps,
    summary: {
      passed: input.steps.filter((step) => step.status === "pass").length,
      failed: input.steps.filter((step) => step.status === "fail").length,
      skipped: input.steps.filter((step) => step.status === "skip").length,
    },
  }
}
