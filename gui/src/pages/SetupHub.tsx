import { useKeyedClientResource } from "../client-resource";
import { useT } from "../i18n/shared";
import type { Page } from "../app-routing";
import { IconCheck, IconKey, IconMonitor } from "../icons";
import { HubCard, type HubBadge } from "@/components/ui-v2/hub-card";
import { Button } from "@/components/ui-v2/button";
import { frame, sectionTitle } from "@/components/v2-connect/classes";
import { cn } from "@/lib/utils";
import { startupChecklistDone } from "../startup-health-ui";
import { useStartupChecklist } from "../hooks/useStartupChecklist";

/*
 * The "Set up" tier: everything people do once, in the order they do it. Each row opens
 * the existing page that owns the job, so no setup flow is duplicated here — this page is
 * the map and the progress, the pages stay the source of truth.
 *
 * Laid out after the React Bits `onboarding-3` checklist: the essentials are one ruled
 * list under a progress line, each row naming its state and the one button that moves it
 * forward. The two optional jobs stay cards below, so they never count against "done".
 */

interface SetupHubProps {
  apiBase: string;
  navigate: (page: Page, subPath?: string) => void;
}

interface ConfigBody { providers?: Record<string, unknown> }
interface UsageBody { summary?: { requests?: number } }

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  return res.ok ? ((await res.json()) as T) : null;
}

interface Step {
  key: string;
  title: string;
  hint: string;
  /** undefined while the source has not answered: neither done nor to do yet. */
  done: boolean | undefined;
  open: () => void;
}

export default function SetupHub({ apiBase, navigate }: SetupHubProps) {
  const t = useT();
  const config = useKeyedClientResource(`home-config:${apiBase}`, [apiBase],
    signal => getJson<ConfigBody>(`${apiBase}/api/config`, signal));
  const usage = useKeyedClientResource(`setup-usage:${apiBase}`, [apiBase],
    signal => getJson<UsageBody>(`${apiBase}/api/usage?range=all`, signal));
  const startup = useStartupChecklist(apiBase);

  const optional = { label: t("shellV2.badgeOptional"), tone: "optional" } satisfies HubBadge;

  const providers = config.data ? Object.keys(config.data.providers ?? {}).length > 0 : undefined;
  const requested = usage.data ? (usage.data.summary?.requests ?? 0) > 0 : undefined;
  const protectedStart = startup.data ? startupChecklistDone(startup.data) : undefined;

  const steps: Step[] = [
    { key: "provider", title: t("shellV2.stepProvider"), hint: t("shellV2.stepProviderHint"),
      done: providers, open: () => navigate("providers") },
    { key: "apps", title: t("shellV2.setupApps"), hint: t("shellV2.setupAppsHint"),
      done: requested, open: () => navigate("integrations") },
    { key: "request", title: t("shellV2.stepFirstRequest"), hint: t("shellV2.stepFirstRequestHint"),
      done: requested, open: () => navigate("providers") },
    { key: "autostart", title: t("shellV2.stepAutostart"), hint: t("shellV2.stepAutostartHint"),
      done: protectedStart, open: () => navigate("startup") },
  ];
  const doneCount = steps.filter(step => step.done === true).length;
  const allDone = doneCount === steps.length;
  // The first step not yet done is the one this page points at.
  const currentIndex = steps.findIndex(step => step.done === false);
  const open = t("shellV2.stepOpen");

  return (
    <div className="ui-v2 flex flex-col gap-8 font-sans text-fg">
      <header className="flex max-w-[640px] flex-col gap-2">
        <h1 className="m-0 text-title font-semibold tracking-[-0.025em]">{t("shellV2.setupTitle")}</h1>
        <p className="m-0 text-[15px] text-fg-muted">{t("shellV2.setupIntro")}</p>
      </header>

      <section aria-labelledby="setup-essentials" className="flex max-w-[760px] flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="setup-essentials" className={sectionTitle}>{t("connectV2.setupEssentials")}</h2>
          <span className="text-[13px] text-fg-muted tabular-nums">
            {t("shellV2.checklistProgress", { done: String(doneCount), total: String(steps.length) })}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar"
          aria-labelledby="setup-essentials" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
          <div className="h-full origin-left rounded-full bg-accent transition-transform duration-[600ms] ease-soft"
            style={{ transform: `scaleX(${doneCount / steps.length})` }} />
        </div>
        {allDone && <p className="m-0 text-[14px] text-fg-muted">{t("shellV2.checklistAllDone")}</p>}
        <ol className={cn(frame, "m-0 mt-1 list-none divide-y divide-line p-0")}>
          {steps.map((step, index) => (
            <SetupRow key={step.key} step={step} index={index} current={index === currentIndex} openLabel={open}
              doneLabel={t("shellV2.badgeDone")} todoLabel={t("shellV2.badgeTodo")} />
          ))}
        </ol>
      </section>

      <section aria-labelledby="setup-optional" className="flex flex-col gap-3">
        <h2 id="setup-optional" className={sectionTitle}>{t("connectV2.setupOptional")}</h2>
        <div className="grid max-w-[760px] gap-3 sm:grid-cols-2">
          <HubCard icon={<IconKey />} title={t("shellV2.setupApiKeys")} body={t("shellV2.setupApiKeysHint")}
            badge={optional} onOpen={() => navigate("integrations", "keys")} openLabel={open} />
          <HubCard icon={<IconMonitor />} title={t("shellV2.setupRemote")} body={t("shellV2.setupRemoteHint")}
            badge={optional} onOpen={() => navigate("remote")} openLabel={open} />
        </div>
      </section>
    </div>
  );
}

function SetupRow({ step, index, current, openLabel, doneLabel, todoLabel }: {
  step: Step; index: number; current: boolean; openLabel: string; doneLabel: string; todoLabel: string;
}) {
  const done = step.done === true;
  return (
    <li className={cn("flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5", current && "bg-surface")}>
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold tabular-nums [&_svg]:size-3.5",
          done ? "bg-success-soft text-success" : current ? "bg-accent text-on-accent" : "bg-surface-2 text-fg-muted",
        )}
        aria-hidden
      >
        {done ? <IconCheck strokeWidth={2.5} /> : index + 1}
      </span>
      <span className="flex min-w-0 flex-1 basis-[16rem] flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("text-[14px] leading-5 font-medium", done && "text-fg-muted")}>{step.title}</span>
          {step.done !== undefined && (
            <span className={cn(
              "rounded-full px-1.5 text-[11px] leading-[18px] font-medium",
              done ? "bg-success-soft text-success" : "bg-surface-2 text-fg-muted",
            )}>{done ? doneLabel : todoLabel}</span>
          )}
        </span>
        <span className="text-[13px] leading-5 text-fg-muted">{step.hint}</span>
      </span>
      <Button size="sm" variant={current ? "primary" : "outline"} onClick={step.open}
        aria-label={`${step.title} — ${openLabel}`} className="max-sm:ml-11">
        {openLabel}
      </Button>
    </li>
  );
}
