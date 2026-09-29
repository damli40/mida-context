import { PERMISSION } from "@mida/protocol"
import type { OwnerLinkRequest as LinkRequest } from "@mida/protocol"
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

/** The lines of #summary, in order — approve.ts renders them verbatim. */
export function approveSummaryLines(prep: PreparedApprove, req: LinkRequest): string[] {
  const lines: string[] = [
    `${prep.agentName} (run by ${shortAddress(prep.operator)}) is asking to:`,
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
  // name, not a hash — it is never shortened either (in-27 R-3).
  if (req.entry !== undefined) {
    const entry = req.entry
    lines.push(`Adds folder: ${entry.root} — agent ${entry.agent}`)
  }
  lines.push(`Advisor: ${prep.advice.risk} risk.`, ...prep.advice.warnings.map((w) => `Warning: ${w}`))
  if (prep.alreadyGranted) lines.push("This agent already holds everything it asked for.")
  lines.push("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
  return lines
}
