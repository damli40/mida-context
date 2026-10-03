// Pure helpers for the publish scripts — no I/O, so they can be unit-tested without running a
// build. Plain .mjs on purpose: scripts/build-publish.mjs and scripts/clean-install-check.mjs
// run under `node` directly, not tsx. scripts/build-publish-lib.d.mts carries the types.

/**
 * A path safe to write into a generated config or glob. TypeScript reads tsconfig values and
 * `include` globs as POSIX-shaped, so a Windows path like `D:\a\pkg\src\**\*.ts` keeps its
 * backslashes as literal characters and never matches a file — the declaration step finds no
 * inputs and dies with TS18003. Every `\` becomes `/`.
 */
export function toConfigPath(path) {
  return path.replaceAll("\\", "/")
}

/**
 * The spawnable name for an npm-family command on this platform. On Windows npm and npx exist
 * only as .cmd shims — there is no npm.exe — so a bare "npm" fails ENOENT; Node runs the .cmd
 * through cmd.exe with its arguments escaped.
 */
export function npmCommand(name) {
  return process.platform === "win32" ? `${name}.cmd` : name
}
