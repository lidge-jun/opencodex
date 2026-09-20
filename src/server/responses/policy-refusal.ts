import { bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent } from "../../types";
import { extractPolicyRefusalText, isUpstreamPolicyRefusal } from "../../lib/errors";

async function* policyRefusalEvents(message: string): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: message };
  yield { type: "done", stopReason: "content_filter" };
}

/**
 * Turn an xAI-style HTTP 403 model refusal into a Codex-facing Responses
 * incomplete/content_filter payload. Returned from `prepareAdapterExchange`
 * and native openai-responses passthrough (the grok-4.6 OAuth wire), like
 * the 413 overflow helpers. Combo hops still see the original 403.
 */
export function rewriteUpstreamPolicyRefusal(args: {
  status: number;
  errorText: string;
  stream: boolean;
  modelId: string;
  translatorBudget: TranslatorBudget;
}): Response | null {
  if (!isUpstreamPolicyRefusal(args.status, args.errorText)) return null;
  const message = extractPolicyRefusalText(args.errorText);
  if (!args.stream) {
    const json = buildResponseJSON(
      [
        { type: "text_delta", text: message },
        { type: "done", stopReason: "content_filter" },
      ],
      args.modelId,
      { translatorBudget: args.translatorBudget },
    );
    return Response.json(json, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(bridgeToResponsesSSE(
    policyRefusalEvents(message),
    args.modelId,
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { translatorBudget: args.translatorBudget },
  ), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
