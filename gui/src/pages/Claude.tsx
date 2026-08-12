import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import ClaudeCode from "./ClaudeCode";
import ClaudeDesktop from "./ClaudeDesktop";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT } from "../i18n/shared";
import { readSessionListCache } from "../session-list-cache";

type ClaudeTab = "code" | "desktop";

const CODE_HASH = "integrations/claude";
const DESKTOP_HASH = "integrations/claude/desktop";

/** Desktop is a route of its own, so a reload or a shared link opens on it. */
function readClaudeTab(hash = typeof window !== "undefined" ? window.location.hash : ""): ClaudeTab {
  return normalizeHashPath(hash) === DESKTOP_HASH ? "desktop" : "code";
}

function readCachedDesktopPort(apiBase: string): number | null {
  const cached = readSessionListCache<{ data?: { port?: number } }>(`ocx.claude-desktop.v1:${apiBase}`);
  return typeof cached?.data?.port === "number" ? cached.data.port : null;
}

export default function Claude({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const [tab, setTab] = useState<ClaudeTab>(readClaudeTab);
  const t = useT();
  const codeTabRef = useRef<HTMLButtonElement>(null);
  const desktopTabRef = useRef<HTMLButtonElement>(null);
  // Seed Desktop's port subtitle from session cache so the intro above the Code/Desktop
  // strip does not wait on the first status paint after a tab hop. Live updates from
  // Desktop win while they match the current apiBase; a base change falls back to cache.
  const seededDesktopPort = readCachedDesktopPort(apiBase);
  const [liveDesktopPort, setLiveDesktopPort] = useState<{ base: string; port: number | null } | null>(null);
  const desktopPort = liveDesktopPort?.base === apiBase ? liveDesktopPort.port : seededDesktopPort;
  const desktopSettled = liveDesktopPort?.base === apiBase;
  // Skip no-op writes: an unstable callback + always-new object would loop with Desktop's effect.
  const setDesktopPort = useCallback((port: number | null) => {
    setLiveDesktopPort((prev) => {
      if (prev?.base === apiBase && prev.port === port) return prev;
      return { base: apiBase, port };
    });
  }, [apiBase]);

  /*
   * Back/Forward across the inner selection has to move the panel too. The
   * outer Integrations strip owns `integrations/claude`, but Desktop's nested
   * hash is read here — otherwise history would change the URL and leave the
   * inner panel showing Code.
   */
  useEffect(() => {
    const syncFromHash = () => setTab(readClaudeTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  const selectTab = (next: ClaudeTab) => {
    // `navigateHash` is a no-op for the current hash, so reselecting the same
    // inner tab adds no history entry.
    navigateHash(next === "desktop" ? DESKTOP_HASH : CODE_HASH);
    setTab(next);
    // preventScroll: focusing the tab must not scroll the page — otherwise the
    // Code/Desktop panels' different header heights make the tab strip jump.
    window.requestAnimationFrame(() => {
      (next === "code" ? codeTabRef : desktopTabRef).current?.focus({ preventScroll: true });
    });
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === "code" ? "desktop" : "code");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("code");
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("desktop");
    }
  };

  return (
    <section className="claude-page">
      {/* Title/subtitle sit above the Code/Desktop strip so the page reads title → selector → body. */}
      <div className="claude-page-intro">
        <div className="page-head">
          <h2>{tab === "code" ? t("claude.pageTitle") : t("claudeDesktop.title")}</h2>
        </div>
        {tab === "code" ? (
          <p className="page-sub">{t("claude.subtitle")}</p>
        ) : (
          <p className="page-sub">
            {desktopPort != null
              ? t("claudeDesktop.subtitle", { port: desktopPort })
              : desktopSettled
                ? t("claudeDesktop.loadFail")
                : t("claudeDesktop.loading")}
          </p>
        )}
      </div>

      <div className="claude-tabs" role="tablist" aria-label={t("claude.tabsLabel")}>
        <button
          type="button"
          role="tab"
          ref={codeTabRef}
          aria-selected={tab === "code"}
          aria-controls="claude-code-panel"
          id="claude-code-tab"
          className={tab === "code" ? "active" : ""}
          tabIndex={tab === "code" ? 0 : -1}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("code")}
        >
          {t("claude.tabCode")}
        </button>
        <button
          type="button"
          role="tab"
          ref={desktopTabRef}
          aria-selected={tab === "desktop"}
          aria-controls="claude-desktop-panel"
          id="claude-desktop-tab"
          className={tab === "desktop" ? "active" : ""}
          tabIndex={tab === "desktop" ? 0 : -1}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("desktop")}
        >
          {t("claude.tabDesktop")}
        </button>
      </div>

      {/* Both stay mounted so draft/UI state survives tab switches; Desktop pauses polls while hidden. */}
      <div
        id="claude-code-panel"
        role="tabpanel"
        aria-labelledby="claude-code-tab"
        hidden={tab !== "code"}
      >
        {/* Mounted while hidden so drafts survive a tab switch, but `active` keeps it from
            fetching for a panel nobody is looking at — mirroring Desktop below. */}
        <ClaudeCode key={apiBase} apiBase={apiBase} active={active && tab === "code"} />
      </div>
      <div
        id="claude-desktop-panel"
        role="tabpanel"
        aria-labelledby="claude-desktop-tab"
        hidden={tab !== "desktop"}
      >
        <ClaudeDesktop
          key={apiBase}
          apiBase={apiBase}
          active={active && tab === "desktop"}
          onPortChange={setDesktopPort}
        />
      </div>
    </section>
  );
}
