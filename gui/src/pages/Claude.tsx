import ClaudeCode from "./ClaudeCode";
import { useT } from "../i18n/shared";
import "../styles/claude-page.css";

/**
 * Claude Code's routing and settings, shown as the Claude tab inside Connect. There are no
 * sub-tabs: Claude Desktop is its own Connect tab, Claude accounts live only on Providers
 * (#claude/account redirects there), and the old read-only Settings view folded into this
 * page (#claude/settings opens it). #claude and #claude/code both land here.
 */
export default function Claude({ apiBase, active = true, embedded = false }: { apiBase: string; active?: boolean; embedded?: boolean }) {
  const t = useT();
  return (
    <section className={`claude-page${embedded ? " claude-page--embedded" : ""}`}>
      {/* Embedded, the Connect tab strip already names Claude; a second title would repeat it. */}
      {!embedded && <div className="page-head"><h2>{t("nav.claude")}</h2></div>}
      <p className="page-sub">{t("claude.pageSub")}</p>
      <ClaudeCode key={apiBase} apiBase={apiBase} active={active} />
    </section>
  );
}
