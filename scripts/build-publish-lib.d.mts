// Types for build-publish-lib.mjs — a plain-JS module the .mts tests and typecheck must see.

/** Rewrites every `\` in `path` to `/` — the shape tsconfig values and globs need on Windows. */
export declare function toConfigPath(path: string): string

/** `npm`/`npx` on POSIX, `npm.cmd`/`npx.cmd` on Windows, where only the shims exist. */
export declare function npmCommand(name: string): string
