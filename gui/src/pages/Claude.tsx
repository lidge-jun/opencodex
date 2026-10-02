import { useEffect, useState } from "react";
import ClaudeCode from "./ClaudeCode";
import ClaudeDesktop from "./ClaudeDesktop";
import Providers from "./Providers";
import ClaudeSettings from "./claude-settings";
import ClaudeAccountEmpty from "./claude-account-empty";
import { CLAUDE_TABS, readClaudeTab, selectClaudeTab, claudeTabKeyDown, type ClaudeTab } from "./claude-tab";
import { useT } from "../i18n/shared";
import { normalizeHashPath } from "../hash-routing";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCache } from "../session-list-cache";
import "../styles/claude-page.css";

const TAB_LABELS = { account: "claude.tabAccount", code: "claude.tabCode", desktop: "claude.tabDesktop", settings: "claude.tabSettings" } as const;

/**
 * One stable page head and tab strip; panels carry no titles of their own.
 * Account is the Providers page scoped to Anthropic's Accounts content and mounts only while
 * selected, so its roster poll stops with the tab. Code/Desktop/Settings latch on first visit
 * to keep drafts, and gate their own reads on `active`.
 */
export default function Claude({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const [hash, setHash] = useState(window.location.hash);
  const [hasAnthropic, setHasAnthropic] = useState(() => Boolean(readSessionListCache<{ providers?: { anthropic?: unknown } }>(`ocx.providers.config.v1:${apiBase}`)?.providers?.anthropic));
  const [tab, setTab] = useState(() => readClaudeTab(window.location.hash, hasAnthropic));
  const [mounted, setMounted] = useState<ReadonlySet<ClaudeTab>>(() => new Set([readClaudeTab(window.location.hash, hasAnthropic)]));
  if (!mounted.has(tab)) setMounted(new Set([...mounted, tab]));

  useEffect(() => {
    const sync = () => { setHash(window.location.hash); setTab(readClaudeTab(window.location.hash, hasAnthropic)); };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [hasAnthropic]);
  useEffect(() => {
    if (!active || normalizeHashPath(window.location.hash) !== "claude") return;
    const controller = new AbortController();
    void fetch(`${apiBase}/api/config`, { signal: controller.signal }).then(response => readJsonOrThrow<{ providers?: { anthropic?: unknown } }>(response)).then(config => {
      if (controller.signal.aborted) return;
      const configured = Boolean(config?.providers?.anthropic);
      setHasAnthropic(configured);
      if (normalizeHashPath(window.location.hash) === "claude") setTab(readClaudeTab(window.location.hash, configured));
    }).catch(() => {});
    return () => controller.abort();
  }, [apiBase, active, hash]);
  const shown = (value: ClaudeTab) => tab === value || (value !== "account" && mounted.has(value));
  return (
    <section className="claude-page">
      <div className="page-head"><h2>{t("nav.claude")}</h2></div>
      <p className="page-sub">{t("claude.pageSub")}</p>
      <div className="page-tabs" role="tablist" aria-label={t("nav.claude")}>
        {CLAUDE_TABS.map(value => (
          <button key={value} type="button" role="tab" id={`claude-tab-${value}`}
            aria-selected={tab === value} aria-controls={`claude-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={`page-tab${tab === value ? " page-tab--active" : ""}`}
            onClick={() => selectClaudeTab(value)} onKeyDown={claudeTabKeyDown}>{t(TAB_LABELS[value])}</button>
        ))}
      </div>
      {CLAUDE_TABS.map(value => shown(value) && (
        <div key={value} role="tabpanel" id={`claude-panel-${value}`} aria-labelledby={`claude-tab-${value}`} hidden={tab !== value} className="claude-panel">
          {value === "account" && <Providers key={apiBase} apiBase={apiBase} scopeProvider="anthropic" scopeEmpty={login => <ClaudeAccountEmpty apiBase={apiBase} provider="anthropic" login={login} />} />}
          {value === "code" && <ClaudeCode key={apiBase} apiBase={apiBase} active={active && tab === value} />}
          {value === "desktop" && <ClaudeDesktop key={apiBase} apiBase={apiBase} active={active && tab === value} />}
          {value === "settings" && <ClaudeSettings key={apiBase} apiBase={apiBase} active={active && tab === value} />}
        </div>
      ))}
    </section>
  );
}
