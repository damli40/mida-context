/**
 * The MCP clients — each connects over mida-mcp with its own identity, never a hook. A leaf module
 * with no imports, so the key-free MCP adapter (mcp.ts) can read the same list install.ts and
 * mcp-save.ts use: the save tool is offered to exactly the agents the save route signs for.
 */
export const MCP_CLIENT_TOOLS: readonly string[] = ["claude-desktop", "cursor"]

/**
 * The hook clients — they save only through their Mida hooks, never through mida_save. The same
 * names as install.ts's HOOK_COMMAND keys (mcp-save.test.ts pins that); kept here so the key-free
 * adapter can tell a hook client from an identity with no save path at all.
 */
export const HOOK_CLIENTS: readonly string[] = ["claude-code", "codex", "devin"]
