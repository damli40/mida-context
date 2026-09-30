/**
 * The MCP clients — each connects over mida-mcp with its own identity, never a hook. A leaf module
 * with no imports, so the key-free MCP adapter (mcp.ts) can read the same list install.ts and
 * mcp-save.ts use: the save tool is offered to exactly the agents the save route signs for.
 */
export const MCP_CLIENT_TOOLS: readonly string[] = ["claude-desktop", "cursor"]
