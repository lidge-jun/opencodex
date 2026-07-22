import { flushResponseState } from "../responses/state";
import { cloudflareTunnelController } from "./cloudflare-tunnel";

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

const activeTurns = new Set<AbortController>();
let draining = false;
let _serverRef: ReturnType<typeof Bun.serve> | undefined;

export function setServerRef(server: ReturnType<typeof Bun.serve> | undefined): void { _serverRef = server; }
export function setDraining(value: boolean): void { draining = value; }
export function registerTurn(ac: AbortController): void { activeTurns.add(ac); }
export function unregisterTurn(ac: AbortController): void { activeTurns.delete(ac); }
export function isDraining(): boolean { return draining; }
export function getActiveTurnCount(): number { return activeTurns.size; }

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  ac: AbortController,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  registerTurn(ac);
  const reader = body.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    unregisterTurn(ac);
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        finish();
        try { controller.error(err); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      finish();
      ac.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export async function drainAndShutdown(
  server: ReturnType<typeof Bun.serve> | undefined,
  timeoutMs: number,
): Promise<void> {
  const s = server ?? _serverRef;
  draining = true;
  const deadline = Date.now() + timeoutMs;
  while (activeTurns.size > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (activeTurns.size > 0) {
    console.warn(`⚠️  Aborting ${activeTurns.size} in-flight turn(s) after ${timeoutMs}ms deadline`);
    for (const ac of activeTurns) {
      ac.abort(new Error("server shutdown"));
    }
    activeTurns.clear();
  }
  // Debounced replay-state snapshot may still be pending; flush so the last completed turn's
  // previous_response_id chain survives the restart this shutdown is usually part of.
  flushResponseState();
  // Public ingress must not outlive the local proxy. The controller escalates to a force kill if
  // cloudflared does not honor its graceful termination window.
  try {
    await cloudflareTunnelController.stop();
  } catch (err) {
    console.warn(`[cloudflare] tunnel shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  s?.stop(true);
  draining = false;
}
