import { targetFetch, type ApiTargetCapture } from "./api";

import { isServerOwnedLogin } from "./oauth-server-owned-login";

export type OAuthLoginAttempt = ApiTargetCapture & { flowId?: string };

type OAuthLoginStartData = {
  url?: string;
  instructions?: string;
  deviceCode?: string;
  browserLaunch?: unknown;
  flowId?: unknown;
};

type OAuthLoginStartResult =
  | { data: OAuthLoginStartData; errorResponse?: never }
  | { data?: never; errorResponse: Response };

// The capture comes from the original attempt, even after changing targets.
// Before a flow ID is available, only the original attempt can be deduplicated.
type CancellationKey = OAuthLoginAttempt | string | undefined;
const cancellations = new Map<string, Map<CancellationKey, Promise<void>>>();
const starting = new WeakMap<ApiTargetCapture, Promise<void>>();

function barrierKey(capture: ApiTargetCapture, provider: string): string {
  return JSON.stringify([capture.targetKey, capture.apiBase, provider]);
}

export function bindOAuthLoginFlow(attempt: OAuthLoginAttempt, provider: string, flowId: unknown): void {
  if (!isServerOwnedLogin(provider)) return;
  if (typeof flowId !== "string" || !flowId.trim() || flowId.length > 128) throw new Error("Missing login flow ID");
  attempt.flowId = flowId;
}

export async function readOAuthLoginStart(
  attempt: OAuthLoginAttempt,
  provider: string,
  response: Response,
): Promise<OAuthLoginStartResult> {
  if (!response.ok) return { errorResponse: response };
  const data = await response.json() as OAuthLoginStartData;
  bindOAuthLoginFlow(attempt, provider, data.flowId);
  return { data };
}

export function oauthLoginStatusUrl(apiBase: string, provider: string, flowId?: string): string {
  const query = new URLSearchParams({ provider });
  if (flowId) query.set("flowId", flowId);
  return `${apiBase}/api/oauth/status?${query}`;
}

export function cancelOAuthLogin(capture: OAuthLoginAttempt, provider: string): Promise<void> {
  const { flowId } = capture;
  const needsFlowId = isServerOwnedLogin(provider) && !flowId;
  const startup = needsFlowId ? starting.get(capture) : undefined;
  // A queued or failed start has no flow to cancel.
  if (needsFlowId && !startup) return Promise.resolve();
  const cancellationKey = startup ? capture : flowId;
  const key = barrierKey(capture, provider);
  const byFlow = cancellations.get(key) ?? new Map<CancellationKey, Promise<void>>();
  const pending = byFlow.get(cancellationKey);
  if (pending) return pending;

  const delivery = (async () => {
    if (startup) {
      // Wait for this attempt to bind its ID, then keep the barrier until the
      // scoped cancel settles. A failed startup leaves no ID to send.
      await startup;
      if (capture.flowId) await cancelOAuthLogin(capture, provider);
      return;
    }
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
    byFlow.delete(cancellationKey);
    if (byFlow.size === 0) cancellations.delete(key);
  });
  byFlow.set(cancellationKey, delivery);
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
  // The callback checks the generation and dispatches in this turn. For
  // server-owned logins its promise also covers parsing and binding the ID.
  const started = start();
  if (started !== undefined && isServerOwnedLogin(provider)) {
    const settled = () => { starting.delete(capture); };
    starting.set(capture, Promise.resolve(started).then(settled, settled));
  }
  return started;
}
