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

const PROTECTED_SUMMARY_CAP = 8192;
/** A real checkpoint carries the conversation it summarizes; a short probe is not one (#5465). */
const MIN_CHECKPOINT_TRANSCRIPT_CHARS = 2000;

/** The mitigation is scoped to Z.AI's own endpoints; another gateway serving the same model id is not. */
function isZaiEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "z.ai" || host.endsWith(".z.ai");
  } catch {
    return false;
  }
}

function isTinyCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1024;
}

/**
 * Aside's emergency checkpoint is a standalone summary, not an ordinary short answer (#5465).
 * Runs at the physical Chat destination, after all combo effort overrides, so `effort` is the
 * effective effort. Only the exhausting tiers (`high`/`max`) on Z.AI's GLM-5.3-Flash, for the
 * two-message checkpoint shape with a real `<conversation>` transcript, qualify. Each tiny cap
 * field is raised on its own, so a caller's larger cap is never shrunk.
 */
export function protectGlmSummaryBudget(
  body: Record<string, unknown>,
  baseUrl: string | undefined,
  effort: unknown,
): boolean {
  if (!isZaiEndpoint(baseUrl)) return false;
  if (effort !== "high" && effort !== "max") return false;
  if (typeof body.model !== "string"
      || !/^(?:(?:zai|z-ai|zai-org)\/)?glm-5\.3-flash$/i.test(body.model)) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) return false;
  if (!isTinyCap(body.max_tokens) && !isTinyCap(body.max_completion_tokens)) return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 2) return false;
  const [system, user] = messages;
  if (!system || !user || !["system", "developer"].includes(system.role) || user.role !== "user"
      || system.tool_calls || user.tool_calls || system.function_call || user.function_call) return false;
  const instruction = textContent(system.content);
  const transcript = textContent(user.content);
  if (instruction === undefined || transcript === undefined) return false;
  if (!/\b(?:summari[sz](?:e|ation|er|ing)|summary|checkpoint)\b/i.test(instruction)) return false;
  if (!/<conversation>[\s\S]*<\/conversation>/i.test(transcript)) return false;
  if (transcript.length < MIN_CHECKPOINT_TRANSCRIPT_CHARS) return false;
  if (isTinyCap(body.max_tokens)) body.max_tokens = PROTECTED_SUMMARY_CAP;
  if (isTinyCap(body.max_completion_tokens)) body.max_completion_tokens = PROTECTED_SUMMARY_CAP;
  return true;
}
