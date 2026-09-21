import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError } from "@category-labs/mera"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "./bytes.js"
import { COSE_ES256, COSE_RS256, RP_ID, RP_NAME, TEST_CHALLENGE } from "./constants.js"
import { makeCheckClient } from "./client.js"
import type { CheckClientDeps, InvocationCounts } from "./client.js"
import { parseP256Spki } from "./spki.js"
import type { P256PublicKey } from "./spki.js"
import { parseDerSignature } from "./der.js"
import { parseAuthenticatorData } from "./authdata.js"
import { assertionDigest, buildPrecompileInput, verifyAssertionInBrowser } from "./assertion.js"
import { callP256Precompile } from "./rpc.js"
import { assertNoSecretMaterial, buildReport } from "./report.js"
import type { CheckStatus } from "./report.js"
import { clearSaved, loadSaved, saveCredential } from "./storage.js"
import type { SavedTestCredential } from "./storage.js"

const PRF_FIX = "Save the passkey to Google Password Manager, iCloud Keychain or 1Password, not to this Chrome profile."

const counts: InvocationCounts = { create: 0, get: 0 }
const capture: CheckClientDeps["capture"] = { create: null, get: null }
let saved: SavedTestCredential | null = loadSaved(window.localStorage)
let firstFingerprint: string | null = null
let platformAuthenticatorAvailable: boolean | null = null

function line(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-line="${id}"]`)
}

function setLine(id: string, status: CheckStatus, text: string): void {
  const el = line(id)
  if (!el) return
  el.classList.remove("pass", "fail", "unknown")
  el.classList.add(status)
  const detail = el.querySelector(".detail")
  if (detail) detail.textContent = text
}

function note(text: string): void {
  const el = document.getElementById("note")
  if (el) el.textContent = text
}

function setBusy(busy: boolean): void {
  for (const id of ["btn-create", "btn-use"]) {
    const btn = document.getElementById(id) as HTMLButtonElement | null
    if (btn) btn.disabled = busy
  }
}

function fingerprintOf(secret: Uint8Array): string {
  return bytesToHex(sha256(secret).slice(0, 4))
}

function updatePromptCountLine(perClick: number): void {
  if (perClick === 1) {
    setLine("prompt-count", "pass", "One click caused exactly one passkey prompt.")
  } else {
    setLine(
      "prompt-count",
      "fail",
      `One click caused ${perClick} passkey prompts — on this device a single approval would interrupt the owner ${perClick} times.`,
    )
  }
}

function updateDeterminismLine(fingerprint: string): void {
  if (firstFingerprint === null) {
    firstFingerprint = fingerprint
    setLine(
      "determinism",
      "unknown",
      `First reading recorded — fingerprint ${fingerprint} (fingerprint of the secret, not the secret). Click "Use my test passkey" again to confirm it is the same.`,
    )
  } else if (firstFingerprint === fingerprint) {
    setLine("determinism", "pass", `Two separate ceremonies returned the same secret (fingerprint ${fingerprint}).`)
  } else {
    setLine(
      "determinism",
      "fail",
      `Two ceremonies returned different secrets (${firstFingerprint} then ${fingerprint}) — this passkey does not derive deterministically.`,
    )
  }
}

function updateAlgorithmAndKeyLines(): void {
  const created = capture.create
  if (!created) return
  if (created.algorithm === COSE_ES256) {
    setLine("algorithm", "pass", "ES256 (−7) — the P-256 curve our contract verifies.")
  } else if (created.algorithm === COSE_RS256) {
    setLine(
      "algorithm",
      "fail",
      "This passkey is RSA (−257). Our contract verifies only P-256 ECDSA signatures, so it could never verify this passkey.",
    )
  } else {
    setLine("algorithm", "unknown", `The browser reported algorithm ${created.algorithm ?? "nothing"}.`)
  }

  if (created.spki) {
    const point = parseP256Spki(created.spki)
    if (point) {
      setLine("public-key", "pass", `Captured the public key — x ${bytesToHex(point.x)}, y ${bytesToHex(point.y)}.`)
    } else {
      setLine("public-key", "fail", "A public key was returned but it is not a P-256 point we can use.")
    }
  } else {
    setLine("public-key", "unknown", "The browser did not expose the credential's public key.")
  }
}

function currentPublicKey(): P256PublicKey | null {
  if (saved?.x && saved.y) {
    return { x: hexToBytes(saved.x), y: hexToBytes(saved.y) }
  }
  const spki = capture.create?.spki
  return spki ? parseP256Spki(spki) : null
}

function describeFailure(error: unknown): string {
  if (isMeraError(error) && error.code === "PRF_UNAVAILABLE") {
    return `This passkey did not return its secret bytes (PRF). ${PRF_FIX}`
  }
  return "The passkey ceremony failed or was dismissed before it finished."
}

async function onCreate(): Promise<void> {
  setBusy(true)
  note("Waiting for the passkey prompt — create a test passkey when the browser asks.")
  const client = makeCheckClient({ credentials: navigator.credentials, challenge: TEST_CHALLENGE, counts, capture })
  const before = counts.create + counts.get
  try {
    const result = await createPasskeyWithPrfOutput({
      rp: { id: RP_ID, name: RP_NAME },
      user: { name: "mida-device-check", displayName: "Mida device check" },
      webAuthnClient: client,
    })
    setLine("prf", "pass", "The passkey returned its secret bytes (PRF).")
    updateDeterminismLine(fingerprintOf(result.prfOutput))

    const point = capture.create?.spki ? parseP256Spki(capture.create.spki) : null
    saved = {
      credentialId: result.credentialId,
      ...(capture.create?.transports ? { transports: capture.create.transports } : {}),
      ...(capture.create?.algorithm !== null && capture.create?.algorithm !== undefined
        ? { algorithm: capture.create.algorithm }
        : {}),
      ...(point ? { x: bytesToHex(point.x), y: bytesToHex(point.y) } : {}),
    }
    saveCredential(window.localStorage, saved)
    note(`Created and remembered a test passkey (${result.credentialId.slice(0, 12)}…). Now click "Use my test passkey".`)
  } catch (error) {
    setLine("prf", "fail", describeFailure(error))
    note("The create ceremony did not finish.")
  } finally {
    updateAlgorithmAndKeyLines()
    updatePromptCountLine(counts.create + counts.get - before)
    refreshAttachment()
    setBusy(false)
  }
}

async function onUse(): Promise<void> {
  setBusy(true)
  note("Waiting for the passkey prompt — touch the same test passkey.")
  const client = makeCheckClient({ credentials: navigator.credentials, challenge: TEST_CHALLENGE, counts, capture })
  const before = counts.create + counts.get
  try {
    const result = await getPasskeyPrfOutput({
      rpId: RP_ID,
      ...(saved ? { credential: { credentialId: saved.credentialId, ...(saved.transports ? { transports: saved.transports } : {}) } } : {}),
      webAuthnClient: client,
    })
    setLine("prf", "pass", "The passkey returned its secret bytes (PRF).")
    updateDeterminismLine(fingerprintOf(result.prfOutput))
    await verifyCapturedAssertion()
    note("Done — copy the report to share what this device answered.")
  } catch (error) {
    setLine("prf", "fail", describeFailure(error))
    note("The use ceremony did not finish.")
  } finally {
    updatePromptCountLine(counts.create + counts.get - before)
    refreshAttachment()
    setBusy(false)
  }
}

async function verifyCapturedAssertion(): Promise<void> {
  const got = capture.get
  const publicKey = currentPublicKey()
  if (!got?.authenticatorData || !got.clientDataJSON || !got.signatureDer) {
    setLine("browser-verify", "unknown", "The browser did not expose the assertion bytes to verify.")
    setLine("chain-verify", "unknown", "No assertion bytes to send to the precompile.")
    return
  }
  if (!publicKey) {
    setLine("browser-verify", "unknown", 'No public key captured yet — click "Create a test passkey" first.')
    setLine("chain-verify", "unknown", 'No public key captured yet — click "Create a test passkey" first.')
    return
  }

  const authInfo = parseAuthenticatorData(got.authenticatorData)
  if (!authInfo) {
    setLine("browser-verify", "fail", "The authenticator data is too short to parse.")
    setLine("chain-verify", "unknown", "Cannot build the precompile input without authenticator data.")
    return
  }

  let signature
  try {
    signature = parseDerSignature(got.signatureDer)
  } catch {
    setLine("browser-verify", "fail", "The signature is not a DER ECDSA signature we can parse.")
    setLine("chain-verify", "unknown", "No usable signature to send to the precompile.")
    return
  }

  const verdict = verifyAssertionInBrowser({
    authenticatorData: got.authenticatorData,
    authInfo,
    clientDataJSON: got.clientDataJSON,
    signature,
    publicKey,
  })
  if (verdict.ok) {
    setLine(
      "browser-verify",
      "pass",
      "In this browser: the signature verifies against the captured public key, the rpId hash matches midacontext.xyz, the user-verified flag is set, and the challenge is our fixed test value.",
    )
  } else {
    const failed = [
      !verdict.signatureOk && "the signature itself did not verify",
      !verdict.rpIdHashOk && "the rpId hash did not match midacontext.xyz",
      !verdict.userVerifiedOk && "the user-verified flag is missing",
      !verdict.challengeOk && "the assertion is not over our test challenge",
    ].filter(Boolean)
    setLine("browser-verify", "fail", `In-browser verification failed: ${failed.join("; ")}.`)
  }

  const input160 = buildPrecompileInput(assertionDigest(got.authenticatorData, got.clientDataJSON), signature, publicKey)
  setLine("chain-verify", "unknown", "Asking the P256 precompile on Monad testnet (read-only eth_call)…")
  const result = await callP256Precompile(input160)
  setLine("chain-verify", result.outcome === "verified" ? "pass" : "fail", result.detail)
}

function refreshAttachment(): void {
  const attachment = capture.get?.attachment ?? capture.create?.attachment ?? null
  if (attachment) environment().authenticatorAttachment = attachment
  renderEnvironmentLine()
}

function environment() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    secureContext: window.isSecureContext,
    webauthnAvailable: typeof navigator.credentials?.create === "function" && typeof window.PublicKeyCredential === "function",
    platformAuthenticatorAvailable,
    authenticatorAttachment: capture.get?.attachment ?? capture.create?.attachment ?? null,
  }
}

function renderEnvironmentLine(): void {
  const env = environment()
  const parts = [
    `browser says "${env.userAgent}"`,
    `platform "${env.platform || "unknown"}"`,
    env.platformAuthenticatorAvailable === null
      ? "platform passkey support not reported"
      : env.platformAuthenticatorAvailable
        ? "a platform authenticator is available"
        : "no platform authenticator reported",
    env.authenticatorAttachment ? `the passkey that answered is ${env.authenticatorAttachment === "platform" ? "on this device" : `attachment "${env.authenticatorAttachment}"`}` : "no passkey has answered yet",
  ]
  setLine("environment", "pass", `${parts.join("; ")}.`)
}

async function onCopyReport(): Promise<void> {
  const env = environment()
  const report = buildReport({
    rpId: RP_ID,
    challengeHex: bytesToHex(TEST_CHALLENGE),
    environment: env,
    credential: saved
      ? {
          credentialId: saved.credentialId,
          transports: saved.transports ?? null,
          algorithm: saved.algorithm ?? null,
          publicKey: saved.x && saved.y ? { x: saved.x, y: saved.y } : null,
        }
      : null,
    calls: counts,
    fingerprintOfSecret: firstFingerprint,
    lines: [...document.querySelectorAll<HTMLElement>("[data-line]")].map((el) => ({
      id: el.dataset["line"] ?? "",
      status: (el.classList.contains("pass") ? "pass" : el.classList.contains("fail") ? "fail" : "unknown") as CheckStatus,
      text: el.querySelector(".detail")?.textContent ?? "",
    })),
  })
  assertNoSecretMaterial(report)
  const json = JSON.stringify(report, null, 2)
  const out = document.getElementById("report-json")
  if (out) out.textContent = json
  try {
    await navigator.clipboard.writeText(json)
    note("Report copied — it contains public values only, nothing secret.")
  } catch {
    note("Clipboard was refused — the report JSON is shown below the buttons instead.")
  }
}

function onForget(): void {
  clearSaved(window.localStorage)
  saved = null
  note(
    "Cleared the remembered credential ID. To remove the passkey itself, delete it in your password manager — Chrome: Settings → Passwords and autofill → Passkeys; iCloud Keychain: Settings → Passwords; 1Password: delete the item in your vault.",
  )
}

async function boot(): Promise<void> {
  const challengeEl = document.getElementById("challenge-hex")
  if (challengeEl) challengeEl.textContent = bytesToHex(TEST_CHALLENGE)

  const secure = window.isSecureContext
  const webauthn = typeof navigator.credentials?.create === "function" && typeof window.PublicKeyCredential === "function"
  if (secure && webauthn) {
    setLine("secure-context", "pass", "This is a secure context and the browser exposes WebAuthn.")
  } else {
    setLine(
      "secure-context",
      "fail",
      !secure
        ? "This is not a secure context — WebAuthn requires HTTPS (or localhost for a quick look, which proves nothing)."
        : "This browser does not expose WebAuthn.",
    )
  }

  try {
    platformAuthenticatorAvailable =
      typeof window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable === "function"
        ? await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        : null
  } catch {
    platformAuthenticatorAvailable = null
  }
  renderEnvironmentLine()

  document.getElementById("btn-create")?.addEventListener("click", () => void onCreate())
  document.getElementById("btn-use")?.addEventListener("click", () => void onUse())
  document.getElementById("btn-copy")?.addEventListener("click", () => void onCopyReport())
  document.getElementById("btn-forget")?.addEventListener("click", onForget)

  if (saved) note(`A test passkey (${saved.credentialId.slice(0, 12)}…) is remembered on this device — "Use my test passkey" will ask for it.`)
}

void boot()
