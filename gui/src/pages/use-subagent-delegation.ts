/**
 * Delegation settings (`/api/injection-model`) as a standalone hook.
 *
 * These controls used to live only on the Dashboard, where they were the one panel on an
 * otherwise read-only status page. They belong with the rest of the sub-agent settings, and
 * the Dashboard keeps a one-line summary that links here. Both surfaces read the same
 * endpoint, so this hook is the single owner of the fetch/patch pair.
 */
import { useCallback, useEffect, useState } from "react";
import { requireJson } from "./dashboard-shared";
import { readJsonOrThrow } from "../fetch-json";
import { normalizeInjectionSelection } from "./dashboard-core-poll";

export type DelegationModelOption = { provider: string; model: string; namespaced: string; canonical?: boolean };

export type DelegationPatch = {
  multiAgentGuidanceEnabled?: boolean;
  syncCodexSubagentDefaults?: boolean;
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;
};

/** Ultra mode (Proactive delegation for every model/effort) via /api/v2. */
export type UltraModeState = {
  enabled: boolean;
  hintText: string | null;
  multiAgentV2Enabled: boolean;
};

export type UltraModePatch = {
  multiAgentModeHintText: string | null;
};

export type V2NativeParentOverrideState = {
  enabled: boolean;
  model: string | null;
  active: boolean;
};

type DelegationResponse = {
  multiAgentGuidanceEnabled?: boolean;
  syncCodexSubagentDefaults?: boolean;
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;
  efforts?: string[];
  available?: DelegationModelOption[];
};

export function useSubagentDelegation(apiBase: string) {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [efforts, setEfforts] = useState<string[]>([]);
  const [available, setAvailable] = useState<DelegationModelOption[]>([]);
  const [guidanceEnabled, setGuidanceEnabled] = useState(true);
  const [syncCodexDefaults, setSyncCodexDefaults] = useState(false);
  const [prompt, setPrompt] = useState("");

  const apply = useCallback((data: DelegationResponse) => {
    const normalized = normalizeInjectionSelection(data);
    setGuidanceEnabled(normalized.multiAgentGuidanceEnabled);
    setSyncCodexDefaults(normalized.syncCodexSubagentDefaults);
    setModel(normalized.injectionModel);
    setEffort(normalized.injectionEffort);
    if ("prompt" in data) setPrompt(typeof data.prompt === "string" ? data.prompt : "");
    if (Array.isArray(data.efforts)) setEfforts(data.efforts);
    if (Array.isArray(data.available)) setAvailable(data.available);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/injection-model`);
        const data = await requireJson<DelegationResponse>(res);
        if (cancelled) return;
        apply(data);
      } catch { /* keep defaults; the panel still renders and can be retried by saving */ }
      finally { if (!cancelled) setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [apiBase, apply]);

  const save = useCallback(async (patch: DelegationPatch): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (saving) return { ok: false, error: "" };
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/injection-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await readJsonOrThrow(res, "injection save failed");
      // Re-read rather than trusting the patch: the server clamps effort to what the chosen
      // model actually supports, so the echo can differ from what was sent.
      const getRes = await fetch(`${apiBase}/api/injection-model`);
      apply(await requireJson<DelegationResponse>(getRes));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error && error.message ? error.message : "injection save failed",
      };
    } finally {
      setSaving(false);
    }
  }, [apiBase, apply, saving]);

  return {
    loaded, saving, model, effort, efforts, available, prompt,
    guidanceEnabled, syncCodexDefaults, save,
  };
}
