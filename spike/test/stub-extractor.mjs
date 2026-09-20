// Stub extractor: appends its stdin to the file named by MIDA_STUB_OUT
// (prefixed by a ===CALL=== marker so tests can count invocations), then
// prints a valid checkpoint JSON object wrapped in a ```json fence plus prose.
// If stdin is empty (e.g. executed directly by the test runner) just exits.

import fs from "node:fs";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString("utf8");
  if (!input) process.exit(0);
  if (process.env.MIDA_STUB_OUT) {
    fs.appendFileSync(process.env.MIDA_STUB_OUT, "===CALL===\n" + input + "\n");
  }
  process.stdout.write(
    "Here is the extracted checkpoint.\n" +
      "```json\n" +
      JSON.stringify({
        objective: "Implement the TokenBucket rate limiter",
        progress: ["constructor and tryTake implemented"],
        decisions: [{ decision: "lazy refill on each call", rationale: "timers are banned" }],
        rejected: [{ approach: "background interval refill", why: "no-timers constraint" }],
        constraints: ["no dependencies", "synchronous API"],
        artifacts: ["src/bucket.mjs"],
        unresolvedIssue: null,
        nextAction: "add msUntilAvailable(n)",
        remainingPlan: ["4. KeyedLimiter with max keys + LRU eviction", "5. README usage section"],
        evidence: [{ field: "decisions[0]", ref: "transcript:L40-L52" }],
      }) +
      "\n```\nDone.\n",
  );
});
