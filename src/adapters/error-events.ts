import type { AdapterEvent } from "../types";

type ErrorEnvelope = {
  message?: unknown;
  code?: unknown;
  type?: unknown;
  status?: unknown;
  error?: unknown;
};

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

export function statusFromErrorIdentifiers(code?: string | null, errorType?: string | null): number | undefined {
  const ids = new Set([code, errorType].map(value => normalized(value ?? undefined)).filter((value): value is string => !!value));
  if (ids.has("rate_limit_error") || ids.has("rate_limit_exceeded") || ids.has("too_many_requests") || ids.has("throttlingexception") || ids.has("resource_exhausted")) return 429;
  if (ids.has("insufficient_quota") || ids.has("quota_exceeded") || ids.has("billing_hard_limit_reached")) return 402;
  if (ids.has("authentication_error") || ids.has("invalid_api_key") || ids.has("unauthenticated") || ids.has("unauthenticated_error")) return 401;
  if (ids.has("permission_denied") || ids.has("access_denied")) return 403;
  if (ids.has("invalid_request_error") || ids.has("invalid_argument") || ids.has("bad_request")) return 400;
  if (ids.has("not_found")) return 404;
  if (ids.has("server_is_overloaded") || ids.has("unavailable")) return 503;
  return undefined;
}

/* [Decision Log]
- 목적: streaming provider 오류가 200 OK 안쪽의 JSON/SSE frame으로 도착해도 실제 provider code/type/status를 잃지 않도록 한다.
- 대안 분석: (1) 각 adapter에서 message string만 조립하면 기존 구현은 작지만 false 429와 연결 끊김 오분류가 반복된다. (2) provider별 error payload를 bridge까지 그대로 노출하면 타입이 퍼지고 redaction 책임이 흐려진다. (3) 공통 helper가 OpenAI/Anthropic/Google 계열 envelope를 작은 AdapterEvent metadata로 정규화한다.
- 선택 근거: bridge와 classifier는 하나의 작은 계약만 알면 되고, provider별 parser는 기존 위치에서 안전하게 metadata만 추가하면 된다.
*/
export function errorEventFromEnvelope(error: unknown, fallbackMessage = "upstream error"): Extract<AdapterEvent, { type: "error" }> {
  const envelope = (error && typeof error === "object" ? error : {}) as ErrorEnvelope;
  const nested = envelope.error && typeof envelope.error === "object" ? envelope.error as ErrorEnvelope : undefined;
  const source = nested ?? envelope;
  const message = safeString(source.message) ?? safeString(envelope.message) ?? fallbackMessage;
  const code = safeString(source.code);
  const errorType = safeString(source.type) ?? safeString(source.status);
  const status = numericStatus(source.status) ?? numericStatus(source.code) ?? statusFromErrorIdentifiers(code, errorType);
  return {
    type: "error",
    message,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
  };
}

export function errorEvent(message: string, metadata: Omit<Extract<AdapterEvent, { type: "error" }>, "type" | "message"> = {}): Extract<AdapterEvent, { type: "error" }> {
  return { type: "error", message, ...metadata };
}
