/**
 * ProviderOverview — 2-column layout: left (CONNECTION + Auth summary) / right
 * (STATS + Notes). Phase 030 of workspace design parity.
 */
import { useCallback, useState } from "react";
import { useT, useI18n } from "../../i18n";
import { IconAlert, IconCheck } from "../../icons";
import { binProviderStatus, type WorkspaceItem } from "../../provider-workspace/catalog";
import { formatRelativeTime, relativeTimeLabelsFromT, formatRequestCount, formatTokenCount } from "../../provider-workspace/usage";
import { accountQuotaFromReport, formatQuotaSourceLabel, type ProviderQuotaReportView } from "../../provider-workspace/report";
import type { ProviderUsageTotals } from "./types";
import { authModeLabel } from "./ProviderRail";
import type { ProviderUpdatePatch } from "./types";

export default function ProviderOverview({
  item, usageTotals, quotaReport, oauthEmail,
  onEditSettings, onViewUsage, onUpdateProvider,
  onReauthenticate, onCancelLogin, reauthBusy = false,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  oauthEmail?: string;
  onEditSettings?: () => void;
  onViewUsage?: () => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  onReauthenticate?: () => void;
  onCancelLogin?: () => void;
  reauthBusy?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);
  const status = binProviderStatus(item);
  const needsAttention = Boolean(item.activeNeedsReauth);
  const statusText = status === "ready"
    ? t("pws.status.connected")
    : status === "needs-setup"
      ? (needsAttention ? t("pws.status.needsAttention") : t("pws.status.needsSetup"))
      : t("prov.disabledBadge");
  const requests = usageTotals?.requests;
  const tokens = usageTotals?.totalTokens;
  const quota = accountQuotaFromReport(quotaReport);
  return (
    <div className="pws-overview-layout">
      <div className="pws-overview-main">
      <section className="pws-section" aria-label={t("pws.connection")}>
        <h3 className="pws-section-title">{t("pws.connection")}</h3>
        <dl className="pws-kv">
          <div className="pws-kv-row">
            <dt>{t("dash.status")}</dt>
            <dd className={status === "ready" ? "pws-status-ok" : "pws-status-warn"}>
              {status === "ready"
                ? <IconCheck style={{ width: 13, height: 13 }} aria-hidden="true" />
                : <IconAlert style={{ width: 13, height: 13 }} aria-hidden="true" />}
              {statusText}
            </dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("modal.baseUrl")}</dt>
            <dd><code>{item.baseUrl?.trim() ? item.baseUrl : "—"}</code></dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("pws.cell.auth")}</dt>
            <dd>{oauthEmail ? `${authModeLabel(item, t)} · ${oauthEmail}` : authModeLabel(item, t)}</dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("modal.defaultModel")}</dt>
            <dd>{item.defaultModel ?? <span className="muted">—</span>}</dd>
          </div>
          {item.note && (
            <div className="pws-kv-row">
              <dt>{t("pws.cell.note")}</dt>
              <dd className="muted">{item.note}</dd>
            </div>
          )}
        </dl>
        {onEditSettings && (
          <button type="button" className="link-btn pws-edit-settings-link" onClick={onEditSettings}>
            {t("pws.editSettings")}
          </button>
        )}
      </section>

      <section className="pws-section" aria-label={t("pws.authSummary")}>
        <h3 className="pws-section-title">{t("pws.authSummary")}</h3>
        {needsAttention ? (
          <div className="pws-auth-summary pws-auth-summary--warn" role="status">
            <IconAlert style={{ width: 14, height: 14 }} aria-hidden="true" />
            <div className="pws-auth-summary-body">
              <span>
                <strong>{t("pws.status.needsAttention")}</strong>
                {" — "}
                {item.authMode === "forward"
                  ? t("pws.attention.reauthForward")
                  : t("pws.attention.reauth")}
              </span>
              {onReauthenticate && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={reauthBusy}
                  onClick={() => onReauthenticate()}
                >
                  {reauthBusy ? t("prov.waitingBrowser") : t("pws.reauthenticate")}
                </button>
              )}
              {reauthBusy && onCancelLogin && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCancelLogin()}>
                  {t("common.cancel")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="pws-auth-summary">
            <span className="pws-auth-dot" />
            <span>
              {item.authMode === "forward"
                ? t("pws.passthrough")
                : item.authMode === "oauth"
                  ? (oauthEmail ? t("pws.loggedInAs", { email: oauthEmail }) : t("pws.notLoggedIn"))
                  : item.hasApiKey
                    ? t("pws.apiKeyConfigured")
                    : authModeLabel(item, t)}
            </span>
          </div>
        )}
      </section>
      </div>

      <aside className="pws-overview-sidebar">
      <section className="pws-section" aria-label={t("pws.statsAria")}>
        <h3 className="pws-section-title">{t("pws.statsTitle")}</h3>
        <dl className="pws-kv">
          {typeof requests === "number" && (
            <div className="pws-kv-row">
              <dt>{t("pws.stats.totalRequests")}</dt>
              <dd className="pws-kv-mono">{formatRequestCount(requests, locale)}</dd>
            </div>
          )}
          {typeof tokens === "number" && (
            <div className="pws-kv-row">
              <dt>{t("pws.stats.totalTokens")}</dt>
              <dd className="pws-kv-mono">{formatTokenCount(tokens, locale)}</dd>
            </div>
          )}
          {quotaReport && (
            <div className="pws-kv-row">
              <dt>{t("pws.stats.quotaUpdated")}</dt>
              <dd
                className="pws-kv-mono"
                title={quotaReport.source ? formatQuotaSourceLabel(quotaReport.source) : undefined}
              >
                {formatRelativeTime(quotaReport.updatedAt, timeLabels)}
              </dd>
            </div>
          )}
          {typeof requests !== "number" && typeof tokens !== "number" && !quotaReport && (
            <div className="muted">{t("pws.usageUnavailable")}</div>
          )}
        </dl>
        {onViewUsage && (
          <button type="button" className="link-btn pws-view-usage-link" onClick={onViewUsage}>
            {t("pws.viewUsage")} →
          </button>
        )}
        {quota && <div className="muted pws-stats-note">{t("pws.stats.quotaTracked")}</div>}
      </section>

      <NotesSection item={item} onUpdateProvider={onUpdateProvider} />
      </aside>
    </div>
  );
}

function NotesSection({ item, onUpdateProvider }: {
  item: WorkspaceItem;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (saving || !onUpdateProvider) return;
    const trimmed = draft.trim();
    if (trimmed === (item.note ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    await onUpdateProvider(item.name, { note: trimmed || undefined });
    setSaving(false);
    setEditing(false);
  }, [draft, item.name, item.note, onUpdateProvider, saving]);

  if (!editing) {
    return (
      <section className="pws-section pws-notes-section" aria-label={t("pws.notes")}>
        <h3 className="pws-section-title">{t("pws.notes")}</h3>
        <button
          type="button"
          className="pws-notes-display"
          onClick={() => {
            if (!onUpdateProvider) return;
            setDraft(item.note ?? "");
            setEditing(true);
          }}
          disabled={!onUpdateProvider}
        >
          {item.note || <span className="muted">{t("pws.notePlaceholder")}</span>}
        </button>
      </section>
    );
  }

  return (
    <section className="pws-section pws-notes-section" aria-label={t("pws.notes")}>
      <h3 className="pws-section-title">{t("pws.notes")}</h3>
      <textarea
        className="pws-notes-textarea"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={e => {
          if (e.key === "Escape") { setDraft(item.note ?? ""); setEditing(false); }
        }}
        placeholder={t("pws.notePlaceholder")}
        autoFocus
        rows={3}
        disabled={saving}
      />
    </section>
  );
}
