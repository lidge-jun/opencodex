import type { AdapterEvent } from "../../types";
import type { IncomingMeta, ProviderAdapter } from "../base";
import { MuseMspError } from "./connection";
import { MuseSegmentError } from "./segment";
import type { MuseMspRunner } from "./runner";
import type { MuseToolResult } from "./tool-result";
import { endsWithMuseToolResult } from "./developer-continuation";

/** Unregistered runTurn bridge; the caller must retain and close the shared runner. */
export function createMuseMspAdapter(runner: Pick<MuseMspRunner, "run"> & Partial<Pick<MuseMspRunner, "onResponseRendered">>, timeoutMs = 60_000, experimentalGate?: {
  run: <T>(incoming: IncomingMeta, execute: (hooks?: { beforeDispatch?: () => void; beforeResultCommit?: (result: Readonly<MuseToolResult>) => void; beforeUserDispatch?: (text: string) => void }) => Promise<T>, context: { continuation: boolean; userContinuation: boolean }) => Promise<T>;
}): ProviderAdapter {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new MuseMspError("invalid_timeout");
  return {
    name: "muse-msp",
    // The supplied gate reports opaque segment dispatches. It cannot observe the
    // number of physical model requests that Muse sends within each segment.
    ...(experimentalGate ? { reportsPhysicalSends: true } : {}),
    ...(runner.onResponseRendered ? { onResponseRendered: (parsed, response) => runner.onResponseRendered!(parsed, response) } : {}),
    buildRequest() { throw new MuseMspError("unsupported_transport"); },
    async *parseStream(): AsyncGenerator<AdapterEvent> { throw new MuseMspError("unsupported_transport"); },
    async runTurn(parsed, incoming, emit) {
      // Muse may issue more than one model request inside an agent turn; this prototype
      // has no authoritative physical-send hook and must not bypass a request send cap.
      if (incoming.sendBudget && !experimentalGate) {
        emit({ type: "error", message: "Muse cannot enforce this request's model-send budget.", status: 400,
          errorType: "invalid_request_error", code: "muse_send_budget_unsupported", retryable: false });
        return;
      }
      try {
        const execute = (hooks?: { beforeDispatch?: () => void; beforeResultCommit?: (result: Readonly<MuseToolResult>) => void; beforeUserDispatch?: (text: string) => void }) => runner.run(parsed, { timeoutMs, signal: incoming.abortSignal, onText: text => emit({ type: "text_delta", text }), ...hooks });
        const events = experimentalGate ? await experimentalGate.run(incoming, execute, { continuation: endsWithMuseToolResult(parsed),
          userContinuation: parsed.context.messages.at(-1)?.role === "user" && parsed.context.messages.some(message => message.role === "assistant") }) : await execute();
        for (const event of events) emit(event);
      } catch (error) {
        // Do not surface CLI diagnostics, prompts, process environment or exception text.
        const code = error instanceof MuseMspError ? error.code : "host_error";
        const invalid = code.startsWith("unsupported_") || code.startsWith("invalid_");
        const strictSpend = code === "unsupported_enforced_spend_budget";
        emit({ type: "error", message: strictSpend ? "Muse cannot enforce this request's configured spend limit."
          : invalid ? "Muse request is not supported." : "Muse session could not be completed.",
          status: invalid ? 400 : 502, errorType: invalid ? "invalid_request_error" : "upstream_error",
          code: strictSpend ? "muse_spend_limit_unsupported" : invalid ? "muse_request_unsupported" : "muse_session_failed", retryable: false,
          ...(error instanceof MuseSegmentError ? { usage: error.usage } : {}) });
      }
    },
  };
}
