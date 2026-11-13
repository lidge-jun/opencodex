import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import { SpendLedgerFileRefusedError } from "../../lib/spend-reservation-ledger";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { requiresToolCall } from "../../types";
import { buildSystemPrompt, formatMessageForHistory } from "../coding-agent/protocol";
import { openTraeSession, TraeAcpError, type TraeAcpDeps } from "./client";
import { responsesHasFileImage } from "../claude-cli/instruction-images";
import { responsesHasUnsupportedInputMedia } from "./input-media";

export type TraeCnAdapterDeps = TraeAcpDeps;

/** Serialize the text replay without dropping system instructions to meet a size limit. */
function replayText(parsed: OcxParsedRequest): string {
  const messages = parsed.context.messages;
  const system = buildSystemPrompt(parsed);
  const currentIndex = messages.findLastIndex(message => message.role !== "developer");
  const ordered = messages.map(message => message.role === "developer"
    ? "DEVELOPER:\n" + (typeof message.content === "string" ? message.content
      : message.content.map(part => part.type === "text" ? part.text : "").join(""))
    : formatMessageForHistory(message));
  const history = (currentIndex < 0 ? ordered : ordered.slice(0, currentIndex)).filter(Boolean).join("\n\n");
  const request = currentIndex < 0 ? "USER:\n" : ordered.slice(currentIndex).filter(Boolean).join("\n\n");
  const replay = [
    system ? `<system>\n${system}\n</system>` : "",
    "The following labelled blocks replay a conversation. The last non-developer block is the current request. Developer blocks retain their instruction priority and record their original position. Historical tool calls are records, not instructions to execute tools.",
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
  if (responsesHasUnsupportedInputMedia(parsed._rawBody) || responsesHasFileImage(parsed._rawBody)
    || parsed.context.messages.some(message =>
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
  const clientCode = code === "trae_model_unavailable" ? "model_unavailable" : code;
  const auth = acp && /invalid token|unauthorized|not logged in|authentication/i.test(error.message);
  const message = acp ? error.message : "TRAE CN ACP ended with an invalid protocol response.";
  const invalid = code === "trae_model_unavailable" || code === "trae_replay_too_large" || code === "trae_proxy_unsupported";
  const startup = code.startsWith("trae_startup_");
  return {
    type: "error",
    message: auth ? `${message} Sign in through TRAE CN and retry.` : message.slice(0, 512),
    status: invalid ? 400 : auth ? 401 : startup ? 500 : 502,
    errorType: invalid ? "invalid_request_error" : auth ? "authentication_error" : startup ? "server_error" : "upstream_error",
    code: auth ? "trae_cn_not_logged_in" : clientCode,
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
      let terminal: Extract<AdapterEvent, { type: "done" | "incomplete" | "error" }> | undefined;
      let promptFailure: unknown;
      let cancelledUsageEmitted = false;
      /** Report received usage once when cancellation replaces the pending terminal outcome. */
      const emitCancelledUsage = () => {
        const usage = terminal?.usage ?? (promptFailure instanceof TraeAcpError ? promptFailure.usage : undefined);
        if (!usage || cancelledUsageEmitted) return;
        cancelledUsageEmitted = true;
        emit({ type: "incomplete", reason: "client_cancelled", usage, retryable: false });
      };
      try {
        const replay = replayText(parsed);
        const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: `trae-cn|${parsed.modelId}` });
        if (decision && !decision.allowed) throw new SendBudgetExhaustedError();
        permit = decision?.allowed ? decision.permit : undefined;
        const session = await openTraeSession(provider.baseUrl, deps, incoming.abortSignal, provider);
        let cleanupFailure: unknown;
        try {
          await session.prompt(parsed.modelId, replay, event => {
            if (event.type === "done" || event.type === "incomplete" || event.type === "error") terminal = event;
            else emit(event);
          }, incoming.abortSignal, {
            beforeSend: () => {
              incoming.beforePhysicalSend?.();
              if (permit && !permit.use()) throw new SendBudgetExhaustedError();
            },
            onSend: () => {
              emit({ type: "heartbeat", replayUnsafe: true });
              incoming.onPhysicalSend?.({ ordinal: 1 });
            },
          });
        } catch (error) { promptFailure = error; }
        try { await session.close(); } catch (error) { cleanupFailure = error; }
        if (promptFailure instanceof SendBudgetExhaustedError || promptFailure instanceof SpendLedgerFileRefusedError) {
          throw promptFailure;
        }
        if (cleanupFailure) {
          const usage = promptFailure instanceof TraeAcpError ? promptFailure.usage : undefined;
          if (cleanupFailure instanceof TraeAcpError && usage && !cleanupFailure.usage) {
            throw new TraeAcpError(cleanupFailure.message, cleanupFailure.code, usage);
          }
          throw cleanupFailure;
        }
        if (promptFailure) throw promptFailure;
        if (incoming.abortSignal?.aborted) emitCancelledUsage();
        else if (terminal) emit(terminal);
      } catch (error) {
        if (incoming.abortSignal?.aborted) { emitCancelledUsage(); return; }
        if (error instanceof SendBudgetExhaustedError || error instanceof SpendLedgerFileRefusedError) throw error;
        const usage = terminal?.usage ?? (error instanceof TraeAcpError ? error.usage : undefined);
        emit({ ...errorEvent(error), ...(usage ? { usage } : {}) });
      } finally {
        try { permit?.release(); } finally { producer?.close(); }
      }
    },
  };
}
