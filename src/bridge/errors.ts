import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  type OcxErrorPayload,
} from "../lib/errors";

export function formatErrorResponse(
  status: number,
  type: string,
  message: string,
  options?: { code?: string | null; retryAfter?: string | null },
): Response {
  const error = classifyError(status, type, message);
  if (isCyberPolicyCode(options?.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(type);
  }
  const finalStatus = error.code === CYBER_POLICY_ERROR_CODE ? 400 : status;
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = options?.retryAfter?.trim();
  if (error.code !== CYBER_POLICY_ERROR_CODE
    && retryAfter
    && retryAfter.length > 0
    && retryAfter.length <= 128) {
    headers.set("Retry-After", retryAfter);
  }
  return new Response(JSON.stringify({ error }), {
    status: finalStatus,
    headers,
  });
}
