export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

export interface OcxErrorHints {
  code?: string | null;
  errorType?: string | null;
}

function normalizedHint(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function hintSet(type: string, hints?: OcxErrorHints): Set<string> {
  return new Set([type, hints?.code, hints?.errorType].map(normalizedHint).filter((v): v is string => !!v));
}

/* [Decision Log]
- 목적: upstream 오류를 Codex 호환 error code로 변환하되, provider 메시지에 섞인 "rate limit" 문구만으로 가짜 429를 만들지 않기 위함.
- 대안 분석: (1) 기존처럼 message substring만 사용하면 간단하지만 Umans 같은 compatibility provider에서 false rate-limit이 발생한다. (2) 모든 upstream error를 그대로 passthrough하면 Codex가 context/quota/auth 오류를 제대로 인식하지 못한다. (3) HTTP status와 구조화된 provider code/type을 우선하고, message fallback은 context/auth/overload처럼 덜 모호한 오류에만 남긴다.
- 선택 근거: adapter가 보존한 status/code/type을 신뢰하면 실제 429와 연결 끊김/일반 upstream 실패를 구분할 수 있고, 기존 Codex 호환 error envelope는 유지된다.
*/
export function classifyError(status: number, type: string, message: string, hints?: OcxErrorHints): OcxErrorPayload {
  const text = message.toLowerCase();
  const ids = hintSet(type, hints);
  if (
    ids.has("context_length_exceeded") ||
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (
    ids.has("insufficient_quota") ||
    status === 402 ||
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("quota exhausted") ||
    text.includes("account quota exceeded") ||
    text.includes("monthly quota exceeded") ||
    text.includes("daily quota exceeded")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (
    status === 429 ||
    ids.has("rate_limit_error") ||
    ids.has("rate_limit_exceeded") ||
    ids.has("too_many_requests") ||
    ids.has("throttlingexception") ||
    ids.has("resource_exhausted")
  ) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (type === "origin_rejected") {
    return { message, type: "invalid_request_error", code: "origin_rejected" };
  }
  if (
    status === 401 ||
    status === 403 ||
    type === "authentication_error" ||
    ids.has("authentication_error") ||
    ids.has("invalid_api_key") ||
    ids.has("unauthenticated") ||
    ids.has("unauthenticated_error") ||
    ids.has("permission_denied") ||
    text.includes("authentication failed") ||
    text.includes("access denied") ||
    text.includes("unauthorizedexception") ||
    text.includes("unrecognizedclientexception") ||
    text.includes("unrecognizedclient") ||
    text.includes("expired token") ||
    text.includes("expiredtoken")
  ) {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  if (
    status === 503 ||
    ids.has("server_is_overloaded") ||
    ids.has("unavailable") ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (
    ids.has("invalid_request_error") ||
    ids.has("invalid_argument") ||
    ids.has("bad_request") ||
    ids.has("not_found") ||
    text.includes("validationexception") ||
    text.includes("invalid request") ||
    text.includes("model unavailable") ||
    text.includes("model not found") ||
    text.includes("unsupported model") ||
    text.includes("profile arn") ||
    text.includes("wrong region") ||
    text.includes("invalid region")
  ) {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}
