# Mida in the Claude Code desktop app (Oct 4, 2026)

**Question.** The Claude Code desktop app runs Claude Code inside the Claude desktop app. Its docs do not say whether it runs the hooks a user set up in `~/.claude/settings.json`. Does Mida work there with no extra setup?

**Result.** Yes, in one session. The owner opened a session in the Claude Code desktop app (Claude Code 2.1.286, macOS) in a folder where Mida was already set up with `mida install claude-code`. Nothing was changed for the desktop app.

| What | Outcome |
|---|---|
| Session start | Mida's handoff was delivered: the session's transcript holds the `MIDA HANDOFF` block |
| Each prompt | Mida's update note was delivered |
| Saves | 4 hook events were queued (3 at the end of a reply, 1 after a tool call), and Mida's service logged 4 saves for the session, the last 63 seconds after the session's final reply |
| Mida's tools | `mida_handoff`, `mida_read`, `mida_status` and `mida_whats_new` were offered to the session; it did not call them |

The session ran from 04:10:27 to 04:12:39 UTC. The saves landed at 04:11:12, 04:12:16, 04:13:01 and 04:13:42 UTC.

**How.** Claude read the session's transcript, which Claude Code marks as started from the desktop app (`"entrypoint": "claude-desktop"`; a terminal session says `"cli"`), for the hook records. Claude then read Mida's own logs (`hook.jsonl` and `drain.jsonl`) for the same session.

**Limits.**
- One session, one Mac, one Claude Code version.
- The tools were offered but not called, so a read in the middle of a session is not shown.
- The desktop app on Windows was not tried.
- This is the Claude Code desktop app. The Claude Desktop chat app is a different client: it reaches Mida through the MCP server only, with no hooks (README, "Supported agents").

**Raw data.** [`claude-code-desktop-app-2026-10-04.json`](claude-code-desktop-app-2026-10-04.json): timestamps and outcomes only, no session text.
