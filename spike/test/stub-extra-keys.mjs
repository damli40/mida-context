// Stub extractor: like stub-extractor.mjs but the printed JSON object
// carries two fields the schema does not know ("notes", "confidence").
// F3: the capture path must store the checkpoint anyway and log the
// dropped key names — one extra field must not discard the whole save.

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  process.stdout.write(
    "Extracted:\n```json\n" +
      JSON.stringify({
        objective: "Implement the TokenBucket rate limiter",
        progress: ["constructor and tryTake implemented"],
        decisions: [{ decision: "lazy refill on each call", rationale: "timers are banned" }],
        rejected: [],
        constraints: ["no dependencies"],
        artifacts: ["src/bucket.mjs"],
        unresolvedIssue: null,
        nextAction: "add msUntilAvailable(n)",
        evidence: [],
        notes: "x",
        confidence: 0.9,
      }) +
      "\n```\n",
  );
});
