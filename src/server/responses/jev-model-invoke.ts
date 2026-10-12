import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { JevModelInvokeError, type JevModelInvoke, type JevModelInvokeResult } from "../../combos/jev-model-backend";
import { JEV_MAX_REQUEST_BYTES, JEV_MAX_RESPONSE_BYTES } from "../../combos/jev";
import type { OcxConfig } from "../../types";
import { codexEffortRank, isCodexReasoningEffort } from "../../reasoning-effort";
import { routeConcreteModel } from "../../router";
import { supportedLadderFor } from "../effort-policy";
import { createInferenceSendBudget } from "../inference/context";
import { tryAdmitTurn } from "../lifecycle";
import type { RequestLogContext } from "../request-log";
import { createSseInspector } from "../relay";
import type { HandleResponsesOptions } from "./core-options";

type HandleResponses = (
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options?: HandleResponsesOptions,
) => Promise<Response>;

export interface JevModelInvokerContext {
  /** The request that owns the combo; only its spend root is reused, never its headers. */
  req: Pick<Request, "headers">;
  config: OcxConfig;
  /** Parent options: only the typed admission scope and Codex auth policy cross over. */
  options: Pick<HandleResponsesOptions, "admission" | "codexAuthPolicy">;
  handleResponses: HandleResponses;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Concatenate assistant message text from a Responses output array. */
function messageOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function responseUsage(response: Record<string, unknown>): Record<string, number> | undefined {
  if (!isRecord(response.usage)) return undefined;
  const usage: Record<string, number> = {};
  for (const key of ["input_tokens", "output_tokens"] as const) {
    const value = response.usage[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function terminalResult(response: Record<string, unknown>, deltaText: string): JevModelInvokeResult {
  if (response.error !== undefined && response.error !== null) throw new JevModelInvokeError("http", "decision model failed");
  if (response.status !== "completed") throw new JevModelInvokeError("malformed", "decision model did not complete");
  const text = messageOutputText(response.output) ?? deltaText;
  const usage = responseUsage(response);
  return { text, ...(usage ? { usage } : {}) };
}

function decodeSse(bytes: Uint8Array): JevModelInvokeResult {
  let completed: Record<string, unknown> | undefined;
  let terminal: string | undefined;
  let deltaText = "";
  const inspector = createSseInspector({
    onTerminal: status => { terminal ??= status; },
    onCompletedResponse: value => { if (isRecord(value)) completed = value; },
    onParsedPayload: payload => {
      if (isRecord(payload) && payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
        deltaText += payload.delta;
      }
    },
  });
  try {
    inspector.feed(bytes);
    inspector.finish();
  } finally {
    inspector.dispose();
  }
  if (terminal !== "completed" || !completed) {
    throw new JevModelInvokeError(terminal === "failed" ? "http" : "malformed", "decision model did not complete");
  }
  return terminalResult({ ...completed, status: completed.status ?? "completed" }, deltaText);
}

/**
 * The answer is one short JSON object, so the decision turn carries its own output ceiling. It
 * bounds billed output (including reasoning) and gives the spend reservation a nonzero ceiling;
 * a truncated answer is malformed and fails open like any other bad reply.
 */
export const JEV_MODEL_MAX_OUTPUT_TOKENS = 1024;

/**
 * The cheapest reasoning effort the decision model declares, so a reasoning model cannot spend
 * the whole output ceiling thinking before it writes the JSON answer. A model with no known
 * ladder gets no reasoning field at all: some OpenAI-compatible servers reject one they do not
 * support, and an unknown capability is not evidence that the field is safe to send.
 */
export function jevDecisionReasoningEffort(config: OcxConfig, model: string): string | undefined {
  let ladder: string[] | undefined;
  try {
    const route = routeConcreteModel(config, model);
    ladder = supportedLadderFor({ provider: route.provider, modelId: route.modelId });
  } catch {
    return undefined;
  }
  const rankable = (ladder ?? []).filter(isCodexReasoningEffort);
  if (rankable.length === 0) return undefined;
  if (rankable.includes("low")) return "low";
  return rankable.reduce((lowest, effort) => (codexEffortRank(effort) < codexEffortRank(lowest) ? effort : lowest));
}

/**
 * Build the invoker that runs one decision prompt as an internal Responses turn through the
 * normal router. The decision request is its own logical request: a fresh turn lease and send
 * budget, a detached log context whose spend tracker is settled here, and no caller credential
 * or conversation header. It therefore runs on credentials configured on provider rows only.
 */
export function createJevModelInvoker(context: JevModelInvokerContext): JevModelInvoke {
  return async ({ model, instructions, input, signal }) => {
    const effort = jevDecisionReasoningEffort(context.config, model);
    const body = JSON.stringify({
      model,
      stream: true,
      store: false,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
      tools: [],
      max_output_tokens: JEV_MODEL_MAX_OUTPUT_TOKENS,
      ...(effort ? { reasoning: { effort } } : {}),
    });
    if (new TextEncoder().encode(body).byteLength > JEV_MAX_REQUEST_BYTES) {
      throw new JevModelInvokeError("malformed", "decision request too large");
    }
    const lease = tryAdmitTurn(undefined, signal);
    if (!lease) throw new JevModelInvokeError("network", "decision turn not admitted");
    const childLog: RequestLogContext = { model, provider: "unknown", inboundProtocol: "responses" };
    let usage: Record<string, number> | undefined;
    try {
      const request = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      });
      const response = await context.handleResponses(request, context.config, childLog, {
        abortSignal: signal,
        ...(context.options.admission ? { admission: context.options.admission } : {}),
        ...(context.options.codexAuthPolicy ? { codexAuthPolicy: context.options.codexAuthPolicy } : {}),
        // Explicit nulls: handleResponses captures caller credentials only when these are undefined.
        callerDirectAuth: null,
        openAiSidecarAuth: null,
        nativeCallerAuth: null,
        sendBudget: createInferenceSendBudget(context.req, childLog),
        turnAdmissionLease: lease,
        internalDecisionCall: true,
      });
      if (!response.ok) {
        try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
        throw new JevModelInvokeError("http", `decision model returned ${response.status}`);
      }
      const bounded = await readBoundedResponseBytes(response, { maxBytes: JEV_MAX_RESPONSE_BYTES, signal });
      if (bounded.oversized) throw new JevModelInvokeError("malformed", "decision response too large");
      const result = response.headers.get("content-type")?.includes("text/event-stream")
        ? decodeSse(bounded.bytes)
        : (() => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes));
          } catch {
            throw new JevModelInvokeError("malformed", "decision response is not JSON");
          }
          if (!isRecord(parsed)) throw new JevModelInvokeError("malformed", "decision response is not an object");
          return terminalResult(parsed, "");
        })();
      usage = result.usage;
      return result;
    } finally {
      // No final log row is written for this detached context, so settle its spend here.
      childLog.spendTracker?.settle(childLog.usage ?? (usage
        ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
        : undefined));
      lease.release();
    }
  };
}
