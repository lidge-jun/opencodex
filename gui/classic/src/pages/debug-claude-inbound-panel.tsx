import { useI18n } from "../i18n/shared";
import type { ClaudeInboundEntry } from "./debug-shared";
import { formatClaudeInboundTime } from "./debug-shared";

export function DebugClaudeInboundPanel({ entries }: { entries: ClaudeInboundEntry[] }) {
  const { t } = useI18n();

  return (
    <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
      <div className="font-semibold" style={{ marginBottom: 4 }}>{t("debug.claudeInbound.title")}</div>
      <div className="muted text-control" style={{ marginBottom: 10 }}>{t("debug.claudeInbound.sub")}</div>
      {entries.length === 0 ? (
        <div className="muted text-control">{t("debug.claudeInbound.empty")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table text-label">
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
                  <td className="mono" title={entry.anthropicBeta} style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.anthropicBeta ?? "-"}</td>
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
    </div>
  );
}
