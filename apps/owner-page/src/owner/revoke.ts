import { el, parsePageLink, assertRpGate, makeEnv, showListReSigned, showError, finish } from "./page.js"
import { prepareRevoke, confirmRevoke } from "./flows.js"
import { describeError } from "./session.js"

/**
 * /revoke — the link names the agent; the page shows what the agent can read today (from the
 * chain, never from the link). One touch revokes the agent and rotates the areas it could see,
 * then publishes fresh key wraps to the surviving agents the terminal listed.
 */
async function main(): Promise<void> {
  let link
  try {
    link = parsePageLink("revoke")
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
    const prep = await prepareRevoke(env, link)
    const summary = el("summary")
    const lines =
      prep.live.length === 0
        ? ["The chain shows nothing live for this agent."]
        : [
            "This agent can currently:",
            ...prep.live.map((c) => `• ${c.namespaceName} — ${permissionWords(c.permissions)}`),
            "Revoking ends all of this and locks the old keys out of anything it saved.",
          ]
    summary.textContent = lines.join("\n")
    // The approved-projects rows the signature re-covers (the terminal already filtered the
    // revoked agent out) — shown before the passkey is asked, same rule as approve.
    const keptRows = link.req.entries as { agent: string; projectId: string; root: string; approvedAt: string }[] | undefined
    if (keptRows !== undefined) showListReSigned(el("sign-list"), keptRows)
    // Nothing live ends the page early only when there is also no list to re-sign (M3-F2).
    if (prep.live.length === 0 && keptRows === undefined) return
    button.disabled = false
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true
        const result = await confirmRevoke(env, link, prep)
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

function permissionWords(permissions: number): string {
  const bits: string[] = []
  if (permissions & 1) bits.push("read")
  if (permissions & 2) bits.push("add entries")
  if (permissions & 4) bits.push("replace its own entries")
  if (permissions & 8) bits.push("replace any entry")
  return bits.length > 0 ? bits.join(" and ") : `permission bits ${permissions}`
}

void main()
