/**
 * The terminal ↔ page wire contract lives in `@mida/protocol` (src/owner-link.ts) — one
 * implementation shared by this page and the terminal. This file is only the old import path,
 * kept so existing imports (and the tests that pin the page-side names) keep working.
 */
export {
  OwnerLinkError,
  OwnerLinkError as LinkError,
  buildOwnerResult,
  buildOwnerResult as buildResult,
  buildOwnerReturnUrl,
  buildOwnerReturnUrl as buildReturnUrl,
  parseOwnerLink,
  parseOwnerLink as parseLinkFragment,
} from "@mida/protocol"
export type {
  OwnerLinkFlow as FlowName,
  OwnerLinkProject as ProjectLabel,
  OwnerLinkRequest as LinkRequest,
  OwnerLinkResult as FlowResult,
  ParsedOwnerLink as ParsedLink,
} from "@mida/protocol"
