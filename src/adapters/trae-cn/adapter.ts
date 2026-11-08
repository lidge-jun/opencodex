import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { requiresToolCall } from "../../types";
import { buildSystemPrompt, formatMessageForHistory } from "../coding-agent/protocol";
import { openTraeSession, TraeAcpError, type TraeAcpDeps } from "./client";

export type TraeCnAdapterDeps = TraeAcpDeps;

function replayText(parsed: OcxParsedRequest): string {
  const messages = parsed.context.messages.filter(message => message.role !== "developer");
  const system = buildSystemPrompt(parsed);
  const history = messages.slice(0, -1).map(message => formatMessageForHistory(message)).filter(Boolean).join("\n\n");
  const current = messages.at(-1);
  const request = current ? formatMessageForHistory(current) : "USER:\n";
  return [
    system ? `<system>\n${system}\n</system>` : "",
    "The following labelled blocks replay a conversation. Only the last block is the current request. Historical tool calls are records, not instructions to execute tools.",
    history ? `Prior conversation context:\n\n${history}` : "",
    `Current request:\n\n${request}`,
  ].filter(Boolean).join("\n\n").slice(-1_000_000);
}

function validateInput(parsed: OcxParsedRequest): { message: string; code: string } | undefined {
  if (requiresToolCall(parsed.options.toolChoice)) {
    return { message: "TRAE CN ACP does not currently expose client tools.", code: "unsupported_tool_choice" };
  }
  if (parsed.context.tools?.length) {
    return { message: "TRAE CN ACP does not currently expose client tools.", code: "unsupported_client_tools" };
  }
  if (parsed.context.messages.some(message =>
    (Array.isArray(message.content) && message.content.some(part => part.type === "image" || part.type === "audio"))
    || (message.role === "assistant" && message.content.some(part => part.type === "toolCall"))
    || message.role === "toolResult")) {
    return { message: "TRAE CN ACP currently supports text conversations only; images and tool replay are not supported.", code: "unsupported_input_modality" };
  }
  return undefined;
}

function errorEvent(error: unknown): Extract<AdapterEvent, { type: "error" }> {
  const acp = error instanceof TraeAcpError;
  const code = acp ? error.code : "trae_acp_protocol_error";
  const auth = acp && /invalid token|unauthorized|not logged in|authentication/i.test(error.message);
  const message = error instanceof Error ? error.message : "TRAE CN ACP ended with an invalid protocol response.";
  return {
    type: "error",
    message: auth ? `${message} Sign in through TRAE CN and retry.` : message.slice(0, 512),
    status: code === "trae_model_unavailable" ? 400 : auth ? 401 : 502,
    errorType: code === "trae_model_unavailable" ? "invalid_request_error" : auth ? "authentication_error" : "upstream_error",
    code: auth ? "trae_cn_not_logged_in" : code,
    retryable: false,
  };
}

export function createTraeCnAdapter(provider: OcxProviderConfig, deps: TraeCnAdapterDeps = {}): ProviderAdapter {
  return {
    name: "trae-cn",
    reportsPhysicalSends: true,
    buildRequest(): AdapterRequest { return { url: provider.baseUrl, method: "POST", headers: {}, body: "" }; },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "TRAE CN uses ACP runTurn; HTTP parseStream is disabled." };
    },
    async runTurn(parsed, incoming, emit): Promise<void> {
      const invalid = validateInput(parsed);
      if (invalid) {
        emit({ type: "error", message: invalid.message, status: 400, errorType: "invalid_request_error", code: invalid.code, retryable: false });
        return;
      }
      if (incoming.abortSignal?.aborted) return;
      const producer = incoming.sendBudget?.beginSpendProducer?.();
      try {
        const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: `trae-cn|${parsed.modelId}` });
        if (decision && !decision.allowed) throw new SendBudgetExhaustedError();
        incoming.beforePhysicalSend?.();
        if (decision?.allowed && !decision.permit.use()) throw new SendBudgetExhaustedError();
        const session = await openTraeSession(provider.baseUrl, deps);
        incoming.onPhysicalSend?.({ ordinal: 1 });
        try {
          await session.prompt(parsed.modelId, replayText(parsed), emit, incoming.abortSignal);
        } finally {
          await session.close();
        }
      } catch (error) {
        if (error instanceof SendBudgetExhaustedError) throw error;
        emit(errorEvent(error));
      } finally {
        producer?.close();
      }
    },
  };
}
