/**
 * Integrated title bar plumbing.
 *
 * Inside the Tauri desktop shell the window has no native title bar: macOS draws its
 * traffic lights over the webview, so the strips at the top of the sidebar and of the
 * main column are what a person grabs to move the window. They call the shell through
 * `plugin:window` commands — granted to the loopback origin by
 * `desktop/src-tauri/capabilities/dashboard-titlebar.json` — on the `__TAURI__` global
 * that `withGlobalTauri` injects. Outside the shell (a plain browser dashboard) the
 * global is absent and every call is a no-op.
 */
import type { MouseEvent as ReactMouseEvent } from "react";

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
  }
}

type WindowCommand = "plugin:window|start_dragging" | "plugin:window|toggle_maximize";

function windowCommand(command: WindowCommand): void {
  try {
    void window.__TAURI__?.core?.invoke?.(command).catch(() => {});
  } catch {
    // Not a shell surface.
  }
}

/**
 * Elements a drag must not start on: the strip wraps the quota chips (links) and their
 * paging buttons, which have to stay clickable.
 */
const INTERACTIVE_SELECTOR =
  "a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable]";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * Spread onto a top-strip element: press-and-move drags the window, a double click on
 * empty strip toggles zoom — the two behaviors a native title bar would give it.
 */
export function windowChromeHandlers(): {
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
} {
  return {
    onMouseDown: (event) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) return;
      windowCommand("plugin:window|start_dragging");
    },
    onDoubleClick: (event) => {
      if (isInteractiveTarget(event.target)) return;
      windowCommand("plugin:window|toggle_maximize");
    },
  };
}
