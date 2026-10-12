/**
 * The single answer to "is the dashboard hidden right now?".
 *
 * A plain browser is answered by `document.visibilityState`. The desktop shell is not
 * always: WebView2 on Windows is reported to keep "visible" while the Tauri window sits
 * hidden in the tray (tauri issues #10592, #6864), so every dashboard poller went on
 * fetching for a window nobody could see. macOS WKWebView does flip it (measured).
 * The native side closes that gap by pushing the truth into the page —
 * `window.__OPENCODEX_HOST_VISIBLE__` plus an `opencodex:host-visibility` event, on
 * every show/hide and again after each page load — and this module folds both signals
 * into one predicate.
 *
 * Consumers read {@link hostDocumentHidden} and subscribe through
 * {@link onHostVisibilityChange} instead of touching `document.visibilityState`;
 * the tray popup keeps its own equivalent bridge (`opencodex:tray-visibility`).
 */

declare global {
  interface Window {
    /**
     * Pushed by the desktop shell: `false` while the main dashboard window is hidden
     * to the tray, `true` when it is shown. Absent in a browser, where the flag has no
     * meaning and `undefined !== false` keeps the document the only signal.
     */
    __OPENCODEX_HOST_VISIBLE__?: boolean;
  }
}

/** True when the dashboard is hidden — by the browser tab or by the desktop host. */
export function hostDocumentHidden(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return typeof window !== "undefined" && window.__OPENCODEX_HOST_VISIBLE__ === false;
}

/**
 * Call `callback` on every real host-visibility transition, and return the unsubscribe.
 *
 * Both signals are watched: `visibilitychange` for browsers and macOS, the custom host
 * event for the Windows case the standard event cannot see. On macOS both arrive for a
 * single hide, and a consumer's visible-again path is a make-up fetch, so the
 * transition is deduped against the last computed value per subscription — one hide is
 * one callback, one show is one callback, and a duplicate signal costs nothing.
 */
export function onHostVisibilityChange(callback: () => void): () => void {
  let last = hostDocumentHidden();

  const notify = () => {
    const next = hostDocumentHidden();
    if (next === last) return;
    last = next;
    callback();
  };

  const onHostEvent = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    // The flag must land before the reading below, or the event would evaluate against
    // the previous state and the transition would be deduped away.
    if (typeof window !== "undefined" && typeof detail === "boolean") {
      window.__OPENCODEX_HOST_VISIBLE__ = detail;
    }
    notify();
  };

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", notify);
  if (typeof window !== "undefined") window.addEventListener("opencodex:host-visibility", onHostEvent);

  return () => {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", notify);
    if (typeof window !== "undefined") window.removeEventListener("opencodex:host-visibility", onHostEvent);
  };
}
