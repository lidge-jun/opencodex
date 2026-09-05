import { toolChoiceToolPredicate, type OcxParsedRequest, type OcxProviderConfig } from "../types";
import { isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers";
import { CODE_MODE_RESULT_ECHO_SENTENCE, normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
import { isBareShellBridgeTool, isCodexCodeModeExecTool } from "./tool-catalog-nudge";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Inspect the whole result, not just its empty header: later text or media is real output. */
function textOnlyOutput(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  if (!output.every(part => record(part)
    && ["text", "input_text", "output_text"].includes(String(part.type))
    && typeof part.text === "string")) return undefined;
  return output.map(part => part.text).join("\n");
}

function withExecInputGuidance(tool: unknown): unknown {
  if (!record(tool) || tool.type !== "function" || tool.name !== "exec" || tool.namespace !== undefined) return tool;
  if (!record(tool.parameters) || !record(tool.parameters.properties) || !record(tool.parameters.properties.input)) return tool;
  return { ...tool, parameters: { ...tool.parameters, properties: {
    ...tool.parameters.properties,
    input: {
      ...tool.parameters.properties.input,
      description: `JavaScript source for unified exec; do not provide a bare shell command. ${CODE_MODE_RESULT_ECHO_SENTENCE}`,
    },
  } } };
}

/** Native routed Responses needs the same first-call/output contract as translated adapters. */
export function normalizeResponsesCodeMode(body: unknown, parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown {
  if (!record(body) || parsed._compactionRequest || isOpenAiOperatedResponsesDestination(provider)) return body;
  const visible = parsed.context.tools?.filter(toolChoiceToolPredicate(parsed.options.toolChoice, parsed.context.tools));
  if (!visible?.some(isCodexCodeModeExecTool) || visible.some(isBareShellBridgeTool)) return body;
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  const input = Array.isArray(body.input) ? body.input : undefined;
  const execCalls = new Set(input?.filter(item => record(item)
    && (item.type === "function_call" || item.type === "custom_tool_call")
    && item.name === "exec" && item.namespace === undefined && typeof item.call_id === "string")
    .map(item => item.call_id));
  return {
    ...body,
    instructions: instructions.includes(CODE_MODE_RESULT_ECHO_SENTENCE)
      ? instructions : [instructions, CODE_MODE_RESULT_ECHO_SENTENCE].filter(Boolean).join("\n\n"),
    ...(Array.isArray(body.tools) ? { tools: body.tools.map(withExecInputGuidance) } : {}),
    ...(input ? { input: input.map(item => {
      if (!record(item)) return item;
      if (item.type === "additional_tools" && Array.isArray(item.tools)) {
        return { ...item, tools: item.tools.map(withExecInputGuidance) };
      }
      if ((item.type !== "function_call_output" && item.type !== "custom_tool_call_output") || !execCalls.has(item.call_id)) return item;
      const text = textOnlyOutput(item.output);
      const normalized = text === undefined ? undefined : normalizeEmptyExecToolResultText(text, { toolName: "exec" });
      return normalized === undefined ? item : { ...item, output: normalized };
    }) } : {}),
  };
}
