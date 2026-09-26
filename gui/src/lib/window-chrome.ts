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

/** Native traffic lights stay in window points while WKWebView page zoom scales CSS pixels. */
export function watchMacTitlebarMetrics(app: HTMLElement): () => void {
  const core = window.__TAURI__?.core;
  // Retina is the conservative initial guess until the window scale query resolves.
  const initialDpr = window.devicePixelRatio;
  let windowScale = Number.isFinite(initialDpr) && initialDpr > 0 ? Math.max(2, initialDpr) : 2;
  let active = true;
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const apply = () => {
    const dpr = window.devicePixelRatio;
    const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.max(1, windowScale / dpr) : 1;
    app.classList.toggle("app--reduced-zoom", ratio > 1);
    app.style.setProperty("--tl-inset", `${Math.ceil(80 * ratio)}px`);
    app.style.setProperty("--titlebar-h", `${Math.ceil(40 * ratio)}px`);
    app.style.setProperty("--chrome-clear", `${Math.ceil(124 * ratio)}px`);
  };
  const readScale = () => {
    if (!core?.invoke) return;
    const current = ++request;
    void core.invoke("plugin:window|scale_factor").then((scale) => {
      if (!active || current !== request) return;
      if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) {
        windowScale = scale;
        apply();
      }
    }).catch(() => {});
  };
  const onResize = () => {
    apply();
    clearTimeout(timer);
    timer = setTimeout(readScale, 80);
  };

  apply();
  readScale();
  window.addEventListener("resize", onResize);
  window.addEventListener("focus", readScale);
  return () => {
    active = false;
    clearTimeout(timer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("focus", readScale);
  };
}
