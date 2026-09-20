// Single source of truth for the checkpoint shape.
// Deterministic, no dependencies. Rejects unknown keys, enforces types,
// caps every string at 2000 chars and every array at 50 items.

const MAX_STR = 2000;
// originalRequest carries the user's own words verbatim — it needs more
// room than ordinary fields and is the ONE field exempt from MAX_STR.
const MAX_REQUEST = 6000;
const MAX_ARR = 50;
const SOURCES = new Set(["agent-tool", "hook-compiler"]);

const CONTENT_KEYS = [
  "objective",
  "originalRequest",
  "progress",
  "decisions",
  "rejected",
  "constraints",
  "artifacts",
  "unresolvedIssue",
  "nextAction",
  "remainingPlan",
  "evidence",
];
const ALL_KEYS = new Set(["eventId", "agent", "source", "createdAt", ...CONTENT_KEYS]);

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v, path, errors, { required = false } = {}) {
  if (typeof v !== "string") {
    errors.push(`${path}: expected string, got ${v === null ? "null" : typeof v}`);
    return;
  }
  if (required && v.trim() === "") errors.push(`${path}: must be non-empty`);
  if (v.length > MAX_STR) errors.push(`${path}: string exceeds ${MAX_STR} chars`);
}

function strList(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected array, got ${typeof v}`);
    return;
  }
  if (v.length > MAX_ARR) errors.push(`${path}: array exceeds ${MAX_ARR} items`);
  v.forEach((item, i) => str(item, `${path}[${i}]`, errors));
}

function pairList(v, path, keys, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected array, got ${typeof v}`);
    return;
  }
  if (v.length > MAX_ARR) errors.push(`${path}: array exceeds ${MAX_ARR} items`);
  v.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(item)) {
      errors.push(`${p}: expected object`);
      return;
    }
    for (const k of Object.keys(item)) {
      if (!keys.includes(k)) errors.push(`${p}.${k}: unknown key`);
    }
    for (const k of keys) str(item[k], `${p}.${k}`, errors);
  });
}

// Validates a full checkpoint record. `createdAt` may be absent on input
// (the store stamps it); if present it must be a parseable date string.
export function validateCheckpoint(obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ["checkpoint: expected object"] };

  for (const k of Object.keys(obj)) {
    if (!ALL_KEYS.has(k)) errors.push(`${k}: unknown top-level key`);
  }

  str(obj.eventId, "eventId", errors, { required: true });
  if (typeof obj.eventId === "string" && (obj.eventId.length < 8 || obj.eventId.length > 128)) {
    errors.push("eventId: must be 8-128 chars");
  }
  str(obj.agent, "agent", errors, { required: true });
  if (!SOURCES.has(obj.source)) {
    errors.push(`source: must be one of ${[...SOURCES].join(" | ")}`);
  }
  if (obj.createdAt !== undefined) {
    if (typeof obj.createdAt !== "string" || Number.isNaN(Date.parse(obj.createdAt))) {
      errors.push("createdAt: must be an ISO-8601 date string");
    }
  }

  str(obj.objective, "objective", errors, { required: true });
  str(obj.nextAction, "nextAction", errors, { required: true });
  if (obj.originalRequest !== undefined && obj.originalRequest !== null) {
    if (typeof obj.originalRequest !== "string") {
      errors.push(`originalRequest: expected string or null, got ${typeof obj.originalRequest}`);
    } else if (obj.originalRequest.length > MAX_REQUEST) {
      errors.push(`originalRequest: string exceeds ${MAX_REQUEST} chars`);
    }
  }
  for (const k of ["progress", "constraints", "artifacts", "remainingPlan"]) {
    strList(obj[k] ?? [], k, errors);
  }
  pairList(obj.decisions ?? [], "decisions", ["decision", "rationale"], errors);
  pairList(obj.rejected ?? [], "rejected", ["approach", "why"], errors);
  pairList(obj.evidence ?? [], "evidence", ["field", "ref"], errors);
  if (obj.unresolvedIssue !== undefined && obj.unresolvedIssue !== null) {
    str(obj.unresolvedIssue, "unresolvedIssue", errors);
  }

  if (errors.length) return { ok: false, errors };
  const value = {
    eventId: obj.eventId,
    agent: obj.agent,
    source: obj.source,
    objective: obj.objective,
    nextAction: obj.nextAction,
    originalRequest: obj.originalRequest ?? null,
    unresolvedIssue: obj.unresolvedIssue ?? null,
    progress: obj.progress ?? [],
    decisions: obj.decisions ?? [],
    rejected: obj.rejected ?? [],
    constraints: obj.constraints ?? [],
    artifacts: obj.artifacts ?? [],
    remainingPlan: obj.remainingPlan ?? [],
    evidence: obj.evidence ?? [],
    ...(obj.createdAt !== undefined ? { createdAt: obj.createdAt } : {}),
  };
  return { ok: true, value };
}
