/** Pure hash → page resolution used by App route state. */

import { normalizeHashPath } from "./hash-routing";

export type Page =
  | "dashboard"
  | "startup"
  | "providers"
  | "models"
  | "subagents"
  | "logs"
  | "usage"
  | "storage"
  | "codex-set"
  | "integrations";

export const VALID_PAGES = new Set<Page>([
  "dashboard",
  "startup",
  "providers",
  "models",
  "subagents",
  "logs",
  "usage",
  "storage",
  "codex-set",
  "integrations",
]);

export function readPageFromHash(hash?: string): Page {
  const raw = normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  );
  // Sub-views use a "/" suffix (e.g. #logs/debug); the first segment is the page id.
  const pageId = raw.split("/")[0] as Page;
  // Legacy: Debug used to be a standalone page; it now lives as a tab on Logs.
  if (pageId === ("debug" as Page)) return "logs";
  // Legacy: Codex Auth became the Multi-auth tab of Codex Set. #codex-auth is a
  // bookmarkable URL that has shipped, and use-app-route-state reads the initial
  // page straight from the hash, so without this an old bookmark lands on an
  // unknown page.
  if (pageId === ("codex-auth" as Page)) return "codex-set";
  // Legacy: Combos, Routing, and Lab are Models tabs now. Resolve the destination page
  // immediately so a cold legacy hash never flashes Dashboard before replacement.
  if (pageId === ("combos" as Page)
    || pageId === ("routing" as Page)
    || pageId === ("lab" as Page)) return "models";
  // Legacy integration pages now live below one Integrations route. Returning
  // the destination page here keeps the initial hook state aligned until the
  // resolver replaces the hash with the exact nested destination.
  if (pageId === ("api" as Page)
    || pageId === ("claude" as Page)
    || pageId === ("grok" as Page)) return "integrations";
  return VALID_PAGES.has(pageId) ? pageId : "dashboard";
}

/**
 * Dashboard section tabs live in the hash so refresh/bookmark/back-forward keep the
 * choice, mirroring Logs (`#logs` / `#logs/debug`). Overview is the bare `#dashboard`,
 * so it has no suffix entry here.
 */
export const DASHBOARD_TAB_HASHES = ["dashboard/providers", "dashboard/models"] as const;

/**
 * Models owns four tabs: the catalog, Combos, Routing, and Compatibility. The catalog
 * is the bare `#models`, so it has no suffix entry here - same convention Dashboard
 * uses for Overview and Logs uses for the log list.
 */
export const MODELS_TAB_HASHES = ["models/combos", "models/routing", "models/compatibility"] as const;

/**
 * `#dashboard/update` is an action deep link, not a tab: the sidebar update button uses
 * it to open the maintenance update dialog over the Overview section. It is listed as a
 * valid dashboard hash so route normalization does not strip it before the dashboard
 * reads it.
 */
export const DASHBOARD_UPDATE_HASH = "dashboard/update";

/**
 * Integrations uses a wrapping outer tab strip. Claude Desktop is a nested
 * route owned by the Claude family panel, but it still has to be registered
 * here or App normalization strips it before Claude can read it.
 */
export const INTEGRATION_TAB_HASHES = [
  "integrations/keys",
  "integrations/codex",
  "integrations/claude",
  "integrations/claude/desktop",
  "integrations/grok",
  "integrations/opencode",
  "integrations/pi",
  "integrations/omp",
  "integrations/hermes",
  "integrations/openclaw",
  "integrations/kimi",
  "integrations/gajae",
  "integrations/dsh",
  "integrations/mcode",
  "integrations/zcode",
  "integrations/prime",
  "integrations/aside",
] as const;

export function hashBelongsToPage(rawHash: string, page: Page): boolean {
  return rawHash === page
    || (page === "logs" && rawHash === "logs/debug")
    || (page === "codex-set" && rawHash === "codex-set/prompt")
    || (page === "models" && (MODELS_TAB_HASHES as readonly string[]).includes(rawHash))
    || (page === "dashboard"
      && (rawHash === DASHBOARD_UPDATE_HASH || (DASHBOARD_TAB_HASHES as readonly string[]).includes(rawHash)))
    || (page === "integrations"
      && (INTEGRATION_TAB_HASHES as readonly string[]).includes(rawHash));
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

  /* Legacy: Codex Auth is now the Multi-auth tab of Codex Set. */
  if (rawHash === "codex-auth" || rawHash.startsWith("codex-auth/")) {
    return { page: "codex-set", replaceTo: "codex-set" };
  }

  /* Legacy Models pages. Delimiter-aware prefix arms preserve nested legacy bookmarks. */
  if (rawHash === "combos" || rawHash.startsWith("combos/")) {
    return { page: "models", replaceTo: "models/combos" };
  }
  if (rawHash === "routing" || rawHash.startsWith("routing/")) {
    return { page: "models", replaceTo: "models/routing" };
  }
  if (rawHash === "lab" || rawHash.startsWith("lab/")) {
    return { page: "models", replaceTo: "models/compatibility" };
  }

  /* Legacy top-level integration pages. */
  if (rawHash === "api") return { page: "integrations", replaceTo: "integrations/keys" };
  if (rawHash === "claude") return { page: "integrations", replaceTo: "integrations/claude" };
  if (rawHash === "grok") return { page: "integrations", replaceTo: "integrations/grok" };

  // Legacy deep link from the removed dual-layout era.
  if (rawHash === "providers/workspace") return { page: "providers", replaceTo: "providers" };

  // An unrecognised sub-hash is normalised away rather than left in the URL.
  if (!hashBelongsToPage(rawHash, nextPage)) return { page: nextPage, replaceTo: nextPage };
  return { page: nextPage, replaceTo: null };
}
