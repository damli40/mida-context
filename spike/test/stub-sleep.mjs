// Stub extractor that sleeps MIDA_STUB_SLEEP_MS (default 3000) before
// printing a valid fenced checkpoint — proves the capture hook returns
// immediately while the detached worker absorbs the slow extractor call.

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  const ms = Number(process.env.MIDA_STUB_SLEEP_MS) || 3000;
  setTimeout(() => {
    process.stdout.write(
      "```json\n" +
        JSON.stringify({
          objective: "Implement the TokenBucket rate limiter",
          progress: ["slow extractor ran"],
          decisions: [],
          rejected: [],
          constraints: ["no dependencies"],
          artifacts: ["src/bucket.mjs"],
          unresolvedIssue: null,
          nextAction: "add msUntilAvailable(n)",
          evidence: [],
        }) +
        "\n```\n",
    );
  }, ms);
});
