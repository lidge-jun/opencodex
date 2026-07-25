import { useEffect, useRef, useState } from "react";
import {
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
  type Page,
} from "./app-routing";
import { navigateHash, normalizeHashPath, replaceHash } from "./hash-routing";
import {
  ensureMigratedViewMode,
  providersHashForGlobalViewChange,
  providersHashForViewMode,
  toggleViewMode,
  writeViewMode,
  type ViewMode,
} from "./view-mode";

/**
 * Production App route + Classic/Workspace ownership.
 * Hash page changes push history; view-mode sync on Providers replaces the current entry.
 * After init, React `viewMode` is authoritative for the session — storage is persistence only.
 */
export function useAppRouteState() {
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const migrated = ensureMigratedViewMode();
    try {
      const rawHash = normalizeHashPath(window.location.hash);
      if (rawHash === "providers/workspace") {
        writeViewMode("workspace");
        return "workspace";
      }
    } catch {
      /* ignore */
    }
    return migrated;
  });
  const viewModeRef = useRef(viewMode);

  const commitViewMode = (next: ViewMode) => {
    viewModeRef.current = next;
    setViewMode(next);
  };

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  const applyHashAction = (rawHash: string) => {
    // Prefer in-memory mode so a storage failure cannot revert a live session toggle.
    const action = resolveAppHashChange(rawHash, viewModeRef.current);
    if (action.replaceTo) replaceHash(action.replaceTo);
    if (action.persistViewMode) writeViewMode(action.persistViewMode);
    // Route page and view mode update in the same event — never via startTransition.
    setPageState(action.page);
    if (action.viewMode) commitViewMode(action.viewMode);
  };

  const toggleGlobalWorkspace = () => {
    const next = toggleViewMode(viewModeRef.current);
    writeViewMode(next);
    commitViewMode(next);
    // Preference change, not page navigation: replace the Providers hash in place.
    const wanted = providersHashForGlobalViewChange(window.location.hash, next, page === "providers");
    if (wanted) replaceHash(wanted);
  };

  const navigateToPage = (id: Page) => {
    navigateHash(id === "providers" ? providersHashForViewMode(viewModeRef.current) : id);
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
  }, []);

  useEffect(() => {
    const rawHash = normalizeHashPath(window.location.hash);
    if (rawHash === "debug" || rawHash.startsWith("debug/")) {
      replaceHash("logs/debug");
      return;
    }
    if (page === "providers") {
      const wanted = providersHashForViewMode(viewMode);
      if (rawHash !== wanted) replaceHash(wanted);
      return;
    }
    if (!hashBelongsToPage(rawHash, page)) {
      replaceHash(page);
    }
  }, [page, viewMode]);

  return {
    page,
    viewMode,
    setPageState,
    toggleGlobalWorkspace,
    navigateToPage,
  };
}
