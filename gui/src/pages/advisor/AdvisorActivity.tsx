import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { InboxIcon } from "@hugeicons/core-free-icons";
import { useDataSurface } from "../../data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import { cn } from "../../lib/utils";
import { HelpButton } from "../../components/v2-proxy/settings-layout";

export interface AdvisorActivityEntry {
  id: string;
  startedAt: number;
  trigger: "manual" | "preflight" | "repair_failure";
  workerModel: string;
  advisorModel: string;
  requestedEffort: string;
  effectiveEffort: string | null;
  status: "running" | "ok" | "failed" | "cancelled" | "blocked";
  durationMs: number | null;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

const STATUS_TONE: Record<AdvisorActivityEntry["status"], string> = {
  ok: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  blocked: "bg-warning-soft text-warning",
  running: "bg-surface-2 text-fg-muted",
  cancelled: "bg-surface-2 text-fg-muted",
};

export function AdvisorActivityTable({ entries }: { entries: AdvisorActivityEntry[] }) {
  const t = useT();
  if (!entries.length) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
        <span className="mb-1 grid size-9 place-items-center rounded-[10px] bg-surface text-fg-muted" aria-hidden="true">
          <HugeiconsIcon icon={InboxIcon} size={18} strokeWidth={1.8} />
        </span>
        <p className="m-0 text-[14px] font-medium text-fg">{t("advisor.activity.empty")}</p>
        <p className="m-0 text-[13px] text-fg-muted">{t("proxyV2.activityEmptyHint")}</p>
      </div>
    );
  }
  const th = "px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-fg-subtle";
  const td = "px-4 py-3 align-top whitespace-nowrap";
  return (
    <div className="max-h-[480px] overflow-auto rounded-[12px]">
      <table className="pv2-table advisor-activity-table w-full border-collapse text-[13px] text-fg">
        <thead><tr className="border-b border-line">
          <th scope="col" className={th}>{t("advisor.activity.started")}</th>
          <th scope="col" className={th}>{t("advisor.activity.trigger")}</th>
          <th scope="col" className={th}>{t("advisor.model")}</th>
          <th scope="col" className={th}>{t("advisor.effort")}</th>
          <th scope="col" className={cn(th, "text-right")}>{t("advisor.activity.tokens")}</th>
          <th scope="col" className={cn(th, "text-right")}>{t("advisor.activity.duration")}</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{entries.map(entry => <tr key={entry.id}>
          <td className={cn(td, "font-mono text-xs text-fg-muted tabular-nums")}>
            <time dateTime={new Date(entry.startedAt).toISOString()}>{new Date(entry.startedAt).toLocaleTimeString()}</time>
          </td>
          <td className={td}>
            <div className="flex flex-col items-start gap-1">
              <span>{t(`advisor.activity.trigger.${entry.trigger}` as TKey)}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_TONE[entry.status])}>
                {t(`advisor.activity.status.${entry.status}` as TKey)}
              </span>
            </div>
          </td>
          <td className={td}>
            <code className="font-mono text-xs text-fg">{entry.advisorModel}</code>
            <div className="mt-0.5"><code className="font-mono text-xs text-fg-subtle">{entry.workerModel}</code></div>
          </td>
          <td className={td}><code className="font-mono text-xs">{entry.requestedEffort} → {entry.effectiveEffort ?? t("logs.tokens.unreported")}</code></td>
          <td className={cn(td, "num text-right font-mono text-xs tabular-nums")}>
            {entry.usage
              ? <><span title={t("logs.tokens.input")}>{entry.usage.inputTokens ?? "—"}</span>{" / "}<span title={t("logs.tokens.output")}>{entry.usage.outputTokens ?? "—"}</span></>
              : <span className="font-sans text-fg-subtle">{t("logs.tokens.unreported")}</span>}
          </td>
          <td className={cn(td, "num text-right font-mono text-xs tabular-nums")}>{entry.durationMs === null ? "—" : <>{entry.durationMs} ms</>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export default function AdvisorActivity({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [noteOpen, setNoteOpen] = useState(false);
  const resource = useDataSurface<{ entries: AdvisorActivityEntry[] }>(
    `advisor-activity:${apiBase}`, [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/advisor/activity`, { signal });
      if (!response.ok) throw new Error(String(response.status));
      return await response.json() as { entries: AdvisorActivityEntry[] };
    },
    { isEmpty: data => data.entries.length === 0, pollMs: 5000, pauseWhenHidden: true },
  );
  const { state } = resource;
  return <section aria-labelledby="advisor-activity-title" className="min-w-0 rounded-card bg-surface p-1">
    <header className="flex flex-col gap-0.5 px-4 pt-3 pb-3">
      <div className="flex items-center gap-1.5">
        <h3 id="advisor-activity-title" className="m-0 text-[15px] leading-5 font-semibold text-fg">{t("advisor.activity.title")}</h3>
        <HelpButton label={t("proxyV2.detailsFor", { name: t("advisor.activity.title") })} expanded={noteOpen}
          controls="advisor-activity-note" onClick={() => setNoteOpen(open => !open)} />
      </div>
      <p className="m-0 text-[13px] leading-[18px] text-fg-muted">{t("proxyV2.activityLede")}</p>
      <p id="advisor-activity-note" hidden={!noteOpen} className="m-0 mt-1 max-w-[72ch] text-[13px] leading-[19px] text-fg-muted">{t("advisor.activity.note")}</p>
    </header>
    <div className="flex min-w-0 flex-col rounded-[12px] bg-raised ring-1 ring-line">
      {state.showSkeleton && <p className="m-0 px-4 py-6 text-[13px] text-fg-muted">{t("common.loading")}</p>}
      {state.showError && <div className="p-3"><Notice tone="err">
        {t("advisor.activity.failed")}{" "}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
      </Notice></div>}
      {state.data && <AdvisorActivityTable entries={state.data.entries} />}
    </div>
  </section>;
}
