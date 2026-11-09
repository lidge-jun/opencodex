import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CodingAgentMcpTool } from "../coding-agent/mcp-server";
import { MuseMspError } from "./connection";

export interface MuseCapturedCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * MCP endpoint which advertises a fixed catalog and delegates calls to the owner.
 * It does not execute tools. The owner must authenticate and correlate calls to
 * an admitted MSP approval before returning a client-supplied result.
 * Transport, process lifetime, cancellation, and callback isolation are caller-owned.
 */
export function createMuseCaptureServer(
  catalog: readonly CodingAgentMcpTool[],
  onCall: (call: MuseCapturedCall, signal: AbortSignal) => Promise<string>,
): Server {
  if (catalog.length > 128) throw new MuseMspError("invalid_capture_catalog");
  const names = new Set<string>();
  const tools = catalog.map(tool => {
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
        names.has(tool.name) || typeof tool.description !== "string" ||
        Buffer.byteLength(tool.description) > 16 * 1024 || !tool.inputSchema ||
        typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== "object") {
      throw new MuseMspError("invalid_capture_catalog");
    }
    names.add(tool.name);
    // Snapshot to prevent callers from mutating the advertised schema later.
    try {
      const serialized = JSON.stringify(tool);
      if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error();
      return JSON.parse(serialized) as CodingAgentMcpTool;
    } catch { throw new MuseMspError("invalid_capture_catalog"); }
  });
  const server = new Server({ name: "opencodex-muse-capture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args, _meta: meta } = request.params;
    const callId = meta?.callId;
    if (!names.has(name) || typeof callId !== "string" || !callId || Buffer.byteLength(callId) > 512 ||
        !args || typeof args !== "object" || Array.isArray(args)) throw new MuseMspError("invalid_capture_call");
    try {
      if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) throw new MuseMspError("invalid_capture_call");
      const output = await onCall({ callId, name, arguments: args }, extra.signal);
      if (typeof output !== "string" || Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error();
      return { content: [{ type: "text" as const, text: output }] };
    } catch {
      // Never relay callback exception text or secrets through the MCP endpoint.
      throw new MuseMspError("capture_call_failed");
    }
  });
  return server;
}
