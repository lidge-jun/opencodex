/** Hash URL helpers that distinguish deliberate navigation from passive normalization. */

/** Strip a leading `#` / `#/` so callers can pass either form. */
export function normalizeHashPath(hash: string): string {
  return hash.replace(/^#\/?/, "");
}

/**
 * Passive URL correction: replace the current history entry.
 * Does not emit `hashchange` — callers must update React state themselves when needed.
 */
export function replaceHash(hash: string, win: Window = window): void {
  const raw = normalizeHashPath(hash);
  const current = normalizeHashPath(win.location.hash);
  if (current === raw) return;
  const nextUrl = `${win.location.pathname}${win.location.search}#${raw}`;
  win.history.replaceState(win.history.state, "", nextUrl);
}

/**
 * Deliberate user navigation: assign `location.hash` so the browser pushes a history entry
 * and emits `hashchange` for listeners.
 */
export function navigateHash(hash: string, win: Window = window): void {
  const raw = normalizeHashPath(hash);
  const current = normalizeHashPath(win.location.hash);
  if (current === raw) return;
  win.location.hash = raw;
}

export type ProvidersHashResolve = {
  /** When set, passively replace the current hash (no new history entry). */
  replaceTo: string | null;
  /** Preferred view mode to apply from an explicit deep link or classic bare hash. */
  viewMode: "classic" | "workspace" | null;
  /** When true, the hash was rewritten; caller should apply page/state without waiting for hashchange. */
  handledPassively: boolean;
};

/**
 * Resolve Providers hash against the stored Classic/Workspace preference.
 * Bare `#providers` with a stored workspace preference is passively rewritten to
 * `#providers/workspace` (no history push). Explicit `#providers/workspace` deep links
 * still force workspace mode.
 */
export function resolveProvidersHashChange(
  rawHash: string,
  preferred: "classic" | "workspace",
): ProvidersHashResolve {
  if (rawHash === "providers/workspace") {
    return { replaceTo: null, viewMode: "workspace", handledPassively: false };
  }
  if (rawHash === "providers" && preferred === "workspace") {
    return { replaceTo: "providers/workspace", viewMode: "workspace", handledPassively: true };
  }
  if (rawHash === "providers") {
    return { replaceTo: null, viewMode: "classic", handledPassively: false };
  }
  return { replaceTo: null, viewMode: null, handledPassively: false };
}
