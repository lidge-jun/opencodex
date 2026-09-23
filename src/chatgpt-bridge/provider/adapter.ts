import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../../adapters/base";

/**
 * chatgpt-web provider adapter: the thin OC seam for web ChatGPT models.
 *
 * P4 boundary (handoff §7): this adapter owns protocol translation and the
 * model catalog surface. Actual turn execution is delegated to an injected
 * ChatGptWebTransport. Until the browser transport is attached (P4 browser
 * helper work), every turn fails with an explicit structured error — never a
 * fabricated reply, and never a silent model switch.
 */
export interface ChatGptWebTurnContext {
  modelId: string;
  effort?: string;
  promptPreview: string;
}

export interface ChatGptWebTransport {
  runTurn(context: ChatGptWebTurnContext, incoming: IncomingMeta, emit: (event: AdapterEvent) => void): Promise<void>;
}

export interface ChatGptWebAdapterDeps {
  /** Absent until the browser helper transport is wired (explicitly degraded). */
  transport?: ChatGptWebTransport;
}

const BROWSER_TRANSPORT_UNAVAILABLE =
  "chatgpt-web model transport is not attached: the browser helper is not enabled in this OpenCodex build. " +
  "Enable the chatgpt-bridge module (chatgptBridge.enabled + browser transport) to route turns through the web session.";

export function createChatGptWebAdapter(
  provider: OcxProviderConfig,
  deps: ChatGptWebAdapterDeps = {},
): ProviderAdapter {
  return {
    name: "chatgpt-web",

    buildRequest() {
      // Required by the adapter contract; runTurn adapters never fetch here.
      return {
        url: provider.baseUrl || "https://chatgpt.com",
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "chatgpt-web adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(
      parsed: OcxParsedRequest,
      incoming: IncomingMeta,
      emit: (event: AdapterEvent) => void,
    ): Promise<void> {
      const transport = deps.transport;
      if (!transport) {
        emit({
          type: "error",
          message: BROWSER_TRANSPORT_UNAVAILABLE,
          status: 503,
          errorType: "chatgpt_web_transport_unavailable",
          code: "CHATGPT_WEB_TRANSPORT_UNAVAILABLE",
          retryable: false,
        });
        return;
      }
      try {
        await transport.runTurn(
          {
            modelId: parsed.modelId,
            effort: (parsed.options as { reasoningEffort?: string } | undefined)?.reasoningEffort,
            promptPreview: JSON.stringify(parsed.context ?? {}).slice(0, 200),
          },
          incoming,
          emit,
        );
      } catch (error) {
        // Transport failures are surfaced verbatim as terminal errors; the
        // caller (OC core) decides retry semantics. The adapter never retries
        // a web turn on its own: the send may already have become visible.
        emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          errorType: "chatgpt_web_transport_failure",
          code: "CHATGPT_WEB_TRANSPORT_FAILURE",
          retryable: false,
        });
      }
    },
  };
}
