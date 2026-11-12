import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { ProviderAdapter } from "./base";
import { codeBuddyAiToolParameters } from "./codebuddy-ai-schema";
import { retainTranslatedEvent, releaseTranslatedEvent } from "../lib/translator-budget";
import { createOpenAIChatAdapter } from "./openai-chat";
import { neutralizeClaudeCodeIdentity } from "./claude-code-identity";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import { assertCodeBuddyAiDestination, CODEBUDDY_AI_BASE_URL, codeBuddyAiHeaders } from "../providers/codebuddy-ai";

const sessionSalt = randomBytes(32);
const opaqueId = (value: unknown) => createHmac("sha256", sessionSalt).update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** OpenAI Chat contract over CodeBuddy SSE, with its account headers and tool-schema rules. */
export function createCodeBuddyAiAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const base = createOpenAIChatAdapter({ ...provider, adapter: "openai-chat", baseUrl: CODEBUDDY_AI_BASE_URL, headers: undefined });
  return {
    ...base, name: "codebuddy-ai",
    async buildRequest(parsed, incoming) {
      assertCodeBuddyAiDestination(provider.baseUrl);
      if (!provider.apiKey || !parsed._codeBuddyAiAuthContext) throw new Error("CodeBuddy AI account unavailable; run ocx login codebuddy-ai");
      const req = await base.buildRequest({ ...parsed, stream: true }, incoming);
      const body = JSON.parse(req.body);
      const messages = body.messages as Array<Record<string, unknown>>;
      for (const message of messages) if (message.role === "developer") message.role = "system";
      neutralizeClaudeCodeIdentity(messages);
      if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: "You are a helpful assistant." });
      if (body.max_completion_tokens !== undefined) { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
      if (body.tool_choice === "none") { delete body.tools; delete body.tool_choice; }
      else if (body.tool_choice?.type === "function") body.tool_choice = body.tool_choice.function.name;
      for (const tool of body.tools ?? []) {
        if (tool.type === "function") tool.function.parameters = codeBuddyAiToolParameters(tool.function.parameters);
      }
      const users = messages.map((m, index) => ({ m, index })).filter(({ m }) => m.role === "user");
      const session = parsed._codexOwnThreadId || parsed._clientThreadId
        || (!parsed._promptCacheKeyIsSharedCohort ? parsed.options.promptCacheKey : undefined)
        || incoming.headers.get("session_id") || incoming.headers.get("x-session-id");
      const conversation = session || users[0]?.m.content;
      const latest = users.at(-1);
      const requestId = randomUUID().replaceAll("-", "");
      const headers = {
        "Content-Type": "application/json", Accept: "text/event-stream",
        ...codeBuddyAiHeaders(provider.apiKey, parsed._codeBuddyAiAuthContext),
        "X-Request-ID": requestId, "X-Conversation-Message-ID": requestId,
        "X-Conversation-Request-ID": latest ? opaqueId([conversation, latest.index, latest.m.content]) : requestId,
        ...(conversation ? { "X-Conversation-ID": opaqueId(conversation) } : {}),
      };
      return { ...req, url: `${CODEBUDDY_AI_BASE_URL}/chat/completions`, headers, body: JSON.stringify(body), redirect: "error" as const };
    },
    async parseResponse(response, budget, tier) {
      const events: AdapterEvent[] = [];
      try {
        for await (const event of base.parseStream(response, budget, tier)) {
          retainTranslatedEvent(event, budget, events.at(-1));
          events.push(event);
        }
        return events;
      } catch (error) {
        for (const event of events) releaseTranslatedEvent(event, budget);
        throw error;
      }
    },
    formatErrorBody(status, _headers, payload) {
      let code: unknown;
      try { code = JSON.parse(payload)?.code; } catch { /* Only structured numeric codes are public. */ }
      if (Number(code) === 11128) return "CodeBuddy AI rejected this client channel (11128).";
      if (Number(code) === 11140) return "CodeBuddy AI restricted this account (11140); contact CodeBuddy support.";
      if (Number(code) === 14018) return "CodeBuddy AI credits exhausted (14018).";
      return `CodeBuddy AI request failed (HTTP ${status}).`;
    },
  };
}
