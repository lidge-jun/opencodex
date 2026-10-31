import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { Notice, Select, Switch } from "../../ui";
import { readJsonOrThrow } from "../../fetch-json";
import { Frame, FrameBody } from "../v2-subagents/frame";
import { useHelpDisclosure } from "../v2-subagents/use-help-disclosure";

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
export default function SubagentForceControl({ apiBase, roster, id, onForceChange }: {
  apiBase: string;
  roster: string[];
  id?: string;
  /** The committed pin (`null` = off, `undefined` = not loaded), for the page's summary. */
  onForceChange?: (force: string | null | undefined) => void;
}) {
  const t = useT();
  const help = useHelpDisclosure(t("sub.forceTitle"));
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
  const committedForce = state ? state.force : undefined;
  useEffect(() => { onForceChange?.(committedForce); }, [committedForce, onForceChange]);
  const notices = [
    state?.force && (!valid || status?.targetValid === false) && <Notice key="invalid" tone="warn">{t("sub.forceInvalid")}</Notice>,
    state?.force && status?.support === "unsupported" && <Notice key="old" tone="warn">{t("sub.forceOld")}</Notice>,
    state?.force && (!status || status.support === "unknown") && <Notice key="unknown" tone="warn">{t("sub.forceUnknown")}</Notice>,
    state?.force && status?.settingsOverride && <Notice key="override" tone="warn">{t("sub.forceOverride")}</Notice>,
    state?.force && status?.settingsReadable === false && <Notice key="settings" tone="warn">{t("sub.forceSettingsUnknown")}</Notice>,
    saved && <Notice key="saved" tone="ok">{t("sub.forceSaved")}</Notice>,
    error && <Notice key="error" tone="err">{error}<button type="button" className="btn btn-ghost btn-sm" disabled={pending}
      onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button></Notice>,
  ].filter(Boolean);
  return (
    <Frame
      id={id}
      title={t("sub.forceTitle")}
      lede={t("subagentsV2.forceLede")}
      meta={help.button}
      actions={<Switch on={!!state?.force} disabled={!state || pending || (!state.force && !valid)}
        label={t("sub.forceTitle")} onClick={() => { void save(state?.force ? null : selection); }} />}
      below={help.panel(<><p>{t("sub.forceHelp")}</p><p>{t("sub.forceScope")}</p></>)}
    >
      <FrameBody>
        <label className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <span className="min-w-[min(100%,12rem)] flex-1 text-[14px] leading-5 font-medium text-fg">{t("sub.forceModel")}</span>
          <Select fullWidth className="max-w-[22rem] sm:w-auto sm:min-w-[16rem]" triggerClassName="text-[13px]"
            label={t("sub.forceModel")} value={selected} disabled={!state || pending}
            onChange={value => {
              // Re-picking the pinned model is not a change; only a different model saves.
              if (state?.force) { if (value !== state.force) void save(value); }
              else setSelection(value);
            }}
            options={[
              { value: "", label: t("sub.forceChoose"), disabled: true },
              ...(selected && !valid ? [{ value: selected, label: selected, disabled: true }] : []),
              ...options.map(model => ({ value: model, label: model })),
            ]} />
        </label>
      </FrameBody>
      {notices.length > 0 && <div className="flex flex-col gap-2 px-4 py-3">{notices}</div>}
    </Frame>
  );
}
