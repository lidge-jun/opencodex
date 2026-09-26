/**
 * The capture-only MCP catalog, served from this process.
 *
 * This is the tool channel of the Agent SDK row and the reason it needs no second executable: the
 * SDK registers an in-process MCP server with the harness over its control channel, so the client's
 * catalog reaches the model without a temp module, a `--mcp-config` path or an argv entry. The
 * server advertises the request's own schemas and NEVER answers a call — a `tools/call` handler that
 * never settles is the capture: the runner reads the `tool_use` blocks off the stream, terminates the
 * turn, and hands the call to the client, where approval and execution stay.
 *
 * The catalog validation, the name aliasing and the `mcp__<server>__<tool>` mapping are the ones the
 * CodeBuddy bridge already owns for the same CLI protocol, so this module reuses that builder
 * instead of growing a second interpretation of the same limits.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OcxParsedRequest } from "../../types";
import {
  CODEBUDDY_MCP_SERVER_NAME,
  CODEBUDDY_TOOL_LIMITS,
  buildCodeBuddyToolBridge,
  type CodeBuddyMcpToolDefinition,
} from "../codebuddy/tool-bridge";

/** Server name the catalog is advertised under; part of every rendered tool name. */
export const CLAUDE_AGENT_SDK_MCP_SERVER_NAME = CODEBUDDY_MCP_SERVER_NAME;

export interface ClaudeAgentSdkToolBridge {
  serverName: string;
  tools: CodeBuddyMcpToolDefinition[];
  /** Rendered `mcp__<server>__<tool>` name -> the request's wire tool name. */
  emittedNameMap: Map<string, string>;
  /** Captured tool_use blocks accepted in one assistant message. */
  maxTurnToolCalls: number;
  requireToolCall: boolean;
  instance: McpServer;
}

/**
 * Build the in-process capture server for a request that carries a tool catalog.
 *
 * Returns undefined for a request with no tools, which makes the turn a plain text/reasoning pass,
 * and throws for a catalog the shared builder rejects (the caller reports that as a 400).
 *
 * The MCP SDK is imported here rather than at module scope: it is a real dependency of the proxy,
 * but only a turn that actually carries a catalog should pay for loading it.
 */
export async function buildClaudeAgentSdkToolBridge(
  parsed: OcxParsedRequest,
): Promise<ClaudeAgentSdkToolBridge | undefined> {
  const catalog = buildCodeBuddyToolBridge(parsed);
  if (catalog.tools.length === 0) return undefined;

  const { McpServer: McpServerClass } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  // The tools capability has to be declared up front: the low-level server asserts it when a
  // `tools/list` handler is registered, and the high-level wrapper only declares it for tools it
  // registered itself — this catalog is served straight from the request's schemas instead, so the
  // advertised `inputSchema` is the client's own JSON Schema, byte for byte.
  const instance = new McpServerClass(
    { name: CODEBUDDY_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.tools }));
  instance.server.setRequestHandler(CallToolRequestSchema, async () => {
    // Capture-only: the call is read off the stream by the runner, and an answer here would mean
    // this process executed a tool the client is supposed to execute.
    return await new Promise<never>(() => undefined);
  });

  return {
    serverName: CLAUDE_AGENT_SDK_MCP_SERVER_NAME,
    tools: catalog.tools,
    emittedNameMap: catalog.emittedNameMap,
    maxTurnToolCalls: CODEBUDDY_TOOL_LIMITS.maxTurnToolCalls,
    requireToolCall: catalog.requireToolCall,
    instance,
  };
}
