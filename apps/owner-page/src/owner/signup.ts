import { el, parsePageLink, assertRpGate, makeEnv, progressLine, showError, finish } from "./page.js"
import { runSignup } from "./flows.js"
import { describeError } from "./session.js"

/** /signup — create the passkey, register its key, open the three context areas. One touch. */
function main(): void {
  let link
  try {
    link = parsePageLink("signup")
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
  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true
      const name = el<HTMLInputElement>("owner-name").value.trim() || "Mida owner"
      const result = await runSignup(makeEnv(), link, name)
      if (result.status === "success") {
        const owner = result.owner ?? ""
        progressLine(`This passkey IS your account (${owner}) — lose it and you lose this owner.`)
        progressLine("It syncs through iCloud, Google or 1Password; that sync is your backup.")
      } else if (result.status === "failed" && result.reason !== undefined) {
        showError(result.reason)
        button.disabled = false
      }
      finish(link, result)
    })().catch((error: unknown) => showError(describeError(error)))
  })
}

main()
