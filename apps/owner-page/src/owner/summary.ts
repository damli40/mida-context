import { PERMISSION, namespaceById } from "@mida/protocol"
import type { Hex, OwnerLinkRequest as LinkRequest, ScopeWarning, ScopeWarningCode } from "@mida/protocol"
import type { PreparedApprove, PreparedRevoke } from "./flows.js"
import { scopeInWords } from "./page.js"
import { shortAddress } from "./secrets.js"

/**
 * The summary above the approve button — the lines the owner reads before the one passkey touch.
 * Lifted out of approve.ts's DOM code so a test can pin the exact wording without a document.
 */

/** The provenance-policy bits a scope carries, in the words the summary shows. */
function provenancePolicyInWords(policy: number): string {
  const parts: string[] = []
  if (policy & 1) parts.push("inferred records")
  if (policy & 2) parts.push("imported records")
  if (policy & 4) parts.push("externally attested records")
  return parts.length > 0 ? `allows ${parts.join(", ")}` : "allows no inferred, imported or attested records"
}

/** The permission bits that let a scope write records — the only ones a provenance policy governs. */
const WRITE_PERMISSIONS = PERMISSION.CREATE | PERMISSION.SUPERSEDE_OWN | PERMISSION.SUPERSEDE_ANY

/** The severity word that opens each advisor line (in-30 T-1). */
const WARNING_PREFIX: Readonly<Record<ScopeWarning["severity"], string>> = {
  info: "Note",
  warning: "Warning",
  critical: "Critical",
}

/** The same words the scope lines use for a namespace — "the X area" — falling back to the raw id. */
function areaInWords(id: Hex): string {
  try {
    return `the ${namespaceById(id).name} area`
  } catch {
    return `the ${id} area`
  }
}

/**
 * One sentence per warning code — the words from the in-30 review, verbatim. A code that talks
 * about an area needs the warning's namespaceId; without one the sentence falls back to naming
 * the code, the same shape an unknown code takes.
 */
const WARNING_AREA_SENTENCES: Partial<Record<ScopeWarningCode, (area: string) => string>> = {
  SCOPE_NOT_DECLARED: (area) => `It asks for ${area} without declaring it for this purpose in its manifest.`,
  SCOPE_UNCLASSIFIED: (area) => `Mida has no rule on whether this kind of agent needs ${area}, so the advisor does not recommend it.`,
  SCOPE_ELEVATED: (area) => `The advisor does not recommend ${area} for this kind of agent: it is more than this agent's purpose normally needs.`,
  SCOPE_SUSPICIOUS: (area) => `Mida does not recommend sharing ${area} with any agent.`,
  HIGH_SENSITIVITY: (area) => `${area} is highly sensitive.`,
  BROAD_PARENT_SCOPE: (area) => `${area} covers several narrower areas at once.`,
  SUPERSEDE_ANY_EXPLICIT: (area) => `It asks to replace records other agents wrote in ${area}.`,
  PERMISSION_NARROWED: (area) => `It asked for more permissions in ${area} than the advisor recommends.`,
  PROVENANCE_POLICY_NARROWED: (area) => `It asked for provenance settings in ${area} that the advisor does not recommend.`,
}

const WARNING_FREE_SENTENCES: Partial<Record<ScopeWarningCode, string>> = {
  DURATION_NARROWED: "It asked for a longer approval than the advisor recommends.",
  PREVIOUSLY_REVOKED: "You revoked this agent before.",
}

function warningInWords(warning: ScopeWarning): string {
  const areaTemplate = WARNING_AREA_SENTENCES[warning.code]
  const sentence =
    areaTemplate !== undefined && warning.namespaceId !== undefined
      ? areaTemplate(areaInWords(warning.namespaceId))
      : (WARNING_FREE_SENTENCES[warning.code] ?? `The advisor flagged this request (${warning.code}).`)
  const capitalized = sentence.charAt(0).toUpperCase() + sentence.slice(1)
  return `${WARNING_PREFIX[warning.severity] ?? "Warning"}: ${capitalized}`
}

/** The lines of #summary, in order — approve.ts renders them verbatim. */
export function approveSummaryLines(prep: PreparedApprove, req: LinkRequest): string[] {
  const lines: string[] = [
    // The operator gets its own FIRST line: a look-alike quote inside a name (a curly ” where
    // a " was expected) could put a forged `(run by …)` left of the real one on a shared line —
    // nothing an agent names itself can precede the operator now (in-32 X-1).
    `Run by ${shortAddress(prep.operator)}`,
    `Agent "${prep.agentName}" is asking to:`,
    ...prep.needed.map((s) => `• ${scopeInWords(s.namespaceId, s.permissions)}`),
    `until ${new Date(Number(prep.expiresAt) * 1000).toLocaleDateString()}`,
  ]
  // The signature binds the scopes' provenance policy bits — the owner sees exactly what the
  // digest authorizes: the needed scopes when a grant mints, the whole request when only the
  // project row is signed. But a policy only governs writes — a read-only ask shows no line at
  // all, and a read scope's forced-zero bit never blends into the wording (in-26 Q-3).
  const digestScopes = prep.alreadyGranted ? prep.accessRequest.scopes : prep.needed
  const writeScopes = digestScopes.filter((s) => (s.permissions & WRITE_PERMISSIONS) !== 0)
  if (writeScopes.length > 0) {
    const policies = [...new Set(writeScopes.map((s) => s.provenancePolicy))]
    lines.push(`Provenance policy: ${policies.length === 1 ? provenancePolicyInWords(policies[0]!) : "varies by scope"}`)
  }
  lines.push(`Advisor: ${prep.advice.risk} risk.`, ...prep.advice.warnings.map(warningInWords))
  // Every page-derived line — including the conditional already-holds one — renders above any
  // text the link chose (in-34): a label or root keeps its quotes legal and can carry a whole
  // forged page line (`x" This agent already holds…"` asserts it when it is false), so no link
  // text may sit above a line the page asserts on its own.
  if (prep.alreadyGranted) lines.push("This agent already holds everything it asked for.")
  // A new project row is signed too — name the agent and the COMPLETE folder root it adds; a
  // shortened root would hide exactly what this approval covers (in-26 Q-3), and the agent is a
  // name, not a hash — it is never shortened either (in-27 R-3). The SIGNED folder line still
  // precedes the unsigned label below it, so the label can only trail the real root, never
  // stand above it as a decoy.
  if (req.entry !== undefined) {
    const entry = req.entry
    lines.push(`Adds folder: ${entry.root} (agent ${entry.agent})`)
  }
  if (req.project !== undefined) lines.push(`for the project "${req.project.label}"`)
  lines.push("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
  return lines
}

/** The permission bits of a live capability, in the words the revoke summary uses. */
function revokePermissionWords(permissions: number): string {
  const bits: string[] = []
  if (permissions & 1) bits.push("read")
  if (permissions & 2) bits.push("add entries")
  if (permissions & 4) bits.push("replace its own entries")
  if (permissions & 8) bits.push("replace any entry")
  return bits.length > 0 ? bits.join(" and ") : `permission bits ${permissions}`
}

/**
 * The lines of #summary on /revoke, in order — rendered through the same one-element-per-line
 * showSummaryLines as approve, so a long line wraps on a phone and a stray newline inside a
 * field can not mint a line (in-30 T-4).
 */
export function revokeSummaryLines(prep: PreparedRevoke): string[] {
  if (prep.live.length === 0) return ["The chain shows nothing live for this agent."]
  return [
    "This agent can currently:",
    ...prep.live.map((c) => `• ${c.namespaceName} — ${revokePermissionWords(c.permissions)}`),
    "Revoking ends all of this and locks the old keys out of anything it saved.",
    "It does not erase what the agent already read.",
  ]
}
