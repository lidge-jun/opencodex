import type {
  ResponsesRequestContext,
  ResponsesAdmissionState,
  PassthroughAdmissionState,
} from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import { preparePassthroughExchange } from "./passthrough-dispatch";
import { deliverPassthroughResponse } from "./passthrough-delivery";
import { releaseUpstreamHostAdmission } from "../../codex/upstream-host-health";
import { releaseCodexAuthContextProbeLease } from "../../codex/auth-context";

/** Owns the native host lease across dispatch, recovery, and response construction. */
export async function executePassthroughResponse(
  requestContext: ResponsesRequestContext,
  admissionState: ResponsesAdmissionState,
  requestState: PreparedResponsesRequest,
  transportState: ResponsesTransport,
  sidecarState: ResponsesSidecarAuth,
  responseEffects: ResponsesEffects,
  sendBudgetState: ResponsesSendBudget,
): Promise<Response> {
  const nativeHostState: PassthroughAdmissionState = { lease: admissionState.pendingHostAdmissionLease };
  admissionState.pendingHostAdmissionLease = null;
  try {
    const nativeExchange = await preparePassthroughExchange(
      requestContext,
      admissionState,
      nativeHostState,
      requestState,
      transportState,
      responseEffects,
      sendBudgetState,
    );
    if (nativeExchange instanceof Response) return nativeExchange;
    return await deliverPassthroughResponse(
      requestContext,
      admissionState,
      requestState,
      transportState,
      sidecarState,
      responseEffects,
      nativeExchange,
    );
  } finally {
    if (nativeHostState.lease) {
      releaseUpstreamHostAdmission(nativeHostState.lease);
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
    }
  }
}
