// Fails when abi/*.json no longer matches packages/chain/src/abis.ts.
// Regenerate with `pnpm --filter @mida/indexer export-abis` — never edit the
// JSON by hand.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildAbiJson } from "../scripts/export-abis.mjs"

describe("abi freshness", () => {
  for (const [name, expected] of Object.entries(buildAbiJson())) {
    it(`abi/${name}.json is up to date with packages/chain/src/abis.ts`, () => {
      const onDisk = readFileSync(new URL(`../abi/${name}.json`, import.meta.url), "utf8")
      expect(onDisk).toBe(expected)
    })
  }
})
