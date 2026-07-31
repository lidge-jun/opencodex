/** Pure hash → page resolution used by App route state. */

import { normalizeHashPath } from "./hash-routing";

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
  | "claude"
  | "grok";

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
  "grok",
]);

export function readPageFromHash(hash?: string): Page {
  const raw = normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  );
  // Sub-views use a "/" suffix (e.g. #logs/debug); the first segment is the page id.
  const pageId = raw.split("/")[0] as Page;
  // Legacy: Debug used to be a standalone page; it now lives as a tab on Logs.
  if (pageId === ("debug" as Page)) return "logs";
  return VALID_PAGES.has(pageId) ? pageId : "dashboard";
}

/**
 * Dashboard section tabs live in the hash so refresh/bookmark/back-forward keep the
 * choice, mirroring Logs (`#logs` / `#logs/debug`). Overview is the bare `#dashboard`,
 * so it has no suffix entry here.
 */
export const DASHBOARD_TAB_HASHES = ["dashboard/providers", "dashboard/models"] as const;

/**
 * `#dashboard/update` is an action deep link, not a tab: the sidebar update button uses
 * it to open the maintenance update dialog over the Overview section. It is listed as a
 * valid dashboard hash so route normalization does not strip it before the dashboard
 * reads it.
 */
export const DASHBOARD_UPDATE_HASH = "dashboard/update";

export function hashBelongsToPage(rawHash: string, page: Page): boolean {
  return rawHash === page
    || (page === "logs" && rawHash === "logs/debug")
    || (page === "dashboard"
      && (rawHash === DASHBOARD_UPDATE_HASH || (DASHBOARD_TAB_HASHES as readonly string[]).includes(rawHash)));
}


/** Result of resolving an incoming hash. */
export type AppHashChangeAction = {
  page: Page;
  /** When non-null, passively replace the hash (no new history entry). */
  replaceTo: string | null;
};

/**
 * Resolve what App should do for the current location hash.
 * Any rewrite this returns is passive: callers apply it with replaceState, never a
 * push, so Back is never trapped on a hash the router immediately corrects.
 */
export function resolveAppHashChange(rawHash: string): AppHashChangeAction {
  const nextPage = readPageFromHash(rawHash);

  // Legacy: Debug used to be a standalone page.
  if (rawHash === "debug" || rawHash.startsWith("debug/")) {
    return { page: "logs", replaceTo: "logs/debug" };
  }

  // Legacy deep link from the removed dual-layout era.
  if (rawHash === "providers/workspace") {
    return { page: "providers", replaceTo: "providers" };
  }

  // An unrecognised sub-hash is normalised away rather than left in the URL.
  if (!hashBelongsToPage(rawHash, nextPage)) {
    return { page: nextPage, replaceTo: nextPage };
  }

  return { page: nextPage, replaceTo: null };
}
