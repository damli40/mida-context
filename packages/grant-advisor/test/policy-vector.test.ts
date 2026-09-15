import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { POLICY_HASH_V1 } from "@mida/grant-advisor"

const vectorPath = fileURLToPath(new URL("../../../contracts/test/vectors/policy-v1.json", import.meta.url))

describe("policy hash handoff to Solidity (Task 14)", () => {
  it("the committed vector file matches the TypeScript policy hash", () => {
    expect(JSON.parse(readFileSync(vectorPath, "utf8"))).toEqual({ policyHash: POLICY_HASH_V1 })
  })
})
