import type { Checkpoint } from "@mida/checkpoint"

/** A fully-populated checkpoint that passes validation; `over` replaces any field. */
export function sampleCheckpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    eventId: "cp-sample01",
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
