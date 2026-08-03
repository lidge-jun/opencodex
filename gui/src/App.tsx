import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "./client-resource";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Combos from "./pages/Combos";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Usage from "./pages/Usage";
import Storage from "./pages/Storage";
import CodexAuth from "./pages/CodexAuth";
import Integrations from "./pages/Integrations";
import Startup from "./pages/Startup";
import ErrorBoundary from "./components/ErrorBoundary";
import { SidebarGithubRow } from "./components/sidebar-github-row";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconActivity, IconHardDrive, IconKey, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconTerminal, IconX } from "./icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "./i18n/shared";
import { Select } from "./ui";
import { installApiAuthFetch } from "./api";
import { type Page } from "./app-routing";
import { normalizeHashPath } from "./hash-routing";
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
  integrations: "nav.integrations",
};

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

/**
 * A sidebar row usually maps one-to-one onto a page. Claude does not: it is a
 * shortcut into a tab of the Integrations page, so it needs a destination that
 * is not the bare page hash and a current-state rule that is not `page === id`.
 */
type NavEntry = {
  id: Page;
  tkey: TKey;
  Icon: typeof IconGrid;
  /** Sub-path handed to navigateToPage; the row targets a tab of `id`. */
  subPath?: string;
  /** Hash prefixes that keep this row current, instead of the page match. */
  activeHashes?: readonly string[];
};

const NAV: NavEntry[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  /*
   * Claude sits directly above Integrations because it is a shortcut into that
   * page. It carries navigation ONLY — the connection switch that used to live
   * on this row now belongs to ClaudeCode, which owns GET/PUT /api/claude-code.
   * A nav row owning a mutation is exactly the trap that was removed.
   *
   * The prefix also covers `integrations/claude/desktop`, so Desktop keeps the
   * row current without a second entry.
   */
  {
    id: "integrations",
    tkey: "nav.claude",
    Icon: IconTerminal,
    subPath: "claude",
    activeHashes: ["integrations/claude"],
  },
  { id: "integrations", tkey: "nav.integrations", Icon: IconGlobe },
];

/**
 * Two rows resolve to the same page, so `page === id` would light both at once
 * and the sidebar would claim the user is in two places. A row with
 * `activeHashes` wins its own hash; a plain row keeps the page match only while
 * no sibling has claimed the current hash.
 */
function isNavEntryActive(entry: NavEntry, page: Page, rawHash: string): boolean {
  if (entry.activeHashes) {
    return entry.activeHashes.some(prefix => rawHash === prefix || rawHash.startsWith(`${prefix}/`));
  }
  if (entry.id !== page) return false;
  return !NAV.some(sibling => sibling.activeHashes?.some(
    prefix => rawHash === prefix || rawHash.startsWith(`${prefix}/`),
  ));
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
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const { locale, setLocale } = useI18n();
  const t = useT();

  // Narrow screens: the sidebar becomes an off-canvas drawer behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);
  /*
   * The sidebar's current row is a HASH question, not just a page question:
   * Claude and Integrations are the same page and are told apart by the tab.
   * `useAppRouteState` only surfaces the page, so track the raw hash here.
   */
  const [navHash, setNavHash] = useState(() => normalizeHashPath(
    typeof window === "undefined" ? "" : window.location.hash,
  ));
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navWasOpen = useRef(false);

  useEffect(() => {
    // External navigation (hash edit, back/forward) also dismisses the mobile drawer.
    const dismissNav = () => {
      setNavOpen(false);
      setNavHash(normalizeHashPath(window.location.hash));
    };
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
          {/*
            The sidebar is navigation only. The Claude row used to carry the
            connection switch, which made a nav entry the owner of a mutation
            and left the control stranded once the three integration pages
            collapsed into one. ClaudeCode owns GET/PUT /api/claude-code, and
            the switch lives on its own surface.
          */}
          {NAV.map(entry => {
            const { id, tkey, Icon, subPath } = entry;
            const active = isNavEntryActive(entry, page, navHash);
            return (
              <div key={subPath ? `${id}/${subPath}` : id} className="nav-entry">
                <button type="button" className={`nav-item${active ? " active" : ""}`}
                  data-page={subPath ? `${id}/${subPath}` : id}
                  onClick={() => {
                    // Deliberate sidebar navigation — push a history entry.
                    navigateToPage(id, subPath);
                    // `hashchange` fires asynchronously and not at all when the
                    // hash is unchanged, so the row that was just clicked would
                    // otherwise stay un-highlighted for a frame or, for a repeat
                    // click, forever.
                    setNavHash(subPath ? `${id}/${subPath}` : id);
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
            {page === "combos" && <Combos key={API_BASE} apiBase={API_BASE} />}
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
