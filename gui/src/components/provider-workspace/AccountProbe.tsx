import { useT } from "../../i18n/shared";
import type { AccountProbeController, AccountProbeEntry, AccountProbeStatus } from "../../hooks/useAccountProbe";

function statusBadgeClass(status: AccountProbeStatus): string {
  if (status === "ok") return "badge badge-green";
  if (status === "token_expired" || status === "paused") return "badge badge-muted";
  return "badge badge-amber";
}

export function AccountProbeButton({ controller, accountId, label, disabled }: {
  controller: AccountProbeController; accountId: string; label: string; disabled?: boolean;
}) {
  const t = useT();
  const pending = controller.isPending(accountId);
  return (
    <button type="button" className="btn btn-ghost btn-sm"
      aria-label={`${t("acctProbe.test")} — ${label}`}
      title={t("acctProbe.hint")}
      aria-busy={pending}
      disabled={disabled || pending}
      onClick={() => { void controller.probeOne(accountId); }}>
      {pending ? t("acctProbe.testing") : t("acctProbe.test")}
    </button>
  );
}

/** One line under the account row: verdict badge, then HTTP code, reason and upstream message. */
export function AccountProbeResultLine({ entry }: { entry: AccountProbeEntry | undefined }) {
  const t = useT();
  if (!entry) return null;
  const time = new Date(entry.at).toLocaleTimeString();
  if ("failed" in entry) {
    return <div className="pwi-auth-row-secondary pws-status-warn" role="status">{`${t("acctProbe.failed")} · ${time}`}</div>;
  }
  const { result } = entry;
  const evidence = [
    result.httpStatus !== null ? `HTTP ${result.httpStatus}` : null,
    result.reason,
    result.message,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  const windows = (result.quota?.customWindows ?? [])
    .map(window => `${window.label} ${Math.max(0, Math.round(100 - window.percent))}%`)
    .join(" · ");
  return (
    <div className="pwi-auth-row-secondary" role="status" data-probe-status={result.status}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <span className={statusBadgeClass(result.status)}>{t(`acctProbe.status.${result.status}`)}</span>
      {evidence && <span className={result.status === "ok" ? "faint" : "pws-status-warn"}>{evidence}</span>}
      {windows && <span className="faint">{windows}</span>}
      <span className="faint">{time}</span>
    </div>
  );
}
