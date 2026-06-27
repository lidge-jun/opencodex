import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxRequestOptions, OcxTool } from "../../types";
import { namespacedToolName } from "../../types";
import { McpToolDefinitionSchema, type McpToolDefinition } from "./gen/agent_pb";

export const OCX_RESPONSES_TOOL_PROVIDER = "opencodex-responses";

export function cursorToolWireName(tool: OcxTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function toolChoiceAllows(tool: OcxTool, toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if ("allowedTools" in toolChoice) {
    return toolChoice.allowedTools.includes(tool.name) || toolChoice.allowedTools.includes(cursorToolWireName(tool));
  }
  return tool.name === toolChoice.name || cursorToolWireName(tool) === toolChoice.name;
}

export function encodeCursorInputSchema(schema: unknown): Uint8Array {
  const value: JsonValue = schema && typeof schema === "object"
    ? schema as JsonValue
    : { type: "object", properties: {}, required: [] };
  return toBinary(ValueSchema, fromJson(ValueSchema, value));
}

export function buildCursorToolDefinitions(
  tools: readonly OcxTool[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): McpToolDefinition[] {
  if (!tools?.length) return [];
  return tools.filter(tool => toolChoiceAllows(tool, toolChoice)).map(tool => {
    const wireName = cursorToolWireName(tool);
    return create(McpToolDefinitionSchema, {
      name: wireName,
      toolName: wireName,
      providerIdentifier: OCX_RESPONSES_TOOL_PROVIDER,
      description: tool.description,
      inputSchema: encodeCursorInputSchema(tool.parameters ?? {}),
    });
  });
}
