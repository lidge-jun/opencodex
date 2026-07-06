/**
 * Lightweight in-flight breadcrumb for sidecar work (web-search / vision), read by crash-guard.
 *
 * The proxy's unhandled rejections arrive with a native-only stack, so the throw site is invisible.
 * To confirm or rule out the strong correlation with sidecar activity (the gpt-mini web-search /
 * vision passes that run an EXTRA upstream fetch alongside the main turn), each sidecar call brackets
 * itself with enter()/exit(). crash-guard then records whether any sidecar was in flight when a
 * rejection fired — turning a guess into evidence without a debugger.
 */
let inFlight = 0;
let lastLabel = "";
let lastEnterAt = 0;

export function sidecarEnter(label: string): () => void {
  inFlight++;
  lastLabel = label;
  lastEnterAt = Date.now();
  let exited = false;
  return () => {
    if (exited) return;
    exited = true;
    if (inFlight > 0) inFlight--;
  };
}

export function sidecarBreadcrumb(): { inFlight: number; lastLabel: string; sinceMs: number } {
  return {
    inFlight,
    lastLabel,
    sinceMs: lastEnterAt ? Date.now() - lastEnterAt : 0,
  };
}

/**
 * Generic last-activity breadcrumb (any code path, not just sidecars). The proxy's native-only
 * rejections carry no source location, so we record the most recent meaningful activity —
 * request path + a short note — to correlate the next fault with what the daemon was doing.
 */
let lastActivity = "";
let lastActivityAt = 0;

export function markActivity(note: string): void {
  lastActivity = note;
  lastActivityAt = Date.now();
}

export function activityBreadcrumb(): { note: string; sinceMs: number } {
  return { note: lastActivity, sinceMs: lastActivityAt ? Date.now() - lastActivityAt : 0 };
}
