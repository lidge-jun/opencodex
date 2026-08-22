/**
 * ProviderOverview — 2-column layout: left (CONNECTION + Auth summary) / right
 * (STATS + Notes). Phase 030 of workspace design parity.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { useT, useI18n } from "../../i18n/shared";
import { IconAlert, IconCheck } from "../../icons";
import { binProviderStatus, type WorkspaceItem } from "../../provider-workspace/catalog";
import { formatRelativeTime, relativeTimeLabelsFromT, formatRequestCount, formatTokenCount } from "../../provider-workspace/usage";
import { accountQuotaFromReport, formatQuotaSourceLabel, type ProviderQuotaReportView } from "../../provider-workspace/report";
import type { ProviderUsageTotals } from "./types";
import { authModeLabel } from "./ProviderRail";
import type { ProviderUpdatePatch, ProviderUpdateResult } from "./types";
import { ProviderCapacityQuota } from "./ProviderCapacityQuota";

type ConnectionTestResult = {
  applicable?: boolean;
  ok?: boolean;
  latencyMs?: number;
  reason?: string;
  message?: string;
  error?: string;
};

type ConnectionTestState = {
  key: string;
  testing: boolean;
  result: ConnectionTestResult | null;
};

export default function ProviderOverview({
  item, usageTotals, quotaReport, oauthEmail, oauth,
  apiBase, connectionIdentity,
  onEditSettings, onViewUsage, onUpdateProvider,
  onReauthenticate, onCancelLogin, reauthBusy = false,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  oauthEmail?: string;
  /** Login state for OAuth summaries that carry no email (e.g. Cursor/Kimi). */
  oauth?: { loggedIn?: boolean };
  apiBase?: string;
  /** Opaque active credential identity used only to invalidate stale probe results. */
  connectionIdentity?: string;
  onEditSettings?: () => void;
  onViewUsage?: () => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
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
  const connectionProbeKey = JSON.stringify([
    apiBase ?? null,
    item.name,
    item.adapter,
    item.baseUrl,
    item.authMode ?? null,
    item.apiKeyTransport ?? null,
    item.liveModels ?? null,
    item.disabled === true,
    item.hasApiKey === true,
    item.hasHeaders === true,
    item.allowPrivateNetwork === true,
    item.keyOptional === true,
    item.activeNeedsReauth === true,
    connectionIdentity ?? null,
  ]);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestState | null>(null);
  const connectionAbortRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const testingConnection = connectionTest?.key === connectionProbeKey && connectionTest.testing;
  const connectionResult = connectionTest?.key === connectionProbeKey ? connectionTest.result : null;

  useEffect(() => {
    return () => {
      if (connectionAbortRef.current?.key === connectionProbeKey) {
        connectionAbortRef.current.controller.abort();
        connectionAbortRef.current = null;
      }
    };
  }, [connectionProbeKey]);

  const testConnection = useCallback(async () => {
    if (!apiBase) return;
    connectionAbortRef.current?.controller.abort();
    const controller = new AbortController();
    connectionAbortRef.current = { key: connectionProbeKey, controller };
    setConnectionTest({ key: connectionProbeKey, testing: true, result: null });
    try {
      const response = await fetch(`${apiBase}/api/providers/test?name=${encodeURIComponent(item.name)}`, {
        method: "POST",
        signal: controller.signal,
      });
      const result = await readJsonOrThrow<ConnectionTestResult>(response, t("pws.connectionFailed"));
      if (!result) throw new Error(t("pws.connectionFailed"));
      if (!controller.signal.aborted) {
        setConnectionTest({ key: connectionProbeKey, testing: false, result });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setConnectionTest({
          key: connectionProbeKey,
          testing: false,
          result: {
            applicable: true,
            ok: false,
            error: error instanceof Error ? error.message : t("pws.connectionFailed"),
          },
        });
      }
    } finally {
      if (connectionAbortRef.current?.controller === controller) {
        connectionAbortRef.current = null;
      }
    }
  }, [apiBase, connectionProbeKey, item.name, t]);

  const connectionState = connectionResult?.applicable === false
    ? "not-applicable"
    : connectionResult?.ok === true
      ? "ok"
      : "failed";
  const connectionText = connectionResult?.applicable === false
    ? t("pws.connectionNotApplicable")
    : connectionResult?.ok === true
      ? (connectionResult.message || t("pws.connectionOk"))
      : (connectionResult?.error || t("pws.connectionFailed"));
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
        {apiBase && (
          <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={testingConnection}
              onClick={() => void testConnection()}
            >
              {testingConnection ? t("pws.testing") : t("pws.testConnection")}
            </button>
            {connectionResult && (
              <span
                role="status"
                className={connectionState === "ok" ? "pws-status-ok" : connectionState === "failed" ? "pws-status-warn" : "muted"}
                data-connection-test-state={connectionState}
              >
                {connectionText}
              </span>
            )}
          </div>
        )}
        {onEditSettings && (
          <button type="button" className="link-btn pws-edit-settings-link" onClick={onEditSettings}>
            {t("pws.editSettings")}
          </button>
        )}
      </section>

      {quotaReport && (
        <section className="pws-section" aria-label={t("pws.rateLimits")}>
          <h3 className="pws-section-title">{t("pws.rateLimits")}</h3>
          <ProviderCapacityQuota report={quotaReport} pending={false} />
        </section>
      )}

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
                  ? (oauthEmail
                    ? t("pws.loggedInAs", { email: oauthEmail })
                    : oauth?.loggedIn
                      ? t("pws.loggedInTitle")
                      : t("pws.notLoggedIn"))
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
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const save = useCallback(async () => {
    if (saving || !onUpdateProvider) return;
    const trimmed = draft.trim();
    if (trimmed === (item.note ?? "")) {
      setEditing(false);
      setError("");
      return;
    }
    setSaving(true);
    try {
      const result = await onUpdateProvider(item.name, { note: trimmed || undefined });
      if (!result.ok) {
        setError(result.error || t("prov.saveFailed"));
        return;
      }
      setError("");
      setEditing(false);
    } finally {
      setSaving(false);
    }
  // oxlint-disable-next-line react/react-compiler -- preserve existing callback dependency semantics during Oxlint migration
  }, [draft, item.name, item.note, onUpdateProvider, saving, t]);

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
            setError("");
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
        ref={textareaRef}
        className="pws-notes-textarea"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={e => {
          if (e.key === "Escape") { setDraft(item.note ?? ""); setError(""); setEditing(false); }
        }}
        placeholder={t("pws.notePlaceholder")}
        rows={3}
        disabled={saving}
      />
      {error ? <p className="pws-inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
