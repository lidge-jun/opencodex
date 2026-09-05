import type {
  GuardrailsDemaskBudget,
  GuardrailsPlaceholderState,
  GuardrailsRegistry,
} from "../types";
import type { GuardrailsScanBudget } from "../scanner";
import {
  isRecord,
  maskGuardrailsTextSlots,
  nestedStringSlots,
  restoreGuardrailsTextSlots,
  stringPropertySlot,
  type GuardrailsFieldMaskResult,
  type GuardrailsTextSlot,
  type UnknownRecord,
} from "./shared";

export const RESPONSES_GUARDRAILS_ITEM_POLICY = {
  additional_tools: "skip",
  agent_message: "scan",
  compaction: "scan_local_envelope",
  compaction_summary: "scan_local_envelope",
  compaction_trigger: "skip",
  context_compaction: "scan_local_envelope",
  custom_tool_call: "scan",
  custom_tool_call_output: "scan",
  function_call: "scan",
  function_call_output: "scan",
  local_shell_call: "scan",
  message: "scan",
  reasoning: "skip",
  tool_search_call: "scan",
  tool_search_output: "skip",
  web_search_call: "scan",
} as const satisfies Record<string, "scan" | "scan_local_envelope" | "skip">;

function contentSlots(content: unknown): GuardrailsTextSlot[] {
  if (typeof content === "string") return [];
  if (!Array.isArray(content)) return [];
  const slots: GuardrailsTextSlot[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      const slot = stringPropertySlot(part, "text");
      if (slot) slots.push(slot);
    } else if (part.type === "refusal") {
      const slot = stringPropertySlot(part, "refusal");
      if (slot) slots.push(slot);
    } else if (part.type === "input_file") {
      const slot = stringPropertySlot(part, "filename");
      if (slot) slots.push(slot);
    }
  }
  return slots;
}

function stringArraySlots(value: unknown): GuardrailsTextSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: GuardrailsTextSlot[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") continue;
    slots.push({
      value: value[index],
      replace(next) { value[index] = next; },
    });
  }
  return slots;
}

function toolOutputSlots(item: UnknownRecord): GuardrailsTextSlot[] {
  const output = item.output;
  const slot = stringPropertySlot(item, "output");
  if (slot) return [slot];
  if (Array.isArray(output)) {
    const slots = [...stringArraySlots(output), ...contentSlots(output)];
    const protocolContentTypes = new Set([
      "computer_screenshot",
      "input_file",
      "input_image",
      "input_text",
      "output_text",
      "refusal",
      "text",
    ]);
    for (const part of output) {
      if (!isRecord(part)) continue;
      if (typeof part.type === "string" && protocolContentTypes.has(part.type)) continue;
      slots.push(...nestedStringSlots(part));
    }
    return slots;
  }
  return nestedStringSlots(output);
}

function textBearingContentSlots(item: UnknownRecord): GuardrailsTextSlot[] {
  if (typeof item.content === "string") {
    return [{ value: item.content, replace(next) { item.content = next; } }];
  }
  return contentSlots(item.content);
}

function collectResponsesSlots(body: unknown): GuardrailsTextSlot[] {
  if (!isRecord(body)) return [];
  const slots: GuardrailsTextSlot[] = [];
  const instructions = stringPropertySlot(body, "instructions");
  if (instructions) slots.push(instructions);
  if (typeof body.input === "string") {
    slots.push({ value: body.input, replace(next) { body.input = next; } });
    return slots;
  }
  if (!Array.isArray(body.input)) return slots;
  for (const item of body.input) {
    if (!isRecord(item)) continue;
    if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) {
      slots.push(...textBearingContentSlots(item));
      continue;
    }
    if (item.type === "agent_message") {
      slots.push(...textBearingContentSlots(item));
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const key = item.type === "function_call" ? "arguments" : "input";
      const slot = stringPropertySlot(item, key);
      if (slot) slots.push(slot);
      else slots.push(...nestedStringSlots(item[key]));
      continue;
    }
    if (item.type === "tool_search_call") {
      const slot = stringPropertySlot(item, "arguments");
      if (slot) slots.push(slot);
      else slots.push(...nestedStringSlots(item.arguments));
      continue;
    }
    if (item.type === "web_search_call" && isRecord(item.action)) {
      const query = stringPropertySlot(item.action, "query");
      if (query) slots.push(query);
      slots.push(...stringArraySlots(item.action.queries));
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      slots.push(...toolOutputSlots(item));
      slots.push(...contentSlots(item.content));
      continue;
    }
    if (item.type === "local_shell_call" && isRecord(item.action)) {
      const slot = stringPropertySlot(item.action, "command");
      if (slot) slots.push(slot);
      else slots.push(...stringArraySlots(item.action.command));
    }
  }
  return slots;
}

export function maskResponsesRequestFields<T>(
  body: T,
  registry: GuardrailsRegistry,
  previousState?: GuardrailsPlaceholderState,
  scanBudget?: GuardrailsScanBudget,
): GuardrailsFieldMaskResult<T> {
  return maskGuardrailsTextSlots(body, registry, copy => collectResponsesSlots(copy as UnknownRecord), previousState, scanBudget);
}

export function restoreResponsesRequestFields<T>(
  body: T,
  state: GuardrailsPlaceholderState,
  budget?: GuardrailsDemaskBudget,
): T {
  return restoreGuardrailsTextSlots(
    body,
    state,
    copy => collectResponsesSlots(copy as UnknownRecord),
    budget,
  );
}
