import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";
import { useT } from "../i18n/shared";
import type { NoticeTone } from "../ui";

type Feedback = { tone: NoticeTone; message: string } | null;
type ModelsMap = Record<string, string[]>;
type AccountModelOption = { selector: string; models: string[] };
type AccountFieldsPayload = { codexAccountPickerModels?: unknown; codexAccountPickerOptions?: unknown };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isModelsMap(value: unknown): value is ModelsMap {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isStringArray);
}

function isAccountOptions(value: unknown): value is AccountModelOption[] {
  return Array.isArray(value) && value.every(entry => !!entry && typeof entry === "object"
    && typeof (entry as { selector?: unknown }).selector === "string"
    && isStringArray((entry as { models?: unknown }).models));
}

/** Order-insensitive equality for the per-account model draft vs. the last confirmed map. */
function sameModelsMap(a: ModelsMap, b: ModelsMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key] ?? [];
    const bv = b[key];
    if (!bv || av.length !== bv.length) return false;
    const bset = new Set(bv);
    if (!av.every(model => bset.has(model))) return false;
  }
  return true;
}

/** Opt-in control for account-qualified Codex model-picker entries. */
export default function CodexAccountPickerSetting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const enabledRef = useRef(false);
  const savingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  // Second, independent opt-in: restrict which models show under each account selector.
  // Backend-gated (older /api/settings responses omit codexAccountPickerOptions). The main
  // enable switch above never reads or writes codexAccountPickerModels -- flipping it on/off
  // must not touch this field at all. With customize OFF (the default), enabling the picker
  // keeps the exact legacy behavior: account-qualified entries fully replace the plain rows
  // for those accounts. Turning customize ON does not change that replacement; it only narrows
  // which models appear under each account entry, while common pool models keep appearing
  // alongside those account entries instead of being hidden by them.
  const [customizeSupported, setCustomizeSupported] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [customizeSaving, setCustomizeSaving] = useState(false);
  const [options, setOptions] = useState<AccountModelOption[]>([]);
  const [savedModels, setSavedModels] = useState<ModelsMap>({});
  const [draft, setDraft] = useState<ModelsMap>({});
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsFeedback, setModelsFeedback] = useState<Feedback>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const customizeRef = useRef(false);
  const customizeSavingRef = useRef(false);
  const modelsSavingRef = useRef(false);
  const dirty = useMemo(() => !sameModelsMap(draft, savedModels), [draft, savedModels]);
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  // Any in-flight mutation blocks every other mutating control, so a customize toggle cannot
  // race a model-list save (or vice versa) and leave the confirmed state ambiguous.
  const busy = saving || customizeSaving || modelsSaving;
  const anyMutationInFlight = useCallback(() => savingRef.current || customizeSavingRef.current || modelsSavingRef.current, []);

  // Applies the account-selector fields from any /api/settings response (GET or PUT). Live
  // selector labels are only (re)initialized on the enable-picker PUT and the customize/save
  // PUTs, not on a plain GET, so this runs after every one of those responses too, not only
  // after the background poll.
  const applyAccountFields = useCallback((payload: AccountFieldsPayload) => {
    const rawModels = payload.codexAccountPickerModels;
    const rawOptions = payload.codexAccountPickerOptions;
    const supported = isAccountOptions(rawOptions) && (rawModels === null || isModelsMap(rawModels));
    setCustomizeSupported(supported);
    if (!supported) return;
    setOptions(rawOptions as AccountModelOption[]);
    if (dirtyRef.current) return; // never clobber an unsaved draft mid-edit.
    const models = rawModels as ModelsMap | null;
    customizeRef.current = models !== null;
    setCustomize(models !== null);
    if (models !== null) {
      setSavedModels(models);
      setDraft(models);
    }
  }, []);

  const load = useCallback(async () => {
    if (anyMutationInFlight() || dirtyRef.current) return;
    const generation = ++loadGenerationRef.current;
    const bounded = createBoundedFetch(15_000);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: bounded.signal });
      if (!response.ok) throw new Error("load");
      const payload = await response.json() as {
        codexAccountPickerEnabled?: unknown;
        codexAccountPickerModels?: unknown;
        codexAccountPickerOptions?: unknown;
      };
      if (anyMutationInFlight() || dirtyRef.current || generation !== loadGenerationRef.current) return;
      if (typeof payload.codexAccountPickerEnabled !== "boolean") throw new Error("shape");
      enabledRef.current = payload.codexAccountPickerEnabled;
      setEnabled(payload.codexAccountPickerEnabled);
      applyAccountFields(payload);
      setHydrated(true);
      setLoadError(false);
    } catch {
      if (!anyMutationInFlight() && !dirtyRef.current && generation === loadGenerationRef.current) {
        setLoadError(true);
      }
    } finally {
      bounded.clear();
    }
  }, [apiBase, applyAccountFields, anyMutationInFlight]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const stop = startVisibilityPoll(() => { void load(); }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, [load]);

  const toggle = useCallback(async () => {
    if (anyMutationInFlight() || !hydrated) return;
    const previous = enabledRef.current;
    const requested = !previous;
    enabledRef.current = requested;
    setEnabled(requested);
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    loadGenerationRef.current += 1;
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexAccountPickerEnabled: requested }),
      });
      const payload = (await readJsonOrThrow<{
        ok?: unknown;
        codexAccountPickerEnabled?: unknown;
        codexAccountPickerModels?: unknown;
        codexAccountPickerOptions?: unknown;
        catalogRefreshPending?: unknown;
      }>(response)) ?? {};
      if (payload.ok !== true || typeof payload.codexAccountPickerEnabled !== "boolean") {
        throw new Error("unconfirmed");
      }
      enabledRef.current = payload.codexAccountPickerEnabled;
      setEnabled(payload.codexAccountPickerEnabled);
      applyAccountFields(payload);
      setHydrated(true);
      setLoadError(false);
      setFeedback(payload.catalogRefreshPending === true
        ? { tone: "warn", message: t("codexAuth.catalogRefreshPending") }
        : { tone: "ok", message: t("codexAuth.accountPickerUpdated") });
    } catch {
      enabledRef.current = previous;
      setEnabled(previous);
      setFeedback({ tone: "err", message: t("codexAuth.accountPickerUpdateFailed") });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, hydrated, applyAccountFields, anyMutationInFlight, t]);

  const toggleCustomize = useCallback(async () => {
    if (anyMutationInFlight() || !hydrated || !customizeSupported) return;
    const previous = customizeRef.current;
    const requested = !previous;
    const nextModels: ModelsMap | null = requested ? draft : null;
    customizeRef.current = requested;
    setCustomize(requested);
    customizeSavingRef.current = true;
    setCustomizeSaving(true);
    setModelsFeedback(null);
    loadGenerationRef.current += 1;
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexAccountPickerModels: nextModels }),
      });
      const payload = (await readJsonOrThrow<{
        ok?: unknown;
        codexAccountPickerModels?: unknown;
        codexAccountPickerOptions?: unknown;
        catalogRefreshPending?: unknown;
      }>(response)) ?? {};
      const confirmed = payload.codexAccountPickerModels;
      // The server always returns this field on a settings PUT; a missing field is treated as
      // any other malformed response instead of being silently coerced to null.
      if (payload.ok !== true || !(confirmed === null || isModelsMap(confirmed))) {
        throw new Error("unconfirmed");
      }
      const isOn = confirmed !== null;
      customizeRef.current = isOn;
      setCustomize(isOn);
      if (isOn) {
        setSavedModels(confirmed);
        setDraft(confirmed);
      }
      if (isAccountOptions(payload.codexAccountPickerOptions)) {
        setOptions(payload.codexAccountPickerOptions);
      }
      setModelsFeedback(payload.catalogRefreshPending === true
        ? { tone: "warn", message: t("codexAuth.catalogRefreshPending") }
        : { tone: "ok", message: t("codexAuth.accountPickerCustomizeUpdated") });
    } catch {
      customizeRef.current = previous;
      setCustomize(previous);
      setModelsFeedback({ tone: "err", message: t("codexAuth.accountPickerCustomizeUpdateFailed") });
    } finally {
      customizeSavingRef.current = false;
      setCustomizeSaving(false);
    }
  }, [apiBase, hydrated, customizeSupported, draft, anyMutationInFlight, t]);

  const toggleModel = useCallback((selector: string, model: string) => {
    setDraft(prev => {
      const current = prev[selector] ?? [];
      const has = current.includes(model);
      const nextList = has ? current.filter(m => m !== model) : [...current, model];
      return { ...prev, [selector]: nextList };
    });
  }, []);

  const saveModels = useCallback(async () => {
    if (anyMutationInFlight() || !customize || !dirty) return;
    modelsSavingRef.current = true;
    loadGenerationRef.current += 1;
    setModelsSaving(true);
    setModelsFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codexAccountPickerModels: draft }),
      });
      const payload = (await readJsonOrThrow<{
        ok?: unknown;
        codexAccountPickerModels?: unknown;
        codexAccountPickerOptions?: unknown;
        catalogRefreshPending?: unknown;
      }>(response)) ?? {};
      const confirmed = payload.codexAccountPickerModels;
      if (payload.ok !== true || !isModelsMap(confirmed)) throw new Error("unconfirmed");
      setSavedModels(confirmed);
      setDraft(confirmed);
      if (isAccountOptions(payload.codexAccountPickerOptions)) {
        setOptions(payload.codexAccountPickerOptions);
      }
      setModelsFeedback(payload.catalogRefreshPending === true
        ? { tone: "warn", message: t("codexAuth.catalogRefreshPending") }
        : { tone: "ok", message: t("codexAuth.accountPickerModelsSaved") });
    } catch {
      setModelsFeedback({ tone: "err", message: t("codexAuth.accountPickerModelsSaveFailed") });
    } finally {
      modelsSavingRef.current = false;
      setModelsSaving(false);
    }
  }, [apiBase, customize, dirty, draft, anyMutationInFlight, t]);

  const initialLoadFailed = loadError && !hydrated;

  return (
    <div className="codex-account-picker-wrap">
      <div
        className="card card-row codex-account-picker-card"
        aria-busy={saving || (!hydrated && !initialLoadFailed) || undefined}
      >
        <div className="codex-account-picker-copy">
          <strong>{t("codexAuth.accountPickerTitle")}</strong>
          <div className="card-sub" role={initialLoadFailed ? "status" : undefined}>
            {initialLoadFailed
              ? t("codexAuth.accountPickerLoadFailed")
              : !hydrated
                ? t("common.loading")
                : t(!enabled
                  ? "codexAuth.accountPickerOffDesc"
                  : customize
                    ? "codexAuth.accountPickerOnDescCustomized"
                    : "codexAuth.accountPickerOnDesc")}
          </div>
          {hydrated && enabled && (
            <div className="card-sub faint">{t("codexAuth.accountPickerCompatibility")}</div>
          )}
          {hydrated && loadError && (
            <div className="card-sub faint" role="status">
              {t("codexAuth.accountPickerRefreshFailed")}
            </div>
          )}
        </div>
        <div className="codex-account-picker-controls">
          {loadError && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { void load(); }}
              disabled={busy}
            >
              {t("common.retry")}
            </button>
          )}
          {hydrated && (
            <button
              type="button"
              className={`toggle ${enabled ? "on" : ""}`}
              onClick={() => { void toggle(); }}
              disabled={busy}
              aria-pressed={enabled}
              aria-label={t("codexAuth.accountPickerTitle")}
              title={t("codexAuth.accountPickerTitle")}
            >
              <span className="toggle-knob" />
            </button>
          )}
        </div>
        {feedback && (
          <div
            className={`codex-account-picker-feedback is-${feedback.tone}`}
            role={feedback.tone === "err" ? "alert" : "status"}
            aria-atomic="true"
          >
            {feedback.message}
          </div>
        )}
      </div>

      {hydrated && enabled && customizeSupported && (
        <div
          className="card card-row codex-account-picker-customize-card"
          aria-busy={customizeSaving || undefined}
        >
          <div className="codex-account-picker-copy">
            <strong>{t("codexAuth.accountPickerCustomizeTitle")}</strong>
            <div className="card-sub">
              {t(customize
                ? "codexAuth.accountPickerCustomizeOnDesc"
                : "codexAuth.accountPickerCustomizeOffDesc")}
            </div>
          </div>
          <div className="codex-account-picker-controls">
            <button
              type="button"
              className={`toggle ${customize ? "on" : ""}`}
              onClick={() => { void toggleCustomize(); }}
              disabled={busy}
              aria-pressed={customize}
              aria-label={t("codexAuth.accountPickerCustomizeTitle")}
              title={t("codexAuth.accountPickerCustomizeTitle")}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          {modelsFeedback && (
            <div
              className={`codex-account-picker-feedback is-${modelsFeedback.tone}`}
              role={modelsFeedback.tone === "err" ? "alert" : "status"}
              aria-atomic="true"
            >
              {modelsFeedback.message}
            </div>
          )}
        </div>
      )}

      {hydrated && enabled && customizeSupported && customize && (
        <div className="codex-account-picker-models" aria-busy={modelsSaving || undefined}>
          <div className="muted text-label codex-account-picker-models-note">
            {t("codexAuth.accountPickerModelsCommonNote")}
          </div>
          {options.length === 0 && (
            <div className="muted text-caption">{t("codexAuth.accountPickerModelsNoAccounts")}</div>
          )}
          {options.map(option => {
            const selected = new Set(draft[option.selector] ?? []);
            const rowQuery = query[option.selector] ?? "";
            const filtered = rowQuery
              ? option.models.filter(model => model.toLowerCase().includes(rowQuery.toLowerCase()))
              : option.models;
            return (
              <div key={option.selector} className="codex-account-picker-account-row">
                <div className="codex-account-picker-account-row-head">
                  <code className="chip">{option.selector}</code>
                  <span className="muted text-caption">
                    {t("codexAuth.accountPickerModelsSelectedCount", { n: selected.size })}
                  </span>
                </div>
                <input
                  type="search"
                  className="input codex-account-picker-search"
                  value={rowQuery}
                  onChange={e => setQuery(prev => ({ ...prev, [option.selector]: e.target.value }))}
                  placeholder={t("codexAuth.accountPickerModelsSearchPlaceholder")}
                  aria-label={t("codexAuth.accountPickerModelsSearchPlaceholder")}
                  disabled={busy}
                />
                <div
                  className="codex-account-picker-model-list"
                  role="group"
                  aria-label={option.selector}
                >
                  {filtered.length === 0 && (
                    <div className="muted text-caption">{t("codexAuth.accountPickerModelsNoMatch")}</div>
                  )}
                  {filtered.map(model => (
                    <label key={model} className="codex-account-picker-model-option">
                      <input
                        type="checkbox"
                        checked={selected.has(model)}
                        onChange={() => toggleModel(option.selector, model)}
                        disabled={busy}
                      />
                      <span>{model}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="codex-account-picker-models-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => { void saveModels(); }}
              disabled={!dirty || busy}
            >
              {t(modelsSaving ? "common.saving" : "common.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
