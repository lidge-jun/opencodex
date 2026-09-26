/**
 * The integrated title bar's two strips, laid out the way the Codex desktop app is:
 * traffic lights live in the sidebar's top strip next to a collapse toggle, and the
 * main column's top strip carries the quota summary on the same row.
 *
 * `SidebarTopStrip` is the sidebar's first child and the only child that survives a
 * collapse; `MainTopStrip` wraps whatever sits at the top of `.main`. Both spread the
 * window-chrome handlers, which no-op outside the desktop shell.
 */
import type { ReactNode } from "react";
import { IconPanelLeft } from "../icons";
import { useT } from "../i18n/shared";
import { windowChromeHandlers } from "../lib/window-chrome";
import "./app-titlebar.css";

export function SidebarTopStrip({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  const label = collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar");
  return (
    <div className="sidebar-top" {...windowChromeHandlers()}>
      <button
        type="button"
        className="sidebar-collapse"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        aria-label={label}
        title={label}
      >
        <IconPanelLeft />
      </button>
    </div>
  );
}

export function MainTopStrip({ children }: { children?: ReactNode }) {
  return (
    <div className="main-top" {...windowChromeHandlers()}>
      {children}
    </div>
  );
}
