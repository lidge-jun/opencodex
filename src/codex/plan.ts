import { decodeJwtPayload } from "../oauth/chatgpt";

/** Preserve user/provider plan labels only when they are usable strings. */
export function codexPlanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

/** Case-insensitive key used by quota, capacity, and collision policy. */
export function codexPlanKey(value: unknown): string | undefined {
  return codexPlanValue(value)?.trim().toLowerCase();
}

export function isThirtyDayOnlyCodexPlan(value: unknown): boolean {
  const key = codexPlanKey(value);
  return key === "go" || key === "free";
}

/**
 * ChatGPT plan label from a live access/id token (`chatgpt_plan_type`).
 * Used when WHAM has not run yet so a stale stored `free` cannot outrank the token (#1989).
 */
export function extractChatgptPlanType(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.chatgpt_plan_type === "string") {
      const plan = codexPlanValue(payload.chatgpt_plan_type);
      if (plan) return plan;
    }
    const ns = payload["https://api.openai.com/auth"];
    if (ns && typeof ns === "object") {
      const nested = (ns as Record<string, unknown>).chatgpt_plan_type;
      const plan = codexPlanValue(nested);
      if (plan) return plan;
    }
  }
  return undefined;
}
