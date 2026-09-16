import { useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  applyNativeMain, canApplyNativeMain, canRegisterNativeMain, NativeMainError, nativeMainErrorCode,
  readNativeMainSnapshot, registerNativeMain, sameNativeMainScope,
  type NativeMainAction, type NativeMainErrorCode, type NativeMainSnapshot,
} from "../native-main-profiles";
import { NativeMainProfilesView } from "./native-main-profiles-view";

interface Props {
  apiBase: string;
  disabled?: boolean;
  onChanged: () => unknown | Promise<unknown>;
}

/** A new proxy owns a new confirmation, previous-profile hint and request lifetime. */
export default function NativeMainProfiles(props: Props) {
  return <NativeMainProfilesForProxy key={props.apiBase} {...props} />;
}

function NativeMainProfilesForProxy({ apiBase, disabled = false, onChanged }: Props) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<NativeMainSnapshot | null>(null);
  const [label, setLabel] = useState("");
  const [action, setAction] = useState<NativeMainAction | null>(null);
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const [previous, setPrevious] = useState<{ id: string | null; home: string; active: string } | null>(null);
  const [error, setError] = useState<NativeMainErrorCode | null>(null);
  const [result, setResult] = useState<"saved" | "restart" | "done" | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const live = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const external = useRef({ disabled, onChanged });
  useLayoutEffect(() => { external.current = { disabled, onChanged }; }, [disabled, onChanged]);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; pending.current?.abort(); pending.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (action) confirmationRef.current?.focus();
    else if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      summaryRef.current?.focus();
    }
  }, [action, busy]);

  function select(next: NativeMainAction | null) {
    if (pending.current) return;
    setAction(next);
    setConfirmedStopped(false);
    setError(null);
    if (!next) restoreFocus.current = true;
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    // Synchronous guard: two clicks in the same render cannot send two mutations.
    if (!live.current || pending.current || external.current.disabled) return;
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45_000);
    setBusy(true);
    try { await operation(controller.signal); }
    catch (caught) {
      if (live.current) { setError(nativeMainErrorCode(caught)); setSnapshot(null); }
    } finally {
      clearTimeout(timeout);
      if (live.current) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  async function refresh(signal: AbortSignal) {
    const next = await readNativeMainSnapshot(apiBase, signal);
    if (!live.current) return;
    setSnapshot(next);
    setPrevious(value => value && value.home === next.doctor.effectiveCodexHome
      && value.active === next.doctor.activeProfileId ? value : null);
    setRefreshFailed(false);
  }

  function reload() {
    if (action) return;
    void run(async signal => {
      setError(null);
      await refresh(signal);
      if (refreshFailed && live.current) {
        try {
          const updated = await external.current.onChanged();
          if (live.current && updated === false) setRefreshFailed(true);
        } catch { if (live.current) setRefreshFailed(true); }
      }
    });
  }

  async function reconcile() {
    // Never reuse an aborted mutation signal. A timed-out write may have committed;
    // only fresh GETs and the existing account controller can tell the user what won.
    if (!live.current) return;
    const read = new AbortController();
    pending.current = read;
    const timeout = setTimeout(() => read.abort(), 20_000);
    try {
      await refresh(read.signal);
      if (!live.current || read.signal.aborted) return;
      const refreshed = await external.current.onChanged();
      if (live.current && refreshed === false) setRefreshFailed(true);
    } catch {
      if (live.current) { setSnapshot(null); setRefreshFailed(true); }
    } finally { clearTimeout(timeout); }
  }

  function register() {
    if (!snapshot || refreshFailed || !label.trim() || action || !canRegisterNativeMain(snapshot)) return;
    const before = snapshot;
    void run(async signal => {
      setError(null); setResult(null); setRefreshFailed(false);
      let dispatched = false;
      try {
        const current = await readNativeMainSnapshot(apiBase, signal);
        signal.throwIfAborted();
        if (!live.current || external.current.disabled) return;
        if (!sameNativeMainScope(before, current) || !canRegisterNativeMain(current)) {
          setSnapshot(current); throw new NativeMainError("STATE_CHANGED");
        }
        dispatched = true;
        const home = await registerNativeMain(apiBase, label, signal);
        if (home !== before.doctor.effectiveCodexHome) throw new NativeMainError("STATE_CHANGED");
        if (live.current) { setResult("saved"); setLabel(""); }
      } catch (caught) {
        if (live.current) setError(nativeMainErrorCode(caught));
      } finally {
        if (dispatched) await reconcile();
      }
    });
  }

  function confirm() {
    if (!snapshot || refreshFailed || !action || !confirmedStopped || !canApplyNativeMain(snapshot, action)) return;
    const before = snapshot;
    const selected = action;
    void run(async signal => {
      setError(null); setResult(null); setRefreshFailed(false);
      let dispatched = false;
      try {
        const current = await readNativeMainSnapshot(apiBase, signal);
        signal.throwIfAborted();
        if (!live.current || external.current.disabled) return;
        if (!sameNativeMainScope(before, current) || !canApplyNativeMain(current, selected)) {
          setSnapshot(current); throw new NativeMainError("STATE_CHANGED");
        }
        dispatched = true;
        const outcome = await applyNativeMain(apiBase, selected, true, signal);
        if (!live.current) return;
        if (outcome.effectiveCodexHome !== before.doctor.effectiveCodexHome) throw new NativeMainError("STATE_CHANGED");
        // The existing API does not return the transaction source. This is explicitly
        // a shortcut to the previously displayed profile, never an authoritative undo.
        setPrevious(selected.kind === "switch" ? { id: before.doctor.activeProfileId,
          home: before.doctor.effectiveCodexHome, active: selected.target } : null);
        setResult(outcome.restartRequired ? "restart" : "done");
      } catch (caught) {
        if (live.current) { setError(nativeMainErrorCode(caught)); setPrevious(null); }
      } finally {
        if (live.current) {
          restoreFocus.current = true;
          setAction(null); setConfirmedStopped(false);
        }
        if (dispatched) await reconcile();
      }
    });
  }

  return <NativeMainProfilesView t={t} id={id} open={open} busy={busy} blocked={disabled}
    snapshot={snapshot} label={label} action={action} confirmedStopped={confirmedStopped}
    previousId={previous?.id ?? null} error={error} result={result} refreshFailed={refreshFailed}
    summaryRef={summaryRef} confirmationRef={confirmationRef}
    onToggle={() => {
      if (pending.current) return;
      setOpen(!open); select(null);
      if (!open) reload();
    }}
    onRefresh={reload} onLabel={setLabel} onRegister={register} onSelect={select}
    onStopped={setConfirmedStopped} onConfirm={confirm} />;
}
