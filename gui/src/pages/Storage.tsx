import { useCallback, useEffect, useRef, useState } from "react";
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

interface CleanupPreview {
  percent: number;
  count: number;
  bytes: number;
  digest: string;
  candidates: Array<{ relPath: string; bytes: number; physicalRelPaths?: string[] }>;
}

interface CleanupResult {
  ok: boolean;
  mode: "quarantine" | "permanent";
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

interface TrashEntry {
  id: string;
  epoch: string;
  fileCount: number;
  bytes: number;
  quarantinedAt?: number;
  mode?: "quarantine" | "permanent";
}

interface TrashList {
  entries: TrashEntry[];
}

interface RestoreResult {
  ok: boolean;
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

const GB = 1024 ** 3;

interface CleanupPolicy {
  enabled: boolean;
  trigger: { archivedBytesOver: number };
  target: { reduceToBytes?: number; removeOldestPercent?: number };
  schedule: "startup" | "daily" | "weekly" | "manual";
  mode: "quarantine" | "permanent";
  lastRun?: { at: number; freedBytes: number; removed: number };
  nextRun?: number;
  job?: {
    status: "idle" | "running";
    reason?: string;
    startedAt?: number;
    finishedAt?: number;
    lastError?: string;
    lastOutcome?: {
      ok: boolean;
      skipped?: string;
      deferred?: string;
      error?: string;
      mode?: string;
      freedBytes?: number;
      removed?: number;
    };
  };
}

const BUCKET_TKEYS: Record<string, TKey> = {
  sessions: "storage.bucket.sessions",
  archived_sessions: "storage.bucket.archived_sessions",
  logs_db: "storage.bucket.logs_db",
  state_db: "storage.bucket.state_db",
  attachments: "storage.bucket.attachments",
  deletion_manifests: "storage.bucket.deletion_manifests",
  other: "storage.bucket.other",
};

const PRESETS = [10, 25, 50] as const;

const localizedCatch = (e: unknown, fallback: string): string => {
  if (!(e instanceof Error)) return fallback;
  const msg = e.message;
  if (
    msg === "Failed to fetch"
    || msg.includes("NetworkError")
    || msg.includes("network error")
    || msg.includes("JSON")
    || msg.includes("Unexpected end of")
  ) {
    return fallback;
  }
  return msg || fallback;
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

function ArchivedCleanupPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const [percent, setPercent] = useState(25);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  const closeConfirm = useCallback((clearPreview = false) => {
    setConfirmOpen(false);
    setPermanent(false);
    if (clearPreview) setPreview(null);
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!confirmOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmOpen, closeConfirm]);

  const mapCleanupError = (code: string | undefined, fallback?: string, trashDir?: string) => {
    switch (code) {
      case "codex_busy": return t("storage.cleanup.err.codex_busy");
      case "stale_preview": return t("storage.cleanup.err.stale_preview");
      case "restore_pending_overlap": return t("storage.cleanup.err.restore_pending_overlap");
      case "referenced_history": return t("storage.cleanup.err.referenced_history");
      case "invalid_digest": return t("storage.cleanup.err.invalid_digest");
      case "invalid_mode": return t("storage.cleanup.err.invalid_mode");
      case "fs_failed":
        return trashDir
          ? t("storage.cleanup.err.fs_failed_trash", { trashDir })
          : t("storage.cleanup.err.fs_failed");
      case "db_reconcile_failed": return t("storage.cleanup.err.db_reconcile_failed");
      case "cleanup_failed": return t("storage.cleanup.err.cleanup_failed");
      default: return fallback ?? t("storage.cleanup.cleanupFailed");
    }
  };

  const formatPreset = (value: number) =>
    t("storage.cleanup.preset", {
      percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value / 100),
    });

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent }),
      });
      const json = await res.json() as CleanupPreview & { error?: string };
      if (!res.ok) throw new Error(mapCleanupError(json.error, t("storage.cleanup.previewFailed")));
      setPreview(json);
      setConfirmOpen(true);
    } catch (e) {
      setError(localizedCatch(e, t("storage.cleanup.previewFailed")));
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: preview.percent,
          mode: permanent ? "permanent" : "quarantine",
          digest: preview.digest,
        }),
      });
      const json = await res.json() as CleanupResult;
      if (!res.ok || !json.ok) {
        if (json.error === "stale_preview") {
          // Digest can never succeed again — send the user back to Preview.
          closeConfirm(true);
        }
        throw new Error(mapCleanupError(json.error, json.message, json.trashDir));
      }
      closeConfirm(true);
      setStatus(
        permanent
          ? t("storage.cleanup.donePermanent", { count: String(json.count), size: formatBytes(json.bytes, locale) })
          : t("storage.cleanup.doneQuarantine", { count: String(json.count), size: formatBytes(json.bytes, locale) }),
      );
      onDone();
    } catch (e) {
      // Keep the dialog open (except stale_preview) so the failure is visible.
      setError(localizedCatch(e, t("storage.cleanup.cleanupFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-cleanup-title">
      <h3 id="storage-cleanup-title" className="panel-title">{t("storage.cleanup.title")}</h3>
      <p className="muted" style={{ marginTop: 4 }}>{t("storage.cleanup.help")}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 220px" }}>
          <span className="muted">{t("storage.cleanup.percent", { percent: String(percent) })}</span>
          <input
            type="range"
            min={1}
            max={100}
            value={percent}
            onChange={e => setPercent(Number(e.target.value))}
            disabled={busy}
            style={{ flex: 1 }}
            aria-label={t("storage.cleanup.slider")}
          />
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          {PRESETS.map(p => (
            <button
              key={p}
              type="button"
              className={`btn btn-ghost btn-sm${percent === p ? " active" : ""}`}
              disabled={busy}
              onClick={() => setPercent(p)}
            >
              {formatPreset(p)}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runPreview()}>
          {t("storage.cleanup.preview")}
        </button>
      </div>

      {status && <p className="muted" style={{ marginTop: 12 }}>{status}</p>}
      {error && !confirmOpen && <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p>}

      {confirmOpen && preview && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="storage-cleanup-confirm-title"
          onClick={() => !busy && closeConfirm()}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3 id="storage-cleanup-confirm-title">{t("storage.cleanup.confirmTitle")}</h3>
            <p>
              {t("storage.cleanup.confirmBody", {
                count: String(preview.count),
                size: formatBytes(preview.bytes, locale),
                percent: String(preview.percent),
              })}
            </p>
            {preview.candidates.length > 0 && (
              <ul className="mono muted" style={{ maxHeight: 160, overflow: "auto", fontSize: "var(--text-caption)" }}>
                {preview.candidates.slice(0, 8).map(c => (
                  <li key={c.relPath}>{c.relPath}</li>
                ))}
                {preview.count > 8 && (
                  <li>{t("storage.cleanup.moreFiles", { n: String(Math.max(0, preview.count - 8)) })}</li>
                )}
              </ul>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <input
                type="checkbox"
                checked={permanent}
                disabled={busy}
                onChange={e => setPermanent(e.target.checked)}
              />
              <span>{t("storage.cleanup.permanent")}</span>
            </label>
            <p className="muted" style={{ marginTop: 8, fontSize: "var(--text-caption)" }}>
              {permanent ? t("storage.cleanup.permanentWarn") : t("storage.cleanup.quarantineNote")}
            </p>
            {error && <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p>}
            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => closeConfirm()}
              >
                {t("storage.cleanup.cancel")}
              </button>
              <button
                type="button"
                className={permanent ? "btn btn-danger" : "btn"}
                disabled={busy || preview.count === 0}
                onClick={() => void runCleanup()}
              >
                {permanent ? t("storage.cleanup.confirmPermanent") : t("storage.cleanup.confirmQuarantine")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function QuarantineTrashPanel({
  apiBase,
  locale,
  t,
  onDone,
  reloadToken,
  onEntriesChange,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
  reloadToken: number;
  onEntriesChange?: (entries: TrashEntry[]) => void;
}) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmEntry, setConfirmEntry] = useState<TrashEntry | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const closeConfirm = useCallback(() => setConfirmEntry(null), []);

  useEffect(() => {
    if (!confirmEntry) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmEntry, closeConfirm]);

  const loadTrash = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/storage/trash`, { signal });
      const json = await res.json() as TrashList & { error?: string };
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      if (!res.ok) throw new Error(json.error ?? "list_failed");
      const next = Array.isArray(json.entries) ? json.entries : [];
      setEntries(next);
      onEntriesChange?.(next);
      setError(null);
    } catch (e) {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setEntries([]);
      onEntriesChange?.([]);
      setError(localizedCatch(e, t("storage.trash.listFailed")));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase, t, onEntriesChange]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadTrash(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [loadTrash, reloadToken]);

  const mapRestoreError = (code: string | undefined, fallback?: string) => {
    switch (code) {
      case "codex_busy": return t("storage.trash.err.codex_busy");
      case "invalid_trash": return t("storage.trash.err.invalid_trash");
      case "missing_trash": return t("storage.trash.err.missing_trash");
      case "dest_exists": return t("storage.trash.err.dest_exists");
      case "fs_failed": return t("storage.trash.err.fs_failed");
      case "db_reconcile_failed": return t("storage.trash.err.db_reconcile_failed");
      case "storage_mutation_busy": return t("storage.trash.err.storage_mutation_busy");
      case "restore_failed": return t("storage.trash.err.restore_failed");
      case "restore_worker_timeout": return t("storage.trash.err.restore_worker_timeout");
      case "restore_worker_aborted": return t("storage.trash.err.restore_worker_aborted");
      case "restore_worker_failed":
        return fallback ?? t("storage.trash.err.restore_worker_failed");
      default: return fallback ?? t("storage.trash.restoreFailed");
    }
  };

  const runRestore = async () => {
    if (!confirmEntry) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/trash/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: confirmEntry.id }),
      });
      const json = await res.json() as RestoreResult;
      if (!res.ok || !json.ok) {
        throw new Error(mapRestoreError(json.error, json.message));
      }
      closeConfirm();
      setStatus(t("storage.trash.done", {
        count: String(json.count),
        size: formatBytes(json.bytes, locale),
      }));
      onDone();
    } catch (e) {
      setError(localizedCatch(e, t("storage.trash.restoreFailed")));
    } finally {
      setBusy(false);
    }
  };

  const formatWhen = (entry: TrashEntry) => {
    const ms = entry.quarantinedAt ?? Number(entry.epoch.split("-")[0]);
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    return new Date(ms).toLocaleString(locale);
  };

  const modeLabel = (mode: TrashEntry["mode"]) => {
    if (mode === "permanent") return t("storage.trash.mode.permanent");
    if (mode === "quarantine") return t("storage.trash.mode.quarantine");
    return "—";
  };

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-trash-title">
      <h3 id="storage-trash-title" className="panel-title">{t("storage.trash.title")}</h3>
      <p className="muted" style={{ marginTop: 4 }}>{t("storage.trash.help")}</p>

      {status && <p className="muted" style={{ marginTop: 12 }}>{status}</p>}
      {error && !confirmEntry && <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p>}

      {loading ? (
        <p className="muted" style={{ marginTop: 12 }}>{t("storage.trash.loading")}</p>
      ) : entries.length === 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>{t("storage.trash.empty")}</p>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("storage.trash.col.when")}</th>
                <th className="num">{t("storage.trash.col.files")}</th>
                <th className="num">{t("storage.trash.col.size")}</th>
                <th>{t("storage.trash.col.mode")}</th>
                <th>{t("storage.trash.col.id")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td className="muted">{formatWhen(entry)}</td>
                  <td className="num">{entry.fileCount}</td>
                  <td className="num mono">{formatBytes(entry.bytes, locale)}</td>
                  <td className="muted">{modeLabel(entry.mode)}</td>
                  <td className="mono" style={{ fontSize: "var(--text-caption)" }}>{entry.id}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setConfirmEntry(entry);
                      }}
                    >
                      {t("storage.trash.restore")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmEntry && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="storage-trash-confirm-title"
          onClick={() => !busy && closeConfirm()}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3 id="storage-trash-confirm-title">{t("storage.trash.confirmTitle")}</h3>
            <p>
              {t("storage.trash.confirmBody", {
                count: String(confirmEntry.fileCount),
                size: formatBytes(confirmEntry.bytes, locale),
                id: confirmEntry.id,
              })}
            </p>
            {error && <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p>}
            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => closeConfirm()}
              >
                {t("storage.trash.cancel")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void runRestore()}
              >
                {t("storage.trash.confirmRestore")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function policyFieldsFromResponse(json: CleanupPolicy): CleanupPolicy {
  const { job, ...policy } = json;
  void job;
  return policy;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

function AutoCleanupPolicyPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const [policy, setPolicy] = useState<CleanupPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<"percent" | "reduce">("percent");
  const [percent, setPercent] = useState(25);
  /** Draft string so blank/invalid reduce targets are rejected instead of coerced to 0. */
  const [reduceGb, setReduceGb] = useState("4");
  /** Draft string so a cleared threshold is rejected instead of coerced to 0. */
  const [thresholdGb, setThresholdGb] = useState("5");
  /** Cancels in-flight Run-now polling when the panel unmounts. */
  const runAbortRef = useRef<AbortController | null>(null);

  const loadPolicy = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, { signal });
      if (!res.ok) throw new Error("load_failed");
      const json = await res.json() as CleanupPolicy;
      if (signal?.aborted) return;
      setPolicy(policyFieldsFromResponse(json));
      setThresholdGb(String(Math.max(0, Math.round((json.trigger.archivedBytesOver / GB) * 100) / 100)));
      if (json.target.reduceToBytes !== undefined) {
        setTargetMode("reduce");
        setReduceGb(String(Math.max(0, Math.round((json.target.reduceToBytes / GB) * 100) / 100)));
      } else {
        setTargetMode("percent");
        setPercent(Math.min(100, Math.max(1, Math.floor(json.target.removeOldestPercent ?? 25))));
      }
    } catch {
      if (signal?.aborted) return;
      setPolicy(null);
      setError(t("storage.policy.loadFailed"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadPolicy(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [loadPolicy]);

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
      runAbortRef.current = null;
    };
  }, []);

  const buildBody = (): CleanupPolicy | null => {
    if (!policy) return null;
    const thresholdRaw = thresholdGb.trim();
    if (thresholdRaw === "") return null;
    const threshold = Number(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 0) return null;

    let target: CleanupPolicy["target"];
    if (targetMode === "reduce") {
      const raw = reduceGb.trim();
      if (raw === "") return null;
      const reduce = Number(raw);
      if (!Number.isFinite(reduce) || reduce < 0) return null;
      target = { reduceToBytes: Math.floor(reduce * GB) };
    } else {
      const pct = Number(percent);
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return null;
      target = { removeOldestPercent: Math.min(100, Math.max(1, Math.floor(pct))) };
    }

    return {
      enabled: policy.enabled,
      trigger: { archivedBytesOver: Math.floor(threshold * GB) },
      target,
      schedule: policy.schedule,
      mode: policy.mode,
    };
  };

  const savePolicy = async (patch?: Partial<CleanupPolicy>) => {
    const base = buildBody();
    if (!base) {
      setError(t("storage.policy.invalid"));
      return;
    }
    const body = { ...base, ...patch };
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { ok?: boolean; policy?: CleanupPolicy; error?: string };
      if (!res.ok || !json.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      setPolicy(policyFieldsFromResponse(json.policy));
      setStatus(t("storage.policy.saved"));
    } catch {
      setError(t("storage.policy.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const { signal } = controller;

    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      const base = buildBody();
      if (!base) {
        setError(t("storage.policy.invalid"));
        return;
      }
      const saveRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base),
        signal,
      });
      const saved = await saveRes.json() as { policy?: CleanupPolicy; error?: string };
      if (signal.aborted) return;
      if (!saveRes.ok || !saved.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      setPolicy(policyFieldsFromResponse(saved.policy));

      const res = await fetch(`${apiBase}/api/storage/cleanup-policy/run`, {
        method: "POST",
        signal,
      });
      const startJson = await res.json() as {
        ok?: boolean;
        started?: boolean;
        error?: string;
        job?: CleanupPolicy["job"];
        policy?: CleanupPolicy;
      };
      if (signal.aborted) return;
      if (startJson.policy) setPolicy(policyFieldsFromResponse(startJson.policy));
      if (startJson.error === "already_running" || res.status === 409) {
        setError(t("storage.policy.alreadyRunning"));
        return;
      }
      if (!res.ok) {
        setError(t("storage.policy.runFailed"));
        return;
      }
      if (!startJson.started || !startJson.job?.startedAt) {
        setError(t("storage.policy.runFailed"));
        return;
      }

      const startedAt = startJson.job.startedAt;
      const deadline = Date.now() + 120_000;
      let outcome: NonNullable<CleanupPolicy["job"]>["lastOutcome"] | undefined;
      let finalPolicy: CleanupPolicy | undefined;

      while (Date.now() < deadline) {
        if (signal.aborted) return;
        await sleep(250);
        if (signal.aborted) return;
        const pollRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, { signal });
        if (signal.aborted) return;
        if (!pollRes.ok) continue;
        const body = await pollRes.json() as CleanupPolicy;
        if (signal.aborted) return;
        finalPolicy = policyFieldsFromResponse(body);
        setPolicy(finalPolicy);
        const job = body.job;
        if (!job) continue;
        if (job.status === "running") continue;
        if (job.startedAt === startedAt && job.lastOutcome) {
          outcome = job.lastOutcome;
          break;
        }
        if (job.finishedAt && job.finishedAt >= startedAt && job.lastOutcome) {
          outcome = job.lastOutcome;
          break;
        }
      }

      if (signal.aborted) return;
      if (finalPolicy) setPolicy(finalPolicy);
      if (!outcome) {
        setError(t("storage.policy.runFailed"));
        return;
      }

      if (outcome.skipped === "disabled") {
        setStatus(t("storage.policy.skippedDisabled"));
      } else if (outcome.skipped === "under_threshold") {
        setStatus(t("storage.policy.skippedUnder"));
      } else if (outcome.skipped === "nothing_selected") {
        setStatus(t("storage.policy.skippedEmpty"));
      } else if (outcome.deferred === "codex_busy" || outcome.error === "codex_busy") {
        setError(t("storage.cleanup.err.codex_busy"));
      } else if (!outcome.ok) {
        setError(t("storage.policy.runFailed"));
      } else {
        setStatus(
          outcome.mode === "permanent"
            ? t("storage.policy.donePermanent", {
              count: String(outcome.removed ?? 0),
              size: formatBytes(outcome.freedBytes ?? 0, locale),
            })
            : t("storage.policy.doneQuarantine", {
              count: String(outcome.removed ?? 0),
              size: formatBytes(outcome.freedBytes ?? 0, locale),
            }),
        );
        onDone();
      }
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      setError(t("storage.policy.runFailed"));
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      if (!signal.aborted) setRunning(false);
    }
  };

  const formatWhen = (ms: number | undefined) =>
    ms === undefined ? t("storage.policy.never") : new Date(ms).toLocaleString(locale);

  if (loading && !policy) {
    return (
      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-policy-title">
        <h3 id="storage-policy-title" className="panel-title">{t("storage.policy.title")}</h3>
        <p className="muted">{t("storage.policy.loading")}</p>
      </section>
    );
  }

  if (!policy) {
    return (
      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-policy-title">
        <h3 id="storage-policy-title" className="panel-title">{t("storage.policy.title")}</h3>
        {error && <p className="err" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-policy-title">
      <h3 id="storage-policy-title" className="panel-title">{t("storage.policy.title")}</h3>
      <p className="muted" style={{ marginTop: 4 }}>{t("storage.policy.help")}</p>

      <label className="row" style={{ marginTop: 12, gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={policy.enabled}
          disabled={saving || running}
          onChange={e => {
            const enabled = e.target.checked;
            void savePolicy({ enabled });
          }}
        />
        <span>{t("storage.policy.enabled")}</span>
      </label>
      <p className="muted" style={{ marginTop: 4, fontSize: "var(--text-sm)" }}>{t("storage.policy.enabledHint")}</p>

      <div style={{ display: "grid", gap: 12, marginTop: 16, maxWidth: 420 }}>
        <label>
          <span className="muted">{t("storage.policy.threshold")}</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={thresholdGb}
            disabled={saving || running}
            onChange={e => setThresholdGb(e.target.value)}
            onBlur={() => void savePolicy()}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          />
        </label>

        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="muted">{t("storage.policy.target")}</legend>
          <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 4 }}>
            <input
              type="radio"
              name="storage-policy-target"
              checked={targetMode === "percent"}
              disabled={saving || running}
              onChange={() => setTargetMode("percent")}
            />
            <span>{t("storage.policy.targetPercent")}</span>
          </label>
          {targetMode === "percent" && (
            <input
              type="number"
              min={1}
              max={100}
              value={percent}
              disabled={saving || running}
              onChange={e => setPercent(Number(e.target.value))}
              onBlur={() => void savePolicy()}
              style={{ display: "block", marginTop: 4, width: "100%" }}
            />
          )}
          <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
            <input
              type="radio"
              name="storage-policy-target"
              checked={targetMode === "reduce"}
              disabled={saving || running}
              onChange={() => setTargetMode("reduce")}
            />
            <span>{t("storage.policy.targetReduce")}</span>
          </label>
          {targetMode === "reduce" && (
            <input
              type="number"
              min={0}
              step={0.1}
              value={reduceGb}
              disabled={saving || running}
              onChange={e => setReduceGb(e.target.value)}
              onBlur={() => void savePolicy()}
              style={{ display: "block", marginTop: 4, width: "100%" }}
            />
          )}
        </fieldset>

        <label>
          <span className="muted">{t("storage.policy.schedule")}</span>
          <select
            value={policy.schedule}
            disabled={saving || running}
            onChange={e => {
              const schedule = e.target.value as CleanupPolicy["schedule"];
              void savePolicy({ schedule });
            }}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          >
            <option value="manual">{t("storage.policy.schedule.manual")}</option>
            <option value="startup">{t("storage.policy.schedule.startup")}</option>
            <option value="daily">{t("storage.policy.schedule.daily")}</option>
            <option value="weekly">{t("storage.policy.schedule.weekly")}</option>
          </select>
        </label>

        <label>
          <span className="muted">{t("storage.policy.mode")}</span>
          <select
            value={policy.mode}
            disabled={saving || running}
            onChange={e => {
              const mode = e.target.value as CleanupPolicy["mode"];
              void savePolicy({ mode });
            }}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          >
            <option value="quarantine">{t("storage.policy.mode.quarantine")}</option>
            <option value="permanent">{t("storage.policy.mode.permanent")}</option>
          </select>
        </label>
        {policy.mode === "permanent" && (
          <p className="err" role="status">{t("storage.policy.permanentWarn")}</p>
        )}
      </div>

      <div className="usage-cards" style={{ marginTop: 16 }}>
        <div className="stat">
          <div className="muted">{t("storage.policy.lastRun")}</div>
          <div className="stat-value" style={{ fontSize: "var(--text-body)" }}>{formatWhen(policy.lastRun?.at)}</div>
          {policy.lastRun && (
            <div className="muted" style={{ marginTop: 4 }}>
              {t("storage.policy.lastRunDetail", {
                count: String(policy.lastRun.removed),
                size: formatBytes(policy.lastRun.freedBytes, locale),
              })}
            </div>
          )}
        </div>
        <div className="stat">
          <div className="muted">{t("storage.policy.nextRun")}</div>
          <div className="stat-value" style={{ fontSize: "var(--text-body)" }}>{formatWhen(policy.nextRun)}</div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving || running} onClick={() => void savePolicy()}>
          {t("storage.policy.save")}
        </button>
        <button type="button" className="btn btn-sm" disabled={saving || running || !policy.enabled} onClick={() => void runNow()}>
          {running ? t("storage.policy.running") : t("storage.policy.runNow")}
        </button>
      </div>
      {status && <p className="muted" style={{ marginTop: 8 }} role="status">{status}</p>}
      {error && <p className="err" style={{ marginTop: 8 }} role="alert">{error}</p>}
    </section>
  );
}

export default function Storage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [trashReloadToken, setTrashReloadToken] = useState(0);
  // Stamp trash awareness with apiBase so a base change invalidates without an effect.
  const [trashInfo, setTrashInfo] = useState({ apiBase, settled: false, hasEntries: false });
  const loadGenerationRef = useRef(0);

  const fetchStorage = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/storage`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const json = await res.json() as StorageReport;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(json);
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(null);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetchStorage(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchStorage]);

  const refreshAll = useCallback(() => {
    void fetchStorage();
    setTrashReloadToken(n => n + 1);
  }, [fetchStorage]);

  const onTrashEntriesChange = useCallback((entries: TrashEntry[]) => {
    setTrashInfo({ apiBase, settled: true, hasEntries: entries.length > 0 });
  }, [apiBase]);

  const trashSettled = trashInfo.apiBase === apiBase && trashInfo.settled;
  const trashHasEntries = trashInfo.apiBase === apiBase && trashInfo.hasEntries;
  const failed = !loading && (!data || data.error !== undefined);
  const empty = !loading && !failed && data!.total.fileCount === 0 && trashSettled && !trashHasEntries;
  const archivedCount = data?.buckets.find(b => b.key === "archived_sessions")?.fileCount ?? 0;
  const showBody = Boolean(data) && !failed;
  // While storage is empty, keep the trash panel mounted until it reports so we
  // do not flash the empty state over a non-empty quarantine.
  const showTrashWhileSettling = showBody && (data!.total.fileCount > 0 || !trashSettled || trashHasEntries);

  return (
    <>
      <div className="page-head">
        <h2 id="storage-page-title">{t("storage.title")}</h2>
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => refreshAll()}>
          <IconRefresh /> {t("storage.refresh")}
        </button>
      </div>
      <p className="page-sub">{t("storage.subtitle")}</p>

      {loading && !data ? (
        <EmptyState title={t("storage.loading")} />
      ) : failed ? (
        <EmptyState title={t("storage.error")} />
      ) : empty ? (
        <>
          <EmptyState title={t("storage.empty")} />
          <AutoCleanupPolicyPanel
            apiBase={apiBase}
            locale={locale}
            t={t}
            onDone={() => refreshAll()}
          />
        </>
      ) : (
        <>
          {data && data.total.fileCount > 0 && (
            <>
              <div className="usage-cards">
                <div className="stat"><div className="muted">{t("storage.card.total")}</div><div className="stat-value">{formatBytes(data.total.bytes, locale)}</div></div>
                <div className="stat"><div className="muted">{t("storage.card.files")}</div><div className="stat-value">{data.total.fileCount.toLocaleString(locale)}</div></div>
                <div className="stat"><div className="muted">{t("storage.card.home")}</div><div className="stat-value mono" style={{ fontSize: "var(--text-body)", wordBreak: "break-all" }}>{data.codexHome}</div></div>
              </div>
              <BucketsTable buckets={data.buckets} locale={locale} t={t} />
              <LargestFilesPanel buckets={data.buckets} locale={locale} t={t} />
            </>
          )}
          <AutoCleanupPolicyPanel
            apiBase={apiBase}
            locale={locale}
            t={t}
            onDone={() => refreshAll()}
          />
          {archivedCount > 0 && (
            <ArchivedCleanupPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              onDone={() => refreshAll()}
            />
          )}
          {showTrashWhileSettling && (
            <QuarantineTrashPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              reloadToken={trashReloadToken}
              onEntriesChange={onTrashEntriesChange}
              onDone={() => refreshAll()}
            />
          )}
        </>
      )}
    </>
  );
}
