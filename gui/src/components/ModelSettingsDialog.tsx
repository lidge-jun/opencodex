import { useEffect, useId, useRef, useState } from "react";
import { confirmAction } from "../action-dialogs";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { readJsonOrThrow } from "../fetch-json";
import { useT, type TKey } from "../i18n/shared";
import { Notice, Select } from "../ui";
import { CUSTOM_OPTION, REASONING_EFFORT_LEVELS, type ModelRow } from "../pages/models-shared";

/**
 * The per-model overrides on ONE routed row, in the shape the row already reports them.
 *
 * Three axes, and no fourth. Display name is absent on purpose: the row has its own editor for
 * it, with its own provenance display, and a second control writing the same key is two
 * statements that can drift apart. This dialog owns what nothing else edits — the context
 * window, the modality declaration, and the reasoning ladder — so "restore" means "clear the
 * capability overrides", which is a promise it can keep.
 *
 * Every field is optional and clearing one is a distinct intent from writing a value: an empty
 * window sends `null`, which hands the fact back to the registry, the catalog and the provider
 * default instead of pinning today's answer as an override that outlives its source.
 */

/** The modalities the API accepts. `video` is absent: the wire carries text and image parts. */
const MODALITIES = ["text", "image", "audio"] as const;

const CONTEXT_PRESETS = ["100000", "128000", "200000", "256000", "352000", "500000", "1000000"];

const REQUEST_TIMEOUT_MS = 60_000;

type Phase = "ready" | "saving" | "restoring" | "unknown" | "saved-stale";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What the row reported when the dialog opened: the form's start, and the save diff's baseline. */
interface SettingsBaseline {
  contextWindow: string;
  modalities: string[];
  reasoning: boolean;
  ladder: string[];
  defaultEffort: string;
}

function baselineOf(row: ModelRow): SettingsBaseline {
  const reasoning = row.reasoningOverridden === true;
  return {
    contextWindow: row.contextWindowDeclared !== undefined ? String(row.contextWindowDeclared) : "",
    // The DECLARATION, never the row's own `inputModalities`. That one is the catalog value:
    // pre-filling from it made an undeclared model look declared, and because an untouched field
    // is not submitted, every save came back as "nothing changed" and the row never moved.
    modalities: Array.isArray(row.inputModalitiesDeclared) ? [...row.inputModalitiesDeclared] : [],
    reasoning,
    // The ladder only counts as the operator's when the config really overrides it: OpenCodex
    // writes the registry ladder into the config itself, so key presence would tick this box on
    // every model that merely inherits its levels.
    ladder: reasoning && Array.isArray(row.reasoningEfforts) ? [...row.reasoningEfforts] : [],
    defaultEffort: reasoning ? (row.defaultReasoningEffort ?? "") : "",
  };
}

function sortedKey(values: readonly string[]): string {
  return values.toSorted().join(",");
}

/** undefined when the draft is not a usable window, null when the operator cleared it. */
function parseContextWindow(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/[_,\s]/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

interface ModelSettingsDialogProps {
  row: ModelRow;
  apiBase: string;
  /** Reload the catalog. Resolves false when the reload failed, so the dialog can say so. */
  onRefresh: (signal: AbortSignal) => Promise<boolean>;
  onFeedback: (ok: boolean, message: string) => void;
  onClose: () => void;
}

export default function ModelSettingsDialog({ row, apiBase, onRefresh, onFeedback, onClose }: ModelSettingsDialogProps) {
  const t = useT();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<BoundedFetch | null>(null);
  // State rather than a ref: the form's start values are read during render to seed the fields,
  // and a ref read in render is exactly what the React Compiler lint refuses.
  const [baseline] = useState<SettingsBaseline>(() => baselineOf(row));
  const [phase, setPhase] = useState<Phase>("ready");
  const [contextDraft, setContextDraft] = useState(() => baseline.contextWindow);
  const [customContext, setCustomContext] = useState(() => (
    baseline.contextWindow !== "" && !CONTEXT_PRESETS.includes(baseline.contextWindow)
  ));
  const [modalities, setModalities] = useState<string[]>(() => [...baseline.modalities]);
  const [reasoning, setReasoning] = useState(() => baseline.reasoning);
  const [ladder, setLadder] = useState<string[]>(() => [...baseline.ladder]);
  const [defaultEffort, setDefaultEffort] = useState(() => baseline.defaultEffort);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const busy = phase === "saving" || phase === "restoring";
  const terminal = phase === "unknown" || phase === "saved-stale";

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); if (opener?.isConnected && typeof opener.focus === "function") opener.focus(); };
  }, []);

  useEffect(() => {
    if (terminal) reloadRef.current?.focus();
  }, [terminal]);

  const reload = async () => {
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    try {
      if (!await onRefresh(bounded.signal)) return;
      bounded.signal.throwIfAborted();
      if (requestRef.current !== bounded) return;
      onFeedback(true, t("models.settingsReloaded", { model: row.namespaced }));
      onClose();
    } catch {
      // Keep the terminal state: the operator still needs a successful read before another write.
    } finally {
      bounded.clear();
      if (requestRef.current === bounded) requestRef.current = null;
    }
  };

  const toggleReasoning = (next: boolean) => {
    setReasoning(next);
    if (!next) return;
    // First enable seeds from what the model advertises rather than the full shared ladder: a
    // provider that accepts only a subset would otherwise be handed levels its API rejects.
    if (ladder.length > 0) return;
    const advertised = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : undefined;
    setLadder(advertised && advertised.length > 0 ? [...advertised] : [...REASONING_EFFORT_LEVELS]);
  };

  const toggleLevel = (level: string, on: boolean) => {
    setLadder(prev => (on ? [...prev, level] : prev.filter(value => value !== level)));
    // The default has to stay inside the ladder, so dropping its level drops it too.
    if (!on && defaultEffort === level) setDefaultEffort("");
  };

  const requestClose = () => {
    if (!busy) onClose();
  };

  const send = async (patch: Record<string, unknown>, restoring: boolean) => {
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    setPhase(restoring ? "restoring" : "saving");
    setErrorKey(null);
    let confirmed = false;
    let rejected = false;
    try {
      const response = await fetch(apiBase + "/api/model-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: row.provider, modelId: row.id, ...patch }),
        signal: bounded.signal,
      });
      // A 4xx is answered before anything is written, so the outcome is known: nothing saved.
      // The form stays editable, and the server's untranslated text is not shown.
      if (response.status >= 400 && response.status < 500) {
        rejected = true;
        throw new Error("model settings rejected");
      }
      const result = await readJsonOrThrow<unknown>(response);
      bounded.signal.throwIfAborted();
      // Validate the receipt against the request: a 200 for another row would otherwise be
      // reported as this row's save, and the reload would appear to disagree with the toast.
      if (!isRecord(result) || result.ok !== true || result.provider !== row.provider || result.modelId !== row.id
        || typeof result.changed !== "boolean" || typeof result.hasOverrides !== "boolean"
        || typeof result.saved !== "boolean" || result.saved !== result.changed || !isRecord(result.catalogRefresh)
        || !["committed", "skipped", "failed"].includes(String(result.catalogRefresh.status))) {
        throw new Error("invalid model-settings receipt");
      }
      if (requestRef.current !== bounded) return;
      confirmed = true;
      if (!result.changed) {
        onFeedback(true, t(restoring && !result.hasOverrides ? "models.settingsNothingToRestore" : "models.settingsNoChange", { model: row.namespaced }));
        onClose();
        return;
      }
      // `catalogRefresh` describes the Codex app's catalog, not this list: the dashboard reads the
      // saved config directly. A skip the operator cannot act on (no managed catalog) is normal;
      // only a failed or retryable refresh is worth a warning, and only after the list reloads.
      const refresh = result.catalogRefresh;
      const codexStale = refresh.status === "failed" || (refresh.status === "skipped" && refresh.retryable === true);
      if (!await onRefresh(bounded.signal)) throw new Error("catalog refresh failed");
      bounded.signal.throwIfAborted();
      if (requestRef.current !== bounded) return;
      if (codexStale) {
        onFeedback(false, t("models.settingsSavedCodexStale", { model: row.namespaced }));
      } else if (restoring) {
        onFeedback(true, t("models.settingsRestored", { model: row.namespaced }));
      } else {
        onFeedback(true, t("models.settingsSaved", { model: row.namespaced }));
      }
      onClose();
    } catch {
      if (requestRef.current !== bounded) return;
      if (rejected) {
        setPhase("ready");
        setErrorKey("models.settingsRejected");
        return;
      }
      setPhase(confirmed ? "saved-stale" : "unknown");
      setErrorKey(confirmed ? "models.settingsRefreshFailed" : "models.settingsSaveFailed");
    } finally {
      bounded.clear();
      if (requestRef.current === bounded) requestRef.current = null;
    }
  };

  const submit = () => {
    if (phase !== "ready") return;
    const parsedWindow = parseContextWindow(contextDraft);
    if (parsedWindow === undefined) { setErrorKey("models.contextInvalid"); return; }
    const base = baseline;
    const patch: Record<string, unknown> = {};
    if (contextDraft.trim() !== base.contextWindow) patch.contextWindow = parsedWindow;
    if (sortedKey(modalities) !== sortedKey(base.modalities)) {
      patch.inputModalities = modalities.length > 0 ? [...modalities] : null;
    }
    const ladderKey = reasoning ? sortedKey(ladder) : "";
    if (reasoning !== base.reasoning || ladderKey !== sortedKey(base.ladder)) {
      patch.reasoningEfforts = reasoning ? [...ladder] : null;
    }
    const nextDefault = reasoning && ladder.includes(defaultEffort) ? defaultEffort : "";
    if (nextDefault !== base.defaultEffort) patch.defaultReasoningEffort = nextDefault || null;
    // Only what the operator actually touched is submitted. Writing an untouched field would
    // convert a fact the row merely inherits into a stored override, which is the failure this
    // whole surface exists to avoid.
    if (Object.keys(patch).length === 0) { onClose(); return; }
    void send(patch, false);
  };

  const restore = async () => {
    if (phase !== "ready") return;
    const confirmed = await confirmAction({
      message: t("models.settingsRestoreConfirm", { model: row.namespaced }),
      confirmLabel: t("models.settingsRestore"),
      tone: "danger",
    });
    if (!confirmed) return;
    // Every axis at once, and it writes immediately rather than resetting the form: a form-level
    // reset would still need a save, and that save would re-pin the values it had just restored.
    void send({ contextWindow: null, inputModalities: null, reasoningEfforts: null, defaultReasoningEffort: null }, true);
  };

  const inheritedModalities = Array.isArray(row.inputModalities) ? row.inputModalities.join(", ") : "";
  const inheritedModalityList = Array.isArray(row.inputModalities)
    ? row.inputModalities.filter((value): value is string => (MODALITIES as readonly string[]).includes(value))
    : [];

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby={id + "-title"}
      onCancel={event => { event.preventDefault(); requestClose(); }}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        disabled={busy}
        onClick={requestClose}
      />
      {/*
        `model-display-name-dialog` is reused rather than a new modifier: it is the shared narrow
        dialog shell (460px, stacked actions on a small viewport), and gui/src/styles.css is at its
        file-size cap, so a second class with the same rules could not be added.
      */}
      <form
        className="modal-card model-display-name-dialog"
        role="document"
        noValidate
        aria-busy={busy}
        onClick={event => event.stopPropagation()}
        onSubmit={event => { event.preventDefault(); submit(); }}
      >
        <div className="modal-head">
          <h3 id={id + "-title"}>{t("models.settingsTitle", { model: row.namespaced })}</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={requestClose}>
            {t("common.close")}
          </button>
        </div>

        {errorKey && <Notice tone={phase === "saved-stale" ? "warn" : "err"}>{t(errorKey)}</Notice>}

        <div className="models-field-stack">
          <div className="text-label models-field">
            {t("models.customFieldModelId")}
            <code className="mono text-control">{row.namespaced}</code>
          </div>

          <label className="text-label models-field">
            {t("models.customFieldContext")}
            <div className="row models-field-row">
              <Select
                value={customContext ? CUSTOM_OPTION : contextDraft}
                options={[
                  { value: "", label: "—" },
                  { value: "100000", label: "100k" },
                  { value: "128000", label: "128k" },
                  { value: "200000", label: "200k" },
                  { value: "256000", label: "256k" },
                  { value: "352000", label: "352k" },
                  { value: "500000", label: "500k" },
                  { value: "1000000", label: "1M" },
                  { value: CUSTOM_OPTION, label: t("models.custom") },
                ]}
                onChange={value => {
                  if (value === CUSTOM_OPTION) { setCustomContext(true); return; }
                  setCustomContext(false);
                  setContextDraft(value);
                }}
                disabled={busy}
                label={t("models.customFieldContext")}
                // A portaled menu lands under the modal's top layer, where the backdrop takes its clicks.
                portal={false}
              />
              {customContext && (
                <input
                  className="input"
                  style={{ width: 120 }}
                  inputMode="numeric"
                  value={contextDraft}
                  onChange={event => setContextDraft(event.target.value)}
                  disabled={busy}
                  placeholder={t("models.customPlaceholder")}
                  aria-label={t("models.customFieldContext")}
                />
              )}
            </div>
            {row.contextWindowDeclared === undefined && (
              <span className="muted text-caption">{t("models.settingsContextInherit", {
                value: row.contextWindow ? String(row.contextWindow) : t("models.settingsContextUnknown"),
              })}</span>
            )}
          </label>

          <div className="text-label models-field">
            {t("models.customFieldModalities")}
            <div className="row models-field-row">
              {MODALITIES.map(modality => (
                <label key={modality} className="row models-modality-option">
                  <input
                    type="checkbox"
                    checked={modalities.includes(modality)}
                    onChange={event => {
                      const checked = event.target.checked;
                      setModalities(prev => {
                        if (!checked) return prev.filter(value => value !== modality);
                        // An empty set means "follow the upstream declaration". The first tick
                        // starts from what the row already follows, so adding image to a text
                        // model does not silently declare it image-only.
                        const start = prev.length > 0 ? prev : inheritedModalityList;
                        return [...new Set([...start, modality])];
                      });
                    }}
                    disabled={busy}
                  />
                  <span className="text-control">{modality}</span>
                </label>
              ))}
            </div>
            {modalities.length === 0 && (
              // No box ticked is a real state — undeclared — not an empty model. Say what is
              // being followed instead, or the blank row reads as "this model accepts nothing".
              <span className="muted text-caption">
                {t("models.settingsModalitiesInherit", {
                  modalities: inheritedModalities || t("models.settingsModalitiesUnknown"),
                })}
              </span>
            )}
          </div>

          <div className="text-label models-field">
            {t("models.customFieldReasoning")}
            <div className="row models-field-row">
              <label className="row models-modality-option">
                <input
                  type="checkbox"
                  checked={reasoning}
                  onChange={event => toggleReasoning(event.target.checked)}
                  disabled={busy}
                />
                <span className="text-control">{t("models.customFieldReasoningOverride")}</span>
              </label>
            </div>
            {reasoning && (
              <div className="row models-field-row" style={{ flexWrap: "wrap" }}>
                {REASONING_EFFORT_LEVELS.map(level => (
                  <label key={level} className="row models-modality-option">
                    <input
                      type="checkbox"
                      checked={ladder.includes(level)}
                      onChange={event => toggleLevel(level, event.target.checked)}
                      disabled={busy}
                    />
                    <span className="text-control">{t(("models.reasoningEffort." + level) as TKey)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {reasoning && (
            <label className="text-label models-field">
              {t("models.settingsDefaultEffort")}
              <div className="row models-field-row">
                <Select
                  value={defaultEffort}
                  options={[
                    { value: "", label: "—" },
                    ...ladder.map(level => ({ value: level, label: t(("models.reasoningEffort." + level) as TKey) })),
                  ]}
                  onChange={setDefaultEffort}
                  disabled={busy}
                  label={t("models.settingsDefaultEffort")}
                  portal={false}
                />
              </div>
            </label>
          )}
        </div>

        <div className="modal-actions">
          {terminal && <button ref={reloadRef} type="button" className="btn btn-ghost" onClick={() => void reload()}>
            {t("models.settingsReload")}
          </button>}
          <button
            type="button"
            className="btn btn-ghost"
            title={t("models.settingsRestoreHint")}
            disabled={busy || terminal}
            onClick={() => void restore()}
          >
            {t("models.settingsRestore")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || terminal}>
            {busy ? t("models.customSaving") : t("models.customApply")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
