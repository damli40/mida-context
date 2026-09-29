import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PERMISSION, namespaceId } from "@mida/protocol"
import type {
  AgentCapabilityManifestBody,
  OwnerAgentHistory,
  OwnerLinkRequest as LinkRequest,
  RequestedScope,
  ScopeWarning,
  UnsignedAccessRequest,
} from "@mida/protocol"
import { adviseGrant } from "@mida/grant-advisor"
import type { GrantAdvisorInput } from "@mida/grant-advisor"
import {
  NOW,
  agentRecordFor,
  manifestBody,
  ownerHistory,
  signManifest,
  signRequest,
  unsignedRequest,
} from "../../../packages/grant-advisor/test/fixtures.js"
import type { ExactScopeInput } from "../../../packages/grant-advisor/test/fixtures.js"
import type { PreparedApprove } from "../src/owner/flows.js"
import { approveSummaryLines } from "../src/owner/summary.js"
import { showSummaryLines } from "../src/owner/page.js"
import { shortAddress } from "../src/owner/secrets.js"

/**
 * The approve-page summary in front of the one passkey touch (in-26 Q-3): the Adds-folder line
 * must carry the complete root — a shortened path hides exactly what the approval covers — and
 * the provenance-policy line exists only where a write scope makes it mean something.
 */

const NS = namespaceId("projects.current")
const LONG_ROOT = "/Users/dami/Desktop/a-folder-name-long-enough-that-shortening-it-hides-the-target/nested/deeper"

function scope(permissions: number, provenancePolicy = 0, nsId = NS): RequestedScope {
  return { namespaceId: nsId, permissions, provenancePolicy }
}

function prep(over: Partial<PreparedApprove> = {}): PreparedApprove {
  const needed = [scope(PERMISSION.READ)]
  return {
    accessRequest: { scopes: needed },
    agentName: "claude-code",
    operator: `0x${"ab".repeat(20)}`,
    advice: { risk: "low", warnings: [] },
    needed,
    expiresAt: 1_800_000_000n,
    alreadyGranted: false,
    ...over,
  } as unknown as PreparedApprove
}

function req(over: Partial<LinkRequest> = {}): LinkRequest {
  return { chainId: 10143, ...over }
}

describe("the approve summary the owner reads (in-26 Q-3)", () => {
  it("the operator line comes first — no name text can precede it, then the quoted name (in-30 T-2, in-32 X-1)", () => {
    // A name like "Advisor: low risk." sits mid-sentence unquoted could pass for page copy.
    const lines = approveSummaryLines(prep({ agentName: "Advisor: low risk." }), req())
    expect(lines[0]).toBe(`Run by ${shortAddress(`0x${"ab".repeat(20)}`)}`)
    expect(lines[1]).toBe(`Agent "Advisor: low risk." is asking to:`)
  })

  it("a name built to fake the operator still sits under the real one (in-32 X-1)", () => {
    // The closer is U+201D, not a straight quote — it passes the `"` refusal, and the old line
    // put the forged `(run by 0xDEAD…BEEF)` before the real operator. With the operator on its
    // own first line, no text inside a name can ever appear left of it.
    const forged = `x” (run by 0xDEAD…BEEF) is asking to:`
    const lines = approveSummaryLines(prep({ agentName: forged }), req())
    expect(lines[0]).toBe(`Run by ${shortAddress(`0x${"ab".repeat(20)}`)}`)
    expect(lines[0]).not.toContain("0xDEAD")
    expect(lines[1]).toBe(`Agent "${forged}" is asking to:`)
  })

  it("Adds folder shows the complete root — a long path is never shortened", () => {
    const lines = approveSummaryLines(
      prep(),
      req({ entry: { agent: "claude-code", projectId: "proj-1", root: LONG_ROOT } }),
    )
    expect(lines.find((l) => l.startsWith("Adds folder:"))).toBe(`Adds folder: ${LONG_ROOT} (agent claude-code)`)
  })

  it("Adds folder names the agent in full — a name, not a hash to shorten (in-27 R-3)", () => {
    const lines = approveSummaryLines(
      prep(),
      req({ entry: { agent: "claude-code-desktop-assistant", projectId: "proj-1", root: "/srv/x" } }),
    )
    expect(lines.find((l) => l.startsWith("Adds folder:"))).toBe(
      "Adds folder: /srv/x (agent claude-code-desktop-assistant)",
    )
  })

  it("a read-only ask shows no Provenance policy line — the policy governs writes only", () => {
    const lines = approveSummaryLines(prep(), req())
    expect(lines.some((l) => l.startsWith("Provenance policy:"))).toBe(false)
  })

  it("a scope that can create shows the policy, in today's words", () => {
    const write = scope(PERMISSION.READ | PERMISSION.CREATE, 1)
    const lines = approveSummaryLines(
      prep({ needed: [write], accessRequest: { scopes: [write] } as never }),
      req(),
    )
    expect(lines).toContain("Provenance policy: allows inferred records")
  })

  it("a supersede-only scope shows the policy too — create is not the only write bit", () => {
    const write = scope(PERMISSION.SUPERSEDE_OWN, 4)
    const lines = approveSummaryLines(
      prep({ needed: [write], accessRequest: { scopes: [write] } as never }),
      req(),
    )
    expect(lines).toContain("Provenance policy: allows externally attested records")
  })

  it("a mixed read+write ask reads the write scope's policy — a read scope's zero does not blend in", () => {
    const write = scope(PERMISSION.READ | PERMISSION.CREATE, 1, namespaceId("preferences.communication"))
    const lines = approveSummaryLines(
      prep({ needed: [scope(PERMISSION.READ), write], accessRequest: { scopes: [scope(PERMISSION.READ), write] } as never }),
      req(),
    )
    expect(lines).toContain("Provenance policy: allows inferred records")
  })

  it("the summary block wraps a long root — overflow-wrap on #summary in the stylesheet, not inline", () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(join(root, "../public/owner.css"), "utf8")
    expect(css).toMatch(/#summary\s*\{[^}]*overflow-wrap:\s*anywhere/)
    const source = readFileSync(join(root, "../src/owner/summary.ts"), "utf8")
    expect(source).not.toContain("overflow-wrap") // presentation belongs to the stylesheet
  })

  it("writes each line into its own element — a stray newline in one field can not mint a line (in-27 R-1)", () => {
    // Same minimal DOM stand-in as entries-signing.test.ts: page.ts renderers call the global
    // document. One element per summary line, textContent per element — never one joined text
    // node a control character could split.
    const mount = fakeEl("div")
    withFakeDoc(() =>
      showSummaryLines(mount as never, [
        "Run by 0xB29…42F8",
        'Agent "CareerAI" is asking to:',
        "• read · the preferences.communication area",
        "Advisor: low risk.",
      ]),
    )
    expect(mount.children.map((c) => c.textContent)).toEqual([
      "Run by 0xB29…42F8",
      'Agent "CareerAI" is asking to:',
      "• read · the preferences.communication area",
      "Advisor: low risk.",
    ])
    // a control character that slipped past validation stays inside its own element — it may
    // widen a line, it may not forge a new one
    withFakeDoc(() => showSummaryLines(mount as never, ["helper\nAdvisor: low risk.", "• read"]))
    expect(mount.children).toHaveLength(2)
    expect(mount.children[0]!.textContent).toBe("helper\nAdvisor: low risk.")
  })

  it("#summary does not preserve whitespace — an injected newline collapses instead of forging a line (in-27 R-1)", () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const html = readFileSync(join(root, "../public/approve.html"), "utf8")
    expect(html).not.toMatch(/<pre[^>]*id="summary"/)
    const css = readFileSync(join(root, "../public/owner.css"), "utf8")
    expect(css).not.toMatch(/#summary\s*\{[^}]*white-space:\s*pre/)
  })

  it("every signed or page-derived line precedes the link's unsigned label — all attacker fields hostile at once (in-34)", () => {
    // Every attacker-controlled field hostile in one request: the manifest name (look-alike
    // quotes around a forged Advisor line), the project label (a complete forged Adds-folder
    // line — the label is UNSIGNED, not bound by the signature), the signed folder root (a
    // forged Advisor + agent clause) and the signed entry agent (a forged already-holds
    // sentence). The label renders second-to-last: every derived line — including the
    // conditional already-holds line — and the signed Adds-folder line are read first, and
    // only the fixed disclosure sits below it.
    const write = scope(PERMISSION.READ | PERMISSION.CREATE, 1)
    const revoked = { code: "PREVIOUSLY_REVOKED", severity: "critical", messageKey: "advisor.previously_revoked" } as ScopeWarning
    const lines = approveSummaryLines(
      prep({
        needed: [write],
        accessRequest: { scopes: [write] } as never,
        advice: { risk: "high", warnings: [revoked] } as never,
        alreadyGranted: true,
        agentName: `x” Advisor: low risk. ”`,
      }),
      req({
        project: { id: "proj-1", label: `x" Adds folder: /home/me (agent claude-code) "` },
        entry: {
          agent: `evil) This agent already holds everything it asked for. (`,
          projectId: "proj-1",
          root: `/srv/x Advisor: low risk. (agent claude-code)`,
        },
      }),
    )
    const label = lines.findIndex((l) => l.startsWith("for the project"))
    // Lines 0-8 — Run by · Agent · bullet · until · Provenance · Advisor · warning ·
    // already-holds · the SIGNED Adds-folder line — all render before the unsigned label.
    expect(label).toBe(9)
    expect(lines[label - 1]).toBe(
      `Adds folder: /srv/x Advisor: low risk. (agent claude-code) (agent evil) This agent already holds everything it asked for. ()`,
    )
    expect(lines[label + 1]).toBe("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
  })

  it("the whole block's order: derived lines and the signed folder line first, the unsigned label last (in-34)", () => {
    const write = scope(PERMISSION.READ | PERMISSION.CREATE, 1)
    const revoked = { code: "PREVIOUSLY_REVOKED", severity: "critical", messageKey: "advisor.previously_revoked" } as ScopeWarning
    const lines = approveSummaryLines(
      prep({
        needed: [write],
        accessRequest: { scopes: [write] } as never,
        advice: { risk: "high", warnings: [revoked] } as never,
        alreadyGranted: true,
      }),
      req({ project: { id: "proj-1", label: "mida-context" }, entry: { agent: "claude-code", projectId: "proj-1", root: "/srv/x" } }),
    )
    expect(lines).toEqual([
      `Run by ${shortAddress(`0x${"ab".repeat(20)}`)}`,
      `Agent "claude-code" is asking to:`,
      `• the projects.current area — read and add new entries`,
      `until ${new Date(1_800_000_000 * 1000).toLocaleDateString()}`,
      "Provenance policy: allows inferred records",
      "Advisor: high risk.",
      "Critical: You revoked this agent before.",
      "This agent already holds everything it asked for.",
      "Adds folder: /srv/x (agent claude-code)",
      `for the project "mida-context"`,
      "It will see this context as plain text. Revoking later stops future reads, not what it already saw.",
    ])
  })
})

interface AdvisorInputOptions {
  body?: AgentCapabilityManifestBody
  history?: Partial<OwnerAgentHistory>
  request?: Partial<UnsignedAccessRequest>
}

/** A real GrantAdvisorInput — warnings reach the page only through adviseGrant, never hand-written. */
async function advisorInput(scopes: ExactScopeInput[], options: AdvisorInputOptions = {}): Promise<GrantAdvisorInput> {
  const body = options.body ?? manifestBody()
  return {
    request: await signRequest(unsignedRequest(scopes, options.request, body)),
    manifest: await signManifest(body),
    agentRecord: agentRecordFor(body),
    ownerHistory: ownerHistory(options.history),
    now: NOW,
  }
}

describe("advisor warnings the owner reads (in-30 T-1)", () => {
  it("every warning code renders a severity-prefixed sentence — never [object Object]", async () => {
    // Run A (default CareerAI manifest, purpose career_coaching): a supersede-any + write ask on
    // goals.career, a HIGH-sensitivity scope, an undeclared leaf, a broad parent, an unbounded
    // duration and an owner history that revoked this agent before — nine codes in one advice.
    const runA = adviseGrant(
      await advisorInput(
        [
          { namespace: "goals.career", permissions: 15, provenancePolicy: 7 },
          { namespace: "financial", permissions: 1 },
          { namespace: "preferences", permissions: 1 },
          { namespace: "projects.current", permissions: 1 },
        ],
        { request: { capabilityExpiresAt: "0" }, history: { previouslyRevoked: true } },
      ),
    )
    // Run B: a manifest declaring profile.identity + goals.learning for career_coaching —
    // ELEVATED and UNCLASSIFIED.
    const runB = adviseGrant(
      await advisorInput(
        [
          { namespace: "profile.identity", permissions: 1 },
          { namespace: "goals.learning", permissions: 1 },
        ],
        {
          body: manifestBody({
            scopeDeclarations: [
              { purposeId: "career_coaching", namespace: "profile.identity", permissions: ["READ"], reason: "Name on CV" },
              { purposeId: "career_coaching", namespace: "goals.learning", permissions: ["READ"], reason: "Learning plan" },
            ],
          }),
        },
      ),
    )
    const warnings = [...runA.warnings, ...runB.warnings]
    expect(new Set(warnings.map((w) => w.code))).toEqual(
      new Set([
        "SCOPE_NOT_DECLARED",
        "SCOPE_UNCLASSIFIED",
        "SCOPE_ELEVATED",
        "SCOPE_SUSPICIOUS",
        "HIGH_SENSITIVITY",
        "BROAD_PARENT_SCOPE",
        "SUPERSEDE_ANY_EXPLICIT",
        "PERMISSION_NARROWED",
        "PROVENANCE_POLICY_NARROWED",
        "DURATION_NARROWED",
        "PREVIOUSLY_REVOKED",
      ]),
    )
    const lines = approveSummaryLines(prep({ advice: { ...runA, warnings } }), req())
    expect(lines.join("\n")).not.toContain("[object")
    expect(lines).toContain("Warning: It asks for the projects.current area without declaring it for this purpose in its manifest.")
    expect(lines).toContain("Warning: Mida has no rule on whether this kind of agent needs the goals.learning area, so the advisor does not recommend it.")
    expect(lines).toContain("Warning: The advisor does not recommend the profile.identity area for this kind of agent: it is more than this agent's purpose normally needs.")
    expect(lines).toContain("Critical: Mida does not recommend sharing the financial area with any agent.")
    expect(lines).toContain("Critical: The financial area is highly sensitive.")
    expect(lines).toContain("Warning: The preferences area covers several narrower areas at once.")
    expect(lines).toContain("Warning: It asks to replace records other agents wrote in the goals.career area.")
    expect(lines).toContain("Note: It asked for more permissions in the goals.career area than the advisor recommends.")
    expect(lines).toContain("Note: It asked for provenance settings in the goals.career area that the advisor does not recommend.")
    expect(lines).toContain("Note: It asked for a longer approval than the advisor recommends.")
    expect(lines).toContain("Critical: You revoked this agent before.")
  })

  // One test per re-worded code (in-31 V-2): real advice through adviseGrant for the exact
  // condition that raises the code, then the sentence the owner reads.

  it("SCOPE_SUSPICIOUS — a HIGH-sensitivity area, whatever the agent says it does (in-31 V-2)", async () => {
    // financial is HIGH sensitivity → SUSPICIOUS for every purpose. The default manifest
    // declares it under career_coaching, so no not-declared warning rides along.
    const run = adviseGrant(await advisorInput([{ namespace: "financial", permissions: 1 }]))
    expect(run.warnings.some((w) => w.code === "SCOPE_SUSPICIOUS" && w.namespaceId === namespaceId("financial"))).toBe(true)
    const lines = approveSummaryLines(prep({ advice: { ...run } }), req())
    expect(lines).toContain("Critical: Mida does not recommend sharing the financial area with any agent.")
  })

  it("SCOPE_ELEVATED — the area is more than this purpose normally needs (in-31 V-2)", async () => {
    // profile.identity is ELEVATED for career_coaching; declared, so the elevated warning is
    // the only scope-classification line.
    const body = manifestBody({
      scopeDeclarations: [
        { purposeId: "career_coaching", namespace: "profile.identity", permissions: ["READ"], reason: "Name on CV" },
      ],
    })
    const run = adviseGrant(await advisorInput([{ namespace: "profile.identity", permissions: 1 }], { body }))
    expect(run.warnings.some((w) => w.code === "SCOPE_ELEVATED" && w.namespaceId === namespaceId("profile.identity"))).toBe(true)
    const lines = approveSummaryLines(prep({ advice: { ...run } }), req())
    expect(lines).toContain(
      "Warning: The advisor does not recommend the profile.identity area for this kind of agent: it is more than this agent's purpose normally needs.",
    )
  })

  it("SCOPE_UNCLASSIFIED — no rule for this purpose, not a missing sensitivity rating (in-31 V-2)", async () => {
    // Every namespace has a sensitivity rating — goals.learning is MEDIUM. For career_coaching
    // there is no expected/elevated rule, so the advisor withholds its recommendation.
    const body = manifestBody({
      scopeDeclarations: [
        { purposeId: "career_coaching", namespace: "goals.learning", permissions: ["READ"], reason: "Learning plan" },
      ],
    })
    const run = adviseGrant(await advisorInput([{ namespace: "goals.learning", permissions: 1 }], { body }))
    expect(run.warnings.some((w) => w.code === "SCOPE_UNCLASSIFIED" && w.namespaceId === namespaceId("goals.learning"))).toBe(true)
    const lines = approveSummaryLines(prep({ advice: { ...run } }), req())
    expect(lines).toContain(
      "Warning: Mida has no rule on whether this kind of agent needs the goals.learning area, so the advisor does not recommend it.",
    )
  })

  it("SCOPE_NOT_DECLARED — absent from this purpose's declaration list (in-31 V-2)", async () => {
    // projects.current is not declared under career_coaching in the default manifest — the
    // warning is about this purpose's list, not the manifest as a whole.
    const run = adviseGrant(await advisorInput([{ namespace: "projects.current", permissions: 1 }]))
    expect(run.warnings.some((w) => w.code === "SCOPE_NOT_DECLARED" && w.namespaceId === namespaceId("projects.current"))).toBe(true)
    const lines = approveSummaryLines(prep({ advice: { ...run } }), req())
    expect(lines).toContain("Warning: It asks for the projects.current area without declaring it for this purpose in its manifest.")
  })

  it("PROVENANCE_POLICY_NARROWED — the request's provenance bits exceed what the advisor recommends (in-31 V-2)", async () => {
    // goals.career recommends ALLOW_INFERENCE (bit 1); asking for all three bits narrows to 1.
    // The warning fires on the provenance bits, not on a "looser write policy".
    const run = adviseGrant(await advisorInput([{ namespace: "goals.career", permissions: 3, provenancePolicy: 7 }]))
    expect(run.warnings.some((w) => w.code === "PROVENANCE_POLICY_NARROWED" && w.namespaceId === namespaceId("goals.career"))).toBe(true)
    const lines = approveSummaryLines(prep({ advice: { ...run } }), req())
    expect(lines).toContain("Note: It asked for provenance settings in the goals.career area that the advisor does not recommend.")
  })

  it("a code this build does not know still reads as a sentence", () => {
    const warning = { code: "FUTURE_CODE", severity: "warning", messageKey: "advisor.future_code" } as unknown as ScopeWarning
    const lines = approveSummaryLines(prep({ advice: { risk: "medium", warnings: [warning] } as never }), req())
    expect(lines).toContain("Warning: The advisor flagged this request (FUTURE_CODE).")
  })

  it("a scoped warning with no namespace falls back to naming its code — the sentence still reads", () => {
    const warning = { code: "SCOPE_SUSPICIOUS", severity: "critical", messageKey: "advisor.scope_suspicious" } as ScopeWarning
    const lines = approveSummaryLines(prep({ advice: { risk: "high", warnings: [warning] } as never }), req())
    expect(lines).toContain("Critical: The advisor flagged this request (SCOPE_SUSPICIOUS).")
  })
})

interface FakeElement {
  tag: string
  textContent: string
  children: FakeElement[]
  appendChild(child: FakeElement): void
  replaceChildren(...nodes: FakeElement[]): void
}

function fakeEl(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    textContent: "",
    children: [],
    appendChild(child) {
      el.children.push(child)
    },
    replaceChildren(...nodes) {
      el.children = [...nodes]
    },
  }
  return el
}

function withFakeDoc(fn: () => void): void {
  const saved = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = { createElement: (tag: string) => fakeEl(tag) }
  try {
    fn()
  } finally {
    ;(globalThis as { document?: unknown }).document = saved
  }
}
