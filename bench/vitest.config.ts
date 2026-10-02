import { defineConfig } from "vitest/config"

// The root vitest config covers packages/*/test and apps/*/test only; bench
// tests live under bench/test and are run from this directory:
//   cd bench && pnpm exec vitest run test/<file>.test.ts
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
})
