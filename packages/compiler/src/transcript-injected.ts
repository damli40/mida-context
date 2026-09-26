// The injected-text filter the transcript readers share. Mida and the agents
// themselves inject their own text as user-role messages — Codex's
// <environment_context> scaffolding, Mida's "MIDA HANDOFF" note, the hook's
// "Mida: …" status lines — and none of it may become firstUserMessage, render
// as an owner turn, or be saved again as the original request. One list in
// one place, so a reader added later cannot silently skip the guard: Devin
// stores injected context as real is_user_input nodes (in-10 R-13), which is
// why the check must ignore that flag.

// User-role messages an agent or Mida injects ahead of the real request — a
// kept user message whose joined text opens with one of these is scaffolding,
// not the human's words.
export const INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<recommended_plugins>",
  "<user_shell_command>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
  "MIDA HANDOFF",
  // the header grew a parenthetical in in-8 — matching on the shared stem keeps the older and
  // the newer note both recognised as Mida's own injection
  "Mida update since you last checked",
]

// Mida's own hook and MCP output lands in a transcript as user-role text
// opening "Mida: ". Only the shapes Mida itself prints are skipped — a human
// prompt that happens to start "Mida:" is kept.
export const MIDA_HOOK_PATTERNS = [
  /^Mida: could not load context\b/,
  /^Mida: handoff loaded\b/,
  /^Mida: connected\b/,
  /^Mida: nothing new\b/,
  /^Mida: no context available\b/,
  /^Mida: no agent\b/,
  /^Mida: the approved-projects list\b/,
  /^Mida: updates? from\b/,
  /^Mida: \S+ has no access to this project\b/,
  /^Mida: \S+ is not approved for this project\b/,
  /^Mida: \S+'s access was revoked\b/,
  /^Mida: \S+'s identity in this Mida home\b/,
]

// Named agent/Mida scaffolding only — these user texts leave the conversation
// entirely; everything else renders.
export function isInjectedUserText(text: string): boolean {
  const t = text.trim()
  if (INJECTED_PREFIXES.some((pre) => t.startsWith(pre))) return true
  return MIDA_HOOK_PATTERNS.some((re) => re.test(t))
}
