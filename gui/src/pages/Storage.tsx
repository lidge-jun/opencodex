import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n, type TFn, type Locale } from "../i18n/shared";
import { EmptyState } from "../ui";
import { IconRefresh } from "../icons";
import { formatBytes } from "../format-bytes";
import { NumberStepper } from "../components/NumberStepper";
import { clampNumberDraft } from "../clamp-draft";
import StorageWorkspace, {
  type StorageReport,
} from "../components/storage-workspace/StorageWorkspace";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";


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
    const onKey = (e: WindowEventMap["keydown"]) => {
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
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(mapCleanupError(json.error, t("storage.cleanup.previewFailed")));
      }
      const json = await res.json() as CleanupPreview;
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
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as CleanupResult;
        if (json.error === "stale_preview") {
          // Digest can never succeed again — send the user back to Preview.
          closeConfirm(true);
        }
        throw new Error(mapCleanupError(json.error, json.message, json.trashDir));
      }
      const json = await res.json() as CleanupResult;
      if (!json.ok) {
        if (json.error === "stale_preview") {
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
    <section className="storage-cleanup-pane">
      <p className="muted storage-manual-panel__help">{t("storage.cleanup.help")}</p>

      <div className="storage-manual-panel__controls">
        <label className="storage-manual-panel__slider">
          <span className="muted mono" style={{ minWidth: "3.5rem", fontVariantNumeric: "tabular-nums" }}>
            {t("storage.cleanup.percent", { percent: String(percent) })}
          </span>
          <input
            type="range"
            min={1}
            max={100}
            value={percent}
            onChange={e => setPercent(Number(e.target.value))}
            disabled={busy}
            style={{ flex: 1, minWidth: 0 }}
            aria-label={t("storage.cleanup.slider")}
          />
        </label>
        <div className="storage-manual-panel__presets">
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

      {status && <p className="muted storage-manual-panel__status">{status}</p>}
      {error && !confirmOpen && <p className="storage-manual-panel__status" style={{ color: "var(--red)" }}>{error}</p>}

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
  const [busy, setBusy] = useState(false);
  const [confirmEntry, setConfirmEntry] = useState<TrashEntry | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const closeConfirm = useCallback(() => setConfirmEntry(null), []);

  useEffect(() => {
    if (!confirmEntry) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: WindowEventMap["keydown"]) => {
      if (e.key === "Escape" && !busyRef.current) closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmEntry, closeConfirm]);

  const loadTrash = useCallback(async (signal: AbortSignal): Promise<TrashEntry[]> => {
    const res = await fetch(`${apiBase}/api/storage/trash`, { signal });
    if (!res.ok) throw new Error(t("storage.trash.listFailed"));
    const json = await res.json() as TrashList;
    const next = Array.isArray(json.entries) ? json.entries : [];
    onEntriesChange?.(next);
    return next;
  }, [apiBase, onEntriesChange, t]);
  const trashResource = useDataSurface<TrashEntry[]>(
    `storage-trash:${apiBase}`,
    [apiBase, reloadToken],
    loadTrash,
    { isEmpty: entries => entries.length === 0 },
  );
  const trashState = trashResource.state;
  const entries = trashState.data ?? [];

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
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as RestoreResult;
        throw new Error(mapRestoreError(json.error, json.message));
      }
      const json = await res.json() as RestoreResult;
      if (!json.ok) {
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
    <section className="storage-cleanup-pane storage-quarantine-pane">
      <p className="muted storage-manual-panel__help">{t("storage.trash.help")}</p>

      {status && <p className="muted storage-manual-panel__status">{status}</p>}
      {error && !confirmEntry && <p className="storage-manual-panel__status" style={{ color: "var(--red)" }} role="alert">{error}</p>}
      {trashState.showError && !confirmEntry && (
        <p className="storage-manual-panel__status" style={{ color: "var(--red)" }} role="alert">
          {trashState.error instanceof Error ? trashState.error.message : t("storage.trash.listFailed")}
        </p>
      )}
      {trashState.refreshing && !trashState.showSkeleton && (
        <DataSurfaceStatus live={!trashState.showError}>{t("storage.trash.loading")}</DataSurfaceStatus>
      )}

      {trashState.showSkeleton ? (
        <DataSurfaceSkeleton label={t("storage.trash.loading")} rows={2} />
      ) : entries.length === 0 ? (
        <p className="muted storage-manual-panel__status">{t("storage.trash.empty")}</p>
      ) : (
        <div className="tbl-wrap storage-manual-panel__table">
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

type CachedCleanupPolicy = {
  policy: CleanupPolicy;
  thresholdGb: string;
  targetMode: "percent" | "reduce";
  percent: string;
  reduceGb: string;
};

function draftsFromPolicyResponse(json: CleanupPolicy): Omit<CachedCleanupPolicy, "policy"> & { policy: CleanupPolicy } {
  const thresholdGb = String(Math.max(0, Math.round((json.trigger.archivedBytesOver / GB) * 100) / 100));
  if (json.target.reduceToBytes !== undefined) {
    return {
      policy: policyFieldsFromResponse(json),
      thresholdGb,
      targetMode: "reduce",
      percent: "25",
      reduceGb: String(Math.max(0, Math.round((json.target.reduceToBytes / GB) * 100) / 100)),
    };
  }
  return {
    policy: policyFieldsFromResponse(json),
    thresholdGb,
    targetMode: "percent",
    percent: String(Math.min(100, Math.max(1, Math.floor(json.target.removeOldestPercent ?? 25)))),
    reduceGb: "4",
  };
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
  const cacheKey = `ocx.storage.cleanup-policy.v1:${apiBase}`;
  const cached = readSessionListCache<CachedCleanupPolicy>(cacheKey);
  const hasCacheRef = useRef(Boolean(cached));
  const [policy, setPolicy] = useState<CleanupPolicy | null>(() => cached?.policy ?? null);
  const [loading, setLoading] = useState(() => !cached);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<"percent" | "reduce">(() => cached?.targetMode ?? "percent");
  /** Draft string so blank/invalid percent targets are rejected instead of coerced. */
  const [percent, setPercent] = useState(() => cached?.percent ?? "25");
  /** Draft string so blank/invalid reduce targets are rejected instead of coerced to 0. */
  const [reduceGb, setReduceGb] = useState(() => cached?.reduceGb ?? "4");
  /** Draft string so a cleared threshold is rejected instead of coerced to 0. */
  const [thresholdGb, setThresholdGb] = useState(() => cached?.thresholdGb ?? "5");
  /** Cancels in-flight Run-now polling when the panel unmounts. */
  const runAbortRef = useRef<AbortController | null>(null);
  /** User has local draft edits; background GET must not clobber them. */
  const dirtyRef = useRef(false);
  /** True while a draft control is focused. */
  const editingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const applyPolicy = useCallback((json: CleanupPolicy) => {
    const next = draftsFromPolicyResponse(json);
    setPolicy(next.policy);
    setThresholdGb(next.thresholdGb);
    setTargetMode(next.targetMode);
    setPercent(next.percent);
    setReduceGb(next.reduceGb);
    hasCacheRef.current = true;
    writeSessionListCache(cacheKey, next);
    dirtyRef.current = false;
  }, [cacheKey]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  const setEditing = useCallback((editing: boolean) => {
    editingRef.current = editing;
  }, []);

  const loadPolicy = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    // Soft refresh: keep last-good policy painted while revalidating.
    if (!hasCacheRef.current) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, { signal });
      if (!res.ok) throw new Error("load_failed");
      const json = await res.json() as CleanupPolicy;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      // Do not overwrite in-progress drafts with a stale/background GET.
      if (dirtyRef.current || editingRef.current) return;
      applyPolicy(json);
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      if (!hasCacheRef.current) {
        setPolicy(null);
        setError(t("storage.policy.loadFailed"));
      }
    } finally {
      if (!signal?.aborted && generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase, applyPolicy, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadPolicy(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
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
      if (!res.ok) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      const json = await res.json() as { ok?: boolean; policy?: CleanupPolicy; error?: string };
      if (!json.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      applyPolicy(json.policy);
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
      // Persist current drafts only — never flip enabled:true; Run now must not opt
      // the user into recurring cleanup. A disabled policy still starts the job and
      // reports skippedDisabled (user must enable first for an actual cleanup).
      const saveRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base),
        signal,
      });
      if (signal.aborted) return;
      if (!saveRes.ok) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      const saved = await saveRes.json() as { policy?: CleanupPolicy; error?: string };
      if (signal.aborted) return;
      if (!saved.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      applyPolicy(saved.policy);

      const res = await fetch(`${apiBase}/api/storage/cleanup-policy/run`, {
        method: "POST",
        signal,
      });
      if (signal.aborted) return;
      if (res.status === 409) {
        const conflict = await res.json().catch(() => ({})) as {
          error?: string;
          policy?: CleanupPolicy;
        };
        if (signal.aborted) return;
        if (conflict.policy) applyPolicy(conflict.policy);
        setError(t("storage.policy.alreadyRunning"));
        return;
      }
      if (!res.ok) {
        const failed = await res.json().catch(() => ({})) as {
          error?: string;
          policy?: CleanupPolicy;
        };
        if (signal.aborted) return;
        if (failed.policy) applyPolicy(failed.policy);
        if (failed.error === "already_running") {
          setError(t("storage.policy.alreadyRunning"));
          return;
        }
        setError(t("storage.policy.runFailed"));
        return;
      }
      const startJson = await res.json() as {
        ok?: boolean;
        started?: boolean;
        error?: string;
        job?: CleanupPolicy["job"];
        policy?: CleanupPolicy;
      };
      if (signal.aborted) return;
      if (startJson.policy) applyPolicy(startJson.policy);
      if (startJson.error === "already_running") {
        setError(t("storage.policy.alreadyRunning"));
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
        applyPolicy(body);
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
      if (finalPolicy) applyPolicy(finalPolicy);
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
      <section className="storage-cleanup-pane">
        <p className="muted storage-policy-help">{t("storage.policy.loading")}</p>
      </section>
    );
  }

  if (!policy) {
    return (
      <section className="storage-cleanup-pane">
        {error && <p className="err" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section className="storage-cleanup-pane">
      <p className="muted storage-policy-help">{t("storage.policy.help")}</p>

      <div className="storage-policy-enable">
        <div className="storage-policy-enable-row">
          <button
            type="button"
            className={`toggle${policy.enabled ? " on" : ""}`}
            disabled={saving || running}
            aria-pressed={policy.enabled}
            aria-label={t("storage.policy.enabled")}
            title={t("storage.policy.enabledHint")}
            onClick={() => void savePolicy({ enabled: !policy.enabled })}
          >
            <span className="toggle-knob" />
          </button>
          <span>{t("storage.policy.enabled")}</span>
        </div>
      </div>

      <div className="storage-policy-fields">
        <div className="field storage-policy-trigger">
          <label className="field-label" htmlFor="storage-policy-threshold">
            {t("storage.policy.trigger")}
          </label>
          <div className="storage-policy-trigger-row">
            <span className="storage-policy-trigger-hint">{t("storage.policy.threshold")}</span>
            <span
              className="codex-auto-switch-input-wrap"
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setEditing(false);
                void savePolicy();
              }}
            >
              <input
                id="storage-policy-threshold"
                className="input mono codex-auto-switch-input"
                type="number"
                min={0}
                step={0.1}
                inputMode="decimal"
                value={thresholdGb}
                disabled={saving || running}
                aria-label={t("storage.policy.threshold")}
                onFocus={() => setEditing(true)}
                onChange={e => {
                  markDirty();
                  setThresholdGb(e.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || saving || running) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void savePolicy();
                  }
                }}
              />
              <span className="codex-auto-switch-unit" aria-hidden="true">GiB</span>
              <NumberStepper
                disabled={saving || running}
                incrementLabel={t("storage.policy.thresholdInc")}
                decrementLabel={t("storage.policy.thresholdDec")}
                onIncrement={() => {
                  markDirty();
                  setThresholdGb(clampNumberDraft(thresholdGb, 0.1, 0, 10_000, 0.1));
                }}
                onDecrement={() => {
                  markDirty();
                  setThresholdGb(clampNumberDraft(thresholdGb, -0.1, 0, 10_000, 0.1));
                }}
              />
            </span>
          </div>
        </div>

        <fieldset className="field storage-policy-target">
          <legend className="field-label">{t("storage.policy.target")}</legend>
          <label className="storage-policy-target-row">
            <input
              type="radio"
              name="storage-policy-target"
              checked={targetMode === "percent"}
              disabled={saving || running}
              onChange={() => {
                markDirty();
                setTargetMode("percent");
              }}
            />
            <span className="storage-policy-target-label">{t("storage.policy.targetPercent")}</span>
            {targetMode === "percent" && (
              <span
                className="codex-auto-switch-input-wrap"
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setEditing(false);
                  void savePolicy();
                }}
              >
                <input
                  id="storage-policy-percent"
                  className="input mono codex-auto-switch-input"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={percent}
                  disabled={saving || running}
                  aria-label={t("storage.policy.targetPercent")}
                  onFocus={() => setEditing(true)}
                  onChange={e => {
                    markDirty();
                    setPercent(e.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || saving || running) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void savePolicy();
                    }
                  }}
                />
                <span className="codex-auto-switch-unit" aria-hidden="true">%</span>
                <NumberStepper
                  disabled={saving || running}
                  incrementLabel={t("storage.policy.percentInc")}
                  decrementLabel={t("storage.policy.percentDec")}
                  onIncrement={() => {
                    markDirty();
                    setPercent(clampNumberDraft(percent, 1, 1, 100));
                  }}
                  onDecrement={() => {
                    markDirty();
                    setPercent(clampNumberDraft(percent, -1, 1, 100));
                  }}
                />
              </span>
            )}
          </label>
          <label className="storage-policy-target-row">
            <input
              type="radio"
              name="storage-policy-target"
              checked={targetMode === "reduce"}
              disabled={saving || running}
              onChange={() => {
                markDirty();
                setTargetMode("reduce");
              }}
            />
            <span className="storage-policy-target-label">{t("storage.policy.targetReduce")}</span>
            {targetMode === "reduce" && (
              <span
                className="codex-auto-switch-input-wrap"
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setEditing(false);
                  void savePolicy();
                }}
              >
                <input
                  id="storage-policy-reduce"
                  className="input mono codex-auto-switch-input"
                  type="number"
                  min={0}
                  step={0.1}
                  inputMode="decimal"
                  value={reduceGb}
                  disabled={saving || running}
                  aria-label={t("storage.policy.targetReduce")}
                  onFocus={() => setEditing(true)}
                  onChange={e => {
                    markDirty();
                    setReduceGb(e.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || saving || running) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void savePolicy();
                    }
                  }}
                />
                <span className="codex-auto-switch-unit" aria-hidden="true">GiB</span>
                <NumberStepper
                  disabled={saving || running}
                  incrementLabel={t("storage.policy.reduceInc")}
                  decrementLabel={t("storage.policy.reduceDec")}
                  onIncrement={() => {
                    markDirty();
                    setReduceGb(clampNumberDraft(reduceGb, 0.1, 0, 10_000, 0.1));
                  }}
                  onDecrement={() => {
                    markDirty();
                    setReduceGb(clampNumberDraft(reduceGb, -0.1, 0, 10_000, 0.1));
                  }}
                />
              </span>
            )}
          </label>
        </fieldset>

        <div className="storage-policy-selects">
          <label className="field" htmlFor="storage-policy-schedule">
            <span className="field-label">{t("storage.policy.schedule")}</span>
            <select
              id="storage-policy-schedule"
              className="input"
              value={policy.schedule}
              disabled={saving || running}
              onChange={e => {
                const schedule = e.target.value as CleanupPolicy["schedule"];
                void savePolicy({ schedule });
              }}
            >
              <option value="manual">{t("storage.policy.schedule.manual")}</option>
              <option value="startup">{t("storage.policy.schedule.startup")}</option>
              <option value="daily">{t("storage.policy.schedule.daily")}</option>
              <option value="weekly">{t("storage.policy.schedule.weekly")}</option>
            </select>
          </label>

          <label className="field" htmlFor="storage-policy-mode">
            <span className="field-label">{t("storage.policy.mode")}</span>
            <select
              id="storage-policy-mode"
              className="input"
              value={policy.mode}
              disabled={saving || running}
              onChange={e => {
                const mode = e.target.value as CleanupPolicy["mode"];
                void savePolicy({ mode });
              }}
            >
              <option value="quarantine">{t("storage.policy.mode.quarantine")}</option>
              <option value="permanent">{t("storage.policy.mode.permanent")}</option>
            </select>
          </label>
        </div>
        {policy.mode === "permanent" && (
          <p className="err storage-policy-warn" role="status">{t("storage.policy.permanentWarn")}</p>
        )}
      </div>

      <div className="storage-policy-meta">
        <div className="storage-policy-meta-item">
          <span className="muted">{t("storage.policy.lastRun")}</span>
          <span className="storage-policy-meta-value">
            {formatWhen(policy.lastRun?.at)}
            {policy.lastRun
              ? ` · ${t("storage.policy.lastRunDetail", {
                count: String(policy.lastRun.removed),
                size: formatBytes(policy.lastRun.freedBytes, locale),
              })}`
              : ""}
          </span>
        </div>
        <div className="storage-policy-meta-item">
          <span className="muted">{t("storage.policy.nextRun")}</span>
          <span className="storage-policy-meta-value">{formatWhen(policy.nextRun)}</span>
        </div>
      </div>

      <div className="storage-policy-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving || running} onClick={() => void savePolicy()}>
          {t("storage.policy.save")}
        </button>
        <button type="button" className="btn btn-sm" disabled={saving || running} onClick={() => void runNow()}>
          {running ? t("storage.policy.running") : t("storage.policy.runNow")}
        </button>
        <span
          className={`storage-policy-actions__status${error ? " is-error" : ""}`}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          {error ?? status ?? ""}
        </span>
      </div>
    </section>
  );
}

type StorageCleanupTab = "policy" | "quarantine";

function StorageCleanupCard({
  apiBase,
  locale,
  t,
  archivedCount,
  showQuarantine,
  trashReloadToken,
  onDone,
  onTrashEntriesChange,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  archivedCount: number;
  showQuarantine: boolean;
  trashReloadToken: number;
  onDone: () => void;
  onTrashEntriesChange: (entries: TrashEntry[]) => void;
}) {
  const [tab, setTab] = useState<StorageCleanupTab>("policy");
  const policyTabRef = useRef<HTMLButtonElement>(null);
  const quarantineTabRef = useRef<HTMLButtonElement>(null);
  const tabs: Array<{ id: StorageCleanupTab; label: string; ref: typeof policyTabRef }> = [
    { id: "policy", label: t("storage.cleanupCard.tab.policy"), ref: policyTabRef },
    { id: "quarantine", label: t("storage.cleanupCard.tab.quarantine"), ref: quarantineTabRef },
  ];

  const selectTab = (next: StorageCleanupTab) => {
    setTab(next);
    window.requestAnimationFrame(() => (next === "policy" ? policyTabRef : quarantineTabRef).current?.focus());
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === "policy" ? "quarantine" : "policy");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("policy");
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("quarantine");
    }
  };

  return (
    <section className="panel storage-cleanup-card" aria-labelledby="storage-cleanup-card-title">
      <div className="page-tabs storage-cleanup-card__tabs" role="tablist" aria-label={t("storage.cleanupCard.tabs")}>
        {tabs.map(({ id, label, ref }) => (
          <button
            key={id}
            type="button"
            role="tab"
            ref={ref}
            id={`storage-cleanup-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`storage-cleanup-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`page-tab${tab === id ? " page-tab--active" : ""}`}
            onKeyDown={handleTabKey}
            onClick={() => selectTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <h3 id="storage-cleanup-card-title" className="panel-title">{t("storage.cleanupCard.title")}</h3>

      <div className="storage-cleanup-card__stack">
        <div
          id="storage-cleanup-panel-policy"
          role="tabpanel"
          aria-labelledby="storage-cleanup-tab-policy"
          className="storage-cleanup-card__body storage-cleanup-policy-split"
          data-active={tab === "policy" ? "true" : "false"}
          aria-hidden={tab !== "policy"}
          {...(tab !== "policy" ? { inert: true } : {})}
        >
          <AutoCleanupPolicyPanel apiBase={apiBase} locale={locale} t={t} onDone={onDone} />
          <aside className="storage-cleanup-manual" aria-labelledby="storage-cleanup-manual-title">
            <h4 id="storage-cleanup-manual-title" className="storage-cleanup-manual__title">{t("storage.cleanup.title")}</h4>
            {archivedCount > 0
              ? <ArchivedCleanupPanel apiBase={apiBase} locale={locale} t={t} onDone={onDone} />
              : <p className="muted storage-manual-panel__status">{t("storage.cleanup.noArchives")}</p>}
          </aside>
        </div>

        <div
          id="storage-cleanup-panel-quarantine"
          role="tabpanel"
          aria-labelledby="storage-cleanup-tab-quarantine"
          className="storage-cleanup-card__body"
          data-active={tab === "quarantine" ? "true" : "false"}
          aria-hidden={tab !== "quarantine"}
          {...(tab !== "quarantine" ? { inert: true } : {})}
        >
          {showQuarantine ? (
            <QuarantineTrashPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              onDone={onDone}
              reloadToken={trashReloadToken}
              onEntriesChange={onTrashEntriesChange}
            />
          ) : (
            <p className="muted storage-manual-panel__status">{t("storage.trash.empty")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Storage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const storageCacheKey = `ocx.storage.report.v1:${apiBase}`;
  const cachedReport = readSessionListCache<StorageReport>(storageCacheKey);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [trashReloadToken, setTrashReloadToken] = useState(0);
  const manualRefreshRef = useRef(false);
  // Stamp trash awareness with apiBase so a base change invalidates without an effect.
  const [trashInfo, setTrashInfo] = useState({ apiBase, settled: false, hasEntries: false });
  const fetchStorage = useCallback(async (signal: AbortSignal): Promise<StorageReport> => {
    try {
      const res = await fetch(`${apiBase}/api/storage`, { signal });
      if (!res.ok) throw new Error(t("storage.error"));
      const report = await res.json() as StorageReport;
      writeSessionListCache(storageCacheKey, report);
      if (manualRefreshRef.current) {
        manualRefreshRef.current = false;
        setScanStatus(t("storage.rescanned"));
      }
      return report;
    } catch (error) {
      if (manualRefreshRef.current) {
        manualRefreshRef.current = false;
        setScanStatus(t("storage.error"));
      }
      if (signal.aborted) throw error;
      throw new Error(t("storage.error"), { cause: error });
    }
  }, [apiBase, storageCacheKey, t]);
  const reportResource = useDataSurface<StorageReport>(
    `storage-report:${apiBase}`,
    [apiBase],
    fetchStorage,
    { isEmpty: report => report.total.fileCount === 0 && report.error === undefined },
  );
  const reportState = reportResource.state;
  const data = reportState.data ?? cachedReport;
  const loading = reportState.refreshing || (reportState.showSkeleton && !data);
  const refreshReport = reportResource.refresh;

  const refreshAll = useCallback(() => {
    setScanStatus(null);
    manualRefreshRef.current = true;
    refreshReport();
    setTrashReloadToken(n => n + 1);
  }, [refreshReport]);

  const onTrashEntriesChange = useCallback((entries: TrashEntry[]) => {
    setTrashInfo({ apiBase, settled: true, hasEntries: entries.length > 0 });
  }, [apiBase]);

  const trashSettled = trashInfo.apiBase === apiBase && trashInfo.settled;
  const trashHasEntries = trashInfo.apiBase === apiBase && trashInfo.hasEntries;
  const reportFailed = data?.error !== undefined;
  const empty = !loading && !reportState.showError && !reportFailed && data!.total.fileCount === 0 && trashSettled && !trashHasEntries;
  const archivedCount = data?.buckets.find(b => b.key === "archived_sessions")?.fileCount ?? 0;
  const showBody = Boolean(data) && !reportFailed;
  // While storage is empty, keep the trash panel mounted until it reports so we
  // do not flash the empty state over a non-empty quarantine.
  const showTrashWhileSettling = showBody && (data!.total.fileCount > 0 || !trashSettled || trashHasEntries);

  return (
    <>
      <div className="page-head">
        <h2 id="storage-page-title">{t("storage.title")}</h2>
        <div className="storage-page-head-actions">
          <span className="storage-page-head-feedback" role="status" aria-live="polite">
            {scanStatus ?? ""}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void refreshAll()}>
            <IconRefresh /> {t("storage.refresh")}
          </button>
        </div>
      </div>
      <p className="page-sub">{t("storage.subtitle")}</p>
      {data && data.error === undefined && (
        <p className="storage-page-meta">
          <code className="mono storage-page-meta__home" title={data.codexHome}>{data.codexHome}</code>
          <span className="storage-page-meta__sep" aria-hidden="true">·</span>
          <span>
            {t("storage.snapshot.lastScan")}:{" "}
            {new Date(data.generatedAt).toLocaleString(locale)}
          </span>
        </p>
      )}

      {reportState.showSkeleton && !data ? (
        <DataSurfaceSkeleton label={t("storage.loading")} rows={5} />
      ) : reportState.kind === "failed-cold" && !data ? (
        <>
          <div className="alert alert-err" role="alert">
            {reportState.error instanceof Error ? reportState.error.message : t("storage.error")}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => refreshReport()}>{t("common.retry")}</button>
        </>
      ) : reportFailed ? (
        <>
          <div className="alert alert-err" role="alert">{t("storage.error")}</div>
        </>
      ) : (
        <>
          {reportState.showError && <div className="alert alert-err" role="alert">{t("storage.error")}</div>}
          {empty ? <EmptyState title={t("storage.empty")} /> : data && data.total.fileCount > 0 && <StorageWorkspace report={data} locale={locale} />}
        </>
      )}

      {data && data.error === undefined && reportState.refreshing && !reportState.showSkeleton && (
        <DataSurfaceStatus live={!reportState.showError}>{t("storage.loading")}</DataSurfaceStatus>
      )}

      {showBody && (
        <StorageCleanupCard
          apiBase={apiBase}
          locale={locale}
          t={t}
          archivedCount={archivedCount}
          showQuarantine={showTrashWhileSettling}
          trashReloadToken={trashReloadToken}
          onDone={() => void refreshAll()}
          onTrashEntriesChange={onTrashEntriesChange}
        />
      )}
    </>
  );
}
