#!/usr/bin/env node
// kimi-model.mjs — kept for anything that spawns it by name (R5-8/M3-D5). The real
// implementation is openai-compatible-model.mjs; this shim execs it with provider "kimi".
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./openai-compatible-model.mjs", import.meta.url)), "kimi"],
  { stdio: "inherit" },
)
child.on("error", () => process.exit(1))
child.on("exit", (code) => process.exit(code ?? 1))
