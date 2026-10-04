# A first end-to-end run of Mida on Windows, built from the Windows branch (Oct 3, 2026)

**Question.** Mida 0.1.2 does not start on Windows: `mida init` fails before it registers anything. The first batch of the native Windows port replaces the parts that assume a Mac or Linux machine (how files are saved safely, how commands reach the background service, how it starts and stops processes). Does Mida's own path now work end to end on a clean Windows machine?

**Result.** Yes, for Mida's own side. On Windows Server 2025 (`Microsoft Windows NT 10.0.26100.0`) with Node 22.23.3, the branch's build, installed into a folder with a space in its path (`C:\mida test\npm`), passed every gated step:

| Step | Outcome |
|---|---|
| `mida init` | Registered an owner and three identities on Monad testnet, gas sponsored |
| `mida request claude-code`, `mida request codex` | Both requests created |
| `mida approve --all` (typed yes in a pseudo-terminal) | `approved: claude-code, codex` |
| `mida save-demo claude-code <project>` | Saved in 6.2 s |
| Codex's session-start hook (`mida-inject codex`) | `Mida: handoff loaded — 1 checkpoint, 0 facts (from claude-code, 6 s ago)` |
| Claude Code's Stop hook (`mida-hook claude-code`) | Exit 0; the hook's own log records the job as queued (`outcome: "enqueued"`) |
| `mida revoke codex`, then Codex's hook again | `Mida: codex has no access to this project (revoked by the owner)`; no checkpoint delivered |
| Who can read the owner's key file and the service's address file | Only the user, SYSTEM and Administrators |

From the start of `mida init` to the handoff: 1 minute 42 seconds (19:50:51 to 19:52:33 UTC), including both requests, the approve and the three install attempts below.

`mida doctor` printed 29 `ok` lines and 1 PROBLEM line, expected on a machine with no agent: no model can write summaries.

**What does not work yet (recorded, not gated).** These depend on the second batch of the port, which is not built. Each ran and its exit code was logged:

| Step | Exit | What happened |
|---|---|---|
| `mida install codex` | 0, but | It writes Codex's config with Windows paths that are not valid TOML (`config.toml`, line 12). Codex would likely refuse to start, not just skip Mida |
| `mida install claude-code` | 0, but | The hook entry it writes is a quoted path plus an argument, which Claude Code on Windows cannot run without a shell |
| `mida install claude-desktop` | 2 | Asks for a terminal; the job did not answer it |
| Session-start hooks run the way each agent runs them | 1 and 1 | Follow from the two broken configs above |
| The Codex config parses as TOML | 1 | See the first row |
| The Claude Desktop tool server answers | 1 | No config was written |
| The Stop hook run the way `settings.json` runs it | 1 | PowerShell: the quoted path plus argument "is not recognized as a name of a cmdlet, function, script file, or executable program" |

So on Windows today, do not point Codex at Mida: its config would be broken.

**How.** A GitHub Actions job started by hand, `.github/workflows/windows-first-run.yml` on the public repo's `windows-native` branch, on GitHub's `windows-latest` runner (image `windows-2025-vs2026`). Run: https://github.com/damli40/mida-context/actions/runs/37148916993, attempt 2, at commit `43862195` (the port's first batch plus the CI job). The job checks out the branch, builds it, packs the CLI and installs the tarball. It used the hosted store and the hosted gas sponsor on Monad testnet. `approve` and `revoke` refuse to run without a terminal, so the job gives them one with pywinpty and types `yes`. The Codex handoff and the Stop hook are called with the same input each agent's hook sends, but directly rather than through the agent.

The revoke step passes only if the next handoff names the revoke as the reason, so a dead service (which also delivers nothing and exits 0) cannot pass it. The hook step passes only if the hook's own log records a queued job for that step's session, and the job was not moved aside as malformed.

**Limits.**
- No Claude Code or Codex ran on that machine. This shows install, the background service, file permissions, the chain and store calls, the hook path and the handoff on Windows. It does not show a real agent-to-agent handoff on Windows.
- One run, one Windows version, one Node version.
- Never exercised on real Windows, only unit-tested on a Mac posing as Windows: a mismatched service token being refused, a leftover service address after a crash, two services starting at once, stopping a summary run's process tree, colon-free names when moving a home, the process check on a real lock, the MCP server and the SDK's local connection.
- The tarball is named `mida-context-0.1.2.tgz` because the branch has not had its version bumped. The code is the branch's, not the published 0.1.2.
- The Windows console under pywinpty shows "�" in place of the em dash in some lines. Not checked in a real Windows Terminal.

**Earlier attempts.** Attempt 1 of the same run failed at approve: the gas sponsor could not send either grant because the public Monad testnet node stayed rate-limited through 3 retries, and approve reported `OWNER_WALLET_LOW` for both agents. Nothing was granted. Run 37146438746 (commit `57c93089`) passed the same steps an hour earlier, with weaker checks for revoke and the hook, which this run's checks replace. Before that, three runs went to fixing the job itself: one tested the published 0.1.2 instead of the branch, one hit a build script that wrote Windows paths TypeScript could not read, and one installed the CLI without its dependencies.

**Status.** Shown once. The port's second batch will turn the recorded steps into gates.

**Raw data.** The folder `windows-first-run-2026-10-03/` holds the output of every step (`init.txt`, `approve.txt`, `doctor.txt`, `save.txt`, `handoff.txt`, `revoke.txt`, `handoff-after-revoke.txt`, `check-acl.txt`, the install and record-only outputs, `exit-codes.txt`, `commit.txt` and the hook's log line in `hook.jsonl`), with terminal codes removed. The addresses and transaction ids in them are public testnet data from a throwaway owner.
