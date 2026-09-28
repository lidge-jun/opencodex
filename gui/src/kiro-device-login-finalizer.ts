import { parseKiroDeviceView, type KiroDeviceView } from "./kiro-device-login-helpers";

export type KiroFinalOutcome = "added" | "ended" | "failed";
export type KiroStatusResult =
  | { kind: "view"; view: KiroDeviceView }
  | { kind: "missing" }
  | { kind: "retry" };
export type KiroStatusRead = { result: Promise<KiroStatusResult>; cancel: () => void };
type Listener = (outcome: KiroFinalOutcome) => void;
const active = new Map<string, Promise<KiroFinalOutcome>>();
const terminal = new Map<string, KiroFinalOutcome>();
const listeners = new Map<string, Set<Listener>>();
const keyFor = (apiBase: string, flowId: string) => JSON.stringify([apiBase, flowId]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const MAX_STATUS_BODY_BYTES = 64 * 1024;

function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}

/** Own fetch, body EOF and parsing as one cancellable operation; headers alone are not completion. */
export function readKiroDeviceStatus(apiBase: string, flowId: string, timeoutMs = 45_000): KiroStatusRead {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let settled = false;
  let finish!: (result: KiroStatusResult) => void;
  const result = new Promise<KiroStatusResult>(resolve => { finish = resolve; });
  const settle = (value: KiroStatusResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(value);
  };
  const cancel = () => {
    if (settled) return;
    controller.abort();
    try { void reader?.cancel().catch(() => {}); } catch { /* best effort */ }
    // Transport abort and stream cancellation are cooperative. The caller's deadline is not.
    settle({ kind: "retry" });
  };
  const timer = setTimeout(cancel, Math.max(0, timeoutMs));
  void (async () => {
    try {
      const response = await fetch(
        `${apiBase}/api/oauth/status?provider=kiro&flowId=${encodeURIComponent(flowId)}`,
        { signal: controller.signal },
      );
      if (settled) { cancelBody(response); return; }
      if (response.status === 404) { cancelBody(response); settle({ kind: "missing" }); return; }
      if (!response.ok || !response.body) { cancelBody(response); settle({ kind: "retry" }); return; }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (settled) return;
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_STATUS_BODY_BYTES) { cancel(); return; }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { settle({ kind: "retry" }); return; }
      const view = parseKiroDeviceView(decoded);
      settle(view ? { kind: "view", view } : { kind: "retry" });
    } catch { settle({ kind: "retry" }); }
  })();
  return { result, cancel };
}

async function awaitStatusRead(read: KiroStatusRead, ms: number): Promise<KiroStatusResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read.result,
      new Promise<KiroStatusResult>(resolve => {
        timer = setTimeout(() => { read.cancel(); resolve({ kind: "retry" }); }, Math.max(0, ms));
      }),
    ]);
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
  inFlight?: KiroStatusRead): Promise<KiroFinalOutcome> {
  const key = keyFor(apiBase, flowId);
  const prior = active.get(key);
  if (prior) return prior;
  const known = terminal.get(key);
  if (known) return Promise.resolve(known);
  const deadline = Math.min(Date.now() + 16 * 60_000, (expiresAt ?? Date.now() + 15 * 60_000) + 60_000);
  const run = (async () => {
    let pending = inFlight;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const read = pending ?? readKiroDeviceStatus(apiBase, flowId, Math.min(45_000, remaining));
      pending = undefined;
      const status = await awaitStatusRead(read, remaining);
      if (terminal.has(key)) return terminal.get(key)!;
      if (status.kind === "missing") return finish(apiBase, flowId, "ended");
      if (status.kind === "view") {
        const result = observeKiroDeviceFinal(apiBase, flowId, status.view);
        if (result) return result;
      }
      const retryRemaining = deadline - Date.now();
      if (retryRemaining <= 0) break;
      await delay(Math.min(2_000, retryRemaining));
    }
    // A close can hand off after expiry. Do not leave that inherited transport alive merely
    // because there was no remaining loop iteration in which the deadline wrapper could cancel it.
    pending?.cancel();
    return finish(apiBase, flowId, "ended");
  })().finally(() => { active.delete(key); });
  active.set(key, run);
  return run;
}
