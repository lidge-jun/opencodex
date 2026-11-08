import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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
}

const EMPTY_EDITOR: JsonEditorTargetState = { open: false, draft: "", baseline: "", saving: false, leaveOpen: false };

export function useJsonConfigEditor(deps: {
  apiBase: string;
  config: Config | null;
  notify: (msg: string, ok?: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  onSaved: (addedProviders: string[]) => void;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  const { apiBase, config, notify, fetchConfig, fetchProviderQuotas, onSaved, t } = deps;
  const apiBaseRef = useRef(apiBase);
  useLayoutEffect(() => { apiBaseRef.current = apiBase; }, [apiBase]);
  const [states, setStates] = useState<Map<string, JsonEditorTargetState>>(() => new Map());
  const savedBaseline = useMemo(
    () => config ? JSON.stringify(projectProviderEditorConfig(config), null, 2) : "",
    [config],
  );
  const stored = states.get(apiBase);
  // A closed editor follows the saved config without an effect: the first paint after a
  // load already has the right baseline, and a refresh never needs a second render.
  const state: JsonEditorTargetState = stored?.open
    ? stored
    : stored
      ? (stored.draft === stored.baseline && savedBaseline !== "" && stored.baseline !== savedBaseline
          ? { ...stored, draft: savedBaseline, baseline: savedBaseline }
          : stored)
      : (config ? { ...EMPTY_EDITOR, draft: savedBaseline, baseline: savedBaseline } : EMPTY_EDITOR);

  const update = useCallback((updater: (current: JsonEditorTargetState) => JsonEditorTargetState, atTarget = apiBase) => {
    setStates(previous => {
      const next = updater(previous.get(atTarget) ?? EMPTY_EDITOR);
      const copy = new Map(previous);
      copy.set(atTarget, next);
      return copy;
    });
  }, [apiBase]);

  const saveConfig = useCallback(async (): Promise<boolean> => {
    const saveTarget = apiBase;
    const current = states.get(saveTarget) ?? EMPTY_EDITOR;
    const draft = current.draft;
    const baselineText = current.baseline;
    update(previous => ({ ...previous, saving: true }), saveTarget);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      if (apiBaseRef.current === saveTarget) notify(t("prov.invalidJson"), false);
      update(previous => ({ ...previous, saving: false }), saveTarget);
      return false;
    }
    try {
      const baseline = JSON.parse(baselineText) as unknown;
      const res = await fetch(`${saveTarget}/api/providers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseline, next: parsed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
        if (apiBaseRef.current === saveTarget) {
          notify(data.error || t("prov.saveFailed"), false);
          // A stale baseline means the saved config moved; re-read it so the conflict
          // banner can offer an explicit choice instead of repeating the same failure.
          if (data.code === "stale_provider_editor_baseline") void fetchConfig();
        }
        update(previous => ({ ...previous, saving: false }), saveTarget);
        return false;
      }
      const saved = JSON.stringify(parsed, null, 2);
      // Edits typed while the PUT was in flight stay in the editor; only the baseline
      // moves to what the server just accepted.
      update(current => current.draft === draft
        ? { open: false, draft: saved, baseline: saved, saving: false, leaveOpen: false }
        : { ...current, baseline: saved, saving: false }, saveTarget);
      // The PUT went to the target that owned this baseline. Its success belongs there;
      // announcing it on another target would claim a save the operator cannot see.
      if (apiBaseRef.current !== saveTarget) return true;
      notify(t("prov.saved"), true);
      fetchConfig();
      fetchProviderQuotas(true);
      const addedProviders = Object.keys((parsed as ProviderEditorConfig).providers)
        .filter(name => !Object.hasOwn((baseline as ProviderEditorConfig).providers, name));
      onSaved(addedProviders);
      return true;
    } catch {
      if (apiBaseRef.current === saveTarget) notify(t("prov.saveFailed"), false);
      update(previous => ({ ...previous, saving: false }), saveTarget);
      return false;
    }
  }, [apiBase, fetchConfig, fetchProviderQuotas, notify, onSaved, states, t, update]);

  const openJsonEditor = useCallback(() => {
    const baseline = savedBaseline || state.draft;
    update(() => ({ open: true, draft: baseline, baseline, saving: false, leaveOpen: false }));
  }, [savedBaseline, state.draft, update]);

  const discardJsonEditor = useCallback(() => {
    update(current => {
      const baseline = savedBaseline || current.baseline;
      return { open: false, draft: baseline, baseline, saving: false, leaveOpen: false };
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
    update(current => ({ ...current, draft: current.baseline }));
  }, [update]);

  const setDraft = useCallback((value: string) => {
    update(current => ({ ...current, draft: value }));
  }, [update]);

  const setJsonLeaveOpen = useCallback((value: boolean) => {
    update(current => ({ ...current, leaveOpen: value }));
  }, [update]);

  /** Saved values moved under an open draft; the user must choose explicitly. */
  const jsonConflict = state.open && state.draft !== state.baseline
    && savedBaseline !== "" && state.baseline !== savedBaseline;

  const useSavedJsonValues = useCallback(() => {
    const baseline = savedBaseline || state.baseline;
    update(() => ({ open: true, draft: baseline, baseline, saving: false, leaveOpen: false }));
  }, [savedBaseline, state.baseline, update]);

  const keepJsonDraft = useCallback(() => {
    const baseline = savedBaseline || state.baseline;
    update(current => ({ ...current, baseline }));
  }, [savedBaseline, state.baseline, update]);

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
    useSavedJsonValues,
    keepJsonDraft,
    setJsonLeaveOpen,
  };
}
