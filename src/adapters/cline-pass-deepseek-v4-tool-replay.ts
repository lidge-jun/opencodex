import type { ProviderAdapter } from "./base";

const CLINE_PASS_DEEPSEEK_V4_MODELS = new Set([
  "cline-pass/deepseek-v4-flash",
  "cline-pass/deepseek-v4-pro",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isClinePassDeepSeekV4Model(modelId: string): boolean {
  return CLINE_PASS_DEEPSEEK_V4_MODELS.has(modelId);
}

/**
 * DeepSeek V4 can copy historical pre-tool narration back into the next turn and
 * eventually degenerate into text-only "I'll call the tool" loops. For the two
 * affected ClinePass models, replay historical assistant tool turns as the
 * structured call only. Normal assistant messages, tool results, and separate
 * reasoning metadata remain untouched.
 */
export function stripClinePassDeepSeekV4ToolReplayNarration(
  body: string,
  modelId: string,
): string {
  if (!isClinePassDeepSeekV4Model(modelId)) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return body;

  let changed = false;
  const messages = parsed.messages.map(message => {
    if (!isRecord(message) || message.role !== "assistant") return message;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return message;
    if (message.content === "") return message;

    changed = true;
    return { ...message, content: "" };
  });

  return changed ? JSON.stringify({ ...parsed, messages }) : body;
}

/**
 * Apply the ClinePass DeepSeek V4 replay compatibility policy after the ordinary
 * OpenAI-chat request has been serialized. The adapter's response parsing and all
 * non-target request behavior stay identical.
 */
export function withClinePassDeepSeekV4ToolReplayCompatibility(
  adapter: ProviderAdapter,
): ProviderAdapter {
  return {
    ...adapter,
    async buildRequest(parsed, incoming) {
      const request = await adapter.buildRequest(parsed, incoming);
      if (!isClinePassDeepSeekV4Model(parsed.modelId)) return request;

      const body = stripClinePassDeepSeekV4ToolReplayNarration(request.body, parsed.modelId);
      return body === request.body ? request : { ...request, body };
    },
  };
}
