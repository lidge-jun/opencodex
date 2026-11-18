import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { Notice, Switch } from "../../ui";
import { readJsonOrThrow } from "../../fetch-json";

interface ForceState {
  force: string | null;
  forceAvailable: string[];
  forceStatus: {
    targetValid: boolean;
    version: string | null;
    support: "supported" | "unsupported" | "unknown";
    settingsOverride: boolean;
    settingsReadable: boolean;
  } | null;
}

function forceModelOptions(roster: readonly string[], exposed: readonly string[]): string[] {
  const available = new Set(exposed);
  return [...new Set([...roster.filter(model => available.has(model)), ...exposed])];
}

/** Endpoint-keyed by the page so a late reply cannot update a different server's controls. */
export default function SubagentForceControl({ apiBase, roster }: { apiBase: string; roster: string[] }) {
  const t = useT();
  const [state, setState] = useState<ForceState | null>(null);
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ retry: number; t: typeof t } | null>(null);
  const pending = busy || loaded?.retry !== retry || loaded.t !== t;
  const inFlight = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    inFlight.current = true;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/subagent-models`, { signal: controller.signal });
        const data = await readJsonOrThrow<Partial<ForceState>>(response, t("sub.loadFail"));
        if (cancelled) return;
        const next = { force: data?.force ?? null, forceAvailable: data?.forceAvailable ?? [], forceStatus: data?.forceStatus ?? null };
        setState(next);
        setSelection(next.force ?? "");
        setError("");
      } catch {
        if (!cancelled) setError(t("sub.loadFail"));
      } finally {
        if (!cancelled) { inFlight.current = false; setLoaded({ retry, t }); }
      }
    })();
    return () => { cancelled = true; active.current = false; controller.abort(); };
  }, [apiBase, retry, t]);

  async function save(force: string | null) {
    if (!state || pending || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }),
      });
      const data = await readJsonOrThrow<{ force: string | null }>(response, t("sub.saveFailed"));
      if (!active.current) return;
      setState(current => current ? { ...current, force: data?.force ?? null, forceStatus: null } : current);
      setSelection(data?.force ?? selection);
      setSaved(true);
      setRetry(value => value + 1);
    } catch {
      if (active.current) setError(t("sub.saveFailed"));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  const options = forceModelOptions(roster, state?.forceAvailable ?? []);
  const selected = state?.force ?? selection;
  const valid = options.includes(selected);
  const status = state?.forceStatus;
  return (
    <section className="panel">
      <h3>{t("sub.forceTitle")}</h3>
      <Switch on={!!state?.force} disabled={!state || pending || (!state.force && !valid)}
        label={t("sub.forceTitle")} onClick={() => { void save(state?.force ? null : selection); }} />
      <label className="field-label">
        {t("sub.forceModel")}
        <select className="input" value={selected} disabled={!state || pending}
          onChange={event => {
            const value = event.target.value;
            if (state?.force) void save(value);
            else setSelection(value);
          }}>
          <option value="" disabled>{t("sub.forceChoose")}</option>
          {selected && !valid && <option value={selected} disabled>{selected}</option>}
          {options.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
      <p className="muted">{t("sub.forceHelp")}</p>
      <p className="muted">{t("sub.forceScope")}</p>
      {state?.force && (!valid || status?.targetValid === false) && <Notice tone="warn">{t("sub.forceInvalid")}</Notice>}
      {state?.force && status?.support === "unsupported" && <Notice tone="warn">{t("sub.forceOld")}</Notice>}
      {state?.force && (!status || status.support === "unknown") && <Notice tone="warn">{t("sub.forceUnknown")}</Notice>}
      {state?.force && status?.settingsOverride && <Notice tone="warn">{t("sub.forceOverride")}</Notice>}
      {state?.force && status?.settingsReadable === false && <Notice tone="warn">{t("sub.forceSettingsUnknown")}</Notice>}
      {saved && <Notice tone="ok">{t("sub.forceSaved")}</Notice>}
      {error && <Notice tone="err">{error}<button type="button" className="btn btn-ghost btn-sm" disabled={pending}
        onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button></Notice>}
    </section>
  );
}
