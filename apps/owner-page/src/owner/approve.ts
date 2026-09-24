import { el, parsePageLink, assertRpGate, makeEnv, progressLine, showEntriesToSign, showError, finish, scopeInWords } from "./page.js"
import { prepareApprove, confirmApprove, signableProjectRows } from "./flows.js"
import { describeError } from "./session.js"
import { shortAddress } from "./secrets.js"

/**
 * /approve — the agent's signed request comes in the link fragment. Everything that can be
 * checked without a passkey runs in prepareApprove; the button's one touch signs the grant
 * digest (which is also the ceremony's challenge), then the sponsored sends land.
 */
async function main(): Promise<void> {
  let link
  try {
    link = parsePageLink("approve")
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
    return
  }
  try {
    assertRpGate()
  } catch {
    return
  }
  const button = el<HTMLButtonElement>("go")
  button.disabled = true
  try {
    const env = makeEnv()
    const prep = await prepareApprove(env, link)
    const summary = el("summary")
    const lines: string[] = [
      `${prep.agentName} (run by ${shortAddress(prep.operator)}) is asking to:`,
      ...prep.needed.map((s) => `• ${scopeInWords(s.namespaceId, s.permissions)}`),
      `until ${new Date(Number(prep.expiresAt) * 1000).toLocaleDateString()}`,
    ]
    if (link.req.project !== undefined) lines.push(`for the project "${link.req.project.label}"`)
    lines.push(`Advisor: ${prep.advice.risk} risk.`, ...prep.advice.warnings.map((w) => `Warning: ${w}`))
    if (prep.alreadyGranted) lines.push("This agent already holds everything it asked for.")
    lines.push("It will see this context as plain text. Revoking later stops future reads, not what it already saw.")
    summary.textContent = lines.join("\n")
    // Above the button: every project row the signature will cover — the new row named by its
    // label, plus the count (and the expandable list) of existing rows being re-signed.
    const rows = signableProjectRows(link.req)
    if (rows !== null) {
      showEntriesToSign(el("sign-list"), {
        added: rows.added,
        existing: rows.existing,
        ...(link.req.project !== undefined ? { projectLabel: link.req.project.label } : {}),
      })
    }
    // Already granted only ends the page early when there is also no list row to sign — a
    // folder approval on a passkey home still needs the one touch (M3-F2).
    if (prep.alreadyGranted && rows === null) return
    button.disabled = false
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true
        const result = await confirmApprove(env, link, prep)
        finish(link, result)
      })().catch((error: unknown) => {
        showError(describeError(error))
        button.disabled = false
      })
    })
  } catch (error) {
    showError(describeError(error))
  }
}

void main()
