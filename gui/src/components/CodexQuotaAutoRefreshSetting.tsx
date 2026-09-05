import { useT } from "../i18n/shared";
import type { quotaActivationWindows } from "../codex-quota-activation";

export default function CodexQuotaAutoRefreshSetting({
  windows, ready, busy, loadError, feedback, onToggle, onRetry,
}: {
  windows: ReturnType<typeof quotaActivationWindows>;
  ready: boolean;
  busy: boolean;
  loadError: boolean;
  feedback: { message: string; failed: boolean } | null;
  onToggle(enabled: boolean): void;
  onRetry(): void;
}) {
  const t = useT();
  const available = windows.filter(window => window.available);
  const anyEnabled = windows.some(window => window.enabled);
  const enabled = available.length ? available.every(window => window.enabled) : anyEnabled;
  const mixed = anyEnabled && !enabled;
  const empty = available.length === 0 && !anyEnabled;
  const message = busy ? t("common.saving")
    : loadError ? t("codexAuth.quotaAutoRefreshLoadFailed")
    : !ready ? t("common.loading")
    : feedback?.message ?? (empty ? t("codexAuth.quotaAutoRefreshEmpty")
      : mixed ? t("codexAuth.quotaAutoRefreshMixed") : "");
  const failed = !busy && (loadError || feedback?.failed);
  return (
    <div id="codex-quota-activation" className="card card-row codex-quota-activation" aria-busy={busy || (!ready && !loadError) || undefined}>
      <div className="codex-quota-activation__copy">
        <strong>{t("codexAuth.quotaAutoRefresh")}</strong>
        <div id="codex-quota-activation-desc" className="card-sub">{t("codexAuth.quotaAutoRefreshAllHint")}</div>
        {message && <div className={`card-sub${failed ? " is-error" : ""}`} role={failed ? "alert" : "status"}>{message}</div>}
      </div>
      <div className="codex-quota-activation__controls">
        {failed && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRetry}>{t("common.retry")}</button>}
        <button type="button" className={`toggle ${ready && enabled ? "on" : ""}`}
          aria-label={t("codexAuth.quotaAutoRefresh")}
          aria-describedby="codex-quota-activation-desc"
          aria-pressed={ready ? mixed ? "mixed" : enabled : undefined}
          disabled={!ready || busy || empty}
          onClick={() => onToggle(!enabled)}>
          <span className="toggle-knob" />
        </button>
      </div>
    </div>
  );
}
