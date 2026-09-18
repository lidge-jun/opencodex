import type { RefObject } from "react";
import type { NativeMainTFn } from "../i18n/native-main-copy";
import { canApplyNativeMain, canRegisterNativeMain, nativeMainUnavailableCode, type NativeMainAction, type NativeMainErrorCode, type NativeMainSnapshot } from "../native-main-profiles";

export interface NativeMainProfilesViewProps {
  t: NativeMainTFn;
  id: string;
  open: boolean;
  busy: boolean;
  blocked: boolean;
  snapshot: NativeMainSnapshot | null;
  label: string;
  action: NativeMainAction | null;
  confirmedStopped: boolean;
  previousId: string | null;
  error: NativeMainErrorCode | null;
  result: "saved" | "restart" | "done" | null;
  refreshFailed: boolean;
  summaryRef?: RefObject<HTMLButtonElement | null>;
  confirmationRef?: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onRefresh: () => void;
  onLabel: (label: string) => void;
  onRegister: () => void;
  onSelect: (action: NativeMainAction | null) => void;
  onStopped: (checked: boolean) => void;
  onConfirm: () => void;
}

const DOCTOR_CMD = "ocx account main doctor";

/** The global <Trans> chip shape, bound to this closed native-main namespace. */
function DoctorHint({ t }: { t: NativeMainTFn }) {
  const [pre, post = ""] = t("nativeMain.doctorHint").split("{cmd}");
  return <>{pre}<code className="chip">{DOCTOR_CMD}</code>{post}</>;
}

/** Pure view; credentials and response/error objects never enter its props. */
export function NativeMainProfilesView({
  t, id, open, busy, blocked, snapshot: s, label, action, confirmedStopped, previousId, error, result,
  refreshFailed, summaryRef, confirmationRef, onToggle, onRefresh, onLabel, onRegister, onSelect,
  onStopped, onConfirm,
}: NativeMainProfilesViewProps) {
  const disabled = busy || blocked;
  const mutationDisabled = disabled || refreshFailed;
  const unavailable = s ? nativeMainUnavailableCode(s) : null;
  const profiles = s?.list?.profiles ?? [];
  const active = profiles.find(item => item.id === s?.doctor.activeProfileId);
  const previous = profiles.find(item => item.id === previousId && item.state === "inactive");
  return <section className="panel" aria-labelledby={`${id}-heading`} style={{ marginBottom: 12 }}>
    <div className="row" style={{ justifyContent: "space-between" }}>
      <strong id={`${id}-heading`}>{t("nativeMain.title")}</strong>
      <button ref={summaryRef} type="button" className="btn btn-sm btn-ghost" aria-expanded={open}
        aria-controls={`${id}-panel`} onClick={onToggle} disabled={busy}>
        {t(open ? "nativeMain.close" : "nativeMain.manage")}
      </button>
    </div>
    {open && <div id={`${id}-panel`} aria-busy={busy}>
      <p className="card-sub">{t("nativeMain.separate")}</p>
      {s && <dl>
        <dt>{t("nativeMain.home")}</dt><dd style={{ marginLeft: 0, overflowWrap: "anywhere" }}><code>{s.doctor.effectiveCodexHome}</code></dd>
        {s.list && <>
          <dt>{t("nativeMain.current")}</dt><dd style={{ marginLeft: 0, overflowWrap: "anywhere" }}>{active?.label ?? t("nativeMain.unregistered")}</dd>
        </>}
      </dl>}
      <p className="card-sub">{t("nativeMain.physicalHint")}</p>
      {blocked && <p role="status" className="notice notice-warn">{t("nativeMain.busyOther")}</p>}
      {busy && <p role="status">{t("nativeMain.working")}</p>}
      {error && <div role="alert" className="notice notice-err">
        <p>{t(error === "STATE_CHANGED" ? "nativeMain.changed" : "nativeMain.error")}</p>
        <code>{error}</code> <DoctorHint t={t} />
      </div>}
      {result && <p role="status" className="notice">{t(result === "saved" ? "nativeMain.saved"
        : result === "restart" ? "nativeMain.restart" : "nativeMain.done")}</p>}
      {refreshFailed && <p role="alert" className="notice notice-warn">{t("nativeMain.refreshFailed")}</p>}
      <button type="button" className="btn btn-sm btn-ghost" onClick={onRefresh} disabled={disabled || !!action}>{t("nativeMain.refresh")}</button>
      {s && !s.doctor.supported && <p role="alert">{t("nativeMain.unsupported")}</p>}
      {unavailable && s?.doctor.supported && !s.doctor.recoveryPending && <p role="status">
        {t("nativeMain.unavailable")} <code>{unavailable}</code>
      </p>}
      {s?.doctor.recoveryPending && <div className="notice notice-warn">
        <p>{t("nativeMain.recoveryHint")}</p>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={mutationDisabled || !!action || !s.doctor.supported}
            onClick={() => onSelect({ kind: "recover", rollback: false })}>{t("nativeMain.recover")}</button>
          <button type="button" className="btn btn-sm" disabled={mutationDisabled || !!action || !s.doctor.supported}
            onClick={() => onSelect({ kind: "recover", rollback: true })}>{t("nativeMain.rollback")}</button>
        </div>
      </div>}
      {s?.list && <>
        {profiles.length === 0 && <p>{t("nativeMain.empty")}</p>}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {profiles.map(item => <li key={item.id} className="row" style={{ padding: "8px 0", flexWrap: "wrap" }}>
            <strong style={{ overflowWrap: "anywhere", minWidth: 0 }}>{item.label}</strong> <code style={{ overflowWrap: "anywhere", minWidth: 0 }}>{item.identityHint}</code>
            {item.state === "active" ? <span className="badge badge-green">{t("nativeMain.active")}</span>
              : <button type="button" className="btn btn-sm" disabled={mutationDisabled || !!action || !canApplyNativeMain(s, { kind: "switch", target: item.id, label: item.label })}
                aria-label={t("nativeMain.switchTo", { label: item.label })}
                onClick={() => onSelect({ kind: "switch", target: item.id, label: item.label })}>{t("nativeMain.switch")}</button>}
          </li>)}
        </ul>
        {previous && <>
          <button type="button" className="btn btn-sm" disabled={mutationDisabled || !!action
            || !canApplyNativeMain(s, { kind: "switch", target: previous.id, label: previous.label })}
            onClick={() => onSelect({ kind: "switch", target: previous.id, label: previous.label })}>
            {t("nativeMain.restore", { label: previous.label })}
          </button>
          <p className="card-sub">{t("nativeMain.restoreHint")}</p>
        </>}
        <form onSubmit={event => { event.preventDefault(); onRegister(); }}>
          <label htmlFor={`${id}-label`}>{t("nativeMain.label")}</label>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input id={`${id}-label`} value={label} onChange={event => onLabel(event.target.value)}
              disabled={mutationDisabled || !!action || !canRegisterNativeMain(s)} maxLength={80} autoComplete="off" />
            <button type="submit" className="btn btn-sm" disabled={mutationDisabled || !!action || !label.trim() || !canRegisterNativeMain(s)}>
              {t("nativeMain.save")}
            </button>
          </div>
          <p className="card-sub">{t("nativeMain.saveHint")}</p>
        </form>
      </>}
      {action && s && <div ref={confirmationRef} role="group" tabIndex={-1} aria-labelledby={`${id}-confirm-title`}
        className="notice notice-warn" style={{ marginTop: 12 }}
        onKeyDown={event => {
          if (event.key === "Escape" && !busy) { event.preventDefault(); onSelect(null); }
        }}>
        <h3 id={`${id}-confirm-title`} style={{ overflowWrap: "anywhere" }}>{t(action.kind === "switch" ? "nativeMain.switchTo"
          : action.rollback ? "nativeMain.rollback" : "nativeMain.recover", { label: action.kind === "switch" ? action.label : "" })}</h3>
        <p>{t("nativeMain.confirmHint")}</p>
        <code style={{ overflowWrap: "anywhere" }}>{s.doctor.effectiveCodexHome}</code>
        <p><label htmlFor={`${id}-stopped`}>
          <input id={`${id}-stopped`} type="checkbox" checked={confirmedStopped}
            disabled={mutationDisabled} onChange={event => onStopped(event.target.checked)} /> {t("nativeMain.stopped")}
        </label></p>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onSelect(null)}>{t("nativeMain.cancel")}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={mutationDisabled || !confirmedStopped || !canApplyNativeMain(s, action)}
            onClick={onConfirm}>{t("nativeMain.confirm")}</button>
        </div>
      </div>}
    </div>}
  </section>;
}
