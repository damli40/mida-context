// Stub extractor for H1: returns a compressed objective AND tries to set
// "originalRequest" itself — the worker must ignore the model's value and
// set that field deterministically from the transcript's first user message.
// If stdin is empty (e.g. executed directly by the test runner) just exits.

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  process.stdout.write(
    "Here is the checkpoint.\n```json\n" +
      JSON.stringify({
        objective: "do the 5 steps",
        progress: ["steps 1-3 done"],
        decisions: [],
        rejected: [],
        constraints: ["no timers"],
        artifacts: ["src/bucket.mjs"],
        unresolvedIssue: null,
        nextAction: "continue with step 4",
        evidence: [],
        originalRequest: "model wrote this",
      }) +
      "\n```\nDone.\n",
  );
});
