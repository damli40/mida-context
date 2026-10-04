# Mida 0.1.3 on Windows, every step a gate (Oct 4, 2026)

**Question.** After the Windows port's three batches and their review fixes, does the 0.1.3 build work end to end on a clean Windows machine, including the hook entries `mida install` writes for each agent and Claude Desktop's tool server?

**Result.** Yes, for Mida's own side. On Windows Server 2025 (`Microsoft Windows NT 10.0.26100.0`) with Node 22.23.3, the 0.1.3 package built from the release branch and installed into a folder with a space in its path (`C:\mida test\npm`) passed every step:

| Step | Outcome |
|---|---|
| `mida init`, then a request for `claude-code` and for `codex` | Owner and identities registered on Monad testnet, gas sponsored; both requests created |
| `mida approve --all` (typed yes in a pseudo-terminal) | Both agents approved |
| `mida install claude-code`, `mida install codex`, `mida install claude-desktop` | All three exit 0; Claude Desktop's config file is written |
| `mida save-demo claude-code <project>` | Saved |
| Claude Code's session-start entry, run from `settings.json` with no shell | `Mida: handoff loaded — 1 checkpoint, 0 facts (from claude-code, 11 s ago)` |
| Codex's session-start line, run through Windows PowerShell (`powershell.exe -NoProfile -Command`), as Codex runs hooks | The same handoff, 15 s after the save |
| The same Codex line through PowerShell 7 (`pwsh`) | The same handoff, 19 s after the save |
| Codex's `config.toml` | Parses as TOML |
| Claude Desktop's tool server, started from its config | Answers `initialize` (`mida-mcp`) |
| Claude Code's Stop entry from `settings.json`, and `mida-hook` called directly | Each queues one save; the hook's own log records both as `enqueued` |
| `mida revoke codex`, then Codex's session start, both directly and through its own hook line | `Mida: codex has no access to this project (revoked by the owner)`; no checkpoint delivered |
| Who can read the owner's key file and the service's address file | Only the user, SYSTEM and Administrators |

From the start of `mida init` to the revoke taking effect: 2 minutes 54 seconds (05:18:41 to 05:21:35 UTC).

`mida doctor` printed 29 `ok` lines and 2 PROBLEM lines, both expected on this machine: the job never approves `claude-desktop`, and no model can write summaries because neither Claude Code nor Codex is installed.

**How.** A GitHub Actions job started by hand, `.github/workflows/windows-first-run.yml` on the public repo's `release-0.1.3` branch, on GitHub's `windows-latest` runner (image `windows-2025-vs2026`). Run: https://github.com/damli40/mida-context/actions/runs/37179046978, attempt 2, at commit `6f45a401`. The job builds the branch, packs the CLI (`mida-context-0.1.3.tgz`) and installs the tarball. It used the hosted store and the hosted gas sponsor. `approve`, `revoke` and the Claude Desktop install ask for a typed yes, so the job answers them with pywinpty. Each hook check reads the entry Mida wrote into that agent's own config and runs it the way the agent does. A step fails the job when its check fails; only `mida doctor` is logged without being a gate.

**Limits.**
- No Claude Code, Codex or Claude Desktop ran on that machine. The checks run the exact entries each agent would run, but not the agents themselves. A real agent on Windows has not been tried yet.
- Codex falls back to `cmd.exe` when it knows no session shell. Mida's PowerShell line does not run there: recorded in the run as `& was unexpected at this time.` (exit 1, not a gate).
- Claude Code runs the no-shell hook form from version 2.1.139; an older Claude Code ignores those hooks while `mida doctor` reports them installed.
- One run, one Windows version, one Node version.
- Attempt 1 of this run, and one attempt the night before, failed at approve: the public Monad testnet node rate-limited the gas sponsor through 3 retries, and approve reported `OWNER_WALLET_LOW` for the agent it could not grant. Running approve again is the recovery the product names; on testnet this will happen to users too.

**Earlier runs.** [`windows-first-run-2026-10-03.md`](windows-first-run-2026-10-03.md) covers the port's first batch, when the agent-config steps still failed.

**Raw data.** The folder `windows-first-run-2026-10-04/` holds every step's output (`init.txt`, `approve.txt`, the three install outputs, `doctor.txt`, `save.txt`, `handoff.txt`, `run-hook-*.txt` for each agent and shell, `mcp-hello.txt`, `revoke.txt`, both after-revoke handoffs, `check-acl.txt`, `exit-codes.txt`, `commit.txt`) and the hook's log lines in `hook.jsonl`, with terminal codes removed. The addresses and transaction ids are public testnet data from a throwaway owner.
