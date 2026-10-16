import type { RequestLogContext } from "../request-log";
import { ADVISOR_INTERNAL_CAPABILITY_HEADER, isInternalCallCapability } from "../../lib/local-internal-call-capability";

export const ADVISOR_REASONING_HEADER = "x-opencodex-advisor-reasoning";
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** Native Chat sends the finalized body directly instead of the translating adapter builder. */
export function observeAdvisorNativeReasoning(headers: Headers, log: RequestLogContext, body: string): void {
  if (!isInternalCallCapability(headers.get(ADVISOR_INTERNAL_CAPABILITY_HEADER))) return;
  delete log.effectiveEffort;
  try {
    const effort = JSON.parse(body)?.reasoning_effort;
    if (typeof effort === "string" && EFFORTS.has(effort)) log.effectiveEffort = effort;
  } catch { /* absence of evidence stays unreported */ }
}

/** Only the authenticated internal caller receives adapter-owned serialization evidence. */
export function attachAdvisorReasoning(response: Response, log: RequestLogContext): Response {
  const headers = new Headers(response.headers);
  headers.set(ADVISOR_REASONING_HEADER, JSON.stringify({
    effectiveEffort: log.effectiveEffort && EFFORTS.has(log.effectiveEffort) ? log.effectiveEffort : null,
  }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function readAdvisorReasoning(headers: Headers): string | null {
  try {
    const value = JSON.parse(headers.get(ADVISOR_REASONING_HEADER) ?? "null")?.effectiveEffort;
    return typeof value === "string" && EFFORTS.has(value) ? value : null;
  } catch { return null; }
}
