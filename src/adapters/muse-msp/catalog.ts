import { createHash } from "node:crypto";
import type { OcxParsedRequest } from "../../types";
import type { CodingAgentMcpTool } from "../coding-agent/mcp-server";
import type { MuseClientTool } from "./approval";
import { MuseMspError } from "./connection";

/** Build a fixed capture-only catalog and an exact reverse mapping for one session. */
export function buildMuseCaptureCatalog(parsed: OcxParsedRequest): {
  tools: CodingAgentMcpTool[]; approvalTools: ReadonlyMap<string, MuseClientTool>;
} {
  const choice = parsed.options.toolChoice;
  if (choice === "none") return { tools: [], approvalTools: new Map() };
  // An MCP catalog alone cannot guarantee the model will call a required or named tool.
  if (choice !== undefined && choice !== "auto") throw new MuseMspError("unsupported_tool_choice");
  const source = parsed.context.tools ?? [];
  if (!Array.isArray(source) || source.length > 128) throw new MuseMspError("invalid_capture_catalog");
  const seen = new Set<string>(), aliases = new Set<string>();
  const tools: CodingAgentMcpTool[] = [];
  const approvalTools = new Map<string, MuseClientTool>();
  let catalogBytes = 0;
  for (const tool of source) {
    if (!tool || typeof tool.name !== "string" || !tool.name || Buffer.byteLength(tool.name) > 512 ||
        (tool.namespace !== undefined && (typeof tool.namespace !== "string" || !tool.namespace || Buffer.byteLength(tool.namespace) > 512)) ||
        typeof tool.description !== "string" || Buffer.byteLength(tool.description) > 16 * 1024 ||
        !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object") {
      throw new MuseMspError("invalid_capture_catalog");
    }
    // These need different wire types or execution/authorization semantics.
    if (tool.toolSearch || tool.webSearch || tool.imageGeneration || tool.videoGeneration || tool.advisor ||
        tool.cursorStructuredEdit || tool.allowedCallers !== undefined || tool.strict === true) throw new MuseMspError("unsupported_capture_tool");
    const identity = JSON.stringify([tool.namespace ?? null, tool.name]);
    if (seen.has(identity)) throw new MuseMspError("duplicate_capture_tool");
    seen.add(identity);
    const base = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "tool";
    const alias = `${base}_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
    if (aliases.has(alias)) throw new MuseMspError("capture_alias_collision");
    aliases.add(alias);
    let schema: Record<string, unknown>, bytes: number;
    try {
      const serialized = JSON.stringify(tool.parameters);
      bytes = Buffer.byteLength(serialized);
      if (bytes > 256 * 1024) throw new Error();
      schema = JSON.parse(serialized);
    } catch { throw new MuseMspError("invalid_capture_catalog"); }
    const definition = { name: alias, description: tool.description, inputSchema: schema };
    catalogBytes += Buffer.byteLength(JSON.stringify(definition));
    if (catalogBytes > 2 * 1024 * 1024) throw new MuseMspError("invalid_capture_catalog");
    tools.push(definition);
    approvalTools.set(`mcp__opencodex__${alias}`, Object.freeze({ name: tool.name,
      ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }), ...(tool.freeform ? { freeform: true as const } : {}) }));
  }
  return { tools, approvalTools };
}
