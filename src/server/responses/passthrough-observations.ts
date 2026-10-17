import { readCodexWsStage } from "./codex-ws-wire";
import type { RequestLogContext } from "../request-log";

/**
 * #4191: a Codex WS exchange pins its content-free stage record on the
 * Response it resolves (markCodexWsStage). Adopting the record here, at
 * the single funnel every physical upstream response passes through,
 * binds it to the attempt that actually served it — including the 502/504
 * pre-response JSON settles that never reach the SSE relay.
 */
export function adoptCodexWsStage(response: Response, logCtx: RequestLogContext): void {
  const stage = readCodexWsStage(response);
  if (stage && logCtx.activeAttempt) logCtx.activeAttempt.codexWsStage = stage;
}

import type { CodexAuthContext } from "../../codex/auth-context";
import type { RouteResult } from "../../router";
import { captureCodexAffinityDiagnostic } from "../../codex/affinity-debug";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../../codex/catalog/native-models";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isFixedCodexAccount } from "./core-codex-account";

export function capturePassthroughAffinity(response: Response, inboundHeaders: Headers, outboundHeaders: Record<string, string>,
  captureAuthCtx: CodexAuthContext, route: Pick<RouteResult, "provider" | "modelId" | "codexAccountMode">,
  parsedModelId: string, credentialSubstituted: boolean): void {
  if (!isCanonicalOpenAiForwardProvider(route.provider)) return;
  captureCodexAffinityDiagnostic({
    inboundHeaders: inboundHeaders,
    outboundHeaders: outboundHeaders,
    authKind: captureAuthCtx.kind,
    accountMode: route.codexAccountMode,
    fixedAccount: isFixedCodexAccount(captureAuthCtx),
    credentialSubstituted,
    accountGatedModel: ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId),
    wireModelNormalized: parsedModelId !== route.modelId,
    status: response.status,
  });
}
