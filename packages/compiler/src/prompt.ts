// The extractor prompt, verbatim from spike/hooks/extract-prompt.txt.

import { CONTENT_FIELDS, type Checkpoint } from "@mida/checkpoint"
import { scrubValue } from "./scrub.js"

const RULES_HEAD = `You are extracting a compact task checkpoint from an AI coding agent's transcript. Another agent will continue this work from your summary alone.`

const REQUEST_PRESENT = `The transcript below is a list of blocks, each headed "L<n> <role>:" where <n> is the 1-based line number in the transcript file and <role> is "user" or "assistant". The FIRST block is the user's original request — it carries the objective and the constraints; read it first and weight it most. The blocks after it are the most recent messages; a line "[… N earlier messages omitted …]" marks messages dropped in between. A block headed "user — later messages you typed" lists, oldest first, messages the user typed later in the session that fall outside the recent messages. The user's words outrank the assistant's: when a later user message changes the goal or a requirement, the objective, nextAction and remainingPlan follow the user's LATEST instruction, and any decision it caused gives the user as its rationale ("the user asked …"), never the assistant's planning. A block "[interrupted here: …]" is not an instruction to stop or wait: nextAction is the work that was in progress. If the block names tool calls that were not approved, those calls are undecided and the next agent must ask the user before running them.`

// For a transcript that opened on scaffolding (post-/compact, resumed) or
// held no user ask at all, the first block is NOT the original request —
// claiming it is anyway taught the model to answer in prose and fail no-json.
const REQUEST_ABSENT = `The transcript below is a list of blocks, each headed "L<n> <role>:" where <n> is the 1-based line number in the transcript file and <role> is "user" or "assistant". No original request was captured; infer the task from the conversation and the summary. The blocks are the most recent messages; a line "[… N earlier messages omitted …]" marks messages dropped in between. A block headed "user — later messages you typed" lists, oldest first, messages the user typed later in the session that fall outside the recent messages. The user's words outrank the assistant's: when a later user message changes the goal or a requirement, the objective, nextAction and remainingPlan follow the user's LATEST instruction, and any decision it caused gives the user as its rationale ("the user asked …"), never the assistant's planning. A block "[interrupted here: …]" is not an instruction to stop or wait: nextAction is the work that was in progress. If the block names tool calls that were not approved, those calls are undecided and the next agent must ask the user before running them.`

const RULES_TAIL = `Output ONLY a single JSON object — no prose, no code fence — with exactly these fields:

- "objective": string — what the task is trying to achieve (required)
- "progress": string[] — what is already done
- "decisions": [{"decision": string, "rationale": string}] — choices made and why
- "rejected": [{"approach": string, "why": string}] — approaches considered and dropped
- "constraints": string[] — rules the work must keep obeying
- "artifacts": string[] — file paths created or modified
- "unresolvedIssue": string | null — the current blocker or open question
- "nextAction": string — the single next thing to do (required)
- "remainingPlan": string[] — every step or requirement in the original request that is NOT finished yet, one entry each, in the request's own words including names of functions, classes and files. Do not summarise several steps into one. If the request lists numbered steps, keep the numbers.
- "evidence": [{"field": string, "ref": string}] — where each claim came from. Use the block's line number: {"field": "decisions[0]", "ref": "transcript:L12"} (or a range like "transcript:L12-L15"), or a file path like {"field": "artifacts[0]", "ref": "file:src/x.js"}

Rules:
- Cite an evidence ref for every non-obvious claim.
- Write null or empty arrays rather than inventing content. Never guess.
- Never copy secrets, tokens, keys, or long transcript passages. Summarize, do not quote.
- Keep every string under 500 characters. Be compact.`

const RULES = `${RULES_HEAD}

${REQUEST_PRESENT}

${RULES_TAIL}`

const RULES_NO_REQUEST = `${RULES_HEAD}

${REQUEST_ABSENT}

${RULES_TAIL}`

const TRANSCRIPT_LINE = "TRANSCRIPT (possibly truncated, secrets already redacted):"

export const EXTRACT_PROMPT = `${RULES}

${TRANSCRIPT_LINE}
`

const EXTRACT_PROMPT_NO_REQUEST = `${RULES_NO_REQUEST}

${TRANSCRIPT_LINE}
`

// When the session already has a checkpoint, the model UPDATES it instead of
// summarising from nothing — each save stays one moving description of the
// session rather than another full restatement in new words (C1).
// The block sits BELOW the transcript (M3-H): DeepSeek and Kimi cache a
// request's byte-exact prefix, so the part that changes every compile must
// come last — a second compile's prompt is then literally the first compile's
// prompt plus this tail, and the whole transcript head stays a cache hit.
const PREVIOUS_LEAD = `PREVIOUS CHECKPOINT (below the transcript above — your own earlier summary of this same session, as JSON). Update it: keep every entry that is still true, in its existing wording; add what is new at the end of its list; move finished steps out of "remainingPlan" and into "progress"; remove an "unresolvedIssue" that the transcript shows was resolved. Never restate an existing entry in new words. Never drop a decision, rejected approach or constraint unless the transcript shows it was reversed.`

export function buildExtractPrompt(
  transcriptText: string,
  previous?: Checkpoint,
  originalRequestCaptured = true,
): string {
  const extractPrompt = originalRequestCaptured ? EXTRACT_PROMPT : EXTRACT_PROMPT_NO_REQUEST
  if (previous === undefined) return `${extractPrompt}\n${transcriptText}`
  // Only the ten content fields go back to the model — never the id, the
  // source tag, the timestamp, or the user's verbatim originalRequest. The
  // model's earlier output is untrusted text, so it is scrubbed again here.
  const fields: Record<string, unknown> = {}
  for (const key of CONTENT_FIELDS) fields[key] = scrubValue(previous[key])
  return `${extractPrompt}\n${transcriptText}\n\n${PREVIOUS_LEAD}\n${JSON.stringify(fields)}`
}
