import type { GuardrailsPlaceholderState, GuardrailsRegistry } from "../types";
import type { GuardrailsScanBudget } from "../scanner";
import {
  isRecord,
  MAX_GUARDRAILS_WALK_DEPTH,
  MAX_GUARDRAILS_WALK_NODES,
  maskGuardrailsTextSlots,
  nestedStringSlots,
  stringPropertySlot,
  type GuardrailsFieldMaskResult,
  type GuardrailsTextSlot,
  type UnknownRecord,
} from "./shared";
import { GuardrailsScanCapacityError } from "../scanner";

export interface AnthropicGuardrailsFieldPolicy {
  scanDocumentSources?: boolean;
}

function anthropicContentSlots(
  content: unknown,
  policy: AnthropicGuardrailsFieldPolicy,
): GuardrailsTextSlot[] {
  if (typeof content === "string") return [{ value: content, replace() {} }];
  if (!Array.isArray(content)) return [];
  const slots: GuardrailsTextSlot[] = [];
  const pending = content.map(block => ({ block, depth: 0 }));
  let nodes = 0;
  while (pending.length > 0) {
    const { block, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_GUARDRAILS_WALK_NODES || depth > MAX_GUARDRAILS_WALK_DEPTH) {
      throw new GuardrailsScanCapacityError("Guardrails Anthropic content walk exceeded its capacity limit");
    }
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      const slot = stringPropertySlot(block, "text");
      if (slot) slots.push(slot);
    } else if (block.type === "tool_use") {
      slots.push(...nestedStringSlots(block.input));
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") slots.push({ value: block.content, replace(next) { block.content = next; } });
      else if (Array.isArray(block.content)) {
        for (const nested of block.content) pending.push({ block: nested, depth: depth + 1 });
      }
    } else if (block.type === "document") {
      const title = stringPropertySlot(block, "title");
      if (title) slots.push(title);
      if (policy.scanDocumentSources === false) continue;
      if (isRecord(block.source) && block.source.type === "text") {
        const data = stringPropertySlot(block.source, "data");
        if (data) slots.push(data);
      } else if (isRecord(block.source) && block.source.type === "content") {
        const content = stringPropertySlot(block.source, "content");
        if (content) slots.push(content);
        else slots.push(...anthropicContentSlots(block.source.content, policy));
      }
    }
  }
  return slots;
}

function collectAnthropicSlots(
  body: unknown,
  policy: AnthropicGuardrailsFieldPolicy,
): GuardrailsTextSlot[] {
  if (!isRecord(body)) return [];
  const slots: GuardrailsTextSlot[] = [];
  if (typeof body.system === "string") slots.push({ value: body.system, replace(next) { body.system = next; } });
  else slots.push(...anthropicContentSlots(body.system, policy));
  if (!Array.isArray(body.messages)) return slots;
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    if (typeof message.content === "string") slots.push({ value: message.content, replace(next) { message.content = next; } });
    else slots.push(...anthropicContentSlots(message.content, policy));
  }
  return slots;
}

export function maskAnthropicRequestFields<T>(
  body: T,
  registry: GuardrailsRegistry,
  previousState?: GuardrailsPlaceholderState,
  scanBudget?: GuardrailsScanBudget,
  policy: AnthropicGuardrailsFieldPolicy = {},
): GuardrailsFieldMaskResult<T> {
  return maskGuardrailsTextSlots(
    body,
    registry,
    copy => collectAnthropicSlots(copy as UnknownRecord, policy),
    previousState,
    scanBudget,
  );
}
