import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useKeyedClientResource } from "./client-resource";
import Dashboard from "./pages/Dashboard";
import Home from "./pages/Home";
import SetupHub from "./pages/SetupHub";
import AdvancedHub from "./pages/AdvancedHub";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Advisor from "./pages/Advisor";
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
import { IconMenu, IconGlobe, IconPower, IconX, IconRefresh, IconHistory } from "./icons";
import { switchDashboardEdition } from "./lib/dashboard-edition";
import { groupForPage, visibleGroupPages } from "./nav-groups";
import { SidebarNav } from "./components/sidebar-nav";
import { SectionSwitcher } from "./components/SectionSwitcher";
import { useI18n, useT, LOCALES, localeDisplayName, type Locale, type TKey } from "./i18n/shared";
import { Notice, Select, ToastNotice, type NoticeTone } from "./ui";
import { bootstrapApiSession, configureApiTargets, DEVICE_PROOF_CHANGED_EVENT, hasApiSession, hasRememberedDashboardDevice, installApiAuthFetch, logoutApiSession, SESSION_CHANGED_EVENT, SESSION_UNAVAILABLE_EVENT } from "./api";
import { apiBaseForPlane, ClientStateChangedError, discoverApiTargets, isConnectedRuntime, runtimeRoleFromDocument, standaloneApiTargets, type ApiTargets } from "./api-targets";
import { ConnectPairingForm } from "./connect-pairing";
import { validateRemoteLinkSession } from "./connect-pairing-transport";
import { type Page } from "./app-routing";
import { readModelsTab, type ModelsTab } from "./pages/models-tab";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { useCodexRestart } from "./use-codex-restart";
import { confirmAction } from "./action-dialogs";
import { hostOs, isDesktopShell, isExternalLink, openDesktopCliPage, openDesktopUpdatePage } from "./lib/desktop-shell";
import { proxyHealthOnline } from "./lib/proxy-health";
import { zoomManagedOn } from "./lib/desktop-zoom";
import { useSidebarCollapse } from "./use-sidebar-collapse";
import { useDesktopZoom } from "./use-desktop-zoom";
import { DesktopZoomControl } from "./components/desktop-zoom-control";
import { ThemeSwitch, type ThemeMode } from "./components/theme-switch";
import { ProxyControls } from "./components/ui-v2/proxy-controls";
import { BrandMark } from "./components/ui-v2/brand-mark";
import { MainTopStrip, SidebarTopStrip } from "./components/app-titlebar";
import { watchMacTitlebarMetrics, windowChromeHandlers } from "./lib/window-chrome";

type Theme = ThemeMode;

const PAGE_TKEY: Record<Page, TKey> = {
  home: "shellV2.navHome",
  setup: "shellV2.pageChecklist",
  advanced: "shellV2.pageAllSettings",
  // The old dashboard is now the "Proxy details" member of the Advanced row.
  dashboard: "shellV2.pageProxyDetails",
  startup: "nav.startup",
  providers: "nav.providers",
  models: "nav.models",
  subagents: "nav.subagents",
  advisor: "nav.advisor",
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

/** Seconds the proxy has been up, from the same /healthz body; null when it does not say. */
function readUptime(data: unknown): number | null {
  const uptime = data && typeof data === "object" ? (data as { uptime?: unknown }).uptime : undefined;
  return typeof uptime === "number" && Number.isFinite(uptime) && uptime >= 0 ? uptime : null;
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
  const [targetError, setTargetError] = useState<"unavailable" | "client-state-changed" | null>(null);
  const [sharedSessionReady, setSharedSessionReady] = useState(() => hasApiSession("shared"));
  const [sharedSessionEpoch, setSharedSessionEpoch] = useState(0);
  const [hubPairingOpen, setHubPairingOpen] = useState(false);
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
    // A change only ever reveals a session (Remember/Forget controls). Target discovery clears the
    // session transiently, and dropping readiness there would cancel the requests that recover it.
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ plane?: string }>).detail?.plane === "shared" && hasApiSession("shared")) {
        setSharedSessionReady(true);
      }
    };
    window.addEventListener(SESSION_UNAVAILABLE_EVENT, unavailable);
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    const proofChanged = (event: Event) => {
      if ((event as CustomEvent<{ plane?: string }>).detail?.plane === "shared") setSharedSessionEpoch(epoch => epoch + 1);
    };
    window.addEventListener(DEVICE_PROOF_CHANGED_EVENT, proofChanged);
    return () => { window.removeEventListener(SESSION_UNAVAILABLE_EVENT, unavailable); window.removeEventListener(SESSION_CHANGED_EVENT, changed); window.removeEventListener(DEVICE_PROOF_CHANGED_EVENT, proofChanged); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void discoverApiTargets(API_BASE, controller.signal).then(async next => {
      configureApiTargets(next);
      setTargets(next);
      if (next.connected && !hasApiSession("shared")) {
        await bootstrapApiSession("shared", controller.signal);
      }
      if (controller.signal.aborted) return;
      setSharedSessionReady(hasApiSession("shared"));
      setTargetError(null);
      setTargetsSettled(true);
    }).catch(error => {
      if (controller.signal.aborted) return;
      setTargetError(error instanceof ClientStateChangedError ? "client-state-changed" : "unavailable");
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
  // A Hub can serve the dashboard on a public HTTPS origin without requiring an admin token.
  // Such a request cannot mint the ordinary loopback session; only an operator-paired session
  // can manage Remote Link. Pairing recovery therefore follows the actual runtime role and the
  // RemoteLink authorization result, not the unrelated admin-token prompt policy.
  const hubPairingAvailable = page === "remote" && runtimeRoleFromDocument() === "hub";
  const remotePairingFormOpen = hubPairingAvailable && hubPairingOpen;

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
  // Menu search and row shortcuts live in SidebarNav; App only says how to show the rail
  // (expand the collapsed rail, open the phone drawer) and how to navigate.
  const revealSidebar = useCallback(() => {
    if (navCollapsed) toggleNavCollapse();
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches) setNavOpen(true);
  }, [navCollapsed, toggleNavCollapse]);
  // Deliberate sidebar navigation — push a history entry and close the phone drawer.
  const sidebarNavigate = (target: Page) => {
    navigateToPage(target);
    setNavOpen(false);
  };
  const sidebarPageLabel = (target: Page) => t(PAGE_TKEY[target]);
  const sidebarPageAvailable = (target: Page) => target !== "remote-workspace" || remoteWorkspaceAvailable;
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
      const body: unknown = await res.json();
      return { version: readRuntimeVersion(body), uptime: readUptime(body) };
    },
    { pollMs: 30_000, enabled: targetsSettled },
  );

  const themeSwitch = <ThemeSwitch theme={theme} onChange={setTheme} />;
  const displayedVersion: string = healthPoll.data?.version ?? __APP_VERSION__;
  // The sidebar status follows the health check: a failed or refused /healthz is "Offline",
  // never a default "Online". Before the first answer it stays Online, as the page itself
  // loaded from this proxy.
  const proxyOnline = proxyHealthOnline(healthPoll.data, healthPoll.error);
  const uptime = proxyOnline ? healthPoll.data?.uptime ?? null : null;
  // The sidebar row is narrow, so it shows the time alone; the status word is its tooltip.
  const uptimeLabel = uptime === null ? undefined : t("shellV2.uptimeValue", { h: String(Math.floor(uptime / 3600)), m: String(Math.floor((uptime % 3600) / 60)) });

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
      // Menu search (Cmd/Ctrl+K) opens the drawer and focuses its own field; keep that focus.
      const timer = setTimeout(() => {
        if (!sidebarRef.current?.contains(document.activeElement)) sidebarRef.current?.focus();
      }, 200);
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
    else report(t(hasRememberedDashboardDevice("shared") ? "connection.forgetDeviceFailed" : "connection.sessionLogoutFailed"), "err");
  };
  const deviceForgetAvailable = hasRememberedDashboardDevice("shared");
  const endSessionLabel = t(deviceForgetAvailable ? "connection.forgetDevice" : "connection.sessionLogout");

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
      onClick={() => { navigateToPage("home"); setNavOpen(false); }}
      aria-label={t("nav.goHome")}
      title={t("nav.goHome")}
      {...(page === "home" ? { "aria-current": "page" as const } : {})}
    >
      <BrandMark className="ui-v2 brand-logo-v2 h-[24px] w-[27px]" label={t("app.logoAria")} />
      <span className="name">opencodex</span>
      <span className="ver" title={displayedVersion}>v{displayedVersion}</span>
    </button>
  );
  // The wide-screen strip carries the wordmark beside the collapse toggle; the version moves
  // to the foot there, so this copy has none. The topbar and drawer keep `brand` above.
  const stripBrand = (
    <button
      type="button"
      className="brand brand-home brand--strip"
      onClick={() => navigateToPage("home")}
      aria-label={t("nav.goHome")}
      title={t("nav.goHome")}
      {...(page === "home" ? { "aria-current": "page" as const } : {})}
    >
      <BrandMark className="ui-v2 brand-logo-v2 h-[22px] w-[25px]" label={t("app.logoAria")} />
      <span className="name">opencodex</span>
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
          {(targets.connected || deviceForgetAvailable) && sharedSessionReady && (
            <button type="button" className="sidebar-orb" onClick={() => { void handleSessionLogout(); }} disabled={sessionLoggingOut}
              aria-label={sessionLoggingOut ? t("connection.sessionLoggingOut") : endSessionLabel} title={endSessionLabel}>
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
      <SidebarTopStrip collapsed={navCollapsed} onToggle={toggleNavCollapse} brand={stripBrand} />
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
          <SidebarNav
            activeGroupId={activeGroup?.id ?? null}
            pageLabel={sidebarPageLabel}
            pageAvailable={sidebarPageAvailable}
            onNavigate={sidebarNavigate}
            onReveal={revealSidebar}
            desktopShell={desktopShell}
            t={t}
          />
        </nav>
        <div className="sidebar-foot">
          <ProxyControls
            label={t("dash.actions")}
            statusLabel={t(proxyOnline ? "dash.online" : "dash.offline")}
            online={proxyOnline}
            detail={uptimeLabel}
            stopLabel={t(targets.connected ? "connection.disconnect" : "dash.stop")}
            stoppingLabel={t("dash.stopping")}
            restartLabel={t("dash.codexRestart")}
            restartingLabel={t("dash.codexRestarting")}
            leverHint={t("shellV2.leverHint", { restart: t("dash.codexRestart"), stop: t(targets.connected ? "connection.disconnect" : "dash.stop") })}
            leverText={{
              hover: t("shellV2.leverHover"),
              cancel: t("shellV2.leverCancel"),
              restart: t("shellV2.leverRelease", { action: t("shellV2.leverReload") }),
              stop: t("shellV2.leverRelease", { action: targets.connected ? t("connection.disconnect") : t("shellV2.leverStop") }),
            }}
            stopping={stopping}
            restarting={codexRestarting}
            onStop={handleStop}
            onRestart={() => { void handleCodexRestart(); }}
            session={(targets.connected || deviceForgetAvailable) && sharedSessionReady ? {
              label: endSessionLabel,
              busyLabel: t("connection.sessionLoggingOut"),
              busy: sessionLoggingOut,
              onClick: () => { void handleSessionLogout(); },
            } : undefined}
          />
          {/* Display preferences share one row: the language picker, then the theme orb. */}
          <div className="sidebar-pref-row">
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
            <button type="button" className="sidebar-orb" onClick={() => switchDashboardEdition("classic")}
              aria-label={t("shellV2.uiClassic")} title={t("shellV2.uiClassicHint")}>
              <IconHistory />
            </button>
            {themeSwitch}
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
            version={<span className="sidebar-version" title={displayedVersion}>v{displayedVersion}</span>}
          />
          {zoomManaged && (
            <div className="sidebar-meta-row">
              <DesktopZoomControl percent={desktopZoom.percent} canZoomIn={desktopZoom.canZoomIn}
                canZoomOut={desktopZoom.canZoomOut} onStep={desktopZoom.step} />
            </div>
          )}
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
          {/* Outside the page boundary: a page that fails to render must not hide whose state this is. */}
          {targetsSettled && targets.link && (
            <Notice tone="warn">
              {targets.link.home
                ? t("connection.linkManaged", { home: targets.link.home, linkId: targets.link.linkId })
                : t("connection.linkManagedUnnamed", { linkId: targets.link.linkId })}
            </Notice>
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
                  <div className="alert alert-err" role="alert">{t(targetError === "client-state-changed" ? "connection.clientStateChanged" : "connection.machineUnavailable")}</div>
                )}
                {((targets.connected && !sharedSessionReady) || remotePairingFormOpen) && (
                  <ConnectPairingForm key={`${targets.shared.serverOrigin}:${targets.shared.bootstrapPath}`} target={targets.shared} focusOnMount={remotePairingFormOpen} onConnected={async signal => {
                    if (remotePairingFormOpen) await validateRemoteLinkSession(sharedBase, undefined, signal);
                    signal.throwIfAborted();
                    setHubPairingOpen(false);
                    setSharedSessionReady(hasApiSession("shared"));
                    setSharedSessionEpoch(epoch => epoch + 1);
                  }} />
                )}
                {page === "home" && <Home apiBase={sharedBase} navigate={navigateToPage}
                  onReloadCodex={() => { void handleCodexRestart(); }} reloadingCodex={codexRestarting} />}
                {page === "setup" && <SetupHub apiBase={sharedBase} navigate={navigateToPage} />}
                {page === "advanced" && <AdvancedHub navigate={navigateToPage} />}
                {page === "dashboard" && <Dashboard apiBase={sharedBase} readOnly={targets.link !== undefined} connected={targets.connected}
                  authenticationPending={targets.connected && !sharedSessionReady} refreshEpoch={sharedSessionEpoch} />}
                {page === "startup" && <Startup apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
                {page === "providers" && <Providers apiBase={sharedBase} />}
                {page === "models" && <Models key={sharedBase} apiBase={sharedBase} restartEpoch={codexRestartEpoch} connected={targets.connected} catalogSyncedAt={targets.catalogSyncedAt} reportRestart={report} />}
                {page === "subagents" && <Subagents key={sharedBase} apiBase={sharedBase} />}
                {page === "advisor" && <Advisor key={sharedBase} apiBase={sharedBase} />}
                {page === "logs" && <Logs apiBase={sharedBase} />}
                {page === "usage" && <Usage apiBase={sharedBase} connected={targets.connected || isConnectedRuntime()} apiKeyId={targets.apiKeyId} topology={targetError || (isConnectedRuntime() && !targets.connected) ? "unknown" : targets.usageTopology} />}
                {page === "storage" && <Storage apiBase={sharedBase} />}
                {page === "remote" && !remotePairingFormOpen && <RemoteLink key={`${sharedBase}:${sharedSessionEpoch}`} apiBase={sharedBase} sessionReady={sharedSessionReady} pairingRecoveryAvailable={hubPairingAvailable} onRequestPairing={() => setHubPairingOpen(true)} workspaceAvailable={remoteWorkspaceAvailable} onOpenWorkspace={() => navigateToPage("remote-workspace")} />}
                {page === "remote-workspace" && <RemoteWorkspaceRoute available={remoteWorkspaceAvailable} apiBase={sharedBase} hubOrigin={targets.shared.serverOrigin} onOpenRemoteLink={() => navigateToPage("remote")} />}
                {page === "codex-set" && <CodexSet apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
                {shellPage === "integrations" && <Integrations apiBase={sharedBase} machineApiBase={machineBase} connected={targets.connected} />}
              </>
            )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
