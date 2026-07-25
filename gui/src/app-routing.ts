/** Pure hash → page/viewMode resolution used by App route state. */

import { normalizeHashPath, resolveProvidersHashChange } from "./hash-routing";
import { providersHashForViewMode, type ViewMode } from "./view-mode";

export type Page =
  | "dashboard"
  | "startup"
  | "providers"
  | "models"
  | "combos"
  | "subagents"
  | "logs"
  | "usage"
  | "storage"
  | "codex-auth"
  | "api"
  | "claude";

export const VALID_PAGES = new Set<Page>([
  "dashboard",
  "startup",
  "providers",
  "models",
  "combos",
  "subagents",
  "logs",
  "usage",
  "storage",
  "codex-auth",
  "api",
  "claude",
]);

export function readPageFromHash(hash?: string): Page {
  const raw = normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  );
  // Sub-views use a "/" suffix (e.g. #providers/workspace); the first segment is the page id.
  const pageId = raw.split("/")[0] as Page;
  // Legacy: Debug used to be a standalone page; it now lives as a tab on Logs.
  if (pageId === ("debug" as Page)) return "logs";
  return VALID_PAGES.has(pageId) ? pageId : "dashboard";
}

export function hashBelongsToPage(rawHash: string, page: Page): boolean {
  return rawHash === page
    || (page === "providers" && rawHash === "providers/workspace")
    || (page === "logs" && rawHash === "logs/debug");
}

export function providersHashForPreferredMode(preferred: ViewMode = "classic"): string {
  return providersHashForViewMode(preferred);
}

/**
 * Result of applying an incoming hash against the canonical view preference.
 * Callers must apply `page` and `viewMode` together (no deferred transitions).
 */
export type AppHashChangeAction = {
  page: Page;
  /** When non-null, set React viewMode in the same turn as `page`. */
  viewMode: ViewMode | null;
  /** When non-null, persist to the canonical preference store. */
  persistViewMode: ViewMode | null;
  /** When non-null, passively replace the current history entry (no push). */
  replaceTo: string | null;
};

/**
 * Resolve what App should do for the current location hash.
 * Classic/Workspace is a persistent preference: bare `#providers` with a stored
 * workspace preference is rewritten via replaceState, never pushed.
 */
export function resolveAppHashChange(rawHash: string, preferred: ViewMode): AppHashChangeAction {
  const nextPage = readPageFromHash(rawHash);

  if (rawHash === "debug" || rawHash.startsWith("debug/")) {
    return {
      page: "logs",
      viewMode: null,
      persistViewMode: null,
      replaceTo: "logs/debug",
    };
  }

  if (!hashBelongsToPage(rawHash, nextPage)) {
    return {
      page: nextPage === "providers" ? "providers" : nextPage,
      viewMode: nextPage === "providers" ? preferred : null,
      persistViewMode: null,
      replaceTo: nextPage === "providers" ? providersHashForPreferredMode(preferred) : nextPage,
    };
  }

  if (nextPage === "providers") {
    const resolved = resolveProvidersHashChange(rawHash, preferred);
    if (resolved.replaceTo) {
      return {
        page: "providers",
        viewMode: resolved.viewMode,
        persistViewMode: resolved.viewMode,
        replaceTo: resolved.replaceTo,
      };
    }
    return {
      page: "providers",
      viewMode: resolved.viewMode,
      persistViewMode: resolved.viewMode,
      replaceTo: null,
    };
  }

  return {
    page: nextPage,
    viewMode: null,
    persistViewMode: null,
    replaceTo: null,
  };
}
