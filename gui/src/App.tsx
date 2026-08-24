import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "./client-resource";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Usage from "./pages/Usage";
import Storage from "./pages/Storage";
import CodexAuth from "./pages/CodexAuth";
import Integrations from "./pages/Integrations";
import Startup from "./pages/Startup";
import ErrorBoundary from "./components/ErrorBoundary";
import { SidebarGithubRow } from "./components/sidebar-github-row";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconKey, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconX, IconRefresh, IconShuffle, IconTerminal } from "./icons";
import { useI18n, useT, LOCALES, localeDisplayName, type Locale, type TKey } from "./i18n/shared";
import { Select } from "./ui";
import { installApiAuthFetch } from "./api";
import { type Page } from "./app-routing";
import { readModelsTab, type ModelsTab } from "./pages/models-tab";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { useCodexRestart } from "./use-codex-restart";
import { normalizeHashPath } from "./hash-routing";

installApiAuthFetch();

type Theme = "light" | "dark" | "system";

const PAGE_TKEY: Record<Page, TKey> = {
  dashboard: "nav.dashboard",
  startup: "nav.startup",
  providers: "nav.providers",
  models: "nav.models",
  subagents: "nav.subagents",
  logs: "nav.logs",
  usage: "nav.usage",
  storage: "nav.storage",
  "codex-auth": "nav.codexAuth",
  integrations: "nav.integrations",
};

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

type NavEntry = {
  id: Page;
  tkey: TKey;
  Icon: typeof IconGrid;
  subPath?: string;
};

type NavGroup = { tkey: TKey; entries: NavEntry[] };

const NAV_GROUPS: NavGroup[] = [
  {
    tkey: "navGroup.overview",
    entries: [{ id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid }],
  },
  {
    tkey: "navGroup.resources",
    entries: [
      { id: "providers", tkey: "nav.providers", Icon: IconServer },
      { id: "models", tkey: "nav.models", Icon: IconBoxes },
      { id: "integrations", subPath: "keys", tkey: "api.title", Icon: IconKey },
    ],
  },
  {
    tkey: "navGroup.observability",
    entries: [
      { id: "usage", tkey: "nav.usage", Icon: IconActivity },
      { id: "logs", tkey: "nav.logs", Icon: IconList },
    ],
  },
  {
    tkey: "navGroup.automation",
    entries: [
      { id: "models", subPath: "routing", tkey: "routing.title", Icon: IconShuffle },
      { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
    ],
  },
  {
    tkey: "navGroup.system",
    entries: [
      { id: "integrations", tkey: "nav.integrations", Icon: IconGlobe },
      { id: "startup", tkey: "nav.startup", Icon: IconTerminal },
      { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
    ],
  },
];

const NAV = NAV_GROUPS.flatMap(group => group.entries);

function navTarget(entry: NavEntry): string {
  return entry.subPath ? `${entry.id}/${entry.subPath}` : entry.id;
}

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
  /*
   * App needs the Models tab for one reason only: the full-bleed combos modifier lives
   * on `.main-inner`, which is App's element. Models owns every other tab concern.
   */
  const [modelsTab, setModelsTab] = useState<ModelsTab>(readModelsTab);
  const [routeHash, setRouteHash] = useState(() => normalizeHashPath(window.location.hash));
  useEffect(() => {
    const syncRoute = () => {
      setModelsTab(readModelsTab());
      setRouteHash(normalizeHashPath(window.location.hash));
    };
    window.addEventListener("hashchange", syncRoute);
    window.addEventListener("popstate", syncRoute);
    return () => {
      window.removeEventListener("hashchange", syncRoute);
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);
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

  // The sidebar control is on every page, including Models. Bumping an epoch on a
  // settled restart lets the models tab re-read staleness without the two surfaces
  // sharing a controller — the backend is already single-flight, so what is missing
  // is invalidation, not mutual exclusion.
  const [codexRestartEpoch, setCodexRestartEpoch] = useState(0);
  const { restarting: codexRestarting, restart: handleCodexRestart } = useCodexRestart(API_BASE, {
    onSettled: () => setCodexRestartEpoch(epoch => epoch + 1),
  });

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
      <span className="name">{t("app.name")}</span>
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
        <div className="mobile-topbar-actions">
          <button type="button" className="sidebar-orb sidebar-orb--danger" onClick={handleStop} disabled={stopping}
            aria-label={t("dash.stop")} title={t("dash.stop")}>
            <IconPower />
          </button>
          <button type="button" className="sidebar-orb"
            onClick={() => { void handleCodexRestart(); }} disabled={codexRestarting}
            aria-label={t("dash.codexRestart")} title={t("dash.codexRestart")}>
            <IconRefresh />
          </button>
        </div>
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
        <nav aria-label={t("nav.main")}>
          {NAV_GROUPS.map(group => (
            <section className="nav-group" key={group.tkey} aria-labelledby={`nav-${group.tkey}`}>
              <h2 className="nav-group-label" id={`nav-${group.tkey}`}>{t(group.tkey)}</h2>
              <div className="nav-group-items">
                {group.entries.map(entry => {
                  const { id, subPath, tkey, Icon } = entry;
                  const exactEntry = NAV.find(candidate => navTarget(candidate) === routeHash);
                  const active = exactEntry ? exactEntry === entry : !subPath && id === page;
                  return (
                    <div key={navTarget(entry)} className="nav-entry">
                      <button type="button" className={`nav-item${active ? " active" : ""}`}
                        data-page={navTarget(entry)}
                        onClick={() => {
                          navigateToPage(id, subPath);
                          setNavOpen(false);
                        }}
                        aria-current={active ? "page" : undefined}>
                        <Icon /> <span>{t(tkey)}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="lang-toggle">
            <IconGlobe aria-hidden />
            <Select
              value={locale}
              options={LOCALES.map(l => ({ value: l.code, label: localeDisplayName(l.code) }))}
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
          <div className="sidebar-action-row">
            <span className="sidebar-action-label">{t("dash.actions")}</span>
            <div className="sidebar-action-orbs">
              <button type="button" className="sidebar-orb sidebar-orb--danger"
                onClick={handleStop} disabled={stopping}
                aria-label={stopping ? t("dash.stopping") : t("dash.stop")}
                title={stopping ? t("dash.stopping") : t("dash.stop")}>
                <IconPower />
              </button>
              <button type="button" className="sidebar-orb"
                onClick={() => { void handleCodexRestart(); }} disabled={codexRestarting}
                aria-label={codexRestarting ? t("dash.codexRestarting") : t("dash.codexRestart")}
                title={codexRestarting ? t("dash.codexRestarting") : t("dash.codexRestart")}>
                <IconRefresh />
              </button>
            </div>
          </div>
          <SidebarGithubRow
            apiBase={API_BASE}
            onOpenUpdate={() => {
              // The update dialog lives on the dashboard maintenance panel. Deep-link to
              // `#dashboard/update` and let the dashboard own the check/run flow — no
              // cross-component event bus, and the link survives a refresh.
              setNavOpen(false);
              navigateToPage("dashboard", "update");
            }}
          />
        </div>
      </aside>

      <main className="main" inert={navOpen}>
        {/*
          Combos is full-bleed, unlike every other surface, and it is reachable only as
          a Models tab. `.main-inner` is App's element, so App is the only place that
          can know which tab is showing.
        */}
        <div className={`main-inner${
          page === "models" && modelsTab === "combos" ? " main-inner--combos" : ""
        }`}>
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
            {page === "models" && <Models key={API_BASE} apiBase={API_BASE} restartEpoch={codexRestartEpoch} />}
            {page === "subagents" && <Subagents key={API_BASE} apiBase={API_BASE} />}
            {page === "logs" && <Logs apiBase={API_BASE} />}
            {page === "usage" && <Usage apiBase={API_BASE} />}
            {page === "storage" && <Storage apiBase={API_BASE} />}
            {page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}
            {page === "integrations" && <Integrations apiBase={API_BASE} />}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
