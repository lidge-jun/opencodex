import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
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
import RemoteLink from "./pages/RemoteLink";
import ErrorBoundary from "./components/ErrorBoundary";
import QuotaSummaryBar from "./components/quota-summary-bar/QuotaSummaryBar";
import { SidebarGithubRow } from "./components/sidebar-github-row";
import { DesktopStarOnboarding } from "./components/desktop-star-onboarding";
import { IconMenu, IconGlobe, IconPower, IconX, IconRefresh} from "./icons";
import { NAV_GROUPS, groupForPage, visibleGroupPages } from "./nav-groups";
import { SectionSwitcher } from "./components/SectionSwitcher";
import { useI18n, useT, LOCALES, localeDisplayName, type Locale, type TKey } from "./i18n/shared";
import { Notice, Select, ToastNotice, type NoticeTone } from "./ui";
import { configureApiTargets, hasApiSession, installApiAuthFetch, installApiSessionFromHtml, logoutApiSession, SESSION_UNAVAILABLE_EVENT } from "./api";
import { adminTokenPromptAllowed, apiBaseForPlane, discoverApiTargets, isConnectedRuntime, runtimeRoleFromDocument, standaloneApiTargets, type ApiTargets } from "./api-targets";
import { ConnectPairingForm } from "./connect-pairing";
import { type Page } from "./app-routing";
import { readModelsTab, type ModelsTab } from "./pages/models-tab";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { useCodexRestart } from "./use-codex-restart";
import { confirmAction } from "./action-dialogs";
import { hostOs, isDesktopShell, isExternalLink, openDesktopCliPage, openDesktopUpdatePage } from "./lib/desktop-shell";
import { zoomManagedOn } from "./lib/desktop-zoom";
import { useSidebarCollapse } from "./use-sidebar-collapse";
import { useDesktopZoom } from "./use-desktop-zoom";
import { DesktopZoomControl } from "./components/desktop-zoom-control";
import { ThemeSwitch, type ThemeMode } from "./components/theme-switch";
import { MainTopStrip, SidebarTopStrip } from "./components/app-titlebar";
import { watchMacTitlebarMetrics, windowChromeHandlers } from "./lib/window-chrome";

type Theme = ThemeMode;

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
  "remote-workspace": "nav.remoteWorkspace",
  "codex-set": "nav.codexSet",
  integrations: "nav.connect",
  claude: "nav.claude",
};

const API_BASE = import.meta.env.VITE_API_BASE || "";
const INITIAL_TARGETS = standaloneApiTargets(API_BASE);
configureApiTargets(INITIAL_TARGETS);
installApiAuthFetch();
const THEME_KEY = "ocx-theme";


export interface RemoteWorkspaceRouteProps {
  available: boolean;
  apiBase: string;
  hubOrigin: string;
  onOpenRemoteLink: () => void;
}

export function RemoteWorkspaceRoute({ available, apiBase, hubOrigin, onOpenRemoteLink }: RemoteWorkspaceRouteProps): ReactElement {
  const t = useT();
  if (!available) {
    return <section className="panel"><h2>{t("nav.remoteWorkspace")}</h2><Notice tone="warn">{t("link.workspaceUnavailable")} <button type="button" className="link-btn" onClick={onOpenRemoteLink}>{t("nav.remote")}</button></Notice></section>;
  }
  return <RemoteWorkspace apiBase={apiBase} hubOrigin={hubOrigin} />;
}

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

/*
 * The section switcher hides once only one member is left (Remote Workspace becoming
 * unavailable). If a switcher button had focus, hand it to this page's sidebar row when that
 * row is on screen, else to the main region, so keyboard focus never drops to <body>.
 */
function focusAfterSwitcher(): void {
  const row = document.querySelector<HTMLElement>(".sidebar .nav-item.active");
  const box = row?.getBoundingClientRect();
  const onScreen = !!box && box.width > 0 && box.height > 0
    && box.right > 0 && box.left < window.innerWidth
    && box.bottom > 0 && box.top < window.innerHeight;
  if (row && onScreen) {
    row.focus({ preventScroll: true });
    return;
  }
  const main = document.querySelector<HTMLElement>("main.main");
  if (!main) return;
  main.tabIndex = -1;
  main.focus({ preventScroll: true });
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
  const [sharedSessionEpoch, setSharedSessionEpoch] = useState(0);
  const [remoteWorkspaceAvailableState, setRemoteWorkspaceAvailable] = useState(false);
  const [sessionLoggingOut, setSessionLoggingOut] = useState(false);
  /*
   * Results from the two sidebar orbs used to be `alert()`, which the app's webview draws
   * nowhere, so a refused stop and a completed one looked identical: nothing happened.
   * The toast is portaled, so reporting from the shell costs the page no layout.
   */
  const [actionFeedback, setActionFeedback] = useState<{ tone: NoticeTone; text: string } | null>(null);
  /** Bumped on every report so a repeated identical message restarts the dismiss timer. */
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const report = useCallback((text: string, tone: NoticeTone) => {
    setActionFeedback({ tone, text });
    setFeedbackRevision(revision => revision + 1);
  }, []);

  useEffect(() => {
    const unavailable = (event: Event) => {
      if ((event as CustomEvent<{ plane?: string }>).detail?.plane === "shared" && !hasApiSession("shared")) {
        setSharedSessionReady(false);
      }
    };
    window.addEventListener(SESSION_UNAVAILABLE_EVENT, unavailable);
    return () => window.removeEventListener(SESSION_UNAVAILABLE_EVENT, unavailable);
  }, []);

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

  useEffect(() => {
    if (!sharedSessionReady) return;
    const controller = new AbortController();
    void fetch(`${sharedBase}/api/remote-workspace`, { signal: controller.signal, cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<{ available?: unknown }> : Promise.reject(new Error("unavailable")))
      .then(value => { if (!controller.signal.aborted) setRemoteWorkspaceAvailable(value.available === true); })
      .catch(() => { if (!controller.signal.aborted) setRemoteWorkspaceAvailable(false); });
    return () => controller.abort();
  }, [page, sharedSessionReady, sharedBase]);
  const remoteWorkspaceAvailable = sharedSessionReady && remoteWorkspaceAvailableState;
  // The sidebar row that owns this page, and the members its switcher may offer.
  const activeGroup = groupForPage(page);
  const sectionPages = activeGroup ? visibleGroupPages(activeGroup, { remoteWorkspaceAvailable }) : [];
  // Claude is a tab inside Connect: both pages render one Integrations shell under one
  // boundary, so moving between Claude and another Connect tab keeps drafts and focus.
  const shellPage: Page = page === "claude" ? "integrations" : page;
  // A standalone/hub dashboard exposed through an authenticated non-loopback origin can need a
  // consent-bearing GUI session even though it is not a connected client. Remote Link requires
  // that stronger principal, so offer the existing one-time pairing flow instead of a dead-end
  // "sign in" warning. Other pages keep their ordinary admin-token flow unchanged.
  const remotePairingRequired = page === "remote" && !sharedSessionReady
    && runtimeRoleFromDocument() === "hub" && adminTokenPromptAllowed();

  // Narrow screens: the sidebar becomes an off-canvas drawer behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);
  // Codex-style rail collapse on wide screens, persisted; Cmd/Ctrl+B toggles too.
  const desktopShell = isDesktopShell();
  const { collapsed: navCollapsed, toggle: toggleNavCollapse } = useSidebarCollapse({ shortcut: desktopShell });
  const desktopMac = desktopShell && hostOs() === "macos";
  const zoomManaged = desktopShell && zoomManagedOn(hostOs());
  const desktopZoom = useDesktopZoom({ managed: zoomManaged });
  const appRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (desktopMac && appRef.current) return watchMacTitlebarMetrics(appRef.current);
  }, [desktopMac]);
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
    if (!isDesktopShell()) return;
    const interceptExternalLinks = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.href;
      if (!isExternalLink(href)) return;
      event.preventDefault();
      // Rust denies external HTTP(S) navigation and opens it in the system browser.
      window.location.assign(href);
    };
    document.addEventListener("click", interceptExternalLinks, true);
    return () => document.removeEventListener("click", interceptExternalLinks, true);
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  // Success expires on its own; a failure and a degraded result stay until the user
  // dismisses them, because those are the two the user has to act on.
  useEffect(() => {
    if (actionFeedback?.tone !== "ok") return;
    const timer = window.setTimeout(() => setActionFeedback(null), 4500);
    return () => window.clearTimeout(timer);
  }, [actionFeedback, feedbackRevision]);

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

  const themeSwitch = <ThemeSwitch theme={theme} onChange={setTheme} />;
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
    report,
  });

  const handleStop = async () => {
    const consented = await confirmAction({
      message: t(targets.connected ? "connection.disconnectConfirm" : "dash.stopConfirm"),
      confirmLabel: t(targets.connected ? "connection.disconnect" : "dash.stop"),
      tone: "danger",
    });
    if (!consented) return;
    setStopping(true);
    const outcome = await requestProxyStop(machineBase, {
      formatFailure: status => t("dash.stopFailed", { status: String(status) }),
      formatStillRunning: () => t("dash.stopStillRunning"),
      formatUnknown: () => t("dash.stopUnknown"),
      mode: targets.connected ? "client" : "standalone",
    });
    /*
     * Only an accepted stop leaves the control pending, because the page is about to go
     * away with the server. A refusal and an unknown both mean the user is still here and
     * still looking at a running dashboard, so the control comes back either way.
     *
     * They are not reported the same, though. A refusal is the server's own answer and
     * reads as a failure; an unknown is the absence of an answer, and claiming either
     * success or failure there is the thing this lane exists to stop.
     */
    if (outcome.status !== "accepted") {
      setStopping(false);
      report(outcome.message, outcome.status === "rejected" ? "err" : "warn");
    }
  };

  const handleSessionLogout = async () => {
    if (sessionLoggingOut) return;
    setSessionLoggingOut(true);
    const loggedOut = await logoutApiSession("shared");
    setSessionLoggingOut(false);
    if (loggedOut) setSharedSessionReady(false);
    else report(t("connection.sessionLogoutFailed"), "err");
  };

  /*
   * The brand is the control users reach for first when they want out of a deep page,
   * and it used to be an inert <div>: clicking the logo did nothing, so a user on
   * #providers had no obvious way back to the first screen. It is a button now.
   *
   * One node, two mount points (mobile topbar and drawer head), so both become
   * interactive from this single definition. `navigateToPage` is the deliberate-
   * navigation helper the nav rows use — it pushes a history entry, so Back still
   * returns to where the user came from — and closing the drawer is required because
   * the second mount lives inside it.
   */
  const brand = (
    <button
      type="button"
      className="brand brand-home"
      onClick={() => { navigateToPage("dashboard"); setNavOpen(false); }}
      aria-label={t("nav.goHome")}
      title={t("nav.goHome")}
      {...(page === "dashboard" ? { "aria-current": "page" as const } : {})}
    >
      <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
      <span className="name">opencodex</span>
      <span className="ver" title={displayedVersion}>v{displayedVersion}</span>
    </button>
  );

  const quotaSummary = targetsSettled && page !== "startup" && (!targets.connected || sharedSessionReady) && (
    <ErrorBoundary key={sharedBase} pageName={t("quotaSummary.aria")} title={t("errorBoundary.title")} message={t("errorBoundary.message")} detailsLabel={t("errorBoundary.details")} reloadLabel={t("errorBoundary.reload")}>
      <QuotaSummaryBar apiBase={sharedBase} />
    </ErrorBoundary>
  );

  return (
    <div ref={appRef} className={`app${desktopShell ? " app--desktop" : ""}${desktopMac ? " app--macos" : ""}${navCollapsed ? " app--nav-collapsed" : ""}`}>
      <DesktopStarOnboarding apiBase={sharedBase} enabled={targetsSettled && !targets.connected} />
      {actionFeedback && (
        <ToastNotice tone={actionFeedback.tone} onDismiss={() => setActionFeedback(null)} dismissLabel={t("common.close")}>
          {actionFeedback.text}
        </ToastNotice>
      )}
      {/* inert while the drawer is open: keeps focus and assistive tech inside the drawer */}
      {/* At narrow widths the sidebar strip is hidden and the main strip scrolls away, so in
          the desktop shell the sticky header is the window's drag surface. */}
      <header className="mobile-topbar" inert={navOpen} {...(desktopShell ? windowChromeHandlers() : {})}>
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
      {/* Fixed to the window's top-left; kept outside .sidebar so the sidebar's
         backdrop-filter containing block can't clip it to 0 width when collapsed. */}
      <SidebarTopStrip collapsed={navCollapsed} onToggle={toggleNavCollapse} />
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
          {/*
            One row per navigation group (nav-groups.ts). A row lights up for any
            page it owns, so #logs/debug highlights Usage & Logs, and a click opens the
            group's first page.
          */}
          {NAV_GROUPS.map(group => {
            const { id, tkey, Icon } = group;
            const active = activeGroup?.id === id;
            return (
              <div key={id} className="nav-entry">
                <button type="button" className={`nav-item${active ? " active" : ""}`}
                  data-page={group.pages[0]}
                  data-group={id}
                  onClick={() => {
                    // Deliberate sidebar navigation — push a history entry.
                    navigateToPage(group.pages[0]);
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
          {zoomManaged ? (
            <div className="sidebar-display-row">
              {themeSwitch}
              <DesktopZoomControl percent={desktopZoom.percent} canZoomIn={desktopZoom.canZoomIn}
                canZoomOut={desktopZoom.canZoomOut} onStep={desktopZoom.step} />
            </div>
          ) : (
            <div className="sidebar-action-row sidebar-action-row--theme">
              <span className="sidebar-action-label">{t("theme.label")}</span>
              {themeSwitch}
            </div>
          )}
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
              setNavOpen(false);
              if (openDesktopUpdatePage()) return;
              navigateToPage("dashboard", "update");
            }}
            onOpenTerminalCommand={() => {
              setNavOpen(false);
              openDesktopCliPage();
            }}
          />
        </div>
      </aside>

      <main className="main" inert={navOpen}>
        {/* Inside the desktop shell the strip is the integrated title bar's right half —
            draggable, at the very top of the window, level with the traffic lights — so it
            exists even while the bar inside it does not. The browser dashboard keeps the
            bar as it was: no strip, no reserved row. */}
        {desktopShell ? <MainTopStrip>{quotaSummary}</MainTopStrip> : quotaSummary}
        {/*
          Combos is full-bleed, unlike every other surface, and it is reachable only as
          a Models tab. `.main-inner` is App's element, so App is the only place that
          can know which tab is showing.
        */}
        <div className={`main-inner${
          page === "models" && modelsTab === "combos" ? " main-inner--combos" : ""
        }`}>
          {/*
            Outside the page-keyed ErrorBoundary on purpose: that boundary remounts on
            every page change, which would destroy the button the user just activated
            and drop keyboard focus to <body>.
          */}
          {targetsSettled && sectionPages.length > 1 && (
            <SectionSwitcher
              items={sectionPages.map(member => ({ page: member, label: t(PAGE_TKEY[member]) }))}
              currentPage={page}
              onNavigate={navigateToPage}
              ariaLabel={t("nav.sectionNavigation")}
              onFocusOrphaned={focusAfterSwitcher}
            />
          )}
          <ErrorBoundary
            key={shellPage}
            pageName={t(PAGE_TKEY[shellPage])}
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
                {((targets.connected && !sharedSessionReady) || remotePairingRequired) && (
                  <ConnectPairingForm key={`${targets.shared.serverOrigin}:${targets.shared.bootstrapPath}`} target={targets.shared} onConnected={() => {
                    setSharedSessionReady(true);
                    setSharedSessionEpoch(epoch => epoch + 1);
                  }} />
                )}
                {page === "dashboard" && <Dashboard apiBase={sharedBase} connected={targets.connected}
                  authenticationPending={targets.connected && !sharedSessionReady} refreshEpoch={sharedSessionEpoch} />}
                {page === "startup" && <Startup apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
                {page === "providers" && <Providers apiBase={sharedBase} />}
                {page === "models" && <Models key={sharedBase} apiBase={sharedBase} restartEpoch={codexRestartEpoch} connected={targets.connected} catalogSyncedAt={targets.catalogSyncedAt} reportRestart={report} />}
                {page === "subagents" && <Subagents key={sharedBase} apiBase={sharedBase} />}
                {page === "logs" && <Logs apiBase={sharedBase} />}
                {page === "usage" && <Usage apiBase={sharedBase} connected={targets.connected} apiKeyId={targets.apiKeyId} />}
                {page === "storage" && <Storage apiBase={sharedBase} />}
                {page === "remote" && !remotePairingRequired && <RemoteLink apiBase={sharedBase} sessionReady={sharedSessionReady} workspaceAvailable={remoteWorkspaceAvailable} onOpenWorkspace={() => navigateToPage("remote-workspace")} />}
                {page === "remote-workspace" && <RemoteWorkspaceRoute available={remoteWorkspaceAvailable} apiBase={sharedBase} hubOrigin={targets.shared.serverOrigin} onOpenRemoteLink={() => navigateToPage("remote")} />}
                {page === "codex-set" && <CodexSet apiBase={sharedBase} />}
                {shellPage === "integrations" && <Integrations apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
              </>
            )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
