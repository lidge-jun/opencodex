/**
 * StorageWorkspace - rail + main workspace for the Storage tab, mirroring the
 * Providers workspace DNA. Left rail lists buckets sorted by size; the main pane
 * shows either the overview (totals + largest files across buckets) or a
 * per-bucket detail view.
 */
/* eslint-disable react-refresh/only-export-components -- bucket label helper co-locates with the rail rows */
import { useMemo, useState } from "react";
import { IconChevron, IconHardDrive } from "../../icons";
import { useT, type TFn, type TKey, type Locale } from "../../i18n/shared";
import { logGuardLabel } from "../../i18n/log-guard-labels";
import { logGuardOperationLabel } from "../../i18n/log-guard-operation-labels";
import {
  logGuardProtectionModeLabel,
  logGuardProtectionStateLabel,
  logGuardSchemaStateLabel,
} from "../../i18n/log-guard-state-labels";
import { formatBytes } from "../../format-bytes";

const API_BASE = import.meta.env.VITE_API_BASE || "";

export interface StorageLargestEntry {
  path: string;
  bytes: number;
}

export interface StorageBucket {
  key: string;
  label: string;
  bytes: number;
  fileCount: number;
  oldest?: number;
  newest?: number;
  largest?: StorageLargestEntry[];
  rows?: number | null;
}

type LogGuardReason = "database_missing" | "database_unreadable" | "unknown_schema";
type LogGuardCapability = { state: "supported" } | { state: "unsupported"; reason: LogGuardReason };
type LogGuardSchema =
  | { state: "compatible" }
  | { state: "missing"; reason: "database_missing" }
  | { state: "unreadable"; reason: "database_unreadable" }
  | { state: "unsupported"; reason: "unknown_schema" };

export interface CodexLogGuardProtection {
  desiredMode: "off" | "compat" | "quiet";
  observedMode: "off" | "compat" | "quiet" | "collision";
  state: "off" | "active" | "drifted" | "unsupported" | "unknown";
}

export interface CodexLogGuardReport {
  generatedAt: number;
  externalSqliteHome: boolean;
  snapshot: "checkpointed";
  files: { databaseBytes: number; walBytes: number; shmBytes: number };
  schema: LogGuardSchema;
  capabilities: {
    inspection: LogGuardCapability;
    protection: LogGuardCapability;
    reclaim: LogGuardCapability;
  };
  protection?: CodexLogGuardProtection;
  metrics: null | {
    totalRows: number;
    rowsByLevel: Record<string, number>;
    traceRows: number;
    traceShare: number;
    topTargets: Array<{ target: string; rows: number }>;
    pageSize: number;
    pageCount: number;
    freelistPages: number;
    reclaimableBytes: number;
    estimatedLogBytes: number | null;
  };
}

export interface StorageReport {
  codexHome: string;
  generatedAt: number;
  total: { bytes: number; fileCount: number };
  buckets: StorageBucket[];
  codexLogs?: CodexLogGuardReport | null;
  codexLogsError?: string;
  error?: string;
}

export type CodexLogGuardAction =
  | { action: "protect"; mode: "compat" | "quiet" }
  | { action: "unprotect" }
  | { action: "repair" }
  | { action: "compact" };

// Known scanner bucket keys -> localized labels; unknown future keys fall back to the API label.
const BUCKET_TKEYS: Record<string, TKey> = {
  sessions: "storage.bucket.sessions",
  archived_sessions: "storage.bucket.archived_sessions",
  logs_db: "storage.bucket.logs_db",
  state_db: "storage.bucket.state_db",
  attachments: "storage.bucket.attachments",
  deletion_manifests: "storage.bucket.deletion_manifests",
  other: "storage.bucket.other",
};

export function bucketLabel(bucket: StorageBucket, t: TFn): string {
  const tkey = BUCKET_TKEYS[bucket.key];
  return tkey ? t(tkey) : bucket.label;
}

function formatDate(ms: number | undefined, locale: Locale): string {
  return ms === undefined ? "—" : new Date(ms).toLocaleDateString(locale);
}

function rowsDisplay(bucket: StorageBucket, locale: Locale, t: TFn): string {
  if (bucket.rows === undefined) return "—";
  if (bucket.rows === null) return t("storage.rows.unknown");
  return bucket.rows.toLocaleString(locale);
}

function mutationErrorLabel(locale: Locale, code: unknown): string {
  switch (code) {
    case "codex_running": return logGuardOperationLabel(locale, "error.codex_running");
    case "process_enumeration_failed": return logGuardOperationLabel(locale, "error.process_enumeration_failed");
    case "busy": return logGuardOperationLabel(locale, "error.busy");
    case "unsupported_schema": return logGuardOperationLabel(locale, "error.unsupported_schema");
    case "trigger_collision": return logGuardLabel(locale, "error.trigger_collision");
    case "unsafe_path": return logGuardOperationLabel(locale, "error.unsafe_path");
    case "database_error": return logGuardOperationLabel(locale, "error.database_error");
    // Two distinct situations that previously collapsed into the generic
    // message: an unsupported auto-vacuum configuration (nothing can be
    // reclaimed without a full rebuild) versus a failed integrity check
    // (the database itself is suspect). A user cannot act on "something
    // went wrong".
    case "auto_vacuum_not_incremental": return logGuardOperationLabel(locale, "error.auto_vacuum_not_incremental");
    case "integrity_check_failed": return logGuardOperationLabel(locale, "error.integrity_check_failed");
    case "config_write_failed": return logGuardLabel(locale, "error.config_write_failed");
    default: return logGuardOperationLabel(locale, "error.generic");
  }
}

function CodexLogGuardPanel({
  report,
  locale,
  t,
  busy,
  error,
  compaction,
  onAction,
}: {
  report: CodexLogGuardReport;
  locale: Locale;
  t: TFn;
  busy: boolean;
  error: string | null;
  /** Outcome of the last compaction POST, retained independently of the status refresh. */
  compaction: string | null;
  onAction: (action: CodexLogGuardAction) => void;
}) {
  const metrics = report.metrics;
  const inspectOnly = report.capabilities.protection.state === "unsupported"
    || report.capabilities.reclaim.state === "unsupported";
  const protection = report.protection;
  const mutationDisabled = busy || report.capabilities.protection.state !== "supported";
  const reclaimAvailable = protection !== undefined
    && report.capabilities.reclaim.state === "supported"
    && (metrics?.reclaimableBytes ?? 0) > 0;
  const [confirmCompact, setConfirmCompact] = useState(false);

  return (
    <div className="stw-section" data-testid="codex-log-guard">
      <h3 className="stw-section-title">{t("storage.bucket.logs_db")}</h3>
      <dl className="stw-kv">
        <div className="stw-kv-row">
          <dt>{t("dash.status")}</dt>
          <dd className="stw-kv-mono">
            <code>{logGuardSchemaStateLabel(locale, report.schema.state)}</code>
            {inspectOnly && report.schema.state === "unsupported" ? <><span aria-hidden="true"> · </span><code>{logGuardLabel(locale, "inspectionOnly")}</code></> : null}
          </dd>
        </div>
        <div className="stw-kv-row">
          <dt>{t("storage.bucket.logs_db")}</dt>
          <dd className="stw-kv-mono">{formatBytes(report.files.databaseBytes, locale)}</dd>
        </div>
        <div className="stw-kv-row">
          <dt><code>WAL</code></dt>
          <dd className="stw-kv-mono">{formatBytes(report.files.walBytes, locale)}</dd>
        </div>
        <div className="stw-kv-row">
          <dt><code>SHM</code></dt>
          <dd className="stw-kv-mono">{formatBytes(report.files.shmBytes, locale)}</dd>
        </div>
        {metrics && (
          <>
            <div className="stw-kv-row">
              <dt>{t("storage.col.rows")}</dt>
              <dd className="stw-kv-mono">{metrics.totalRows.toLocaleString(locale)}</dd>
            </div>
            <div className="stw-kv-row">
              <dt><code>TRACE</code></dt>
              <dd className="stw-kv-mono">{(metrics.traceShare * 100).toFixed(1)}%</dd>
            </div>
            <div className="stw-kv-row">
              <dt><code>freelist</code></dt>
              <dd className="stw-kv-mono">{formatBytes(metrics.reclaimableBytes, locale)}</dd>
            </div>
          </>
        )}
        <div className="stw-kv-row">
          <dt><code>sqlite_home</code></dt>
          <dd className="stw-kv-mono">
            <code>{report.externalSqliteHome ? logGuardLabel(locale, "externalSqliteHome") : "CODEX_HOME"}</code>
          </dd>
        </div>
      </dl>

      {protection && (
        <div className="stw-section" data-testid="log-guard-protection">
          <h4 className="stw-section-title">{logGuardLabel(locale, "protection")}</h4>
          <div className="stw-kv-row">
            <span className="muted"><code>{logGuardProtectionStateLabel(locale, protection.state)}</code></span>
            <span className="stw-kv-mono">
              <code>{logGuardProtectionModeLabel(locale, protection.desiredMode)}</code>
              {protection.observedMode !== protection.desiredMode ? <><span aria-hidden="true"> · </span><code>{logGuardProtectionModeLabel(locale, protection.observedMode)}</code></> : null}
            </span>
          </div>
          <div className="storage-policy-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="log-guard-protect-compat"
              disabled={mutationDisabled}
              aria-pressed={protection.desiredMode === "compat"}
              onClick={() => onAction({ action: "protect", mode: "compat" })}
            >
              {logGuardLabel(locale, "compat")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="log-guard-protect-quiet"
              disabled={mutationDisabled}
              aria-pressed={protection.desiredMode === "quiet"}
              onClick={() => onAction({ action: "protect", mode: "quiet" })}
            >
              {logGuardLabel(locale, "quiet")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="log-guard-unprotect"
              disabled={mutationDisabled || protection.desiredMode === "off"}
              onClick={() => onAction({ action: "unprotect" })}
            >
              {logGuardLabel(locale, "disable")}
            </button>
            {protection.state === "drifted" && (
              <button
                type="button"
                className="btn btn-sm"
                data-testid="log-guard-repair"
                disabled={mutationDisabled}
                onClick={() => onAction({ action: "repair" })}
              >
                {logGuardLabel(locale, "repair")}
              </button>
            )}
            {busy && <span className="muted" role="status">{logGuardOperationLabel(locale, "applying")}</span>}
          </div>
          {error && <p className="err" role="alert">{error}</p>}
        </div>
      )}

      {reclaimAvailable && (
        <div className="stw-section" data-testid="log-guard-reclaim">
          <div className="storage-policy-actions">
            {!confirmCompact ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="log-guard-compact"
                disabled={busy}
                onClick={() => setConfirmCompact(true)}
              >
                {logGuardLabel(locale, "compact")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="log-guard-compact-confirm"
                  disabled={busy}
                  onClick={() => {
                    setConfirmCompact(false);
                    onAction({ action: "compact" });
                  }}
                >
                  {logGuardLabel(locale, "confirmCompact")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => setConfirmCompact(false)}
                >
                  {logGuardLabel(locale, "cancel")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {compaction && (
        // Rendered OUTSIDE `reclaimAvailable` on purpose. A fully successful
        // compaction drives reclaimableBytes to 0, which retires the reclaim
        // section — so nesting the result inside it hid the outcome in exactly
        // the best case. The POST's own result is also shown when the follow-up
        // status refresh fails, since the mutation had already succeeded.
        <div className="stw-section">
          <p className="stw-kv-mono" role="status" data-testid="log-guard-compact-result">{compaction}</p>
        </div>
      )}

      {metrics && metrics.topTargets.length > 0 && (
        <div className="stw-section">
          <h4 className="stw-section-title"><code>target</code></h4>
          {metrics.topTargets.slice(0, 5).map(target => (
            <div key={target.target} className="stw-file-row">
              <span className="stw-file-path" title={target.target}><code>{target.target}</code></span>
              <span className="stw-file-size">{target.rows.toLocaleString(locale)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="stw-hint"><code>immutable=1 · snapshot={report.snapshot}</code></p>
    </div>
  );
}

function CodexLogGuardUnavailablePanel({ locale, t }: { locale: Locale; t: TFn }) {
  return (
    <div className="stw-section" data-testid="codex-log-guard-unavailable">
      <h3 className="stw-section-title">{t("storage.bucket.logs_db")}</h3>
      <p className="stw-hint">{logGuardLabel(locale, "inspectionUnavailable")}</p>
    </div>
  );
}

export interface StorageWorkspaceProps {
  report: StorageReport;
  locale: Locale;
  logGuardBusy?: boolean;
  onLogGuardAction?: (action: CodexLogGuardAction) => void;
}

type GenerationScopedLogGuardReport = {
  generation: number;
  report: CodexLogGuardReport;
};

type GenerationScopedError = {
  generation: number;
  message: string;
};

/**
 * The compaction POST's own report. Kept separately from the periodic status
 * refresh: the mutation already succeeded, so its outcome must survive even if
 * the follow-up GET fails. Without this, a successful compact whose refresh
 * failed showed the user nothing and invited them to run it again.
 */
type GenerationScopedCompaction = {
  generation: number;
  summary: string;
};

export default function StorageWorkspace({
  report,
  locale,
  logGuardBusy = false,
  onLogGuardAction,
}: StorageWorkspaceProps) {
  const t = useT();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [logGuardOverride, setLogGuardOverride] = useState<GenerationScopedLogGuardReport | null>(null);
  const [internalLogGuardBusy, setInternalLogGuardBusy] = useState(false);
  const [logGuardError, setLogGuardError] = useState<GenerationScopedError | null>(null);
  const [logGuardCompaction, setLogGuardCompaction] = useState<GenerationScopedCompaction | null>(null);

  const sortedBuckets = useMemo(
    () => report.buckets.toSorted((a, b) => b.bytes - a.bytes),
    [report.buckets],
  );
  const selected = sortedBuckets.find(b => b.key === selectedKey) ?? null;
  const displayedLogGuard = logGuardOverride?.generation === report.generatedAt
    ? logGuardOverride.report
    : report.codexLogs ?? null;
  const displayedLogGuardError = logGuardError?.generation === report.generatedAt
    ? logGuardError.message
    : null;
  const displayedCompaction = logGuardCompaction?.generation === report.generatedAt
    ? logGuardCompaction.summary
    : null;
  const effectiveLogGuardBusy = logGuardBusy || internalLogGuardBusy;

  const largestAcross = useMemo(() => {
    const rows: Array<StorageLargestEntry & { bucketKey: string }> = [];
    for (const bucket of report.buckets) {
      for (const entry of bucket.largest ?? []) rows.push({ ...entry, bucketKey: bucket.key });
    }
    return rows.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  }, [report.buckets]);

  const bucketByKey = useMemo(
    () => new Map(report.buckets.map(b => [b.key, b])),
    [report.buckets],
  );

  const runLogGuardAction = (action: CodexLogGuardAction) => {
    if (onLogGuardAction) {
      onLogGuardAction(action);
      return;
    }
    if (internalLogGuardBusy) return;
    const generation = report.generatedAt;
    void (async () => {
      setInternalLogGuardBusy(true);
      setLogGuardError(null);
      // A new attempt invalidates the previous receipt. Leaving it up meant a
      // failed retry could render a stale success alongside the current error,
      // so the section misreported the latest attempt.
      if (action.action === "compact") setLogGuardCompaction(null);
      try {
        const suffix = action.action === "protect" ? "protect" : action.action;
        const init: RequestInit = {
          method: "POST",
          ...(action.action === "protect" ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: action.mode }),
          } : {}),
        };
        const response = await fetch(`${API_BASE}/api/storage/codex-logs/${suffix}`, init);
        if (!response.ok) {
          const errorPayload = await response.json().catch(() => ({})) as Record<string, unknown>;
          setLogGuardError({ generation, message: mutationErrorLabel(locale, errorPayload.error) });
          return;
        }
        if (action.action === "compact") {
          // Read the POST's own report FIRST. It is the authoritative record of
          // what this mutation reclaimed; discarding it meant a successful
          // compaction whose refresh then failed showed the user nothing at all,
          // hiding pagesReclaimed/complete/stopReason and inviting them to
          // repeat a mutation that already worked.
          const posted = await response.json().catch(() => null) as {
            report?: {
              pagesReclaimed?: number;
              logicalBytesReclaimed?: number;
              physicalDatabaseBytesReclaimed?: number;
              complete?: boolean;
              stopReason?: string;
            };
          } | null;
          const postedReport = posted?.report;
          if (postedReport) {
            // Both figures are shown because they answer different questions: an
            // incremental vacuum can return pages to the free list without the
            // file shrinking, so "logical > 0, physical 0" is normal progress
            // rather than a failed run.
            const logical = formatBytes(postedReport.logicalBytesReclaimed ?? 0, locale);
            const physical = formatBytes(postedReport.physicalDatabaseBytesReclaimed ?? 0, locale);
            const state = postedReport.complete
              ? logGuardLabel(locale, "compactComplete")
              : logGuardLabel(locale, "compactPartial");
            // stopReason is what distinguishes page_budget from no_progress from
            // busy, and pagesReclaimed is the unit the budget is actually spent
            // in. Reporting only bytes left a partial run indistinguishable from
            // any other partial run.
            const pages = postedReport.pagesReclaimed ?? 0;
            const reason = !postedReport.complete && postedReport.stopReason
              ? ` (${postedReport.stopReason})`
              : "";
            setLogGuardCompaction({
              generation,
              summary: [
                `${state}${reason}`,
                `${pages.toLocaleString(locale)} ${logGuardLabel(locale, "pagesUnit")}`,
                `${logical} / ${physical}`,
              ].join(" — "),
            });
          }
          // The mutation has already succeeded. Refresh is deliberately best effort so
          // a transient GET/JSON failure cannot be presented as a failed compaction.
          try {
            const refreshed = await fetch(`${API_BASE}/api/storage/codex-logs`);
            if (refreshed.ok) {
              const payload = await refreshed.json() as CodexLogGuardReport;
              setLogGuardOverride({ generation, report: payload });
            }
          } catch { /* keep the existing report after successful compaction */ }
          return;
        }
        const payload = await response.json() as CodexLogGuardReport;
        setLogGuardOverride({ generation, report: payload });
      } catch {
        setLogGuardError({ generation, message: logGuardOperationLabel(locale, "error.generic") });
      } finally {
        setInternalLogGuardBusy(false);
      }
    })();
  };

  return (
    <div className="storage-workspace-root">
      <aside className="storage-workspace-rail" aria-label={t("storage.section.buckets")}>
        <div className="storage-workspace-rail-header">
          <span className="storage-workspace-rail-title">{t("storage.section.buckets")}</span>
          <span className="storage-workspace-rail-count">{sortedBuckets.length}</span>
        </div>
        <div className="storage-workspace-rail-list">
          {sortedBuckets.length === 0 ? (
            <span className="storage-workspace-rail-empty">{t("storage.empty")}</span>
          ) : (
            sortedBuckets.map(bucket => (
              <button
                key={bucket.key}
                type="button"
                className={`storage-workspace-rail-row${selectedKey === bucket.key ? " storage-workspace-rail-row--selected" : ""}`}
                onClick={() => setSelectedKey(prev => (prev === bucket.key ? null : bucket.key))}
                aria-current={selectedKey === bucket.key ? "true" : undefined}
              >
                <span className="storage-workspace-rail-primary">
                  <span className="storage-workspace-rail-name">{bucketLabel(bucket, t)}</span>
                  <span className="storage-workspace-rail-size">{formatBytes(bucket.bytes, locale)}</span>
                </span>
                <span className="storage-workspace-rail-meta">
                  {bucket.fileCount.toLocaleString(locale)} {t("storage.col.files").toLowerCase()}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="storage-workspace-main" aria-label={selected ? bucketLabel(selected, t) : t("storage.section.largest")}>
        {selected ? (
          <div className="stw-detail">
            <div className="stw-detail-toolbar">
              <button type="button" className="stw-detail-back" onClick={() => setSelectedKey(null)}>
                <IconChevron className="stw-detail-back-chevron" aria-hidden="true" />
                {t("modal.back")}
              </button>
            </div>
            <div className="stw-detail-body">
              <h2 className="stw-detail-title">{bucketLabel(selected, t)}</h2>
              <dl className="stw-kv">
                <div className="stw-kv-row">
                  <dt>{t("storage.col.size")}</dt>
                  <dd className="stw-kv-mono">{formatBytes(selected.bytes, locale)}</dd>
                </div>
                <div className="stw-kv-row">
                  <dt>{t("storage.col.files")}</dt>
                  <dd className="stw-kv-mono">{selected.fileCount.toLocaleString(locale)}</dd>
                </div>
                <div className="stw-kv-row">
                  <dt>{t("storage.col.oldest")}</dt>
                  <dd>{formatDate(selected.oldest, locale)}</dd>
                </div>
                <div className="stw-kv-row">
                  <dt>{t("storage.col.newest")}</dt>
                  <dd>{formatDate(selected.newest, locale)}</dd>
                </div>
                <div className="stw-kv-row">
                  <dt>{t("storage.col.rows")}</dt>
                  <dd className="stw-kv-mono">{rowsDisplay(selected, locale, t)}</dd>
                </div>
              </dl>

              {(selected.largest?.length ?? 0) > 0 && (
                <div className="stw-section">
                  <h3 className="stw-section-title">{t("storage.section.largest")}</h3>
                  {selected.largest!.map(entry => (
                    <div key={entry.path} className="stw-file-row">
                      <span className="stw-file-path" title={entry.path}>{entry.path}</span>
                      <span className="stw-file-size">{formatBytes(entry.bytes, locale)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="stw-overview">
            <div className="stw-summary">
              <div className="stw-summary-card">
                <div className="stw-summary-label">{t("storage.card.total")}</div>
                <div className="stw-summary-value">{formatBytes(report.total.bytes, locale)}</div>
              </div>
              <div className="stw-summary-card">
                <div className="stw-summary-label">{t("storage.card.files")}</div>
                <div className="stw-summary-value">{report.total.fileCount.toLocaleString(locale)}</div>
              </div>
              <div className="stw-summary-card">
                <div className="stw-summary-label">{t("storage.card.home")}</div>
                <div className="stw-summary-value mono stw-home-path" title={report.codexHome}>{report.codexHome}</div>
              </div>
            </div>

            {displayedLogGuard ? (
              <CodexLogGuardPanel
                report={displayedLogGuard}
                locale={locale}
                t={t}
                busy={effectiveLogGuardBusy}
                error={displayedLogGuardError}
                compaction={displayedCompaction}
                onAction={runLogGuardAction}
              />
            ) : report.codexLogsError === "inspect_failed" ? (
              <CodexLogGuardUnavailablePanel locale={locale} t={t} />
            ) : null}

            {largestAcross.length > 0 ? (
              <div className="stw-section">
                <h3 className="stw-section-title">{t("storage.section.largest")}</h3>
                {largestAcross.map(entry => {
                  const owner = bucketByKey.get(entry.bucketKey);
                  return (
                    <div key={`${entry.bucketKey}:${entry.path}`} className="stw-file-row">
                      <span className="stw-file-path" title={entry.path}>{entry.path}</span>
                      {owner && <span className="stw-file-bucket">{bucketLabel(owner, t)}</span>}
                      <span className="stw-file-size">{formatBytes(entry.bytes, locale)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="stw-hint">
                <IconHardDrive style={{ width: 14, height: 14, verticalAlign: "text-bottom", marginRight: 6 }} aria-hidden="true" />
                {t("storage.workspace.selectBucket")}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
