import { encodeAbiParameters, keccak256 } from "viem"
import type { Hex } from "viem"
import { MidaError } from "./errors.js"

export type IsolationDomain = "general" | "financial" | "relationships" | "private"

export interface NamespaceNode {
  name: string
  parent: string | null
  domain: IsolationDomain
  id: Hex
}

/** §5.2 order. Solidity NamespaceTree registers nodes in exactly this order. */
const TREE_SOURCE: ReadonlyArray<readonly [string, string | null, IsolationDomain]> = [
  ["profile", null, "general"],
  ["profile.identity", "profile", "general"],
  ["profile.skills", "profile", "general"],
  ["goals", null, "general"],
  ["goals.career", "goals", "general"],
  ["goals.learning", "goals", "general"],
  ["goals.personal", "goals", "general"],
  ["preferences", null, "general"],
  ["preferences.communication", "preferences", "general"],
  ["preferences.tools", "preferences", "general"],
  ["preferences.work", "preferences", "general"],
  ["projects", null, "general"],
  ["projects.current", "projects", "general"],
  ["projects.past", "projects", "general"],
  ["decisions", null, "general"],
  ["decisions.career", "decisions", "general"],
  ["decisions.projects", "decisions", "general"],
  ["credentials", null, "general"],
  ["financial", null, "financial"],
  ["financial.preferences", "financial", "financial"],
  ["relationships", null, "relationships"],
  ["private", null, "private"],
]

const SHAPE = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/

export function namespaceId(canonicalNamespace: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "string" }], ["MIDA_NAMESPACE_V1", canonicalNamespace]),
  )
}

export const NAMESPACE_TREE_V1: readonly NamespaceNode[] = Object.freeze(
  TREE_SOURCE.map(([name, parent, domain]) => Object.freeze({ name, parent, domain, id: namespaceId(name) })),
)

const BY_NAME = new Map(NAMESPACE_TREE_V1.map((node) => [node.name, node]))
const BY_ID = new Map(NAMESPACE_TREE_V1.map((node) => [node.id, node]))

export function canonicalizeNamespace(input: string): string {
  const candidate = input.trim().toLowerCase()
  if (!SHAPE.test(candidate) || !BY_NAME.has(candidate)) {
    throw new MidaError("INVALID_NAMESPACE", JSON.stringify(input))
  }
  return candidate
}

function nodeByName(input: string): NamespaceNode {
  const node = BY_NAME.get(canonicalizeNamespace(input))
  if (node === undefined) throw new MidaError("INVALID_NAMESPACE", JSON.stringify(input))
  return node
}

export function namespaceById(id: Hex): NamespaceNode {
  const node = BY_ID.get(id.toLowerCase() as Hex)
  if (node === undefined) throw new MidaError("INVALID_NAMESPACE", `unknown namespace id ${id}`)
  return node
}

/** Depth is at most two, so descendants are exactly the direct children. */
export function expandNamespace(input: string): string[] {
  const root = nodeByName(input)
  return NAMESPACE_TREE_V1.filter((node) => node.name === root.name || node.parent === root.name).map(
    (node) => node.name,
  )
}

export function domainOf(input: string): IsolationDomain {
  return nodeByName(input).domain
}
