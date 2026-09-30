// envio ships no types for its internal config loader; data-source.test.ts needs one call.
declare module "envio/src/Core.res.mjs" {
  export function getConfigJson(configPath?: string, projectDir?: string): string
}
