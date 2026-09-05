import type { GuardrailsPlaceholderState, GuardrailsRegistry } from "../types";
import type { GuardrailsScanBudget } from "../scanner";
import {
  isRecord,
  maskGuardrailsTextSlots,
  nestedStringSlots,
  stringPropertySlot,
  type GuardrailsFieldMaskResult,
  type GuardrailsTextSlot,
  type UnknownRecord,
} from "./shared";

function messageContentSlots(message: UnknownRecord): GuardrailsTextSlot[] {
  if (typeof message.content === "string") return [{ value: message.content, replace(next) { message.content = next; } }];
  if (!Array.isArray(message.content)) return [];
  const slots: GuardrailsTextSlot[] = [];
  for (let index = 0; index < message.content.length; index += 1) {
    const part = message.content[index];
    if (typeof part === "string") {
      slots.push({
        value: part,
        replace(next) { (message.content as unknown[])[index] = next; },
      });
      continue;
    }
    if (!isRecord(part) || (part.type !== "text" && part.type !== "input_text" && part.type !== "output_text")) continue;
    const slot = stringPropertySlot(part, "text");
    if (slot) slots.push(slot);
  }
  return slots;
}

function argumentSlots(record: UnknownRecord, key: string): GuardrailsTextSlot[] {
  const slot = stringPropertySlot(record, key);
  return slot ? [slot] : nestedStringSlots(record[key]);
}

function collectChatSlots(body: unknown): GuardrailsTextSlot[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const slots: GuardrailsTextSlot[] = [];
  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    slots.push(...messageContentSlots(message));
    const refusal = stringPropertySlot(message, "refusal");
    if (refusal) slots.push(refusal);
    if (isRecord(message.function_call)) {
      slots.push(...argumentSlots(message.function_call, "arguments"));
    }
    if (!Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      slots.push(...argumentSlots(call, "arguments"));
      if (isRecord(call.function)) slots.push(...argumentSlots(call.function, "arguments"));
    }
  }
  return slots;
}

export function maskChatRequestFields<T>(
  body: T,
  registry: GuardrailsRegistry,
  previousState?: GuardrailsPlaceholderState,
  scanBudget?: GuardrailsScanBudget,
): GuardrailsFieldMaskResult<T> {
  return maskGuardrailsTextSlots(body, registry, copy => collectChatSlots(copy as UnknownRecord), previousState, scanBudget);
}
