// Unit tests for scripts/build-publish-lib.mjs — the path shape the publish scripts write into
// generated tsconfig files, and the platform command names. Pure functions: normal vitest pass.

import { describe, expect, it } from "vitest"
import { npmCommand, toConfigPath } from "./build-publish-lib.mjs"

describe("toConfigPath", () => {
  it("rewrites a Windows absolute path to forward slashes, glob tail included", () => {
    expect(toConfigPath("D:\\a\\mida-context\\packages\\mida-context-sdk\\src\\**\\*.ts")).toBe(
      "D:/a/mida-context/packages/mida-context-sdk/src/**/*.ts",
    )
  })

  it("leaves a POSIX path byte-identical", () => {
    expect(toConfigPath("/home/runner/work/pkg/src/**/*.ts")).toBe("/home/runner/work/pkg/src/**/*.ts")
  })
})

describe("npmCommand", () => {
  it("names the .cmd shim on Windows and the bare command elsewhere", () => {
    const suffix = process.platform === "win32" ? ".cmd" : ""
    expect(npmCommand("npm")).toBe(`npm${suffix}`)
    expect(npmCommand("npx")).toBe(`npx${suffix}`)
  })
})
