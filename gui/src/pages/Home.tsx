import { useKeyedClientResource } from "../client-resource";
import { useT, getActiveLocale } from "../i18n/shared";
import type { Page } from "../app-routing";
import { IconRefresh } from "../icons";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { recentFailures, type HomeLogRow } from "./home-failures";
import { startupChecklistStep } from "../startup-health-ui";
import { useStartupChecklist } from "../hooks/useStartupChecklist";
import { TelemetryProfileCard } from "../components/telemetry-profile-card";
import { readManagementHealth } from "../lib/proxy-health";

/*
 * Design system v2 landing page. It answers the two questions people open the dashboard
 * with — "is everything working?" and "what do I do next?" — and nothing else: settings
 * live in their own tier. Every figure comes from an endpoint another page already reads; the one
 * exception is the opt-in public profile card, which reads /api/telemetry/profile.
 */

interface HomeProps {
  apiBase: string;
  navigate: (page: Page, subPath?: string) => void;
  onReloadCodex: () => void;
  reloadingCodex: boolean;
}

interface UsageDay { requests?: number; totalTokens?: number }
interface UsageBody { summary?: { requests?: number; totalTokens?: number }; days?: UsageDay[] }
interface ConfigBody { providers?: Record<string, unknown> }
interface LogRow extends HomeLogRow { model?: string; provider?: string; errorCode?: string; upstreamError?: string }

const DAY_MS = 24 * 60 * 60 * 1000;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export default function Home({ apiBase, navigate, onReloadCodex, reloadingCodex }: HomeProps) {
  const t = useT();
  const locale = getActiveLocale();
  const number = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });

  // The authenticated management health route: a hub's management ingress denies /healthz (#8506).
  const health = useKeyedClientResource(`home-health:${apiBase}`, [apiBase],
    signal => readManagementHealth(apiBase, "/api/system/health", signal), { pollMs: 30_000 });
  const usage = useKeyedClientResource(`home-usage:${apiBase}`, [apiBase],
    signal => getJson<UsageBody>(`${apiBase}/api/usage?range=7d`, signal), { pollMs: 60_000 });
  const config = useKeyedClientResource(`home-config:${apiBase}`, [apiBase],
    signal => getJson<ConfigBody>(`${apiBase}/api/config`, signal));
  const startup = useStartupChecklist(apiBase);
  // The 24-hour window is cut when the rows arrive, so render never reads the clock.
  const failureRead = useKeyedClientResource(`home-failures:${apiBase}`, [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/logs?limit=500`, { signal });
      if (!response.ok) throw new Error("logs unavailable");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("logs" in body) || !Array.isArray(body.logs)) throw new Error("logs unavailable");
      return recentFailures(body.logs as LogRow[], Date.now() - DAY_MS);
    },
    { pollMs: 30_000 });
  const failuresKnown = failureRead.error == null && failureRead.data !== undefined;
  const failures = failuresKnown ? failureRead.data ?? [] : [];

  const online = health.data != null;
  const providerCount = Object.keys(config.data?.providers ?? {}).length;
  const requests7d = usage.data?.summary?.requests ?? 0;
  const tokens7d = usage.data?.summary?.totalTokens ?? 0;
  const uptime = health.data?.uptime ?? null;
  const autostart = startupChecklistStep(startup.data);

  const steps = [
    { key: "provider", done: providerCount > 0, title: t("shellV2.stepProvider"), hint: t("shellV2.stepProviderHint"), showHint: false, go: () => navigate("providers") },
    { key: "request", done: requests7d > 0, title: t("shellV2.stepFirstRequest"), hint: t("shellV2.stepFirstRequestHint"), showHint: false, go: () => navigate("integrations") },
    {
      key: "autostart",
      done: autostart.done,
      title: t(autostart.titleKey), hint: t(autostart.hintKey),
      // An unverified Desktop login still says where to check it.
      showHint: Boolean(startup.data) && autostart.desktop && autostart.done === undefined,
      go: () => autostart.subPath ? navigate("startup", autostart.subPath) : navigate("startup"),
    },
  ];
  const doneCount = steps.filter(step => step.done).length;
  const allDone = doneCount === steps.length;

  const headline = !online ? t("shellV2.homeDown")
    : !failuresKnown ? t("shellV2.homeErrorsUnavailable")
    : failures.length > 0 ? t("shellV2.homeErrorsToday", { count: number.format(failures.length) })
    : t("shellV2.homeOk");

  return (
    <div className="ui-v2 flex flex-col gap-6 font-sans text-fg">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative inline-flex size-3 shrink-0" aria-hidden>
            <span className={cn("relative size-3 rounded-full", !online ? "bg-danger" : !failuresKnown || failures.length ? "bg-warning" : "bg-success")} />
          </span>
          <h1 className="m-0 text-title font-semibold tracking-[-0.025em] text-balance">{headline}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onReloadCodex} disabled={reloadingCodex}>
            <span className={cn("inline-flex", reloadingCodex && "animate-spin")}><IconRefresh /></span>
            {t(reloadingCodex ? "dash.codexRestarting" : "dash.codexRestart")}
          </Button>
          <Button variant="primary" onClick={() => navigate("logs")}>{t("shellV2.openLogs")}</Button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t("shellV2.tileVersion")} value={health.data?.version ? `v${health.data.version}` : "—"} />
        <Stat label={t("shellV2.tileUptime")} value={online && uptime !== null ? t("shellV2.uptimeValue", { h: String(Math.floor(uptime / 3600)), m: String(Math.floor((uptime % 3600) / 60)) }) : "—"} />
        <Stat label={t("shellV2.tileRequests")} value={number.format(requests7d)} />
        <Stat label={t("shellV2.tileTokens")} value={compact.format(tokens7d)} />
      </section>

      <TelemetryProfileCard apiBase={apiBase} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="flex flex-col gap-4 rounded-card bg-surface p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[15px] font-semibold">{t("shellV2.checklistTitle")}</h2>
            <span className="text-[13px] text-fg-muted tabular-nums">{t("shellV2.checklistProgress", { done: String(doneCount), total: String(steps.length) })}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full origin-left rounded-full bg-accent transition-transform duration-[600ms] ease-soft"
              style={{ transform: `scaleX(${doneCount / steps.length})` }} />
          </div>
          {allDone ? (
            <p className="m-0 text-[14px] text-fg-muted">{t("shellV2.checklistAllDone")}</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {steps.map((step, index) => {
                const current = step.done === false && steps.findIndex(s => s.done === false) === index;
                return (
                  <li key={step.key} data-step={step.key}>
                    <button type="button" onClick={step.go}
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-3 rounded-control p-2.5 text-left transition-colors hover:bg-raised",
                        current && "bg-raised shadow-sm ring-1 ring-line",
                      )}>
                      <span className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                        step.done ? "bg-success text-on-accent" : current ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-muted",
                      )} aria-hidden>{step.done ? "✓" : index + 1}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn("text-[14px] font-medium", step.done && "text-fg-subtle line-through")}>{step.title}</span>
                        {(step.done === false || step.showHint) && <span className="text-[13px] text-fg-muted">{step.hint}</span>}
                      </span>
                      {step.done === false && <span className="text-[13px] font-medium text-highlight opacity-0 transition-opacity group-hover:opacity-100">{t("shellV2.stepOpen")} →</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-card bg-surface p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[15px] font-semibold">{t("shellV2.recentErrors")}</h2>
            <button type="button" onClick={() => navigate("logs")}
              className="cursor-pointer text-[13px] font-medium text-highlight hover:underline">{t("shellV2.viewAll")}</button>
          </div>
          {!failuresKnown ? (
            <p className="m-0 text-[14px] text-fg-muted">{t("shellV2.homeErrorsUnavailable")}</p>
          ) : failures.length === 0 ? (
            <p className="m-0 text-[14px] text-fg-muted">{t("shellV2.noErrors")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {failures.slice(0, 4).map(row => (
                <li key={`${row.timestamp}:${row.model}`} className="flex items-baseline gap-2.5 rounded-control px-1 py-1.5 text-[13px]">
                  <span className="font-mono text-xs text-fg-subtle tabular-nums">
                    {new Date(row.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-warning tabular-nums">{row.status}</span>
                  <span className="min-w-0 flex-1 truncate">{row.provider} · {row.model}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-3 text-[13px] text-fg-muted">
            <span>{t("shellV2.tileProviders")} <b className="font-semibold text-fg tabular-nums">{number.format(providerCount)}</b></span>
            <button type="button" onClick={() => navigate("dashboard", "update")}
              className="cursor-pointer font-medium text-highlight hover:underline">{t("shellV2.checkUpdate")}</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card bg-surface px-4 py-3.5">
      <span className="text-xs font-medium text-fg-subtle">{label}</span>
      <span className="truncate text-stat font-semibold tracking-[-0.02em] tabular-nums">{value}</span>
    </div>
  );
}
