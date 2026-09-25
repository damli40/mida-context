// Writes the contract ABIs the indexer needs as plain JSON files under apps/indexer/abi/.
// Source of truth is packages/chain/src/abis.ts (itself generated from contracts/out by
// `pnpm chain:abis`). Never edit abi/*.json by hand — run `pnpm --filter @mida/indexer export-abis`
// after any contract change. apps/indexer/test/abi-freshness.test.ts fails when these files drift.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { pathToFileURL } from "node:url"

const outDir = new URL("../abi/", import.meta.url)
const abiSourceUrl = new URL("../../../packages/chain/src/abis.ts", import.meta.url)

// abis.ts is TypeScript (`as const`), so it cannot be imported from a plain .mjs file.
// The file is machine-generated as `export const <name> = <json> as const`, so the JSON
// array can be extracted textually. The trailing "as const" anchor keeps this unambiguous.
export const extractAbi = (constName, source = readFileSync(abiSourceUrl, "utf8")) => {
  const marker = `export const ${constName} = `
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`abis.ts: could not find "${marker.trim()}"`)
  const body = source.slice(start + marker.length)
  const end = body.indexOf(" as const")
  if (end === -1) throw new Error(`abis.ts: "${constName}" is not followed by "as const"`)
  return JSON.parse(body.slice(0, end).trim())
}

// The exact object the JSON files are generated from — the freshness test
// compares this against what is on disk.
export const buildAbiJson = () => ({
  CapabilityRegistry: `${JSON.stringify(extractAbi("capabilityRegistryAbi"), null, 2)}\n`,
  ContextRegistry: `${JSON.stringify(extractAbi("contextRegistryAbi"), null, 2)}\n`,
  BatchAnchor: `${JSON.stringify(extractAbi("batchAnchorAbi"), null, 2)}\n`,
})

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  mkdirSync(outDir, { recursive: true })
  for (const [name, json] of Object.entries(buildAbiJson())) {
    writeFileSync(new URL(`${name}.json`, outDir), json)
    console.log(`abi/${name}.json <- ${JSON.parse(json).length} ABI items`)
  }
}
