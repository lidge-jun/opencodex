import { parseKiroDeviceView, type KiroDeviceView } from "./kiro-device-login-helpers";

export type KiroFinalOutcome = "added" | "ended" | "failed";
type Listener = (outcome: KiroFinalOutcome) => void;
const active = new Map<string, Promise<KiroFinalOutcome>>();
const terminal = new Map<string, KiroFinalOutcome>();
const listeners = new Map<string, Set<Listener>>();
const keyFor = (apiBase: string, flowId: string) => JSON.stringify([apiBase, flowId]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function boundedRead(read: Promise<Response | null>, ms: number): Promise<Response | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function subscribeKiroDeviceFinal(apiBase: string, listener: Listener): () => void {
  const set = listeners.get(apiBase) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(apiBase, set);
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(apiBase); };
}

function finish(apiBase: string, flowId: string, outcome: KiroFinalOutcome): KiroFinalOutcome {
  const key = keyFor(apiBase, flowId);
  if (terminal.has(key)) return terminal.get(key)!;
  terminal.set(key, outcome);
  for (const listener of listeners.get(apiBase) ?? []) listener(outcome);
  return outcome;
}

/** A terminal status reply always outranks a later forgotten-flow 404. */
export function observeKiroDeviceFinal(apiBase: string, flowId: string, view: KiroDeviceView,
  source: "status" | "cancel" = "status"): KiroFinalOutcome | null {
  if (view.flowId !== flowId) return null;
  // Cancel may synthesize done before the credential write commits. A cancelled
  // reply can also race an already-sent status read that observed the commit.
  // Keep reconciling both until status confirms a terminal state.
  if (source === "cancel" && view.state !== "failed") return null;
  if (view.state === "done") return finish(apiBase, flowId, "added");
  if (view.state === "failed") return finish(apiBase, flowId, "failed");
  if (view.state === "expired" || view.state === "cancelled") return finish(apiBase, flowId, "ended");
  return null;
}

/** Detached reconciliation survives dialog and page unmount. One loop per flowId. */
export function finalizeKiroDeviceFlow(apiBase: string, flowId: string, expiresAt?: number,
  inFlight?: Promise<Response | null>): Promise<KiroFinalOutcome> {
  const key = keyFor(apiBase, flowId);
  const prior = active.get(key);
  if (prior) return prior;
  const known = terminal.get(key);
  if (known) return Promise.resolve(known);
  const deadline = Math.min(Date.now() + 16 * 60_000, (expiresAt ?? Date.now() + 15 * 60_000) + 60_000);
  const run = (async () => {
    let pending = inFlight;
    while (Date.now() < deadline) {
      let response: Response | null;
      try {
        const remaining = deadline - Date.now();
        const timeout = Math.min(45_000, remaining);
        response = await boundedRead(pending ?? fetch(
          `${apiBase}/api/oauth/status?provider=kiro&flowId=${encodeURIComponent(flowId)}`,
          { signal: AbortSignal.timeout(timeout) },
        ), timeout);
      } catch { response = null; }
      pending = undefined;
      if (terminal.has(key)) return terminal.get(key)!;
      if (response?.status === 404) return finish(apiBase, flowId, "ended");
      if (response?.ok) {
        const view = parseKiroDeviceView(await response.json().catch(() => null));
        if (view) {
          const result = observeKiroDeviceFinal(apiBase, flowId, view);
          if (result) return result;
        }
      }
      await delay(2_000);
    }
    return finish(apiBase, flowId, "ended");
  })().finally(() => { active.delete(key); });
  active.set(key, run);
  return run;
}
