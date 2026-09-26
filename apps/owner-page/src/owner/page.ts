import { createPublicClient, http } from "viem"
import { chainFor } from "@mida/chain/browser"
import { namespaceById } from "@mida/protocol"
import type { Hex } from "@mida/protocol"
import { DEPLOYMENT, RPC_URL, SPONSOR_URL, STORE_URL } from "./core.js"
import { pairingCode } from "@mida/protocol"
import { parseOwnerLink as parseLinkFragment, buildOwnerReturnUrl as buildReturnUrl } from "@mida/protocol"
import type { OwnerLinkFlow as FlowName, OwnerLinkResult as FlowResult, ParsedOwnerLink as ParsedLink } from "@mida/protocol"
import { makeOwnerApi, makeSponsoredSender, describeError } from "./session.js"
import type { FlowEnvironment } from "./flows.js"
import { rpIdCompatible } from "./webauthn.js"

/**
 * The shared page bootstrap the three flow entries (`signup.ts`, `approve.ts`, `revoke.ts`)
 * drive. Everything DOM-shaped lives here so the flow modules stay testable without a browser.
 */

const IDENTITY_LINE = "Your passkey is your Mida identity. Use the same passkey you originally registered."
const PAIRING_LABEL = "Only approve if this code matches your terminal:"

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`page is missing #${id}`)
  return node as T
}

export function progressLine(text: string): void {
  const list = el("progress")
  const li = document.createElement("li")
  li.textContent = text
  list.appendChild(li)
}

export function showError(text: string): void {
  const box = el<HTMLParagraphElement>("error")
  box.textContent = text
  box.hidden = false
}

/** The link → parse → pairing code + identity line. Throws LinkError; the caller renders it. */
export function parsePageLink(flow: FlowName): ParsedLink {
  const link = parseLinkFragment(location.hash.slice(1), flow)
  el("pairing-label").textContent = PAIRING_LABEL
  el<HTMLElement>("pairing-code").textContent = pairingCode(link.requestBytes)
  el("identity-line").textContent = IDENTITY_LINE
  return link
}

/**
 * WebAuthn's rule: the ceremony's rpId must equal the page's host or a registrable suffix of it.
 * The contract pins `deployment.vaultRpId`, so when the page is served somewhere that cannot
 * legitimately claim that rpId (the deployed origin is app.midacontext.xyz while the pinned
 * value is vault.mida.xyz), the ceremony would only fail inside the browser — explain it in
 * words first, before any prompt.
 */
export function assertRpGate(): void {
  if (!rpIdCompatible(location.hostname, DEPLOYMENT.vaultRpId)) {
    showError(
      `This page is running on "${location.hostname}", but this deployment's passkey belongs to "${DEPLOYMENT.vaultRpId}". ` +
        `A browser will only let a page use a passkey for its own site. Open the link on ${DEPLOYMENT.vaultRpId} (or a page under it).`,
    )
    throw new Error("rp id not compatible with this host")
  }
}

/**
 * The rows the approve signature will cover, rendered above the button. The new row shows the
 * project's label plus a prefix of its id; the existing rows the signature re-covers sit under a
 * <details> fold that names the count. A crafted link can still ASK for extra rows, but it can no
 * longer hide them — the DOM lists every row before the passkey is ever asked.
 */
export function showEntriesToSign(
  mount: HTMLElement,
  view: {
    added: { agent: string; projectId: string; root: string }
    existing: readonly { agent: string; projectId: string; root: string; approvedAt: string }[]
    projectLabel?: string
  },
): void {
  const short = (value: string) => (value.length > 10 ? `${value.slice(0, 10)}…` : value)
  mount.replaceChildren()
  const lead = document.createElement("p")
  lead.textContent = "Approving also signs your approved-projects list. The new row:"
  mount.appendChild(lead)
  const added = document.createElement("p")
  added.className = "sign-row"
  added.textContent = `“${view.projectLabel ?? view.added.projectId}” — id ${short(view.added.projectId)}`
  mount.appendChild(added)
  const details = document.createElement("details")
  const fold = document.createElement("summary")
  fold.textContent = `…plus ${view.existing.length} existing row${view.existing.length === 1 ? "" : "s"} your signature re-covers`
  details.appendChild(fold)
  const list = document.createElement("ul")
  for (const row of view.existing) {
    const li = document.createElement("li")
    li.textContent = `${row.projectId} — agent ${short(row.agent)} — root ${short(row.root)}`
    list.appendChild(li)
  }
  details.appendChild(list)
  mount.appendChild(details)
}

/**
 * The revoke counterpart of showEntriesToSign: revoking re-signs the approved-projects list
 * with the agent's rows removed — the signature covers the surviving rows, so the owner sees
 * exactly what stays before the passkey is asked.
 */
export function showListReSigned(
  mount: HTMLElement,
  rows: readonly { agent: string; projectId: string; root: string; approvedAt: string }[],
): void {
  const short = (value: string) => (value.length > 10 ? `${value.slice(0, 10)}…` : value)
  mount.replaceChildren()
  const lead = document.createElement("p")
  lead.textContent = "Revoking also re-signs your approved-projects list without this agent's rows."
  mount.appendChild(lead)
  const details = document.createElement("details")
  const fold = document.createElement("summary")
  fold.textContent =
    rows.length === 0
      ? "…no rows remain — the signature covers an empty list"
      : `…${rows.length} row${rows.length === 1 ? "" : "s"} stay on the list your signature re-covers`
  details.appendChild(fold)
  const list = document.createElement("ul")
  for (const row of rows) {
    const li = document.createElement("li")
    li.textContent = `${row.projectId} — agent ${short(row.agent)} — root ${short(row.root)}`
    list.appendChild(li)
  }
  details.appendChild(list)
  mount.appendChild(details)
}

/** The real environment: navigator.credentials, the chain RPC, the sponsor, the hosted store. */
export function makeEnv(): FlowEnvironment {
  const publicClient = createPublicClient({ chain: chainFor(DEPLOYMENT.chainId), batch: { multicall: true }, transport: http(RPC_URL) })
  return {
    credentials: navigator.credentials,
    publicClient: publicClient as never,
    deployment: DEPLOYMENT,
    storeUrl: STORE_URL,
    storage: window.localStorage,
    makeSponsor: (account) =>
      makeSponsoredSender({ account, sponsorUrl: SPONSOR_URL, rpcUrl: RPC_URL, deployment: DEPLOYMENT, progress: progressLine }),
    makeApi: (account) => makeOwnerApi({ account, storeUrl: STORE_URL, deployment: DEPLOYMENT }),
    fetchManifest: async (bodyHash: Hex) => {
      const response = await fetch(`${STORE_URL}/agent-manifests/${bodyHash}`)
      if (!response.ok) throw new Error(`the hosted store has no manifest ${bodyHash.slice(0, 18)}…`)
      return response.json()
    },
    progress: progressLine,
  }
}

/** Plain words for one requested scope: "the projects.current area — read". */
export function scopeInWords(namespaceId: Hex, permissions: number): string {
  let name: string = namespaceId
  try {
    name = namespaceById(namespaceId).name
  } catch {
    // an unknown namespace shows by its id
  }
  const bits: string[] = []
  if (permissions & 1) bits.push("read")
  if (permissions & 2) bits.push("add new entries")
  if (permissions & 4) bits.push("replace its own entries")
  if (permissions & 8) bits.push("replace any entry")
  return `the ${name} area — ${bits.length > 0 ? bits.join(" and ") : `permission bits ${permissions}`}`
}

/**
 * Done. With a port the page navigates the top-level window to the local listener — the same
 * redirect pattern CLI logins use (the fragment never reaches a server, and CSP has no
 * navigate-to directive to loosen anyway). Without one, the result shows on the page.
 */
export function finish(link: ParsedLink, result: FlowResult): void {
  const status = el<HTMLElement>("result-status")
  status.textContent =
    result.status === "success"
      ? "Done."
      : result.status === "cancelled"
        ? "Cancelled — nothing was sent."
        : result.status === "pending"
          ? `Pending — the operation was accepted (${result.operations[result.operations.length - 1] ?? "unknown"}). Check it before retrying.`
          : `Stopped: ${result.reason ?? "something failed"}`
  el("result").hidden = false
  if (link.port !== undefined) {
    const url = buildReturnUrl(link.port, link.nonce, result)
    progressLine("Returning the result to your terminal…")
    window.top!.location.href = url
  } else {
    progressLine("No return address in this link — return to your terminal.")
    el("result-json").textContent = JSON.stringify(result, null, 2)
  }
}
