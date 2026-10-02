/**
 * Mida's mark (UF-P2c). Printed at the start of `mida init` and of the help
 * output — nowhere else. The graphical banner needs a UTF-8 terminal; without
 * one the plain line stands in, and without a terminal at all nothing prints.
 */

export const BANNER: readonly string[] = [
  "  ╭     ╮",
  "  │  ●  │   mida",
  "  ╰     ╯   your context, in a store you own",
  "",
]
export const BANNER_PLAIN: readonly string[] = ["mida: your context, in a store you own", ""]

/**
 * Which banner to print: nothing when stdout is not a TTY; BANNER when the
 * first non-empty of LC_ALL, LC_CTYPE, LANG matches /utf-?8/i; BANNER_PLAIN
 * otherwise.
 */
export function bannerLines(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): readonly string[] {
  if (!stdoutIsTTY) return []
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value !== undefined && value !== "")
  return locale !== undefined && /utf-?8/i.test(locale) ? BANNER : BANNER_PLAIN
}
