import { describe, expect, it } from "vitest"
import { zeroHash } from "viem"
import {
  NAMESPACE_TREE_V1,
  canonicalizeNamespace,
  domainOf,
  expandNamespace,
  isMidaError,
  namespaceById,
  namespaceId,
} from "@mida/protocol"

const invalidNamespace = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, "INVALID_NAMESPACE")
  }
  return false
}

describe("namespace canonicalization (§5.1)", () => {
  it("trims and lowercases", () => {
    expect(canonicalizeNamespace("Goals.Career")).toBe("goals.career")
    expect(canonicalizeNamespace("  PROJECTS ")).toBe("projects")
  })

  it("rejects malformed, too-deep and unknown namespaces", () => {
    const bad = [
      "", ".", "goals..career", ".goals", "goals.", "goals-career", "goals career",
      "goals.career.extra", "goals.unknown", "custom",
    ]
    for (const input of bad) {
      expect(invalidNamespace(() => canonicalizeNamespace(input)), input).toBe(true)
    }
  })
})

describe("frozen tree v1 (§5.2)", () => {
  it("has 22 nodes, unique ids, depth ≤ 2, and parents listed before children", () => {
    expect(NAMESPACE_TREE_V1).toHaveLength(22)
    expect(new Set(NAMESPACE_TREE_V1.map((node) => node.id)).size).toBe(22)
    const seen = new Set<string>()
    for (const node of NAMESPACE_TREE_V1) {
      expect(node.name.split(".").length).toBeLessThanOrEqual(2)
      if (node.parent !== null) {
        expect(seen.has(node.parent)).toBe(true)
        expect(node.name.startsWith(`${node.parent}.`)).toBe(true)
      }
      seen.add(node.name)
    }
  })

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(NAMESPACE_TREE_V1)).toBe(true)
    expect(Object.isFrozen(NAMESPACE_TREE_V1[0])).toBe(true)
  })

  it("derives namespaceId with ABI encoding (fixed vector)", () => {
    expect(namespaceId("goals.career")).toBe(
      "0x589f7a11985b453117a42b18c8c5a3783db67a59caa2b76beb33fd9ceb651c2a",
    )
  })

  it("resolves ids back to nodes and rejects unknown ids", () => {
    expect(namespaceById(namespaceId("projects.past")).name).toBe("projects.past")
    expect(invalidNamespace(() => namespaceById(zeroHash))).toBe(true)
  })
})

describe("parent expansion (§5.3) and isolation domains (§6.1)", () => {
  it("expands a parent to itself plus every registered descendant", () => {
    expect(expandNamespace("projects")).toEqual(["projects", "projects.current", "projects.past"])
    expect(expandNamespace("Preferences")).toEqual([
      "preferences", "preferences.communication", "preferences.tools", "preferences.work",
    ])
    expect(expandNamespace("goals.career")).toEqual(["goals.career"])
    expect(expandNamespace("credentials")).toEqual(["credentials"])
  })

  it("assigns every namespace to exactly one domain", () => {
    expect(domainOf("credentials")).toBe("general")
    expect(domainOf("profile.identity")).toBe("general")
    expect(domainOf("financial")).toBe("financial")
    expect(domainOf("financial.preferences")).toBe("financial")
    expect(domainOf("relationships")).toBe("relationships")
    expect(domainOf("private")).toBe("private")
  })
})
