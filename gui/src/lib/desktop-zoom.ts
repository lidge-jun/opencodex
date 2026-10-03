/**
 * Page zoom for the desktop shell, owned by the dashboard.
 *
 * Tauri's own zoom-hotkey polyfill keeps the level in a script variable that starts at 1 on
 * every page load: a restart forgot the level, and so did the hop from the bootstrap page to
 * the dashboard, after which the first shortcut jumped from the real level to 120%. The
 * dashboard therefore keeps the level itself, remembers it, and drives the webview through the
 * one command `desktop/src-tauri/capabilities/dashboard-zoom.json` already grants to this
 * origin. Outside the shell the global is absent and every call is a no-op.
 */
import type { HostOs } from "./desktop-shell";

export const ZOOM_STORAGE_KEY = "ocx-desktop-zoom";
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;

export type ZoomAction = "in" | "out" | "reset";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

/**
 * Whether the dashboard drives zoom on this host. Windows keeps WebView2's native zoom, which
 * the shell leaves enabled there, so a second owner would only disagree with it.
 */
export function zoomManagedOn(os: HostOs): boolean {
  return os === "macos" || os === "linux";
}

/** Whole percent steps keep repeated presses from drifting into 1.2000000000000002. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  const bounded = Math.min(Math.max(value, ZOOM_MIN), ZOOM_MAX);
  return Math.round(bounded * 100) / 100;
}

export function stepZoom(current: number, action: ZoomAction): number {
  if (action === "reset") return ZOOM_DEFAULT;
  return clampZoom(current + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
}

export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}

export function readSavedZoom(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): number {
  try {
    const raw = storage?.getItem(ZOOM_STORAGE_KEY);
    if (raw === null || raw === undefined) return ZOOM_DEFAULT;
    return clampZoom(Number(raw));
  } catch {
    return ZOOM_DEFAULT;
  }
}

export function writeSavedZoom(
  zoom: number,
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): void {
  try {
    storage?.setItem(ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // A storageless context still zooms for the session.
  }
}

/**
 * The key combinations the shell always answered to: Cmd on macOS, Ctrl elsewhere, with plus,
 * minus and zero. `=` is accepted because plus shares its key on most layouts.
 */
export function zoomKeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  os: HostOs,
): ZoomAction | null {
  const modifier = os === "macos" ? event.metaKey : event.ctrlKey;
  if (!modifier) return null;
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "=" || event.key === "+") return "in";
  if (event.key === "0") return "reset";
  return null;
}

/** Distance a Ctrl + wheel gesture must add up to before it steps once. */
export const WHEEL_STEP_PX = 50;

/**
 * Ctrl + wheel, as before: up zooms in. A mouse notch is one step, while a touchpad pinch
 * arrives as many tiny deltas, so the distance accumulates instead of stepping on every event.
 */
export function accumulateWheel(
  accumulated: number,
  deltaY: number,
): { accumulated: number; action: ZoomAction | null } {
  if (!Number.isFinite(deltaY) || deltaY === 0) return { accumulated, action: null };
  // A change of direction starts a new gesture rather than cancelling the last one.
  const carried = Math.sign(accumulated) === Math.sign(deltaY) ? accumulated : 0;
  const total = carried + deltaY;
  if (Math.abs(total) < WHEEL_STEP_PX) return { accumulated: total, action: null };
  return { accumulated: 0, action: total < 0 ? "in" : "out" };
}

/** Asks the shell to set the webview zoom. Resolves false when there is no shell to ask. */
export async function applyWebviewZoom(zoom: number): Promise<boolean> {
  const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  try {
    await invoke("plugin:webview|set_webview_zoom", { value: zoom });
    return true;
  } catch {
    return false;
  }
}
