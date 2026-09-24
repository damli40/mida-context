import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ownerSrc = join(dirname(fileURLToPath(import.meta.url)), "../src/owner")

/**
 * T7 disclosure wording: the two screens where the owner decides about access must state the true
 * model — approval hands the model the context as plain text, and revocation stops future reads
 * without erasing what was already shown. The entry modules call `main()` on import and need a
 * real DOM, so the strings are pinned in their source (the same read-the-source pattern the
 * mida-mcp import-graph test uses).
 */
describe("disclosure wording on the owner page", () => {
  it("the approve screen says the agent sees plain text and revoking is not recall", () => {
    const source = readFileSync(join(ownerSrc, "approve.ts"), "utf8")
    expect(source).toContain(
      "It will see this context as plain text. Revoking later stops future reads, not what it already saw.",
    )
  })

  it("the revoke screen says it does not erase what the agent already read", () => {
    const source = readFileSync(join(ownerSrc, "revoke.ts"), "utf8")
    expect(source).toContain("It does not erase what the agent already read.")
  })
})
