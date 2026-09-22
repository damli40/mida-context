import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The six shipped entry points: the bin name the npm package exposes → the TypeScript source
 * file in this folder that builds it. One table is the whole mapping; a spawn site never names
 * a path itself.
 */
const ENTRIES = {
  "mida": "cli.ts",
  "midad": "daemon-main.ts",
  "mida-drain": "drain-main.ts",
  "mida-hook": "hook-main.ts",
  "mida-inject": "inject-main.ts",
  "mida-mcp": "mcp-main.ts",
} as const

export type SiblingEntry = keyof typeof ENTRIES

/**
 * True when this module is running from a built bundle (the dist output under publish) instead
 * of the TypeScript source tree. tsx and vitest both keep the .ts specifier in import.meta.url;
 * the esbuild output ends in .js. This is the ONE place the source-vs-bundle decision is made —
 * every spawn site, and the doctor fix text, defers to it.
 */
export function isBundled(): boolean {
  return !import.meta.url.endsWith(".ts")
}

/**
 * The argument list that re-runs a sibling entry under plain `node` — `spawn(process.execPath,
 * siblingEntryArgs("midad"))`. Bundled, that is the built .js file sitting next to this one in
 * dist/. From source, it is the .ts file through the repo's tsx loader, both by absolute path:
 * the child's working directory is the Mida home, so a bare `--import tsx` (which resolves
 * against the working directory) would not find the loader.
 */
export function siblingEntryArgs(name: SiblingEntry): string[] {
  if (isBundled()) {
    return [fileURLToPath(new URL(`./${name}.js`, import.meta.url))]
  }
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url))
  const source = fileURLToPath(new URL(`./${ENTRIES[name]}`, import.meta.url))
  return ["--import", loader, source]
}

/**
 * The file an entry runs from — `dist/<name>.js` bundled, the `.ts` source from the repo. This
 * is the path `mida install` writes into hook settings (R5-7): a hook spawned by Claude Code or
 * Codex gets a bare shell with no guarantee Mida's bin is on PATH, so the command must name the
 * file absolutely. Doctor stats this same path rather than searching PATH.
 */
export function siblingEntryPath(name: SiblingEntry): string {
  return fileURLToPath(new URL(isBundled() ? `./${name}.js` : `./${ENTRIES[name]}`, import.meta.url))
}

/**
 * The npm package's own name, read from the package.json one level above the bundled dist file —
 * doctor's PATH fix prints `npm i -g <name>` without hard-coding the name anywhere but
 * publish/names.json. Undefined when the file cannot be read (and in the source tree, where the
 * caller uses the repo's own launcher advice instead).
 */
export function cliPackageName(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { name?: unknown }
    return typeof raw.name === "string" && raw.name !== "" ? raw.name : undefined
  } catch {
    return undefined
  }
}
