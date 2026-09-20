// Fake Agent A for harness tests: prints the NAMES of its environment
// variables (never values) as one JSON array line on stdout — which lands
// in a-output.jsonl — then one assistant-type stream-json line so the run
// counts as having produced output.

process.stdout.write(JSON.stringify(Object.keys(process.env).sort()) + "\n");
process.stdout.write(
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "fake turn" }] },
  }) + "\n",
);
