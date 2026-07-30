import { randomUUID } from "node:crypto";
import { estimateTokens } from "../lib/token-estimate";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import {
  buildChatGptBrowserPrompt,
  CHATGPT_BROWSER_MODEL_ID,
  ChatGptBrowserError,
  parseChatGptBrowserResponse,
  runOracleBrowserTurn,
  type OracleBrowserTurnOptions,
  type OracleBrowserTurnResult,
} from "./chatgpt-browser-oracle";

export interface ChatGptBrowserAdapterDeps {
  runBrowserTurn?: (prompt: string, options?: OracleBrowserTurnOptions) => Promise<OracleBrowserTurnResult>;
}

function errorStatus(code: ChatGptBrowserError["code"]): number {
  switch (code) {
    case "login_required": return 401;
    case "model_unavailable": return 403;
    // 402 is quota-signalling but non-retryable in Codex. A retry could consume another Pro turn.
    case "quota_exhausted": return 402;
    case "aborted": return 499;
    // Oracle may have submitted before timing out, so surface a fail-fast client status.
    case "timeout": return 400;
    case "unsupported_content": return 400;
    case "oracle_missing":
    case "oracle_incompatible": return 503;
    default: return 400;
  }
}

export function createChatGptBrowserAdapter(
  provider: OcxProviderConfig,
  deps: ChatGptBrowserAdapterDeps = {},
): ProviderAdapter {
  return {
    name: "chatgpt-browser",

    buildRequest() {
      return {
        url: provider.baseUrl,
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "The ChatGPT browser adapter uses runTurn; the HTTP stream path is disabled.",
      };
    },

    async runTurn(parsed, incoming, emit) {
      if (parsed.modelId !== CHATGPT_BROWSER_MODEL_ID) {
        emit({
          type: "error",
          message: `ChatGPT browser supports only ${CHATGPT_BROWSER_MODEL_ID}; no fallback model was used.`,
          status: 400,
          errorType: "invalid_request_error",
          code: "model_not_supported",
        });
        return;
      }

      try {
        const responseNonce = randomUUID();
        const prompt = buildChatGptBrowserPrompt(parsed, responseNonce);
        const run = deps.runBrowserTurn ?? runOracleBrowserTurn;
        emit({ type: "heartbeat" });
        const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
        let result: OracleBrowserTurnResult;
        try {
          result = await run(prompt, {
            signal: incoming.abortSignal,
            command: provider.oracleCommand,
          });
        } finally {
          clearInterval(heartbeat);
        }
        const inputTokens = estimateTokens(prompt, CHATGPT_BROWSER_MODEL_ID);
        const outputTokens = estimateTokens(result.answerText, CHATGPT_BROWSER_MODEL_ID);
        const response = parseChatGptBrowserResponse(result.answerText, parsed, responseNonce);
        if (response.type === "final") {
          emit({ type: "text_delta", text: response.text, phase: "final_answer" });
        } else {
          emit({ type: "tool_call_start", id: response.id, name: response.name });
          emit({ type: "tool_call_delta", arguments: JSON.stringify(response.arguments) });
          emit({ type: "tool_call_end" });
        }
        emit({
          type: "done",
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            estimated: true,
          },
          ...(response.type === "tool_call" ? { stopReason: "tool_use", endTurn: false } : { endTurn: true }),
        });
      } catch (error) {
        const safe = error instanceof ChatGptBrowserError
          ? error
          : new ChatGptBrowserError("browser_failed");
        emit({
          type: "error",
          message: safe.message,
          status: errorStatus(safe.code),
          errorType: "chatgpt_browser_error",
          code: safe.code,
          // Oracle may have submitted before a capture failure. Never invite an automatic retry
          // that could duplicate a ChatGPT turn and consume the user's regular Pro allowance.
          retryable: false,
        });
      }
    },
  };
}
