import { el, parsePageLink, assertRpGate, makeEnv, progressLine, showEntriesToSign, showError, showSummaryLines, finish } from "./page.js"
import { prepareApprove, confirmApprove, signableProjectRows } from "./flows.js"
import { approveSummaryLines } from "./summary.js"
import { describeError } from "./session.js"

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
    showSummaryLines(el("summary"), approveSummaryLines(prep, link.req))
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
