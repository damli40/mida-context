# The published 0.1.3 on a clean Linux machine (Oct 4, 2026)

**Question.** Does `mida-context` 0.1.3, as published to npm, install and work end to end on a clean Linux machine, as 0.1.2 did on Oct 2?

**Result.** Yes, for Mida's own side. On Ubuntu 24.04 with Node 22.23.3, `npm install -g mida-context@0.1.3` and then:

| Step | Outcome |
|---|---|
| `mida init` | Owner and three identities registered on Monad testnet, gas sponsored |
| `mida request claude-code`, `mida request codex`, `mida approve --all` (typed yes in a simulated terminal) | `approved: claude-code, codex` |
| `mida save-demo claude-code <project>` | Saved |
| Codex's session-start hook (`mida-inject codex`) | `Mida: handoff loaded — 1 checkpoint, 0 facts (from claude-code, 5 s ago)` |
| `mida read --as codex projects.current` | 1 record, written by claude-code |
| `mida revoke codex`, then the hook again | `Mida: codex has no access to this project (revoked by the owner)`; no checkpoint delivered |
| File modes in `~/.mida` | Every file readable by the owner only, except the service's log (`logs/daemon.jsonl`, mode 644), as on Oct 2 |

From the start of `mida init` to the handoff: 88 seconds (15:33:42 to 15:35:10 UTC). The revoke took effect 22 seconds later.

`mida doctor` printed 26 `ok` lines and 3 PROBLEM lines, all expected on a machine with no agent: the Claude Code and Codex hooks are not installed, and no model can write summaries.

**How.** The same job as Oct 2, [`.github/workflows/linux-first-run.yml`](../../.github/workflows/linux-first-run.yml), started by hand with `version` = `0.1.3`, on GitHub's `ubuntu-latest` runner. Run: https://github.com/damli40/mida-context/actions/runs/37213441676. It installs the package from npm, so it tests what a user gets, not the repo. It used the hosted store and the hosted gas sponsor.

**Limits.**
- No Claude Code or Codex ran on that machine. This shows install, the background service, file permissions, the chain and store calls and the handoff path on Linux, not a real agent-to-agent handoff.
- One run, one Linux distribution, one Node version.

**Earlier run.** [`linux-first-run-2026-10-02.md`](linux-first-run-2026-10-02.md): the same steps on 0.1.2 took 59 seconds from init to handoff. Each figure is one run on a shared public testnet, so the two cannot show whether 0.1.3 is slower.

**Raw data.** The folder `linux-npm-0.1.3-2026-10-04/` holds the output of every step, with terminal colour codes removed. The addresses and transaction ids in them are public testnet data from a throwaway owner.
