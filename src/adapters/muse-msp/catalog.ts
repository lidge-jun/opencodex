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
        typeof tool.description !== "string" || Buffer.byteLength(tool.description) > 256 * 1024 ||
        !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object") {
      throw new MuseMspError("invalid_capture_catalog");
    }
    // These need different wire types or execution/authorization semantics.
    if (tool.imageGeneration || tool.videoGeneration || tool.advisor ||
        tool.cursorStructuredEdit || tool.allowedCallers !== undefined || tool.strict === true) throw new MuseMspError("unsupported_capture_tool");
    const identity = JSON.stringify([tool.namespace ?? null, tool.name]);
    if (seen.has(identity)) throw new MuseMspError("duplicate_capture_tool");
    seen.add(identity);
    const base = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "tool";
    const alias = tool.name === "exec" && tool.freeform && !tool.namespace
      ? "exec" : `${base}_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
    if (aliases.has(alias)) throw new MuseMspError("capture_alias_collision");
    aliases.add(alias);
    let schema: Record<string, unknown>, bytes: number;
    try {
      const serialized = JSON.stringify(tool.parameters);
      bytes = Buffer.byteLength(serialized);
      if (bytes > 256 * 1024) throw new Error();
      schema = JSON.parse(serialized);
    } catch { throw new MuseMspError("invalid_capture_catalog"); }
    const bridgeHint = tool.name === "exec" && tool.freeform && !tool.namespace
      ? "Codex client tool for commands, files and MCP calls. Set input to JavaScript, for example await tools.exec_command({cmd: \"...\"}); inspect ALL_TOOLS to discover MCP tools. Codex applies its own permissions. This tool remains available when Muse's native shell and write tools are disabled.\n\n"
      : "";
    const definition = { name: alias, description: bridgeHint + tool.description, inputSchema: schema };
    if (Buffer.byteLength(JSON.stringify(definition)) > 256 * 1024) throw new MuseMspError("invalid_capture_catalog");
    catalogBytes += Buffer.byteLength(JSON.stringify(definition));
    if (catalogBytes > 2 * 1024 * 1024) throw new MuseMspError("invalid_capture_catalog");
    tools.push(definition);
    approvalTools.set(`mcp__opencodex__${alias}`, Object.freeze({ name: tool.name,
      ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }), ...(tool.freeform ? { freeform: true as const } : {}) }));
  }
  return { tools, approvalTools };
}

/** Tell Muse how the Codex tool names in client instructions map to capture-only MCP tools. */
export function museClientToolInstructions(tools: ReadonlyMap<string, MuseClientTool>): string | undefined {
  if(!tools.size) return undefined;
  const mapping=[...tools].map(([mcp,entry])=>{
    const tool=typeof entry==="string"?{name:entry}:entry;
    return {client:tool.namespace?`${tool.namespace}.${tool.name}`:tool.name,mcp,freeform:tool.freeform===true};
  });
  return "Client tools are available through the MCP tools below. Calls are handled by OpenCodex or forwarded to Codex under its own permissions, and their results are returned to you. Muse's own disabled shell and write tools do not disable these client tools. Use the MCP name corresponding to the client tool named in the instructions. "
    + "For a freeform Codex tool, pass its raw input in the MCP argument named input. "
    + "For the Codex exec tool, that input is JavaScript that calls its documented nested tools, for example await tools.exec_command({cmd: \"...\"}).\n"
    + JSON.stringify(mapping);
}
