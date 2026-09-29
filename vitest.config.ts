import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.{ts,mts}", "test-setup/**/*.test.ts"],
    // the home wall — every test file runs against a fresh temp home with refusing
    // claude/codex/devin stubs on PATH, never the real machine (in-28b)
    setupFiles: ["test-setup/isolate-home.ts"],
    testTimeout: 30_000,
  },
})
