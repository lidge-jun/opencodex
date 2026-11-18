import { useDataSurface } from "../../data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";

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

export function AdvisorActivityTable({ entries }: { entries: AdvisorActivityEntry[] }) {
  const t = useT();
  if (!entries.length) return <p className="muted">{t("advisor.activity.empty")}</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl advisor-activity-table">
        <thead><tr>
          <th>{t("advisor.activity.started")}</th>
          <th>{t("advisor.activity.trigger")}</th>
          <th>{t("advisor.model")}</th>
          <th>{t("advisor.effort")}</th>
          <th>{t("advisor.activity.tokens")}</th>
          <th>{t("advisor.activity.duration")}</th>
        </tr></thead>
        <tbody>{entries.map(entry => <tr key={entry.id}>
          <td><time dateTime={new Date(entry.startedAt).toISOString()}>{new Date(entry.startedAt).toLocaleTimeString()}</time></td>
          <td>
            <div>{t(`advisor.activity.trigger.${entry.trigger}` as TKey)}</div>
            <span className={entry.status === "ok" ? "badge badge-green" : "badge badge-muted"}>
              {t(`advisor.activity.status.${entry.status}` as TKey)}
            </span>
          </td>
          <td><code>{entry.advisorModel}</code><div className="muted"><code>{entry.workerModel}</code></div></td>
          <td><code>{entry.requestedEffort} → {entry.effectiveEffort ?? t("logs.tokens.unreported")}</code></td>
          <td className="num">
            {entry.usage
              ? <><span title={t("logs.tokens.input")}>{entry.usage.inputTokens ?? "—"}</span>{" / "}<span title={t("logs.tokens.output")}>{entry.usage.outputTokens ?? "—"}</span></>
              : t("logs.tokens.unreported")}
          </td>
          <td className="num">{entry.durationMs === null ? "—" : <>{entry.durationMs} ms</>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export default function AdvisorActivity({ apiBase }: { apiBase: string }) {
  const t = useT();
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
  return <section aria-label={t("advisor.activity.title")}>
    <h3>{t("advisor.activity.title")}</h3>
    <p className="muted">{t("advisor.activity.note")}</p>
    {state.showSkeleton && <p className="muted">{t("common.loading")}</p>}
    {state.showError && <Notice tone="err">
      {t("advisor.activity.failed")}{" "}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
    </Notice>}
    {state.data && <AdvisorActivityTable entries={state.data.entries} />}
  </section>;
}
