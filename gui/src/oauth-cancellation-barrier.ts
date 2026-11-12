import { targetFetch, type ApiTargetCapture } from "./api";

// Cancellation is provider-scoped on the server and target-scoped on the client.
// The capture comes from the original login attempt, never from the current target
// at unmount time, so A's cleanup cannot cancel B's login.
const cancellations = new Map<string, Promise<void>>();

function barrierKey(capture: ApiTargetCapture, provider: string): string {
  return JSON.stringify([capture.targetKey, capture.apiBase, provider]);
}

export function cancelOAuthLogin(capture: ApiTargetCapture, provider: string): Promise<void> {
  const key = barrierKey(capture, provider);
  const pending = cancellations.get(key);
  if (pending) return pending;

  const delivery = (async () => {
    await targetFetch(capture, `${capture.apiBase}/api/oauth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
      keepalive: true,
    });
  })().catch(() => {
    // Preserve best-effort cleanup: a transport failure must not wedge retries.
    // Settlement is an ordering barrier, not proof of server cancellation.
  }).finally(() => {
    if (cancellations.get(key) === delivery) cancellations.delete(key);
  });
  cancellations.set(key, delivery);
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
    await pending;
    return afterOAuthCancellation(capture, provider, start);
  }
  // Check the hook's generation and dispatch in the same turn as the barrier
  // check, so another cancellation cannot slip into an extra await boundary.
  return start();
}
