/**
 * The providers the suggested combos leave out, kept in config.json
 * (`comboSuggestionExcludedProviders`, `GET|PUT /api/combo-suggestions`) so the choice follows
 * the operator across browsers.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface SuggestionExclusions {
  excluded: readonly string[];
  /** True once the stored list is known; a save before that would replace it with a partial one. */
  ready: boolean;
  failed: boolean;
  retry: () => void;
  applyPolicy: (policy: unknown) => boolean;
  /** Saves the whole list; resolves false when the proxy did not take it (the list stays as it was). */
  save: (next: readonly string[]) => Promise<boolean>;
}

function parse(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || !("excludedProviders" in body)) return null;
  const list = (body as { excludedProviders: unknown }).excludedProviders;
  return Array.isArray(list) && list.every((name) => typeof name === "string") ? list : null;
}

export function useSuggestionExclusions(apiBase: string, active = true): SuggestionExclusions {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ base: string; attempt: number; excluded: string[] | null }>();
  const current = active && loaded?.base === apiBase && loaded.attempt === attempt ? loaded : undefined;
  // Bumped by every save, so a read that started earlier cannot overwrite what was saved.
  const generation = useRef(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const started = generation.current;
    void fetch(`${apiBase}/api/combo-suggestions`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const list = parse(body);
        if (controller.signal.aborted || generation.current !== started) return;
        setLoaded({ base: apiBase, attempt, excluded: list });
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === started) {
          setLoaded({ base: apiBase, attempt, excluded: null });
        }
      });
    return () => controller.abort();
  }, [apiBase, active, attempt]);

  const save = useCallback(async (next: readonly string[]) => {
    if (!current?.excluded) return false;
    const started = ++generation.current;
    try {
      const response = await fetch(`${apiBase}/api/combo-suggestions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedProviders: next }),
      });
      const list = response.ok ? parse(await response.json()) : null;
      if (!list || generation.current !== started) return false;
      setLoaded({ base: apiBase, attempt, excluded: list });
      return true;
    } catch {
      return false;
    }
  }, [apiBase, attempt, current]);

  return {
    excluded: current?.excluded ?? [],
    ready: current?.excluded != null,
    failed: current?.excluded === null,
    retry: () => setAttempt((value) => value + 1),
    applyPolicy: (policy) => {
      const list = parse(policy);
      if (!list) return false;
      generation.current += 1;
      setLoaded({ base: apiBase, attempt, excluded: list });
      return true;
    },
    save,
  };
}
