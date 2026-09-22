// Types for export-abis.mjs — kept beside it so the root typecheck sees the
// imports in test/abi-freshness.test.ts. Update if the .mjs exports change.
export function extractAbi(constName: string, source?: string): unknown[]
export function buildAbiJson(): Record<"CapabilityRegistry" | "ContextRegistry", string>
