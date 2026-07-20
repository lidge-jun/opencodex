import { useCallback, useEffect, useState } from "react";
import { useI18n, type TFn, type TKey, type Locale } from "../i18n/shared";
import { EmptyState } from "../ui";
import { IconRefresh } from "../icons";
import { formatBytes } from "../format-bytes";

interface StorageLargestEntry {
  path: string;
  bytes: number;
}

interface StorageBucket {
  key: string;
  label: string;
  bytes: number;
  fileCount: number;
  oldest?: number;
  newest?: number;
  largest?: StorageLargestEntry[];
  rows?: number | null;
}

interface StorageReport {
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

function bucketLabel(bucket: StorageBucket, t: TFn): string {
  const tkey = BUCKET_TKEYS[bucket.key];
  return tkey ? t(tkey) : bucket.label;
}

function formatDate(ms: number | undefined, locale: Locale): string {
  return ms === undefined ? "—" : new Date(ms).toLocaleDateString(locale);
}

function BucketsTable({ buckets, locale, t }: { buckets: StorageBucket[]; locale: Locale; t: TFn }) {
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-buckets-title">
      <h3 id="storage-buckets-title" className="panel-title">{t("storage.section.buckets")}</h3>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("storage.col.bucket")}</th>
              <th className="num">{t("storage.col.size")}</th>
              <th className="num">{t("storage.col.files")}</th>
              <th>{t("storage.col.oldest")}</th>
              <th>{t("storage.col.newest")}</th>
              <th className="num">{t("storage.col.rows")}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map(bucket => (
              <tr key={bucket.key}>
                <td>{bucketLabel(bucket, t)}</td>
                <td className="num mono">{formatBytes(bucket.bytes, locale)}</td>
                <td className="num">{bucket.fileCount}</td>
                <td className="muted">{formatDate(bucket.oldest, locale)}</td>
                <td className="muted">{formatDate(bucket.newest, locale)}</td>
                <td className="num mono">
                  {bucket.rows === undefined ? "—" : bucket.rows === null ? t("storage.rows.unknown") : bucket.rows.toLocaleString(locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LargestFilesPanel({ buckets, locale, t }: { buckets: StorageBucket[]; locale: Locale; t: TFn }) {
  const withLargest = buckets.filter(bucket => (bucket.largest?.length ?? 0) > 0);
  if (withLargest.length === 0) return null;
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-largest-title">
      <h3 id="storage-largest-title" className="panel-title">{t("storage.section.largest")}</h3>
      {withLargest.map(bucket => (
        <details key={bucket.key} style={{ marginTop: 8 }}>
          <summary>{bucketLabel(bucket, t)}</summary>
          <div className="tbl-wrap" style={{ marginTop: 8 }}>
            <table className="tbl">
              <tbody>
                {bucket.largest!.map(entry => (
                  <tr key={entry.path}>
                    <td className="mono">{entry.path}</td>
                    <td className="num mono">{formatBytes(entry.bytes, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </section>
  );
}

export default function Storage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStorage = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/storage`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const json = await res.json() as StorageReport;
      if (signal?.aborted) return;
      setData(json);
    } catch {
      if (signal?.aborted) return;
      setData(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred a tick (same pattern as Usage.tsx) so the effect never sets state synchronously.
    const timeout = window.setTimeout(() => {
      void fetchStorage(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [fetchStorage]);

  const failed = !loading && (!data || data.error !== undefined);
  const empty = !loading && !failed && data!.total.fileCount === 0;

  return (
    <>
      <div className="page-head">
        <h2 id="storage-page-title">{t("storage.title")}</h2>
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void fetchStorage()}>
          <IconRefresh /> {t("storage.refresh")}
        </button>
      </div>
      <p className="page-sub">{t("storage.subtitle")}</p>

      {loading && !data ? (
        <EmptyState title={t("storage.loading")} />
      ) : failed ? (
        <EmptyState title={t("storage.error")} />
      ) : empty ? (
        <EmptyState title={t("storage.empty")} />
      ) : (
        <>
          <div className="usage-cards">
            <div className="stat"><div className="muted">{t("storage.card.total")}</div><div className="stat-value">{formatBytes(data!.total.bytes, locale)}</div></div>
            <div className="stat"><div className="muted">{t("storage.card.files")}</div><div className="stat-value">{data!.total.fileCount.toLocaleString(locale)}</div></div>
            <div className="stat"><div className="muted">{t("storage.card.home")}</div><div className="stat-value mono" style={{ fontSize: "var(--text-body)", wordBreak: "break-all" }}>{data!.codexHome}</div></div>
          </div>
          <BucketsTable buckets={data!.buckets} locale={locale} t={t} />
          <LargestFilesPanel buckets={data!.buckets} locale={locale} t={t} />
        </>
      )}
    </>
  );
}
