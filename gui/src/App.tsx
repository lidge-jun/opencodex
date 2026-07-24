import { useEffect, useRef, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Combos from "./pages/Combos";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Usage from "./pages/Usage";
import Storage from "./pages/Storage";
import CodexAuth from "./pages/CodexAuth";
import ApiKeys from "./pages/ApiKeys";
import ClaudeCode from "./pages/ClaudeCode";
import Startup from "./pages/Startup";
import ErrorBoundary from "./components/ErrorBoundary";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconKey, IconGithub, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconSparkle, IconX } from "./icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "./i18n";
import { Select, Switch } from "./ui";
import { installApiAuthFetch } from "./api";

installApiAuthFetch();

type Page = "dashboard" | "startup" | "providers" | "models" | "combos" | "subagents" | "logs" | "usage" | "storage" | "codex-auth" | "api" | "claude";
type Theme = "light" | "dark" | "system";

const VALID_PAGES = new Set<Page>(["dashboard", "startup", "providers", "models", "combos", "subagents", "logs", "usage", "storage", "codex-auth", "api", "claude"]);

const PAGE_TKEY: Record<Page, TKey> = {
  dashboard: "nav.dashboard",
  startup: "nav.startup",
  providers: "nav.providers",
  models: "nav.models",
  combos: "nav.combos",
  subagents: "nav.subagents",
  logs: "nav.logs",
  usage: "nav.usage",
  storage: "nav.storage",
  "codex-auth": "nav.codexAuth",
  api: "nav.api",
  claude: "nav.claude",
};

function readPageFromHash(): Page {
  const raw = location.hash.replace(/^#\/?/, "");
  // Sub-views use a "/" suffix (e.g. #providers/workspace); the first segment is the page id.
  const pageId = raw.split("/")[0] as Page;
  // Legacy: Debug used to be a standalone page; it now lives as a tab on Logs.
  if (pageId === ("debug" as Page)) return "logs";
  return VALID_PAGES.has(pageId) ? pageId : "dashboard";
}

function hashBelongsToPage(rawHash: string, page: Page): boolean {
  return rawHash === page
    || (page === "providers" && rawHash === "providers/workspace")
    || (page === "logs" && rawHash === "logs/debug");
}

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";
const PROVIDERS_VIEW_KEY = "ocx-providers-view";

function readProvidersViewPreference(): "classic" | "workspace" {
  try {
    return localStorage.getItem(PROVIDERS_VIEW_KEY) === "workspace" ? "workspace" : "classic";
  } catch {
    return "classic";
  }
}

function writeProvidersViewPreference(view: "classic" | "workspace"): void {
  try {
    localStorage.setItem(PROVIDERS_VIEW_KEY, view);
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function providersHashForPage(): string {
  return readProvidersViewPreference() === "workspace" ? "providers/workspace" : "providers";
}

const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  { id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey },
  { id: "api", tkey: "nav.api", Icon: IconGlobe },
  { id: "claude", tkey: "nav.claude", Icon: IconSparkle },
];

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;
const THEME_TKEY: Record<Theme, TKey> = { light: "theme.light", dark: "theme.dark", system: "theme.system" };

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export default function App() {
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const { locale, setLocale } = useI18n();
  const t = useT();

  // Narrow screens: the sidebar becomes an off-canvas drawer behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navWasOpen = useRef(false);

  useEffect(() => {
    // External navigation (hash edit, back/forward) also dismisses the mobile drawer.
    const onHash = () => {
      const nextPage = readPageFromHash();
      const rawHash = window.location.hash.replace(/^#\/?/, "");
      setNavOpen(false);
      // Legacy #debug deep links → the Debug tab on Logs.
      if (rawHash === "debug" || rawHash.startsWith("debug/")) {
        window.location.hash = "logs/debug";
        return;
      }
      if (!hashBelongsToPage(rawHash, nextPage)) {
        window.location.hash = nextPage === "providers" ? providersHashForPage() : nextPage;
        return;
      }
      // Preference is source of truth for Classic/Workspace. Bare #providers must not
      // wipe a saved workspace choice (that regressed when leaving Providers and returning).
      if (nextPage === "providers") {
        const preferred = readProvidersViewPreference();
        if (rawHash === "providers/workspace") {
          writeProvidersViewPreference("workspace");
        } else if (rawHash === "providers" && preferred === "workspace") {
          window.location.hash = "providers/workspace";
          return;
        } else if (rawHash === "providers") {
          writeProvidersViewPreference("classic");
        }
      }
      setPageState(nextPage);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const rawHash = window.location.hash.replace(/^#\/?/, "");
    // Legacy #debug deep links must resolve before generic normalization
    // (otherwise the hash collapses to bare #logs and the tab choice is lost).
    if (rawHash === "debug" || rawHash.startsWith("debug/")) {
      window.location.hash = "logs/debug";
      return;
    }
    if (page === "providers") {
      // Honor an explicit workspace deep link on first load before normalizing
      // to the saved preference (bookmarks/shared links must not open Classic).
      if (rawHash === "providers/workspace") {
        writeProvidersViewPreference("workspace");
        return;
      }
      const wanted = providersHashForPage();
      if (rawHash !== wanted) window.location.hash = wanted;
      return;
    }
    if (!hashBelongsToPage(rawHash, page)) {
      window.location.hash = page;
    }
  }, [page]);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const fetchRuntimeVersion = async () => {
      try {
        const res = await fetch(`${API_BASE}/healthz`);
        if (!res.ok) return;
        const version = readRuntimeVersion(await res.json());
        if (!cancelled && version) setRuntimeVersion(version);
      } catch {
        // Keep the build-time fallback when the proxy is unavailable.
      }
    };
    fetchRuntimeVersion();
    const interval = setInterval(fetchRuntimeVersion, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];
  const displayedVersion = runtimeVersion ?? __APP_VERSION__;

  const [stopping, setStopping] = useState(false);
  // Claude navigation row also owns the connection toggle.
  const [claudeEnabled, setClaudeEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";         // no background scroll behind the drawer
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, [navOpen]);

  // Move focus into the drawer on open; hand it back to the toggle on close.
  useEffect(() => {
    if (navOpen) {
      navWasOpen.current = true;
      // after the 180ms slide-in: while visibility is transitioning, focus() no-ops
      const timer = setTimeout(() => sidebarRef.current?.focus(), 200);
      return () => clearTimeout(timer);
    }
    if (navWasOpen.current) { navWasOpen.current = false; menuBtnRef.current?.focus(); }
  }, [navOpen]);

  // Growing the window past the breakpoint dismisses the drawer state.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 761px)");
    const onChange = () => { if (mq.matches) setNavOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/claude-code`)
      .then(res => res.json())
      .then(d => { if (!cancelled && typeof d.enabled === "boolean") setClaudeEnabled(d.enabled); })
      .catch(() => { /* toggle stays hidden until the API answers */ });
    return () => { cancelled = true; };
  }, []);

  const toggleClaude = async () => {
    if (claudeEnabled === null) return;
    const next = !claudeEnabled;
    setClaudeEnabled(next); // optimistic
    try {
      const res = await fetch(`${API_BASE}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) setClaudeEnabled(!next);
    } catch {
      setClaudeEnabled(!next);
    }
  };
  const handleStop = async () => {
    if (!confirm(t("dash.stopConfirm"))) return;
    setStopping(true);
    try { await fetch(`${API_BASE}/api/stop`, { method: "POST" }); } catch { /* connection drops */ }
  };

  const brand = (
    <div className="brand">
      <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
      <span className="name">opencodex</span>
      <span className="ver">v{displayedVersion}</span>
    </div>
  );

  return (
    <div className="app">
      {/* inert while the drawer is open: keeps focus and assistive tech inside the drawer */}
      <header className="mobile-topbar" inert={navOpen}>
        <button ref={menuBtnRef} type="button" className="menu-toggle" onClick={() => setNavOpen(o => !o)}
          aria-expanded={navOpen} aria-controls="app-sidebar"
          aria-label={t(navOpen ? "nav.closeMenu" : "nav.openMenu")} title={t(navOpen ? "nav.closeMenu" : "nav.openMenu")}>
          <IconMenu />
        </button>
        {brand}
        <button type="button" className="theme-toggle stop-toggle" onClick={handleStop} disabled={stopping}
          aria-label={t("dash.stop")} title={t("dash.stop")}>
          <IconPower />
        </button>
      </header>
      {navOpen && <div className="drawer-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside id="app-sidebar" className={`sidebar${navOpen ? " open" : ""}`} ref={sidebarRef} tabIndex={-1}>
        <div className="drawer-head">
          {brand}
          <button type="button" className="menu-toggle drawer-close" onClick={() => setNavOpen(false)}
            aria-label={t("nav.closeMenu")} title={t("nav.closeMenu")}>
            <IconX />
          </button>
        </div>
        <nav>
          {NAV.map(({ id, tkey, Icon }) => (
            <div key={id} className={`nav-entry${id === "claude" ? ` nav-entry-claude${page === id ? " active" : ""}` : ""}`}>
              <button className={`nav-item${page === id ? " active" : ""}`} data-page={id}
                onClick={() => {
                  // Always sync the hash on nav click so Providers restores Classic/Workspace preference.
                  window.location.hash = id === "providers" ? providersHashForPage() : id;
                  setPageState(id);
                  setNavOpen(false);
                }}
                aria-current={page === id ? "page" : undefined}>
                <Icon /> {t(tkey)}
              </button>
              {id === "claude" && claudeEnabled !== null && (
                <Switch on={claudeEnabled} onClick={() => void toggleClaude()} label={t("claude.toggleAria")} />
              )}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="lang-toggle">
            <IconGlobe aria-hidden />
            <Select
              value={locale}
              options={LOCALES.map(l => ({ value: l.code, label: l.name }))}
              onChange={v => setLocale(v as Locale)}
              label={t("lang.label")}
              placement="right"
              style={{ flex: 1, minWidth: 0, width: "100%" }}
            />
          </div>
          <button type="button" className="theme-toggle" onClick={cycleTheme}
            aria-label={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`} title={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}>
            <ThemeIcon /> <span className="mode">{t(THEME_TKEY[theme])}</span>
          </button>
          <button type="button" className="theme-toggle stop-toggle" onClick={handleStop} disabled={stopping}
            aria-label={t("dash.stop")} title={t("dash.stop")}>
            <IconPower /> <span className="mode">{stopping ? t("dash.stopping") : t("dash.stop")}</span>
          </button>
          <a className="sidebar-link" href="https://github.com/lidge-jun/opencodex" target="_blank" rel="noreferrer">
            <IconGithub /> {t("common.github")}
          </a>
        </div>
      </aside>

      <main className="main" inert={navOpen}>
        <div className={`main-inner${page === "combos" ? " main-inner--combos" : ""}${page === "providers" ? " main-inner--providers" : ""}`}>
          <ErrorBoundary
            key={page}
            pageName={t(PAGE_TKEY[page])}
            title={t("errorBoundary.title")}
            message={t("errorBoundary.message")}
            detailsLabel={t("errorBoundary.details")}
            reloadLabel={t("errorBoundary.reload")}
          >
            {page === "dashboard" && <Dashboard apiBase={API_BASE} />}
            {page === "startup" && <Startup apiBase={API_BASE} />}
            {page === "providers" && <Providers apiBase={API_BASE} />}
            {page === "models" && <Models apiBase={API_BASE} />}
            {page === "combos" && <Combos apiBase={API_BASE} />}
            {page === "subagents" && <Subagents apiBase={API_BASE} />}
            {page === "logs" && <Logs apiBase={API_BASE} />}
            {page === "usage" && <Usage apiBase={API_BASE} />}
            {page === "storage" && <Storage apiBase={API_BASE} />}
            {page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}
            {page === "api" && <ApiKeys apiBase={API_BASE} />}
            {page === "claude" && <ClaudeCode apiBase={API_BASE} />}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
