// Shared setup for the deterministic groups: the same local chain launcher the
// e2e tests use (never a second one), temp Mida homes, project markers, seeded
// transcripts and the drain-test stub compile. Nothing here decides a check —
// checks read the chain, the server, the queue/log files, or the injected text.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { localEnvironment } from "@mida/cli"
import type { ScenarioEnvironment } from "@mida/cli"
import type { Checkpoint } from "../../packages/checkpoint/src/index.js"
import type { CompileInput, CompileResult } from "../../packages/compiler/src/index.js"
import { MidaHome } from "../../apps/midad/src/index.js"
import type { Network } from "../../apps/midad/src/index.js"

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url))
export const STUB_MODEL = fileURLToPath(new URL("./stub-model.mjs", import.meta.url))
export const HANGING_MODEL = fileURLToPath(new URL("./hanging-model.mjs", import.meta.url))

export interface BenchChain {
  env: ScenarioEnvironment
  network: Network
}

/** One fresh Anvil + deployment + in-process API per group file, exactly as the e2e tests build it. */
export async function benchChain(): Promise<BenchChain> {
  const env = await localEnvironment()
  return { env, network: { rpcUrl: env.rpcUrl, deployment: env.deployment, fund: env.fund } }
}

export function benchDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `mida-bench-${tag}-`))
}

export function benchHome(tag: string): MidaHome {
  return new MidaHome(benchDir(tag))
}

/** Writes `.mida/project.json` — the marker a project folder carries. */
export function mark(folder: string, projectId: string): void {
  mkdirSync(join(folder, ".mida"), { recursive: true })
  writeFileSync(join(folder, ".mida", "project.json"), JSON.stringify({ projectId }))
}

// ---------- transcript builders (Claude Code JSONL shape) ----------

export const userLine = (text: string): unknown => ({ type: "user", message: { content: text } })
export const assistantText = (text: string): unknown => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
})
export const assistantToolUse = (name: string, input: unknown): unknown => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
})
export const userToolResult = (text: string): unknown => ({
  type: "user",
  message: { content: [{ type: "tool_result", content: text }] },
})

/**
 * A transcript where the drainer expects one: `<homeDir>/.claude/projects/<proj>/<name>.jsonl`.
 * `homeDir` stands in for the user's real home — never the actual one.
 */
export function writeTranscript(homeDir: string, proj: string, name: string, lines: readonly unknown[]): string {
  const dir = join(homeDir, ".claude", "projects", proj)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  return file
}

export const appendTranscript = (path: string, line: unknown): void => {
  appendFileSync(path, JSON.stringify(line) + "\n")
}

/** A valid checkpoint; `over` replaces any field. Mirrors the e2e helper. */
export function sampleCheckpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    eventId: "cp-bench0001",
    agent: "claude-code",
    source: "hook-compiler",
    createdAt: "2026-09-21T10:00:00.000Z",
    objective: "o",
    originalRequest: null,
    progress: [],
    decisions: [],
    rejected: [],
    constraints: [],
    artifacts: [],
    unresolvedIssue: null,
    nextAction: "n",
    remainingPlan: [],
    evidence: [],
    ...over,
  }
}

/**
 * The drain-test stub compile: counts inputs, returns `body(input)` or a plain
 * valid checkpoint. The compile pipeline itself is never under test through
 * this — where it is (C1, C7, D1, H4), the real compileCheckpoint runs against
 * the stub-model subprocess instead.
 */
export function stubCompile(
  calls: CompileInput[],
  body?: (input: CompileInput, n: number) => CompileResult,
): (input: CompileInput) => Promise<CompileResult> {
  return async (input) => {
    calls.push(input)
    if (body !== undefined) return body(input, calls.length)
    return {
      ok: true,
      checkpoint: sampleCheckpoint({ eventId: input.eventId, agent: input.agent }),
      compiledBy: "stub",
      droppedKeys: [],
      trimmed: [],
      attempts: 1,
      format: "claude-jsonl",
      messagesKept: 1,
      messagesTotal: 1,
      charsSent: 0,
      modelMs: 0,
    }
  }
}

export const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8")

export function fixtureJson<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T
}

/**
 * The eight fake secret shapes for D1, built at run time by concatenation so no
 * secret-shaped literal ever sits in the repo. Every shape must trip scrubSecrets —
 * the check asserts that first, or the whole measurement is vacuous.
 */
export function fakeSecrets(): { name: string; value: string }[] {
  return [
    { name: "private-key-block", value: "-----BEGIN " + "PRIVATE KEY-----\nQUJD" + "REVGRw==\n-----END " + "PRIVATE KEY-----" },
    { name: "aws-key", value: "AKIA" + "ABCD".repeat(4) },
    { name: "slack-token", value: "xox" + "b" + "-" + "1234".repeat(4) },
    { name: "github-token", value: "gh" + "p_" + "a".repeat(24) },
    { name: "openai-style", value: "sk-" + "ant-" + "x".repeat(40) },
    { name: "hex-key-0x", value: "0x" + "f".repeat(64) },
    { name: "hex-key-bare", value: "e".repeat(64) },
    { name: "env-assign", value: "API_" + "KEY=z".repeat(16) },
  ]
}
