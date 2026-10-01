/**
 * Task 5 — the /me page: route content, data wiring, and the DOM builder.
 *
 * renderMe is a pure builder — every string lands through textContent (the guard test scans
 * this directory for markup-writing APIs and fails the build on any), and a transaction link is
 * created only from a value matching model.isTxHash. Nothing here trusts the store, the index,
 * an agent manifest, or a record body; loadMe in sources.ts already re-verified every row, and
 * what could not be verified is rendered as such, never silently dropped.
 *
 * The boot path below the builder is thin: sign in once with the passkey (Task 4's session — seed released at once, namespace
 * secrets kept), gather with loadMe, render. On pagehide, sign-out, or the tab hidden past five
 * minutes the session's keys are overwritten and every decrypted cell is cleared — the page
 * never holds plaintext longer than the owner is looking at it.
 */

import { zeroHash } from "viem"
import { batchAnchorAbi, capabilityRegistryAbi, latestTimestamp } from "@mida/chain/browser"
import type { ChainContext } from "@mida/chain/browser"
import { ContextApiClient, RegistryReader } from "@mida/api/browser"
import { NAMESPACE_TREE_V1 } from "@mida/protocol"
import type { Address, Hex } from "@mida/protocol"
import { DEPLOYMENT, STORE_URL } from "../owner/core.js"
import { isUserCancel } from "../owner/flows.js"
import type { FlowEnvironment } from "../owner/flows.js"
import { assertRpGate, el, makeEnv, progressLine, showError } from "../owner/page.js"
import { describeError } from "../owner/session.js"
import { shortAddress } from "../owner/secrets.js"
import { chipsFor, INDEX_FRESHNESS_UNKNOWN_TEXT, isTxHash, provenanceBadge } from "./model.js"
import type { Badge } from "./model.js"
import { BLOCKED_AT_STORE_TEXT, loadMe } from "./sources.js"
import type { AgentRow, MeData, MePorts, RecordRow } from "./sources.js"
import { signIn } from "./session.js"
import type { MeSession } from "./session.js"

/** Monad testnet's explorer — the only destination a transaction link ever gets. */
const EXPLORER_TX = "https://testnet.monadexplorer.com/tx/"

/** Records rendered per page, newest first — decrypting in the browser is not free. */
const RECORD_PAGE = 20

/** The cell text when the ciphertext will not open under this passkey (spec §4.4). */
const COULD_NOT_OPEN = "could not be opened with this passkey"

/** Tab hidden longer than this ends the session and clears the page's plaintext. */
export const HIDDEN_LIMIT_MS = 5 * 60 * 1000

/** The exact #error text when the passkey prompt is dismissed — pinned verbatim by in-25 P-7. */
const PASSKEY_CANCELLED_TEXT =
  "The passkey prompt was cancelled or timed out. No passkey yet? Run mida init --passkey in a terminal first."

const BADGE_CLASS: Record<Badge["kind"], string> = {
  you: "b-ok",
  agent: "b-info",
  unknown: "b-neutral",
}

function elOf<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const shortHash = (hash: string): string => `${hash.slice(0, 6)}…${hash.slice(-4)}`

/**
 * The one place a transaction becomes a link: the value must be a full lowercase 32-byte hash.
 * Anything else — missing, truncated, uppercase, non-hash — returns null and the caller renders
 * plain text instead.
 */
function txLink(doc: Document, tx: Hex | null, text: string): HTMLAnchorElement | null {
  if (tx === null || !isTxHash(tx)) return null
  const a = elOf(doc, "a", "tx", text)
  a.setAttribute("href", `${EXPLORER_TX}${tx}`)
  a.setAttribute("target", "_blank")
  a.setAttribute("rel", "noopener noreferrer")
  return a
}

function metaWithTx(doc: Document, lead: string, tx: Hex | null, fallback: string): HTMLElement {
  const p = elOf(doc, "p", "agent-meta")
  p.appendChild(elOf(doc, "span", undefined, `${lead} · `))
  const link = txLink(doc, tx, `tx ${tx === null ? "" : shortHash(tx)}`)
  if (link !== null) p.appendChild(link)
  else p.appendChild(elOf(doc, "span", undefined, fallback))
  return p
}

function formatWhen(createdAtMs: number): string {
  if (createdAtMs <= 0) return "time unknown"
  const diff = Date.now() - createdAtMs
  if (diff < 60_000) return "just now"
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} h ago`
  const d = new Date(createdAtMs)
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
  return `${day}, ${time}`
}

// --- sections ----------------------------------------------------------------------------------

function renderHead(doc: Document, data: MeData): HTMLElement {
  const head = elOf(doc, "div", "me-head")
  const left = elOf(doc, "div")
  head.appendChild(left)
  left.appendChild(elOf(doc, "p", "eyebrow", "Your Mida"))
  left.appendChild(elOf(doc, "h1", "me-title", "Your records, and who wrote them."))
  const ownerLine = elOf(doc, "p", "owner-line")
  ownerLine.appendChild(elOf(doc, "span", undefined, "Owner "))
  ownerLine.appendChild(elOf(doc, "code", undefined, shortAddress(data.owner)))
  ownerLine.appendChild(
    elOf(doc, "span", undefined, ", derived from your passkey on this device. This browser stores your address and your passkey's public details, nothing secret."),
  )
  left.appendChild(ownerLine)
  const source = elOf(doc, "p", "source")
  source.appendChild(elOf(doc, "span", data.lag.stale ? "dot dot-stale" : "dot"))
  // The badge names what the page actually read: the store's record lists, checked on Monad.
  source.appendChild(elOf(doc, "span", undefined, data.lag.text))
  head.appendChild(source)
  return head
}

function renderSummary(doc: Document, data: MeData): HTMLElement {
  const bento = elOf(doc, "section", "bento")
  bento.setAttribute("aria-label", "Summary")
  const live = data.agents.filter((a) => a.readLive).length
  const revoked = data.agents.filter(
    (a) =>
      !a.readLive &&
      (a.revokedTx !== null || (a.grants.length > 0 && a.grants.every((g) => g.status.label === "Revoked"))),
  ).length
  const lead = elOf(doc, "div", "tile tile-lead")
  if (data.agentsUnavailable !== null) {
    // No agent source answered — a count would invent certainty the page does not have. The
    // flag carries its own sentence so the blame is exact ("the index is down" vs "not
    // configured").
    lead.appendChild(elOf(doc, "p", "n", data.agentsUnavailable))
  } else {
    // Agents whose chain check could not run are not "0 can read" — count them as unchecked so
    // the headline never rounds an unknown down to a negative. A stale index gets the "At least"
    // wording — an agent approved past its progress block is simply absent, so the fresh-index
    // count would overstate certainty — and when the index could not even measure its own lag
    // the line hedges ("may be behind") rather than asserting it (in-26 Q-2).
    const unchecked = data.agents.filter((a) => a.unverified).length
    const headline = data.lag.stale
      ? [
          live > 0
            ? `At least ${live} agent${live === 1 ? "" : "s"} can read your context.`
            : "No agent can read your context, as far as the index shows.",
          ...(unchecked > 0 ? [`${unchecked} could not be checked just now.`] : []),
          data.lag.text === INDEX_FRESHNESS_UNKNOWN_TEXT
            ? "The index may be behind Monad, so a new approval may not show yet."
            : "The index is behind Monad, so a new approval may not show yet.",
        ].join(" ")
      : unchecked > 0
        ? `${live} agent${live === 1 ? "" : "s"} · ${unchecked} could not be checked just now`
        : `${live} agent${live === 1 ? "" : "s"} can read your context right now.`
    lead.appendChild(
      elOf(doc, "p", "n", revoked === 0 ? headline : `${headline} ${revoked} ${revoked === 1 ? "was" : "were"} revoked.`),
    )
    lead.appendChild(elOf(doc, "p", "l", "Revoking stops future reads. It cannot recall what an agent already read."))
  }
  bento.appendChild(lead)
  // Each figure names its own source: records and "stated by you" are the index's totals, while
  // "waiting to be anchored" is counted from the store's batched list — and is hidden outright
  // when that list could not be fully read. The group is absent entirely when the index could
  // not vouch for its side or a store list came back partial (the banner says why).
  if (data.counts !== null) {
    const tiles: [keyof typeof data.counts, string][] = [
      ["records", "records saved — per the index"],
      ["youSaid", "stated by you — per the index"],
    ]
    if (data.batchedListComplete) tiles.push(["pending", "waiting to be anchored — per the store"])
    for (const [key, label] of tiles) {
      const tile = elOf(doc, "div", "tile")
      tile.setAttribute("data-count", key)
      tile.appendChild(elOf(doc, "p", "n", String(data.counts[key])))
      tile.appendChild(elOf(doc, "p", "l", label))
      bento.appendChild(tile)
    }
  }
  return bento
}

function grantStatusText(grant: AgentRow["grants"][number]): string | null {
  const { label, flagged, unchecked } = grant.status
  if (label === "Can read" && !flagged) return null
  if (!flagged) return label
  // A chain read that never returned is a check that did not run — not a disagreement between
  // the listing and Monad. Blame Monad, not the index.
  if (unchecked) return `${label} — could not check Monad just now`
  return `${label} — the index disagrees with the chain`
}

function renderAgent(doc: Document, agent: AgentRow): HTMLElement {
  const allRevoked = agent.grants.length > 0 && agent.grants.every((g) => g.status.label === "Revoked")
  const flagged = agent.grants.find((g) => g.status.flagged)
  const revokedRow = !agent.readLive && !agent.blockedAtStore && allRevoked
  const row = elOf(doc, "div", revokedRow ? "agent is-revoked" : "agent")

  const identity = elOf(doc, "div")
  row.appendChild(identity)
  identity.appendChild(elOf(doc, "p", "agent-name", agent.name))
  const approvedTx = agent.grants.map((g) => g.approvedTx).find((tx) => tx !== null) ?? null
  identity.appendChild(metaWithTx(doc, "Approved", approvedTx, "grant transaction not indexed"))
  if (agent.revokedTx !== null || revokedRow) {
    identity.appendChild(metaWithTx(doc, "Revoked", agent.revokedTx, "revocation not indexed"))
  }

  const grants = elOf(doc, "div", "grants")
  row.appendChild(grants)
  grants.appendChild(elOf(doc, "p", "grants-label", "Grants"))
  for (const grant of agent.grants) {
    const grantRow = elOf(doc, "div", "grant-row")
    grantRow.appendChild(elOf(doc, "span", "area", grant.area))
    const chips = elOf(doc, "span", "chips")
    const c = chipsFor(grant.permissions)
    const slots: [string, boolean][] = [
      ["Read", c.read],
      ["Write", c.write],
      ["Update own", c.updateOwn],
    ]
    if (c.updateAny) slots.push(["Update any", true])
    for (const [label, on] of slots) {
      chips.appendChild(elOf(doc, "span", `chip ${on ? "chip-on" : "chip-off"}`, label))
    }
    grantRow.appendChild(chips)
    const statusText = grantStatusText(grant)
    if (statusText !== null) grantRow.appendChild(elOf(doc, "span", "grant-status", statusText))
    grants.appendChild(grantRow)
  }

  const box = elOf(doc, "div", "revoke-box")
  row.appendChild(box)
  const badge = agent.blockedAtStore
    ? { cls: "b-warn", text: BLOCKED_AT_STORE_TEXT }
    : agent.readLive
      ? { cls: "b-ok", text: "Can read" }
      : flagged !== undefined
        ? { cls: "b-warn", text: flagged.status.label }
        : allRevoked
          ? { cls: "b-bad", text: "Revoked" }
          : { cls: "b-neutral", text: "No read access" }
  box.appendChild(elOf(doc, "span", `badge ${badge.cls}`, badge.text))
  if (revokedRow) {
    box.appendChild(elOf(doc, "p", "revoke-note", "Refused since revocation. Anything it read before then stays with it."))
  }
  // Read-only build: where the revoke button stood, the row names the terminal command instead.
  // A revoke rotates the area key, and the terminal is where the re-key is guaranteed to run.
  // The name is the agent's own manifest string — it goes into a command line only when it is
  // plainly a safe shell word; anything else gets the fallback that finds the name first
  // (in-30 NIT 7).
  const revokeNote = /^[a-z0-9][a-z0-9-]{0,39}$/.test(agent.name)
    ? `To revoke: run mida revoke ${agent.name} in your terminal.`
    : "To revoke this agent, run mida doctor in your terminal to find its name, then mida revoke with that name."
  box.appendChild(elOf(doc, "p", "revoke-note", revokeNote))
  return row
}

function renderAgents(doc: Document, data: MeData): HTMLElement {
  const sec = elOf(doc, "section", "sec")
  sec.setAttribute("aria-labelledby", "agents-title")
  const head = elOf(doc, "div", "sec-head")
  sec.appendChild(head)
  const agentsTitle = elOf(doc, "h2", "sec-title", "Agents and their access")
  agentsTitle.setAttribute("id", "agents-title")
  head.appendChild(agentsTitle)
  head.appendChild(elOf(doc, "p", "sec-note", "Access is enforced by the contract on Monad, not by this page."))
  sec.appendChild(
    elOf(
      doc,
      "p",
      "sec-note",
      "This page is read-only. Revoking happens in your terminal, where your other agents get the new key.",
    ),
  )
  if (data.agentsUnavailable !== null) {
    sec.appendChild(elOf(doc, "p", "agent-meta", data.agentsUnavailable))
    return sec
  }
  if (data.agents.length === 0) {
    sec.appendChild(elOf(doc, "p", "agent-meta", "No agents have been granted access yet."))
    return sec
  }
  for (const agent of data.agents) sec.appendChild(renderAgent(doc, agent))
  return sec
}

type OpenRow = (row: RecordRow) => { ok: true; text: string; provenanceSource: number | null } | { ok: false }

function renderRecordRow(doc: Document, row: RecordRow, open: OpenRow | undefined): HTMLElement {
  const tr = elOf(doc, "tr")
  tr.setAttribute("data-row", row.contextId)

  const what = elOf(doc, "td")
  tr.appendChild(what)
  const opened = open?.(row)
  const text = opened !== undefined && opened.ok ? opened.text : COULD_NOT_OPEN
  const rec = elOf(doc, "p", "rec-what", text)
  if (opened !== undefined && opened.ok) rec.setAttribute("data-decrypted", "1")
  what.appendChild(rec)
  const sub = elOf(doc, "p", "rec-sub")
  sub.appendChild(elOf(doc, "span", "mono", row.area))
  sub.appendChild(elOf(doc, "span", undefined, ` · ${shortHash(row.contextId)}`))
  what.appendChild(sub)

  const who = elOf(doc, "td")
  tr.appendChild(who)
  const whoWrap = elOf(doc, "div", "who")
  const badge = provenanceBadge(row)
  whoWrap.appendChild(elOf(doc, "span", `badge ${BADGE_CLASS[badge.kind]}`, badge.text))
  // The decrypted payload's own provenance label is checked against the row's verified source —
  // for an anchored row that is the chain record's (or the proof-verified signed message's)
  // provenance. A disagreement means the bytes inside do not match what Monad recorded.
  if (
    opened !== undefined &&
    opened.ok &&
    row.state === "anchored" &&
    row.source !== null &&
    opened.provenanceSource !== null &&
    opened.provenanceSource !== row.source
  ) {
    whoWrap.appendChild(elOf(doc, "span", "badge b-bad", "the record's own label disagrees with Monad"))
  }
  who.appendChild(whoWrap)

  tr.appendChild(elOf(doc, "td", undefined, formatWhen(row.createdAt)))

  const anchor = elOf(doc, "td")
  tr.appendChild(anchor)
  if (row.state === "pending") {
    anchor.appendChild(elOf(doc, "span", "badge b-warn", "Pending anchor"))
  } else if (row.state === "blocked") {
    // The store holds it or Monad already refuses it — a pending revoke or a dead grant, not a
    // queue delay. It stays out of "pending" so the owner never mistakes it for a slow anchor.
    anchor.appendChild(elOf(doc, "span", "badge b-bad", "Blocked — author denied or no longer authorized"))
  } else if (row.state === "unknown") {
    // The check itself never ran — this is not a verdict, so it must not wear "not on Monad".
    anchor.appendChild(elOf(doc, "span", "badge b-warn", "could not check Monad just now"))
  } else if (row.state === "unverified") {
    anchor.appendChild(elOf(doc, "span", "badge b-bad", "not on Monad — unverified"))
  } else {
    const lane = row.lane === "direct" ? "direct" : "batch"
    const link = txLink(doc, row.tx, `${lane} · ${row.tx === null ? "" : shortHash(row.tx)}`)
    if (link !== null) anchor.appendChild(link)
    else anchor.appendChild(elOf(doc, "span", "tx-none", `${lane} · anchored on Monad`))
  }
  return tr
}

function renderRecords(doc: Document, data: MeData, open: OpenRow | undefined): HTMLElement {
  const sec = elOf(doc, "section", "sec")
  sec.setAttribute("aria-labelledby", "records-title")
  const head = elOf(doc, "div", "sec-head")
  sec.appendChild(head)
  const recordsTitle = elOf(doc, "h2", "sec-title", "Recent records, and who wrote them")
  recordsTitle.setAttribute("id", "records-title")
  head.appendChild(recordsTitle)
  head.appendChild(
    elOf(
      doc,
      "p",
      "sec-note",
      "Records the store holds, each re-checked against Monad. Content decrypts on this device after your passkey.",
    ),
  )
  if (data.records.length === 0) {
    // "Empty" is only a claim when a listing actually answered empty — a store that failed
    // every call produced no list at all, and the page says so.
    sec.appendChild(
      elOf(
        doc,
        "p",
        "agent-meta",
        data.recordsUnavailable ? "could not load records from the store" : "The store holds no records for this owner.",
      ),
    )
    return sec
  }
  const table = elOf(doc, "table", "records")
  sec.appendChild(table)
  const thead = elOf(doc, "thead")
  table.appendChild(thead)
  const headRow = elOf(doc, "tr")
  thead.appendChild(headRow)
  for (const label of ["What", "Written by", "When", "On Monad"]) headRow.appendChild(elOf(doc, "th", undefined, label))
  const tbody = elOf(doc, "tbody")
  table.appendChild(tbody)

  let shown = 0
  const more = elOf(doc, "button", "btn btn-secondary btn-small me-more", "Show 20 more")
  more.setAttribute("type", "button")
  more.setAttribute("data-more", "")
  const showNext = (): void => {
    const next = data.records.slice(shown, shown + RECORD_PAGE)
    shown += next.length
    for (const row of next) tbody.appendChild(renderRecordRow(doc, row, open))
    if (shown >= data.records.length) more.remove()
  }
  showNext()
  if (shown < data.records.length) {
    more.addEventListener("click", showNext)
    sec.appendChild(more)
  }
  return sec
}

function renderAnchor(doc: Document, data: MeData): HTMLElement {
  const sec = elOf(doc, "section", "sec")
  sec.setAttribute("aria-labelledby", "anchor-title")
  const head = elOf(doc, "div", "sec-head")
  sec.appendChild(head)
  const anchorTitle = elOf(doc, "h2", "sec-title", "How your saves reach Monad")
  anchorTitle.setAttribute("id", "anchor-title")
  head.appendChild(anchorTitle)
  const batching =
    data.batchingOn === true
      ? "Batching is on for this setup."
      : data.batchingOn === false
        ? "Batching is off for this setup."
        : "Batching state unknown — the store did not answer."
  head.appendChild(elOf(doc, "p", "sec-note", batching))

  const whole = data.incomplete.length === 0
  const direct = data.records.filter((r) => r.lane === "direct" && r.state === "anchored").length
  const batched = data.records.filter((r) => r.lane === "batched" && r.state === "anchored").length
  const pending = data.records.filter((r) => r.state === "pending").length
  const grid = elOf(doc, "div", "anchor-grid")
  sec.appendChild(grid)
  const cards: [string, string, string, number][] = [
    ["b-neutral", "One save, one transaction", "Records written directly. Grants, revokes and your own facts always go this way.", direct],
    ["b-info", "Batched", "Checkpoints anchored by Mida's batcher under one Merkle root per batch. The contract re-checks every signature.", batched],
    ["b-warn", "Pending anchor", "The store's queue: saved and checked, usable in handoffs, not yet on Monad. The contract can still reject them.", pending],
  ]
  for (const [cls, badge, blurb, count] of cards) {
    const card = elOf(doc, "div", "anchor-card")
    card.appendChild(elOf(doc, "span", `badge ${cls}`, badge))
    // A figure only ever shows when every store list came back complete — otherwise "—".
    card.appendChild(elOf(doc, "p", "big", whole ? String(count) : "—"))
    card.appendChild(elOf(doc, "p", undefined, blurb))
    grid.appendChild(card)
  }
  sec.appendChild(
    elOf(
      doc,
      "p",
      "honest",
      whole
        ? "Counted from the records the store holds, each re-checked against Monad."
        : "Figures hidden — the record list is incomplete. The banner above says which list.",
    ),
  )
  return sec
}

function renderFoot(doc: Document): HTMLElement {
  const foot = elOf(doc, "footer", "me-foot")
  foot.appendChild(elOf(doc, "span", undefined, "Mida · Monad testnet"))
  const contracts = elOf(doc, "span")
  contracts.appendChild(elOf(doc, "span", undefined, "Contracts "))
  contracts.appendChild(elOf(doc, "span", "mono", shortHash(DEPLOYMENT.capabilityRegistry)))
  contracts.appendChild(elOf(doc, "span", undefined, " · "))
  contracts.appendChild(elOf(doc, "span", "mono", shortHash(DEPLOYMENT.contextRegistry)))
  foot.appendChild(contracts)
  return foot
}

/**
 * The whole dashboard below the sign-in block, built from the verified rows only. `open` is the
 * session's decrypt — absent, every record cell says it could not be opened rather than guessing.
 */
export function renderMe(data: MeData, doc: Document, open?: OpenRow): HTMLElement {
  const root = elOf(doc, "div", "me-content")
  root.appendChild(renderHead(doc, data))
  for (const line of data.incomplete) root.appendChild(elOf(doc, "p", "me-banner", line))
  root.appendChild(renderSummary(doc, data))
  root.appendChild(renderAgents(doc, data))
  root.appendChild(renderRecords(doc, data, open))
  root.appendChild(renderAnchor(doc, data))
  root.appendChild(renderFoot(doc))
  return root
}

// --- live ports: chain views and the store client -------------------------------------------------

function livePorts(env: FlowEnvironment, session: MeSession): MePorts {
  const context: ChainContext = { publicClient: env.publicClient, deployment: env.deployment }
  const reader = new RegistryReader(context)
  const deployment = env.deployment
  return {
    // No index is deployed: the agent list is not offered, and records come from the store.
    index: null,
    // The store client signs as the derived owner — owner reads need no capability.
    store: new ContextApiClient({
      baseUrl: STORE_URL,
      account: session.signer,
      chainId: deployment.chainId,
      capabilityRegistry: deployment.capabilityRegistry,
    }),
    chain: {
      isCapabilityValid: async (capabilityId) =>
        (await context.publicClient.readContract({
          address: deployment.capabilityRegistry,
          abi: capabilityRegistryAbi,
          functionName: "isCapabilityValid",
          args: [capabilityId],
        } as never)) as boolean,
      getCapability: (capabilityId) => reader.getCapability(capabilityId),
      getRecords: (ids) => reader.getRecords(ids),
      batchRoot: async (batchId) => {
        if (deployment.batchAnchor === undefined) return null
        const batch = (await context.publicClient.readContract({
          address: deployment.batchAnchor,
          abi: batchAnchorAbi,
          functionName: "batchOf",
          args: [batchId],
        } as never)) as { root: Hex }
        return batch.root === zeroHash ? null : batch.root
      },
      batchBlock: async (batchId) => {
        if (deployment.batchAnchor === undefined) return null
        const batch = (await context.publicClient.readContract({
          address: deployment.batchAnchor,
          abi: batchAnchorAbi,
          functionName: "batchOf",
          args: [batchId],
        } as never)) as { root: Hex; blockNumber: bigint }
        return batch.root === zeroHash ? null : batch.blockNumber
      },
      blockTime: async (block) => {
        const found = await context.publicClient.getBlock({ blockNumber: block })
        return Number(found.timestamp)
      },
      agentIdOfSigner: (signer) => reader.agentIdOfSigner(signer),
      getAgent: (agentId) => reader.getAgent(agentId),
      hasAuthority: (owner, agentId, namespaceId, permission, provenancePolicy) =>
        reader.hasAuthority(owner, agentId, namespaceId, permission, provenancePolicy),
      latestTimestamp: async () => Number(await latestTimestamp(context)),
      latestBlock: () => context.publicClient.getBlockNumber(),
    },
  }
}

// --- boot ---------------------------------------------------------------------------------------

/**
 * The store port wrapped so teardown can cut it dead: the client inside signs every read as the
 * owner, and once the session ends a signed-out page must not issue owner-signed calls on a
 * leftover key. drop() releases the reference — the signer it held becomes unreachable.
 */
export function revocableStore(store: MePorts["store"]): { port: MePorts["store"]; drop: () => void } {
  let live: MePorts["store"] | null = store
  const need = (): MePorts["store"] => {
    if (live === null) throw new Error("signed out — the store signer was dropped")
    return live
  }
  return {
    port: {
      // `async` so a dead port rejects instead of throwing synchronously at the call site.
      listObjects: async (input) => need().listObjects(input),
      listBatchSaves: async (input) => need().listBatchSaves(input),
      listRevocations: async (state) => need().listRevocations(state),
      batchStatus: async () => need().batchStatus(),
      getAgentManifest: async (hash) => need().getAgentManifest(hash),
    },
    drop: () => {
      live = null
    },
  }
}

/**
 * Everything that must happen when the owner leaves: keys overwritten, plaintext cleared, the
 * store signer dropped, and every control that could act on the owner's behalf disabled. The
 * five-minute rule is a real timer armed on visibilitychange→hidden — a hidden tab that never
 * comes back still loses its session; the elapsed check on return stays as the backstop for a
 * throttled timer.
 */
export function armTeardown(session: Pick<MeSession, "end">, dropSigner: () => void): void {
  let hiddenAt: number | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    session.end()
    dropSigner()
    // Plaintext leaves the page with the keys — the cells remain, their content does not.
    // The query runs against the live tree — a refresh may have replaced the first render.
    for (const node of Array.from(el("me-root").querySelectorAll("[data-decrypted]"))) {
      node.textContent = "cleared — sign in again to read"
    }
    // The records pager is the only control left on a signed-out page — disable it too.
    for (const node of Array.from(el("me-root").querySelectorAll("[data-more]"))) {
      ;(node as HTMLButtonElement).disabled = true
    }
    el("sign-in").hidden = false
    el<HTMLButtonElement>("go").disabled = false
  }
  window.addEventListener("pagehide", end)
  el("sign-out").addEventListener("click", end)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now()
      if (hideTimer === null) hideTimer = setTimeout(end, HIDDEN_LIMIT_MS)
    } else {
      if (hideTimer !== null) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      // A hidden-tab timer can be throttled past the limit — the elapsed check is the backstop.
      if (hiddenAt !== null && Date.now() - hiddenAt > HIDDEN_LIMIT_MS) end()
      hiddenAt = null
    }
  })
}

function boot(): void {
  try {
    assertRpGate()
  } catch {
    return
  }
  const button = el<HTMLButtonElement>("go")
  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true
      const env = makeEnv()
      progressLine("Asking for your passkey…")
      // Secrets for every area in the frozen tree are derived in the one ceremony — the seed is
      // released before signIn returns, whatever the record list turns out to hold.
      const session = await signIn(env, NAMESPACE_TREE_V1.map((node) => node.id))
      progressLine("Signed in. Reading your records…")
      const ports = livePorts(env, session)
      // The store client signs every read as the owner — teardown drops it so a signed-out page
      // cannot issue owner-signed calls on a leftover key.
      const storeHandle = revocableStore(ports.store)
      ports.store = storeHandle.port
      // Every render is a fresh read — the page re-reads, it does not assume.
      const refresh = async (): Promise<void> => {
        const data = await loadMe(session.owner, ports)
        const root = renderMe(data, document, (row) => session.open(row))
        el("me-root").replaceChildren(root)
      }
      await refresh()
      el("sign-in").hidden = true
      el("me-root").hidden = false
      el("nav-state").hidden = false
      el("sign-out").hidden = false
      armTeardown(session, storeHandle.drop)
    })().catch((error: unknown) => {
      showError(isUserCancel(error) ? PASSKEY_CANCELLED_TEXT : describeError(error))
      button.disabled = false
    })
  })
}

// The bundle self-starts on the real page; tests import renderMe with no document at all.
if (
  typeof document !== "undefined" &&
  typeof document.getElementById === "function" &&
  document.getElementById("go") !== null
) {
  boot()
}
