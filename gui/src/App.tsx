import { useCallback, useEffect, useRef, useState } from "react";
import { setClientResourceData, useKeyedClientResource } from "./client-resource";
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
import Claude from "./pages/Claude";
import Grok from "./pages/Grok";
import Startup from "./pages/Startup";
import ErrorBoundary from "./components/ErrorBoundary";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconKey, IconGithub, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconSparkle, IconX } from "./icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "./i18n/shared";
import { Select, Switch } from "./ui";
import { installApiAuthFetch } from "./api";
import { readJsonIfOk } from "./fetch-json";
import { type Page } from "./app-routing";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";

installApiAuthFetch();

type Theme = "light" | "dark" | "system";

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
  grok: "nav.grok",
};

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  { id: "api", tkey: "nav.api", Icon: IconGlobe },
  { id: "claude", tkey: "nav.claude", Icon: IconSparkle },
  { id: "grok", tkey: "nav.grok", Icon: IconBoxes },
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
  const { page, navigateToPage } = useAppRouteState();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const { locale, setLocale } = useI18n();
  const t = useT();

  // Narrow screens: the sidebar becomes an off-canvas drawer behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navWasOpen = useRef(false);

  useEffect(() => {
    // External navigation (hash edit, back/forward) also dismisses the mobile drawer.
    const dismissNav = () => setNavOpen(false);
    window.addEventListener("hashchange", dismissNav);
    window.addEventListener("popstate", dismissNav);
    return () => {
      window.removeEventListener("hashchange", dismissNav);
      window.removeEventListener("popstate", dismissNav);
    };
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  const healthPoll = useKeyedClientResource(
    `app-healthz:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/healthz`, { signal });
      if (!res.ok) return null;
      return readRuntimeVersion(await res.json());
    },
    { pollMs: 30_000 },
  );

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];
  const displayedVersion: string = healthPoll.data ?? __APP_VERSION__;

  const [stopping, setStopping] = useState(false);
  // Claude navigation row also owns the connection toggle.
  const fetchClaudeEnabled = useCallback(async (signal: AbortSignal) => {
    const res = await fetch(`${API_BASE}/api/claude-code`, { signal });
    const d = await readJsonIfOk<{ enabled?: unknown }>(res);
    return d && typeof d.enabled === "boolean" ? d.enabled : null;
  }, []);

  const claudePoll = useKeyedClientResource(
    `app-claude-code:${API_BASE}`,
    [],
    fetchClaudeEnabled,
  );
  const claudeEnabled = claudePoll.data ?? null;
  const claudeToggleInFlight = useRef(false);
  const [claudeTogglePending, setClaudeTogglePending] = useState(false);

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

  const toggleClaude = async () => {
    if (claudeEnabled === null || claudeToggleInFlight.current) return;
    claudeToggleInFlight.current = true;
    setClaudeTogglePending(true);
    const next = !claudeEnabled;
    setClientResourceData(`app-claude-code:${API_BASE}`, next);
    try {
      const res = await fetch(`${API_BASE}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) setClientResourceData(`app-claude-code:${API_BASE}`, !next);
    } catch {
      setClientResourceData(`app-claude-code:${API_BASE}`, !next);
    } finally {
      claudeToggleInFlight.current = false;
      setClaudeTogglePending(false);
    }
  };
  const handleStop = async () => {
    if (!confirm(t("dash.stopConfirm"))) return;
    setStopping(true);
    const outcome = await requestProxyStop(API_BASE, {
      formatFailure: status => t("dash.stopFailed", { status: String(status) }),
    });
    // Refusals and restore failures return normally instead of dropping the connection.
    // In both cases the proxy did not reach a clean-stop result, so re-enable the control
    // and surface the server's remediation instead of leaving "stopping…" stuck forever.
    if (!outcome.accepted) {
      setStopping(false);
      alert(outcome.message);
    }
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
          {/*
            Codex Auth was once filtered out of this list whenever the workspace layout
            was active, on the grounds that the Providers workspace embeds the same
            account pool. It is now promoted to the second slot instead: there is only
            one layout, so that filter would have hidden the page permanently.
          */}
          {NAV.map(({ id, tkey, Icon }) => (
            <div key={id} className={`nav-entry${id === "claude" ? ` nav-entry-claude${page === id ? " active" : ""}` : ""}`}>
              <button type="button" className={`nav-item${page === id ? " active" : ""}`} data-page={id}
                onClick={() => {
                  // Deliberate sidebar navigation — push a history entry.
                  navigateToPage(id);
                  setNavOpen(false);
                }}
                aria-current={page === id ? "page" : undefined}>
                <Icon /> {t(tkey)}
              </button>
              {id === "claude" && claudeEnabled !== null && (
                <Switch
                  on={claudeEnabled}
                  onClick={() => void toggleClaude()}
                  disabled={claudeTogglePending}
                  label={t("claude.toggleAria")}
                />
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
              portal={false}
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
        <div className={`main-inner${page === "combos" ? " main-inner--combos" : ""}`}>
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
            {page === "claude" && <Claude apiBase={API_BASE} />}
            {page === "grok" && <Grok apiBase={API_BASE} />}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
