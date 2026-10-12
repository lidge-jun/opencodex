import { bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import type { AdmissionLease } from "../../lib/admission";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent } from "../../types";
import { extractPolicyRefusalText, isUpstreamPolicyRefusal } from "../../lib/errors";
import { trackStreamLifetime } from "../lifecycle";

async function* policyRefusalEvents(message: string): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: message };
  yield { type: "done", stopReason: "content_filter" };
}

/**
 * Turn an xAI-style HTTP 403 model refusal into a Codex-facing Responses
 * incomplete/content_filter payload. Returned from `prepareAdapterExchange`
 * and native openai-responses passthrough (the grok-4.6 OAuth wire), like
 * the 413 overflow helpers. Combo hops still see the original 403.
 *
 * The streamed form is a delivered turn, so it carries the turn admission lease
 * the way every other streaming return does: the lease is released when the body
 * finishes or the client disconnects, not when the handler returns.
 *
 * Only an xAI destination is rewritten. Another provider's 403 may carry the same
 * sentence for an unrelated reason, and turning it into a successful turn would hide it.
 */
export function rewriteUpstreamPolicyRefusal(args: {
  status: number;
  errorText: string;
  stream: boolean;
  modelId: string;
  /** `isXaiResponsesDestination(route.provider)`: api.x.ai or the Grok CLI proxy. */
  destinationIsXai: boolean;
  translatorBudget: TranslatorBudget;
  turnAdmissionLease?: AdmissionLease;
}): Response | null {
  if (!args.destinationIsXai || !isUpstreamPolicyRefusal(args.status, args.errorText)) return null;
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
  const sse = bridgeToResponsesSSE(
    policyRefusalEvents(message),
    args.modelId,
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { translatorBudget: args.translatorBudget },
  );
  return new Response(trackStreamLifetime(sse, new AbortController(), undefined, args.turnAdmissionLease), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
