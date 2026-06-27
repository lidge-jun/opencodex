import { create } from "@bufbuild/protobuf";
import type { OcxRequestOptions, OcxTool } from "../../types";
import { namespacedToolName } from "../../types";
import { McpToolDefinitionSchema, type McpToolDefinition } from "./gen/agent_pb";
import { textEncoder } from "./native-exec-common";

export const OCX_RESPONSES_TOOL_PROVIDER = "opencodex-responses";

export function cursorToolWireName(tool: OcxTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function toolChoiceAllows(tool: OcxTool, toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  return tool.name === toolChoice.name || cursorToolWireName(tool) === toolChoice.name;
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
      inputSchema: textEncoder.encode(JSON.stringify(tool.parameters ?? {})),
    });
  });
}
