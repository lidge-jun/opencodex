/**
 * ProviderOverview — 2-column layout: left (CONNECTION + Auth summary) / right
 * (STATS + Notes). Phase 030 of workspace design parity.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { useT, useI18n } from "../../i18n/shared";
import { IconAlert, IconCheck } from "../../icons";
import { binProviderStatus, type WorkspaceItem } from "../../provider-workspace/catalog";
import { formatRequestCount, formatTokenCount } from "../../provider-workspace/usage";
import { modelVisible } from "../../model-visibility";
import { discoveryFailureLabel, type ModelRow } from "../../pages/models-shared";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import type { AccountQuotaReading, ProviderUsageTotals } from "./types";
import { authModeLabel } from "./ProviderRail";
import type { ProviderUpdatePatch, ProviderUpdateResult } from "./types";
import ProviderCurrentQuota from "./ProviderCurrentQuota";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import ProviderSponsor from "./ProviderSponsor";
import ProviderCompletionTest, { type CompletionProbeStatus } from "./ProviderCompletionTest";
import { useProviderProbeState, type ProviderProbeController } from "./use-provider-probe-state";

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
  item, preset, usageTotals, quotaReport, currentQuotaReading, onRefreshQuota, oauthEmail, oauth,
  apiBase, connectionIdentity, probeController, availableModels = [], selectedModels, modelRows, modelRowsReady = false,
  modelsLoading = false, modelsLoadFailed = false, onRetryModels, onOpenAccounts, onOpenModelsTab, onOpenModels, onOpenConnect,
  onEditSettings, onViewUsage, onUpdateProvider,
  onCreateJevAuto,
  onReauthenticate, onCancelLogin, reauthBusy = false,
}: {
  item: WorkspaceItem;
  preset?: CatalogPreset;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  currentQuotaReading?: AccountQuotaReading;
  onRefreshQuota?: () => Promise<boolean>;
  oauthEmail?: string;
  /** Login state for OAuth summaries that carry no email (e.g. Cursor/Kimi). */
  oauth?: { loggedIn?: boolean; needsReauth?: boolean };
  apiBase?: string;
  probeController?: ProviderProbeController;
  availableModels?: string[];
  selectedModels?: string[];
  modelRows?: ModelRow[] | null;
  modelRowsReady?: boolean;
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  onRetryModels?: () => void;
  onOpenAccounts?: () => void;
  onOpenModelsTab?: () => void;
  onOpenModels?: () => void;
  onOpenConnect?: () => void;
  /** Opaque active credential identity used only to invalidate stale probe results. */
  connectionIdentity?: string;
  onEditSettings?: () => void;
  onViewUsage?: () => void;
  onCreateJevAuto?: () => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
  onReauthenticate?: () => void;
  onCancelLogin?: () => void;
  reauthBusy?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const status = binProviderStatus(item);
  const needsAttention = Boolean(item.activeNeedsReauth) || oauth?.needsReauth === true;
  const needsOAuthLogin = item.authMode === "oauth" && oauth?.loggedIn === false;
  const effectiveStatus = item.disabled === true
    ? "disabled"
    : needsAttention || needsOAuthLogin || status === "needs-setup"
      ? "needs-setup"
      : "ready";
  const statusText = effectiveStatus === "ready"
    ? t("pws.status.ready")
    : effectiveStatus === "needs-setup"
      ? (needsAttention ? t("pws.status.needsAttention") : t("pws.status.needsSetup"))
      : t("prov.disabledBadge");
  const requests = usageTotals?.requests;
  const tokens = usageTotals?.totalTokens;
  const fallbackProbeController = useProviderProbeState(item, apiBase, connectionIdentity, availableModels);
  const activeProbe = probeController ?? fallbackProbeController;
  const { connectionProbeKey, completionModels, selectedModel: probeSelectedModel, completionProbe, reverifyModel } = activeProbe;
  const [connectionTest, setConnectionTest] = useState<ConnectionTestState | null>(null);
  const connectionAbortRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const testingConnection = connectionTest?.key === connectionProbeKey && connectionTest.testing;
  const connectionResult = connectionTest?.key === connectionProbeKey ? connectionTest.result : null;
  const configuredModels = [
    ...new Set([
      ...(item.models ?? []),
      ...(item.defaultModel ? [item.defaultModel] : []),
    ]),
  ];

  useEffect(() => {
    return () => {
      if (connectionAbortRef.current?.key === connectionProbeKey) {
        connectionAbortRef.current.controller.abort();
        connectionAbortRef.current = null;
      }
    };
  }, [connectionProbeKey]);

  const testConnection = useCallback(async () => {
    // "" is the same-origin dashboard, a real server; only an omitted base has nothing to probe.
    if (apiBase === undefined) return;
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
  const providerStepState = item.disabled === true
    ? "disabled"
    : needsAttention
      ? "needs-attention"
      : needsOAuthLogin
        ? "needs-login"
        : effectiveStatus === "needs-setup"
          ? "needs-setup"
          : "saved";
  const providerStepText = providerStepState === "disabled"
    ? t("pws.firstResponse.providerDisabled")
    : providerStepState === "needs-attention"
      ? t("pws.firstResponse.providerNeedsAttention")
      : providerStepState === "needs-login"
        ? t("pws.firstResponse.providerNeedsLogin")
        : providerStepState === "needs-setup"
          ? t("pws.firstResponse.providerNeedsSetup")
          : t("pws.firstResponse.providerSaved");

  const providerRows = (modelRows ?? []).filter(row => row.provider === item.name);
  const enabledRows = providerRows.filter(row =>
    modelVisible({ [item.name]: selectedModels ?? [] }, item.name, row.id, row.native === true, row.disabled),
  );
  const snapshotReady = modelRows !== undefined && modelRows !== null && modelRowsReady;
  // Once the model snapshot has settled, its rows are authoritative for whether initial
  // selection is still pending: /api/config is not re-read when discovery finishes without an
  // open registration notice, so a stale item.initialModelSelection.status === "pending" must
  // not override a ready snapshot whose rows have already cleared initialSelectionPending.
  const isPending = snapshotReady
    ? providerRows.some(row => row.initialSelectionPending === true)
    : item.initialModelSelection?.status === "pending";
  const discoveryFailure = item.liveModels !== false && item.discovery?.status === "failed"
    ? item.discovery
    : undefined;
  const modelsStepState = modelsLoading
    ? "loading"
    : modelsLoadFailed
      ? "failed"
      : discoveryFailure && (!snapshotReady || isPending || enabledRows.length === 0)
        ? "failed"
        : isPending
          ? "pending"
          : snapshotReady
            ? enabledRows.length > 0
              ? (discoveryFailure ? "ready-discovery-failed" : "ready")
              : (providerRows.length > 0 || item.initialModelSelection?.status === "all-off")
                ? "all-off"
                : configuredModels.length > 0
                  ? "configured"
                  : "empty"
            : item.initialModelSelection?.status === "all-off"
              ? "all-off"
              : configuredModels.length > 0 || availableModels.length > 0
                ? "configured"
                : "empty";
  const modelsStepText = modelsStepState === "loading"
    ? t("pws.firstResponse.modelsLoading")
    : modelsStepState === "failed"
      ? (discoveryFailure ? discoveryFailureLabel(t, discoveryFailure) : t("pws.firstResponse.modelsFailed"))
      : modelsStepState === "pending"
        ? t("pws.firstResponse.modelsPending")
        : modelsStepState === "ready-discovery-failed"
          ? t("pws.firstResponse.modelsReadyDiscoveryFailed", { count: enabledRows.length })
          : modelsStepState === "ready"
            ? t("pws.firstResponse.modelsReady", { count: enabledRows.length })
            : modelsStepState === "all-off"
              ? t("pws.firstResponse.modelsAllOff")
              : modelsStepState === "configured"
                ? t("pws.firstResponse.modelsConfigured", { count: configuredModels.length || availableModels.length })
                : t("pws.firstResponse.modelsEmpty");
  const probeStepState: CompletionProbeStatus = completionProbe?.status ?? "untested";
  const reverifyPending = probeStepState === "untested" && reverifyModel !== null;
  const probeStepText = probeStepState === "testing"
    ? t("pws.testing")
    : probeStepState === "ok"
      ? t("pws.firstResponse.probeOk", { model: completionProbe?.model ?? "" })
      : probeStepState === "failed"
        ? t("pws.firstResponse.probeFailed", { model: completionProbe?.model ?? "" })
        : probeStepState === "not-applicable"
          ? t("pws.completion.notApplicable")
          : reverifyPending
            ? t("pws.firstResponse.probeReverify", { model: reverifyModel })
            : t("pws.firstResponse.probeUntested");
  const openModelsAction = onOpenModelsTab ?? onOpenModels;
  const fixCredentialsAction = onOpenAccounts ?? onEditSettings;

  return (
    <>
    <ProviderSponsor item={item} preset={preset} />
    <div className="pws-overview-layout">
      <div className="pws-overview-main">
      <section className="pws-section" aria-label={t("pws.connection")}>
        <h3 className="pws-section-title">{t("pws.connection")}</h3>
        <dl className="pws-kv">
          <div className="pws-kv-row">
            <dt>{t("dash.status")}</dt>
            <dd className={effectiveStatus === "ready" ? "pws-status-ok" : "pws-status-warn"}>
              {effectiveStatus === "ready"
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
        </dl>
        <div className="pws-first-response" aria-label={t("pws.firstResponse.title")}>
          <div className="pws-first-response-row" data-first-response-step="provider" data-step-state={providerStepState}>
            <span className="pws-first-response-label">{t("pws.firstResponse.stepProvider")}</span>
            <span className={providerStepState === "saved" ? "pws-status-ok" : "pws-status-warn"}>
              {providerStepText}
            </span>
          </div>
          <div className="pws-first-response-row" data-first-response-step="models" data-step-state={modelsStepState}>
            <span className="pws-first-response-label">{t("pws.firstResponse.stepModels")}</span>
            <span className={
              modelsStepState === "ready"
                ? "pws-status-ok"
                : modelsStepState === "failed" || modelsStepState === "all-off" || modelsStepState === "empty" || modelsStepState === "ready-discovery-failed"
                  ? "pws-status-warn"
                  : "muted"
            }>
              {modelsStepText}
            </span>
            {modelsStepState === "failed" && onRetryModels && (
              <button type="button" className="link-btn" onClick={onRetryModels}>
                {t("common.retry")}
              </button>
            )}
            {openModelsAction && (
              <button type="button" className="link-btn" onClick={openModelsAction}>
                {t("pws.firstResponse.openProviderModels")}
              </button>
            )}
          </div>
          <div className="pws-first-response-row" data-first-response-step="clients" data-step-state="info">
            <span className="pws-first-response-label">{t("pws.firstResponse.stepClients")}</span>
            <span className="muted">{t("pws.firstResponse.clientStep", { provider: item.name })}</span>
            {onOpenConnect && (
              <button type="button" className="link-btn" onClick={onOpenConnect}>
                {t("pws.firstResponse.openConnect")}
              </button>
            )}
          </div>
          <div
            className="pws-first-response-row"
            data-first-response-step="probe"
            data-step-state={probeStepState}
            {...(reverifyPending ? { "data-reverify-pending": "true" } : {})}
          >
            <span className="pws-first-response-label">{t("pws.firstResponse.stepProbe")}</span>
            <span className={
              probeStepState === "ok"
                ? "pws-status-ok"
                : probeStepState === "failed" || reverifyPending
                  ? "pws-status-warn"
                  : "muted"
            }>
              {probeStepText}
            </span>
          </div>
          <div className="pws-first-response-row" data-first-response-step="disconnect" data-step-state="info">
            <span className="pws-first-response-label">{t("pws.firstResponse.stepDisconnect")}</span>
            <span className="muted">{t("pws.firstResponse.disconnectNote", { provider: item.name })}</span>
            {onOpenConnect && (
              <button type="button" className="link-btn" onClick={onOpenConnect}>
                {t("pws.firstResponse.openConnect")}
              </button>
            )}
          </div>
        </div>
        {apiBase !== undefined && (
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
            {connectionResult && connectionState === "failed" && fixCredentialsAction && (
              <button
                type="button"
                className="link-btn"
                data-connection-recovery-action="fix-connection"
                onClick={fixCredentialsAction}
              >
                {t(onOpenAccounts ? "pws.completion.recovery.fixAuth" : "pws.completion.recovery.fixSettings")}
              </button>
            )}
          </div>
        )}
        {apiBase !== undefined && (
          <ProviderCompletionTest
            key={item.name}
            apiBase={apiBase}
            provider={item.name}
            probeKey={connectionProbeKey}
            models={completionModels}
            selectedModel={probeSelectedModel}
            onSelectedModelChange={activeProbe.selectModel}
            initialResult={completionProbe?.result ?? null}
            initialError={completionProbe?.error ?? null}
            onStatusChange={activeProbe.reportStatus}
            onFixCredentials={fixCredentialsAction}
            onFixSettings={onEditSettings}
            onFixModels={openModelsAction}
          />
        )}
        {onEditSettings && (
          <button type="button" className="link-btn pws-edit-settings-link" onClick={onEditSettings}>
            {t("pws.editSettings")}
          </button>
        )}
      </section>

      {item.adapter === "jev-decision" && onCreateJevAuto && (
        <section className="pws-section" aria-label={t("cws.jev.create")}>
          <h3 className="pws-section-title">{t("cws.jev.create")}</h3>
          <p className="muted" style={{ marginTop: 0 }}>{t("cws.jev.setupHint")}</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={onCreateJevAuto}>
            {t("cws.jev.create")}
          </button>
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
      <NotesSection item={item} onUpdateProvider={onUpdateProvider} />
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
          {typeof requests !== "number" && typeof tokens !== "number" && (
            <div className="muted">{t("pws.usageUnavailable")}</div>
          )}
        </dl>
        {onViewUsage && (
          <button type="button" className="link-btn pws-view-usage-link" onClick={onViewUsage}>
            {t("pws.viewUsage")} →
          </button>
        )}
      </section>

      <ProviderCurrentQuota key={`${item.name}:${connectionIdentity ?? ""}`} report={quotaReport} reading={currentQuotaReading} onRefreshQuota={onRefreshQuota} />
      </aside>
    </div>
    </>
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
