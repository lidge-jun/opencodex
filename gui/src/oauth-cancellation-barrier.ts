// Cancellation is provider-scoped on the server. Keep outstanding deliveries
// outside React instances so reopening either login surface cannot overtake one.
const cancellations = new Map<string, Promise<void>>();

export function cancelOAuthLogin(apiBase: string, provider: string): Promise<void> {
  const key = JSON.stringify([apiBase, provider]);
  const pending = cancellations.get(key);
  if (pending) return pending;

  const delivery = (async () => {
    await fetch(`${apiBase}/api/oauth/login/cancel`, {
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
  apiBase: string,
  provider: string,
  start: () => T | Promise<T>,
): Promise<T> {
  const key = JSON.stringify([apiBase, provider]);
  const pending = cancellations.get(key);
  if (pending) {
    await pending;
    return afterOAuthCancellation(apiBase, provider, start);
  }
  // Check the hook's generation and dispatch in the same turn as the barrier
  // check, so another cancellation cannot slip into an extra await boundary.
  return start();
}
