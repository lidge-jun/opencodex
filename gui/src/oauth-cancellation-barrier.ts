import { targetFetch, type ApiTargetCapture } from "./api";

import { isServerOwnedLogin } from "./oauth-server-owned-login";

export type OAuthLoginAttempt = ApiTargetCapture & { flowId?: string; cancelRequested?: boolean };

// The capture comes from the original attempt, even after changing targets.
// Scoped cancellations share the start barrier but deduplicate only by flow.
const cancellations = new Map<string, Map<string | undefined, Promise<void>>>();

function barrierKey(capture: ApiTargetCapture, provider: string): string {
  return JSON.stringify([capture.targetKey, capture.apiBase, provider]);
}

export function bindOAuthLoginFlow(attempt: OAuthLoginAttempt, provider: string, flowId: unknown): void {
  if (!isServerOwnedLogin(provider)) return;
  if (typeof flowId !== "string" || !flowId.trim() || flowId.length > 128) throw new Error("Missing login flow ID");
  attempt.flowId = flowId;
  if (attempt.cancelRequested) void cancelOAuthLogin(attempt, provider);
}

export function oauthLoginStatusUrl(apiBase: string, provider: string, flowId?: string): string {
  const query = new URLSearchParams({ provider });
  if (flowId) query.set("flowId", flowId);
  return `${apiBase}/api/oauth/status?${query}`;
}

export function cancelOAuthLogin(capture: OAuthLoginAttempt, provider: string): Promise<void> {
  const { flowId } = capture;
  if (isServerOwnedLogin(provider) && !flowId) {
    // An explicit Cancel can arrive before the start response. Deliver only after
    // that very response names the flow.
    capture.cancelRequested = true;
    return Promise.resolve();
  }
  const key = barrierKey(capture, provider);
  const byFlow = cancellations.get(key) ?? new Map<string | undefined, Promise<void>>();
  const pending = byFlow.get(flowId);
  if (pending) return pending;

  const delivery = (async () => {
    await targetFetch(capture, `${capture.apiBase}/api/oauth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, flowId }),
      keepalive: true,
    });
  })().catch(() => {
    // Preserve best-effort cleanup: a transport failure must not wedge retries.
    // Settlement is an ordering barrier, not proof of server cancellation.
  }).finally(() => {
    byFlow.delete(flowId);
    if (byFlow.size === 0) cancellations.delete(key);
  });
  byFlow.set(flowId, delivery);
  cancellations.set(key, byFlow);
  return delivery;
}

export async function afterOAuthCancellation<T>(
  capture: ApiTargetCapture,
  provider: string,
  start: () => T | Promise<T>,
): Promise<T> {
  const key = barrierKey(capture, provider);
  const pending = cancellations.get(key);
  if (pending) {
    await Promise.all(pending.values());
    return afterOAuthCancellation(capture, provider, start);
  }
  // Check the hook's generation and dispatch in the same turn as the barrier
  // check, so another cancellation cannot slip into an extra await boundary.
  return start();
}
