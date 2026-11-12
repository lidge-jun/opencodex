import { useEffect, useRef, useState } from "react";
import { canonicalHashPath } from "../app-routing";

/** Getting started links here when OpenCodex Desktop keeps the proxy running. */
export const STARTUP_DESKTOP_HASH = "startup/desktop";

function atDesktopHash(): boolean {
  return typeof window !== "undefined" && canonicalHashPath(window.location.hash) === STARTUP_DESKTOP_HASH;
}

/**
 * Bring the Desktop card into view each time the page is reached through `#startup/desktop`.
 *
 * App mounts Startup without the sub-path, and navigating within the page changes only the hash,
 * so arrivals are counted from `hashchange`. Each arrival is spent once, after the card renders,
 * so later polls and stale refreshes never move focus. No card means nothing happens, and the
 * hash is left as it is.
 */
export function useStartupDesktopFocus(cardRendered: boolean): void {
  const [arrival, setArrival] = useState(() => (atDesktopHash() ? 1 : 0));
  const handled = useRef(0);

  useEffect(() => {
    const onHash = () => { if (atDesktopHash()) setArrival(count => count + 1); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (arrival === 0 || handled.current === arrival || !cardRendered) return;
    const card = document.querySelector<HTMLElement>('[data-option="desktop"]');
    if (!card) return;
    handled.current = arrival;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    if (!card.hasAttribute("tabindex")) card.tabIndex = -1;
    card.focus({ preventScroll: true });
  }, [arrival, cardRendered]);
}
