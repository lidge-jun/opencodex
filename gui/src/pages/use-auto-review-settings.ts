import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import type { TFn } from "../i18n/shared";
import type { AutoReviewData } from "./models-shared";

export interface AutoReviewSettingsController {
  data: AutoReviewData | null;
  saving: boolean;
  load: () => Promise<AutoReviewData | null>;
  save: (patch: Partial<AutoReviewData>) => Promise<void>;
}

export function useAutoReviewSettings(
  apiBase: string,
  t: TFn,
  publishFeedback: (ok: boolean, message: string) => void,
): AutoReviewSettingsController {
  const [state, setState] = useState<{ apiBase: string; data: AutoReviewData | null; saving: boolean }>({
    apiBase, data: null, saving: false,
  });
  const data = state.apiBase === apiBase ? state.data : null;
  const saving = state.apiBase === apiBase && state.saving;
  const requests = useRef<{ read: BoundedFetch | null; write: BoundedFetch | null; generation: number; apiBase: string }>({
    read: null, write: null, generation: 0, apiBase,
  });

  useLayoutEffect(() => {
    const scope = requests.current;
    scope.apiBase = apiBase;
    scope.generation++;
    return () => {
      scope.generation++;
      scope.read?.controller.abort();
      scope.read?.clear();
      scope.read = null;
      scope.write?.controller.abort();
      scope.write?.clear();
      scope.write = null;
    };
  }, [apiBase]);

  const load = useCallback(async () => {
    const scope = requests.current;
    scope.read?.controller.abort();
    scope.read?.clear();
    const bounded = createBoundedFetch(15_000);
    const generation = scope.generation;
    scope.read = bounded;
    try {
      const response = await fetch(`${apiBase}/api/auto-review-settings`, { signal: bounded.signal });
      const next = await readJsonIfOk<AutoReviewData>(response);
      if (!next || typeof next.enabled !== "boolean" || typeof next.model !== "string") return null;
      if (!bounded.signal.aborted && scope.apiBase === apiBase && scope.generation === generation && scope.read === bounded) {
        setState({ apiBase, data: next, saving: false });
        return next;
      }
      return null;
    } catch { /* old server / network: keep the row disabled */ return null; }
    finally {
      bounded.clear();
      if (scope.read === bounded) scope.read = null;
    }
  }, [apiBase]);

  const save = useCallback(async (patch: Partial<AutoReviewData>) => {
    const scope = requests.current;
    if (!data || saving || scope.apiBase !== apiBase) return;
    const confirmed = data;
    const generation = scope.generation;
    setState({ apiBase, data: { ...confirmed, ...patch }, saving: true });
    const bounded = createBoundedFetch(15_000);
    scope.write = bounded;
    try {
      const response = await fetch(`${apiBase}/api/auto-review-settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: bounded.signal,
        body: JSON.stringify(patch),
      });
      const next = await readJsonOrThrow<AutoReviewData & { ok?: unknown; catalogRefresh?: { status?: string } }>(response, t("models.saveFailed"));
      if (!next || next.ok !== true || typeof next.enabled !== "boolean" || typeof next.model !== "string") {
        throw new Error(t("models.saveFailed"));
      }
      if (scope.apiBase !== apiBase || scope.generation !== generation) return;
      setState({ apiBase, data: { enabled: next.enabled, model: next.model }, saving: true });
      if (!next.catalogRefresh || next.catalogRefresh.status !== "committed") {
        publishFeedback(false, t("codexAuth.catalogRefreshPending"));
      }
    } catch (error) {
      if (scope.apiBase === apiBase && scope.generation === generation) {
        const refreshed = await load();
        if (scope.apiBase !== apiBase || scope.generation !== generation) return;
        setState({ apiBase, data: refreshed ?? confirmed, saving: true });
        publishFeedback(false, error instanceof Error && error.message ? error.message : t("models.saveFailed"));
      }
    } finally {
      bounded.clear();
      if (scope.write === bounded) scope.write = null;
      if (scope.apiBase === apiBase && scope.generation === generation) {
        setState(current => current.apiBase === apiBase ? { ...current, saving: false } : current);
      }
    }
  }, [apiBase, data, saving, t, publishFeedback, load]);

  return { data, saving, load, save };
}
