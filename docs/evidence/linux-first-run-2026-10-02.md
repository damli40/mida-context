# A first run of Mida on Linux (Oct 2, 2026)

**Question.** The README says "macOS or Linux". Every live run before this one was on a Mac. Does the published package work on a clean Linux machine at all?

**Result.** Yes, for Mida's own side. On Ubuntu 24.04 with Node 22.23.3, `mida-context` 0.1.2 installed from npm and:

| Step | Outcome |
|---|---|
| `mida init` | Registered an owner and three identities on Monad testnet, gas sponsored |
| `mida request claude-code`, `mida request codex` | Both requests created |
| `mida approve --all` (typed yes in a simulated terminal) | `approved: claude-code, codex` |
| `mida save-demo claude-code <project>` | Saved in 5.8 s |
| Codex's session-start hook (`mida-inject codex`) | `Mida: handoff loaded — 1 checkpoint, 0 facts (from claude-code, 4 s ago)` |
| `mida read --as codex projects.current` | 1 record, written by claude-code |
| `mida revoke codex`, then the hook again | `Mida: codex has no access to this project (revoked by the owner)`; no checkpoint delivered |
| File modes in `~/.mida` | Every file readable by the owner only, except the service's log (`logs/daemon.jsonl`, mode 644) |

From the start of `mida init` to the handoff: 59 seconds (14:26:44 to 14:27:43 UTC). The revoke took effect 16 seconds later.

`mida doctor` printed 26 `ok` lines and 3 PROBLEM lines, all expected on a machine with no agent: the Claude Code and Codex hooks are not installed, and no model can write summaries.

**How.** A GitHub Actions job started by hand, [`.github/workflows/linux-first-run.yml`](../../.github/workflows/linux-first-run.yml), on GitHub's `ubuntu-latest` runner. Run: https://github.com/damli40/mida-context/actions/runs/37019868946 (workflow at commit `545bd6c7`). It used the hosted store and the hosted gas sponsor on Monad testnet. `approve` and `revoke` refuse to run without a terminal, so the job gives them one with `expect` and types the answer.

**Limits.**
- No Claude Code or Codex ran on that machine. The agents' own hooks never fired and no model wrote a summary. The checkpoint is Mida's built-in demo one, and the handoff was asked for the way Codex's hook asks for it. This shows install, the background service, file permissions, the chain and store calls and the handoff path on Linux. It does not show a real agent-to-agent handoff on Linux.
- One run, one Linux distribution, one Node version.
- It says nothing about Windows or WSL (the Linux layer inside Windows), beyond this: if plain Ubuntu had failed, WSL would too.
- An earlier run of the same job (37008957817) was cancelled: the job's own script waited for the wrong prompt text and never typed "yes". Install and `mida init` had already succeeded in that run too.

**Status.** Shown once. The README's status table links here.

**Raw data.** The folder `linux-first-run-2026-10-02/` holds the output of every step (`init.txt`, `approve.txt`, `doctor.txt`, `save.txt`, `handoff.txt`, `revoke.txt`, `handoff-after-revoke.txt`, `read-as-codex.txt`, `files.txt`, `times.txt` and the rest), with terminal colour codes removed. The addresses and transaction ids in them are public testnet data from a throwaway owner.
