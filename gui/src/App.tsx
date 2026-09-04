import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "./client-resource";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Usage from "./pages/Usage";
import Storage from "./pages/Storage";
import CodexSet from "./pages/CodexSet";
import Integrations from "./pages/Integrations";
import Startup from "./pages/Startup";
import RemoteWorkspace from "./pages/RemoteWorkspace";
import ErrorBoundary from "./components/ErrorBoundary";
import { SidebarGithubRow } from "./components/sidebar-github-row";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconCodex, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconX, IconRefresh} from "./icons";
import { useI18n, useT, LOCALES, localeDisplayName, type Locale, type TKey } from "./i18n/shared";
import { Select } from "./ui";
import { configureApiTargets, hasApiSession, installApiAuthFetch, installApiSessionFromHtml, logoutApiSession } from "./api";
import { apiBaseForPlane, discoverApiTargets, isConnectedRuntime, standaloneApiTargets, type ApiTargets } from "./api-targets";
import { ConnectPairingForm } from "./connect-pairing";
import { type Page } from "./app-routing";
import { readModelsTab, type ModelsTab } from "./pages/models-tab";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { useCodexRestart } from "./use-codex-restart";

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
  remote: "nav.remote",
  "codex-set": "nav.codexSet",
  integrations: "nav.integrations",
};

const API_BASE = import.meta.env.VITE_API_BASE || "";
const INITIAL_TARGETS = standaloneApiTargets(API_BASE);
configureApiTargets(INITIAL_TARGETS);
installApiAuthFetch();
const THEME_KEY = "ocx-theme";

/**
 * Every sidebar row maps one-to-one onto a page again.
 *
 * The Claude row was the exception: a second entry pointing at a tab of Integrations,
 * which needed `subPath`, `activeHashes`, and an `isNavEntryActive` helper whose only
 * job was stopping the sidebar from lighting two rows and claiming the user was in two
 * places. Removing the duplicate removed all four.
 */
type NavEntry = {
  id: Page;
  tkey: TKey;
  Icon: typeof IconGrid;
};

const NAV: NavEntry[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "codex-set", tkey: "nav.codexSet", Icon: IconCodex },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  { id: "remote", tkey: "nav.remote", Icon: IconMonitor },
  { id: "integrations", tkey: "nav.integrations", Icon: IconGlobe },
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
  /*
   * App needs the Models tab for one reason only: the full-bleed combos modifier lives
   * on `.main-inner`, which is App's element. Models owns every other tab concern.
   */
  const [modelsTab, setModelsTab] = useState<ModelsTab>(readModelsTab);
  useEffect(() => {
    const syncModelsTab = () => setModelsTab(readModelsTab());
    window.addEventListener("hashchange", syncModelsTab);
    window.addEventListener("popstate", syncModelsTab);
    return () => {
      window.removeEventListener("hashchange", syncModelsTab);
      window.removeEventListener("popstate", syncModelsTab);
    };
  }, []);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const { locale, setLocale } = useI18n();
  const t = useT();
  const [targets, setTargets] = useState<ApiTargets>(INITIAL_TARGETS);
  // Standalone starts settled: there is nothing to discover, so nothing to wait for.
  // Gating the page on discovery made a plain install show remote-hub loading copy before
  // its own dashboard, for a feature the operator never enabled.
  const [targetsSettled, setTargetsSettled] = useState(() => !isConnectedRuntime());
  const [targetError, setTargetError] = useState(false);
  const [sharedSessionReady, setSharedSessionReady] = useState(() => hasApiSession("shared"));
  const [sessionLoggingOut, setSessionLoggingOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void discoverApiTargets(API_BASE, controller.signal).then(async next => {
      configureApiTargets(next);
      setTargets(next);
      if (next.connected && !hasApiSession("shared")) {
        try {
          const response = await fetch(next.shared.bootstrapPath, {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
          });
          if (response.ok) installApiSessionFromHtml("shared", await response.text());
        } catch { /* pairing form remains available */ }
      }
      if (controller.signal.aborted) return;
      setSharedSessionReady(hasApiSession("shared"));
      setTargetError(false);
      setTargetsSettled(true);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setTargetError(true);
      setTargetsSettled(true);
    });
    return () => controller.abort();
  }, []);
  const machineBase = apiBaseForPlane("machine", targets);
  const sharedBase = apiBaseForPlane("shared", targets);

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
    `app-healthz:${machineBase}`,
    [machineBase, targetsSettled],
    async (signal) => {
      const res = await fetch(`${machineBase}/healthz`, { signal });
      if (!res.ok) return null;
      return readRuntimeVersion(await res.json());
    },
    { pollMs: 30_000, enabled: targetsSettled },
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
  const { restarting: codexRestarting, restart: handleCodexRestart } = useCodexRestart(sharedBase, {
    onSettled: () => setCodexRestartEpoch(epoch => epoch + 1),
  });

  const handleStop = async () => {
    if (!confirm(t(targets.connected ? "connection.disconnectConfirm" : "dash.stopConfirm"))) return;
    setStopping(true);
    const outcome = await requestProxyStop(machineBase, {
      formatFailure: status => t("dash.stopFailed", { status: String(status) }),
      mode: targets.connected ? "client" : "standalone",
    });
    // Refusals and restore failures return normally instead of dropping the connection.
    // In both cases the proxy did not reach a clean-stop result, so re-enable the control
    // and surface the server's remediation instead of leaving "stopping…" stuck forever.
    if (!outcome.accepted) {
      setStopping(false);
      alert(outcome.message);
    }
  };

  const handleSessionLogout = async () => {
    if (sessionLoggingOut) return;
    setSessionLoggingOut(true);
    const loggedOut = await logoutApiSession("shared");
    setSessionLoggingOut(false);
    if (loggedOut) setSharedSessionReady(false);
    else alert(t("connection.sessionLogoutFailed"));
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
        <div className="mobile-topbar-actions">
          {targets.connected && sharedSessionReady && (
            <button type="button" className="sidebar-orb" onClick={() => { void handleSessionLogout(); }} disabled={sessionLoggingOut}
              aria-label={t(sessionLoggingOut ? "connection.sessionLoggingOut" : "connection.sessionLogout")} title={t("connection.sessionLogout")}>
              <IconX />
            </button>
          )}
          <button type="button" className="sidebar-orb sidebar-orb--danger" onClick={handleStop} disabled={stopping}
            aria-label={t(targets.connected ? "connection.disconnect" : "dash.stop")} title={t(targets.connected ? "connection.disconnect" : "dash.stop")}>
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
        <nav>
          {/*
            Codex Auth was once filtered out of this list whenever the workspace layout
            was active, on the grounds that the Providers workspace embeds the same
            account pool. It is now promoted to the second slot instead: there is only
            one layout, so that filter would have hidden the page permanently.
          */}
          {/*
            The sidebar is navigation only — no row owns a mutation. That rule was
            written when the Claude row carried the Claude Code connection switch;
            ClaudeCode owns GET/PUT /api/claude-code now, and the row itself is gone.
          */}
          {NAV.map(entry => {
            const { id, tkey, Icon } = entry;
            const active = id === page;
            return (
              <div key={id} className="nav-entry">
                <button type="button" className={`nav-item${active ? " active" : ""}`}
                  data-page={id}
                  onClick={() => {
                    // Deliberate sidebar navigation — push a history entry.
                    navigateToPage(id);
                    setNavOpen(false);
                  }}
                  aria-current={active ? "page" : undefined}>
                  <Icon /> {t(tkey)}
                </button>
              </div>
            );
          })}
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
              {targets.connected && sharedSessionReady && (
                <button type="button" className="sidebar-orb" onClick={() => { void handleSessionLogout(); }} disabled={sessionLoggingOut}
                  aria-label={t(sessionLoggingOut ? "connection.sessionLoggingOut" : "connection.sessionLogout")}
                  title={t("connection.sessionLogout")}>
                  <IconX />
                </button>
              )}
              <button type="button" className="sidebar-orb sidebar-orb--danger"
                onClick={handleStop} disabled={stopping}
                aria-label={stopping ? t("dash.stopping") : t(targets.connected ? "connection.disconnect" : "dash.stop")}
                title={stopping ? t("dash.stopping") : t(targets.connected ? "connection.disconnect" : "dash.stop")}>
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
            apiBase={sharedBase}
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
            {!targetsSettled ? (
              <div className="alert">{t("connection.discovering")}</div>
            ) : (
              <>
                {/*
                  A failed discovery is a banner, not a replacement. It used to take over the
                  whole body, so a slow or restarting proxy cost a standalone user their
                  dashboard over a plane they never turned on. The requests that actually
                  need the machine plane report their own errors.
                */}
                {targetError && (
                  <div className="alert alert-err" role="alert">{t("connection.machineUnavailable")}</div>
                )}
                {targets.connected && !sharedSessionReady && (
                  <ConnectPairingForm target={targets.shared} onConnected={() => setSharedSessionReady(true)} />
                )}
                {page === "dashboard" && <Dashboard apiBase={sharedBase} />}
                {page === "startup" && <Startup apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
                {page === "providers" && <Providers apiBase={sharedBase} />}
                {page === "models" && <Models key={sharedBase} apiBase={sharedBase} restartEpoch={codexRestartEpoch} />}
                {page === "subagents" && <Subagents key={sharedBase} apiBase={sharedBase} />}
                {page === "logs" && <Logs apiBase={sharedBase} />}
                {page === "usage" && <Usage apiBase={sharedBase} connected={targets.connected} apiKeyId={targets.apiKeyId} />}
                {page === "storage" && <Storage apiBase={sharedBase} />}
                {page === "remote" && <RemoteWorkspace apiBase={sharedBase} />}
                {page === "codex-set" && <CodexSet apiBase={sharedBase} />}
                {page === "integrations" && <Integrations apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
              </>
            )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
