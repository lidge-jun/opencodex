import { useCallback, useEffect, useState } from "react";

const COLLAPSED_KEY = "ocx-sidebar-collapsed";

export function readSidebarCollapsed(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): boolean {
  try {
    return storage?.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // A storageless context still toggles for the session.
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null)
  );
}

/**
 * Codex-style collapse: the sidebar leaves the layout and only its top strip — traffic
 * lights and the toggle — stays. The remembered answer survives restarts. Cmd/Ctrl+B
 * toggles too, the shortcut every sibling app trained into the same hands — but only in
 * the desktop shell, because in a plain browser it would steal the bookmark-bar shortcut.
 */
export function useSidebarCollapse(
  { shortcut = false }: { shortcut?: boolean } = {},
): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const toggle = useCallback(() => setCollapsed((current) => !current), []);
  // Updaters may run without a commit, so the write follows the render instead.
  useEffect(() => {
    writeSidebarCollapsed(collapsed);
  }, [collapsed]);
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key !== "b" && event.key !== "B") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, shortcut]);
  return { collapsed, toggle };
}
