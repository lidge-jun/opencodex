import { useCallback, useEffect, useRef, useState } from "react";
import { hostOs } from "./lib/desktop-shell";
import {
  accumulateWheel,
  applyWebviewZoom,
  readSavedZoom,
  stepZoom,
  writeSavedZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomKeyAction,
  zoomPercent,
  type ZoomAction,
} from "./lib/desktop-zoom";

/**
 * Owns the desktop window's page zoom: the remembered level, the keyboard and Ctrl + wheel
 * gestures, and the sidebar control. Inert outside the shell. The level is applied on mount as
 * well as on every change, so a restart or a page navigation never leaves the webview at a
 * level the dashboard does not know about.
 *
 * The shell may inject Tauri's own zoom polyfill, and the dashboard cannot know which shell
 * version is hosting it: the runtime serves the dashboard while the installed app is the shell,
 * and a declined takeover or a pending service restart leaves the two on different versions. The
 * polyfill listens on `window` in the bubble phase, so these listeners run in the capture phase
 * and stop the event. A dashboard that handles zoom is then the only writer under any shell, and
 * a dashboard that does not (an older runtime) never gets here, so the polyfill keeps working
 * there. Nothing has to be negotiated between the two.
 */
export function useDesktopZoom(
  { managed }: { managed: boolean },
): { zoom: number; percent: number; canZoomIn: boolean; canZoomOut: boolean; step: (action: ZoomAction) => void } {
  const [zoom, setZoom] = useState(readSavedZoom);
  const step = useCallback((action: ZoomAction) => setZoom((current) => stepZoom(current, action)), []);
  const wheelDistance = useRef(0);

  // Updaters may run without a commit, so the side effects follow the render instead.
  useEffect(() => {
    if (!managed) return;
    void applyWebviewZoom(zoom);
    writeSavedZoom(zoom);
  }, [managed, zoom]);

  useEffect(() => {
    if (!managed) return;
    const os = hostOs();
    const onKey = (event: KeyboardEvent) => {
      const action = zoomKeyAction(event, os);
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      step(action);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Without this the webview would also apply its own pinch zoom under the dashboard's.
      event.preventDefault();
      event.stopImmediatePropagation();
      const next = accumulateWheel(wheelDistance.current, event.deltaY);
      wheelDistance.current = next.accumulated;
      if (next.action) step(next.action);
    };
    // The legacy event the polyfill listens to. It may fire beside `wheel`, so it is silenced here
    // and never counted: one gesture is one step.
    const silenceLegacyWheel = (event: Event) => {
      if (!(event as WheelEvent).ctrlKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("mousewheel", silenceLegacyWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("mousewheel", silenceLegacyWheel, { capture: true });
    };
  }, [managed, step]);

  return { zoom, percent: zoomPercent(zoom), canZoomIn: zoom < ZOOM_MAX, canZoomOut: zoom > ZOOM_MIN, step };
}
