import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { requiresToolCall } from "../../types";
import { buildSystemPrompt, formatMessageForHistory } from "../coding-agent/protocol";
import { openTraeSession, TraeAcpError, type TraeAcpDeps } from "./client";

export type TraeCnAdapterDeps = TraeAcpDeps;

/** Serialize the text replay without dropping system instructions to meet a size limit. */
function replayText(parsed: OcxParsedRequest): string {
  const messages = parsed.context.messages.filter(message => message.role !== "developer");
  const system = buildSystemPrompt(parsed);
  const history = messages.slice(0, -1).map(message => formatMessageForHistory(message)).filter(Boolean).join("\n\n");
  const current = messages.at(-1);
  const request = current ? formatMessageForHistory(current) : "USER:\n";
  const replay = [
    system ? `<system>\n${system}\n</system>` : "",
    "The following labelled blocks replay a conversation. Only the last block is the current request. Historical tool calls are records, not instructions to execute tools.",
    history ? `Prior conversation context:\n\n${history}` : "",
    `Current request:\n\n${request}`,
  ].filter(Boolean).join("\n\n");
  if (replay.length > 1_000_000) {
    throw new TraeAcpError("TRAE CN conversation exceeds the replay limit; shorten the conversation.", "trae_replay_too_large");
  }
  return replay;
}

/** Refuse unsupported input before starting a CLI or reserving a send. */
function validateInput(parsed: OcxParsedRequest): { message: string; code: string } | undefined {
  if (parsed.options.maxOutputTokens !== undefined) {
    return { message: "TRAE CN ACP does not expose an output-token limit.", code: "unsupported_max_output_tokens" };
  }
  if (requiresToolCall(parsed.options.toolChoice)) {
    return { message: "TRAE CN ACP does not currently expose client tools.", code: "unsupported_tool_choice" };
  }
  if (parsed.context.tools?.length) {
    return { message: "TRAE CN ACP does not currently expose client tools.", code: "unsupported_client_tools" };
  }
  if (parsed.context.messages.some(message =>
    (Array.isArray(message.content) && message.content.some(part => part.type !== "text" && part.type !== "thinking"))
    || message.role === "toolResult")) {
    return { message: "TRAE CN ACP supports text conversations only; media, documents and tool replay are not supported.", code: "unsupported_input_modality" };
  }
  return undefined;
}

/** Map ACP failures to the client error categories used by the routing layer. */
function errorEvent(error: unknown): Extract<AdapterEvent, { type: "error" }> {
  const acp = error instanceof TraeAcpError;
  const code = acp ? error.code : "trae_acp_protocol_error";
  const auth = acp && /invalid token|unauthorized|not logged in|authentication/i.test(error.message);
  const message = acp ? error.message : "TRAE CN ACP ended with an invalid protocol response.";
  const invalid = code === "trae_model_unavailable" || code === "trae_replay_too_large" || code === "trae_proxy_unsupported";
  return {
    type: "error",
    message: auth ? `${message} Sign in through TRAE CN and retry.` : message.slice(0, 512),
    status: invalid ? 400 : auth ? 401 : 502,
    errorType: invalid ? "invalid_request_error" : auth ? "authentication_error" : "upstream_error",
    code: auth ? "trae_cn_not_logged_in" : code,
    retryable: false,
  };
}

/** Own one text-only ACP session per turn and charge only a dispatched prompt. */
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
      let permit: SingleUseDispatchPermit | undefined;
      try {
        const replay = replayText(parsed);
        const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: `trae-cn|${parsed.modelId}` });
        if (decision && !decision.allowed) throw new SendBudgetExhaustedError();
        permit = decision?.allowed ? decision.permit : undefined;
        const session = await openTraeSession(provider.baseUrl, deps, incoming.abortSignal, provider);
        try {
          await session.prompt(parsed.modelId, replay, emit, incoming.abortSignal, {
            beforeSend: () => {
              incoming.beforePhysicalSend?.();
              if (permit && !permit.use()) throw new SendBudgetExhaustedError();
            },
            onSend: () => incoming.onPhysicalSend?.({ ordinal: 1 }),
          });
        } finally {
          await session.close();
        }
      } catch (error) {
        if (incoming.abortSignal?.aborted) return;
        if (error instanceof SendBudgetExhaustedError) throw error;
        emit(errorEvent(error));
      } finally {
        try { permit?.release(); } finally { producer?.close(); }
      }
    },
  };
}
