import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { POLICY_HASH_V1 } from "../src/policy.js"

const outPath = fileURLToPath(new URL("../../../contracts/test/vectors/policy-v1.json", import.meta.url))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ policyHash: POLICY_HASH_V1 }, null, 2)}\n`)
console.log(`wrote ${outPath} policyHash=${POLICY_HASH_V1}`)
