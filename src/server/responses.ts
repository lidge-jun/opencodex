// AUTO-SPLIT facade: original responses.ts body moved into ./responses/* modules.
// Public surface preserved exactly; importers keep using "src/server/responses".
export { buildToolBridgeMaps, isV1CollabSurface, collabSurface, isToolOutputContinuation, multiAgentGuidanceForRequest, multiAgentGuidanceText, V2_GUIDANCE_CHAR_BUDGET, injectDeveloperMessage } from "./responses/collaboration";
export type { MultiAgentGuidanceOptions, MultiAgentGuidanceDeps } from "./responses/collaboration";
export { hasUnreadableEncryptedAgentTask, sanitizeEncryptedContentInPlace } from "./responses/encrypted-payload";
export { COMPACT_RESPONSE_MAX_BYTES, bufferCompactResponse, handleResponsesCompact } from "./responses/compact";
export { disableResponsesRequestTimeout, safeHostLabel, fetchWithHeaderTimeout } from "./responses/fetch-helpers";
export { sidecarOutcomeRecorder, isShadowSourceModel, codexLogAccountId, usesCodexForwardPoolAuth, codexForwardTerminalOutcomeRecorder, decodeRequestErrorResponse, buildComboChildHeaders, handleResponses, linkAbortSignal } from "./responses/core";
export { adapterNeedsForcedContinuation } from "./responses/core";
