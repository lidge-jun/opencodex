import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Debug from "./pages/Debug";
import Usage from "./pages/Usage";
import CodexAuth from "./pages/CodexAuth";
import ApiKeys from "./pages/ApiKeys";
import ClaudeCode from "./pages/ClaudeCode";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconTerminal, IconActivity, IconKey, IconGithub, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconSparkle, IconX } from "./icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "./i18n/shared";
import { Select } from "./ui";
import { installApiAuthFetch } from "./api";

installApiAuthFetch();

type Page = "dashboard" | "providers" | "models" | "subagents" | "logs" | "debug" | "usage" | "codex-auth" | "api" | "claude";
type Theme = "light" | "dark" | "system";

const VALID_PAGES = new Set<Page>(["dashboard", "providers", "models", "subagents", "logs", "debug", "usage", "codex-auth", "api", "claude"]);

function readPageFromHash(): Page {
  const raw = location.hash.replace(/^#\/?/, "");
  return VALID_PAGES.has(raw as Page) ? (raw as Page) : "dashboard";
}

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "debug", tkey: "nav.debug", Icon: IconTerminal },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
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
  const queryClient = useQueryClient();
  const { locale, setLocale } = useI18n();
  const t = useT();

  // Narrow screens: the sidebar becomes an off-canvas drawer behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navWasOpen = useRef(false);

  useEffect(() => {
    // External navigation (hash edit, back/forward) also dismisses the mobile drawer.
    const onHash = () => { setPageState(readPageFromHash()); setNavOpen(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const nextHash = `#${page}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = page;
    }
  }, [page]);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  const { data: healthData } = useQuery({
    queryKey: ["healthz", API_BASE],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/healthz`);
      if (!res.ok) throw new Error("health check failed");
      return res.json();
    },
    refetchInterval: 30_000,
    retry: false,
  });

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];
  const displayedVersion = readRuntimeVersion(healthData) ?? __APP_VERSION__;

  const [stopping, setStopping] = useState(false);
  // Sidebar "Claude ON" toggle — literal label in every locale (product name).

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

  const { data: claudeData } = useQuery({
    queryKey: ["claude-code", API_BASE],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/claude-code`);
      if (!res.ok) throw new Error("claude-code fetch failed");
      return res.json() as Promise<{ enabled?: boolean }>;
    },
    retry: false,
  });
  const claudeEnabled =
    claudeData !== undefined && typeof claudeData.enabled === "boolean" ? claudeData.enabled : null;

  const toggleClaude = async () => {
    if (claudeEnabled === null) return;
    const next = !claudeEnabled;
    queryClient.setQueryData(["claude-code", API_BASE], { enabled: next });
    try {
      const res = await fetch(`${API_BASE}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) queryClient.setQueryData(["claude-code", API_BASE], { enabled: !next });
    } catch {
      queryClient.setQueryData(["claude-code", API_BASE], { enabled: !next });
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
            <button type="button" key={id} className={`nav-item${page === id ? " active" : ""}`} data-page={id}
              onClick={() => { setPageState(id); setNavOpen(false); }}
              aria-current={page === id ? "page" : undefined}>
              <Icon /> {t(tkey)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {claudeEnabled !== null && (
            <button type="button" className="theme-toggle" onClick={toggleClaude}
              aria-pressed={claudeEnabled} aria-label={t("claude.toggleAria")} title={t("claude.toggleAria")}
              style={claudeEnabled ? { color: "var(--accent)" } : undefined}>
              <IconSparkle /> <span className="mode">{claudeEnabled ? t("app.claudeOn") : t("app.claudeOff")}</span>
            </button>
          )}
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
        <div className="main-inner">
          {page === "dashboard" && <Dashboard apiBase={API_BASE} />}
          {page === "providers" && <Providers apiBase={API_BASE} />}
          {page === "models" && <Models apiBase={API_BASE} />}
          {page === "subagents" && <Subagents apiBase={API_BASE} />}
          {page === "logs" && <Logs apiBase={API_BASE} />}
          {page === "debug" && <Debug apiBase={API_BASE} />}
          {page === "usage" && <Usage apiBase={API_BASE} />}
          {page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}
          {page === "api" && <ApiKeys apiBase={API_BASE} />}
          {page === "claude" && <ClaudeCode apiBase={API_BASE} />}
        </div>
      </main>
    </div>
  );
}
