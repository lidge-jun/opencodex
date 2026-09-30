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
      step(action);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Without this the webview would also apply its own pinch zoom under the dashboard's.
      event.preventDefault();
      const next = accumulateWheel(wheelDistance.current, event.deltaY);
      wheelDistance.current = next.accumulated;
      if (next.action) step(next.action);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, [managed, step]);

  return { zoom, percent: zoomPercent(zoom), canZoomIn: zoom < ZOOM_MAX, canZoomOut: zoom > ZOOM_MIN, step };
}
