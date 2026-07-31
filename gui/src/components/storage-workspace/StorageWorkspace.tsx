/**
 * StorageWorkspace — rail + main workspace for the Storage tab, mirroring the
 * Providers workspace DNA. Left rail lists buckets sorted by size; the main pane
 * shows either the overview (totals + largest files across buckets) or a
 * per-bucket detail view.
 */
/* eslint-disable react-refresh/only-export-components -- bucket label helper co-locates with the rail rows */
import { useMemo, useState } from "react";
import { IconChevron, IconHardDrive } from "../../icons";
import { useT, type TFn, type TKey, type Locale } from "../../i18n/shared";
import { formatBytes } from "../../format-bytes";

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

export interface StorageReport {
  codexHome: string;
  generatedAt: number;
  total: { bytes: number; fileCount: number };
  buckets: StorageBucket[];
  error?: string;
}

// Known scanner bucket keys → localized labels; unknown future keys fall back to the API label.
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

export interface StorageWorkspaceProps {
  report: StorageReport;
  locale: Locale;
}

export default function StorageWorkspace({ report, locale }: StorageWorkspaceProps) {
  const t = useT();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const sortedBuckets = useMemo(
    () => report.buckets.toSorted((a, b) => b.bytes - a.bytes),
    [report.buckets],
  );
  const selected = sortedBuckets.find(b => b.key === selectedKey) ?? null;

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
            <div className="usage-cards">
              <div className="stat">
                <div className="muted">{t("storage.card.total")}</div>
                <div className="stat-value">{formatBytes(report.total.bytes, locale)}</div>
              </div>
              <div className="stat">
                <div className="muted">{t("storage.card.files")}</div>
                <div className="stat-value">{report.total.fileCount.toLocaleString(locale)}</div>
              </div>
              <div className="stat">
                <div className="muted">{t("storage.card.home")}</div>
                <div className="stat-value mono stw-home-path" title={report.codexHome}>{report.codexHome}</div>
              </div>
            </div>

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
