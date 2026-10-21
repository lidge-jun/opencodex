import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createBoundedFetch } from "../bounded-fetch";
import { startVisibilityPoll } from "../visibility-poll";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import { parseFallbackState, type FallbackState, type FallbackSwitches, type FallbackWrite } from "../fallback-api";
import "../styles-fallback.css";

/**
 * OCX-11 fallback controls. `routing` shows the global switches, scoped overrides and the last
 * fallback; `devices` shows per-device local fallback and chains (read-only on a Child, whose
 * settings live on its Home).
 */
export default function FallbackPanel({ apiBase, section, readOnly = false }: { apiBase: string; section: "routing" | "devices"; readOnly?: boolean }): ReactElement | null {
  const t = useT();
  const [state, setState] = useState<FallbackState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    if (savingRef.current) return;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(apiBase + "/api/fallback", { signal: bounded.signal });
      const parsed = response.ok ? parseFallbackState(await response.json()) : null;
      if (!parsed) throw new Error("shape");
      if (!savingRef.current) { setState(parsed); setLoadFailed(false); }
    } catch {
      if (!savingRef.current) setLoadFailed(true);
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const stop = startVisibilityPoll(() => { void load(); }, 30_000);
    return () => { window.clearTimeout(timeout); stop(); };
  }, [load]);

  const write = useCallback(async (writes: FallbackWrite[]) => {
    if (savingRef.current || readOnly) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    const bounded = createBoundedFetch(15_000);
    try {
      let latest: FallbackState | null = null;
      for (const body of writes) {
        const response = await fetch(apiBase + "/api/fallback", {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: bounded.signal,
        });
        latest = response.ok ? parseFallbackState(await response.json()) : null;
        if (!latest) throw new Error("save");
      }
      if (latest) setState(latest);
    } catch {
      setSaveFailed(true);
    } finally {
      bounded.clear();
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, readOnly]);

  const stateWord = (value: boolean | undefined | null): string =>
    t(value === false ? "fallback.state.off" : value === true ? "fallback.state.on" : "fallback.state.inherit");

  const locked = saving || readOnly;

  if (!state) {
    return (
      <section className="panel fallback-panel" aria-busy={!loadFailed || undefined}>
        <h3>{t(section === "routing" ? "fallback.title" : "fallback.devices.title")}</h3>
        <p className="card-sub" role="status">{loadFailed ? t("fallback.loadFailed") : t("common.loading")}</p>
        {loadFailed && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button>}
      </section>
    );
  }

  if (section === "devices") {
    return (
      <section className="panel fallback-panel">
        <h3>{t("fallback.devices.title")}</h3>
        <p className="card-sub">{t(readOnly ? "fallback.devices.childNote" : "fallback.devices.desc")}</p>
        {state.devices.length === 0
          ? <p className="card-sub">{t("fallback.devices.empty")}</p>
          : <div className="fallback-devices" role="table" aria-label={t("fallback.devices.title")}>
            <div className="fallback-device-row fallback-device-head" role="row">
              <span role="columnheader">{t("fallback.devices.device")}</span>
              <span role="columnheader">{t("fallback.devices.local")}</span>
              <span role="columnheader">{t("fallback.devices.chains")}</span>
            </div>
            {state.devices.map(device => {
              const chainsOn = device.model !== false && device.provider !== false;
              const name = device.alias ?? device.id;
              return (
                <div className="fallback-device-row" role="row" key={device.id}>
                  <span role="cell"><strong>{name}</strong>{device.alias && <code className="fallback-device-id">{device.id}</code>}</span>
                  <span role="cell"><FallbackToggle label={t("fallback.devices.localFor", { name })} on={device.localFallback} disabled={locked}
                    onToggle={() => { void write([{ scope: "device", key: device.id, setting: "localFallback", value: !device.localFallback }]); }} /></span>
                  <span role="cell"><FallbackToggle label={t("fallback.devices.chainsFor", { name })} on={chainsOn} disabled={locked}
                    onToggle={() => {
                    const value = chainsOn ? false : null;
                    void write([
                      { scope: "device", key: device.id, setting: "model", value },
                      { scope: "device", key: device.id, setting: "provider", value },
                    ]);
                    }} /></span>
                </div>
              );
            })}
          </div>}
        {saveFailed && <Notice tone="err">{t("fallback.saveFailed")}</Notice>}
      </section>
    );
  }

  const overrides: Array<{ scope: "provider" | "route"; key: string; value: FallbackSwitches }> = [
    ...Object.entries(state.providers).map(([key, value]) => ({ scope: "provider" as const, key, value })),
    ...Object.entries(state.routes).map(([key, value]) => ({ scope: "route" as const, key, value })),
  ];
  const last = state.last;
  return (
    <section className="panel fallback-panel">
      <h3>{t("fallback.title")}</h3>
      <p className="card-sub">{t("fallback.desc")}</p>
      {(["model", "provider"] as const).map(kind => (
        <div className="fallback-switch-row" key={kind}>
          <div>
            <strong>{t(kind === "model" ? "fallback.model" : "fallback.provider")}</strong>
            <div className="card-sub">{t(kind === "model" ? "fallback.modelHint" : "fallback.providerHint")}</div>
          </div>
          <FallbackToggle label={t(kind === "model" ? "fallback.model" : "fallback.provider")} on={state.global[kind]} disabled={locked}
            onToggle={() => { void write([{ scope: "global", setting: kind, value: state.global[kind] ? false : null }]); }} />
        </div>
      ))}
      <p className="card-sub faint">{t("fallback.rotationNote")}</p>
      {overrides.length > 0 && (
        <div className="fallback-overrides">
          <strong>{t("fallback.overrides")}</strong>
          <ul>
            {overrides.map(row => (
              <li key={row.scope + ":" + row.key}>
                <span>{t(row.scope === "provider" ? "fallback.scope.provider" : "fallback.scope.route", { name: row.key })}</span>
                <span className="card-sub">{t("fallback.model")}: {stateWord(row.value.model)} · {t("fallback.provider")}: {stateWord(row.value.provider)}</span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => {
                  void write((["model", "provider"] as const).filter(kind => row.value[kind] !== undefined)
                    .map(kind => ({ scope: row.scope, key: row.key, setting: kind, value: null })));
                }}>{t("fallback.clear")}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="fallback-last" aria-live="polite">
        <strong>{t("fallback.last")}</strong>
        {last
          ? <p className="card-sub"><time dateTime={last.at}>{new Date(last.at).toLocaleString()}</time> · <code>{last.route}</code>: <code>{last.from}</code> → <code>{last.to}</code> (<code>{last.trigger}</code>) · {t(last.outcome === "refused" ? "fallback.last.refused" : "fallback.last.taken")}</p>
          : <p className="card-sub">{t("fallback.last.none")}</p>}
      </div>
      {saveFailed && <Notice tone="err">{t("fallback.saveFailed")}</Notice>}
    </section>
  );
}

function FallbackToggle({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled: boolean; onToggle: () => void }): ReactElement {
  return (
    <button type="button" className={"toggle " + (on ? "on" : "")} aria-pressed={on} aria-label={label} title={label}
      onClick={onToggle} disabled={disabled}>
      <span className="toggle-knob" />
    </button>
  );
}
