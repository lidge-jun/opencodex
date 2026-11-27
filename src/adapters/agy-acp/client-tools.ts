import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { buildCodeBuddyToolBridge, CODEBUDDY_MCP_TOOL_PREFIX, CODEBUDDY_MCP_SERVER_NAME } from "../codebuddy/tool-bridge";
import { codeBuddyMcpInvocation } from "../coding-agent/turn";

// Adapt the capture-only MCP transport from OpenCodex PR 8776. The client
// executes the resulting structured call with its regular sandbox and approvals.
export async function stageClientTools(parsed: OcxParsedRequest, tmp: string) {
  const bridge = buildCodeBuddyToolBridge(parsed);
  const names = new Map(bridge.tools.map(tool => [
    `mcp_${CODEBUDDY_MCP_SERVER_NAME}_${tool.name}`,
    { wire: bridge.emittedNameMap.get(CODEBUDDY_MCP_TOOL_PREFIX + tool.name)!, schema: tool.inputSchema },
  ]));
  const servers = [];
  if (names.size) {
    const catalog = join(tmp, "client-tools.json");
    await writeFile(catalog, JSON.stringify(bridge.tools), { mode: 0o600, flag: "wx" });
    const helper = fileURLToPath(new URL("../codebuddy/mcp-server.ts", import.meta.url));
    servers.push({ name: CODEBUDDY_MCP_SERVER_NAME, command: process.execPath, args: codeBuddyMcpInvocation(helper, catalog), env: [] });
  }
  function capture(raw: unknown): { id: string; events: AdapterEvent[] } | undefined {
    if (!raw || typeof raw !== "object") return;
    const call = raw as Record<string, unknown>;
    if (typeof call.name !== "string" || typeof call.toolCallId !== "string") return;
    if (call.status === "failed" || call.status === "cancelled") return;
    const tool = names.get(call.name);
    const input = call.rawInput ?? call.args;
    if (!tool || !input || typeof input !== "object" || Array.isArray(input)) return;
    const args = { ...input } as Record<string, unknown>;
    const props = tool.schema.properties;
    if (!(props && typeof props === "object" && Object.hasOwn(props, "toolSummary"))) delete args.toolSummary;
    // Each ACP session may number calls starting at one. Responses ids must be unique across sessions.
    return { id: call.toolCallId, events: [
      { type: "tool_call_start", id: "call_" + randomUUID(), name: tool.wire },
      { type: "tool_call_delta", arguments: JSON.stringify(args) },
      { type: "tool_call_end" },
    ] };
  }
  const instruction = names.size ? [
    'The user is working in the Codex App project. Use the tools of the "opencodex" MCP server for work on that project. Your own temporary directory is separate.',
    'Use one client tool at a time. Its result will appear in the conversation history. Continue from actual results; report command output and changes you have verified.',
    'This is a replay of the same App conversation. Apply the latest user request to the preceding proposal. A clear go-ahead authorizes that proposal within its scope; preserve host approvals and sandbox limits.',
    'Tool calls and results are execution records. Use the actual outputs and exit codes. When the requested work and checks are complete, return the result and end the turn. Repeat a check only if something changed or the result left a specific question unanswered.',
    'The following pairs map client tool names to their callable MCP names:',
    JSON.stringify(Array.from(names, ([alias, tool]) => [tool.wire, alias])),
  ].join("\n") : "";
  return { servers, instruction, required: bridge.requireToolCall, capture };
}
