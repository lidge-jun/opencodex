import type { OcxParsedRequest } from "../types";
import { namespacedToolName } from "../types";

const MAX_KIRO_TOOL_DESCRIPTION = 1024;

function sanitizeKiroSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeKiroSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = sanitizeKiroSchema(child);
  }
  return out;
}

export function convertKiroToolContext(parsed: OcxParsedRequest): { tools: unknown[]; systemAdditions: string[] } {
  const tools = parsed.context.tools ?? [];
  const systemAdditions: string[] = [];
  return {
    tools: tools.map(t => {
      const description = t.description || `Tool: ${t.name}`;
      // Send the full namespaced wire name (e.g. mcp__chrome-devtools__navigate_page) so Kiro echoes
      // it back unchanged; the bridge's toolNsMap is keyed by this name and restores the MCP namespace
      // Codex routes by. Truncating here breaks long MCP/computer-use round trips.
      const toolName = namespacedToolName(t.namespace, t.name);
      const kiroDescription = description.length > MAX_KIRO_TOOL_DESCRIPTION
        ? `Tool documentation moved to the system prompt: ${toolName}.`
        : description;
      if (description.length > MAX_KIRO_TOOL_DESCRIPTION) {
        systemAdditions.push([`### Tool documentation: ${toolName}`, description].join("\n"));
      }
      return {
        toolSpecification: {
          name: toolName,
          description: kiroDescription,
          inputSchema: { json: sanitizeKiroSchema(t.parameters ?? {}) as Record<string, unknown> },
        },
      };
    }),
    systemAdditions,
  };
}

export function convertKiroTools(parsed: OcxParsedRequest): unknown[] {
  return convertKiroToolContext(parsed).tools;
}
