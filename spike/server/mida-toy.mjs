// mida-toy: stdio MCP server exposing mida_checkpoint + mida_handoff.
// Uses the SDK's low-level Server so tool input schemas are plain JSON Schema
// (no zod import needed). Env: MIDA_SPIKE_STORE (required), MIDA_SPIKE_AGENT.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendCheckpoint, latestHandoff, logCall, renderHandoff } from "./store.mjs";

const AGENT = process.env.MIDA_SPIKE_AGENT || "unknown";

const text = (t, isError = false) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

const STR = { type: "string" };
const STR_LIST = { type: "array", items: STR };
const PAIR = (a, b) => ({
  type: "array",
  items: { type: "object", properties: { [a]: STR, [b]: STR }, required: [a, b] },
});

const TOOLS = [
  {
    name: "mida_checkpoint",
    description:
      "Save a compact checkpoint of the current task so a different AI agent can " +
      "continue it later. Call after each meaningful decision or completed step. " +
      "Never paste transcript text.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { ...STR, description: "Idempotency key, 8-128 chars" },
        objective: STR,
        originalRequest: {
          ...STR,
          description:
            "The user's original request for this task, word for word. " +
            "Include it on every checkpoint.",
        },
        progress: STR_LIST,
        decisions: PAIR("decision", "rationale"),
        rejected: PAIR("approach", "why"),
        constraints: STR_LIST,
        artifacts: STR_LIST,
        unresolvedIssue: { anyOf: [STR, { type: "null" }] },
        nextAction: STR,
        remainingPlan: STR_LIST,
        evidence: PAIR("field", "ref"),
      },
      required: ["eventId", "objective", "nextAction"],
    },
  },
  {
    name: "mida_handoff",
    description:
      "Fetch the latest saved task state from a previous AI agent session. " +
      "Call this first when asked to continue work you have no memory of.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "mida-toy", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "mida_checkpoint") {
      const res = appendCheckpoint({ ...args, agent: AGENT, source: "agent-tool" });
      const ok = res.stored || res.duplicate;
      logCall({ tool: name, agent: AGENT, ok });
      if (res.stored) return text(`Checkpoint stored (eventId ${args.eventId}).`);
      if (res.duplicate) return text(`Duplicate eventId ${args.eventId} — already stored, skipped.`);
      return text(`Checkpoint rejected — validation failed:\n${res.errors.join("\n")}`, true);
    }
    if (name === "mida_handoff") {
      const handoff = latestHandoff();
      logCall({ tool: name, agent: AGENT, ok: true });
      if (!handoff) return text("No Mida handoff exists for this workspace.");
      const body =
        renderHandoff(handoff.checkpoint, { originalRequest: handoff.originalRequest }) +
        `\n\nCheckpoints in store: ${handoff.history.count}\n\n` +
        JSON.stringify(handoff.checkpoint, null, 2);
      return text(body);
    }
    logCall({ tool: name, agent: AGENT, ok: false });
    return text(`Unknown tool: ${name}`, true);
  } catch (err) {
    try {
      logCall({ tool: name, agent: AGENT, ok: false });
    } catch {
      // store unusable — still answer the caller
    }
    return text(`mida error: ${err.message}`, true);
  }
});

await server.connect(new StdioServerTransport());
