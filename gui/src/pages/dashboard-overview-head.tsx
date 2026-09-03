import { IconAlert } from "../icons";
import { useT } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { formatUptime } from "../formatUptime";
import { navigateHash } from "../hash-routing";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewHead({
  locale,
  health,
  providers,
  usage30d,
  usageLoading,
  healthLoading,
  startupHealth,
  projectConfigWarnings,
}: Pick<Dash, "locale" | "health" | "providers" | "usage30d" | "usageLoading" | "healthLoading" | "startupHealth" | "projectConfigWarnings">) {
  const t = useT();
  const online = health?.status === "ok";

  return (
    <>
      <div className="dash-overview-head">
        {/*
          Three cards: reachability, capacity, volume. Version and uptime used to be cards
          of their own; they are diagnosis facts, not decisions, so they ride as the status
          card's sub-line (visible, not a title attribute). The subagent v1/base/v2 switch
          that opened this row is a Subagents setting and lives there now.
        */}
        <div className="stat-row">
          <div className="stat" aria-busy={healthLoading || undefined}>
            <div className="label">{t("dash.status")}</div>
            <div className="value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--green)" : "var(--red)" }}>
              <span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? t("dash.online") : t("dash.offline")}
            </div>
            <div className="muted text-label dash-stat-coverage mono">
              {health ? `v${health.version} · ${formatUptime(health.uptime, locale)}` : "\u00a0"}
            </div>
          </div>
          <div className="stat" aria-busy={healthLoading || undefined}><div className="label">{t("dash.providers")}</div><div className="value">{providers.length}</div></div>
          <div className="stat" aria-busy={usageLoading || undefined}>
            <div className="label">{t("dash.tokens30d")}</div>
            <div className="value mono">{usage30d && usage30d.summary.requests > 0 ? formatTokens(usage30d.summary.totalTokens, locale) : "—"}</div>
            <div className="muted text-label dash-stat-coverage">
              {usage30d && usage30d.summary.requests > 0
                ? t("dash.coverage").replace("{pct}", `${Math.round(usage30d.summary.coverageRatio * 100)}%`)
                : "\u00a0"}
            </div>
          </div>
        </div>

        <div className="startup-health-slot" aria-live="polite">
          {startupHealth ? (
            <button type="button" className="startup-health-bar" onClick={() => navigateHash("startup")}>
              <span className={`dot ${startupHealth === "error" ? "dot-red" : startupHealth === "at-risk" ? "dot-amber" : "dot-green"}`} aria-hidden="true" />
              <span className="startup-health-bar__summary">
                {t(startupHealth === "error"
                  ? "startup.error"
                  : startupHealth === "at-risk"
                    ? "startup.summary.atRisk"
                    : startupHealth === "protected"
                      ? "startup.summary.protected"
                      : "startup.summary.native")}
              </span>
            </button>
          ) : (
            <div className="startup-health-bar startup-health-bar--pending" aria-hidden="true">
              <span className="dot dot-amber" />
              <span className="startup-health-bar__summary">&nbsp;</span>
            </div>
          )}
        </div>
      </div>

      {projectConfigWarnings.length > 0 && (
        <div className="notice notice-err maintenance-notice" role="alert">
          <IconAlert />
          <div>
            <div className="font-semibold">{t("dash.projectConfigTitle")}</div>
            <div className="muted text-control" style={{ marginTop: 4 }}>{t("dash.projectConfigHint")}</div>
            <ul className="text-control" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
              {projectConfigWarnings.map(g => (
                <li key={g.path} style={{ marginBottom: 8 }}>
                  <code>{g.path}</code> — {g.issues.join(", ")}
                  <div className="muted" style={{ marginTop: 2 }}>{g.bypass}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
