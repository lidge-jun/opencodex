import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createBoundedFetch } from "../bounded-fetch";
import { startVisibilityPoll } from "../visibility-poll";
import { useT, type TKey } from "../i18n/shared";
import { Select } from "../ui";
import { formatNamespacedModelId } from "../provider-icons";
import { hardLockThresholds, type MainAccountHardLockStatus } from "../hooks/useCodexAccountPool";

type Props = { apiBase: string; onSaved: () => Promise<boolean> };
type FallbackSetting = { enabled?: boolean; model?: string; reasoningEffort?: string } | null;
type Snapshot = { codexMainAccountHardLock: boolean; mainAccountHardLock: MainAccountHardLockStatus; codexMainAccountHardLockFallback: FallbackSetting };
type ModelInfo = { id: string; provider: string; namespaced: string; native?: boolean; disabled?: boolean };

/** Same ladder the memory-models and compaction-routing panels offer for their targets. */
const FALLBACK_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function readFallback(value: unknown): FallbackSetting {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings shape");
  const model = "model" in value && typeof value.model === "string" ? value.model.trim() : "";
  if (!model) throw new Error("settings shape");
  const effort = "reasoningEffort" in value ? value.reasoningEffort : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !FALLBACK_EFFORTS.includes(effort))) throw new Error("settings shape");
  const enabled = "enabled" in value ? value.enabled : undefined;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("settings shape");
  return { model, ...(effort ? { reasoningEffort: effort } : {}), ...(enabled !== undefined ? { enabled } : {}) };
}

function readSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("settings shape");
  const payload = value as Partial<Snapshot> & { codexMainAccountHardLockFallback?: unknown };
  const policy = payload.mainAccountHardLock;
  if (typeof payload.codexMainAccountHardLock !== "boolean" || !policy
    || policy.enabled !== payload.codexMainAccountHardLock
    || !(policy.enabled ? ["unknown", "ready", "blocked"] : ["off"]).includes(policy.state)
    || (policy.resetAt !== undefined && (typeof policy.resetAt !== "number" || !Number.isFinite(policy.resetAt)))) {
    throw new Error("settings shape");
  }
  const fallback = readFallback(payload.codexMainAccountHardLockFallback);
  return { ...payload, codexMainAccountHardLock: payload.codexMainAccountHardLock, mainAccountHardLock: policy, codexMainAccountHardLockFallback: fallback } as Snapshot;
}

function HardLockConfirmation({ pending, thresholds, onCancel, onConfirm }: {
  pending: boolean;
  thresholds: { short: number; long: number };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`} aria-busy={pending || undefined}
      onCancel={event => { event.preventDefault(); onCancel(); }}
      onKeyDown={event => {
        if (event.key !== "Tab" || pending) return;
        const from = event.shiftKey ? cancelRef.current : confirmRef.current;
        const to = event.shiftKey ? confirmRef.current : cancelRef.current;
        if (document.activeElement === from) { event.preventDefault(); to?.focus(); }
      }}>
      <button type="button" className="modal-backdrop-dismiss" tabIndex={-1}
        aria-label={t("common.close")} disabled={pending} onClick={onCancel} />
      <div className="modal-card codex-main-hard-lock-dialog" role="document">
        <h3 id={`${id}-title`}>{t("codexAuth.mainHardLockConfirmTitle", thresholds)}</h3>
        <p id={`${id}-body`} className="modal-desc">{t("codexAuth.mainHardLockConfirmBody")}</p>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>
            {t("codexAuth.cancel")}
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary" disabled={pending} onClick={onConfirm}>
            {t(pending ? "common.saving" : "codexAuth.mainHardLockConfirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** A changed proxy identity must not inherit another proxy's acknowledged setting. */
export default function MainAccountHardLockSetting(props: Props) {
  return <HardLockSetting key={props.apiBase} {...props} />;
}

function HardLockSetting({ apiBase, onSaved }: Props) {
  const t = useT();
  const id = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fallback, setFallback] = useState<FallbackSetting>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fallbackSaving, setFallbackSaving] = useState(false);
  const [fallbackError, setFallbackError] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);
  const modelsAbortRef = useRef<AbortController | null>(null);
  const modelsLoadedRef = useRef(false);

  const ensureModelsLoaded = useCallback(() => {
    if (modelsLoadedRef.current || modelsAbortRef.current) return;
    const controller = new AbortController();
    modelsAbortRef.current = controller;
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/models`, { signal: controller.signal });
        if (!response.ok) throw new Error("models");
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("models");
        modelsLoadedRef.current = true;
        if (mountedRef.current) {
          setModels(rows.filter(row => row !== null && typeof row === "object"
            && typeof (row as ModelInfo).namespaced === "string"
            && (row as ModelInfo).native !== true
            && (row as ModelInfo).disabled !== true) as ModelInfo[]);
        }
      } catch { /* saved value stays selectable */ }
      finally {
        if (modelsAbortRef.current === controller) modelsAbortRef.current = null;
      }
    })();
  }, [apiBase]);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef(false);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    const generation = ++generationRef.current;
    readAbortRef.current?.abort();
    const bounded = createBoundedFetch(15_000);
    readAbortRef.current = bounded.controller;
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!response.ok) throw new Error("load");
      const next = readSnapshot(await response.json());
      if (!mountedRef.current || generation !== generationRef.current) return;
      setSnapshot(next);
      setFallback(next.codexMainAccountHardLockFallback);
      setLoadError(false);
      setSaved(null);
    } catch {
      if (mountedRef.current && generation === generationRef.current) setLoadError(true);
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  useEffect(() => {
    mountedRef.current = true;
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const stop = startVisibilityPoll(() => { void load(); }, 30_000);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      readAbortRef.current?.abort();
      modelsAbortRef.current?.abort();
      modelsAbortRef.current = null;
      window.clearTimeout(timeout);
      stop();
    };
  }, [load]);

  useEffect(() => {
    if (confirming || saving || !restoreFocusRef.current) return;
    if (toggleRef.current && !toggleRef.current.disabled) {
      toggleRef.current.focus();
      restoreFocusRef.current = false;
    } else {
      // Keep the intent through failed/pending authoritative reads: the section is
      // focusable while the switch is disabled, and a successful GET completes restoration.
      sectionRef.current?.focus();
    }
  }, [confirming, saving, loadError, snapshot]);

  const refreshMain = async () => {
    let confirmed = false;
    try { confirmed = await onSaved(); } catch { /* Saved config is not a failed PUT. */ }
    if (mountedRef.current) setRefreshError(!confirmed);
  };

  const save = async (requested: boolean) => {
    // The toggle requires a successful read before opening confirmation. A later poll
    // failure must not silently turn an already-open confirmation into a no-op.
    if (busyRef.current || !snapshot) return;
    busyRef.current = true;
    generationRef.current += 1;
    readAbortRef.current?.abort();
    setSaving(true);
    setSaveError(false);
    setRefreshError(false);
    setSaved(null);
    const bounded = createBoundedFetch(15_000);
    let acknowledged = false;
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexMainAccountHardLock: requested }), signal: bounded.signal,
      });
      if (!response.ok) throw new Error("save");
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
        throw new Error("unconfirmed");
      }
      const next = readSnapshot(payload);
      acknowledged = true;
      if (mountedRef.current) {
        setSnapshot(next);
        setLoadError(false);
        setSaved(next.codexMainAccountHardLock);
      }
    } catch {
      if (mountedRef.current) {
        setSaveError(true);
        setLoadError(true);
      }
    } finally {
      bounded.clear();
    }
    // Also refresh the owner if Advanced was collapsed while a disable PUT was pending.
    if (acknowledged) await refreshMain();
    busyRef.current = false;
    if (!mountedRef.current) return;
    setSaving(false);
    setConfirming(false);
    if (!acknowledged) void load(); // A timeout may still have committed: re-read, never guess.
  };

  const cancel = () => {
    if (!busyRef.current) setConfirming(false);
  };

  // One immediate save per change, the same contract as the shadow-call row: the switch,
  // the model and the effort each PUT alone, and the switch keeps the configured model
  // while off so turning it back on restores the same destination.
  const saveFallback = async (next: Exclude<FallbackSetting, null>) => {
    if (busyRef.current || fallbackSaving || !snapshot) return;
    busyRef.current = true;
    generationRef.current += 1;
    readAbortRef.current?.abort();
    setFallbackSaving(true);
    setFallbackError(false);
    const bounded = createBoundedFetch(15_000);
    let acknowledged = false;
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexMainAccountHardLockFallback: next }),
        signal: bounded.signal,
      });
      if (!response.ok) throw new Error("save");
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
        throw new Error("unconfirmed");
      }
      const accepted = readSnapshot(payload);
      acknowledged = true;
      if (mountedRef.current) {
        setSnapshot(accepted);
        setFallback(accepted.codexMainAccountHardLockFallback);
        setLoadError(false);
      }
    } catch {
      if (mountedRef.current) setFallbackError(true);
    } finally {
      bounded.clear();
    }
    if (acknowledged) await refreshMain();
    busyRef.current = false;
    if (!mountedRef.current) return;
    setFallbackSaving(false);
    if (!acknowledged) void load();
  };
  const fallbackOn = fallback?.enabled !== false && Boolean(fallback?.model);
  const toggleFallback = () => {
    if (!fallback?.model) return;
    void saveFallback({ ...fallback, enabled: !fallbackOn });
  };
  const changeFallbackModel = (model: string) => {
    if (!model) return;
    // Picking a destination is an enabling act: the model always lands with the reroute
    // on, so a fresh setup configures in one pick and the switch only pauses/resumes.
    const { enabled: _paused, ...rest } = fallback ?? {};
    void saveFallback({ ...rest, model, ...(fallback?.enabled === false ? { enabled: true } : {}) });
  };
  const changeFallbackEffort = (effort: string) => {
    void saveFallback({ ...(fallback ?? {}), ...(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined }) });
  };

  const retryRefresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    generationRef.current += 1;
    setSaving(true);
    await refreshMain();
    busyRef.current = false;
    if (mountedRef.current) setSaving(false);
  };
  const enabled = snapshot?.codexMainAccountHardLock;
  const thresholds = hardLockThresholds(snapshot?.mainAccountHardLock.thresholds);
  return (
    <section ref={sectionRef} id="codex-main-hard-lock-setting" tabIndex={-1}
      className="card card-row codex-main-hard-lock-setting" aria-labelledby={`${id}-title`}
      aria-busy={saving || (!snapshot && !loadError) || undefined}
      onBlurCapture={event => {
        // A deliberate departure cancels restoration; disabled controls can blur to null.
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) {
          restoreFocusRef.current = false;
        }
      }}>
      <div className="codex-main-hard-lock-copy">
        <strong id={`${id}-title`}>{t("codexAuth.mainHardLockTitle", thresholds)}</strong>
        <div id={`${id}-desc`} className="card-sub">{t("codexAuth.mainHardLockDesc", thresholds)}</div>
      </div>
      <button ref={toggleRef} type="button" className={`toggle ${enabled === true ? "on" : ""}`}
        disabled={saving || enabled === undefined || loadError} aria-pressed={enabled}
        aria-label={t("codexAuth.mainHardLockTitle", thresholds)} aria-describedby={`${id}-desc`}
        onClick={() => {
          if (busyRef.current || enabled === undefined || loadError) return;
          restoreFocusRef.current = true;
          if (enabled) void save(false);
          else setConfirming(true);
        }}><span className="toggle-knob" /></button>
      <div className="codex-main-hard-lock-feedback">
        {snapshot?.mainAccountHardLock.externalUsage && <div className="codex-main-hard-lock-status is-blocked"><p role="status">{t("codexAuth.mainExternalUsageWarning")}</p></div>}
        {(saveError || loadError) && <p role="alert">{t(saveError ? "codexAuth.mainHardLockSaveFailed" : "codexAuth.mainHardLockLoadFailed")}{" "}
          <button type="button" className="link-btn" disabled={saving} onClick={() => { void load(); }}>{t("common.retry")}</button>
        </p>}
        {saved !== null && !refreshError && <p role="status">{t(saved ? "codexAuth.mainHardLockEnabled" : "codexAuth.mainHardLockDisabled", thresholds)}</p>}
        {refreshError && <p role="status">{t("codexAuth.mainHardLockRefreshFailed")}{" "}
          <button type="button" className="link-btn" disabled={saving} onClick={() => { void retryRefresh(); }}>{t("common.retry")}</button>
        </p>}
      </div>
      <div className="codex-main-hard-lock-fallback" role="group" aria-label={t("codexAuth.mainHardLockFallbackTitle")}
        onFocusCapture={ensureModelsLoaded} onPointerDownCapture={ensureModelsLoaded} onClickCapture={ensureModelsLoaded}
        style={{ flexBasis: "100%" }}>
        <div className="spread" style={{ alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span className="font-semibold">{t("codexAuth.mainHardLockFallbackTitle")}</span>
          </div>
          <div className="setting-controls" style={{ flex: "0 1 auto" }}>
            <button type="button" className={`switch ${fallbackOn ? "on" : ""}`}
              onClick={toggleFallback}
              disabled={fallbackSaving || loadError || !fallback?.model}
              aria-label={t("codexAuth.mainHardLockFallbackTitle")} aria-pressed={fallbackOn}>
              <span className="knob" />
            </button>
            <Select value={fallback?.model ?? ""}
              options={[...new Set([fallback?.model, ...models.map(model => model.namespaced)]
                .filter((value): value is string => Boolean(value)))]
                .map(value => ({ value, label: formatNamespacedModelId(value, t) }))}
              onChange={changeFallbackModel}
              disabled={fallbackSaving || loadError}
              label={t("codexAuth.mainHardLockFallbackModel")}
              align="right" />
            <Select value={fallback?.reasoningEffort ?? ""}
              options={[{ value: "", label: t("codexAuth.mainHardLockFallbackDefaultEffort") },
                ...FALLBACK_EFFORTS.map(value => ({ value, label: t(`models.reasoningEffort.${value}` as TKey) }))]}
              onChange={changeFallbackEffort}
              disabled={fallbackSaving || loadError || !fallbackOn}
              label={t("codexAuth.mainHardLockFallbackEffort")}
              align="right" />
          </div>
        </div>
        <div className="muted setting-hint">{t("codexAuth.mainHardLockFallbackDesc")}</div>
        {snapshot?.mainAccountHardLock.state === "blocked" && fallbackOn && fallback?.model
          && <p role="status" className="codex-main-hard-lock-status is-blocked">{t("codexAuth.mainHardLockFallbackActive", { model: fallback.model })}</p>}
        {fallbackError && <p role="alert">{t("codexAuth.mainHardLockFallbackSaveFailed")}{" "}
          <button type="button" className="link-btn" disabled={fallbackSaving} onClick={() => { void load(); }}>{t("common.retry")}</button>
        </p>}
      </div>
      {confirming && <HardLockConfirmation pending={saving} thresholds={thresholds} onCancel={cancel} onConfirm={() => { void save(true); }} />}
    </section>
  );
}
