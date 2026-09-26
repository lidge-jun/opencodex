import { modelRecordValue } from "../../reasoning-effort";
import type { OcxParsedRequest, OcxProviderConfig } from "../../types";

export function resolveMaxTokens(provider: OcxProviderConfig, parsed: OcxParsedRequest): number | undefined {
  return parsed.options.maxOutputTokens
    ?? modelRecordValue(provider.modelMaxOutputTokens, parsed.modelId)
    ?? provider.defaultMaxOutputTokens;
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text: string[] = [];
  for (const part of value) {
    if (!part || part.type !== "text" || typeof part.text !== "string") return undefined;
    text.push(part.text);
  }
  return text.join("\n");
}

/** Aside's emergency checkpoint is a standalone summary, not an ordinary short answer.
 * Runs at the physical Chat destination, after all combo effort overrides.
 */
export function protectGlmSummaryBudget(body: Record<string, unknown>): boolean {
  if (typeof body.model !== "string"
      || !/^(?:(?:zai|z-ai|zai-org)\/)?glm-5\.3-flash$/i.test(body.model)) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) return false;
  const cap = body.max_completion_tokens ?? body.max_tokens;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > 1024) return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 2) return false;
  const [system, user] = messages;
  if (!system || !user || !["system", "developer"].includes(system.role) || user.role !== "user"
      || system.tool_calls || user.tool_calls || system.function_call || user.function_call) return false;
  const instruction = textContent(system.content);
  const transcript = textContent(user.content);
  if (instruction === undefined || transcript === undefined) return false;
  const summaryInstruction = /\bcontext[-\s]+summari[sz](?:ation|er|ing)\b/i.test(instruction);
  const checkpointTranscript = /\b(?:summari[sz]e|summary|checkpoint)\b/i.test(instruction)
    && /<conversation>[\s\S]*<\/conversation>/i.test(transcript);
  if (!summaryInstruction && !checkpointTranscript) return false;
  // Update both if supplied: gateways differ on which cap takes precedence.
  if (body.max_tokens !== undefined) body.max_tokens = 4096;
  if (body.max_completion_tokens !== undefined) body.max_completion_tokens = 4096;
  return true;
}
