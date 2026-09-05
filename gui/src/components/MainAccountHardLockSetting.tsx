import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createBoundedFetch } from "../bounded-fetch";
import { startVisibilityPoll } from "../visibility-poll";
import { useT } from "../i18n/shared";
import type { MainAccountHardLockStatus } from "../hooks/useCodexAccountPool";

type Props = { apiBase: string; onSaved: () => Promise<boolean> };
type Snapshot = { codexMainAccountHardLock: boolean; mainAccountHardLock: MainAccountHardLockStatus };

function readSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("settings shape");
  const payload = value as Partial<Snapshot>;
  const policy = payload.mainAccountHardLock;
  if (typeof payload.codexMainAccountHardLock !== "boolean" || !policy
    || policy.enabled !== payload.codexMainAccountHardLock
    || !(policy.enabled ? ["unknown", "ready", "blocked"] : ["off"]).includes(policy.state)
    || (policy.resetAt !== undefined && (typeof policy.resetAt !== "number" || !Number.isFinite(policy.resetAt)))) {
    throw new Error("settings shape");
  }
  return payload as Snapshot;
}

function HardLockConfirmation({ pending, onCancel, onConfirm }: {
  pending: boolean;
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
        <h3 id={`${id}-title`}>{t("codexAuth.mainHardLockConfirmTitle")}</h3>
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
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);
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
        <strong id={`${id}-title`}>{t("codexAuth.mainHardLockTitle")}</strong>
        <div id={`${id}-desc`} className="card-sub">{t("codexAuth.mainHardLockDesc")}</div>
      </div>
      <button ref={toggleRef} type="button" className={`toggle ${enabled === true ? "on" : ""}`}
        disabled={saving || enabled === undefined || loadError} aria-pressed={enabled}
        aria-label={t("codexAuth.mainHardLockTitle")} aria-describedby={`${id}-desc`}
        onClick={() => {
          if (busyRef.current || enabled === undefined || loadError) return;
          restoreFocusRef.current = true;
          if (enabled) void save(false);
          else setConfirming(true);
        }}><span className="toggle-knob" /></button>
      <div className="codex-main-hard-lock-feedback">
        {(saveError || loadError) && <p role="alert">{t(saveError ? "codexAuth.mainHardLockSaveFailed" : "codexAuth.mainHardLockLoadFailed")}{" "}
          <button type="button" className="link-btn" disabled={saving} onClick={() => { void load(); }}>{t("common.retry")}</button>
        </p>}
        {saved !== null && !refreshError && <p role="status">{t(saved ? "codexAuth.mainHardLockEnabled" : "codexAuth.mainHardLockDisabled")}</p>}
        {refreshError && <p role="status">{t("codexAuth.mainHardLockRefreshFailed")}{" "}
          <button type="button" className="link-btn" disabled={saving} onClick={() => { void retryRefresh(); }}>{t("common.retry")}</button>
        </p>}
      </div>
      {confirming && <HardLockConfirmation pending={saving} onCancel={cancel} onConfirm={() => { void save(true); }} />}
    </section>
  );
}
