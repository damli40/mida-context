import { PERMISSION, namespaceById } from "@mida/protocol"
import type { Hex, OwnerLinkRequest as LinkRequest, ScopeWarning, ScopeWarningCode } from "@mida/protocol"
import type { PreparedApprove } from "./flows.js"
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
  SCOPE_NOT_DECLARED: (area) => `It asks for ${area}, which its own manifest does not list.`,
  SCOPE_UNCLASSIFIED: (area) => `Mida has no sensitivity rating for ${area}.`,
  SCOPE_ELEVATED: (area) => `${area} holds more sensitive context than this kind of agent usually needs.`,
  SCOPE_SUSPICIOUS: (area) => `${area} is unusual for what this agent says it does.`,
  HIGH_SENSITIVITY: (area) => `${area} is highly sensitive.`,
  BROAD_PARENT_SCOPE: (area) => `${area} covers several narrower areas at once.`,
  SUPERSEDE_ANY_EXPLICIT: (area) => `It asks to replace records other agents wrote in ${area}.`,
  PERMISSION_NARROWED: (area) => `It asked for more permissions in ${area} than the advisor recommends.`,
  PROVENANCE_POLICY_NARROWED: (area) => `It asked for a looser write policy in ${area} than the advisor recommends.`,
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
    `Agent "${prep.agentName}" (run by ${shortAddress(prep.operator)}) is asking to:`,
    ...prep.needed.map((s) => `• ${scopeInWords(s.namespaceId, s.permissions)}`),
    `until ${new Date(Number(prep.expiresAt) * 1000).toLocaleDateString()}`,
  ]
  if (req.project !== undefined) lines.push(`for the project "${req.project.label}"`)
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
  // A new project row is signed too — name the agent and the COMPLETE folder root it adds; a
  // shortened root would hide exactly what this approval covers (in-26 Q-3), and the agent is a
  // name, not a hash — it is never shortened either (in-27 R-3). The name sits in quotes so it
  // cannot imitate a line of the page (in-30 T-2).
  if (req.entry !== undefined) {
    const entry = req.entry
    lines.push(`Adds folder: ${entry.root} — agent "${entry.agent}"`)
  }
  lines.push(`Advisor: ${prep.advice.risk} risk.`, ...prep.advice.warnings.map(warningInWords))
  if (prep.alreadyGranted) lines.push("This agent already holds everything it asked for.")
  lines.push("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
  return lines
}
