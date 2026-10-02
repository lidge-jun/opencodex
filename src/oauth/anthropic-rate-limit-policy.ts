/** Response-header policy for managed Anthropic sends; no account or request payload data. */
export type AnthropicRateLimitKind = "shared-quota" | "family-quota" | "transient-rate" | "request-scoped-unknown";
export type RateLimitHeaders = Pick<Headers, "get">;
export const ANTHROPIC_SHORT_RETRY_MS = 100;
export const ANTHROPIC_MAX_INLINE_THROTTLE_MS = 1_000;

export function anthropicRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text || text.length > 128) return undefined;
  const at = /^\d+(?:\.\d+)?$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(new Date(at).getTime()) && at > now ? Math.ceil(at - now) : undefined;
}

export function classifyAnthropic429(headers: RateLimitHeaders, now = Date.now()): AnthropicRateLimitKind {
  const rejected = (window: string) => headers.get(`anthropic-ratelimit-unified-${window}-status`)?.trim() === "rejected";
  if (rejected("5h") || rejected("7d")) return "shared-quota";
  if (rejected("7d_oi")) return "family-quota";
  if (headers.get("anthropic-ratelimit-unified-status")?.trim() === "rejected") return "shared-quota";
  // Retry-After is an account-local admission pause, not proof of spent subscription quota.
  if (anthropicRetryAfterMs(headers.get("retry-after"), now) !== undefined
    || headers.get("anthropic-ratelimit-unified-status")?.trim() === "allowed") return "transient-rate";
  return "request-scoped-unknown";
}

const pauses = new Map<string, number>();
export function pauseAnthropicRateAdmission(accountId: string, until: number): void {
  const now = Date.now();
  for (const [id, deadline] of pauses) if (deadline <= now) pauses.delete(id);
  pauses.set(accountId, Math.max(pauses.get(accountId) ?? 0, until));
}
export function anthropicRatePauseUntil(accountId: string, now = Date.now()): number | undefined {
  const until = pauses.get(accountId);
  if (until === undefined) return undefined;
  if (until <= now) { pauses.delete(accountId); return undefined; }
  return until;
}
export function clearAnthropicRatePauses(): void { pauses.clear(); }
