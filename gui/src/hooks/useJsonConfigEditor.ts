import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deepEqualJson, threeWayMergeJson } from "../provider-workspace/provider-draft-merge";
import { captureApiTarget, targetFetch } from "../api";

export interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, Record<string, unknown> & { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; xaiResponsesOptInState?: boolean | "mixed" }>;
}

const PROVIDER_EDITOR_DERIVED_FIELDS = [
  "hasApiKey",
  "hasHeaders",
  "vertexCredentialKind",
  "xaiResponsesOptInState",
  "initialModelSelection",
] as const;

type ProviderEditorConfig = {
  defaultProvider: string;
  providers: Record<string, Record<string, unknown>>;
};

const PROVIDER_EDITOR_DERIVED_FIELD_SET = new Set<string>(PROVIDER_EDITOR_DERIVED_FIELDS);

function projectProviderEditorConfig(config: Config): ProviderEditorConfig {
  return {
    defaultProvider: config.defaultProvider,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => {
      const projected: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(provider)) {
        if (!PROVIDER_EDITOR_DERIVED_FIELD_SET.has(field)) projected[field] = structuredClone(value);
      }
      return [name, projected];
    })),
  };
}

/** One target's editor session. The map below keeps a parked session per dashboard server. */
interface JsonEditorTargetState {
  open: boolean;
  draft: string;
  baseline: string;
  saving: boolean;
  leaveOpen: boolean;
  /** Paths both sides changed; the user must edit the draft or use saved values. */
  conflicts: string[];
  /** The user's pre-merge baseline, retained so an edit can revalidate conflict paths. */
  conflictBase: string;
}

const EMPTY_EDITOR: JsonEditorTargetState = { open: false, draft: "", baseline: "", saving: false, leaveOpen: false, conflicts: [], conflictBase: "" };

function hasJsonConflict(state: JsonEditorTargetState, savedBaseline: string): boolean {
  return state.open && state.draft !== state.baseline && savedBaseline !== "" && state.baseline !== savedBaseline;
}

export function useJsonConfigEditor(deps: {
  apiBase: string;
  /** Stable logical dashboard target; apiBase can be the same relay URL for two servers. */
  targetKey?: string;
  config: Config | null;
  notify: (msg: string, ok?: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  onSaved: (addedProviders: string[]) => void;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  const { apiBase, targetKey = apiBase, config, notify, fetchConfig, fetchProviderQuotas, onSaved, t } = deps;
  const apiBaseRef = useRef(apiBase);
  useLayoutEffect(() => { apiBaseRef.current = apiBase; }, [apiBase]);
  const targetKeyRef = useRef(targetKey);
  useLayoutEffect(() => { targetKeyRef.current = targetKey; }, [targetKey]);
  const [states, setStates] = useState<Map<string, JsonEditorTargetState>>(() => new Map());
  const savedBaseline = useMemo(
    () => config ? JSON.stringify(projectProviderEditorConfig(config), null, 2) : "",
    [config],
  );
  const stored = states.get(targetKey);
  // A closed editor follows the saved config without an effect: the first paint after a
  // load already has the right baseline, and a refresh never needs a second render.
  const state: JsonEditorTargetState = stored?.open
    ? stored
    : stored
      ? (stored.draft === stored.baseline && savedBaseline !== "" && stored.baseline !== savedBaseline
          ? { ...stored, draft: savedBaseline, baseline: savedBaseline }
          : stored)
      : (config ? { ...EMPTY_EDITOR, draft: savedBaseline, baseline: savedBaseline } : EMPTY_EDITOR);

  const update = useCallback((updater: (current: JsonEditorTargetState) => JsonEditorTargetState, atTarget = targetKey) => {
    setStates(previous => {
      const next = updater(previous.get(atTarget) ?? EMPTY_EDITOR);
      const copy = new Map(previous);
      copy.set(atTarget, next);
      return copy;
    });
  }, [targetKey]);

  const saveConfig = useCallback(async (): Promise<boolean> => {
    const saveTargetKey = targetKey;
    const saveApiBase = apiBase;
    const saveCapture = captureApiTarget("shared", apiBase);
    if (saveCapture.apiBase !== saveApiBase || (targetKey !== apiBase && saveCapture.targetKey !== targetKey)) {
      notify(t("prov.targetChanged"), false);
      return false;
    }
    const current = states.get(saveTargetKey) ?? EMPTY_EDITOR;
    // Every entry point, including the leave dialog's Save, must honor the conflict gate.
    if (hasJsonConflict(current, savedBaseline) || current.conflicts.length > 0) {
      notify(t("pws.draftConflictResolveFirst"), false);
      return false;
    }
    const draft = current.draft;
    const baselineText = current.baseline;
    update(previous => ({ ...previous, saving: true }), saveTargetKey);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      if (apiBaseRef.current === saveApiBase && targetKeyRef.current === saveTargetKey) notify(t("prov.invalidJson"), false);
      update(previous => ({ ...previous, saving: false }), saveTargetKey);
      return false;
    }
    try {
      const baseline = JSON.parse(baselineText) as unknown;
      // A formatting-only edit must not PUT an identical baseline and next pair.
      if (deepEqualJson(parsed, baseline)) {
        update(() => ({ open: false, draft: baselineText, baseline: baselineText, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" }), saveTargetKey);
        if (apiBaseRef.current === saveApiBase && targetKeyRef.current === saveTargetKey) notify(t("prov.saved"), true);
        return true;
      }
      const res = await targetFetch(saveCapture, `${saveApiBase}/api/providers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseline, next: parsed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
        if (apiBaseRef.current === saveApiBase && targetKeyRef.current === saveTargetKey) {
          notify(data.error === "target_changed" ? t("prov.targetChanged") : (data.error || t("prov.saveFailed")), false);
          // A stale baseline means the saved config moved; re-read it so the conflict
          // banner can offer an explicit choice instead of repeating the same failure.
          if (data.code === "stale_provider_editor_baseline") void fetchConfig();
        }
        update(previous => ({ ...previous, saving: false }), saveTargetKey);
        return false;
      }
      const saved = JSON.stringify(parsed, null, 2);
      // Edits typed while the PUT was in flight stay in the editor; only the baseline
      // moves to what the server just accepted.
      update(current => current.draft === draft
        ? { open: false, draft: saved, baseline: saved, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" }
        : { ...current, baseline: saved, saving: false, conflicts: [], conflictBase: "" }, saveTargetKey);
      // The PUT went to the target that owned this baseline. Its success belongs there;
      // announcing it on another target would claim a save the operator cannot see.
      if (apiBaseRef.current !== saveApiBase || targetKeyRef.current !== saveTargetKey) return true;
      notify(t("prov.saved"), true);
      fetchConfig();
      fetchProviderQuotas(true);
      const addedProviders = Object.keys((parsed as ProviderEditorConfig).providers)
        .filter(name => !Object.hasOwn((baseline as ProviderEditorConfig).providers, name));
      onSaved(addedProviders);
      return true;
    } catch {
      if (apiBaseRef.current === saveApiBase && targetKeyRef.current === saveTargetKey) notify(t("prov.saveFailed"), false);
      update(previous => ({ ...previous, saving: false }), saveTargetKey);
      return false;
    }
  }, [apiBase, fetchConfig, fetchProviderQuotas, notify, onSaved, savedBaseline, states, t, targetKey, update]);

  const openJsonEditor = useCallback(() => {
    const baseline = savedBaseline || state.draft;
    update(() => ({ open: true, draft: baseline, baseline, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" }));
  }, [savedBaseline, state.draft, update]);

  const discardJsonEditor = useCallback(() => {
    update(current => {
      const baseline = savedBaseline || current.baseline;
      return { open: false, draft: baseline, baseline, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" };
    });
  }, [savedBaseline, update]);

  const requestCloseJsonEditor = useCallback(() => {
    if (state.open && state.draft !== state.baseline) {
      update(current => ({ ...current, leaveOpen: true }));
      return;
    }
    discardJsonEditor();
  }, [discardJsonEditor, state.baseline, state.draft, state.open, update]);

  const restoreJsonEditor = useCallback(() => {
    const baseline = savedBaseline || state.baseline;
    update(() => ({ open: true, draft: baseline, baseline, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" }));
  }, [savedBaseline, state.baseline, update]);

  const setDraft = useCallback((value: string) => {
    update(current => {
      if (savedBaseline === "") return { ...current, draft: value };
      try {
        const merged = threeWayMergeJson(JSON.parse(current.conflictBase || current.baseline), JSON.parse(savedBaseline), JSON.parse(value));
        return { ...current, draft: value, conflicts: merged.conflicts, ...(merged.conflicts.length === 0 ? { conflictBase: "" } : {}) };
      } catch {
        return { ...current, draft: value };
      }
    });
  }, [savedBaseline, update]);

  const setJsonLeaveOpen = useCallback((value: boolean) => {
    update(current => ({ ...current, leaveOpen: value }));
  }, [update]);

  /** Saved values moved under an open draft; the user must choose explicitly. */
  const jsonConflict = hasJsonConflict(state, savedBaseline) || state.conflicts.length > 0;

  const useSavedJsonValues = useCallback(() => {
    const baseline = savedBaseline || state.baseline;
    update(() => ({ open: true, draft: baseline, baseline, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" }));
  }, [savedBaseline, state.baseline, update]);

  const keepJsonDraft = useCallback(() => {
    const latestBaseline = savedBaseline || state.baseline;
    let baseValue: unknown;
    let latestValue: unknown;
    let draftValue: unknown;
    try {
      baseValue = JSON.parse(state.baseline);
      latestValue = JSON.parse(latestBaseline);
      draftValue = JSON.parse(state.draft);
    } catch {
      return;
    }
    const merged = threeWayMergeJson(baseValue, latestValue, draftValue);
    if (deepEqualJson(merged.value, latestValue)) {
      update(() => ({ open: false, draft: latestBaseline, baseline: latestBaseline, saving: false, leaveOpen: false, conflicts: [], conflictBase: "" }));
      return;
    }
    const draft = JSON.stringify(merged.value, null, 2);
    update(current => ({
      ...current, draft, baseline: latestBaseline, conflicts: merged.conflicts,
      conflictBase: merged.conflicts.length > 0 ? state.baseline : "",
    }));
  }, [savedBaseline, state.baseline, state.draft, update]);

  return {
    draft: state.draft,
    setDraft,
    jsonEditorOpen: state.open,
    jsonBaseline: state.baseline,
    jsonSaving: state.saving,
    jsonLeaveOpen: state.leaveOpen,
    saveConfig,
    openJsonEditor,
    discardJsonEditor,
    requestCloseJsonEditor,
    restoreJsonEditor,
    jsonIsDirty: state.open && state.draft !== state.baseline,
    jsonConflict,
    jsonConflicts: state.conflicts,
    useSavedJsonValues,
    keepJsonDraft,
    setJsonLeaveOpen,
  };
}
