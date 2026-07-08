import { useEffect, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Debug from "./pages/Debug";
import Usage from "./pages/Usage";
import CodexAuth from "./pages/CodexAuth";
import ApiKeys from "./pages/ApiKeys";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconTerminal, IconActivity, IconKey, IconGithub, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower } from "./icons";
import { useI18n, useT, LOCALES, type TKey } from "./i18n";
import { installApiAuthFetch } from "./api";

installApiAuthFetch();

type Page = "dashboard" | "providers" | "models" | "subagents" | "logs" | "debug" | "usage" | "codex-auth" | "api";
type Theme = "light" | "dark" | "system";

const VALID_PAGES = new Set<Page>(["dashboard", "providers", "models", "subagents", "logs", "debug", "usage", "codex-auth", "api"]);

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
  const setPage = (p: Page) => { location.hash = p; setPageState(p); };
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const { locale, setLocale } = useI18n();
  const t = useT();

  useEffect(() => {
    const onHash = () => setPageState(readPageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  const langName = LOCALES.find(l => l.code === locale)?.name ?? "English";
  const cycleLang = () => {
    const order = LOCALES.map(l => l.code);
    setLocale(order[(order.indexOf(locale) + 1) % order.length]);
  };

  const [stopping, setStopping] = useState(false);
  const handleStop = async () => {
    if (!confirm(t("dash.stopConfirm"))) return;
    setStopping(true);
    try { await fetch(`${API_BASE}/api/stop`, { method: "POST" }); } catch { /* connection drops */ }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" role="img" aria-label="opencodex logo" />
          <span className="name">opencodex</span>
          <span className="ver">v{displayedVersion}</span>
        </div>
        <nav>
          {NAV.map(({ id, tkey, Icon }) => (
            <button key={id} className={`nav-item${page === id ? " active" : ""}`} data-page={id} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}>
              <Icon /> {t(tkey)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="theme-toggle" onClick={cycleLang}
            aria-label={`${t("lang.label")}: ${langName}`} title={`${t("lang.label")}: ${langName}`}>
            <IconGlobe /> <span className="mode">{langName}</span>
          </button>
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

      <main className="main">
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
        </div>
      </main>
    </div>
  );
}
