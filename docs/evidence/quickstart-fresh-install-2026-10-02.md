# The README quickstart, run as a new user (Oct 2, 2026)

**Question.** Can someone who has never used Mida follow the README from `npm install -g mida-context` to a second agent that continues the first one's work? How long does it take, and where does the README mislead?

**Result.** Not as the README was written that morning. The handoff itself worked; two things got in the way, one of them a real product bug.

| | |
|---|---|
| Time from the first command to the second agent's answer | 33 min 25 s. About 14 minutes of that was the tester's own tooling trouble; 8 min 35 s was waiting for the first save, which needed three tries |
| Commands | The README's path is 9 commands and 2 agent sessions. The run needed 12 commands (3 retries after network timeouts) and 3 agent sessions |
| Did the second agent receive the first one's context? | Yes: a block starting `MIDA HANDOFF` with the two decisions, the rule and the original request ([the text](quickstart-fresh-install-2026-10-02/27-handoff-text-seen-by-second-codex.txt)) |
| Did "Continue." continue? | No. The first request ended "do step 1 only, then stop", the checkpoint carried "stop" as the next action, and the second agent answered "Stopped as requested". "Continue with step 2." then did step 2 correctly, in plain JavaScript with the JSON file, as decided |

**Product bugs found.**

1. **An approval that the tool reports as failed can be on chain, and then cannot be repaired** ([output](quickstart-fresh-install-2026-10-02/10-approve-all.txt)). During `mida approve --all` the gas sponsor's reply timed out for one agent. Mida printed `failed: claude-code (OWNER_WALLET_LOW)`. The grant had in fact landed. From then on `mida approve claude-code` said "already approved on chain", `mida doctor` said `ok: claude-code approved`, and every read by that agent was refused (`CAPABILITY_DENIED`). Not fixed in 0.1.2, the version tested. A fix is being built for 0.1.3: running approve again will finish the approval.
2. `mida summarizer` showed Claude Code as "ready, not used yet, 0 failed tries" while Claude failed every summary and Codex wrote them all.
3. One slow chain check failed the whole of `mida doctor` once (18 PROBLEM lines); the next run was clean.
4. While a save was waiting, doctor told a sponsored user to top up four wallets.
5. A network timeout printed a raw library error with no "run it again".
6. `mida --version` does not exist.

**README problems found.** Fifteen, three of which would stop or mislead a new user: nothing said a save takes about a minute before the second agent can be opened; nothing said "Continue." can stall when the last request told the first agent to stop; and "installed" should have read "installed and logged in". All fifteen were corrected in the README the same day.

**How.** A separate agent followed the README line by line with `mida-context` 0.1.2 installed from npm into a throwaway home folder, with every model key removed from the environment, on the live Monad testnet with the hosted store and the hosted gas sponsor. Commands that need a terminal were given a simulated one. It did not edit the README; it reported.

**Limits.**
- Claude Code would not run in the throwaway home ("Not logged in"), so Codex played both the first and the second agent. The Claude Code to Codex path was not exercised here. Bug 1 would have blocked it anyway.
- Codex's hook-trust screen (`/hooks`) is interactive and was bypassed with a flag that is safe only in a throwaway home.
- The first agent wrote its two decisions into `plan.md`, so the second agent respecting them is not proof that Mida carried them. The proof that the handoff arrived is its text and the reply "Stopped as requested", an instruction that is in no project file.
- One run, one machine (macOS), one network day with three timeouts in fifteen minutes.
- The tester ran an older `mida` command four times by mistake at the start (a shell alias on the machine). Those steps were thrown away and redone; the logs kept here are from the redone steps.

**Status.** Shown once, on 0.1.2. All six bugs are open in 0.1.2; a fix for bug 1 is in progress.

**Raw data.** The folder `quickstart-fresh-install-2026-10-02/` holds the output of eighteen steps, with terminal colour codes and local folder paths removed. The addresses and transaction ids are public testnet data from a throwaway owner.
