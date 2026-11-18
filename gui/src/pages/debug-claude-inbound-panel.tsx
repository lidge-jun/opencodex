import { useI18n } from "../i18n/shared";
import { card, cardHint, cardTitle } from "../components/v2-logs/classes";
import type { ClaudeInboundEntry } from "./debug-shared";
import { formatClaudeInboundTime } from "./debug-shared";

export function DebugClaudeInboundPanel({ entries }: { entries: ClaudeInboundEntry[] }) {
  const { t } = useI18n();

  return (
    <section className={card} aria-labelledby="debug-claude-inbound-title">
      <div className="flex flex-col gap-1">
        <h3 id="debug-claude-inbound-title" className={cardTitle}>{t("debug.claudeInbound.title")}</h3>
        <p className={cardHint}>{t("debug.claudeInbound.sub")}</p>
      </div>
      {entries.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-subtle">{t("debug.claudeInbound.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-[8px] bg-bg ring-1 ring-inset ring-line">
          <table className="debug-inbound-table w-full border-collapse">
            <thead>
              <tr>
                <th>{t("debug.claudeInbound.time")}</th>
                <th>{t("debug.claudeInbound.endpoint")}</th>
                <th>{t("debug.claudeInbound.model")}</th>
                <th>thinking</th>
                <th>effort</th>
                <th>beta</th>
                <th>metadata</th>
                <th>system</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td className="muted mono">{formatClaudeInboundTime(entry.at)}</td>
                  <td className="mono">{entry.endpoint}</td>
                  <td className="mono" title={entry.resolvedModel}>
                    {entry.model}
                    {entry.resolvedModel && entry.resolvedModel !== entry.model && (
                      <span className="muted"> → {entry.resolvedModel}</span>
                    )}
                  </td>
                  <td className="mono">
                    {entry.thinkingType ?? "-"}
                    {entry.thinkingBudgetTokens !== undefined && <span className="muted"> ({entry.thinkingBudgetTokens})</span>}
                  </td>
                  <td className="mono">{entry.outputConfigEffort ?? "-"}</td>
                  <td className="mono max-w-40 truncate" title={entry.anthropicBeta}>{entry.anthropicBeta ?? "-"}</td>
                  <td className="mono" title={entry.metadataKeys?.join(", ")}>
                    {entry.hasMetadataUserId ? `user_id ${entry.userIdTag ?? ""}` : t("debug.claudeInbound.none")}
                  </td>
                  <td className="mono">{entry.hasSystem ? entry.systemTag ?? "yes" : t("debug.claudeInbound.none")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
