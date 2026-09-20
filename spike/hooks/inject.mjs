// inject.mjs — SessionStart-style hook that prints the latest handoff so it
// lands in the continuing agent's context. FAILS OPEN: always exits 0; prints
// nothing when there is no handoff.

import { latestHandoff, renderHandoff } from "../server/store.mjs";
import { readStdinJson, logHookEvent, logError } from "./lib.mjs";

const CLOSING =
  "This is the saved state of the task in this workspace from a previous AI " +
  "session. If the user asks you to continue, continue from here.";

async function main() {
  const input = await readStdinJson();
  logHookEvent(input.hook_event_name ?? null, input.session_id ?? null, { hook: "inject" });

  const handoff = latestHandoff();
  if (!handoff) return;

  process.stdout.write(
    renderHandoff(handoff.checkpoint, { originalRequest: handoff.originalRequest }) +
      "\n\n" +
      CLOSING +
      "\n",
  );
}

main()
  .catch((err) => logError("inject.main", err))
  .finally(() => process.exit(0));
