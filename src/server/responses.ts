// AUTO-SPLIT facade: original responses.ts body moved into ./responses/* modules.
// Public surface preserved exactly; importers keep using "src/server/responses".
import { handleResponsesCompact as handleResponsesCompactImpl } from "./responses/compact";
import { requestPacingOverloadResponse } from "./responses/pacing-overload";

export { buildToolBridgeMaps, isV1CollabSurface, collabSurface, multiAgentGuidanceText, V2_GUIDANCE_CHAR_BUDGET, injectDeveloperMessage } from "./responses/collaboration";
export type { MultiAgentGuidanceOptions, MultiAgentGuidanceDeps } from "./responses/collaboration";
export { hasUnreadableEncryptedAgentTask, sanitizeEncryptedContentInPlace } from "./responses/encrypted-payload";
export { COMPACT_RESPONSE_MAX_BYTES, bufferCompactResponse } from "./responses/compact";
export { disableResponsesRequestTimeout, safeHostLabel, fetchWithHeaderTimeout } from "./responses/fetch-helpers";
export { sidecarOutcomeRecorder, isShadowSourceModel, codexLogAccountId, usesCodexForwardPoolAuth, codexForwardTerminalOutcomeRecorder, decodeRequestErrorResponse, buildComboChildHeaders, linkAbortSignal } from "./responses/core";
export { handleResponses, handleResponsesWithPolicyFallback, rankPolicyFallbackCandidates } from "./responses/policy-fallback";
export { adapterNeedsForcedContinuation } from "./responses/core";

export async function handleResponsesCompact(
  ...args: Parameters<typeof handleResponsesCompactImpl>
): Promise<Response> {
  try {
    return await handleResponsesCompactImpl(...args);
  } catch (error) {
    const overload = requestPacingOverloadResponse(error);
    if (overload) return overload;
    throw error;
  }
}
