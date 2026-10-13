# README test-count verification — October 13, 2026

Verified against GitHub `main` commit [`9a03b0c2915e12c44e24e18170fbdaa22fcdf9d9`](https://github.com/damli40/mida-context/commit/9a03b0c2915e12c44e24e18170fbdaa22fcdf9d9), before this documentation-only correction.

| Result | Count |
|---|---:|
| Passed | 4,019 |
| Failed | 0 |
| Skipped | 1 |
| Total | 4,020 |
| Test files | 232 |

The full Vitest run exited successfully. The previous README badge said **3,998 passing**; the verified passing count is **4,019**. The separately collected list contained 4,019 selected tests; the completed run also reported one skipped test.

## Reproduction

A clean checkout of the current GitHub source, including all recursive contract submodules, was used. Dependencies were installed from the frozen lockfile, and contracts were built before running the suite. Environment: macOS arm64, Node.js 25.8.1, pnpm 12.4.1, Vitest 4.1.11, Foundry 1.8.1.

```bash
git clone --recurse-submodules https://github.com/damli40/mida-context.git
cd mida-context
git checkout 9a03b0c2915e12c44e24e18170fbdaa22fcdf9d9
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
(cd contracts && "$HOME/.foundry/bin/forge" build)
FOUNDRY_BIN="$HOME/.foundry/bin" pnpm exec vitest run --reporter=json --outputFile=test-results.json
```

`pnpm test` invokes the same `vitest run` suite. The JSON reporter was used to verify counts, and its assertion results independently total 4,019 passed and one skipped. Runtime was approximately 37 minutes 29 seconds. This count covers the Vitest suite, including its local-chain integration tests; the separate `forge test` suite is not included.

## Skipped test

- `apps/midad/test/mcp.test.ts` — mida-mcp startup gate the launcher picks the newest nvm node when PATH and the usual spots have none (F9).

## Setup correction

An initial attempt used a source archive without contract submodules. It was interrupted after dependency-related failures and is not the basis for the badge. The successful run above used the complete checkout with its pinned submodules. No application code was changed.
