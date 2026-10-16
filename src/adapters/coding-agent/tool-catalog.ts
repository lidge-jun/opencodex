import { namespacedToolName, requiresToolCall, toolChoiceToolPredicate, type OcxParsedRequest } from "../../types";
import { stripResponsesOnlyEncryptedMarker } from "../responses-tool-schema";

// The selected catalog also supplies one comma-joined --allowed-tools argv value.
// Bound that full argument separately from individual names for Windows process creation.
export const CODING_AGENT_TOOL_LIMITS = Object.freeze({
  maxTools: 128,
  maxNameBytes: 512,
  maxAllowedToolsArgBytes: 8 * 1024,
  maxToolBytes: 256 * 1024,
  maxCatalogBytes: 2 * 1024 * 1024,
});

const encoder = new TextEncoder();
const INVALID_NAME_PART = /[,\s\u0000-\u001f\u007f-\u009f]/u;

export class CodingAgentToolCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentToolCatalogError";
  }
}

export function isValidCodingAgentToolNamePart(value: unknown): value is string {
  if (typeof value !== "string" || !value || INVALID_NAME_PART.test(value)) return false;
  // TextEncoder replaces lone surrogates, which would change tool identity on the MCP wire.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** One client-owned catalog; the CLI spelling is only a projection of its wire names. */
export function buildCodingAgentToolCatalog(parsed: OcxParsedRequest, serverName: string) {
  const declared = parsed.context.tools ?? [];
  const selected = declared.filter(toolChoiceToolPredicate(parsed.options.toolChoice, declared));
  if (selected.length > CODING_AGENT_TOOL_LIMITS.maxTools) throw new CodingAgentToolCatalogError("tool catalog exceeds tool count limit");
  const requireToolCall = requiresToolCall(parsed.options.toolChoice);
  const emittedNameMap = new Map<string, string>();
  // JSON array brackets and commas count too; avoid serializing the whole catalog twice.
  let catalogBytes = 2;
  let allowedToolsArgBytes = 0;
  const tools = selected.map((tool, index) => {
    if (!tool || !isValidCodingAgentToolNamePart(tool.name) || (tool.namespace !== undefined && !isValidCodingAgentToolNamePart(tool.namespace))) {
      throw new CodingAgentToolCatalogError("invalid tool name or namespace");
    }
    const wireName = namespacedToolName(tool.namespace, tool.name);
    if (encoder.encode(wireName).byteLength > CODING_AGENT_TOOL_LIMITS.maxNameBytes) {
      throw new CodingAgentToolCatalogError("tool name exceeds byte limit");
    }
    const definition = {
      name: wireName,
      description: tool.description || `Tool: ${wireName}`,
      inputSchema: stripResponsesOnlyEncryptedMarker(tool.parameters) as Record<string, unknown>,
    };
    const bytes = encoder.encode(JSON.stringify(definition)).byteLength;
    if (bytes > CODING_AGENT_TOOL_LIMITS.maxToolBytes) throw new CodingAgentToolCatalogError("tool definition exceeds byte limit");
    catalogBytes += bytes + (index ? 1 : 0);
    if (catalogBytes > CODING_AGENT_TOOL_LIMITS.maxCatalogBytes) throw new CodingAgentToolCatalogError("tool catalog exceeds byte limit");
    const emittedName = `mcp__${serverName}__${wireName}`;
    allowedToolsArgBytes += encoder.encode(emittedName).byteLength + (index ? 1 : 0);
    if (allowedToolsArgBytes > CODING_AGENT_TOOL_LIMITS.maxAllowedToolsArgBytes) {
      throw new CodingAgentToolCatalogError("allowed-tools argument exceeds byte limit");
    }
    emittedNameMap.set(emittedName, wireName);
    return definition;
  });
  return { tools, emittedNameMap, requireToolCall };
}
