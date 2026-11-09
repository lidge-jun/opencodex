import { IconAlert, IconChevron } from "../icons";
import { type TKey, useT } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { formatUptime } from "../formatUptime";
import { navigateHash } from "../hash-routing";
import type { useDashboardData } from "./use-dashboard-data";
import { UsageIncompleteNotice } from "../components/usage-incomplete-notice";
import { SegmentedControl } from "@/components/ui-v2/segmented-control";
import { HelpButton } from "@/components/v2-proxy/settings-layout";
import { cn } from "@/lib/utils";

type Dash = ReturnType<typeof useDashboardData>;

/*
 * The state strip on top of Proxy details: is the proxy up, which build, how long, how much
 * traffic, and whether it is protected at startup. Settings live in the sections below.
 */
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
  const hasUsage = !!usage30d && usage30d.summary.requests > 0;

  return (
    <>
      <div className="dash-overview-head flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <HeadTile label={t("dash.status")} busy={healthLoading}>
            <span className={cn("flex items-center gap-2", online ? "text-success" : "text-danger")}>
              <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-danger")} aria-hidden="true" />
              {online ? t("dash.online") : t("dash.offline")}
            </span>
          </HeadTile>
          <HeadTile label={t("dash.version")} busy={healthLoading} title={health?.version}>
            <span className="dash-stat-version block truncate">{health?.version ?? "—"}</span>
          </HeadTile>
          <HeadTile label={t("dash.uptime")} busy={healthLoading}>
            {health ? formatUptime(health.uptime, locale) : "—"}
          </HeadTile>
          <HeadTile label={t("dash.providers")} busy={healthLoading}>
            {providers.length}
          </HeadTile>
          <HeadTile label={t("dash.tokens30d")} busy={usageLoading}
            sub={hasUsage ? t("dash.coverage").replace("{pct}", `${Math.round(usage30d.summary.coverageRatio * 100)}%`) : undefined}>
            {hasUsage ? formatTokens(usage30d.summary.totalTokens, locale) : "—"}
          </HeadTile>
        </div>

        <div className="startup-health-slot" aria-live="polite">
          {startupHealth ? (
            <button type="button" onClick={() => navigateHash("startup")}
              className={cn(
                "group flex h-[var(--ocx-control-h)] w-full cursor-pointer items-center gap-2.5 rounded-control border-0 bg-surface px-3.5 text-left text-[13px] text-fg-muted",
                "transition-colors duration-150 hover:bg-surface-2 hover:text-fg",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
              )}>
              <span className={cn("size-2 shrink-0 rounded-full",
                startupHealth === "error" ? "bg-danger" : startupHealth === "at-risk" ? "bg-warning" : startupHealth === "unverified" ? "bg-fg-subtle" : "bg-success")} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t(startupHealth === "error"
                  ? "startup.error"
                  : startupHealth === "unverified" ? "startup.unverified"
                  : startupHealth === "at-risk"
                    ? "startup.summary.atRisk"
                    : startupHealth === "protected"
                      ? "startup.summary.protected"
                      : "startup.summary.native")}
              </span>
              <IconChevron width={12} height={12} aria-hidden="true" className="shrink-0 text-fg-subtle transition-transform duration-150 group-hover:translate-x-0.5" />
            </button>
          ) : (
            <div className="h-[var(--ocx-control-h)] rounded-control bg-surface" aria-hidden="true" />
          )}
        </div>
      </div>

      <UsageIncompleteNotice data={usage30d} />
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

// Figures are the UI face with tabular numerals, never monospace (foundations.md, "Type").
function HeadTile({ label, children, sub, busy, title }: {
  label: string; children: React.ReactNode; sub?: string | undefined; busy?: boolean; title?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card bg-surface px-4 py-3" aria-busy={busy || undefined} title={title}>
      <span className="text-xs font-medium text-fg-subtle">{label}</span>
      <span className="min-w-0 truncate text-[17px] leading-6 font-semibold tracking-[-0.01em] tabular-nums text-fg">{children}</span>
      {sub && <span className="dash-stat-coverage truncate text-xs text-fg-subtle">{sub}</span>}
    </div>
  );
}

/**
 * The subagent engine switch (v1 / base / v2) as a settings-row control. Radio semantics come
 * from the shared segmented control; a disabled fieldset holds it still while a switch is saving.
 */
export function DashboardMultiAgentControl({ maMode, maBusy, switchMaMode }: Pick<Dash, "maMode" | "maBusy" | "switchMaMode">) {
  const t = useT();
  return (
    <fieldset disabled={maBusy} className="dash-ma-switch m-0 min-w-0 border-0 p-0 disabled:opacity-60">
      <SegmentedControl
        aria-label={t("dash.multiAgent")}
        value={maMode}
        onChange={mode => { if (mode !== maMode) void switchMaMode(mode); }}
        items={(["v1", "default", "v2"] as const).map(mode => ({ value: mode, label: t(`models.v2Mode_${mode}` as TKey) }))}
      />
    </fieldset>
  );
}

/** The "?" beside the subagent switch opens the page's multi-agent help dialog. */
export function DashboardMultiAgentHelp({ maHelpTriggerRef, maHelpOpen, setMaHelpOpen }: Pick<Dash, "maHelpTriggerRef" | "maHelpOpen" | "setMaHelpOpen">) {
  const t = useT();
  return (
    <HelpButton
      buttonRef={maHelpTriggerRef}
      label={t("dash.multiAgent")}
      expanded={maHelpOpen}
      controls="multi-agent-help-dialog"
      popup="dialog"
      onClick={() => setMaHelpOpen(true)}
    />
  );
}
