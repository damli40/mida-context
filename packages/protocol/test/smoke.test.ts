import { describe, expect, it } from "vitest"
import { PROTOCOL_VERSION } from "@mida/protocol"

describe("@mida/protocol workspace wiring", () => {
  it("resolves the package through the workspace", () => {
    expect(PROTOCOL_VERSION).toBe("mida-protocol-v1")
  })
})
