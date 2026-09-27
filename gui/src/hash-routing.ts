/** Hash URL helpers that distinguish deliberate navigation from passive normalization. */

/** Strip a leading `#` / `#/` so callers can pass either form. */
export function normalizeHashPath(hash: string): string {
  return hash.replace(/^#\/?/, "");
}

/**
 * Split a normalized hash into its route path and an optional `?query`. The query is page-owned
 * state (a prefilter, a selected provider); routing decisions read the path alone.
 */
export function splitHashQuery(raw: string): { path: string; query: string } {
  const index = raw.indexOf("?");
  return index < 0 ? { path: raw, query: "" } : { path: raw.slice(0, index), query: raw.slice(index + 1) };
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
