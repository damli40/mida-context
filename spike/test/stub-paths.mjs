// Stub extractor for H4: emits artifacts and file: evidence refs built from
// MIDA_STUB_CWD and the user's home dir, so the worker's path rewriting can
// be checked end to end. If stdin is empty just exits.

import os from "node:os";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  if (!Buffer.concat(chunks).length) process.exit(0);
  const cwd = process.env.MIDA_STUB_CWD || "/nonexistent";
  const home = os.homedir();
  process.stdout.write(
    "```json\n" +
      JSON.stringify({
        objective: "do the steps",
        progress: ["step 1 done"],
        decisions: [],
        rejected: [],
        constraints: [],
        artifacts: [`${cwd}/src/a.mjs`, "src/b.mjs", `${home}/other/c.txt`],
        unresolvedIssue: null,
        nextAction: "keep going",
        evidence: [
          { field: "artifacts[0]", ref: `file:${cwd}/src/a.mjs` },
          { field: "objective", ref: "transcript:L2" },
        ],
      }) +
      "\n```\n",
  );
});
