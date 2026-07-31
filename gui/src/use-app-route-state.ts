import { useCallback, useEffect, useState } from "react";
import {
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
  type Page,
} from "./app-routing";
import { navigateHash, normalizeHashPath, replaceHash } from "./hash-routing";

/** localStorage keys written by the removed Classic/Workspace preference. */
const STALE_VIEW_KEYS = [
  "ocx-global-view",
  "ocx-view",
  "ocx-providers-view",
  "ocx-subagents-view",
  "ocx-storage-view",
  "ocx-codexauth-view",
  "ocx-apikeys-view",
  "ocx-claudecode-view",
  "ocx-usage-view",
  "ocx-logs-view",
  "ocx-models-view",
  "ocx-dashboard-view",
];

/**
 * One-shot cleanup of the layout-preference keys. There is a single layout now, so these
 * would otherwise sit in every user's storage forever.
 * TODO: delete this function (and its call) one release after 2.7.x.
 */
function clearStaleViewKeys(): void {
  try {
    for (const key of STALE_VIEW_KEYS) localStorage.removeItem(key);
  } catch {
    /* private mode / quota — nothing to clean up */
  }
}

/**
 * Production App route ownership. Hash page changes push history; normalization of an
 * unknown sub-hash replaces the current entry so Back is never trapped on a URL the
 * router immediately rewrites.
 */
export function useAppRouteState() {
  const [page, setPageState] = useState<Page>(readPageFromHash);

  useEffect(() => { clearStaleViewKeys(); }, []);

  const applyHashAction = useCallback((rawHash: string) => {
    const action = resolveAppHashChange(rawHash);
    if (action.replaceTo) replaceHash(action.replaceTo);
    setPageState(action.page);
  }, []);

  /**
   * Deliberate navigation. `subPath` deep-links a page sub-view (for example the
   * sidebar's `dashboard/update` action link); `hashBelongsToPage` must accept it,
   * otherwise the normalization effect below strips it right back off.
   */
  const navigateToPage = (id: Page, subPath?: string) => {
    const target = subPath ? `${id}/${subPath}` : id;
    navigateHash(target);
    setPageState(id);
  };

  useEffect(() => {
    const onRouteHash = () => {
      applyHashAction(normalizeHashPath(window.location.hash));
    };
    // hashchange covers location.hash assignment; popstate covers Back/Forward.
    window.addEventListener("hashchange", onRouteHash);
    window.addEventListener("popstate", onRouteHash);
    return () => {
      window.removeEventListener("hashchange", onRouteHash);
      window.removeEventListener("popstate", onRouteHash);
    };
  }, [applyHashAction]);

  useEffect(() => {
    const rawHash = normalizeHashPath(window.location.hash);
    if (rawHash === "debug" || rawHash.startsWith("debug/")) {
      replaceHash("logs/debug");
      return;
    }
    // Legacy deep link from the removed dual-layout era.
    if (rawHash === "providers/workspace") {
      replaceHash("providers");
      return;
    }
    if (!hashBelongsToPage(rawHash, page)) {
      replaceHash(page);
    }
  }, [page]);

  return {
    page,
    setPageState,
    navigateToPage,
  };
}
