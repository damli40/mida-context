// Stub extractor: records the NAMES of the env vars it was spawned with
// (never values) to MIDA_STUB_OUT, then prints a valid fenced checkpoint —
// proves the worker strips ANTHROPIC_* before spawning the extractor.

import fs from "node:fs";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  if (process.env.MIDA_STUB_OUT) {
    fs.appendFileSync(
      process.env.MIDA_STUB_OUT,
      "===CALL===\n" + JSON.stringify(Object.keys(process.env).sort()) + "\n",
    );
  }
  process.stdout.write(
    "```json\n" +
      JSON.stringify({
        objective: "env probe",
        progress: [],
        decisions: [],
        rejected: [],
        constraints: [],
        artifacts: [],
        unresolvedIssue: null,
        nextAction: "nothing",
        evidence: [],
      }) +
      "\n```\n",
  );
});
